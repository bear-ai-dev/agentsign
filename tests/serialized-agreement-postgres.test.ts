import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { agreementCreationLock, globalIdempotencyMarker, serializedAgreementInsert } from "../src/lib/serializedAgreementCreation.js";
import { creationTable, insertInput, toPg } from "./helpers/serialized-agreement-fixture.js";

const execute = promisify(execFile);
const pgBin = process.env.PROVIDER_TEST_PG_BIN ?? "/opt/homebrew/opt/postgresql@16/bin";
const available = existsSync(join(pgBin, "initdb"));
const localEnvironment = { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C", TMPDIR: tmpdir() };

test("real PostgreSQL sessions serialize global/default races, observe committed rows after waiting, and release rolled-back claims", { skip: !available, timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentsign-creation-pg-"));
  let started = false;
  let pool: pg.Pool | undefined;
  try {
    const server = createServer();
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    await new Promise<void>(resolve => server.close(() => resolve()));
    await execute(join(pgBin, "initdb"), ["-D", join(directory, "data"), "-U", "creation_fixture", "-A", "trust", "--no-locale"], { env: localEnvironment });
    await execute(join(pgBin, "pg_ctl"), ["-D", join(directory, "data"), "-l", join(directory, "postgres.log"), "-o", `-h 127.0.0.1 -p ${port} -k ${directory} -c fsync=off`, "-w", "start"], { env: localEnvironment });
    started = true;
    pool = new pg.Pool({ connectionString: `postgresql://creation_fixture@127.0.0.1:${port}/postgres`, ssl: false, max: 2 });
    await pool.query(creationTable);
    const database = { sqlite: null, pool, toPg };
    const same = await Promise.all(Array.from({ length: 8 }, (_, index) => serializedAgreementInsert(database, insertInput(`same-${index}`))));
    assert.equal(same.filter(result => result.changes === 1).length, 1);
    const winnerId = (await pool.query("SELECT id FROM agreements")).rows[0].id;
    assert.ok(same.filter(result => !result.changes).every(result => result.existing?.id === winnerId));
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM agreements")).rows[0].count, 1);
    for (const mode of ["replay", "foreign", "rollback", "default-replay", "default-foreign", "default-rollback"]) {
      const key = `blocked-${mode}`;
      const holder = await pool.connect();
      let pending: ReturnType<typeof serializedAgreementInsert> | undefined;
      try {
        const contenderPid = (await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [agreementCreationLock(key)]);
        const winner = insertInput(`winner-${key}`, "owner:a", key);
        if (!mode.startsWith("default-")) winner.params[4] = JSON.stringify({ [globalIdempotencyMarker]: true });
        await holder.query(toPg(winner.sql), winner.params);
        pending = serializedAgreementInsert(database, insertInput(`contender-${key}`, mode.endsWith("foreign") ? "owner:b" : "owner:a", key));
        const outcome = pending.then(value => ({ value, error: null }), error => ({ value: null, error }));
        const deadline = Date.now() + 5_000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (await holder.query("SELECT pg_blocking_pids($1) AS blockers", [contenderPid])).rows[0].blockers.length > 0;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(blocked, "the second session must block on the first session's full-key advisory lock");
        await holder.query(mode.endsWith("rollback") ? "ROLLBACK" : "COMMIT");
        const result = await outcome;
        if (mode.endsWith("replay")) {
          assert.equal(result.error, null);
          assert.equal(result.value?.changes, 0);
          assert.equal(result.value?.existing?.id, `winner-${key}`);
          assert.equal(result.value?.existing?.creation_request_sha256, "original");
          assert.equal(JSON.parse(result.value!.existing!.metadata_json!)[globalIdempotencyMarker], true);
        }
        else if (mode.endsWith("rollback")) { assert.equal(result.error, null); assert.equal(result.value?.changes, 1); }
        else { assert.equal(result.error?.status, 409); assert.equal(result.error?.message, "cannot-confirm-original-send"); }
        const stored = (await holder.query("SELECT id, metadata_json FROM agreements WHERE idempotency_key = $1", [key])).rows;
        assert.equal(stored.length, 1);
        if (mode === "default-foreign") assert.equal(stored[0].metadata_json, null);
        else assert.equal(JSON.parse(stored[0].metadata_json)[globalIdempotencyMarker], true);
      } finally {
        await holder.query("ROLLBACK");
        holder.release();
        if (pending) await Promise.allSettled([pending]);
      }
    }
    const races = await Promise.allSettled([serializedAgreementInsert(database, insertInput("global-winner", "owner:a", "race")), serializedAgreementInsert(database, insertInput("default-contender", "owner:b", "race", "original", false))]);
    assert.equal(races.filter(result => result.status === "fulfilled").length, 1);
    assert.equal(races.filter(result => result.status === "rejected").length, 1);
    const bad = insertInput("rollback", "owner:a", "rollback");
    bad.sql = "INSERT INTO missing_table VALUES (?, ?)";
    bad.params = ["rollback", null];
    bad.metadataParamIndex = 1;
    await assert.rejects(serializedAgreementInsert(database, bad), /missing_table/);
    assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM agreements WHERE idempotency_key = 'rollback'")).rows[0].count, 0);
    assert.equal((await serializedAgreementInsert(database, insertInput("after-rollback", "owner:a", "rollback"))).changes, 1);
    await serializedAgreementInsert(database, insertInput("legacy", "owner:a", "legacy", "original", false));
    const claimed = await serializedAgreementInsert(database, insertInput("ignored", "owner:a", "legacy"));
    assert.equal(claimed.existing?.id, "legacy");
    assert.equal(JSON.parse(claimed.existing!.metadata_json!)[globalIdempotencyMarker], true);
    await assert.rejects(serializedAgreementInsert(database, insertInput("foreign-legacy", "owner:b", "legacy", "original", false)), /cannot-confirm-original-send/);
    await serializedAgreementInsert(database, insertInput("legacy-fail", "owner:a", "legacy-fail", "original", false));
    await pool.query("ALTER TABLE agreements ADD CONSTRAINT reject_claim CHECK (id != 'legacy-fail' OR metadata_json IS NULL)");
    await assert.rejects(serializedAgreementInsert(database, insertInput("ignored-fail", "owner:a", "legacy-fail")), /reject_claim/);
    assert.equal((await pool.query("SELECT metadata_json FROM agreements WHERE id = 'legacy-fail'")).rows[0].metadata_json, null);
    await pool.query("ALTER TABLE agreements DROP CONSTRAINT reject_claim");
    assert.equal((await serializedAgreementInsert(database, insertInput("ignored-retry", "owner:a", "legacy-fail"))).existing?.id, "legacy-fail");
  } finally {
    await pool?.end();
    if (started) await execute(join(pgBin, "pg_ctl"), ["-D", join(directory, "data"), "-m", "immediate", "-w", "stop"], { env: localEnvironment });
    await rm(directory, { recursive: true, force: true });
  }
});
