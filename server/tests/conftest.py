# Test setup: point the app at a separate `whiteboard_test` Postgres database
# (same engine as prod). test_ws.py truncates it before every test.
import os

TEST_DB = "whiteboard_test"
ADMIN_URL = os.environ.get(
    "TEST_ADMIN_DATABASE_URL", "postgres://whiteboard:whiteboard@localhost:5432/whiteboard"
)
# Must be set before app.db is imported, since it reads DATABASE_URL at import time.
os.environ["DATABASE_URL"] = ADMIN_URL.rsplit("/", 1)[0] + "/" + TEST_DB

import asyncpg  # noqa: E402


async def ensure_test_db() -> None:
    admin = await asyncpg.connect(ADMIN_URL)
    try:
        if not await admin.fetchval("SELECT 1 FROM pg_database WHERE datname = $1", TEST_DB):
            await admin.execute(f'CREATE DATABASE "{TEST_DB}"')
    finally:
        await admin.close()
