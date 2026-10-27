# Decisions

## Requirements checklist
- [x] User accounts (signup, login, logout), verified with curl via the Vite proxy
- [x] Create a canvas, open an existing canvas (canvas page is a placeholder until phase 4)
- [x] Invite other users by username or email
- [ ] Shapes: rectangle, ellipse, line, text
- [ ] Select, move, resize, delete, change color
- [ ] Undo / redo
- [ ] See other users' cursors
- [ ] Canvas state persists across sessions (tables exist; sync not built yet)

## Changes to provided code
- `server/schema.sql`: tables added; all statements idempotent.
- `server/app/db.py`: `init_db()` retries the connection while Postgres boots, then applies `schema.sql` under an advisory lock.
- `server/app/main.py`: lifespan calls `init_db()`; auth and canvas routers registered.
- `server/pyproject.toml`: added `argon2-cffi`; dev deps `pytest`, `httpx`; pinned ruff config.
- `docker-compose.yml`: db `pg_isready` healthcheck + `condition: service_healthy` and `restart: unless-stopped` on server (scaffold issue 2); removed the initdb schema mount (the server applies it now); replaced unused `VITE_API_URL`/`VITE_WS_URL` with `API_PROXY_TARGET` (scaffold issues 1, 3).
- `client/vite.config.ts`: proxy target read from `API_PROXY_TARGET` (scaffold issue 1).
- `client/package.json`: added `react-router-dom`.
- `client/src/App.tsx`: router root.
- `SETUP.md`: removed the manual `psql -f schema.sql` step.
- Added `client/.dockerignore` / `server/.dockerignore`: without them `COPY . .` overwrote the container's node_modules with the host's (macOS) ones.

### Schema applied on server startup
Decision: the server runs `schema.sql` (all `IF NOT EXISTS`) on every start.
Alternative: Postgres initdb mount (runs only on a fresh volume), or a migration tool.
Why: schema changes during the 3h block never need `docker compose down -v`, so data isn't wiped.
Weakness: only additive changes are safe; a column type change needs a hand-written `ALTER`.

### Server-side sessions, hashed token, httpOnly cookie
Decision: `secrets.token_urlsafe(32)` goes in an httpOnly SameSite=Lax cookie `session_id`; only its SHA-256 is stored in `sessions` with `expires_at` (30 days). Logout deletes the row.
Alternative: JWTs.
Why: revocable (logout really logs out), and a DB leak doesn't leak usable tokens. Same-origin via the Vite proxy, so no CORS.
Weakness: one DB lookup per request (trivial at this scale); expired rows aren't swept.

### argon2 for passwords
Decision: `argon2-cffi`, with hashing run in a threadpool so it doesn't block the event loop (which will carry WS traffic). Unknown users are checked against a dummy hash, so the timing and the error ("Invalid username/email or password") are the same either way.
Alternative: stdlib `hashlib.scrypt` (no dependency).
Why: argon2 is the current recommendation, and the user approved it.

### One membership check for REST and WS
Decision: `check_canvas_access(canvas_id, user_id)` is transport-agnostic and raises `AccessError(404|403)`. `require_canvas_member` wraps it as a FastAPI dependency; the WS handshake (phase 3) will call it directly and close with 1008.
Why: one code path for authorization, so REST and WS can't drift apart.

### Case-insensitive usernames/emails
Decision: unique indexes on `lower(username)` and `lower(email)`; emails stored lowercased; login and invite match either field case-insensitively.
Why: EDGE_CASES V8. The DB enforces uniqueness even under concurrent signups.
Note: the `username OR email` lookup can't match two users, because `USERNAME_RE` forbids `@` and emails require it.
Weakness: that guarantee comes from app-level regexes, not a DB CHECK.

### Shapes are tombstoned
Decision: `shapes.deleted` flag, never `DELETE`. Client-generated UUID primary keys.
Why: a late move/resize for a deleted shape can be recognised and rejected instead of resurrecting it, and undo of a delete can restore it. Client IDs make create retries idempotent.

### Invites are idempotent
Decision: `INSERT ... ON CONFLICT DO NOTHING` on PK `(canvas_id, user_id)`; any member can invite.
Why: EDGE_CASES C4/V8. Double-sends and inviting an existing member return 200 with no duplicate row. Granular permissions are out of scope.

### Minimal automated testing
Decision: no tests for auth, canvas CRUD, or invites; those are verified by hand (curl + psql), as recorded above. `server/tests/conftest.py` is kept so the few sync-path tests (convergence, no resurrection after delete, WS membership rejection) can be added in phase 3.
Alternative: a broad suite. An earlier 37-test version, mutation-checked against 8 injected bugs, was removed (see git history, commit 5ded18a).
Why: in a 3-hour block, tests pay off only where bugs are race-dependent and invisible in a two-browser check.
Weakness: auth and membership regressions are caught only by manual re-checks.

### WebSocket protocol and conflict policy (PLAN.md)
Decision: one canvas-wide `seq`, bumped under the canvas row lock for every shape op and stored as the shape's `version`. Clients ignore `shape` frames with version <= what they hold. Updates are field-level patches, last writer wins. Ops on a deleted shape are rejected; only an explicit `restore` un-deletes. Every connect gets a full snapshot.
Alternative: a per-canvas `asyncio.Lock` held across write + broadcast; CRDT/OT.
Why: several people edit the same shapes at once (README). The row lock serializes writes in the DB and the version filter makes every client converge on the DB state, even if broadcasts arrive out of order. Patches let a concurrent move and recolor both survive.
Weakness: every op on a canvas is serialized (fine for 2-5 users at ~20 updates/s each); the in-memory room registry assumes a single server process.

### Few committed tests
Decision: tests are written freely during development, but only the risky concurrency/realtime paths (C1, C2/C6, C3, W1, W2) are committed. Everything else is verified by hand and noted here.
Why: the 3-hour limit, and every committed line has to be explained in review.
