import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseApiTokens } from "../crates/odenctl/src/control-plane/authz.ts";
import { createJsonlAuditSink } from "../crates/odenctl/src/control-plane/audit.ts";

test("API token parser supports legacy admin token and scoped token entries", () => {
  assert.deepEqual(
    parseApiTokens({
      ODENCTL_API_TOKEN: "admin-token",
      ODENCTL_API_TOKENS: "read-token=read;publish-token=publish,read",
    }),
    [
      { token: "admin-token", scopes: ["*"], principal: "legacy" },
      { token: "read-token", scopes: ["read"], principal: "token:read-token" },
      {
        token: "publish-token",
        scopes: ["publish", "read"],
        principal: "token:publish-token",
      },
    ],
  );
});

test("JSONL audit sink appends one event per line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "odenctl-audit-"));
  const path = join(dir, "audit.jsonl");
  const sink = createJsonlAuditSink({ path });

  await sink.record({
    timestamp: "2026-06-30T10:00:00.000Z",
    principal: "token:test",
    scope: "write",
    method: "POST",
    path: "/projects",
    status: 201,
  });

  const lines = (await readFile(path, "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    timestamp: "2026-06-30T10:00:00.000Z",
    principal: "token:test",
    scope: "write",
    method: "POST",
    path: "/projects",
    status: 201,
  });
});
