// One color per user, derived from the user id alone: the same person gets the
// same color on every client and every session, with no server state.
const USER_COLORS = ["#C0392B", "#2F5D8A", "#3B7D4F", "#B7862C", "#7A4E9E", "#1F7A7A"];

export function userColor(userId: string): string {
  let hash = 0;
  for (const ch of userId) hash = (hash * 31 + ch.charCodeAt(0)) % USER_COLORS.length;
  return USER_COLORS[hash];
}
