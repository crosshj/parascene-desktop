import { useEffect, useState } from "react";
import { blueCredentialsStatus } from "../../blue/blueClient";
import {
  BLUE_CREDENTIALS_CHANGED_EVENT,
  REPLICATE_TOKEN_CHANGED_EVENT,
} from "../../settings/events";
import {
  replicateModelsListEnabled,
  replicateTokenStatus,
} from "../../replicate/replicateClient";
import {
  serversForIntent,
  type GenerateIntentId,
  type GenerateServerId,
  type IntentServerCapability,
} from "./previewIntent";

export type GenerateServerCredentialState = {
  blueConfigured: boolean | null;
  replicateReady: boolean | null;
};

/** True when a BYO server still needs Settings setup (never while creds load). */
export function serverNeedsCredentials(
  id: GenerateServerId,
  creds: GenerateServerCredentialState,
): boolean {
  if (id === "blue_direct") {
    if (creds.blueConfigured === null) return false;
    return !creds.blueConfigured;
  }
  if (id === "replicate") {
    if (creds.replicateReady === null) return false;
    return !creds.replicateReady;
  }
  return false;
}

/**
 * Whether a system is enabled in Settings right now (not intent wiring).
 * Parascene is always on; BYO lanes need confirmed credentials.
 * While creds are still loading (`null`), BYO counts as not enabled.
 */
export function isGenerateServerEnabled(
  id: GenerateServerId,
  creds: GenerateServerCredentialState,
): boolean {
  if (id === "parascene_blue") return true;
  if (id === "blue_direct") return creds.blueConfigured === true;
  if (id === "replicate") return creds.replicateReady === true;
  return false;
}

/** Hide BYO servers until Settings credentials are confirmed (any cap status). */
export function isGenerateServerCapVisible(
  cap: Pick<IntentServerCapability, "server" | "status">,
  creds: GenerateServerCredentialState,
): boolean {
  return isGenerateServerEnabled(cap.server, creds);
}

export function serverChoiceDescription(
  cap: Pick<IntentServerCapability, "server" | "status">,
  creds: GenerateServerCredentialState,
  fallback: string,
): string {
  if (cap.status === "coming_soon") return fallback;
  if (cap.status === "wired" && serverNeedsCredentials(cap.server, creds)) {
    if (cap.server === "blue_direct") {
      return "Needs Blue credentials in Settings";
    }
    if (cap.server === "replicate") {
      return "Needs Replicate token and enabled models in Settings";
    }
    return "Needs Settings credentials";
  }
  return fallback;
}

export function libraryServerFormReady(
  cap: Pick<IntentServerCapability, "server" | "status"> | null | undefined,
  creds: GenerateServerCredentialState,
): boolean {
  if (!cap || cap.status !== "wired") return false;
  return !serverNeedsCredentials(cap.server, creds);
}

export function firstVisibleGenerateServer(
  intent: GenerateIntentId,
  creds: GenerateServerCredentialState,
  prefer?: GenerateServerId | null,
): GenerateServerId {
  const caps = serversForIntent(intent).filter((cap) =>
    isGenerateServerCapVisible(cap, creds),
  );
  const ready = caps.filter((cap) => cap.status === "wired");
  return (
    (prefer && ready.find((c) => c.server === prefer)?.server) ||
    ready[0]?.server ||
    caps[0]?.server ||
    "parascene_blue"
  );
}

export async function refreshReplicateReady(): Promise<boolean> {
  const token = await replicateTokenStatus();
  if (!token.configured) return false;
  const enabled = await replicateModelsListEnabled();
  return enabled.length > 0;
}

/** Module cache — survives Form remounts while flipping assets. */
let cachedCredentialState: GenerateServerCredentialState | null = null;
let cachedEnabledServerIds: readonly GenerateServerId[] | null = null;

function enabledIdsFromCreds(
  creds: GenerateServerCredentialState,
): GenerateServerId[] {
  const ids: GenerateServerId[] = ["parascene_blue"];
  if (creds.blueConfigured === true) ids.push("blue_direct");
  if (creds.replicateReady === true) ids.push("replicate");
  return ids;
}

function sameIdList(
  a: readonly GenerateServerId[],
  b: readonly GenerateServerId[],
): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Settled enabled-system ids for the System chooser.
 *
 * Credentials are read once Settings answers; the enabled list is cached and
 * only recomputed when those answers change — never from selection / intent.
 * While Settings is still loading, returns the last settled cache (or Parascene
 * alone on first paint) so flipping assets cannot reshuffle the roster.
 */
export function settledEnabledGenerateServerIds(
  creds: GenerateServerCredentialState,
): readonly GenerateServerId[] {
  const settled =
    creds.blueConfigured !== null && creds.replicateReady !== null;
  if (!settled) {
    return cachedEnabledServerIds ?? ["parascene_blue"];
  }
  const next = enabledIdsFromCreds(creds);
  if (!cachedEnabledServerIds || !sameIdList(cachedEnabledServerIds, next)) {
    cachedEnabledServerIds = next;
  }
  return cachedEnabledServerIds;
}

/** @internal test helper — clear module caches between cases. */
export function resetGenerateServerCredentialCachesForTests(): void {
  cachedCredentialState = null;
  cachedEnabledServerIds = null;
}

/** Settings-backed readiness for BYO servers (Blue credentials, Replicate token + models). */
export function useGenerateServerCredentials(): GenerateServerCredentialState {
  const [creds, setCreds] = useState<GenerateServerCredentialState>(
    () =>
      cachedCredentialState ?? {
        blueConfigured: null,
        replicateReady: null,
      },
  );

  useEffect(() => {
    let cancelled = false;
    const apply = (next: GenerateServerCredentialState) => {
      if (cancelled) return;
      cachedCredentialState = next;
      if (next.blueConfigured !== null && next.replicateReady !== null) {
        settledEnabledGenerateServerIds(next);
      }
      setCreds(next);
    };
    const refresh = () => {
      void Promise.all([
        blueCredentialsStatus()
          .then((s) => s.configured)
          .catch(() => false),
        refreshReplicateReady().catch(() => false),
      ]).then(([blueConfigured, replicateReady]) => {
        apply({ blueConfigured, replicateReady });
      });
    };
    refresh();
    window.addEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, refresh);
    window.addEventListener(REPLICATE_TOKEN_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.removeEventListener(BLUE_CREDENTIALS_CHANGED_EVENT, refresh);
      window.removeEventListener(REPLICATE_TOKEN_CHANGED_EVENT, refresh);
    };
  }, []);

  return creds;
}
