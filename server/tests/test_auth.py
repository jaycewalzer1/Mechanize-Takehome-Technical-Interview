import hashlib

import pytest

from tests.conftest import signup

pytestmark = pytest.mark.anyio


def sha256(s: str) -> str:
    return hashlib.sha256(s.encode()).hexdigest()


async def test_signup_stores_argon2_hash_and_hashed_session(make_client, conn):
    client = make_client()
    user = await signup(client, "alice", password="password1")

    row = await conn.fetchrow("SELECT * FROM users WHERE id = $1", user["id"])
    assert row["username"] == "alice"
    assert row["password_hash"].startswith("$argon2")
    assert "password1" not in row["password_hash"]

    token = client.cookies["session_id"]
    sessions = await conn.fetch("SELECT token_hash, user_id FROM sessions")
    assert len(sessions) == 1
    # Only the hash of the cookie value is stored, never the raw token.
    assert sessions[0]["token_hash"] == sha256(token)
    assert sessions[0]["token_hash"] != token
    assert str(sessions[0]["user_id"]) == user["id"]


async def test_session_cookie_is_httponly(make_client):
    client = make_client()
    r = await client.post(
        "/api/auth/signup",
        json={"username": "alice", "email": "alice@example.com", "password": "password1"},
    )
    set_cookie = r.headers["set-cookie"].lower()
    assert "session_id=" in set_cookie
    assert "httponly" in set_cookie
    assert "samesite=lax" in set_cookie


async def test_me_requires_session(make_client):
    anon = make_client()
    assert (await anon.get("/api/auth/me")).status_code == 401

    client = make_client()
    user = await signup(client, "alice")
    r = await client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json() == user


async def test_login_by_username_or_email_case_insensitive(make_client, conn):
    await signup(make_client(), "Alice")
    for ident in ["Alice", "alice", "ALICE@EXAMPLE.COM", " alice@example.com "]:
        c = make_client()
        r = await c.post("/api/auth/login", json={"identifier": ident, "password": "password1"})
        assert r.status_code == 200, (ident, r.text)
        assert r.json()["username"] == "Alice"
    # 1 signup session + 4 logins
    assert await conn.fetchval("SELECT count(*) FROM sessions") == 5


async def test_S4_same_error_for_unknown_user_and_wrong_password(make_client, conn):
    await signup(make_client(), "alice")
    c = make_client()
    bad = "nope-nope"
    wrong_pw = await c.post("/api/auth/login", json={"identifier": "alice", "password": bad})
    unknown = await c.post("/api/auth/login", json={"identifier": "ghost", "password": bad})
    assert wrong_pw.status_code == unknown.status_code == 401
    assert wrong_pw.json() == unknown.json()
    assert "session_id" not in c.cookies
    # Failed logins must not create sessions (only the signup one exists).
    assert await conn.fetchval("SELECT count(*) FROM sessions") == 1


async def test_S3_logout_deletes_session_row_and_old_cookie_rejected(make_client, conn):
    client = make_client()
    await signup(client, "alice")
    token = client.cookies["session_id"]
    assert await conn.fetchval("SELECT count(*) FROM sessions") == 1

    r = await client.post("/api/auth/logout")
    assert r.status_code == 200
    assert await conn.fetchval("SELECT count(*) FROM sessions") == 0

    # Replay the old cookie explicitly: it must be dead server-side, not just cleared client-side.
    replay = make_client()
    replay.cookies.set("session_id", token)
    assert (await replay.get("/api/auth/me")).status_code == 401


async def test_S2_expired_session_rejected(make_client, conn):
    client = make_client()
    await signup(client, "alice")
    await conn.execute("UPDATE sessions SET expires_at = now() - interval '1 second'")
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_S2_garbage_cookie_rejected(make_client):
    c = make_client()
    c.cookies.set("session_id", "not-a-real-token")
    assert (await c.get("/api/auth/me")).status_code == 401


async def test_V8_username_and_email_unique_case_insensitive(make_client, conn):
    await signup(make_client(), "alice")
    c = make_client()
    dup_name = await c.post(
        "/api/auth/signup",
        json={"username": "ALICE", "email": "other@example.com", "password": "password1"},
    )
    dup_email = await c.post(
        "/api/auth/signup",
        json={"username": "other", "email": "Alice@Example.com", "password": "password1"},
    )
    assert dup_name.status_code == 409 and "Username" in dup_name.json()["detail"]
    assert dup_email.status_code == 409 and "Email" in dup_email.json()["detail"]
    assert await conn.fetchval("SELECT count(*) FROM users") == 1


async def test_email_stored_lowercase(make_client, conn):
    c = make_client()
    await c.post(
        "/api/auth/signup",
        json={"username": "bob", "email": "Bob@X.COM", "password": "password1"},
    )
    assert await conn.fetchval("SELECT email FROM users") == "bob@x.com"


@pytest.mark.parametrize(
    "field,value,ok",
    [
        ("password", "a" * 7, False),
        ("password", "a" * 8, True),
        ("password", "a" * 128, True),
        ("password", "a" * 129, False),
        ("username", "a", False),
        ("username", "ab", True),
        ("username", "a" * 32, True),
        ("username", "a" * 33, False),
        ("username", "has space", False),
        ("username", "has@at", False),
        ("email", "not-an-email", False),
    ],
)
async def test_V3_signup_limits(make_client, conn, field, value, ok):
    body = {"username": "alice", "email": "alice@example.com", "password": "password1"}
    body[field] = value
    r = await make_client().post("/api/auth/signup", json=body)
    assert (r.status_code == 200) is ok, r.text
    if not ok:
        assert r.status_code in (400, 422)
    assert await conn.fetchval("SELECT count(*) FROM users") == (1 if ok else 0)
