export type RuntimeErrorCode =
  | "artifact"
  | "compile"
  | "cpu_limit"
  | "invoke"
  | "limits"
  | "not_found"
  | "overloaded"
  | "policy"
  | "rate_limited"
  | "timeout"
  | "unsupported"
  | "validation";

export class RuntimeError extends Error {
  code: RuntimeErrorCode;

  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
  }
}
