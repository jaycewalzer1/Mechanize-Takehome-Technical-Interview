// Tool, color and delete controls. Purely presentational; the Board owns the state.

export type Tool = "select" | "rect" | "ellipse" | "line" | "text";

const TOOLS: Tool[] = ["select", "rect", "ellipse", "line", "text"];

// A fixed palette instead of <input type="color">: the native picker fires a change
// on every hue it passes through, which would send dozens of updates (and undo
// entries) for one recolor. A swatch click is exactly one op.
// Pastels dark enough to stay visible as strokes on the paper board; the first
// (soft charcoal) is the default, so text shapes stay readable.
export const COLORS = ["#4a4a5a", "#f08a8a", "#f6b26b", "#7ccba2", "#7fb5ee", "#a99bea", "#f29cc3"];

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
    <div className="row toolbar">
      {TOOLS.map((t) => (
        <button
          key={t}
          className={props.tool === t ? "tool active" : "tool"}
          disabled={props.disabled}
          onClick={() => props.onTool(t)}
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
            outline: props.color === c ? "2px solid var(--accent)" : undefined,
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
