"""Canvas list, create, open and invite (/api/canvases)."""

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.auth import current_user, public_user, require_canvas_member
from app.db import get_pool

router = APIRouter(prefix="/api/canvases")


class CreateCanvasBody(BaseModel):
    name: str = Field(default="", max_length=100)


class InviteBody(BaseModel):
    identifier: str = Field(max_length=254)  # username or email


async def _members(canvas_id: str) -> list[dict]:
    pool = await get_pool()
    rows = await pool.fetch(
        """
        SELECT u.id, u.username, u.email
        FROM canvas_members m JOIN users u ON u.id = m.user_id
        WHERE m.canvas_id = $1 ORDER BY m.created_at
        """,
        UUID(canvas_id),
    )
    return [public_user(r) for r in rows]


@router.get("")
async def list_canvases(user: dict = Depends(current_user)) -> list[dict]:
    pool = await get_pool()
    # One query through the canvas_members(user_id) index, no N+1 (P1). No pagination:
    # a user's canvas list is small in this context (P2).
    rows = await pool.fetch(
        """
        SELECT c.id, c.name, c.updated_at, o.username AS owner
        FROM canvas_members m
        JOIN canvases c ON c.id = m.canvas_id
        JOIN users o ON o.id = c.owner_id
        WHERE m.user_id = $1
        ORDER BY c.updated_at DESC
        """,
        UUID(user["id"]),
    )
    return [
        {
            "id": str(r["id"]),
            "name": r["name"],
            "owner": r["owner"],
            "updated_at": r["updated_at"].isoformat(),
        }
        for r in rows
    ]


@router.post("")
async def create_canvas(body: CreateCanvasBody, user: dict = Depends(current_user)) -> dict:
    name = body.name.strip() or "Untitled canvas"
    pool = await get_pool()
    # One transaction: a canvas never exists without its owner's membership row.
    async with pool.acquire() as conn, conn.transaction():
        canvas_id = await conn.fetchval(
            "INSERT INTO canvases (name, owner_id) VALUES ($1, $2) RETURNING id",
            name,
            UUID(user["id"]),
        )
        await conn.execute(
            "INSERT INTO canvas_members (canvas_id, user_id, added_by) VALUES ($1, $2, $2)",
            canvas_id,
            UUID(user["id"]),
        )
    return {"id": str(canvas_id), "name": name}


@router.get("/{canvas_id}")
async def get_canvas(canvas: dict = Depends(require_canvas_member)) -> dict:
    return {**canvas, "members": await _members(canvas["id"])}


@router.post("/{canvas_id}/members")
async def invite_member(
    body: InviteBody,
    canvas: dict = Depends(require_canvas_member),
    user: dict = Depends(current_user),
) -> dict:
    ident = body.identifier.strip()
    pool = await get_pool()
    invitee = await pool.fetchrow(
        "SELECT id FROM users WHERE lower(username) = lower($1) OR lower(email) = lower($1)",
        ident,
    )
    if invitee is None:
        raise HTTPException(404, f"No user with username or email '{ident}'")
    # Edge case: C4/V8 duplicate or concurrent invite (or inviting a member) -> the
    # (canvas_id, user_id) primary key keeps one row, and DO NOTHING makes it a 200.
    await pool.execute(
        """
        INSERT INTO canvas_members (canvas_id, user_id, added_by) VALUES ($1, $2, $3)
        ON CONFLICT DO NOTHING
        """,
        UUID(canvas["id"]),
        invitee["id"],
        UUID(user["id"]),
    )
    return {"members": await _members(canvas["id"])}
