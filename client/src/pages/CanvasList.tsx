// Home page: the canvases I'm a member of, plus a form to create a new one.
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

export default function CanvasList() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [canvases, setCanvases] = useState<any[] | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let ignore = false; // drop the response if we unmounted (StrictMode double-mount)
    api("/canvases")
      .then((cs) => !ignore && setCanvases(cs))
      .catch((e) => !ignore && setError(e.message));
    return () => {
      ignore = true;
    };
  }, []);

  const create = async (e: any) => {
    e.preventDefault();
    setBusy(true); // disabled in flight so a double-click can't create two canvases
    try {
      const c = await api("/canvases", { body: { name } });
      // No setBusy(false) on success: we navigate away, and re-enabling first would allow a second create.
      navigate(`/canvas/${c.id}`);
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="row">
        <h1>Canvases</h1>
        <span className="spacer" />
        <span>Signed in as <b>{user.username}</b></span>
        <button onClick={logout}>Log out</button>
      </header>
      <form onSubmit={create} className="row">
        <input placeholder="New canvas name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <button disabled={busy}>Create canvas</button>
      </form>
      {error && <div className="error">{error}</div>}
      {canvases === null ? (
        // Edge case: F3 a failed fetch shows its error (above) plus a retry, never an endless "Loading…".
        error ? <button onClick={() => window.location.reload()}>Retry</button> : <p>Loading…</p>
      ) : canvases.length === 0 ? (
        <p>No canvases yet. Create one, or ask someone to invite you.</p>
      ) : (
        <ul className="list">
          {canvases.map((c) => (
            <li key={c.id}>
              <Link to={`/canvas/${c.id}`} className="pill-link">{c.name}</Link>
              <span className="muted meta">owner {c.owner} · updated {new Date(c.updated_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
