import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { agreementCreationLock, globalIdempotencyMarker, serializedAgreementInsert } from "../src/lib/serializedAgreementCreation.js";
import { creationTable, insertInput, toPg } from "./helpers/serialized-agreement-fixture.js";

test("SQLite immediate transactions serialize concurrent same-key retries and reject changed scopes or hashes", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(creationTable);
  const database = { sqlite, pool: null, toPg };
  try {
    const results = await Promise.all(Array.from({ length: 8 }, (_, index) => serializedAgreementInsert(database, insertInput(`agr_${index}`))));
    assert.equal(results.filter(result => result.changes === 1).length, 1);
    assert.ok(results.filter(result => !result.changes).every(result => result.existing?.id === "agr_0"));
    for (const input of [insertInput("foreign", "owner:b"), insertInput("changed", "owner:a", "a".repeat(64), "changed")]) {
      await assert.rejects(serializedAgreementInsert(database, input), error => (error as { status: number }).status === 409);
    }
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM agreements").get() as { count: number }).count, 1);
    const crossScope = await Promise.allSettled([serializedAgreementInsert(database, insertInput("key-a", "key:a", "b".repeat(64))), serializedAgreementInsert(database, insertInput("bootstrap", "bootstrap", "b".repeat(64)))]);
    assert.deepEqual(crossScope.map(result => result.status).sort(), ["fulfilled", "rejected"]);
  } finally { sqlite.close(); }
});

test("SQLite rollback preserves absence after insert failure and permits a safe later creation", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(creationTable);
  sqlite.exec("CREATE TRIGGER reject_insert AFTER INSERT ON agreements BEGIN SELECT RAISE(ABORT, 'fixture insert failure'); END");
  const database = { sqlite, pool: null, toPg };
  try {
    await assert.rejects(serializedAgreementInsert(database, insertInput("failed")), /fixture insert failure/);
    assert.equal(sqlite.inTransaction, false);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM agreements").get() as { count: number }).count, 0);
    sqlite.exec("DROP TRIGGER reject_insert");
    assert.equal((await serializedAgreementInsert(database, insertInput("retry"))).changes, 1);
    await assert.rejects(serializedAgreementInsert(database, insertInput("retry", "owner:a", "c".repeat(64))), /did not create a record/);
    assert.equal(sqlite.inTransaction, false);
  } finally { sqlite.close(); }
});

test("legacy duplicate keys cannot hide a foreign collision behind a matching scoped row", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(creationTable);
  const database = { sqlite, pool: null, toPg };
  try {
    for (const input of [insertInput("own"), insertInput("foreign", "owner:b")]) sqlite.prepare(input.sql).run(...input.params);
    await assert.rejects(serializedAgreementInsert(database, insertInput("replay")), /cannot-confirm-original-send/);
    assert.equal((sqlite.prepare("SELECT COUNT(*) AS count FROM agreements").get() as { count: number }).count, 2);
  } finally { sqlite.close(); }
});

test("advisory lock identity uses the entire key and is independent of creation scope", () => {
  assert.equal(agreementCreationLock("full-key"), agreementCreationLock("full-key"));
  assert.notEqual(agreementCreationLock("a".repeat(64)), agreementCreationLock(`${"a".repeat(63)}b`));
  assert.match(agreementCreationLock("full-key"), /^-?\d+$/);
});

test("default namespaces remain independent unless a provider-owned global claim exists", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(creationTable);
  const database = { sqlite, pool: null, toPg };
  try {
    const first = insertInput("own", "owner:a", "scoped", "original", false);
    first.params[4] = JSON.stringify({ [globalIdempotencyMarker]: true, application: "proof" });
    await serializedAgreementInsert(database, first);
    assert.deepEqual(JSON.parse((sqlite.prepare("SELECT metadata_json FROM agreements WHERE id = 'own'").get() as { metadata_json: string }).metadata_json), { application: "proof" });
    assert.equal((await serializedAgreementInsert(database, insertInput("foreign", "owner:b", "scoped", "original", false))).changes, 1);
    await assert.rejects(serializedAgreementInsert(database, insertInput("global", "owner:a", "scoped")), /cannot-confirm-original-send/);
    await serializedAgreementInsert(database, insertInput("claim", "owner:a", "claimed"));
    await assert.rejects(serializedAgreementInsert(database, insertInput("default", "owner:b", "claimed", "original", false)), /cannot-confirm-original-send/);
  } finally { sqlite.close(); }
});

test("opted replay claims a legacy scoped agreement without changing its creation hash or duplicating it", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(creationTable);
  const database = { sqlite, pool: null, toPg };
  try {
    await serializedAgreementInsert(database, insertInput("legacy", "owner:a", "claim-legacy", "original", false));
    const replay = await serializedAgreementInsert(database, insertInput("ignored", "owner:a", "claim-legacy"));
    assert.equal(replay.changes, 0);
    assert.equal(replay.existing?.id, "legacy");
    assert.equal(replay.existing?.creation_request_sha256, "original");
    assert.equal(JSON.parse(replay.existing!.metadata_json!)[globalIdempotencyMarker], true);
    await assert.rejects(serializedAgreementInsert(database, insertInput("foreign", "owner:b", "claim-legacy", "original", false)), /cannot-confirm-original-send/);
  } finally { sqlite.close(); }
});

test("a failed legacy claim update rolls back and never advertises a persisted claim", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(creationTable);
  const database = { sqlite, pool: null, toPg };
  try {
    await serializedAgreementInsert(database, insertInput("legacy", "owner:a", "failed-claim", "original", false));
    sqlite.exec("CREATE TRIGGER reject_claim AFTER UPDATE ON agreements BEGIN SELECT RAISE(ABORT, 'fixture claim failure'); END");
    await assert.rejects(serializedAgreementInsert(database, insertInput("retry", "owner:a", "failed-claim")), /fixture claim failure/);
    assert.equal((sqlite.prepare("SELECT metadata_json FROM agreements WHERE id = 'legacy'").get() as { metadata_json: null }).metadata_json, null);
    assert.equal(sqlite.inTransaction, false);
  } finally { sqlite.close(); }
});
