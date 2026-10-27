// Who is logged in, shared app-wide; RequireAuth sends anyone without a session to /login.
import { createContext, useContext, useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { api, ApiError, SESSION_EXPIRED } from "./api";

type AuthState = {
  user: any | null;
  loading: boolean;
  setUser: (u: any | null) => void;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState>(null as any);

export function AuthProvider({ children }: { children: any }) {
  const [user, setUser] = useState<any | null>(null);
  const [loading, setLoading] = useState(true);

  // The session cookie is httpOnly (JS can't read it), so ask the server once on load
  // whether it's still valid. A 401 just means "not logged in", not an error.
  useEffect(() => {
    api("/auth/me")
      .then(setUser)
      .catch((e) => {
        if (!(e instanceof ApiError && e.status === 401)) console.error(e);
      })
      .finally(() => setLoading(false));
  }, []);

  // Edge case: S2 any API call that finds the session gone logs us out here (see api.ts).
  useEffect(() => {
    const expire = () => setUser(null);
    window.addEventListener(SESSION_EXPIRED, expire);
    return () => window.removeEventListener(SESSION_EXPIRED, expire);
  }, []);

  const logout = async () => {
    await api("/auth/logout", { method: "POST" });
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, setUser, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

export function RequireAuth({ children }: { children: any }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <div className="page">Loading…</div>;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return children;
}
