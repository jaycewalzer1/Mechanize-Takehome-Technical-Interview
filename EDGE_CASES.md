# Edge case contract
Format: ID. Scenario → Expected behavior.
Placeholders resolved for this repo: PARENT = **canvas**, RESOURCE = **shape** (rect, ellipse, line, text), membership = `canvas_members`.

## C: Concurrency
C1. Two users create shapes on the same canvas at the same instant → both succeed, both appear for everyone, no lost write. Client-generated shape UUIDs + PRIMARY KEY make a duplicate create a no-op (`ON CONFLICT DO NOTHING`), not a second row.
C2. Two users move/resize/recolor the same shape at the same instant → writes are serialized by the shape row lock (`UPDATE ... RETURNING version`), every broadcast carries the new version, clients ignore updates whose version ≤ what they hold → **all clients converge to the DB state**. Test: two WS clients spam updates on one shape; final state on both equals the DB row. Must FAIL with version filtering removed.
C3. User A deletes a shape while user B is dragging/editing it → B's update matches 0 rows → B gets an error/"shape deleted" message and removes it locally. The shape is **never resurrected** by a late update.
C4. Two people invite the same user at once (or the same invite is sent twice) → UNIQUE(canvas_id, user_id) → exactly one membership row. Second request is idempotent (200) or 409 with a readable message, never a 500.
C5. Two signups with the same email/username at once → UNIQUE (case-insensitive, stored lowercased) → one succeeds, the other gets 409.
C6. Broadcast order differs from commit order (two handlers commit A then B, broadcast B then A) → version check in C2 makes clients discard the stale one. Alternatively, a per-canvas `asyncio.Lock` held across write + broadcast. Document which.
C7. Lock order for multi-row ops (e.g. delete multiple, or anything touching canvas + shapes) → canvas row FOR UPDATE first, then shape rows in id order. No deadlocks.

## U: Undo / redo (multi-user)
U1. Undo is per-user and only reverts **my own** operations. It is sent as a normal new operation (the inverse), so it goes through validation, locking, versioning, and broadcast like any edit.
U2. Undo of my move on a shape someone else moved afterward → policy documented in README.md (default: apply my inverse as a new LWW write). Behavior is deterministic and identical for all clients.
U3. Undo of my create after someone else deleted that shape → no-op (the entry is skipped or dropped), no error popup, no resurrection beyond what U4 allows.
U4. Undo of my delete → re-creates the shape with the same id and props. The DB must allow this (hard delete + re-insert, or `deleted_at` tombstone cleared).
U5. A drag or resize produces **one** undo entry (start state → end state), not one per pointermove.
U6. Making a new change after undo clears the redo stack.
U7. Undo history is client memory → lost on refresh. Acceptable; tag as LIMITATION.

## W: WebSocket / realtime
W1. WS handshake without a valid session cookie, or for a canvas the user isn't a member of → closed with 1008 before joining the room. No data leaks.
W2. Malformed frame (non-JSON, unknown `type`, wrong field types, NaN/Infinity, missing fields) → `{"type":"error"}` to the sender only; the connection and room stay up; nothing is persisted or broadcast.
W3. Exception or DB error while handling one message → transaction rolls back, nothing is broadcast, sender gets an error, the receive loop continues.
W4. Persist before broadcast → other clients never see a change that isn't in the DB.
W5. Client disconnects (tab closed, network drop, mid-drag) → removed from the room; others drop that user's cursor promptly. Shape state stays at the last committed write.
W6. Server restart / network blip → client shows "reconnecting", retries with backoff, **refetches the full canvas snapshot** on reconnect, then resumes. Edits attempted while disconnected are blocked or clearly dropped, never silently lost while showing as saved.
W7. A slow or dead socket must not block broadcasts to others: catch send failures per client, drop dead connections, and don't let one exception abort the fan-out loop.
W8. Same user in two tabs → two independent connections; both receive updates; cursors are keyed by connection id (or deduped by user, documented).
W9. Sender's own broadcast/ack → applied once (no double-apply, no jitter back to an older position while dragging).
W10. Cursor messages → throttled client-side (~20-30/s), never persisted, never in undo history, sent to others only, include the user's display name/color.
W11. Drag/resize streaming → throttled. Policy documented: persist every throttled update, or broadcast live and persist on pointerup. Either way the final position is persisted.
W12. Oversized frames (huge text, thousands of points) → rejected by schema limits (max_length, max items) with an error, not processed.
W13. Session logged out or expired while a socket is open → LIMITATION unless handled (close sockets on logout, or recheck session on each write).

## I: Idempotency / duplicates
I1. Double-click submit on any form (signup, login, create canvas, invite) → button disabled in flight; a duplicate that reaches the server is handled by UNIQUE / idempotency; exactly one row.
I2. Client timeout or disconnect after server commit, client retries the same shape create → same UUID → no duplicate. UI refetches/resyncs before showing an error.

## F: Failure
F1. Exception mid-write → nothing persisted (single transaction per operation).
F2. Constraint violation (UniqueViolation, FK, Check) → mapped to a 4xx with readable detail, never a raw 500.
F3. Backend down/slow → every screen shows a loading state, then an error state with retry, never blank. The canvas shows a connection status indicator.
F4. Non-JSON error body (Vite proxy 502/504 HTML) → api client still throws a readable error.
F5. 204 responses → client returns null, doesn't parse JSON.
F6. Refresh mid-drag or mid-request → server state is whatever committed; reload shows server truth.
F7. Persistence: draw, `docker compose restart` (or stop/start the server), reopen → every shape is identical. Canvas is still listed for every member.
F8. Cold start: `docker compose up --build` on an empty volume → server waits for DB health and doesn't crash on first connect.

## V: Validation
V1. REST: wrong types or missing fields → 422 before the route runs; UI shows field messages. WS: same schema rules, error frame (W2).
V2. Shape schema: `type` in {rect, ellipse, line, text}; x/y/width/height are finite numbers within a sane bound (reject NaN/Infinity, `allow_inf_nan=False`); color matches `^#[0-9a-fA-F]{6}$`; text has max_length. Mirror with DB CHECK constraints where possible.
V3. Every limit (text length, canvas name length, username/password length) → exactly-at-limit allowed, one-past rejected (test both).
V4. Resize past the opposite edge (negative width/height) → normalized (flip x/width) client-side before sending; server rejects negative sizes. A line keeps its two endpoints (any direction is valid).
V5. Zero-size shapes (click without drag) → policy: discard client-side or enforce a minimum size. Server never stores invalid geometry.
V6. Strings: trimmed, empty-after-trim rejected (canvas name, username), max_length on everything.
V7. Unknown ids: canvas → 404; shape id from another canvas → treated as not found (scoped query), never 500. Invite of an unknown username/email → 404 with a readable message.
V8. Email/username uniqueness and lookup are case-insensitive. Inviting yourself or an existing member → idempotent, no duplicate row.

## S: Security
S1. Every REST endpoint and WS message taking a canvas or shape id checks membership in the service → missing 404, not a member 403. One test per endpoint/message type.
S2. No, expired, or deleted session → 401 on REST, 1008 close on WS; UI returns to login.
S3. Logout deletes the session row; the old cookie is rejected afterward (REST and new WS handshakes).
S4. Same error for unknown email and wrong password.
S5. Input schemas never accept `user_id`, `owner_id`, `canvas_id` (from the body, since it comes from the path/room), `version`, or other server-owned fields.
S6. No CORS needed (Vite proxy). If added: exact origin, explicit headers, credentials, never wildcard.
S7. WS handshake checks the `Origin` header against the allowed origin (cross-site WebSocket hijacking defense, cheap to add).
S8. SQL is always parameterized (`$1`); no user input in SQL strings.
S9. Text shapes render as React text children, never `dangerouslySetInnerHTML`.

## P: Performance
P1. Opening a canvas → fixed number of queries (membership check + one shapes query), with an index on `shapes(canvas_id)`. Canvas list → one query joined through `canvas_members(user_id)`, indexed.
P2. Canvas list is per-user and small for this context; pagination is N/A (document it). Shapes per canvas are bounded by a max-shapes limit or documented as a LIMITATION.
P3. Cursor and drag messages are throttled (W10, W11) so 5 users don't flood the server or the DB.
P4. Rendering: shapes keyed by id, and cursor updates don't re-render every shape (separate state).

## R: React
R1. Every fetch → loading, error, empty, data states (canvas list empty state, canvas not found, not a member).
R2. Every fetch/WS effect → correct deps + cleanup (ignore flag for fetch, `ws.close()` for sockets). Switching canvases quickly never shows the old canvas's shapes or sockets.
R3. Every mutation → refetch affected data (or apply the server broadcast); show the server's error message.
R4. Lists and shapes → keys from ids.
R5. State updates → never mutate; updater form when depending on the previous value (WS `onmessage` handlers especially, to avoid stale closures).
R6. Pointer handling uses pointer capture so a drag that leaves the canvas/window still ends cleanly (no stuck drag).
R7. Keyboard shortcuts (Delete, Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z) are ignored while typing in an input or text box.
