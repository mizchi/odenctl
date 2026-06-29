import assert from "node:assert/strict";
import { test } from "node:test";
import {
  resolveRuntimeMemoryMb,
  resolveRuntimeNodeId,
  resolveRuntimePublicUrl,
} from "../src/runtime/config.ts";

test("runtime config uses Fly machine identity for scaled runtime nodes", () => {
  const env = {
    FLY_APP_NAME: "wasmplane-runtime",
    FLY_MACHINE_ID: "d8953eda04d9e8",
    FLY_VM_MEMORY_MB: "2048",
    RUNTIME_PUBLIC_URL: "auto",
  };

  assert.equal(resolveRuntimeNodeId(env, "0.0.0.0", 8080), "rt_d8953eda04d9e8");
  assert.equal(
    resolveRuntimePublicUrl(env, "0.0.0.0", 8080),
    "http://d8953eda04d9e8.vm.wasmplane-runtime.internal:8080",
  );
  assert.equal(resolveRuntimeMemoryMb(env, 4096), 2048);
});

test("runtime config keeps explicit non-auto public url override", () => {
  const env = {
    FLY_APP_NAME: "wasmplane-runtime",
    FLY_MACHINE_ID: "d8953eda04d9e8",
    RUNTIME_NODE_ID: "rt_manual",
    RUNTIME_PUBLIC_URL: "https://runtime.example.dev",
    RUNTIME_MEMORY_MB: "1024",
  };

  assert.equal(resolveRuntimeNodeId(env, "0.0.0.0", 8080), "rt_manual");
  assert.equal(resolveRuntimePublicUrl(env, "0.0.0.0", 8080), "https://runtime.example.dev");
  assert.equal(resolveRuntimeMemoryMb(env, 4096), 1024);
});
