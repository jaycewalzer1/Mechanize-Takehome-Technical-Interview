// The canvas editor: draws shapes and turns pointer/keyboard input into ops.
// It never touches a socket. It reports intent through onOp, and the parent
// applies ops optimistically, sends them, and feeds the resulting `shapes` back in.
// onGesture fires once per finished drag/resize, so undo gets one entry per gesture
// (U5). Single-op edits (create, delete, color, text) are visible to the parent via
// onOp alone.
import { useEffect, useRef, useState } from "react";
import { MAX_TEXT } from "../types";
import type { ClientMessage, Shape, ShapePatch, ShapeProps } from "../types";
import {
  boxCorners,
  boxFromCorners,
  fontSizeFor,
  geometryOf,
  moveBy,
  sameGeometry,
  SelectionHandles,
  ShapeView,
  textBoxWidth,
  type Geometry,
} from "./shapes";
import Toolbar, { COLORS, type Tool } from "./Toolbar";

type Props = {
  shapes: Shape[];
  onOp: (op: ClientMessage) => void;
  onGesture: (entry: { id: string; before: ShapePatch; after: ShapePatch }) => void;
  disabled: boolean;
};

type Pt = { x: number; y: number };

type Gesture =
  | { kind: "create"; shapeType: "rect" | "ellipse" | "line"; start: Pt; geom: Geometry }
  | {
      kind: "move" | "resize";
      id: string;
      start: Pt;
      anchor: Pt | null; // fixed corner for a box resize
      handle: string | null; // "0".."3" box corner, "p1"/"p2" line endpoint
      before: Geometry;
      geom: Geometry;
      moved: boolean;
      lastSent: number;
    };

type TextEdit = { id: string | null; x: number; y: number; width: number; height: number; value: string };

const BOARD_HEIGHT = 600;
const SEND_INTERVAL_MS = 50; // ~20 updates/s during a drag (W11): smooth for peers, bounded load
const MIN_DRAW = 2; // V5: anything smaller is an accidental click, not a shape
const TEXT_HEIGHT = 28;

export default function Board({ shapes, onOp, onGesture, disabled }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLORS[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Gesture and text-edit state lives in a ref (read by event handlers, which can
  // fire several times before React re-renders) mirrored into state (to render).
  const gestureRef = useRef<Gesture | null>(null);
  const [gesture, setGestureState] = useState<Gesture | null>(null);
  const setGesture = (g: Gesture | null) => {
    gestureRef.current = g;
    setGestureState(g);
  };
  const editRef = useRef<TextEdit | null>(null);
  const [edit, setEditState] = useState<TextEdit | null>(null);
  const setEdit = (e: TextEdit | null) => {
    editRef.current = e;
    setEditState(e);
  };

  const selected = shapes.find((s) => s.id === selectedId) ?? null;

  // Edge case: C3 ("Update after delete"). If the shape being dragged, selected or
  // edited disappears (someone deleted it), end the gesture silently: no final
  // update, no undo entry.
  useEffect(() => {
    const live = (id: string) => shapes.some((s) => s.id === id);
    const g = gestureRef.current;
    if (g && g.kind !== "create" && !live(g.id)) setGesture(null);
    if (selectedId && !live(selectedId)) setSelectedId(null);
    if (editRef.current?.id && !live(editRef.current.id)) setEdit(null);
  }, [shapes, selectedId]);

  // Losing the connection mid-gesture: drop it rather than send into the void.
  // The next snapshot is the truth (W6).
  useEffect(() => {
    if (disabled) {
      setGesture(null);
      setEdit(null);
    }
  }, [disabled]);

  // Delete / Escape on the selection. A window listener so it works without
  // focusing the SVG.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      // Edge case: R7. Backspace/Delete while typing (text box, invite field) edits
      // the text; it must never delete the selected shape.
      if (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !disabled) {
        e.preventDefault(); // Backspace would otherwise navigate back in some browsers
        onOp({ type: "delete", id: selectedId });
        setSelectedId(null);
      } else if (e.key === "Escape") {
        setSelectedId(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, disabled, onOp]);

  // Pointer position in board coordinates (1 SVG unit = 1 CSS px, no zoom/pan).
  // Clamped to the board so a captured drag outside it can't put shapes off-screen.
  const pointFrom = (e: React.MouseEvent): Pt => {
    const r = svgRef.current!.getBoundingClientRect();
    return {
      x: Math.round(Math.min(r.width, Math.max(0, e.clientX - r.left))),
      y: Math.round(Math.min(r.height, Math.max(0, e.clientY - r.top))),
    };
  };

  // The shape (if any) under an element: every ShapeView wraps itself in a <g data-id>.
  const shapeAt = (el: Element | null) => {
    const id = el?.closest("[data-id]")?.getAttribute("data-id");
    return shapes.find((s) => s.id === id);
  };

  // Edit an existing text shape in place, or start a new one vertically centered on `at`.
  const startTextEdit = (shape: Shape | undefined, at: Pt) => {
    if (shape?.props.type === "text") {
      const { x, y, width, height, text } = shape.props;
      setSelectedId(shape.id);
      setEdit({ id: shape.id, x, y, width, height, value: text });
    } else {
      setSelectedId(null);
      setEdit({ id: null, x: at.x, y: at.y - TEXT_HEIGHT / 2, width: 160, height: TEXT_HEIGHT, value: "" });
    }
  };

  const commitText = () => {
    // Read and clear the ref first: Enter commits and then unmounting the input can
    // fire blur, which must not commit a second time.
    const ed = editRef.current;
    if (!ed) return;
    setEdit(null);
    if (!ed.value.trim()) return; // the server requires 1+ chars; empty = cancel
    if (ed.id) {
      const s = shapes.find((x) => x.id === ed.id);
      if (s?.props.type !== "text" || s.props.text === ed.value) return;
      // Refit the box to the new text. Geometry must go as a whole group (README
      // conflict policy), so send x/y/height unchanged alongside the new width.
      const { x, y, height } = s.props;
      const width = textBoxWidth(ed.value, height);
      onOp({ type: "update", id: ed.id, patch: { text: ed.value, x, y, width, height } });
    } else {
      const id = crypto.randomUUID();
      const width = textBoxWidth(ed.value, TEXT_HEIGHT); // the user can resize after
      onOp({
        type: "create",
        id,
        props: { type: "text", x: ed.x, y: ed.y, width, height: TEXT_HEIGHT, color, text: ed.value },
      });
      setSelectedId(id);
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // The text tool opens its editor in onClick, not here (see onClick for why).
    if (disabled || e.button !== 0 || tool === "text") return;
    const target = e.target as Element;
    const p = pointFrom(e);

    // Edge case: R6. Capture the pointer so the drag keeps receiving moves and the
    // pointerup even when the cursor leaves the SVG (otherwise a release outside
    // leaves a gesture stuck open).
    svgRef.current!.setPointerCapture(e.pointerId);

    if (tool !== "select") {
      const geom = tool === "line" ? { x1: p.x, y1: p.y, x2: p.x, y2: p.y } : boxFromCorners(p.x, p.y, p.x, p.y);
      setGesture({ kind: "create", shapeType: tool, start: p, geom });
      return;
    }

    const handle = target.closest("[data-handle]")?.getAttribute("data-handle") ?? null;
    const hit = shapeAt(target);
    if (handle && selected) {
      const before = geometryOf(selected.props);
      // A box resize pins the corner opposite the grabbed one; a line has no anchor.
      const anchor = "x" in before ? boxCorners(before)[(Number(handle) + 2) % 4] : null;
      setGesture({ kind: "resize", id: selected.id, start: p, anchor, handle, before, geom: before, moved: false, lastSent: 0 });
    } else if (hit) {
      setSelectedId(hit.id);
      const before = geometryOf(hit.props);
      setGesture({ kind: "move", id: hit.id, start: p, anchor: null, handle: null, before, geom: before, moved: false, lastSent: 0 });
    } else {
      setSelectedId(null);
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    const p = pointFrom(e);

    if (g.kind === "create") {
      const geom =
        g.shapeType === "line"
          ? { x1: g.start.x, y1: g.start.y, x2: p.x, y2: p.y }
          : boxFromCorners(g.start.x, g.start.y, p.x, p.y);
      setGesture({ ...g, geom });
      return;
    }

    let geom: Geometry;
    if (g.kind === "move") geom = moveBy(g.before, p.x - g.start.x, p.y - g.start.y);
    // p1/p2 handles exist only on lines, so `before` is line geometry here.
    else if (g.handle === "p1") geom = { ...g.before, x1: p.x, y1: p.y };
    else if (g.handle === "p2") geom = { ...g.before, x2: p.x, y2: p.y };
    else geom = boxFromCorners(g.anchor!.x, g.anchor!.y, p.x, p.y);

    const next = { ...g, geom, moved: g.moved || !sameGeometry(geom, g.before) };
    // Throttle: at most one update per SEND_INTERVAL_MS. Frames in between only
    // re-render locally; pointerup always sends the final position, so nothing is lost.
    const now = performance.now();
    if (next.moved && now - g.lastSent >= SEND_INTERVAL_MS) {
      // Full geometry group every time: the server replaces the group as a unit
      // (README conflict policy), so a partial patch would be rejected.
      onOp({ type: "update", id: g.id, patch: geom });
      next.lastSent = now;
    }
    setGesture(next);
  };

  const onPointerUp = () => {
    const g = gestureRef.current;
    if (!g) return; // gesture already ended (e.g. the shape was deleted mid-drag)
    setGesture(null);

    if (g.kind === "create") {
      const geom = g.geom;
      const tooSmall =
        "x1" in geom
          ? Math.hypot(geom.x2 - geom.x1, geom.y2 - geom.y1) < MIN_DRAW
          : geom.width < MIN_DRAW || geom.height < MIN_DRAW;
      if (tooSmall) return; // Edge case: V5, discard zero-size shapes
      const id = crypto.randomUUID(); // client id makes a retried create idempotent (C1)
      // Cast: TS can't see that shapeType "line" always comes with line geometry.
      onOp({ type: "create", id, props: { type: g.shapeType, ...geom, color } as ShapeProps });
      setSelectedId(id);
      setTool("select");
      return;
    }

    // A plain click (no movement) only selects: no op, no undo entry. Also check the
    // shape is still live: a render that removed it may not have run the C3 effect yet.
    if (!g.moved || !shapes.some((s) => s.id === g.id)) return;
    // Always send the final frame: throttling may have skipped the last moves, and
    // `moved` (not before != after) decides, because a drag that returns to its start
    // still sent intermediate frames the server now holds.
    onOp({ type: "update", id: g.id, patch: g.geom });
    if (!sameGeometry(g.geom, g.before)) onGesture({ id: g.id, before: g.before, after: g.geom });
  };

  // Why click and not pointerdown: the browser moves focus on mousedown, which fires
  // *after* pointerdown. An input opened on pointerdown gets focus, then loses it
  // to that focus move, and its onBlur commits the empty text as a cancel. By
  // click time the focus move is over, so the new input keeps focus.
  const onClick = (e: React.MouseEvent) => {
    if (disabled || tool !== "text") return;
    startTextEdit(shapeAt(e.target as Element), pointFrom(e));
    setTool("select");
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (disabled || tool !== "select") return;
    // Not e.target: pointer capture (R6) retargets the clicks to the <svg>, so
    // hit-test at the pointer position to find the shape under it.
    const s = shapeAt(document.elementFromPoint(e.clientX, e.clientY));
    if (s?.props.type === "text") startTextEdit(s, { x: 0, y: 0 }); // `at` only matters for a new box
  };

  const onColor = (c: string) => {
    setColor(c);
    // Color is its own field (per-field LWW), so send just that field: a peer's
    // concurrent drag of the same shape survives.
    if (selected && selected.props.color !== c) onOp({ type: "update", id: selected.id, patch: { color: c } });
  };

  // Edge case: W9. While dragging, render the shape from the gesture's local geometry
  // on top of the latest server props. Echoes of our own earlier throttled frames
  // would otherwise make it jump back, while a peer's color change still shows.
  // The shape being text-edited is hidden: the input draws it (same text, color and
  // position) until the edit commits.
  const display = shapes.filter((s) => s.id !== edit?.id).map((s) =>
    gesture && gesture.kind !== "create" && gesture.id === s.id
      ? { ...s, props: { ...s.props, ...gesture.geom } as ShapeProps }
      : s
  );
  const selectedDisplay = display.find((s) => s.id === selectedId);

  return (
    <div>
      <Toolbar
        tool={tool}
        onTool={setTool}
        color={selected ? selected.props.color : color}
        onColor={onColor}
        canDelete={!!selected}
        onDelete={() => {
          if (!selected) return;
          onOp({ type: "delete", id: selected.id });
          setSelectedId(null);
        }}
        disabled={disabled}
      />
      <div style={{ position: "relative" }}>
        <svg
          ref={svgRef}
          className="board"
          width="100%"
          height={BOARD_HEIGHT}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          // pointercancel (e.g. the OS steals the pointer) ends the gesture the
          // same way, so the server and the undo stack agree on where it stopped.
          onPointerCancel={onPointerUp}
          onClick={onClick}
          onDoubleClick={onDoubleClick}
          style={{
            cursor: disabled ? "not-allowed" : tool === "select" ? "default" : "crosshair",
            opacity: disabled ? 0.6 : 1,
            touchAction: "none",
          }}
        >
          {/* Edge case: R4. Keys are shape ids, so React never reuses one shape's DOM for another. */}
          {display.map((s) => (
            <ShapeView key={s.id} id={s.id} props={s.props} />
          ))}
          {gesture?.kind === "create" && (
            <g opacity={0.6} pointerEvents="none">
              <ShapeView id="draft" props={{ type: gesture.shapeType, ...gesture.geom, color } as ShapeProps} />
            </g>
          )}
          {selectedDisplay && !disabled && !edit && <SelectionHandles props={selectedDisplay.props} />}
        </svg>
        {edit && (
          <input
            autoFocus
            value={edit.value}
            maxLength={MAX_TEXT}
            placeholder="Type, then Enter"
            className="text-edit"
            onChange={(e) => setEdit({ ...edit, value: e.target.value })}
            onBlur={commitText}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitText();
              if (e.key === "Escape") setEdit(null);
            }}
            style={{
              position: "absolute",
              left: edit.x,
              top: edit.y,
              // Grows with the text so the dashed outline always surrounds all of it.
              width: textBoxWidth(edit.value || "Type, then Enter", edit.height),
              height: edit.height,
              fontSize: fontSizeFor(edit.height),
              // An existing shape keeps its own color; a new one uses the picked color.
              color: shapes.find((s) => s.id === edit.id)?.props.color ?? color,
            }}
          />
        )}
      </div>
    </div>
  );
}
