import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, connect, type ConnectionOptions } from "node:tls";
import { promisify } from "node:util";
import test from "node:test";
import { verifiedPostgresSsl } from "../src/lib/postgres.js";

const execute = promisify(execFile);

test("supported Node TLS rejects an untrusted remote database certificate and accepts only a valid explicit CA and hostname", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentsign-tls-"));
  const keyPath = join(directory, "fixture-key.pem");
  const certificatePath = join(directory, "fixture-cert.pem");
  await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certificatePath, "-days", "1", "-subj", "/CN=fixture.example.test", "-addext", "subjectAltName=DNS:fixture.example.test"], { env: { PATH: "/opt/homebrew/bin:/usr/bin:/bin" } });
  const certificate = await readFile(certificatePath, "utf8");
  const server = createServer({ key: await readFile(keyPath), cert: certificate }, socket => socket.end());
  server.on("tlsClientError", () => undefined);
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const handshake = (options: ConnectionOptions) => new Promise<void>((resolve, reject) => {
      const socket = connect({ host: "127.0.0.1", port, servername: "fixture.example.test", ...options });
      socket.once("secureConnect", () => { socket.destroy(); resolve(); });
      socket.once("error", reject);
    });
    const untrusted = verifiedPostgresSsl("postgresql://fixture@pooler.example.test/postgres", "");
    assert.deepEqual(untrusted, { rejectUnauthorized: true });
    await assert.rejects(handshake(untrusted as ConnectionOptions), { code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    const trusted = verifiedPostgresSsl("postgresql://fixture@pooler.example.test/postgres", certificate);
    assert.equal((trusted as ConnectionOptions).rejectUnauthorized, true);
    await handshake(trusted as ConnectionOptions);
    await assert.rejects(handshake({ ...trusted as ConnectionOptions, servername: "foreign.example.test" }), { code: "ERR_TLS_CERT_ALTNAME_INVALID" });
    assert.throws(() => verifiedPostgresSsl("postgresql://fixture@pooler.example.test/postgres", "invalid fixture CA"), /valid PEM-encoded/);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
