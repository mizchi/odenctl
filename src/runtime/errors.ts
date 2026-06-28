export type RuntimeErrorCode =
  | "artifact"
  | "compile"
  | "invoke"
  | "limits"
  | "not_found"
  | "overloaded"
  | "policy"
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
