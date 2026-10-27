# Review against the spec (README, CLAUDE.md, EDGE_CASES.md, PLAN.md)

Ordered by severity. **FIXED** = changed in this review's commit; **OPEN** = still to do or accepted as a LIMITATION.

## High

1. **FIXED** `server/tests/test_ws.py:113` (C2): Alice's `create` and Bob's first `update` raced. If Bob's update was handled before the create committed, it got "Shape not found" with no `shape` frame, and the test waited forever for its 61st frame. It hung in 1 of 10 runs in this review (other batches of 10 all passed, so it's timing-dependent). Fix: wait for both clients to see the create echo before the concurrent updates (25/25 runs pass).
2. **FIXED** `server/app/ws.py:81`: a dropped connection's cleanup ran `rooms.pop(canvas_id)` by key. Two sockets dropped by `_deliver`, then a new joiner, then the second cleanup would pop the *new* room, so the joiner stops receiving every broadcast and its users silently diverge. Fix: pop only if `rooms.get(canvas_id) is room`.
3. **FIXED** `server/app/ws.py:143` (W3): only `PostgresError` was caught. `asyncpg.InterfaceError` and `OSError` (the pool reconnecting while Postgres restarts) escaped and killed the receive loop. Fix: catch `(PostgresError, InterfaceError, OSError)`. Verified with a throwaway test that raises `ConnectionRefusedError`: the old code drops the socket, the new code sends an error frame and keeps it open.

## Medium

4. **OPEN** `client/src/useCanvasSocket.ts:25,34`: a rejected op is never undone locally. The correction frame has the version the client already holds, so `<=` drops it. A rejected `create` ("Canvas is full", or a DB error) gets no frame at all, so the sender sees a shape that isn't in the DB until it reconnects (breaks the W6 rule "never shown as saved"). The code already tags this as a LIMITATION. One-line fix: on an `error` frame, close the socket so the reconnect snapshot resyncs (errors are rare).
5. **FIXED** `server/app/shapes.py:139`: `restore` skipped the 2000-live-shape cap, so undo-delete or redo-create could push a canvas past it. Fix: a shared `_check_not_full` called by both create and restore.
6. **OPEN** `server/app/shapes.py:107`: a `create` whose id already exists *on another canvas* does nothing, sends nothing back, and leaves the sender with a ghost shape. It needs a UUID collision or a malicious client. Fix: if `ON CONFLICT` returns no row, raise `OpRejected("Shape id already used")`.
7. **OPEN** `client/Dockerfile:3-4`: `npm install` runs without a lockfile, because the lockfile is the workspace one at the repo root and the build context is `./client`. A fresh clone can resolve newer versions (`vite ^6`, `react-router-dom ^7`) than the ones verified. Fix: build with `context: .` and `COPY package.json package-lock.json client/`, then `npm ci`. Or accept and document it.

## Low

8. **FIXED** `client/src/pages/CanvasList.tsx:51` (F3): a failed list fetch showed the error *and* "Loading…" forever. Now it shows the error and a Retry button.
9. **FIXED** `server/app/ws.py:28` (S7): the default Origin allowlist was only `http://localhost:5173`. Opening the app at `127.0.0.1:5173` made every socket close with 1008 "Origin not allowed". Fix: add `127.0.0.1:5173` to the default.
10. **OPEN** `server/app/auth.py:162`: signup inserts the user and the session in separate statements, not one transaction (F1). If the session insert fails, the account exists but the user gets a 500 and then "Username is already taken". Fix: one `conn.transaction()` around both.
11. **OPEN** `client/src/auth.tsx:21,27`: if `/auth/me` fails because the backend is down, the user is sent to the login page with no error. If `logout` throws, the error is an unhandled rejection with no message. Fix: keep a `bootError` state with Retry, and catch in `logout`.
12. **OPEN** `server/app/ws.py:133`: the cursor relay awaits the whole fan-out inside the sender's receive loop, so one slow peer (up to the 2s timeout) delays the sender's next shape op. Fix: `asyncio.create_task` for cursor broadcasts, or accept it (the 2s cap is already W7).
13. **OPEN** `client/src/pages/CanvasPage.tsx:159-164`: cursor coordinates are relative to the wrapper that also holds the toolbar, so they're offset when the toolbar wraps differently. Tagged as a LIMITATION in the code. Fix: measure against the Board's `<svg>`.
14. **OPEN** `client/src/undo.ts:63`: `isLive` reads `stateRef`, which updates on render. Two undo keypresses before a re-render can both see the pre-undo state and send a doomed op. The server rejects it harmlessly, but see item 4. Fix: none needed at this scale; note it.

## Brittle (works, but depends on something easy to break)
- `server/app/shapes.py:40`: `load_snapshot` must read `seq` *before* the shapes. Swapping them could hide changes behind the client's seq floor. Now commented.
- `server/app/ws.py` `pending` drain: correctness depends on there being no `await` between the last `while conn.pending` check and `conn.pending = None`. It's commented; adding a log `await` there would lose frames.
- `server/app/auth.py` login/invite `username OR email` lookup: unambiguous only because `USERNAME_RE` forbids `@`, which is an app regex, not a DB CHECK (already in DECISIONS).

## Changes to provided code not logged in DECISIONS.md (now logged)
- `server/app/main.py`: the scaffold's echo `/ws` stub was deleted and the `AsyncGenerator` import moved. The old entry only said "routers registered".
- `.gitignore`: 3 lines added.
- Root `package-lock.json`: updated by the `react-router-dom` install.

## Comments that didn't match the code (fixed)
- `DECISIONS.md`: "canvas page is a placeholder until phase 4", "WS handshake (phase 3) will call it", "can be added in phase 3", and "C2/C6 tests committed" (C6 isn't tested; it's verified by hand).
- `PLAN.md:105`: Board props were listed without `onGesture`.
- `client/src/canvas/Board.tsx:76`: said a shape can disappear because "the server rejected our op". That's false (see item 4). Track B removed it in `6ce6807`.
- `client/src/styles.css`: `.canvas-placeholder` was dead once CanvasPage mounts the Board. Removed.

## Docker
- Cold start is handled (healthcheck + `service_healthy`, plus the `init_db` retry loop). Not yet re-run from a fresh clone since the realtime work landed. Do that as part of the final check, after Track C commits `CanvasPage.tsx`.
- Item 7 (no lockfile in the client image) is the only open Docker issue.

## Interview questions: "what if the user does X, then Y?"
1. Alice drags a rectangle while Bob deletes it, and then Alice presses Ctrl+Z. What does each screen show, and what's in the DB? (C3 → U3: the drag frames are rejected, the gesture ends, and the undo entry is skipped because the shape isn't live.)
2. Bob loses Wi-Fi mid-drag, keeps dragging, then reconnects. Where does the shape end up for him and for Alice, and why doesn't his last offline position get saved? (W6: edits are blocked, nothing is queued, and the snapshot replaces local state.)
3. Alice creates a shape and Bob recolors it. Alice presses undo (delete), then redo (restore). Which color comes back, and why? (The tombstone keeps its props, so the restore brings back Bob's color.)
4. Two users drag the same shape and their broadcasts reach Carol in the opposite order from the commits. Show where Carol's client discards the stale one, and what happens if both frames carry the same version. (`applyFrame` with `version <= floor`; versions come from the canvas `seq` taken under the row lock, so they're unique.)
5. A user opens the canvas in two tabs, logs out in one, and keeps drawing in the other. What happens to the second tab's socket, and to a new tab opened afterwards? (W13 LIMITATION: the open socket keeps working because the session isn't rechecked per op; a new handshake gets 1008, and the page goes to login.)
