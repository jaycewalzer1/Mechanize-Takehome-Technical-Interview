// Login and signup share one form; on success, return to the page RequireAuth redirected from.
import { useState } from "react";
import { Link, Navigate, useLocation, useNavigate } from "react-router-dom";
import { api } from "../api";
import { useAuth } from "../auth";

export default function AuthPage({ mode }: { mode: "login" | "signup" }) {
  const { user, setUser } = useAuth();
  const navigate = useNavigate();
  const location: any = useLocation();
  const [form, setForm] = useState({ identifier: "", username: "", email: "", password: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Set by RequireAuth; the Login/Sign up links below pass it along so switching forms keeps it.
  const dest = location.state?.from ?? "/";
  if (user) return <Navigate to={dest} replace />;

  const set = (k: string) => (e: any) => setForm({ ...form, [k]: e.target.value });

  const submit = async (e: any) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const body =
        mode === "login"
          ? { identifier: form.identifier, password: form.password }
          : { username: form.username, email: form.email, password: form.password };
      setUser(await api(`/auth/${mode}`, { body }));
      navigate(dest, { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <h1>{mode === "login" ? "Log in" : "Sign up"}</h1>
      <form onSubmit={submit} className="stack">
        {mode === "login" ? (
          <input placeholder="Username or email" value={form.identifier} onChange={set("identifier")} autoFocus required />
        ) : (
          <>
            <input placeholder="Username" value={form.username} onChange={set("username")} autoFocus required />
            <input placeholder="Email" type="email" value={form.email} onChange={set("email")} required />
          </>
        )}
        <input placeholder="Password" type="password" value={form.password} onChange={set("password")} required />
        {error && <div className="error">{error}</div>}
        <button disabled={busy}>{mode === "login" ? "Log in" : "Create account"}</button>
      </form>
      <p>
        {mode === "login" ? (
          <>No account? <Link to="/signup" state={location.state}>Sign up</Link></>
        ) : (
          <>Have an account? <Link to="/login" state={location.state}>Log in</Link></>
        )}
      </p>
    </div>
  );
}
