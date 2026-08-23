import { useEffect, useState } from "react";
import { blueCredentialsStatus } from "../../blue/blueClient";
import {
  BLUE_CREDENTIALS_CHANGED_EVENT,
  REPLICATE_TOKEN_CHANGED_EVENT,
} from "../../settings/events";
import { replicateModelsListEnabled, replicateTokenStatus } from "../../replicate/replicateClient";
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

/** Hide BYO servers until Settings credentials are confirmed (any cap status). */
export function isGenerateServerCapVisible(
  cap: Pick<IntentServerCapability, "server" | "status">,
  creds: GenerateServerCredentialState,
): boolean {
  if (cap.server === "parascene_blue") return true;
  if (cap.server === "blue_direct") {
    return creds.blueConfigured === true;
  }
  if (cap.server === "replicate") {
    return creds.replicateReady === true;
  }
  return true;
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
    (prefer &&
      ready.find((c) => c.server === prefer)?.server) ||
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

/** Settings-backed readiness for BYO servers (Blue credentials, Replicate token + models). */
export function useGenerateServerCredentials(): GenerateServerCredentialState {
  const [blueConfigured, setBlueConfigured] = useState<boolean | null>(null);
  const [replicateReady, setReplicateReady] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void blueCredentialsStatus()
        .then((s) => {
          if (!cancelled) setBlueConfigured(s.configured);
        })
        .catch(() => {
          if (!cancelled) setBlueConfigured(false);
        });
      void refreshReplicateReady()
        .then((ready) => {
          if (!cancelled) setReplicateReady(ready);
        })
        .catch(() => {
          if (!cancelled) setReplicateReady(false);
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

  return { blueConfigured, replicateReady };
}
