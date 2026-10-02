import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { before, after } from "node:test";
import { setup, cleanup, create, created, bulk, request, headers, payload, db, ownerKey, ownerlessA, ownerlessB, bootstrap, sourcePdf, session } from "./fixtures/provider-review.js";

before(() => setup());
after(cleanup);

test("ownerless stored keys and bootstrap create and replay hosted agreements in separate principal scopes", async () => {
  const identities = [ownerlessA, ownerlessB, bootstrap];
  const ids: string[] = [];
  for (const key of identities) {
    const body = { signing_mode: "hosted", idempotency_key: "principal-replay" };
    const first = await created(body, key);
    const secret: string = `fake-webhook-secret-${ids.length}`;
    await db.run("UPDATE agreements SET webhook_secret = ? WHERE id = ?", secret, first.id);
    const replay = await created(body, key);
    assert.equal(replay.id, first.id);
    assert.equal(replay.signing_url, first.signing_url);
    assert.equal(replay.webhook_secret, secret);
    assert.equal((await create({ ...body, document_markdown: "# Changed" }, key)).status, 409);
    ids.push(first.id);
  }
  assert.equal(new Set(ids).size, 3);
  const scopes = await Promise.all(ids.map(async (id) => (await db.getAgreement(id))!.idempotency_scope));
  assert.equal(new Set(scopes).size, 3);
});

test("ownerless embedded creation and replay cannot bypass session, detail and artifact restrictions", async () => {
  const body = { idempotency_key: "embedded-principal" };
  const admin = await created(body, bootstrap);
  const count = (await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agreements"))!.count;
  for (const key of [ownerlessA, ownerlessB]) {
    for (const overrides of [body, { ...body, document_markdown: "# Changed" }]) {
      const response = await create(overrides, key);
      assert.equal(response.status, 403);
      assert.match(await response.text(), /owner|embedded/i);
    }
    assert.equal((await bulk({ ...payload(), ...body, recipients: [payload().recipient] }, key)).status, 403);
    assert.equal((await session(admin.id, key)).status, 404);
    for (const suffix of ["", "/document", "/pdf", "/source-pdf", "/audit", "/documents/source", "/documents/signed", "/documents/certificate"]) assert.equal((await request(`/v1/agreements/${admin.id}${suffix}`, { headers: headers(key) })).status, 404);
  }
  assert.equal((await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agreements"))!.count, count);
});

test("ownerless keys retain hosted listing, document access, reminders and cancellation while embedded stays hidden", async () => {
  const own = await created({ signing_mode: "hosted", document_pdf_base64: sourcePdf.toString("base64") }, ownerlessA);
  const legacy = await created({ signing_mode: "hosted", document_pdf_base64: sourcePdf.toString("base64") });
  const embedded = await created();
  for (const id of [own.id, legacy.id]) {
    for (const suffix of ["", "/document", "/pdf", "/source-pdf", "/audit", "/documents/source"]) assert.equal((await request(`/v1/agreements/${id}${suffix}`, { headers: headers(ownerlessA) })).status, 200, suffix);
    assert.equal((await request(`/v1/agreements/${id}/remind`, { method: "POST", headers: headers(ownerlessA) })).status, 200);
    assert.equal((await request(`/v1/agreements/${id}/cancel`, { method: "POST", headers: headers(ownerlessA) })).status, 200);
  }
  const listed = await (await request("/v1/agreements?limit=100", { headers: headers(ownerlessA) })).json() as { agreements: Array<{ id: string }> };
  assert.ok(listed.agreements.some((item) => item.id === own.id));
  assert.ok(listed.agreements.some((item) => item.id === legacy.id));
  assert.ok(!listed.agreements.some((item) => item.id === embedded.id));
  for (const action of ["cancel", "remind"]) assert.equal((await request(`/v1/agreements/${embedded.id}/${action}`, { method: "POST", headers: headers(ownerlessA) })).status, 404);
});

test("bulk keys reject appended, removed, reordered and changed payloads with 409 before creating members", async () => {
  const recipients = [payload().recipient, { name: "Second", email: "second@example.test" }];
  const body = { ...payload(), recipients, idempotency_key: "whole-bulk" };
  assert.equal((await bulk(body)).status, 201);
  const count = (await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agreements"))!.count;
  for (const changed of [
    { recipients: [...recipients, { name: "Third", email: "third@example.test" }] },
    { recipients: recipients.slice(0, 1) },
    { recipients: [...recipients].reverse() },
    { document_markdown: "# Changed" },
    { metadata: { changed: true } },
    { recipients: [recipients[0], { ...recipients[1], metadata: { changed: true } }] }
  ]) {
    const response = await bulk({ ...body, ...changed });
    assert.equal(response.status, 409);
    assert.match(await response.text(), /idempotency/i);
    assert.equal((await db.get<{ count: number }>("SELECT COUNT(*) AS count FROM agreements"))!.count, count);
  }
});

test("concurrent bulk retries and a single create use disjoint member key namespaces", async () => {
  const key = "bulk-namespace";
  const single = await created({ idempotency_key: `${key}:0` });
  const forged = await created({ idempotency_key: `${createHash("sha256").update(JSON.stringify(key)).digest("hex")}:0` });
  const body = { ...payload(), recipients: [payload().recipient, { name: "Second", email: "second@example.test" }], idempotency_key: key };
  const responses = await Promise.all(Array.from({ length: 5 }, () => bulk(body)));
  for (const response of responses) assert.equal(response.status, 201);
  const results = await Promise.all(responses.map((response) => response.json() as Promise<{ agreements: Array<{ id: string }> }>));
  for (const result of results) assert.deepEqual(result.agreements.map((item) => item.id), results[0].agreements.map((item) => item.id));
  assert.ok(results[0].agreements.every((item) => item.id !== single.id && item.id !== forged.id));
  for (const item of results[0].agreements) assert.equal((await db.getAuditEvents(item.id)).filter((event) => event.event_type === "created").length, 1);
});

test("concurrent changed bulk requests produce one complete batch and one 409 without loser members", async () => {
  const base = { ...payload(), idempotency_key: "bulk-conflict-race" };
  const responses = await Promise.all([
    bulk({ ...base, recipients: [{ name: "First", email: "first@example.test" }] }),
    bulk({ ...base, recipients: [{ name: "Second", email: "second@example.test" }, { name: "Third", email: "third@example.test" }] })
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  const winner = await responses.find((response) => response.status === 201)!.json() as { agreements: Array<{ id: string }> };
  const rows = await db.all<{ id: string }>("SELECT id FROM agreements WHERE idempotency_scope = ? AND idempotency_key IN (?, ?)", "owner:owner@example.test:bulk", `${createHash("sha256").update(JSON.stringify(base.idempotency_key)).digest("hex")}:0`, `${createHash("sha256").update(JSON.stringify(base.idempotency_key)).digest("hex")}:1`);
  assert.deepEqual(rows.map((row) => row.id).sort(), winner.agreements.map((row) => row.id).sort());
});

test("owner-scoped keys for the same owner share creation retries", async () => {
  const { createApiKey } = await import("../src/lib/apiKeys.js");
  const key = (await createApiKey({ name: "Another owner key", ownerEmail: "owner@example.test" })).key;
  const first = await created({ idempotency_key: "shared-owner-retry" });
  const replay = await created({ idempotency_key: "shared-owner-retry" }, key);
  assert.equal(replay.id, first.id);
});

test("bulk validates the original key and isolates identical bulk keys by authenticated principal", async () => {
  const body = { ...payload(), signing_mode: "hosted", recipients: [payload().recipient], idempotency_key: "principal-bulk" };
  const ids: string[] = [];
  for (const key of [ownerlessA, ownerlessB, bootstrap, ownerKey]) {
    const response = await bulk(body, key);
    assert.equal(response.status, 201);
    ids.push((await response.json() as { agreements: Array<{ id: string }> }).agreements[0].id);
  }
  assert.equal(new Set(ids).size, 4);
  for (const key of ["", "*invalid", "a".repeat(201), 42]) assert.equal((await bulk({ ...body, idempotency_key: key })).status, 400);
  assert.equal((await bulk({ ...body, idempotency_key: "a".repeat(200) })).status, 201);
});
