// The one HTTP client: every REST call goes through api(), which turns any non-2xx
// into an ApiError carrying the server's readable `detail`.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const SESSION_EXPIRED = "session-expired";

// All requests go through the Vite proxy (same origin), so the httpOnly
// session cookie is sent automatically.
export async function api(path: string, opts: { method?: string; body?: any } = {}): Promise<any> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  // Edge case: F5 an empty body (and F4 a non-JSON one) fails to parse -> null, not a throw.
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    // Edge case: S2 a 401 outside /auth/* means the session expired or was logged out
    // in another tab. AuthProvider listens for this and drops the user, so RequireAuth
    // sends us to login. (/auth/login's 401 is just a wrong password.)
    if (res.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event(SESSION_EXPIRED));
    // Edge case: F4 a non-JSON error body (e.g. a proxy 502 page) has no detail, and
    // statusText can be empty, so fall back to the status code: never a blank error.
    let msg = data?.detail ?? (res.statusText || `Request failed (${res.status})`);
    if (Array.isArray(msg)) msg = msg.map((d: any) => d.msg).join(", ");
    throw new ApiError(res.status, String(msg));
  }
  return data;
}
