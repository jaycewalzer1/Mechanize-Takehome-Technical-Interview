// One WebSocket per open canvas (PLAN "Connection"): holds the server's shape
// state plus my optimistic edits, reconnects with backoff, and hands cursor
// frames to <Cursors> without touching shape state (P4).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ClientMessage, ServerMessage, Shape, ShapeProps } from "./types";

export type Status = "connecting" | "open" | "reconnecting";
// "reset" is local: a fresh snapshot means any cursor we hold may belong to a
// connection whose `leave` we missed while disconnected.
export type PeerEvent = Extract<ServerMessage, { type: "cursor" } | { type: "leave" }> | { type: "reset" };

type ShapeFrame = Extract<ServerMessage, { type: "shape" }>;
// Tombstones (deleted: true) stay in byId but aren't rendered; see applyFrame.
type Held = { props: ShapeProps; version: number; deleted: boolean };
type State = { seq: number; byId: Record<string, Held> };

const MAX_BACKOFF_MS = 10_000;

function applyFrame(state: State, f: ShapeFrame): State {
  // Edge case: C2/C6 broadcasts can arrive out of commit order. A frame at or
  // below the version we hold is stale, so every client ends at the DB state.
  // The snapshot's seq is a floor too: it already reflects every commit up to
  // it, so an older frame for a shape we don't hold must not add it back.
  const floor = Math.max(state.byId[f.id]?.version ?? 0, state.seq);
  if (f.version <= floor) return state;
  // Keeping the tombstone (instead of deleting the key) is what stops a late,
  // older update frame from resurrecting a deleted shape locally (C3).
  return { ...state, byId: { ...state.byId, [f.id]: { props: f.props, version: f.version, deleted: f.deleted } } };
}

// Optimistic apply (PLAN client rules): props change now, `version` doesn't,
// so the server's echo (always a higher version) still passes the filter and
// replaces this with the committed state.
// LIMITATION: a rejected op on a shape nobody else touched gets a correction
// frame with the version we already hold, which the filter drops -> my local
// state stays wrong until reconnect. Only reachable if the client sends
// something invalid; fix: apply equal-version frames too (needs a PLAN change).
function applyLocal(state: State, op: Exclude<ClientMessage, { type: "cursor" }>): State {
  const held = state.byId[op.id];
  let next: Held;
  switch (op.type) {
    case "create":
      next = { props: op.props, version: 0, deleted: false };
      break;
    case "update":
      if (!held || held.deleted) return state;
      // A geometry patch carries its whole group, so spreading it replaces the
      // group as a unit, exactly as the server merges it.
      next = { ...held, props: { ...held.props, ...op.patch } as ShapeProps };
      break;
    case "delete":
    case "restore":
      // Restoring a tombstone we hold shows it at once; one we don't hold
      // (deleted before our snapshot) appears when the server's echo arrives.
      if (!held) return state;
      next = { ...held, deleted: op.type === "delete" };
      break;
  }
  return { ...state, byId: { ...state.byId, [op.id]: next } };
}

export function useCanvasSocket(canvasId: string) {
  const [state, setState] = useState<State>({ seq: 0, byId: {} });
  const [status, setStatus] = useState<Status>("connecting");
  const [rejected, setRejected] = useState<string | null>(null); // 1008 close reason
  const [error, setError] = useState<string | null>(null); // last server `error` frame
  const wsRef = useRef<WebSocket | null>(null);
  // True only between this socket's snapshot and its close: editing before the
  // snapshot would apply to state the snapshot is about to replace.
  const readyRef = useRef(false);
  const peerListeners = useRef(new Set<(e: PeerEvent) => void>());
  // Read by isLive from event handlers (undo), which would otherwise see the state of an old render.
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    // One flag per effect run: after cleanup (StrictMode's double mount, or
    // leaving the canvas) that run's socket can't touch state or reconnect.
    let stopped = false;
    let attempt = 0;
    let timer: number | undefined;
    const emitPeers = (e: PeerEvent) => peerListeners.current.forEach((fn) => fn(e));

    const connect = () => {
      // Same origin through the Vite proxy, so the browser sends the httpOnly session cookie with the handshake.
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws?canvas=${encodeURIComponent(canvasId)}`);
      wsRef.current = ws;

      ws.onmessage = (ev) => {
        if (stopped) return;
        const msg: ServerMessage = JSON.parse(ev.data);
        switch (msg.type) {
          case "snapshot":
            // Edge case: W6 every (re)connect replaces ALL shape state with server
            // truth, dropping optimistic edits the old socket never confirmed.
            setState({
              seq: msg.seq,
              byId: Object.fromEntries(
                msg.shapes.map((s) => [s.id, { props: s.props, version: s.version, deleted: false }]),
              ),
            });
            emitPeers({ type: "reset" });
            attempt = 0;
            readyRef.current = true;
            setStatus("open");
            break;
          case "shape":
            setState((s) => applyFrame(s, msg));
            break;
          case "cursor":
          case "leave":
            emitPeers(msg);
            break;
          case "error":
            setError(msg.detail);
            break;
        }
      };

      ws.onclose = (ev) => {
        if (stopped) return;
        readyRef.current = false;
        if (ev.code === 1008) {
          // Edge case: W1/S2 the server refused us (no session, not a member):
          // retrying can't fix that, so stop and let the page say why.
          setRejected(ev.reason || "Access denied");
          return;
        }
        // Edge case: W6 restart or network blip -> retry after 0.5s, 1s, 2s, ...
        // capped at 10s, so a down server isn't hammered. Edits stay blocked
        // until the next snapshot.
        setStatus("reconnecting");
        timer = window.setTimeout(connect, Math.min(500 * 2 ** attempt++, MAX_BACKOFF_MS));
      };
    };

    connect();
    return () => {
      stopped = true;
      readyRef.current = false;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [canvasId]);

  // Returns false when the op wasn't sent. Edge case: W6 nothing is queued while
  // disconnected, so an edit is never shown as saved when it wasn't.
  const send = useCallback((op: ClientMessage): boolean => {
    const ws = wsRef.current;
    if (!readyRef.current || !ws || ws.readyState !== WebSocket.OPEN) return false;
    if (op.type !== "cursor") setState((s) => applyLocal(s, op));
    ws.send(JSON.stringify(op));
    return true;
  }, []);

  // Current props of a live shape, or undefined if it's deleted or unknown.
  const liveProps = useCallback((id: string): ShapeProps | undefined => {
    const held = stateRef.current.byId[id];
    return held && !held.deleted ? held.props : undefined;
  }, []);
  const isLive = useCallback((id: string) => liveProps(id) !== undefined, [liveProps]);

  // Cursor frames go to subscribers instead of state here, so they re-render
  // only <Cursors>, never the Board (P4). Returns the unsubscribe function.
  const subscribePeers = useCallback((fn: (e: PeerEvent) => void) => {
    peerListeners.current.add(fn);
    return () => {
      peerListeners.current.delete(fn);
    };
  }, []);

  const shapes: Shape[] = useMemo(
    () =>
      Object.entries(state.byId)
        .filter(([, h]) => !h.deleted)
        .map(([id, h]) => ({ id, props: h.props, version: h.version })),
    [state.byId],
  );

  return { shapes, status, rejected, error, setError, send, isLive, liveProps, subscribePeers };
}
