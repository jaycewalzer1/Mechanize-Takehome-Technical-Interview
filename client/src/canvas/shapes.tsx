// Shape rendering and the geometry math the Board's gestures use. No state, no I/O.
import { COORD_LIMIT } from "../types";
import type { BoxGeometry, LineGeometry, ShapeProps } from "../types";

export type Geometry = BoxGeometry | LineGeometry;

// Keep every coordinate inside the server's bounds so a long drag can't produce
// a frame the server rejects (it would roll back and snap the shape back).
const clamp = (v: number) => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, v));

// The full geometry group for a shape. Updates always send the whole group
// (PLAN.md conflict policy), so this is the unit both sends and undo use.
export function geometryOf(p: any): Geometry {
  return p.type === "line"
    ? { x1: p.x1, y1: p.y1, x2: p.x2, y2: p.y2 }
    : { x: p.x, y: p.y, width: p.width, height: p.height };
}

export function moveBy(g: any, dx: number, dy: number): Geometry {
  return "x1" in g
    ? { x1: clamp(g.x1 + dx), y1: clamp(g.y1 + dy), x2: clamp(g.x2 + dx), y2: clamp(g.y2 + dy) }
    : { x: clamp(g.x + dx), y: clamp(g.y + dy), width: g.width, height: g.height };
}

// Edge case: V4. Dragging a corner past the opposite (anchor) corner would give a
// negative width/height; storing min corner + absolute size flips the box instead.
// Sizes are floored at 1 because the server rejects anything smaller.
export function boxFromCorners(ax: number, ay: number, bx: number, by: number): BoxGeometry {
  return {
    x: clamp(Math.min(ax, bx)),
    y: clamp(Math.min(ay, by)),
    width: Math.max(1, Math.abs(bx - ax)),
    height: Math.max(1, Math.abs(by - ay)),
  };
}

export function sameGeometry(a: any, b: any): boolean {
  return Object.keys(a).every((k) => a[k] === b[k]);
}

// Text size follows the box height, so resizing a text box scales its font.
export const fontSizeFor = (height: number) => height * 0.75;

export function ShapeView({ id, props }: { id: string; props: ShapeProps }) {
  const p: any = props;
  // data-id lets the Board's single pointerdown handler find which shape was hit.
  if (p.type === "line") {
    return (
      <g data-id={id}>
        <line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke={p.color} strokeWidth={3} strokeLinecap="round" />
        {/* A 3px line is hard to hit; an invisible wide stroke is the click target. */}
        <line x1={p.x1} y1={p.y1} x2={p.x2} y2={p.y2} stroke="transparent" strokeWidth={14} pointerEvents="stroke" />
      </g>
    );
  }
  if (p.type === "text") {
    return (
      <g data-id={id}>
        {/* Transparent box so the whole text area is clickable, not just the glyphs. */}
        <rect x={p.x} y={p.y} width={p.width} height={p.height} fill="transparent" />
        <text
          x={p.x}
          y={p.y + p.height / 2}
          dominantBaseline="central"
          fontSize={fontSizeFor(p.height)}
          fill={p.color}
          style={{ userSelect: "none" }}
        >
          {/* Edge case: S9. Text goes in as a React child, so it's escaped, never parsed as markup. */}
          {p.text}
        </text>
      </g>
    );
  }
  const common = { fill: p.color, fillOpacity: 0.25, stroke: p.color, strokeWidth: 2 };
  return (
    <g data-id={id}>
      {p.type === "rect" ? (
        <rect x={p.x} y={p.y} width={p.width} height={p.height} {...common} />
      ) : (
        <ellipse cx={p.x + p.width / 2} cy={p.y + p.height / 2} rx={p.width / 2} ry={p.height / 2} {...common} />
      )}
    </g>
  );
}

// Box handles are numbered clockwise from top-left. The resize anchor is the opposite
// corner, (i + 2) % 4. Line handles are its two endpoints.
export function boxCorners(p: any) {
  return [
    { x: p.x, y: p.y },
    { x: p.x + p.width, y: p.y },
    { x: p.x + p.width, y: p.y + p.height },
    { x: p.x, y: p.y + p.height },
  ];
}

export function SelectionHandles({ props }: { props: ShapeProps }) {
  const p: any = props;
  const handle = { r: 5, fill: "#fff", stroke: "#2563eb", strokeWidth: 1.5, style: { cursor: "pointer" } };
  if (p.type === "line") {
    return (
      <g>
        <circle data-handle="p1" cx={p.x1} cy={p.y1} {...handle} />
        <circle data-handle="p2" cx={p.x2} cy={p.y2} {...handle} />
      </g>
    );
  }
  return (
    <g>
      <rect x={p.x} y={p.y} width={p.width} height={p.height} fill="none" stroke="#2563eb" strokeDasharray="4 3" pointerEvents="none" />
      {boxCorners(p).map((c, i) => (
        <circle key={i} data-handle={String(i)} cx={c.x} cy={c.y} {...handle} />
      ))}
    </g>
  );
}
