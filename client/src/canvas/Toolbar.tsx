// Tool, color and delete controls. Purely presentational; the Board owns the state.

export type Tool = "select" | "rect" | "ellipse" | "line" | "text";

const TOOLS: Tool[] = ["select", "rect", "ellipse", "line", "text"];

// A fixed palette instead of <input type="color">: the native picker fires a change
// on every hue it passes through, which would send dozens of updates (and undo
// entries) for one recolor. A swatch click is exactly one op.
export const COLORS = ["#1f2937", "#ef4444", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#ec4899"];

export default function Toolbar(props: {
  tool: Tool;
  onTool: (t: Tool) => void;
  color: string;
  onColor: (c: string) => void;
  canDelete: boolean;
  onDelete: () => void;
  disabled: boolean;
}) {
  return (
    <div className="row">
      {TOOLS.map((t) => (
        <button
          key={t}
          disabled={props.disabled}
          onClick={() => props.onTool(t)}
          style={{ fontWeight: props.tool === t ? 700 : 400, borderColor: props.tool === t ? "#2563eb" : undefined }}
        >
          {t}
        </button>
      ))}
      <span style={{ width: 12 }} />
      {COLORS.map((c) => (
        <button
          key={c}
          title={c}
          disabled={props.disabled}
          onClick={() => props.onColor(c)}
          style={{
            width: 26,
            height: 26,
            padding: 0,
            background: c,
            outline: props.color === c ? "2px solid #2563eb" : undefined,
            outlineOffset: 2,
          }}
        />
      ))}
      <span style={{ width: 12 }} />
      <button disabled={props.disabled || !props.canDelete} onClick={props.onDelete}>
        delete
      </button>
    </div>
  );
}
