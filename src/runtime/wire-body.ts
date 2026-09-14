import { isUtf8 } from "node:buffer";
import { RuntimeError } from "./errors.ts";

export type WireBody = { body: string; bodyBase64?: never } | {
  body?: never;
  bodyBase64: string;
};

export function encodeWireBody(bytes: Uint8Array): WireBody {
  const body = Buffer.from(bytes);
  // NUL cannot be passed to a spawned process in argv, even though it is UTF-8.
  return isUtf8(body) && !body.includes(0)
    ? { body: body.toString("utf8") }
    : { bodyBase64: body.toString("base64") };
}

export function decodeWireBody(record: Record<string, unknown>): Uint8Array {
  if ("body" in record && "bodyBase64" in record) {
    throw new RuntimeError(
      "invoke",
      "body and bodyBase64 are mutually exclusive",
    );
  }
  if ("bodyBase64" in record) {
    if (typeof record.bodyBase64 !== "string") {
      throw new RuntimeError("invoke", "bodyBase64 must be a string");
    }
    const bytes = Buffer.from(record.bodyBase64, "base64");
    // Buffer.from is deliberately permissive; the wire contract is canonical.
    if (bytes.toString("base64") !== record.bodyBase64) {
      throw new RuntimeError(
        "invoke",
        "bodyBase64 must be canonical padded base64",
      );
    }
    return bytes;
  }
  if ("body" in record && typeof record.body !== "string") {
    throw new RuntimeError("invoke", "body must be a string");
  }
  return Buffer.from(
    typeof record.body === "string" ? record.body : "",
    "utf8",
  );
}
