import asyncio
from uuid import UUID

import pytest

from app import db
from tests.conftest import signup

pytestmark = pytest.mark.anyio

MISSING = "00000000-0000-0000-0000-000000000000"


async def create_canvas(client, name="Design review") -> str:
    r = await client.post("/api/canvases", json={"name": name})
    assert r.status_code == 200, r.text
    return r.json()["id"]


async def member_ids(conn, canvas_id) -> set[str]:
    rows = await conn.fetch(
        "SELECT user_id FROM canvas_members WHERE canvas_id = $1", UUID(canvas_id)
    )
    return {str(r["user_id"]) for r in rows}


async def test_create_canvas_persists_with_owner_membership(make_client, conn):
    alice = make_client()
    a = await signup(alice, "alice")
    cid = await create_canvas(alice, "  Design review  ")

    row = await conn.fetchrow("SELECT * FROM canvases WHERE id = $1", UUID(cid))
    assert row["name"] == "Design review"
    assert str(row["owner_id"]) == a["id"]
    assert row["seq"] == 0
    assert await member_ids(conn, cid) == {a["id"]}


async def test_create_canvas_blank_name_defaults(make_client, conn):
    alice = make_client()
    await signup(alice, "alice")
    cid = await create_canvas(alice, "   ")
    assert await conn.fetchval("SELECT name FROM canvases WHERE id = $1", UUID(cid)) == (
        "Untitled canvas"
    )


async def test_V3_canvas_name_limit(make_client, conn):
    alice = make_client()
    await signup(alice, "alice")
    assert (await alice.post("/api/canvases", json={"name": "n" * 100})).status_code == 200
    assert (await alice.post("/api/canvases", json={"name": "n" * 101})).status_code == 422
    assert await conn.fetchval("SELECT count(*) FROM canvases") == 1


async def test_list_shows_only_member_canvases(make_client):
    alice, bob = make_client(), make_client()
    await signup(alice, "alice")
    await signup(bob, "bob")
    a_cid = await create_canvas(alice, "alice's")
    b_cid = await create_canvas(bob, "bob's")

    a_list = (await alice.get("/api/canvases")).json()
    b_list = (await bob.get("/api/canvases")).json()
    assert [c["id"] for c in a_list] == [a_cid]
    assert [c["id"] for c in b_list] == [b_cid]
    assert a_list[0]["owner"] == "alice"


async def test_S1_non_member_gets_403_on_every_canvas_route(make_client, conn):
    alice, bob = make_client(), make_client()
    await signup(alice, "alice")
    b = await signup(bob, "bob")
    cid = await create_canvas(alice)

    assert (await bob.get(f"/api/canvases/{cid}")).status_code == 403
    # A non-member must not be able to invite (least of all themselves) in.
    r = await bob.post(f"/api/canvases/{cid}/members", json={"identifier": "bob"})
    assert r.status_code == 403
    assert b["id"] not in await member_ids(conn, cid)


async def test_S1_missing_canvas_404_and_bad_id_422(make_client):
    alice = make_client()
    await signup(alice, "alice")
    assert (await alice.get(f"/api/canvases/{MISSING}")).status_code == 404
    r = await alice.post(f"/api/canvases/{MISSING}/members", json={"identifier": "alice"})
    assert r.status_code == 404
    assert (await alice.get("/api/canvases/not-a-uuid")).status_code == 422


async def test_S2_canvas_routes_require_login(make_client):
    alice = make_client()
    await signup(alice, "alice")
    cid = await create_canvas(alice)
    anon = make_client()
    assert (await anon.get("/api/canvases")).status_code == 401
    assert (await anon.post("/api/canvases", json={"name": "x"})).status_code == 401
    assert (await anon.get(f"/api/canvases/{cid}")).status_code == 401
    r = await anon.post(f"/api/canvases/{cid}/members", json={"identifier": "alice"})
    assert r.status_code == 401


@pytest.mark.parametrize("ident", ["bob", "BOB", "bob@example.com", "Bob@Example.COM"])
async def test_invite_by_username_or_email_grants_access(make_client, conn, ident):
    alice, bob = make_client(), make_client()
    a = await signup(alice, "alice")
    b = await signup(bob, "bob")
    cid = await create_canvas(alice)

    r = await alice.post(f"/api/canvases/{cid}/members", json={"identifier": ident})
    assert r.status_code == 200, r.text
    assert {m["username"] for m in r.json()["members"]} == {"alice", "bob"}

    row = await conn.fetchrow(
        "SELECT added_by FROM canvas_members WHERE canvas_id = $1 AND user_id = $2",
        UUID(cid),
        UUID(b["id"]),
    )
    assert row is not None and str(row["added_by"]) == a["id"]

    # The invitee can now open and list it.
    assert (await bob.get(f"/api/canvases/{cid}")).status_code == 200
    assert [c["id"] for c in (await bob.get("/api/canvases")).json()] == [cid]


async def test_invited_member_can_invite_others(make_client, conn):
    alice, bob, carol = make_client(), make_client(), make_client()
    await signup(alice, "alice")
    await signup(bob, "bob")
    c = await signup(carol, "carol")
    cid = await create_canvas(alice)
    await alice.post(f"/api/canvases/{cid}/members", json={"identifier": "bob"})

    r = await bob.post(f"/api/canvases/{cid}/members", json={"identifier": "carol"})
    assert r.status_code == 200
    assert c["id"] in await member_ids(conn, cid)


async def test_V7_invite_unknown_user_404_no_row(make_client, conn):
    alice = make_client()
    await signup(alice, "alice")
    cid = await create_canvas(alice)
    r = await alice.post(f"/api/canvases/{cid}/members", json={"identifier": "nobody"})
    assert r.status_code == 404
    assert "nobody" in r.json()["detail"]
    assert await conn.fetchval("SELECT count(*) FROM canvas_members") == 1


async def test_V8_reinvite_and_self_invite_idempotent(make_client, conn):
    alice, bob = make_client(), make_client()
    await signup(alice, "alice")
    await signup(bob, "bob")
    cid = await create_canvas(alice)
    for ident in ["bob", "bob@example.com", "alice"]:
        r = await alice.post(f"/api/canvases/{cid}/members", json={"identifier": ident})
        assert r.status_code == 200
    assert await conn.fetchval("SELECT count(*) FROM canvas_members") == 2


async def test_C4_concurrent_invites_create_exactly_one_row(make_client, conn):
    alice, bob = make_client(), make_client()
    await signup(alice, "alice")
    b = await signup(bob, "bob")
    cid = await create_canvas(alice)

    results = await asyncio.gather(
        *[
            alice.post(f"/api/canvases/{cid}/members", json={"identifier": "bob"})
            for _ in range(10)
        ]
    )
    assert [r.status_code for r in results] == [200] * 10
    count = await conn.fetchval(
        "SELECT count(*) FROM canvas_members WHERE canvas_id = $1 AND user_id = $2",
        UUID(cid),
        UUID(b["id"]),
    )
    assert count == 1


async def test_F7_schema_reapply_is_idempotent_and_keeps_data(make_client, conn):
    alice = make_client()
    await signup(alice, "alice")
    cid = await create_canvas(alice)
    # Simulates a server restart: init_db re-runs schema.sql on existing tables.
    await db.init_db()
    await db.init_db()
    assert await conn.fetchval("SELECT count(*) FROM canvases WHERE id = $1", UUID(cid)) == 1
    assert (await alice.get(f"/api/canvases/{cid}")).status_code == 200
