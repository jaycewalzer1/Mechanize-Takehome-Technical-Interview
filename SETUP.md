# Setup

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose
- [Node.js](https://nodejs.org/) 22+ (for the frontend)
- [Python](https://www.python.org/) 3.12+ (for the backend)

## Running with Docker Compose

```bash
docker compose up --build
```

This starts:
- **PostgreSQL** on port 5432
- **Backend (FastAPI)** on port 3001
- **Frontend (React)** on port 5173

Open http://localhost:5173 in your browser.

## Running locally (without Docker)

You need a running PostgreSQL instance. The default connection string is `postgres://whiteboard:whiteboard@localhost:5432/whiteboard`.

```bash
# Start Postgres (if you don't have one running)
docker compose up db

# Install and start the backend
cd server
pip install -e .
uvicorn app.main:app --reload --port 3001

# In another terminal — install and start the frontend
cd client
npm install
npm run dev
```

The server applies `server/schema.sql` on startup (all statements are idempotent), so schema changes never need a volume wipe.

The frontend dev server proxies `/api` and `/ws` to the backend (`API_PROXY_TARGET`, default `http://localhost:3001`). The browser only ever talks to Vite, so the httpOnly session cookie is same-origin.

## Running tests

Tests run the real app (in-process, via httpx) against a separate `whiteboard_test` database on the same Postgres, created automatically and truncated before each test.

```bash
docker compose up -d db
cd server
python3 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q
.venv/bin/ruff check app tests
```

Override the Postgres location with `TEST_ADMIN_DATABASE_URL` (defaults to the compose db on localhost:5432).

## Project structure

```
├── client/             # React frontend
│   ├── src/
│   │   ├── App.tsx     # Root component
│   │   └── main.tsx    # Entry point
│   └── vite.config.ts
├── server/             # FastAPI backend
│   ├── app/
│   │   ├── db.py       # Postgres connection pool (asyncpg)
│   │   └── main.py     # FastAPI app, HTTP routes, WebSocket endpoint
│   └── schema.sql      # Idempotent schema, applied by the server on every startup
└── docker-compose.yml
```

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Backend | FastAPI, Python 3.12, uvicorn |
| Database | PostgreSQL 16 |
| WebSocket | FastAPI built-in (via Starlette) |

You are free to add any packages you need (pip or npm). Do not swap out the framework or database — we want submissions to be comparable.
