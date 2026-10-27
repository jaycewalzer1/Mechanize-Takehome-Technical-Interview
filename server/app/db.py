"""The shared asyncpg pool, and startup: wait for Postgres, then apply schema.sql."""

import asyncio
import logging
import os
from pathlib import Path

import asyncpg

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgres://whiteboard:whiteboard@localhost:5432/whiteboard",
)
SCHEMA_PATH = Path(__file__).resolve().parent.parent / "schema.sql"

log = logging.getLogger(__name__)

pool: asyncpg.Pool | None = None


async def get_pool() -> asyncpg.Pool:
    global pool
    if pool is None:
        pool = await asyncpg.create_pool(DATABASE_URL)
    return pool


async def init_db(attempts: int = 30) -> None:
    """Connect (retrying while Postgres boots) and apply the idempotent schema."""
    for attempt in range(1, attempts + 1):
        try:
            p = await get_pool()
            break
        except (OSError, asyncpg.PostgresError) as e:
            if attempt == attempts:
                raise
            log.warning("database not ready (%s), retrying", e)
            await asyncio.sleep(1)
    async with p.acquire() as conn:
        # Advisory lock so concurrent workers don't race on DDL.
        async with conn.transaction():
            await conn.execute("SELECT pg_advisory_xact_lock(727274)")
            await conn.execute(SCHEMA_PATH.read_text())


async def close_pool() -> None:
    global pool
    if pool is not None:
        await pool.close()
        pool = None
