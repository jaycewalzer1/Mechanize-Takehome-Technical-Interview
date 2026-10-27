"""Shape operations: every write to `shapes`, one transaction per op (PLAN.md "Server rules").

The WS handler calls `apply_op` and broadcasts what it returns, only after commit.
"""

import json
from uuid import UUID

import asyncpg
from pydantic import ValidationError

from app.db import get_pool
from app.ws_schemas import CreateMsg, DeleteMsg, RestoreMsg, UpdateMsg, shape_props_adapter

MAX_LIVE_SHAPES = 2000  # P2: bounds snapshot size; 2-5 people never get close


class OpRejected(Exception):
    """An op the server refused. `shape`, the row as it is now, resyncs the sender."""

    def __init__(self, detail: str, shape: dict | None = None):
        self.detail = detail
        self.shape = shape


def _frame(row: asyncpg.Record) -> dict:
    # asyncpg returns JSONB as a string unless a codec is registered; decoding here is simpler.
    return {
        "type": "shape",
        "id": str(row["id"]),
        "props": json.loads(row["props"]),
        "version": row["version"],
        "deleted": row["deleted"],
    }


async def load_snapshot(canvas_id: UUID) -> tuple[int, list[dict]]:
    """Current seq and all live shapes. Two queries, independent of shape count (P1).

    Order matters: seq is read *before* the shapes, so a commit landing between the
    two can only make the shapes newer than seq, never older. The client uses seq
    as a floor for stale frames, so a too-high seq could hide a real change.
    """
    pool = await get_pool()
    seq = await pool.fetchval("SELECT seq FROM canvases WHERE id = $1", canvas_id)
    rows = await pool.fetch(
        """
        SELECT id, props, version, deleted FROM shapes
        WHERE canvas_id = $1 AND NOT deleted ORDER BY created_at, id
        """,
        canvas_id,
    )
    return seq, [{k: v for k, v in _frame(r).items() if k != "type"} for r in rows]


async def apply_op(
    canvas_id: UUID, user_id: UUID, msg: CreateMsg | UpdateMsg | DeleteMsg | RestoreMsg
) -> dict | None:
    """Apply one shape op. Returns the `shape` frame to broadcast, or None for a no-op.

    Raises OpRejected; the transaction then rolls back, so nothing (not even the
    seq bump) is persisted and nothing is broadcast (F1, W3).
    """
    pool = await get_pool()
    async with pool.acquire() as conn, conn.transaction():
        # Bumping seq takes the canvas row lock: every op on this canvas waits here
        # until the previous one commits, so writes are serialized and seq order is
        # commit order. The new seq becomes the shape's version (C2).
        # Canvas row first, shape row second, always: one lock order, no deadlocks (C7).
        # The EXISTS re-checks membership on every op, not just the handshake (S1).
        seq = await conn.fetchval(
            """
            UPDATE canvases SET seq = seq + 1, updated_at = now()
            WHERE id = $1 AND EXISTS (
                SELECT 1 FROM canvas_members WHERE canvas_id = $1 AND user_id = $2)
            RETURNING seq
            """,
            canvas_id,
            user_id,
        )
        if seq is None:
            raise OpRejected("Canvas not found or you are not a member")
        if isinstance(msg, CreateMsg):
            return await _create(conn, canvas_id, user_id, seq, msg)
        return await _modify(conn, canvas_id, seq, msg)


async def _check_not_full(conn: asyncpg.Connection, canvas_id: UUID) -> None:
    # Called by create and restore, the two ops that add a live shape.
    live = await conn.fetchval(
        "SELECT count(*) FROM shapes WHERE canvas_id = $1 AND NOT deleted", canvas_id
    )
    if live >= MAX_LIVE_SHAPES:  # race-free: we hold the canvas lock
        raise OpRejected(f"Canvas is full ({MAX_LIVE_SHAPES} shapes)")


async def _create(
    conn: asyncpg.Connection, canvas_id: UUID, user_id: UUID, seq: int, msg: CreateMsg
) -> dict | None:
    await _check_not_full(conn, canvas_id)
    # Edge case: C1/I2 a retried create reuses its client UUID -> ON CONFLICT does
    # nothing (no second row, and no resurrecting a deleted shape) -> no broadcast.
    row = await conn.fetchrow(
        """
        INSERT INTO shapes (id, canvas_id, props, version, created_by)
        VALUES ($1, $2, $3::jsonb, $4, $5)
        ON CONFLICT (id) DO NOTHING
        RETURNING id, props, version, deleted
        """,
        msg.id,
        canvas_id,
        json.dumps(msg.props.model_dump()),
        seq,
        user_id,
    )
    return _frame(row) if row else None


async def _modify(
    conn: asyncpg.Connection, canvas_id: UUID, seq: int, msg: UpdateMsg | DeleteMsg | RestoreMsg
) -> dict:
    # Scoped by canvas_id, so an id from another canvas is simply "not found" (V7).
    current = await conn.fetchrow(
        """
        SELECT id, props, version, deleted FROM shapes
        WHERE id = $1 AND canvas_id = $2 FOR UPDATE
        """,
        msg.id,
        canvas_id,
    )
    if current is None:
        raise OpRejected("Shape not found")
    props = json.loads(current["props"])
    deleted = current["deleted"]

    if isinstance(msg, RestoreMsg):
        if not deleted:
            raise OpRejected("Shape is not deleted", _frame(current))
        await _check_not_full(conn, canvas_id)
        deleted = False
    elif deleted:
        # Edge case: C3 update/delete after delete -> rejected, sender gets the
        # tombstone so it drops the shape. Only an explicit restore un-deletes.
        raise OpRejected("Shape was deleted", _frame(current))
    elif isinstance(msg, DeleteMsg):
        deleted = True
    else:
        # The schema guarantees geometry arrives as a whole group, so this dict
        # merge replaces the group as a unit (group LWW) and color/text per field.
        merged = {**props, **msg.patch.model_dump(exclude_unset=True)}
        try:
            # Re-validate the merged result: rejects e.g. line endpoints on a rect.
            props = shape_props_adapter.validate_python(merged).model_dump()
        except ValidationError as e:
            raise OpRejected(f"Invalid update: {e.errors()[0]['msg']}", _frame(current)) from e

    row = await conn.fetchrow(
        """
        UPDATE shapes SET props = $3::jsonb, deleted = $4, version = $5, updated_at = now()
        WHERE id = $1 AND canvas_id = $2
        RETURNING id, props, version, deleted
        """,
        msg.id,
        canvas_id,
        json.dumps(props),
        deleted,
        seq,
    )
    return _frame(row)
