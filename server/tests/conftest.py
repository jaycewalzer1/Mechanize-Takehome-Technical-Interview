# Test fixtures: run the real app against a separate `whiteboard_test` Postgres
# database (same engine as prod), truncated before every test.
import os

TEST_DB = "whiteboard_test"
ADMIN_URL = os.environ.get(
    "TEST_ADMIN_DATABASE_URL", "postgres://whiteboard:whiteboard@localhost:5432/whiteboard"
)
# Must be set before app.db is imported, since it reads DATABASE_URL at import time.
os.environ["DATABASE_URL"] = ADMIN_URL.rsplit("/", 1)[0] + "/" + TEST_DB

import asyncpg  # noqa: E402
import httpx  # noqa: E402
import pytest  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
async def conn():
    """Fresh schema + empty tables; yields a raw connection for asserting on DB rows."""
    admin = await asyncpg.connect(ADMIN_URL)
    try:
        if not await admin.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", TEST_DB):
            await admin.execute(f'CREATE DATABASE "{TEST_DB}"')
    finally:
        await admin.close()

    # anyio gives each test its own event loop, and an asyncpg pool is bound to
    # the loop it was created on, so build the app's pool per test.
    await db.init_db()
    pool = await db.get_pool()
    await pool.execute("TRUNCATE users, sessions, canvases, canvas_members, shapes CASCADE")
    async with pool.acquire() as c:
        yield c
    await db.close_pool()


@pytest.fixture
async def make_client(conn):
    """Factory for independent clients (separate cookie jars = separate users)."""
    clients = []

    def _make() -> httpx.AsyncClient:
        c = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        clients.append(c)
        return c

    yield _make
    for c in clients:
        await c.aclose()


async def signup(client: httpx.AsyncClient, name: str, password: str = "password1") -> dict:
    r = await client.post(
        "/api/auth/signup",
        json={"username": name, "email": f"{name}@example.com", "password": password},
    )
    assert r.status_code == 200, r.text
    return r.json()
