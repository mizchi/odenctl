import assert from "node:assert/strict";
import test from "node:test";
import gateway, { Counter } from "../examples/celld-gateway/index.js";

function request(body: unknown = {}, token = "test-secret", binding = "COUNTER", name = "one") {
  return new Request(`http://gateway/v1/objects/${binding}/${encodeURIComponent(name)}/fetch`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const input = { method: "POST", path: "/increment", headers: [], body: "", requestId: "retry-1" };

test("celld gateway authenticates before resolving a binding", async () => {
  let opened = false;
  const env = {
    ODEN_GATEWAY_TOKEN: "test-secret", ODEN_BINDINGS: "COUNTER",
    get COUNTER() { opened = true; throw new Error("must not resolve"); },
  };
  assert.equal((await gateway.fetch(request(input, "wrong"), env)).status, 401);
  assert.equal(opened, false);
  assert.equal((await gateway.fetch(request(input), {})).status, 503);
});

test("celld gateway scopes object names and keeps gateway credentials out of the object", async () => {
  let resolved: unknown;
  let forwarded: Request | undefined;
  const env = {
    ODEN_GATEWAY_TOKEN: "test-secret", ODEN_BINDINGS: "COUNTER",
    COUNTER: {
      idFromName(name: string) { resolved = name; return `object:${name}`; },
      get(id: string) {
        assert.equal(id, "object:日本語/one");
        return { async fetch(req: Request) {
          forwarded = req;
          return new Response("denied by object", { status: 401 });
        } };
      },
    },
  };
  const response = await gateway.fetch(request(input, "test-secret", "COUNTER", "日本語/one"), env);
  assert.equal(response.status, 200);
  assert.equal(resolved, "日本語/one");
  assert.equal(forwarded!.headers.get("authorization"), null);
  assert.equal(forwarded!.headers.get("x-oden-request-id"), "retry-1");
  const output = await response.json();
  assert.equal(output.status, 401);
  assert.equal(Buffer.from(output.body, "base64").toString(), "denied by object");
  assert.equal((await gateway.fetch(request(input, "test-secret", "SECRET"), env)).status, 404);
});

test("celld gateway rejects malformed envelopes before dispatch", async () => {
  const env = { ODEN_GATEWAY_TOKEN: "test-secret", ODEN_BINDINGS: "COUNTER" };
  for (const bad of [
    { ...input, path: "https://attacker.invalid" },
    { ...input, method: "CONNECT" },
    { ...input, body: "%%%" },
    { ...input, headers: [["x-oden-request-id", "forged"]] },
    { ...input, requestId: "bad\nvalue" },
  ]) {
    assert.equal((await gateway.fetch(request(bad), env)).status, 400);
  }
});

test("counter persists deduplication with the update across object activations", async () => {
  const values = new Map<string, unknown>();
  let tail = Promise.resolve();
  const storage = {
    async get(key: string) { return values.get(key); },
    async put(key: string, value: unknown) { values.set(key, value); },
    transaction<T>(fn: (tx: unknown) => Promise<T>) {
      const result = tail.then(() => fn(storage));
      tail = result.then(() => {}, () => {});
      return result;
    },
  };
  const increment = (actor: Counter, id: string) => actor.fetch(new Request("https://object/increment", {
    method: "POST", headers: { "x-oden-request-id": id },
  })).then((response: Response) => response.json());
  const actor = new Counter({ storage });
  const first = await Promise.all(Array.from({ length: 12 }, (_, i) => increment(actor, `id-${i}`)));
  assert.deepEqual(first.map((v) => v.n).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
  const reactivated = new Counter({ storage });
  assert.equal((await increment(reactivated, "id-0")).n, 1);
  const response = await reactivated.fetch(new Request("https://object/"));
  assert.equal((await response.json()).n, 12);
});
