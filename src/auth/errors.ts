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

  if (/oauth_timeout/i.test(detail) || /browser login timed out/i.test(firstLine)) {
    return {
      summary: "Browser login timed out",
      detail:
        "Parascene didn't finish authorizing in time. Click Log in to open the browser again — keep that tab open until you return here.",
      step: fallbackStep ?? "Wait for browser callback",
    };
  }

  return {
    summary: firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine,
    detail,
    step: fallbackStep,
  };
}

/** True when the user should reconnect via browser OAuth (dead session). */
export function isSessionReauthError(message: string): boolean {
  return /session expired|not signed in|sign (out and )?in again|log (out and )?in again|reconnect|invalid_grant|rejected the session/i.test(
    message,
  );
}

/** Transient transport failures (not auth) — retry once, then show network copy. */
export function isTransientNetworkError(message: string): boolean {
  return /couldn't reach|request failed|error sending request|timed out|timeout|failed to connect|network|dns|connection reset|connection refused/i.test(
    message,
  );
}

/** Map Rust / network auth failures into short Sync-friendly copy. */
export function mapEnsureAccessTokenError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (isSessionReauthError(raw)) {
    return new Error(
      "Your Parascene session expired. Reconnect in the browser, then retry Sync.",
    );
  }
  if (isTransientNetworkError(raw)) {
    return new Error(
      "Couldn't refresh your Parascene session. Check your network and try again.",
    );
  }
  return err instanceof Error ? err : new Error(raw);
}

/** Map catalog/API failures into Sync-friendly copy (auth vs network). */
export function mapCatalogSyncError(err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  if (/unauthorized/i.test(raw) || isSessionReauthError(raw)) {
    return new Error(
      "Your Parascene session expired. Reconnect in the browser, then retry Sync.",
    );
  }
  if (isTransientNetworkError(raw)) {
    return new Error(
      "Couldn't reach Parascene. Check your network, then retry Sync.",
    );
  }
  return err instanceof Error ? err : new Error(raw);
}
