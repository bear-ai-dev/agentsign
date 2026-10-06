import assert from "node:assert/strict";
import test from "node:test";
import { creationHash } from "../src/lib/embeddedSigning.js";
import { globalIdempotencyMarker } from "../src/lib/serializedAgreementCreation.js";
import { serializedRouteFixture } from "./helpers/serialized-agreement-routes.js";

test("concurrent managed POST retries create one agreement and emit audit and email only after commit", async () => {
  const { sqlite, state, request } = serializedRouteFixture();
  try {
    const responses = await Promise.all(Array.from({ length: 8 }, () => request("a".repeat(64))));
    assert.ok(responses.every(response => response.status === 201));
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.equal(new Set(bodies.map(body => body.id)).size, 1);
    assert.equal(state.emails, 1);
    assert.equal(state.audits, 2);
    assert.ok(state.inputs.every(input => input.global === true));
  } finally { sqlite.close(); }
});

test("managed/default races across owners admit one global winner and conflicts disclose no agreement data", async () => {
  const { sqlite, state, request } = serializedRouteFixture();
  try {
    const responses = await Promise.all([request("race", "owner-a"), request("race", "owner-b", false)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [201, 409]);
    assert.deepEqual(await responses.find(response => response.status === 409)!.json(), { error: "cannot-confirm-original-send" });
    assert.equal(state.emails, 1);
    assert.equal(state.audits, 2);
    assert.equal((await request("race", "owner-a", true, { document_markdown: "# Changed" })).status, 409);
    assert.equal(state.emails, 1);
  } finally { sqlite.close(); }
});

test("default arbitrary keys preserve owner independence but opted replays claim old rows without rehash or redelivery", async () => {
  const { sqlite, state, request } = serializedRouteFixture();
  try {
    for (const owner of ["owner-a", "owner-b"]) assert.equal((await request("independent", owner, false)).status, 201);
    const first = await (await request("legacy", "owner-a", false)).json();
    const before = sqlite.prepare("SELECT creation_request_sha256 FROM agreements WHERE id = ?").get(first.id) as { creation_request_sha256: string };
    const replay = await request("legacy", "owner-a", true);
    assert.equal(replay.status, 201);
    assert.equal((await replay.json()).id, first.id);
    const after = sqlite.prepare("SELECT creation_request_sha256, metadata_json FROM agreements WHERE id = ?").get(first.id) as { creation_request_sha256: string; metadata_json: string };
    assert.equal(after.creation_request_sha256, before.creation_request_sha256);
    assert.equal(JSON.parse(after.metadata_json)[globalIdempotencyMarker], true);
    assert.equal((await request("legacy", "owner-b", false)).status, 409);
    assert.equal(state.emails, 3);
  } finally { sqlite.close(); }
});

test("database failure has no creation effects and a later retry safely creates once", async () => {
  const { sqlite, state, request } = serializedRouteFixture();
  try {
    state.failInsert = true;
    assert.equal((await request("retry")).status, 400);
    assert.equal(state.emails, 0);
    assert.equal(state.audits, 0);
    state.failInsert = false;
    assert.equal((await request("retry")).status, 201);
    assert.equal((await request("retry")).status, 201);
    assert.equal(state.emails, 1);
    assert.equal((await request(undefined)).status, 201);
  } finally { sqlite.close(); }
});

test("bulk managed members use the same serialized guard and provider claim without changing body hashes", async () => {
  const { sqlite, state, request } = serializedRouteFixture();
  try {
    const extra = { recipients: [{ name: "Signer", email: "signer@example.test" }] };
    assert.equal((await request("bulk", "owner-a", true, extra, true)).status, 201);
    assert.equal((await request("bulk", "owner-b", false, extra, true)).status, 409);
    assert.equal(state.emails, 1);
    assert.ok(state.inputs.every(input => input.key === `${creationHash("bulk")}:0`));
  } finally { sqlite.close(); }
});
