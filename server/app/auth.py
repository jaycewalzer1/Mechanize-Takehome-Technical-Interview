import hashlib
import os
import re
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

import asyncpg
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import APIRouter, Depends, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel, Field
from starlette.requests import HTTPConnection

from app.db import get_pool

SESSION_COOKIE = "session_id"
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
SESSION_TTL = timedelta(days=30)
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,32}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

_hasher = PasswordHasher()
# Verified against when the user doesn't exist, so login timing doesn't reveal it.
_DUMMY_HASH = _hasher.hash("dummy-password")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def public_user(row) -> dict:
    return {"id": str(row["id"]), "username": row["username"], "email": row["email"]}


async def user_from_token(token: str | None) -> dict | None:
    """Resolve a raw session token to a user. Shared by HTTP routes and the WS handshake."""
    if not token:
        return None
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT u.id, u.username, u.email
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = $1 AND s.expires_at > now()
        """,
        _hash_token(token),
    )
    return public_user(row) if row else None


async def current_user(conn: HTTPConnection) -> dict:
    # HTTPConnection (not Request) so this dependency also works on WebSocket routes.
    user = await user_from_token(conn.cookies.get(SESSION_COOKIE))
    if user is None:
        raise HTTPException(status_code=401, detail="Not logged in")
    return user


class AccessError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


async def check_canvas_access(canvas_id: UUID, user_id: str) -> dict:
    """Return the canvas if `user_id` is a member; raise AccessError(404/403) otherwise.

    Transport-agnostic: HTTP routes use `require_canvas_member`, and the WS
    handshake calls this directly and maps AccessError to a close code.
    """
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT c.id, c.name, c.owner_id, c.created_at,
               EXISTS (SELECT 1 FROM canvas_members m
                       WHERE m.canvas_id = c.id AND m.user_id = $2) AS is_member
        FROM canvases c WHERE c.id = $1
        """,
        canvas_id,
        UUID(user_id),
    )
    if row is None:
        raise AccessError(404, "Canvas not found")
    if not row["is_member"]:
        raise AccessError(403, "You are not a member of this canvas")
    return {
        "id": str(row["id"]),
        "name": row["name"],
        "owner_id": str(row["owner_id"]),
        "created_at": row["created_at"].isoformat(),
    }


async def require_canvas_member(canvas_id: UUID, user: dict = Depends(current_user)) -> dict:
    try:
        return await check_canvas_access(canvas_id, user["id"])
    except AccessError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


async def _start_session(response: Response, user_id) -> None:
    token = secrets.token_urlsafe(32)
    pool = await get_pool()
    await pool.execute(
        "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
        _hash_token(token),
        user_id,
        datetime.now(timezone.utc) + SESSION_TTL,
    )
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=COOKIE_SECURE,
        path="/",
    )


router = APIRouter(prefix="/api/auth")


# Max lengths bound the work an attacker can force (argon2 on a huge password).
class SignupBody(BaseModel):
    username: str = Field(max_length=32)
    email: str = Field(max_length=254)
    password: str = Field(min_length=8, max_length=128)


class LoginBody(BaseModel):
    identifier: str = Field(max_length=254)  # username or email
    password: str = Field(max_length=128)


@router.post("/signup")
async def signup(body: SignupBody, response: Response) -> dict:
    username = body.username.strip()
    email = body.email.strip().lower()
    if not USERNAME_RE.match(username):
        raise HTTPException(400, "Username must be 2-32 characters: letters, digits, _ . -")
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Invalid email address")

    password_hash = await run_in_threadpool(_hasher.hash, body.password)
    pool = await get_pool()
    try:
        row = await pool.fetchrow(
            """
            INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3)
            RETURNING id, username, email
            """,
            username,
            email,
            password_hash,
        )
    except asyncpg.UniqueViolationError as e:
        field = "Email" if "email" in (e.constraint_name or "") else "Username"
        raise HTTPException(409, f"{field} is already taken")
    await _start_session(response, row["id"])
    return public_user(row)


@router.post("/login")
async def login(body: LoginBody, response: Response) -> dict:
    ident = body.identifier.strip()
    pool = await get_pool()
    row = await pool.fetchrow(
        """
        SELECT id, username, email, password_hash FROM users
        WHERE lower(username) = lower($1) OR lower(email) = lower($1)
        """,
        ident,
    )
    try:
        ok = await run_in_threadpool(
            _hasher.verify, row["password_hash"] if row else _DUMMY_HASH, body.password
        )
    except (VerificationError, InvalidHashError):
        ok = False
    if not row or not ok:
        raise HTTPException(401, "Invalid username/email or password")
    await _start_session(response, row["id"])
    return public_user(row)


@router.post("/logout")
async def logout(conn: HTTPConnection, response: Response) -> dict:
    token = conn.cookies.get(SESSION_COOKIE)
    if token:
        pool = await get_pool()
        await pool.execute("DELETE FROM sessions WHERE token_hash = $1", _hash_token(token))
    response.delete_cookie(SESSION_COOKIE, path="/")
    return {"ok": True}


@router.get("/me")
async def me(user: dict = Depends(current_user)) -> dict:
    return user
