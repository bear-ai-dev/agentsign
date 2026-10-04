import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BlockList, isIP } from "node:net";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

test("the webhook deadline covers stalled DNS and cannot send after the lease window", async () => {
  let expire!: () => void;
  let completeLookup!: (addresses: { address: string; family: number }[]) => void;
  let requests = 0;
  const lookup = new Promise(resolve => { completeLookup = resolve; });
  const exports: { postWebhook?: (url: string, body: string, headers: Record<string, string>, options?: { deadlineAt: number }) => Promise<number> } = {};
  const dependencies: Record<string, unknown> = { "node:net": { BlockList, isIP }, "node:dns/promises": { lookup: () => lookup }, "node:https": { request: () => { requests++; throw new Error("No network allowed"); } } };
  const source = readFileSync("src/lib/safeWebhook.ts", "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    exports, require: (name: string) => { if (!(name in dependencies)) throw new Error(`Unexpected dependency ${name}`); return dependencies[name]; },
    URL, AbortController, setTimeout: (callback: () => void, milliseconds: number) => { assert.equal(milliseconds, 15_000); expire = callback; return 1; }, clearTimeout: () => undefined
  });
  const posting = exports.postWebhook!("https://receiver.example.test", "{}", {});
  expire();
  await assert.rejects(posting, /deadline exceeded/);
  completeLookup([{ address: "8.8.8.8", family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
  await assert.rejects(exports.postWebhook!("https://receiver.example.test", "{}", {}, { deadlineAt: Date.now() - 1 }), /deadline exceeded/);
  assert.equal(requests, 0);
});
