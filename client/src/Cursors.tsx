// Other users' cursors (README requirement), plus the throttled sender for mine.
// Remote cursors are their own state, fed straight from the socket, so a
// cursor frame re-renders this overlay only, never the shapes (P4).
import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientMessage, Peer } from "./types";
import type { PeerEvent } from "./useCanvasSocket";

const SEND_INTERVAL_MS = 40; // ~25/s (W10): smooth enough to follow, cheap for 5 users

type Remote = Peer & { x: number; y: number };

// Derived from user_id, so one person has the same color in every client and
// every session with no server state.
function colorFor(userId: string): string {
  let hue = 0;
  for (const ch of userId) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${hue} 70% 45%)`;
}

export default function Cursors({ subscribe }: { subscribe: (fn: (e: PeerEvent) => void) => () => void }) {
  const [cursors, setCursors] = useState<Record<string, Remote>>({});

  // `subscribe` is stable, so this subscribes once; the returned cleanup unsubscribes.
  useEffect(
    () =>
      subscribe((e) => {
        if (e.type === "reset") {
          setCursors({});
        } else if (e.type === "leave") {
          // Edge case: W5 tab closed / network drop -> that cursor disappears.
          setCursors((c) => {
            const next = { ...c };
            delete next[e.conn_id];
            return next;
          });
        } else {
          // Edge case: W8 keyed by connection, so one user in two tabs is two cursors.
          setCursors((c) => ({ ...c, [e.conn_id]: e }));
        }
      }),
    [subscribe],
  );

  return (
    // Covers the board without catching clicks, so the Board underneath still gets every pointer event.
    <div style={{ position: "absolute", inset: 0, pointerEvents: "none", overflow: "hidden" }}>
      {Object.values(cursors).map((c) => {
        const color = colorFor(c.user_id);
        return (
          <div key={c.conn_id} style={{ position: "absolute", transform: `translate(${c.x}px, ${c.y}px)` }}>
            <svg width="14" height="18" viewBox="0 0 14 18" style={{ display: "block" }}>
              <path d="M0 0 L0 14 L4 10.5 L7 17 L9.5 16 L6.5 9.5 L12 9.5 Z" fill={color} stroke="#fff" />
            </svg>
            <span style={{ background: color, color: "#fff", fontSize: 12, padding: "1px 4px", borderRadius: 3 }}>
              {c.username}
            </span>
          </div>
        );
      })}
    </div>
  );
}

// Throttle with a trailing send: at most one frame per interval, and the
// newest position always goes out, so a cursor that stops is shown where it stopped.
export function useCursorSender(send: (op: ClientMessage) => boolean) {
  const lastSent = useRef(0);
  const latest = useRef({ x: 0, y: 0 });
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  return useCallback(
    (x: number, y: number) => {
      latest.current = { x, y };
      if (timer.current !== undefined) return; // a send is already scheduled and will use this newest position
      const wait = Math.max(0, lastSent.current + SEND_INTERVAL_MS - Date.now());
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        lastSent.current = Date.now();
        send({ type: "cursor", ...latest.current }); // dropped while disconnected; the next move resends
      }, wait);
    },
    [send],
  );
}
