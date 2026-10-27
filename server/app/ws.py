"""The /ws endpoint: handshake auth, the in-memory room per canvas, and broadcast fan-out.

Thin by design: it parses frames, calls `shapes.apply_op`, and broadcasts the result
after commit. Protocol and rules: README.md.
"""

import asyncio
import logging
import os
from dataclasses import dataclass, field
from uuid import UUID, uuid4

import asyncpg
from fastapi import APIRouter, WebSocket
from pydantic import ValidationError

from app.auth import SESSION_COOKIE, AccessError, check_canvas_access, user_from_token
from app.shapes import OpRejected, apply_op, load_snapshot
from app.ws_schemas import CursorMsg, parse_client_message

router = APIRouter()
log = logging.getLogger(__name__)

# S7: browsers always send Origin on a WebSocket handshake, so a cross-site page
# can't open a socket with our cookie. A missing Origin means a non-browser client,
# which can't ride a victim's cookie anyway.
ALLOWED_ORIGINS = set(
    os.environ.get("ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(",")
)
SEND_TIMEOUT = 2.0  # seconds; a socket slower than this is dropped (W7)


@dataclass
class Conn:
    ws: WebSocket
    peer: dict  # {conn_id, user_id, username}, sent with this connection's cursor frames
    # Frames broadcast while the snapshot is being loaded, sent right after it (see join).
    pending: list[dict] | None = field(default_factory=list)


# LIMITATION: multiple workers -> rooms split; fix with Postgres LISTEN/NOTIFY.
rooms: dict[UUID, dict[str, Conn]] = {}


class HandshakeRejected(Exception):
    pass


@router.websocket("/ws")
async def canvas_socket(ws: WebSocket, canvas: str = "") -> None:
    # Accept, then close with 1008: a close before accept reaches the browser only
    # as a failed handshake (code 1006), which it can't tell apart from "server down".
    await ws.accept()
    try:
        user, canvas_id = await _authorize(ws, canvas)
    except HandshakeRejected as e:
        # Edge case: W1/S2 bad session or not a member -> closed before joining, no data sent.
        await ws.close(code=1008, reason=str(e))
        return

    conn = Conn(ws, {"conn_id": uuid4().hex, "user_id": user["id"], "username": user["username"]})
    room = rooms.setdefault(canvas_id, {})
    # Join *before* loading the snapshot, so a change committed after the snapshot
    # query still reaches us as a broadcast. Those broadcasts are held in
    # conn.pending and sent after the snapshot; if they were sent first, the
    # (older) snapshot would overwrite them on the client.
    room[conn.peer["conn_id"]] = conn
    try:
        seq, shapes = await load_snapshot(canvas_id)
        await ws.send_json({"type": "snapshot", "seq": seq, "you": conn.peer, "shapes": shapes})
        while conn.pending:  # frames that arrive during these awaits are appended and drained too
            await ws.send_json(conn.pending.pop(0))
        conn.pending = None  # no await since the loop's last check, so nothing can slip in
        await _receive_loop(canvas_id, UUID(user["id"]), conn)
    finally:
        # Edge case: W5 tab closed / network drop -> leave the room, others drop the cursor.
        room.pop(conn.peer["conn_id"], None)
        # Only remove the room if it's still the registered one: if this connection
        # was dropped by _deliver and the room emptied and was replaced by a newer
        # one, popping by key would orphan the newcomers from every broadcast.
        if not room and rooms.get(canvas_id) is room:
            rooms.pop(canvas_id)
        await _broadcast(canvas_id, {"type": "leave", "conn_id": conn.peer["conn_id"]})


async def _authorize(ws: WebSocket, canvas: str) -> tuple[dict, UUID]:
    origin = ws.headers.get("origin")
    if origin is not None and origin not in ALLOWED_ORIGINS:
        raise HandshakeRejected("Origin not allowed")
    user = await user_from_token(ws.cookies.get(SESSION_COOKIE))
    if user is None:
        raise HandshakeRejected("Not logged in")
    try:
        canvas_id = UUID(canvas)
    except ValueError:
        raise HandshakeRejected("Invalid canvas id") from None
    try:
        await check_canvas_access(canvas_id, user["id"])
    except AccessError as e:
        raise HandshakeRejected(e.detail) from None
    return user, canvas_id


async def _receive_loop(canvas_id: UUID, user_id: UUID, conn: Conn) -> None:
    while True:
        message = await conn.ws.receive()
        if message["type"] == "websocket.disconnect":
            return
        raw = message.get("text")
        if raw is None:
            await _deliver(canvas_id, conn, _error("Only text frames are supported"))
            continue
        await _handle(canvas_id, user_id, conn, raw)


async def _handle(canvas_id: UUID, user_id: UUID, conn: Conn, raw: str) -> None:
    """Handle one frame. Every failure becomes an error frame; none ends the loop (W2, W3)."""
    try:
        msg = parse_client_message(raw)
    except ValidationError as e:
        first = e.errors()[0]
        where = ".".join(str(p) for p in first["loc"])  # empty for e.g. non-JSON
        detail = f"{where}: {first['msg']}" if where else first["msg"]
        await _deliver(canvas_id, conn, _error(f"Invalid message: {detail}"))
        return
    except ValueError as e:  # oversized frame
        await _deliver(canvas_id, conn, _error(str(e)))
        return

    if isinstance(msg, CursorMsg):
        # Edge case: W10 cursors go to the others only and never touch the DB.
        cursor = {"type": "cursor", **conn.peer, "x": msg.x, "y": msg.y}
        await _broadcast(canvas_id, cursor, skip=conn)
        return

    try:
        frame = await apply_op(canvas_id, user_id, msg)
    except OpRejected as e:
        await _deliver(canvas_id, conn, _error(e.detail))
        if e.shape is not None:  # resync the sender's optimistic state (C3)
            await _deliver(canvas_id, conn, e.shape)
        return
    except (asyncpg.PostgresError, asyncpg.InterfaceError, OSError):
        # Edge case: W3 DB error (query failure, or a lost/refused connection) -> the
        # transaction already rolled back; tell the sender only and keep the loop alive.
        log.exception("shape op failed")
        await _deliver(canvas_id, conn, _error("Server error: change not saved"))
        return

    # Edge case: W4 broadcast only after apply_op's transaction has committed.
    # Sent to everyone including the sender, whose client confirms its optimistic edit.
    if frame is not None:
        await _broadcast(canvas_id, frame)


async def _broadcast(canvas_id: UUID, frame: dict, skip: Conn | None = None) -> None:
    targets = [c for c in rooms.get(canvas_id, {}).values() if c is not skip]
    # Concurrently, so one slow socket doesn't delay everyone else (W7).
    await asyncio.gather(*(_deliver(canvas_id, c, frame) for c in targets))


async def _deliver(canvas_id: UUID, conn: Conn, frame: dict) -> None:
    if conn.pending is not None:  # still sending this connection its snapshot
        conn.pending.append(frame)
        return
    try:
        await asyncio.wait_for(conn.ws.send_json(frame), SEND_TIMEOUT)
    except Exception:
        # Edge case: W7 any send failure (closed, reset, too slow) means this
        # socket is unusable: drop it and close it, so its client reconnects and
        # gets a fresh snapshot. Catching broadly is deliberate here: the fan-out
        # must keep going for everyone else.
        log.info("dropping connection %s", conn.peer["conn_id"])
        rooms.get(canvas_id, {}).pop(conn.peer["conn_id"], None)
        try:
            await conn.ws.close(code=1011)
        except Exception:
            pass  # already closed; nothing more to do


def _error(detail: str) -> dict:
    return {"type": "error", "detail": detail}
