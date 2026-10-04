import { test, expect } from "bun:test";
import { spawn, execFileSync } from "node:child_process";
import { readdirSync, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const cwd = fileURLToPath(new URL("../../", import.meta.url));
const node = process.env.AGENTSIGN_TEST_NODE ?? "node";
const version = execFileSync(node, ["--version"], { encoding: "utf8" }).trim();
const [major, minor] = version.slice(1).split(".").map(Number);
if (major < 22 || major === 22 && minor < 17) throw new Error(`AgentSign verification requires Node >=22.17, received ${version}`);

test("full AgentSign suite uses supported Node and disposable local fixtures", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentsign019-runtime-"));
  const logPath = process.env.AGENTSIGN_TEST_LOG ?? join(directory, "runtime.log");
  const files = readdirSync(join(cwd, "tests")).filter(name => name.endsWith(".test.ts")).sort().map(name => `tests/${name}`);
  const environment = {
    PATH: `${dirname(node)}:/opt/homebrew/bin:/usr/bin:/bin`, DOTENV_CONFIG_PATH: "/dev/null", NODE_ENV: "test",
    DATABASE_URL: "", DATABASE_PATH: join(directory, "fixture.db"), PDF_OUTPUT_DIR: join(directory, "pdfs"),
    AGENTCONTRACT_CONFIG: join(directory, "fake-cli-config.json"), AGENTCONTRACT_API_KEY: "fixture-api-key",
    RESEND_API_KEY: "", WORKOS_API_KEY: "", WORKOS_CLIENT_ID: "", WORKOS_COOKIE_PASSWORD: "fixture-cookie-password", POSTHOG_ENABLED: "false",
    AGENTSIGN_LOCAL_PG_TEST: process.env.AGENTSIGN_LOCAL_PG_TEST ?? "false"
  };
  try {
    const log = createWriteStream(logPath);
    const child = spawn(node, ["--import", "tsx", "--test", "--test-concurrency=1", ...files], { cwd, env: environment });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    const code = await new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    await new Promise<void>(resolve => log.end(resolve));
    console.log(`AgentSign ${version} runtime log: ${logPath}`);
    expect(code).toBe(0);
  } finally { await rm(directory, { recursive: true, force: true }); }
}, 600_000);
