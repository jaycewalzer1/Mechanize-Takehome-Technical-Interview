import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api";

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
      <div className="canvas-placeholder">Canvas goes here (phase 3–4)</div>
    </div>
  );
}
