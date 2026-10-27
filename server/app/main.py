from contextlib import asynccontextmanager
from collections.abc import AsyncGenerator

from fastapi import FastAPI

from app import auth, canvases, ws
from app.db import close_pool, get_pool, init_db


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    await init_db()
    yield
    await close_pool()


app = FastAPI(lifespan=lifespan)
app.include_router(auth.router)
app.include_router(canvases.router)
app.include_router(ws.router)


@app.get("/health")
async def health() -> dict:
    # Queries the DB so a healthy response also means Postgres is reachable.
    pool = await get_pool()
    async with pool.acquire() as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True}

