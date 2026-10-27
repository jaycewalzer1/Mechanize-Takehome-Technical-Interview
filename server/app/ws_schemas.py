"""Validation schemas for WebSocket frames: the client->server half of the protocol in PLAN.md.

Every inbound frame is parsed with `parse_client_message`. Invalid frames raise
pydantic.ValidationError, which the WS handler turns into an error frame
(EDGE_CASES W2) without closing the socket. Mirrored in client/src/types.ts.
"""

from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, model_validator

# Bounds keep geometry sane and frames small (EDGE_CASES V2, W12). No zoom/pan,
# so anything past +-10000 is off any screen anyway.
COORD_LIMIT = 10_000
MAX_SIZE = 10_000
MAX_TEXT = 1_000
MAX_FRAME_CHARS = 16_384  # checked on the raw text before JSON parsing

# The bounds already reject NaN/Infinity; allow_inf_nan=False states the rule
# explicitly (V2) instead of relying on how NaN compares.
Coord = Annotated[float, Field(ge=-COORD_LIMIT, le=COORD_LIMIT, allow_inf_nan=False)]
# Boxes must be at least 1x1: zero-size shapes are discarded client-side (V5),
# and the client normalizes negative width/height before sending (V4).
Size = Annotated[float, Field(ge=1, le=MAX_SIZE, allow_inf_nan=False)]
Color = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]


class _Strict(BaseModel):
    # extra="forbid" means a client can't sneak in server-owned fields such as
    # version, canvas_id or created_by (EDGE_CASES S5).
    model_config = ConfigDict(extra="forbid")


# --- Shape props: what is stored in shapes.props (JSONB) ---------------------


class BoxProps(_Strict):
    type: Literal["rect", "ellipse"]
    x: Coord
    y: Coord
    width: Size
    height: Size
    color: Color


class TextProps(_Strict):
    type: Literal["text"]
    x: Coord
    y: Coord
    width: Size
    height: Size
    color: Color
    # The whole string is replaced on edit; there's no collaborative typing (README out of scope).
    text: str = Field(min_length=1, max_length=MAX_TEXT)


class LineProps(_Strict):
    # A line is its two endpoints, so any direction is valid (V4).
    type: Literal["line"]
    x1: Coord
    y1: Coord
    x2: Coord
    y2: Coord
    color: Color


ShapeProps = Annotated[BoxProps | TextProps | LineProps, Field(discriminator="type")]
shape_props_adapter: TypeAdapter[BoxProps | TextProps | LineProps] = TypeAdapter(ShapeProps)


# Geometry fields are only ever written together, as one group (see PLAN.md).
BOX_GEOMETRY = frozenset({"x", "y", "width", "height"})
LINE_GEOMETRY = frozenset({"x1", "y1", "x2", "y2"})


class ShapePatch(_Strict):
    """A partial update: geometry as one whole group, color and text per field (see PLAN.md).

    `type` is deliberately absent, so a shape can't change kind. The server merges
    the patch onto the stored props and re-validates the result with
    `shape_props_adapter`, which rejects e.g. line endpoints on a rect.
    """

    x: Coord | None = None
    y: Coord | None = None
    width: Size | None = None
    height: Size | None = None
    x1: Coord | None = None
    y1: Coord | None = None
    x2: Coord | None = None
    y2: Coord | None = None
    color: Color | None = None
    text: str | None = Field(default=None, min_length=1, max_length=MAX_TEXT)

    @model_validator(mode="after")
    def _geometry_is_whole_group(self) -> "ShapePatch":
        # Why all-or-nothing: a drag sends {x, y} and a left-edge resize sends
        # {x, width}. Merged per field, concurrent ones could combine into a
        # shape nobody drew (drag's x + resize's width = the right edge jumps).
        # Replacing the whole group means the result is exactly one user's write.
        sent = self.model_fields_set
        for group in (BOX_GEOMETRY, LINE_GEOMETRY):
            if sent & group and not group <= sent:
                raise ValueError(f"geometry must include all of {sorted(group)}")
        return self


# --- Client -> server messages ------------------------------------------------


class CreateMsg(_Strict):
    type: Literal["create"]
    id: UUID  # client-generated, so a retried create is a no-op (C1, I2)
    props: ShapeProps


class UpdateMsg(_Strict):
    type: Literal["update"]
    id: UUID
    patch: ShapePatch


class DeleteMsg(_Strict):
    type: Literal["delete"]
    id: UUID


class RestoreMsg(_Strict):
    # Un-tombstones a deleted shape with the props it had. Used to undo a delete
    # and to redo a create (U4).
    type: Literal["restore"]
    id: UUID


class CursorMsg(_Strict):
    # Relayed to the other connections only: never persisted, never undone (W10).
    type: Literal["cursor"]
    x: Coord
    y: Coord


AnyClientMessage = CreateMsg | UpdateMsg | DeleteMsg | RestoreMsg | CursorMsg
_client_message_adapter: TypeAdapter[AnyClientMessage] = TypeAdapter(
    Annotated[AnyClientMessage, Field(discriminator="type")]
)


def parse_client_message(raw: str) -> AnyClientMessage:
    """Validate one raw frame.

    Raises ValueError if it's too big, pydantic.ValidationError (a ValueError) if malformed.
    """
    # Edge case: W12 oversized frame -> rejected before any JSON parsing work.
    if len(raw) > MAX_FRAME_CHARS:
        raise ValueError("Message too large")
    # validate_json rejects non-JSON, unknown `type`, wrong field types and NaN (W2).
    return _client_message_adapter.validate_json(raw)
