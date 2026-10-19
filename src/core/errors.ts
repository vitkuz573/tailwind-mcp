/**
 * Typed errors.
 *
 * Anything that can reach the model is expressed as a stable machine code
 * plus a short message, so the model can branch on the failure rather than
 * parse prose.
 */

export type ErrorCode =
  | "INVALID_ARGUMENT"
  | "PROJECT_NOT_FOUND"
  | "NO_TAILWIND"
  | "UNSUPPORTED_VERSION"
  | "LOAD_FAILED"
  | "LIMIT_EXCEEDED"
  | "INTERNAL";

const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["LOAD_FAILED", "INTERNAL"]);

export interface TailwindMcpErrorOptions {
  readonly details?: Record<string, unknown> | undefined;
  readonly cause?: unknown;
  readonly retryable?: boolean | undefined;
  readonly hint?: string | undefined;
}

export class TailwindMcpError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;
  readonly retryable: boolean;
  /** Actionable next step for the model, e.g. how to point at another project. */
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, options: TailwindMcpErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TailwindMcpError";
    this.code = code;
    this.details = options.details ?? {};
    this.retryable = options.retryable ?? RETRYABLE.has(code);
    this.hint = options.hint;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.hint ? { hint: this.hint } : {}),
      ...(Object.keys(this.details).length > 0 ? { details: this.details } : {}),
    };
  }
}

export function isTailwindMcpError(value: unknown): value is TailwindMcpError {
  return value instanceof TailwindMcpError;
}

export function errorCodeOf(value: unknown): ErrorCode {
  return isTailwindMcpError(value) ? value.code : "INTERNAL";
}

export function invalidArgument(
  message: string,
  details?: Record<string, unknown>,
): TailwindMcpError {
  return new TailwindMcpError("INVALID_ARGUMENT", message, { details, retryable: false });
}

export function projectNotFound(message: string, hint?: string): TailwindMcpError {
  return new TailwindMcpError("PROJECT_NOT_FOUND", message, { retryable: false, hint });
}

export function noTailwind(message: string, hint?: string): TailwindMcpError {
  return new TailwindMcpError("NO_TAILWIND", message, { retryable: false, hint });
}

export function loadFailed(message: string, cause?: unknown, details?: Record<string, unknown>) {
  return new TailwindMcpError("LOAD_FAILED", message, { cause, details });
}
