// Per-user undo/redo (README "Sync and conflict model", point 8). Each entry is one of MY finished
// actions; undo and redo send an ordinary op, so it goes through server
// validation, the canvas lock and the version filter like any other edit (U1).
// LIMITATION: history is in memory only -> lost on refresh (U7); fix: keep each user's op log server-side.
import { useCallback, useMemo, useRef, useState } from "react";
import type { ClientMessage, ShapePatch } from "./types";

// One entry per user action, so a whole drag or resize is a single undo step (U5).
type UndoEntry =
  | { kind: "create"; id: string }
  | { kind: "delete"; id: string }
  // before/after hold only what the action changed: the whole geometry group
  // for a move/resize (the server rejects a partial group), or just color/text.
  | { kind: "update"; id: string; before: ShapePatch; after: ShapePatch };

type ShapeOp = Exclude<ClientMessage, { type: "cursor" }>;

// Tombstones keep their props on the server, so undoing a delete and redoing a
// create are both `restore` (U4); no props need to be remembered here.
function undoOp(e: UndoEntry): ShapeOp {
  switch (e.kind) {
    case "create":
      return { type: "delete", id: e.id };
    case "delete":
      return { type: "restore", id: e.id };
    case "update":
      // U2: my before-values become a new last-writer-wins write, even if
      // someone moved the shape since. Deterministic, and everyone sees it.
      return { type: "update", id: e.id, patch: e.before };
  }
}

function redoOp(e: UndoEntry): ShapeOp {
  switch (e.kind) {
    case "create":
      return { type: "restore", id: e.id };
    case "delete":
      return { type: "delete", id: e.id };
    case "update":
      return { type: "update", id: e.id, patch: e.after };
  }
}

export function useUndo(send: (op: ClientMessage) => boolean, isLive: (id: string) => boolean) {
  // The stacks are refs so step() always sees the latest entries; only whether each
  // is empty is state, because that's all the toolbar buttons render.
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const sync = useCallback(() => {
    setCanUndo(undoStack.current.length > 0);
    setCanRedo(redoStack.current.length > 0);
  }, []);

  const record = useCallback(
    (e: UndoEntry) => {
      undoStack.current.push(e);
      redoStack.current = []; // Edge case: U6 a new action makes the old redo branch meaningless.
      sync();
    },
    [sync],
  );

  // Pop entries until one still makes sense, send it, and move it to the other stack.
  const step = useCallback(
    (from: UndoEntry[], to: UndoEntry[], toOp: (e: UndoEntry) => ShapeOp) => {
      while (from.length > 0) {
        const entry = from.pop()!;
        const op = toOp(entry);
        // `restore` only makes sense on a shape that isn't live; delete/update only on a live one.
        // Edge case: U3 someone else deleted (or restored) the shape -> skip silently and drop
        // the entry, so the click undoes my next action instead of doing nothing.
        if ((op.type === "restore") === isLive(op.id)) continue;
        // Disconnected (W6): put the entry back, so the action isn't lost from history.
        if (!send(op)) {
          from.push(entry);
          return;
        }
        to.push(entry);
        return;
      }
    },
    [send, isLive],
  );

  const undo = useCallback(() => {
    step(undoStack.current, redoStack.current, undoOp);
    sync();
  }, [step, sync]);
  const redo = useCallback(() => {
    step(redoStack.current, undoStack.current, redoOp);
    sync();
  }, [step, sync]);
  return useMemo(() => ({ record, undo, redo, canUndo, canRedo }), [record, undo, redo, canUndo, canRedo]);
}
