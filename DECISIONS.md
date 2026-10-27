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

### Tests hit real Postgres and assert on DB rows
Decision: pytest + httpx `ASGITransport` against a `whiteboard_test` database, truncated per test. Tests check HTTP responses *and* the resulting rows (argon2 hash stored, only sha256 of the token stored, exactly one membership row after 10 concurrent invites, session row gone after logout). anyio's bundled pytest plugin, so no pytest-asyncio.
Alternative: mocking the DB, or SQLite.
Why: the guarantees we rely on (unique indexes, `ON CONFLICT`, `lower()` lookups) live in Postgres, so only real Postgres can show they hold.
Proof the tests can fail: 8 bugs injected one at a time, all caught:
skip membership check, store raw token, ignore session expiry, logout keeps the session row, case-sensitive login, invite without `ON CONFLICT`, owner not made a member, canvas list not filtered by membership.
Weakness: the pool is rebuilt per test (anyio uses a fresh event loop each time), which costs about 0.1s per test. The suite runs serially.
