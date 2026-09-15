import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { startServiceProcess } from "../crates/odenctl/src/service-process.ts";
import {
  createWasip3HostDaemonInvoker,
  createWasip3HostInvoker,
} from "../crates/odenctl/src/runtime/wasip3-host.ts";
import type { InvokeComponentRequest } from "../crates/odenctl/src/runtime/types.ts";

const exec = promisify(execFile);
const bytes = Buffer.from(Array.from({ length: 256 }, (_, value) => value));
function request(body = bytes): InvokeComponentRequest {
  return {
    deploymentId: "dep_binary",
    method: "POST",
    uri: "http://binary.example/echo",
    headers: [{ name: "content-type", value: "application/octet-stream" }],
    body,
    component: {
      deploymentId: "dep_binary",
      backend: "wasmtime",
      componentPath: "unused.wasm",
      precompiledPath: "unused.cwasm",
      cached: true,
    },
  };
}

test("spawn and daemon adapters preserve binary and NUL request/response bodies", async () => {
  for (
    const body of [
      bytes,
      Buffer.from("before\0after"),
      Buffer.alloc(0),
      Buffer.from("hello 日本語"),
    ]
  ) {
    const binary = body.equals(bytes) || body.includes(0);
    const encoded = binary
      ? { bodyBase64: body.toString("base64") }
      : { body: body.toString("utf8") };
    const response = JSON.stringify({ status: 200, headers: [], ...encoded });
    const spawn = createWasip3HostInvoker({
      commandRunner: {
        async run(_program, args) {
          const flag = binary ? "--body-base64" : "--body";
          assert(args.includes(flag));
          assert.equal(
            args[args.indexOf(flag) + 1],
            binary ? body.toString("base64") : body.toString("utf8"),
          );
          return { stdout: response, stderr: "" };
        },
      },
    });
    const daemon = createWasip3HostDaemonInvoker({
      url: "http://unused",
      fetch: async (_url, init) => {
        const payload = JSON.parse(String(init?.body));
        assert.equal(
          payload.body,
          "body" in encoded ? encoded.body : undefined,
        );
        assert.equal(
          payload.bodyBase64,
          "bodyBase64" in encoded ? encoded.bodyBase64 : undefined,
        );
        return new Response(response);
      },
    });
    for (const invoker of [spawn, daemon]) {
      assert.deepEqual(
        Buffer.from((await invoker.invoke(request(body))).body),
        body,
      );
    }
  }
});

test("adapters reject ambiguous or malformed body encodings", async () => {
  for (
    const body of [
      { body: "text", bodyBase64: "AA==" },
      { bodyBase64: "%%%" },
      { bodyBase64: "AB==" },
      { bodyBase64: "AA" },
      { bodyBase64: 42 },
      { body: null },
    ]
  ) {
    const invoker = createWasip3HostDaemonInvoker({
      url: "http://unused",
      fetch: async () =>
        new Response(JSON.stringify({ status: 200, headers: [], ...body })),
    });
    await assert.rejects(invoker.invoke(request()), /body|base64/i);
  }
});

const host = process.env.ODEN_BINARY_HOST;
const component = process.env.ODEN_BINARY_COMPONENT;
test("real P3 component round-trips bytes through CLI and daemon adapters", {
  skip: !(host && component),
  timeout: 30_000,
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "odenctl-binary-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const compiled = join(directory, "binary.cwasm");
  await exec(resolve(host!), [
    "compile",
    "--component",
    resolve(component!),
    "--out",
    compiled,
  ]);
  const daemon = await startServiceProcess(resolve(host!), [
    "serve",
    "--host",
    "127.0.0.1",
    "--port",
    "0",
  ]);
  t.after(() => daemon.stop());
  for (
    const invoker of [
      createWasip3HostInvoker({ hostBin: resolve(host!) }),
      createWasip3HostDaemonInvoker({ url: daemon.url }),
    ]
  ) {
    // Includes PNG magic, invalid UTF-8, NUL, and every possible byte value.
    const input = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      bytes,
    ]);
    const args = request(input);
    args.component.precompiledPath = compiled;
    args.component.componentPath = resolve(component!);
    args.component.limits = {
      cpuMs: 5000,
      wallMs: 5000,
      memoryMb: 64,
      requestBytes: 1024,
      responseBytes: 1024,
      subrequests: 1,
    };
    const response = await invoker.invoke(args);
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(response.body), input);
  }
});
