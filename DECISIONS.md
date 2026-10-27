# Decisions

## Requirements checklist
- [x] User accounts (signup, login, logout), verified with curl via the Vite proxy
- [x] Create a canvas, open an existing canvas
- [x] Invite other users by username or email
- [x] Shapes: rectangle, ellipse, line, text (Track B, in Chrome against the Docker app)
- [x] Select, move, resize, delete, change color (Track B, in Chrome)
- [x] Undo / redo (two browsers, two users: U2 my undo overwrites B's later move (LWW), U3 undo of a create someone deleted is skipped silently, U4 undo of a delete restores the same id, U6 a new edit clears redo)
- [x] See other users' cursors (two WS clients through the proxy on a fresh clone: cursor relayed with username, `leave` on close)
- [x] Canvas state persists across sessions (fresh clone: create + recolor, `docker compose restart`, both users' snapshots identical, canvas still listed for the invitee)

## Changes to provided code
- `server/schema.sql`: tables added; all statements idempotent; a `shapes_props_valid` CHECK (known type, `#rrggbb` color) added in a DO block that ignores the duplicate error.
- `server/app/db.py`: `init_db()` retries the connection while Postgres boots, then applies `schema.sql` under an advisory lock.
- `server/app/main.py`: lifespan calls `init_db()`; auth, canvas and ws routers registered; the scaffold's echo `/ws` stub removed (replaced by `app/ws.py`); `typing.AsyncGenerator` import moved to `collections.abc` (ruff UP035).
- `server/app/main.py`: the `/ws` stub replaced by the `ws` router (`app/ws.py`); `AsyncGenerator` imported from `collections.abc` (ruff UP035).
- `server/pyproject.toml`: added `argon2-cffi`; dev deps `pytest`, `httpx`; pinned ruff config.
- `docker-compose.yml`: db `pg_isready` healthcheck + `condition: service_healthy` and `restart: unless-stopped` on server (scaffold issue 2); removed the initdb schema mount (the server applies it now); replaced unused `VITE_API_URL`/`VITE_WS_URL` with `API_PROXY_TARGET` (scaffold issues 1, 3).
- `client/vite.config.ts`: proxy target read from `API_PROXY_TARGET` (scaffold issue 1).
- `client/package.json`: added `react-router-dom` (root `package-lock.json` updated by npm workspaces to match).
- `.gitignore`: added `*.tsbuildinfo`, `.pytest_cache/`, `*.log`.
- `client/src/App.tsx`: router root.
- `SETUP.md`: removed the manual `psql -f schema.sql` step.
- `client/Dockerfile`: a LIMITATION comment only (no behavior change) on the unpinned `npm install`; see REVIEW item 7.
- `README.md`: appended run/architecture/decisions/limitations sections below the assignment text (original text unchanged).
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
Decision: `check_canvas_access(canvas_id, user_id)` is transport-agnostic and raises `AccessError(404|403)`. `require_canvas_member` wraps it as a FastAPI dependency; the WS handshake calls it directly and closes with 1008.
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
Decision: no tests for auth, canvas CRUD, or invites; those are verified by hand (curl + psql), as recorded above. The few sync-path tests are listed under "Committed WS tests" below.
Alternative: a broad suite. An earlier 37-test version, mutation-checked against 8 injected bugs, was removed (see git history, commit 5ded18a).
Why: in a 3-hour block, tests pay off only where bugs are race-dependent and invisible in a two-browser check.
Weakness: auth and membership regressions are caught only by manual re-checks.

### WebSocket protocol and conflict policy (PLAN.md)
Decision: one canvas-wide `seq`, bumped under the canvas row lock for every shape op and stored as the shape's `version`. Clients ignore `shape` frames with version <= what they hold. Geometry (`x, y, width, height` or line endpoints) is written as one whole group, last writer wins on the group; color and text are per field. Ops on a deleted shape are rejected; only an explicit `restore` un-deletes. Every connect gets a full snapshot.
Alternative: a per-canvas `asyncio.Lock` held across write + broadcast; CRDT/OT.
Why: several people edit the same shapes at once (README). The row lock serializes writes in the DB and the version filter makes every client converge on the DB state, even if broadcasts arrive out of order. Grouping geometry means a concurrent drag and left-edge resize end at exactly one user's shape, never a mix; per-field color/text lets a concurrent move and recolor both survive.
Weakness: every op on a canvas is serialized (fine for 2-5 users at ~20 updates/s each); the in-memory room registry assumes a single server process.

### Few committed tests
Decision: tests are written freely during development, but only the risky concurrency/realtime paths (C1, C2, C3, W1, W2) are committed. C6 (out-of-order broadcasts) is covered only by code review of the client's version filter (`applyFrame` in `useCanvasSocket.ts`): out-of-order delivery can't be forced from a browser or from TestClient. LIMITATION: no automated proof; with more time, unit-test `applyFrame` with frames fed in reverse commit order. Everything else is verified by hand and noted here.
Why: the 3-hour limit, and every committed line has to be explained in review.

### WS handshake: accept, then close 1008
Decision: `/ws` accepts the socket, runs the checks (Origin, session cookie, canvas membership), and on failure closes with 1008 and a reason, before joining the room or sending any data.
Alternative: close before accept.
Why: a pre-accept close reaches the browser as a generic 1006, indistinguishable from "server down", so the client couldn't tell "log in again" apart from "reconnect".
Weakness: an unauthenticated client briefly holds an open socket (a few ms).

### Snapshot vs concurrent broadcasts
Decision: a new connection joins the room *before* the snapshot query; broadcasts that arrive while the snapshot is loading are buffered on the connection and sent right after it.
Why: joining after the query could miss a change committed in between; sending those broadcasts before the (older) snapshot would let the snapshot overwrite them on the client.

### Membership rechecked on every op
Decision: the `UPDATE canvases SET seq = seq + 1` that takes the canvas lock also requires a `canvas_members` row (one query).
Why: EDGE_CASES S1, at no extra round trip.

### Broadcast fan-out
Decision: sends run concurrently (`asyncio.gather`) with a 2s timeout each; a failed or slow socket is removed from the room and closed with 1011, so its client reconnects and resyncs from a snapshot.
Why: W7: one dead tab must not stall the room. This is the one place the code catches a broad `Exception`: any send failure means the same thing.
Weakness: a client on a very slow network for >2s gets dropped and reconnects.

### Committed WS tests (server/tests/test_ws.py)
- `test_W1_handshake_rejects_no_session_and_non_member`
- `test_W2_bad_frames_get_error_and_socket_stays_open` (non-JSON, unknown type, NaN, partial geometry, `version` field)
- `test_C2_drag_vs_left_edge_resize_converges_to_one_users_geometry`: proven once to fail under per-field geometry merging (final rect `x=130, y=130, width=130`, a right edge nobody drew). Removing the test's version filter does *not* make it fail (broadcasts arrive in commit order in TestClient), so C6 is covered only by code review of the client's version filter (`applyFrame` in `useCanvasSocket.ts`): out-of-order delivery can't be forced from a browser or from TestClient. LIMITATION: no automated proof; with more time, unit-test `applyFrame` with frames fed in reverse commit order.
- `test_C3_update_after_delete_is_rejected_and_never_resurrects` (also C1: a duplicate create is a no-op)
Verified by hand through the Vite proxy in Docker: snapshot, create broadcast, bad frame -> error with the socket open, foreign Origin -> 1008, no cookie -> 1008.

### Supervisor review fixes (see REVIEW.md)
- `ws.py`: a dropped connection's cleanup only removes the room if it is still the registered one (it could otherwise orphan a newer room's sockets); `InterfaceError`/`OSError` from the DB (pool reconnecting while Postgres restarts) now return an error frame instead of killing the socket (W3; verified with a throwaway test that fails on the old code); `127.0.0.1:5173` added to the default allowed origins.
- `shapes.py`: `restore` checks the live-shape cap too, so undo/redo can't push a canvas past 2000 shapes.
- `test_ws.py` C2: waits for the create echo before the concurrent updates. Previously ~1 in 10 runs hung: Bob's first update could be handled before Alice's create committed, get "Shape not found", and the test waited forever for a frame that never comes. 25/25 runs pass after.
- `CanvasList.tsx`: a failed list fetch shows the error and a Retry button instead of "Loading…" forever (F3).

### Two-browser verification (latest main, Docker)
User A on localhost:5173, user B on 127.0.0.1:5173. W6: `docker compose stop server` -> "Reconnecting… editing is paused", B's Delete while offline blocked -> reconnect after ~7.6s; a color changed directly in the DB while the server was down showed in both tabs (snapshot refetch). S2/S3: after logout, reopening the canvas redirects to /login and the old cookie gets 401. Signup shows field errors; invite matches case-insensitively.

### Zero-size shapes are discarded client-side (V5)
Decision: a draw smaller than 2px (a click without a drag) creates nothing, and the
server's schema rejects width/height < 1 as a backstop.
Alternative: enforce a minimum size, which would leave stray dots on every misclick.
Why: in a fast design review, accidental clicks are common; silently dropping them is least surprising.

### Edge-case audit fixes
- S2: a 401 from any non-auth REST call fires a `session-expired` event that
  AuthProvider turns into a logout, so RequireAuth redirects to login (before, the
  page just showed "Not logged in" until a refresh).
- F4: an error with no JSON detail and an empty statusText shows "Request failed (<status>)", never a blank message.
- F3: the canvas page's error screen has a Retry button for server/network failures.
- Cursors: leaving the board sends an off-board cursor position, so other users don't
  see it frozen at the edge. No new message type: the overlay clips it.
- V2: DB CHECK `shapes_props_valid` (known type, `#rrggbb` color) as defense in depth behind Pydantic.
Not changed: the brief snap-back after a drag ends (echoes of in-flight drag frames,
at most one round trip, invisible on localhost) would need per-shape tracking of
unconfirmed ops in the sync core. LIMITATION.
