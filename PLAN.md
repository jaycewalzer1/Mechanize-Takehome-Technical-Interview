# Plan: realtime shapes (phases 3-5)

Phases 1-2 (accounts, canvases, invites) are done. This file is the contract the
remaining work builds against. Changing anything in it, `server/app/ws_schemas.py`
or `client/src/types.ts` needs the owner's approval (CLAUDE.md).

## Connection
- `GET /ws?canvas=<uuid>` through the Vite proxy (same origin, so the `session_id` cookie is sent).
- Handshake, before joining the room: Origin must be allowed (S7), the cookie must resolve
  to a user (`user_from_token`), and `check_canvas_access` must pass. Otherwise
  close with **1008** and send no data (W1, S2).
- On accept, the server sends `snapshot` (all non-deleted shapes, current `seq`, `you`).
  Every reconnect gets a fresh snapshot, so that is the resync mechanism (W6).

## Messages
Defined in `server/app/ws_schemas.py` (inbound validation) and `client/src/types.ts`.

| Client -> server | Server effect |
|---|---|
| `create {id, props}` | insert; same id again = no-op (C1, I2) |
| `update {id, patch}` | merge patch onto props, re-validate, write (see Conflict policy) |
| `delete {id}` | set `deleted = true` (tombstone) |
| `restore {id}` | set `deleted = false`, props unchanged (undo delete / redo create) |
| `cursor {x, y}` | relay to the others only, nothing stored |

| Server -> client | When |
|---|---|
| `snapshot {seq, you, shapes}` | on connect |
| `shape {id, props, version, deleted}` | after a shape op commits, to **everyone** incl. sender |
| `cursor {conn_id, user_id, username, x, y}` | another connection moved |
| `leave {conn_id}` | a connection closed |
| `error {detail}` | sender only; socket stays open |

## Server rules (Track A)
- One transaction per op (F1, W3):
  1. `UPDATE canvases SET seq = seq + 1 WHERE id = $1 RETURNING seq` takes the canvas
     row lock, so ops on one canvas are serialized and `seq` is the new version.
     Canvas row first, then the shape row: one fixed lock order, so no deadlocks (C7).
  2. Shape write scoped `WHERE id = $2 AND canvas_id = $1`, setting `version = seq`.
  3. Commit, **then** broadcast (W4).
- Rejected op (missing or deleted shape, or a merged result that fails validation)
  -> roll back, send `error` to the sender **plus** a `shape` frame with the row's
  current state if it exists, so the sender's optimistic state is corrected.
- `create` with an id that exists -> no-op, no broadcast. Max 2000 live shapes per canvas (P2).
- Bad frame or DB error -> `error` to sender; the receive loop continues (W2, W3).
- Broadcast: a per-connection send failure drops that connection only (W7).
- Room registry is in memory: `# LIMITATION: multiple workers -> rooms split; fix with Postgres LISTEN/NOTIFY`.
- Session expiry while a socket is open isn't rechecked: LIMITATION (W13).

## Conflict policy
- **Geometry is one group, last writer wins on the whole group.** Box geometry is
  `{x, y, width, height}`, line geometry is `{x1, y1, x2, y2}`. A patch that touches
  geometry must send the full group (the schema rejects a partial one), and the server
  replaces the group as a unit. Why: a drag changes `{x, y}` and a left-edge resize
  changes `{x, width}`. Merged per field, the two could combine into a shape neither
  user drew (drag's `x` + resize's `width` moves the right edge). As a group, the final
  geometry is exactly one user's last write.
- **Color and text are per field, last writer wins.** So a concurrent recolor and
  drag both survive.
- **Ops on a deleted shape are rejected** (no resurrection except explicit `restore`).

## Update after delete (C3), step by step
1. A deletes shape S: the server sets `deleted = true`, `version = seq`, commits, and
   broadcasts `shape {id: S, deleted: true}`. Every client removes S.
2. B was mid-drag, so B's `update S` frames are still arriving. For each one the
   server locks the canvas row, then `SELECT ... FOR UPDATE` on S, sees `deleted = true`,
   and **rolls back** (no write, no `seq` bump, no broadcast).
3. The server sends B `error {detail: "Shape was deleted"}` followed by
   `shape {id: S, deleted: true, version: <S's version>}`. If B missed step 1's frame,
   that frame removes S now.
4. B's client: removes S from local state and ends the gesture (the drag's pointerup
   sends nothing for a shape that's gone). The undo entries for S stay on the stack,
   and an undo of them is skipped silently while S isn't live (U3).
5. The DB row stays a tombstone. Only an explicit `restore` (A's undo of the delete)
   brings S back, as a normal versioned op that everyone receives.
- **Clients ignore `shape` frames whose `version` <= the version they hold** for that id.
  Broadcasts can arrive out of commit order (C6); this filter makes every client end
  at the DB state (C2). There's no per-canvas asyncio lock.

## Client rules (Tracks B and C)
- **Optimistic local apply**: an op updates local props immediately, without changing
  `version`. The server's echo then sets props + version through the normal version filter.
- **Drag/resize** (W11, U5): send `update` with the **full geometry group** throttled
  to ~20/s, every one persisted, plus a final one on pointerup. While a gesture is active, the Board renders that
  shape from the gesture's local state, so echoes of earlier drag frames don't
  make it jump back (W9). One undo entry per gesture: `{before, after}`.
- **Disconnected** -> editing disabled, status shown; nothing is queued (W6).
- **Cursors**: send `cursor` at ~25/s; key remote cursors by `conn_id` (W8); color derived
  from `user_id`; drop them on `leave`. Separate state from shapes (P4).

## Undo / redo (Track C)
- Per user, in memory, only my own ops (U1). An undo is sent as a normal op:
  - create -> `delete`; its redo -> `restore`
  - delete -> `restore`; its redo -> `delete`
  - update -> `update` with the **before** values of what I changed: the whole
    geometry group if I moved/resized, the field if I recolored/edited text (U2: my
    inverse is a new LWW write, even if someone moved the shape since).
- Undoing anything on a shape that isn't live locally (someone else deleted it) is skipped silently (U3).
- A new op clears the redo stack (U6). History is lost on refresh: LIMITATION (U7).

## Tracks and file ownership
| Track | Owns |
|---|---|
| A: backend realtime | `server/app/ws.py`, `server/app/shapes.py`, `/ws` in `main.py`, `server/tests/test_ws*.py` |
| B: canvas editor | `client/src/canvas/*` (`Board` takes `{shapes, onOp, onGesture, disabled}`, no socket) |
| C: sync, undo, cursors | `client/src/useCanvasSocket.ts`, `client/src/undo.ts`, `client/src/Cursors.tsx`, `client/src/pages/CanvasPage.tsx` |

Commit only your own paths (`git add <paths>`), `git pull` before `git push`, never force-push.

## Testing policy for every track
- **While developing**: write and run as many throwaway tests as you like (in your
  scratchpad or /tmp, not the repo) to probe edge cases and break your own code.
- **What gets committed**: only a small set of tests for the parts of the architecture
  that are sensitive and likely to regress:
  - two users editing the same shape at once converge to the DB state (C2). Note:
    in TestClient, broadcasts happen to arrive in commit order, so removing the
    test's version filter does **not** make it fail. The out-of-order case (C6) is
    the client's filter, verified by hand in Track C.
  - concurrent drag vs left-edge resize of one shape ends at exactly one user's
    geometry, never a mix (geometry group policy)
  - no resurrection: an update after a delete is rejected (C3)
  - concurrent/duplicate creates make one row (C1)
  - WS handshake rejects a missing session or a non-member with 1008 (W1)
  - a bad frame gets an error and the socket stays open (W2)
  - undo inverse ops (create/delete/update) if there's time
  Name them after the EDGE_CASES ID (`test_C2_concurrent_update_converges`). Everything
  else is verified once by hand or a throwaway test and noted in DECISIONS.md.

## Code style for every track
Minimal code: the smallest thing that meets the rule, with no extra abstractions or
helpers "for later". Comment generously on the **why**: every lock, transaction,
version check, throttle, inverse op and effect dependency, plus `# Edge case: <ID>`
and `# LIMITATION:` tags as in CLAUDE.md. Never narrate syntax.
