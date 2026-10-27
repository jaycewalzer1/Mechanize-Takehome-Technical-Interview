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

  useEffect(() => {
    api("/canvases").then(setCanvases).catch((e) => setError(e.message));
  }, []);

  const create = async (e: any) => {
    e.preventDefault();
    try {
      const c = await api("/canvases", { body: { name } });
      navigate(`/canvas/${c.id}`);
    } catch (err: any) {
      setError(err.message);
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
        <input placeholder="New canvas name" value={name} onChange={(e) => setName(e.target.value)} />
        <button>Create canvas</button>
      </form>
      {error && <div className="error">{error}</div>}
      {canvases === null ? (
        <p>Loading…</p>
      ) : canvases.length === 0 ? (
        <p>No canvases yet. Create one, or ask someone to invite you.</p>
      ) : (
        <ul className="list">
          {canvases.map((c) => (
            <li key={c.id}>
              <Link to={`/canvas/${c.id}`}>{c.name}</Link>
              <span className="muted"> · owner {c.owner} · updated {new Date(c.updated_at).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
