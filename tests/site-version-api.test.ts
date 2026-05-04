import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { cli } from "../src/routes/cli.js";
import { site } from "../src/routes/site.js";

test("root returns CLI version metadata when a legacy updater requests JSON", async () => {
  const response = await site.request("http://agentcontract.test/", {
    headers: { Accept: "application/json" }
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);

  const body = await response.json() as {
    version?: string;
    cli?: {
      package?: string;
      version?: string;
      install_command?: string;
    };
  };

  assert.equal(body.version, "0.1.9");
  assert.equal(body.cli?.package, "agent-contract");
  assert.equal(body.cli?.version, "0.1.9");
  assert.equal(body.cli?.install_command, "curl -fsSL http://agentcontract.test/cli/install.sh | bash");
});

test("CLI installer falls back to a user npm prefix when global install is denied", async () => {
  const response = await cli.request("http://agentcontract.test/cli/install.sh");
  assert.equal(response.status, 200);

  const tempDir = mkdtempSync(join(tmpdir(), "agentcontract-installer-test-"));
  try {
    const binDir = join(tempDir, "bin");
    const homeDir = join(tempDir, "home");
    const callsPath = join(tempDir, "npm-calls.log");
    mkdirSync(binDir);
    mkdirSync(homeDir);

    writeFileSync(join(binDir, "node"), "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(binDir, "node"), 0o755);
    writeFileSync(join(binDir, "npm"), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$NPM_CALLS"
for arg in "$@"; do
  if [ "$arg" = "--prefix" ]; then
    exit 0
  fi
done
exit 243
`);
    chmodSync(join(binDir, "npm"), 0o755);

    const result = spawnSync("bash", ["-c", await response.text()], {
      env: {
        ...process.env,
        AGENTCONTRACT_NPM_PREFIX: join(homeDir, ".agentcontract", "npm-global"),
        HOME: homeDir,
        NPM_CALLS: callsPath,
        PATH: `${binDir}:${process.env.PATH ?? ""}`
      },
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(callsPath, "utf8");
    assert.match(calls, /install -g http:\/\/agentcontract\.test\/agentcontract-0\.1\.9\.tgz/);
    assert.match(calls, /--prefix .*\.agentcontract\/npm-global/);
    assert.match(result.stdout, /Trying a user-writable npm prefix/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
