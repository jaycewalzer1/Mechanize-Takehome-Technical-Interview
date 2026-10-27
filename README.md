# Mechanize Take-Home: Collaborative Whiteboard

Thank you for taking the time to interview with Mechanize! This repo contains your assignment for the final phase of our interview process, an open-ended take-home assignment.

The take-home begins with a solo work block of three hours in which you can complete the task as described below.

There is a 20-minute break after the solo block. During this time, our team will review your submission. If we'd like to move forward based on your progress, we'll talk to you on the follow-up call. If not, we'll cancel the follow-up calendar invite and send you an email cancelling the call.


## Getting started

1. **Clone this repo** (do _not_ fork it):
   ```bash
   git clone <this-repo-url>
   cd <this-repo-name>
   ```
2. See `SETUP.md` for how to run the scaffold.
3. Do all of your work on the **`main` branch**. Commit early and often.
4. **Push your commits directly to `main`** — do not open a pull request.
   ```bash
   git push origin main
   ```
5. Your **final commit must be pushed no later than three hours** after your start time.
   Anything pushed after the deadline will not be considered.

## What you're building

A real-time collaborative whiteboard. Multiple users, same canvas, editing together.

## Deployment context

This whiteboard is for synchronous design reviews, consisting of a small group (typically 2-5 people) on a call together, using the canvas as a shared scratchpad while they talk through a design. 
- Each user has an account and can create canvases or be invited to others'. 
- It's common for several people to be editing at once -- often the same objects -- as they try alternatives or work through a disagreement in real time. 
- A typical session runs 30-90 minutes. 
- Teams sometimes return to a canvas in a later session to recall what was decided.

## Required features

- User accounts (signup, login, logout)
- Create a canvas, open an existing canvas
- Invite other users to a canvas (by username or email -- a simple mechanism is fine)
- Shapes: rectangle, ellipse, line, text
- Select, move, resize, delete, change color
- Undo / redo
- See other users' cursors
- Canvas state persists across sessions

## Out of scope

Don't spend time on these feature, as we won't evaluate them:

- Collaborative text editing within text elements (treating a text update as a single operation is fine -- you don't need to handle two users typing in the same text box simultaneously)
- Granular permissions (viewer/editor/owner roles, share-with-link, etc.)
- Rich text editing, images, or file uploads
- Canvas zoom, pan, or infinite canvas
- Export (PNG, SVG, PDF)
- Version history or named snapshots
- Mobile or touch support

## Provided scaffold

This repository contains a minimal scaffold -- frontend, backend, and database wired together, but no whiteboard logic. You are free to restructure anything in the scaffold, but you are expected to stay within the provided stack; don't swap out the framework or database.

## How we evaluate

We evaluate whether your submission has a functional implementation of all required features above and is fit for the deployment context. Correctness and robustness for this use case and set of features matters more to us than other features beyond the required list, such as those listed as out of scope..

## Use of libraries

Don't pull in libraries that solve the core assignment for you (e.g. [tldraw](https://tldraw.dev/), [yjs](https://yjs.dev/)).

The goal is to assess your engineering skills.

## Use of AI

Use whatever AI tools you like. We recommend that you use frontier AI coding models. We are not aware of a candidate who has performed exceptionally on this take-home without using AI. However, note that you will be expected to **fully understand and defend** your implementation during the call after the solo block.

---

# Submission

Everything above this line is the original assignment, unchanged. Below: how to run the whiteboard, how it works, and what it doesn't do. The failure/concurrency contract the code is built against is [EDGE_CASES.md](EDGE_CASES.md).

## How to run

```bash
docker compose up --build
```

Open http://localhost:5173, sign up, create a canvas, and invite a second user by username or email. To act as two users on one machine, open the second one at http://127.0.0.1:5173. It's a different origin, so it gets its own session cookie.

- Cold start is safe: the server waits for the Postgres healthcheck and applies `server/schema.sql` on startup (idempotent), so no manual DB step is needed.
- No hot reload in Docker. After changing code, run `docker compose up -d --build server client`.
- Tests and local (non-Docker) runs: see [SETUP.md](SETUP.md).

## What's implemented

| README requirement | Where |
|---|---|
| Accounts: signup, login, logout | `server/app/auth.py`, `client/src/pages/AuthPage.tsx` |
| Create and open canvases | `server/app/canvases.py`, `client/src/pages/CanvasList.tsx` |
| Invite by username or email | `POST /api/canvases/{id}/members` (idempotent) |
| Rectangle, ellipse, line, text | `client/src/canvas/shapes.tsx` |
| Select, move, resize, delete, change color | `client/src/canvas/Board.tsx` |
| Undo / redo (toolbar buttons) | `client/src/undo.ts` |
| Other users' cursors, with names | `client/src/Cursors.tsx` |
| Persistence across sessions | Postgres; every edit is committed before it's broadcast |

Each row was verified by hand in two browsers as two different users. See also [How it was verified](#how-it-was-verified).

## Architecture

```
 Browser (React)                     FastAPI (one process)                  Postgres
 ───────────────                     ─────────────────────                  ────────
 Board ── onOp ──▶ useCanvasSocket ──WS /ws?canvas=…──▶ ws.py ──▶ shapes.apply_op ──▶ canvases.seq (row lock)
   ▲                 │  optimistic apply                │   in-memory room            shapes (JSONB props,
   └── shapes ◀──────┘  version filter ◀── broadcast ───┘   per canvas                  version, tombstone)
 CanvasList / AuthPage ──── REST /api ───▶ auth.py, canvases.py ─────────────────────▶ users, sessions,
                                                                                       canvas_members
```

- **REST** (`/api/...`) handles accounts, the canvas list, and invites. **One WebSocket per open canvas** carries all shape edits and cursors.
- The browser only ever talks to the Vite dev server, which proxies `/api` and `/ws`. So the httpOnly `session_id` cookie is same-origin and no CORS is needed.
- Auth: server-side sessions. Only a SHA-256 of the token is stored, and logout deletes the row. Passwords use argon2, hashed off the event loop. The WS handshake checks the Origin, the cookie and canvas membership, and closes with **1008** before joining the room if any fails.

## Sync and conflict model

This is the part that matters most for the deployment context (2-5 people editing the same objects at once).

1. **Every edit is one transaction.** It starts with `UPDATE canvases SET seq = seq + 1 ... RETURNING seq`. That takes the canvas row lock, so edits to one canvas are serialized, and `seq` order is commit order. The new `seq` becomes the shape's `version`. Membership is rechecked in the same query.
2. **Persist, then broadcast.** The server broadcasts the committed row to everyone, including the sender, only after the commit. Clients never see a change that isn't in the DB.
3. **Clients keep the highest version.** A `shape` frame whose `version` is no newer than the one held is ignored. So frames arriving out of order, or a late echo of my own drag, can't move anyone backwards, and every client ends at the DB state.
4. **Conflict policy: last writer wins, with geometry as one group.** `{x, y, width, height}` (or a line's two endpoints) is always sent and replaced as a whole. A concurrent drag and left-edge resize therefore end at exactly one user's shape, never a mix of the two (`test_C2_drag_vs_left_edge_resize_converges_to_one_users_geometry`). Color and text are separate fields, so a concurrent move and recolor both survive.
5. **Deletes are tombstones.** An edit that arrives after a delete is rejected and the sender is told, so a late drag frame never resurrects a shape. Only an explicit `restore` (undo of a delete) brings it back, with the same id.
6. **Creates are idempotent.** Shape ids are client-generated UUIDs, so a retried create is a no-op.
7. **Optimistic UI, server truth.** The client applies my edit immediately. If the server rejects it, the client reconnects and takes a fresh snapshot rather than keep a state the DB doesn't have. Every (re)connect starts from a full snapshot. While disconnected, editing is disabled ("Reconnecting… editing is paused"), so no edit is shown as saved when it wasn't.
8. **Undo is per user and goes through the same path.** An undo is sent as a normal edit, the inverse of my own op (create↔delete/restore, update -> the previous values). So it's validated, locked, versioned and broadcast like anything else. Undoing a move that someone else moved afterward applies my inverse as a new last write. Undoing something on a shape someone else deleted is skipped silently. A new edit clears redo. A drag is one undo entry.
9. **Drags stream.** About 20 updates/s, each persisted, plus a final one on release. Cursors are about 25/s, relayed to others only, and never stored.

## WebSocket protocol

`GET /ws?canvas=<uuid>`. Inbound frames are validated by `server/app/ws_schemas.py`; the TypeScript mirror is `client/src/types.ts`.

| Client -> server | Server effect |
|---|---|
| `create {id, props}` | insert; the same id again is a no-op |
| `update {id, patch}` | merge the patch (whole geometry group, or color/text) onto props, re-validate, write |
| `delete {id}` | set `deleted = true` (tombstone) |
| `restore {id}` | set `deleted = false`, props unchanged (undo of a delete, redo of a create) |
| `cursor {x, y}` | relay to the others only, nothing stored |

| Server -> client | When |
|---|---|
| `snapshot {seq, you, shapes}` | first frame on every (re)connect |
| `shape {id, props, version, deleted}` | after a shape op commits, to everyone including the sender |
| `cursor {conn_id, user_id, username, x, y}` | another connection moved its pointer |
| `leave {conn_id}` | a connection closed (drop its cursor) |
| `error {detail}` | sender only, after a rejected frame; the socket stays open. A rejected edit also gets a `shape` frame with the row's current state. |

## Key decisions

- **Canvas row lock plus versions, not CRDT/OT.** It's simple to reason about and correct for 2-5 users. Text editing is single-op (the README puts collaborative text out of scope).
- **Last writer wins on the geometry group.** Per-field merging was tried and proven to produce shapes nobody drew.
- **Tombstones instead of row deletes**, so late updates can be recognized and undo-of-delete can restore the same id.
- **Validation at the edge.** Every inbound WS frame goes through a Pydantic discriminated union (`server/app/ws_schemas.py`). That covers bounded finite coordinates, `#rrggbb` colors, text length, a whole geometry group, and no server-owned fields. A bad frame gets an error reply and the socket stays open.
- **Few automated tests, aimed at races.** The four WS tests cover the handshake, the concurrent drag vs. resize, update-after-delete, and an edit that commits while a new joiner loads its snapshot. Everything else was verified by hand.
- **Two added dependencies only:** argon2-cffi (password hashing) and react-router-dom (routing). Nothing that does drawing, sync or undo. The theme is plain CSS variables in `client/src/styles.css`.

## How it was verified

- `pytest` (4 WS race/failure tests), `ruff check`, and `npm run build` (strict TypeScript).
- Two browsers as two users for every requirement in the table above.
- A final run on a fresh clone with an empty database: 5 scripted users on one canvas through the Vite proxy, firing at the same time. It covers 100 concurrent creates with retries (no duplicates), all 5 hammering one shape (every client ends equal to the DB row, geometry from exactly one sender), delete during 4 concurrent drags (rejected, never resurrected), restore, 12 kinds of malformed frames (one error each, socket kept, nothing persisted), cursor relay to the other 4 only, a dropped connection's `leave`, one user in two tabs, random mixed edits followed by a check that every client equals the DB and a fresh snapshot, and a server restart with the state intact. 26/26 checks passed on 3 consecutive runs, with no server errors logged.

## Known limitations

- **Single server process.** Rooms live in memory, so several uvicorn workers would split a canvas's users. Fix: fan out through Postgres `LISTEN/NOTIFY`.
- **Undo history is in browser memory**, so it's lost on refresh. Fix: keep each user's op log server-side.
- **An open socket isn't closed on logout or session expiry** (EDGE_CASES W13). It keeps working until it disconnects; new handshakes are rejected. Fix: close the user's sockets on logout, or recheck the session per op.
- **Out-of-order broadcast delivery (C6) is handled by the client's version filter but not forced in a test.** Broadcasts arrive in commit order in the test client.
- **Every edit on a canvas is serialized.** That's fine at 5 users × 20 updates/s, but it's the throughput ceiling. Each drag frame is a DB write.
- **A rejected edit costs a quick reconnect** (the client resyncs from a snapshot). Rejections only happen on races like editing a just-deleted shape, or on a full canvas (2000 live shapes).
- A client whose socket is slower than 2 s per send is dropped and reconnects.
- Cursor positions are relative to the editor box. If the toolbar wraps to a different height in a very narrow window, remote cursors are offset.
- If the backend is down when a page first loads, you land on the login page (which then shows the connection error) rather than a dedicated error screen.
- Expired session rows aren't swept. Last writer wins means a concurrent drag simply loses to the later one, with no notification.

## Next steps

1. Close sockets on logout and recheck session expiry per op (W13).
2. A test that forces out-of-order broadcasts, to pin down C6.
3. Postgres `LISTEN/NOTIFY` for multi-worker rooms.
4. Server-side undo log, so history survives a refresh.
5. Coalesce drag writes: broadcast every frame, persist at most every ~200 ms plus on release.
6. Small UX: show who is dragging a shape, and z-order controls.

## Code tour (suggested reading order)

1. "Sync and conflict model" and "WebSocket protocol" above: the rules everything else implements.
2. `server/app/ws_schemas.py`: what a valid message is.
3. `server/app/shapes.py`: one transaction per edit, locking, versions, tombstones.
4. `server/app/ws.py`: handshake, room, snapshot, broadcast.
5. `server/tests/test_ws.py`: the four race and failure tests.
6. `client/src/useCanvasSocket.ts`: reconnect, snapshot, version filter, optimistic apply.
7. `client/src/canvas/Board.tsx`: pointer handling, gestures, text editing.
8. `client/src/undo.ts`, then `client/src/pages/CanvasPage.tsx`: how undo, cursors and the Board are wired together.
