import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api";
import { useAuth } from "../auth";
import Board from "../canvas/Board";
import Cursors, { useCursorSender } from "../Cursors";
import type { ClientMessage, ShapePatch } from "../types";
import { useCanvasSocket } from "../useCanvasSocket";
import { useUndo } from "../undo";

export default function CanvasPage() {
  const { id } = useParams();
  const [canvas, setCanvas] = useState<any>(null);
  const [error, setError] = useState<any>(null);
  const [invitee, setInvitee] = useState("");
  const [inviteMsg, setInviteMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false; // a stale response for a previous id must not overwrite this one
    setCanvas(null);
    setError(null);
    api(`/canvases/${id}`)
      .then((c) => !ignore && setCanvas(c))
      .catch((e) => !ignore && setError(e));
    return () => {
      ignore = true;
    };
  }, [id]);

  const invite = async (e: any) => {
    e.preventDefault();
    setInviteMsg("");
    setBusy(true);
    try {
      const { members } = await api(`/canvases/${id}/members`, { body: { identifier: invitee } });
      setCanvas((c: any) => ({ ...c, members }));
      setInviteMsg(`Invited ${invitee}`);
      setInvitee("");
    } catch (err: any) {
      setInviteMsg(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return (
      <div className="page">
        <p className="error">{error.status === 403 ? "You don't have access to this canvas." : error.message}</p>
        <Link to="/">← Back to canvases</Link>
      </div>
    );
  }
  if (!canvas) return <div className="page">Loading…</div>;

  return (
    <div className="page">
      <header className="row">
        <Link to="/">← Canvases</Link>
        <h1>{canvas.name}</h1>
      </header>
      <section className="row">
        <span>Members: {canvas.members.map((m: any) => m.username).join(", ")}</span>
        <span className="spacer" />
        <form onSubmit={invite} className="row">
          <input placeholder="Invite by username or email" value={invitee} onChange={(e) => setInvitee(e.target.value)} required />
          <button disabled={busy}>Invite</button>
        </form>
      </section>
      {inviteMsg && <div className="muted">{inviteMsg}</div>}
      {/* key: a different canvas gets a fresh socket, undo history and cursors (R2). */}
      <CanvasEditor key={canvas.id} canvasId={canvas.id} />
    </div>
  );
}

// The live editor: wires the socket, undo history and cursors to the Board.
function CanvasEditor({ canvasId }: { canvasId: string }) {
  const { setUser } = useAuth();
  const socket = useCanvasSocket(canvasId);
  const history = useUndo(socket.send, socket.isLive);
  const sendCursor = useCursorSender(socket.send);
  const { rejected, error, setError, send, liveProps } = socket;
  const { record } = history;

  // The Board reports create, delete, color and text only through onOp, and
  // geometry once per finished drag/resize through onGesture (U5), so undo
  // entries come from both.
  const onOp = useCallback(
    (op: ClientMessage) => {
      // Read the before-values first: send applies the op optimistically.
      const before = op.type === "update" ? liveProps(op.id) : undefined;
      if (!send(op)) return;
      if (op.type === "create" || op.type === "delete") {
        record({ kind: op.type, id: op.id });
      } else if (op.type === "update" && before && !("x" in op.patch || "x1" in op.patch)) {
        // Color/text edit. Geometry updates here are throttled drag frames;
        // their single undo entry arrives through onGesture instead.
        const fields = Object.keys(op.patch) as (keyof ShapePatch)[];
        const old = Object.fromEntries(fields.map((k) => [k, (before as any)[k]])) as ShapePatch;
        record({ kind: "update", id: op.id, before: old, after: op.patch });
      }
    },
    [send, liveProps, record],
  );

  const onGesture = useCallback(
    (e: { id: string; before: ShapePatch; after: ShapePatch }) => record({ kind: "update", ...e }),
    [record],
  );

  // A 1008 close means either the session is gone (S2: back to login) or access
  // was refused (show why). Asking /auth/me tells the two apart without
  // depending on the server's close-reason wording.
  useEffect(() => {
    if (!rejected) return;
    let ignore = false;
    api("/auth/me").catch((e) => {
      if (!ignore && e instanceof ApiError && e.status === 401) setUser(null); // RequireAuth redirects
    });
    return () => {
      ignore = true;
    };
  }, [rejected, setUser]);

  // Server errors are transient (e.g. "Shape was deleted" mid-drag), so show each for a few seconds.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 4000);
    return () => clearTimeout(t);
  }, [error, setError]);

  // Listening on window so the shortcuts work wherever focus is on the page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "z") return;
      const t = e.target as HTMLElement;
      // Edge case: R7 in a text field, Ctrl/Cmd+Z belongs to the field (the invite box, a text shape's editor).
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      e.preventDefault();
      if (e.shiftKey) history.redo();
      else history.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [history]);

  if (rejected) return <p className="error">Can't open this canvas: {rejected}</p>;

  return (
    <>
      <div className="muted">
        {socket.status === "open" ? "Live" : socket.status === "connecting" ? "Connecting…" : "Reconnecting… editing is paused"}
      </div>
      {error && <div className="error">{error}</div>}
      {/* Cursor coordinates are relative to this box, which every client lays
          out the same way (no zoom/pan), so a cursor lands on the same spot.
          LIMITATION: if the Board's toolbar wraps to a different height in a
          narrow window, cursors there are offset by the difference -> fix:
          send coordinates relative to the Board's <svg>. */}
      <div
        style={{ position: "relative" }}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          sendCursor(Math.round(e.clientX - r.left), Math.round(e.clientY - r.top));
        }}
      >
        <Board shapes={socket.shapes} onOp={onOp} onGesture={onGesture} disabled={socket.status !== "open"} />
        <Cursors subscribe={socket.subscribePeers} />
      </div>
    </>
  );
}
