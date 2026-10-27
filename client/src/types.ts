// WebSocket protocol types (see PLAN.md). Mirrors server/app/ws_schemas.py;
// keep the two in sync. Limits here are for UX only: the server enforces them.

export const COORD_LIMIT = 10_000;
export const MAX_TEXT = 1_000;

// --- Shape props: what the server stores in shapes.props --------------------

export type BoxProps = {
  type: "rect" | "ellipse";
  x: number;
  y: number;
  width: number; // >= 1: normalize negative sizes before sending (V4)
  height: number;
  color: string; // "#rrggbb"
};

export type TextProps = {
  type: "text";
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
  text: string; // 1..MAX_TEXT chars, rendered as a React text child (S9)
};

// A line is its two endpoints, so any direction is valid.
export type LineProps = {
  type: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
};

export type ShapeProps = BoxProps | TextProps | LineProps;
export type ShapeType = ShapeProps["type"];

// Only the fields sent are changed on the server; `type` can't change.
export type ShapePatch = Partial<Omit<BoxProps, "type"> & Omit<TextProps, "type"> & Omit<LineProps, "type">>;

// A shape as the server sends it.
export type Shape = {
  id: string;
  props: ShapeProps;
  version: number; // canvas seq of its last change; ignore broadcasts with version <= held (C2)
};

// --- Client -> server ----------------------------------------------------------

export type ClientMessage =
  | { type: "create"; id: string; props: ShapeProps } // id from crypto.randomUUID()
  | { type: "update"; id: string; patch: ShapePatch }
  | { type: "delete"; id: string }
  | { type: "restore"; id: string } // undo a delete / redo a create
  | { type: "cursor"; x: number; y: number }; // throttled ~25/s, never persisted

// --- Server -> client ----------------------------------------------------------

export type Peer = { conn_id: string; user_id: string; username: string };

export type ServerMessage =
  // Sent first on every (re)connect; replaces all local shape state (W6).
  | { type: "snapshot"; seq: number; you: Peer; shapes: Shape[] }
  // A committed change, broadcast to every connection including the sender.
  // deleted=true means remove it locally.
  | { type: "shape"; id: string; props: ShapeProps; version: number; deleted: boolean }
  | ({ type: "cursor"; x: number; y: number } & Peer) // other connections only
  | { type: "leave"; conn_id: string } // a connection closed: drop its cursor (W5)
  | { type: "error"; detail: string }; // sender only; the socket stays open
