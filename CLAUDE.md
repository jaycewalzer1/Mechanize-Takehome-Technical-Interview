# CLAUDE.md

## Context
3-hour timed take-home (Mechanize): **real-time collaborative whiteboard**. React 19 + TypeScript frontend, FastAPI backend, PostgreSQL 16, Docker Compose. `README.md` (requirements, deployment context, out of scope) and `SETUP.md` (run instructions, stack) are the source of truth. Re-read the relevant part before every feature. I must demo and explain every line in a code review right after. Optimize for code that is correct, simple, and easy to explain, not volume.

Deployment context that drives design (from README): 2-5 people on a call, often editing **the same objects at once**, 30-90 min sessions, teams come back later to see what was decided. Correctness and robustness for this use case are graded above extra features. Don't build anything in README's "Out of scope" list.

## Repo facts (verified against the scaffold at commit 9abb219)
- Provided code (initial commit): `.gitignore`, `README.md`, `SETUP.md`, `docker-compose.yml`, `package.json`, `package-lock.json`, `client/{Dockerfile,index.html,package.json,tsconfig.json,vite.config.ts}`, `client/src/{App.tsx,main.tsx,vite-env.d.ts}`, `server/{Dockerfile,pyproject.toml,schema.sql}`, `server/app/{__init__.py,db.py,main.py}`.
- Compose services: `db` (postgres:16-alpine, 5432), `server` (FastAPI/uvicorn, **3001**), `client` (Vite dev server, 5173). Containers reach each other as `db:5432` and `server:3001`.
- DB access: **raw asyncpg pool** (`server/app/db.py`). No ORM, no SQLAlchemy, no migrations tool.
- Schema: `server/schema.sql` is mounted into `/docker-entrypoint-initdb.d/`, so it **runs only when the `pgdata` volume is first created**. After any schema change: `docker compose down -v && docker compose up --build`.
- Realtime: FastAPI/Starlette built-in WebSocket at `/ws` (stub in `main.py`). Vite proxies `/api` and `/ws` to the backend.
- Already uses `lifespan` (not `@app.on_event`). `/health` is at the root, not under `/api`.
- Python deps: fastapi, uvicorn[standard], websockets, asyncpg; dev: ruff. Pydantic v2 comes in through FastAPI (not pinned directly). Dev also has pytest + httpx (approved), used only for the few tests allowed under Tests. **Not installed:** SQLAlchemy, bcrypt/passlib.
- Frontend deps: react, react-dom only. No router, no test runner. `npm run build` = `tsc -b && vite build` (strict TS).
- README allows restructuring the scaffold and adding packages, but **not** swapping the framework or database, and no libraries that solve the core assignment (tldraw, yjs, Fabric/Konva-style canvas editors, CRDT/OT libs).

### Known scaffold issues (fix only with approval, log under "Changes to provided code")
1. **Vite proxy is broken inside Docker.** `vite.config.ts` proxies to `localhost:3001`, which inside the `client` container points at the container itself. Smallest fix: read the target from an env var (e.g. `process.env.API_PROXY_TARGET ?? "http://localhost:3001"`) and set it to `http://server:3001` in compose. Keeps cookies same-origin, so no CORS is needed.
2. **No DB readiness wait.** `server` uses plain `depends_on: [db]` and builds the asyncpg pool in lifespan. On a cold first start Postgres may not be accepting connections yet, so the server crashes and has no restart policy. Fix: a `pg_isready` healthcheck on `db` plus `condition: service_healthy`.
3. `VITE_API_URL` / `VITE_WS_URL` are set in compose but nothing reads them. Prefer relative `/api` and `/ws` through the proxy.
4. No bind mounts, so there is no hot reload in Docker; code changes need `--build`. For fast iteration, run locally per SETUP.md.

## Priorities (IMPORTANT, in order)
1. Correct under bad input, failures, and concurrent users (see @EDGE_CASES.md).
2. Every line explainable. Simple beats clever.
3. Every README requirement done and verified.
4. UI polish last.

## Edge cases (IMPORTANT)
- EDGE_CASES.md is the contract for behavior under failure, concurrency, and bad input. @EDGE_CASES.md
- For every slice: list which EDGE_CASES.md items apply, implement them, and verify each one manually (curl, psql, or two browsers) and report how.
- Write an automated test for an item only if it meets the bar under Tests. Where EDGE_CASES.md says "test" (e.g. V3, S1), read it as "verify" unless the item meets that bar.
- Never mark a slice done while an applicable item is unhandled. If an item doesn't apply, say N/A and why.

## Workflow (every task)
1. Restate the task in 1-2 lines and name the README requirement it satisfies.
2. Smallest change that works. One feature or fix per step.
3. List which EDGE_CASES.md items apply; handle each and prove it (curl/psql output or browser check; a test name only for items that meet the Tests bar). N/A needs a reason.
4. Verify before saying done (see Verification). Never claim something works without running it and showing output.
5. Append to DECISIONS.md. Commit (`feat: create canvas endpoint with validation`), then `git push origin main`.
6. End with: files changed, what to read first, how you verified it, known weaknesses.

Ask before: adding a dependency, restructuring files, or changing the data model, REST contract, or WebSocket message protocol once PLAN.md is approved. Never delete or rewrite working code to "clean up" without asking.

## Provided code (do not break)
- The provided files are the ones listed under Repo facts. Extend, don't rewrite. New files, routes, functions, and components are fine.
- Editing or deleting lines in provided files requires asking first, with the exact change and why. Expected edits: `main.py` (register routers, implement `/ws`), `schema.sql` (tables), `App.tsx` (UI root), `pyproject.toml` (deps), plus the scaffold fixes above.
- Make the smallest edit and log it in DECISIONS.md under "Changes to provided code".
- There are no provided tests. Never change Docker/config just to make something pass. Fix the code instead.
- Repo conventions (ports 3001/5173/5432, service names `db`/`server`/`client`, env var `DATABASE_URL`, `/api` and `/ws` prefixes, `client/` and `server/` layout) win over this file.

## Git and submission safety
- Only `main`. Never force-push, rebase, amend pushed commits, or rewrite history. Final push must land within 3 hours of start.
- Only commit when the app builds and starts. If a change breaks the build and can't be fixed in a few minutes, revert it.
- No secrets committed. Working defaults live in docker-compose.yml (already true for the DB) so a fresh clone runs with zero manual steps.
- No scratch/debug files in the repo (use /tmp). `.gitignore` already covers node_modules, dist, .env, *.db, .DS_Store, __pycache__, .venv. `*.log` and `.pytest_cache/` are also ignored.

## Libraries
- Use the standard library, FastAPI, Pydantic v2, asyncpg, and React built-ins. Use what the repo already has.
- Never add a library that does the core assignment (canvas editing, sync, undo, CRDT/OT). If one seems necessary, stop and ask: what it does, why, and the no-library alternative.
- pytest + httpx are already approved (anyio's bundled pytest plugin, no pytest-asyncio). Optional: `bcrypt`.

## Stack rules
### Backend
- **Async everywhere.** asyncpg is async: every route, dependency, and WS handler is `async def`, and every DB call is awaited. Never make a blocking call inside `async def` (no `time.sleep`, no sync DB driver, no CPU-heavy hashing on the event loop; run password hashing via `await asyncio.to_thread(...)`).
- **Raw SQL with asyncpg.** Always use parameterized queries (`$1, $2`), never f-strings or string concatenation for SQL. Keep SQL in small repository/service functions, not in routes. Adding SQLAlchemy is a dependency change, so ask first.
- Pydantic v2 (`model_config`, `model_dump`, `field_validator`; never `orm_mode`, `.dict()`, `@validator`). Timezone-aware UTC (`datetime.now(timezone.utc)`, `timestamptz` columns), never `utcnow`.
- Separate schemas: `XCreate` / `XUpdate` (client-settable fields only, never `user_id`, `canvas_id` from the body, `version`, or other server-owned fields) and `XOut` (via `response_model` on every route). Client-generated shape UUIDs are allowed if PLAN.md chooses them (idempotent creates).
- **WebSocket messages get the same rigor as REST.** Define a Pydantic discriminated union (`type` field) for inbound messages and validate each frame with `TypeAdapter`. FastAPI doesn't auto-422 on WS, so invalid frames get an error message back and the connection stays open.
- Layers: routes and WS handlers stay thin (parse, call one service, return or broadcast). Business rules live in services and are shared by REST and WS paths.
- Errors: services raise `NotFound` / `Forbidden` / `Conflict`. One handler in `main.py` maps them to 404 / 403 / 409 `{"detail": ...}`. `asyncpg.UniqueViolationError` maps to 409, `ForeignKeyViolationError` to 404/409, `CheckViolationError` to 422. On WS, the same exceptions become `{"type":"error", ...}` to the sender. No bare except, never swallow errors, never an unhandled 500 on bad input, and the WS receive loop must never die on one bad message.
- Transactions: `async with pool.acquire() as conn: async with conn.transaction():` around all checks and writes for one operation. One transaction per service call, no partial commits. **Broadcast only after the transaction commits.**
- **Concurrency (IMPORTANT):** check-then-write alone is never acceptable.
  - Serialize writes that touch the same shape: `UPDATE shapes ... WHERE id=$1 AND canvas_id=$2 RETURNING version` takes the row lock. For multi-row rules, `SELECT ... FROM canvases WHERE id=$1 FOR UPDATE` first, then the shape rows, always in that order.
  - Every shape has a `version` (or the canvas has a monotonic `seq`) that the server increments on every write and includes in every broadcast, so clients can discard out-of-order or stale updates and all clients converge to the DB state. See EDGE_CASES C2 and C3.
  - Conflict policy (LWW vs reject stale) is a PLAN.md decision. Default: last-writer-wins for move/resize/color on a live shape, reject any op on a deleted shape.
  - Enforce everything expressible in the DB: UNIQUE (email, username, `(canvas_id, user_id)` membership), CHECK (shape type enum, color format, non-negative size), FK with `ON DELETE CASCADE`, NOT NULL.
  - Single-process assumption: in-memory WS room registry. Tag it `# LIMITATION: multiple workers -> rooms split; fix with Postgres LISTEN/NOTIFY`.
- Access: every REST or WS read/write checks canvas membership in the service (canvas missing -> 404, not a member -> 403). Every shape query is scoped `WHERE id=$1 AND canvas_id=$2`.
- Indexes match the WHERE clause of each hot query (`shapes(canvas_id)`, `canvas_members(user_id)`). Loading a canvas or the canvas list takes a fixed number of queries (no N+1).

### Auth (server-side sessions)
- Login creates `secrets.token_urlsafe(32)`, stores `sha256(token)` + `expires_at` in a `sessions` table, and sets cookie `session_id`: httpOnly, SameSite=Lax, Secure from env `COOKIE_SECURE` (default false for localhost).
- `get_current_user` dependency: hash cookie, look up, check expiry, else 401. The WS handshake reads the same cookie (`ws.cookies`) and closes with code 1008 if invalid or not a member, before joining the room. Logout deletes the row and clears the cookie.
- Passwords: bcrypt isn't installed. Recommended: stdlib `hashlib.scrypt` with a per-user random salt, verified with `hmac.compare_digest` (no new dependency). Use bcrypt only if approved. Same error for unknown email and wrong password.

### Frontend (React 19 + TypeScript, strict)
- Function components and hooks. State as local as possible; lift only to the closest common parent. Types for every API/WS payload in one `types.ts`, mirroring the backend schemas.
- All HTTP through one api client: base `/api`, `credentials: "include"`, checks `res.ok`, throws the server's `detail` (string or validation list), returns null on 204, tolerates non-JSON error bodies.
- One WebSocket hook per open canvas: connect to relative `/ws` (same origin via proxy), close in effect cleanup (StrictMode mounts twice in dev, so cleanup must fully close), reconnect with backoff, and refetch the snapshot on reconnect. Read latest state through updater functions or refs, never stale closures.
- Every fetch effect: correct deps + ignore-flag cleanup; loading, error, empty, and data states.
- Forms: controlled inputs, submit disabled in flight, server error shown next to the form. After any mutation, refetch affected data. Keys from ids. Never mutate state; use the updater form when depending on previous state.
- Frontend checks are UX only. Data integrity lives in the backend and DB.

## Code style and comments
- Plain, explicit code. Small functions, descriptive names, one job each. No dead code, unused imports, commented-out code, or features beyond the README.
- Top of each non-trivial file: 1-2 lines on its responsibility.
- Comment the WHY on anything non-obvious: locks, transactions, version checks, broadcast-after-commit, token hashing, effect deps, throttling, undo inversion, validation choices. Never narrate syntax.
- Tag handled edge cases: `# Edge case: C3 move after delete -> UPDATE matches 0 rows -> error to sender, no resurrection.`
- Tag known gaps: `# LIMITATION: <what breaks> -> <how I'd fix it>.`
- Comments must stay accurate; update them in the same edit as the code.
- Backend lint: `ruff check server` (ruff is already a dev dep).

## Tests (minimal by design)
- **Default: no automated test.** Verify by hand (curl, psql, two browsers) and report the output. No tests for CRUD, validation limits, auth flows, UI, or anything a two-browser check shows directly.
- **Write a test only when all three hold:**
  1. A bug would silently corrupt or leak shared canvas data, or make users diverge.
  2. A manual two-browser check can't reliably trigger it (timing/race-dependent).
  3. It sits on the core sync path.
- In this project that means only:
  - server conflict resolution: concurrent edits to the same shape converge to one state
  - an update/move arriving after a delete doesn't resurrect the shape (tombstone)
  - a non-member's WS connection/ops are rejected and receive no canvas data
- Keep it to roughly 3-5 tests total. Anything else needs the user's explicit OK first.
- Infrastructure already exists in `server/tests/conftest.py`: the real app via httpx `ASGITransport`, against a `whiteboard_test` Postgres database truncated per test. Assert on DB rows, not just responses.
- Those tests use N concurrent clients (`asyncio.gather` over separate connections, or threads + barrier with separate HTTP/WS clients). Assert the invariant (convergent final state, no resurrected shapes). They must FAIL with the lock or version check removed (prove it once).
- WS tests use Starlette `TestClient.websocket_connect` with two clients on one canvas, and only cover the three cases above. Invalid frames, echo behavior, etc. are checked by hand.
- Never weaken, skip, or delete a test to make it pass.

## DECISIONS.md format
Start with a "Requirements checklist": every README required feature as a checkbox (accounts, create/open canvas, invite, 4 shapes, select/move/resize/delete/color, undo/redo, cursors, persistence), ticked only after verifying. Then a "Changes to provided code" section. Then one entry per meaningful choice:

```
### <short title>
Decision: <what we did>
Alternative: <what we didn't do>
Why: <reason, tied to README deployment context or the time limit>
Weakness: <what could break / what I'd change with more time>
```

## Verification
- `docker compose up --build` from a clean state must work. After any Docker or schema change: `docker compose down -v && docker compose up --build`.
- Backend: hit each touched endpoint with valid and invalid input (curl via `localhost:3001` or `/docs`). Send valid and invalid WS frames. Inspect the affected rows with psql. Run `ruff check server` (and the few tests, if the sync path changed).
- Frontend: `npm run build` (type check) passes. Exercise the changed flow in **two browser windows logged in as different users** on the same canvas, including the error path and a backend restart (reconnect).
- Every endpoint returns a deliberate 4xx on bad input. Every WS message type rejects bad payloads without killing the socket. Every form shows errors instead of failing silently.

## Docker gotchas
- The browser calls `localhost:5173` (Vite) and Vite proxies to the backend. Containers call service names (`db:5432`, `server:3001`), never `localhost`. See scaffold issue 1.
- Frontend-to-backend: Vite dev proxy (`/api` and `/ws` -> server), so cookies are same-origin and no CORS is needed. Don't add CORSMiddleware unless we abandon the proxy; if we do, use the exact origin, `allow_credentials=True`, explicit headers, never a wildcard.
- uvicorn `--host 0.0.0.0` (already set); Vite `--host` (already set).
- `depends_on` doesn't wait for readiness: add a DB healthcheck + `condition: service_healthy` (scaffold issue 2).
- `schema.sql` only runs on a fresh volume, so use `down -v` after changing it.
- If a client bind mount is ever added, it needs an anonymous `/app/node_modules` volume.

## Final submission check (when I say "final check")
Run each and report pass/fail:
1. Fresh clone into /tmp, `docker compose up --build`, starts with no manual steps (cold DB, no race).
2. Every item in the DECISIONS.md requirements checklist works, demonstrated with two users in two browsers.
3. Every EDGE_CASES.md item: COVERED (manual check, or test name for sync-path items) or N/A (reason).
4. Bad input to every endpoint, WS message type, and form: no 500s, no dropped sockets, no blank screens.
5. Persistence: draw, `docker compose restart`, reopen, and everything is there.
6. The few sync-path tests pass; `npm run build` and `ruff check server` are clean.
7. `git status` clean; `git log origin/main -1` matches local.
8. README has: how to run, architecture (incl. sync/conflict model), what's implemented, key decisions, known limitations, next steps.

## Compaction
Always preserve: requirements checklist status, EDGE_CASES.md coverage status, modified provided-files list, the agreed WS protocol and conflict policy, current task, unresolved bugs.
