# WebSocket tests for the risky sync paths only (PLAN.md testing policy).
# They use Starlette's TestClient as a context manager, so the app, its DB pool
# and every socket share one event loop, and handlers for two sockets really
# do interleave their transactions.
import asyncio
import json
import uuid

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import db
from app.main import app
from tests.conftest import ensure_test_db

RECT = {"type": "rect", "x": 100, "y": 100, "width": 100, "height": 100, "color": "#000000"}


@pytest.fixture
def client():
    asyncio.run(ensure_test_db())
    with TestClient(app) as c:  # runs lifespan: pool + schema on the client's loop
        c.portal.call(_truncate)
        yield c


async def _truncate() -> None:
    pool = await db.get_pool()
    await pool.execute("TRUNCATE users, sessions, canvases, canvas_members, shapes CASCADE")


def _user(c: TestClient, name: str) -> dict:
    """Sign up and return a Cookie header for this user (the jar is cleared so users don't mix)."""
    r = c.post(
        "/api/auth/signup",
        json={"username": name, "email": f"{name}@example.com", "password": "password1"},
    )
    assert r.status_code == 200, r.text
    header = {"cookie": f"session_id={c.cookies['session_id']}"}
    c.cookies.clear()
    return header


def _shared_canvas(c: TestClient) -> tuple[str, dict, dict]:
    alice, bob = _user(c, "alice"), _user(c, "bob")
    canvas_id = c.post("/api/canvases", json={"name": "t"}, headers=alice).json()["id"]
    r = c.post(f"/api/canvases/{canvas_id}/members", json={"identifier": "bob"}, headers=alice)
    assert r.status_code == 200, r.text
    return canvas_id, alice, bob


def _next(ws, kind: str) -> dict:
    """Next frame of the given type, skipping others (e.g. cursors)."""
    while True:
        frame = ws.receive_json()
        if frame["type"] == kind:
            return frame


def _apply(held: dict, frame: dict) -> None:
    # The client rule from PLAN.md: ignore a shape frame whose version <= the one held.
    current = held.get(frame["id"])
    if current is None or frame["version"] > current["version"]:
        held[frame["id"]] = frame


def _db_shape(c: TestClient, shape_id: str) -> dict:
    async def fetch():
        pool = await db.get_pool()
        return await pool.fetchrow(
            "SELECT props, version, deleted FROM shapes WHERE id = $1", uuid.UUID(shape_id)
        )

    row = c.portal.call(fetch)
    return {"props": json.loads(row["props"]), "version": row["version"], "deleted": row["deleted"]}


def test_W1_handshake_rejects_no_session_and_non_member(client):
    canvas_id, _, _ = _shared_canvas(client)
    outsider = _user(client, "mallory")
    for headers in ({}, outsider):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect(f"/ws?canvas={canvas_id}", headers=headers) as ws:
                ws.receive_json()  # the server must close before sending any data
        assert exc.value.code == 1008


def test_W2_bad_frames_get_error_and_socket_stays_open(client):
    canvas_id, alice, _ = _shared_canvas(client)
    shape_id = str(uuid.uuid4())
    with client.websocket_connect(f"/ws?canvas={canvas_id}", headers=alice) as ws:
        _next(ws, "snapshot")
        ws.send_json({"type": "create", "id": shape_id, "props": RECT})
        _next(ws, "shape")
        bad_frames = [
            "not json",
            json.dumps({"type": "explode"}),
            json.dumps({"type": "cursor", "x": "NaN", "y": 1}),
            # A partial geometry group is rejected (geometry-group policy).
            json.dumps({"type": "update", "id": shape_id, "patch": {"x": 5, "y": 5}}),
            # A server-owned field is rejected (S5).
            json.dumps({"type": "update", "id": shape_id, "patch": {"version": 99}}),
        ]
        for raw in bad_frames:
            ws.send_text(raw)
            assert _next(ws, "error")["detail"]
        # Still open and working after all of that.
        ws.send_json({"type": "update", "id": shape_id, "patch": {"color": "#ff0000"}})
        assert _next(ws, "shape")["props"]["color"] == "#ff0000"


def test_C2_drag_vs_left_edge_resize_converges_to_one_users_geometry(client):
    """Alice drags a rect while Bob drags its left edge, at the same time.

    Both clients must end on the DB row (C2/C6), and that row's geometry must be
    exactly one of the geometries someone sent, never a per-field mix.
    """
    canvas_id, alice, bob = _shared_canvas(client)
    shape_id = str(uuid.uuid4())
    url = f"/ws?canvas={canvas_id}"
    with client.websocket_connect(url, headers=alice) as a, client.websocket_connect(
        url, headers=bob
    ) as b:
        _next(a, "snapshot")
        _next(b, "snapshot")
        a.send_json({"type": "create", "id": shape_id, "props": RECT})

        sent = []
        steps = 30
        for i in range(1, steps + 1):
            drag = {"x": 100 + i, "y": 100 + i, "width": 100, "height": 100}
            # Left-edge resize: x moves left and width grows, so the right edge stays at 200.
            resize = {"x": 100 - i, "y": 100, "width": 100 + i, "height": 100}
            a.send_json({"type": "update", "id": shape_id, "patch": drag})
            b.send_json({"type": "update", "id": shape_id, "patch": resize})
            sent += [drag, resize]

        # Every committed op is broadcast to both sockets: 1 create + 2*steps updates.
        held_a, held_b = {}, {}
        for _ in range(1 + 2 * steps):
            _apply(held_a, _next(a, "shape"))
            _apply(held_b, _next(b, "shape"))

    row = _db_shape(client, shape_id)
    assert held_a[shape_id]["props"] == row["props"] == held_b[shape_id]["props"]
    assert held_a[shape_id]["version"] == row["version"] == held_b[shape_id]["version"]
    geometry = {k: row["props"][k] for k in ("x", "y", "width", "height")}
    assert geometry in sent, f"mixed geometry nobody drew: {geometry}"


def test_C3_update_after_delete_is_rejected_and_never_resurrects(client):
    canvas_id, alice, bob = _shared_canvas(client)
    shape_id = str(uuid.uuid4())
    url = f"/ws?canvas={canvas_id}"
    with client.websocket_connect(url, headers=alice) as a, client.websocket_connect(
        url, headers=bob
    ) as b:
        _next(a, "snapshot")
        _next(b, "snapshot")
        a.send_json({"type": "create", "id": shape_id, "props": RECT})
        _next(b, "shape")
        a.send_json({"type": "delete", "id": shape_id})
        assert _next(b, "shape")["deleted"] is True

        # Bob's late drag frame arrives after the delete.
        move = {"x": 1, "y": 1, "width": 100, "height": 100}
        b.send_json({"type": "update", "id": shape_id, "patch": move})
        assert _next(b, "error")["detail"]
        assert _next(b, "shape")["deleted"] is True  # resync frame: drop it locally

        # C1: the same create sent again is a no-op, not a second row or a resurrection.
        b.send_json({"type": "create", "id": shape_id, "props": RECT})
        b.send_json({"type": "cursor", "x": 1, "y": 1})
        _next(a, "cursor")  # proves Bob's create was processed (frames are handled in order)

    row = _db_shape(client, shape_id)
    assert row["deleted"] is True
    assert row["props"] == RECT
