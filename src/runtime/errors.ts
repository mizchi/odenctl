export type RuntimeErrorCode =
  | "artifact"
  | "compile"
  | "invoke"
  | "not_found"
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
