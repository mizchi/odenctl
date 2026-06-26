export type ControlPlaneErrorCode = "validation" | "not_found" | "conflict";

export class ControlPlaneError extends Error {
  code: ControlPlaneErrorCode;
  status: number;

  constructor(code: ControlPlaneErrorCode, message: string) {
    super(message);
    this.name = "ControlPlaneError";
    this.code = code;
    this.status = codeToStatus(code);
  }
}

export function isControlPlaneError(error: unknown): error is ControlPlaneError {
  return error instanceof ControlPlaneError;
}

function codeToStatus(code: ControlPlaneErrorCode) {
  switch (code) {
    case "validation":
      return 400;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
  }
}
