/** Structured auth failures for UI diagnostics. */

export type AuthErrorInfo = {
  /** Short headline shown by default */
  summary: string;
  /** Full technical detail (collapsible) */
  detail: string;
  /** Which step failed */
  step?: string;
};

export function formatUnknownError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    const withCause = err as Error & { cause?: unknown };
    if (withCause.cause != null) {
      parts.push(`cause: ${formatUnknownError(withCause.cause)}`);
    }
    if (err.stack) parts.push(err.stack);
    return parts.join("\n");
  }
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") {
      const rest = { ...obj };
      delete rest.message;
      const extra = Object.keys(rest).length
        ? `\n${JSON.stringify(rest, null, 2)}`
        : "";
      return `${obj.message}${extra}`;
    }
    try {
      return JSON.stringify(err, null, 2);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

export class AuthFlowError extends Error {
  readonly info: AuthErrorInfo;

  constructor(info: AuthErrorInfo) {
    super(info.summary);
    this.name = "AuthFlowError";
    this.info = info;
  }
}

export function toAuthErrorInfo(err: unknown, fallbackStep?: string): AuthErrorInfo {
  if (err instanceof AuthFlowError) return err.info;
  const detail = formatUnknownError(err);
  const firstLine = detail.split("\n")[0]?.trim() || "Login failed";
  return {
    summary: firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine,
    detail,
    step: fallbackStep,
  };
}
