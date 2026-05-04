import assert from "node:assert/strict";
import test from "node:test";

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
