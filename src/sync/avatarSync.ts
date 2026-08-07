import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { ParasceneUserInfo } from "../sdk/parascene";
import { getMemorySession } from "../auth/session";

export type UserAvatarDisplay = {
  /** Local asset URL when verified; never a remote URL. */
  src: string | null;
  /** Finished ensure attempt for the current user+picture key. */
  ready: boolean;
  /** `${sub}|${picture}` — changes when identity or remote URL changes. */
  key: string;
  /** Last ensure failure detail (for diagnostics). */
  reason: string | null;
};

type EnsureUserAvatarResult = {
  ok: boolean;
  localPath?: string | null;
  reason?: string | null;
};

const EMPTY: UserAvatarDisplay = {
  src: null,
  ready: true,
  key: "",
  reason: null,
};

let state: UserAvatarDisplay = EMPTY;
let inflight: Promise<UserAvatarDisplay> | null = null;
let inflightKey = "";
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(next: UserAvatarDisplay): void {
  state = next;
  emit();
}

function avatarKey(user: Pick<ParasceneUserInfo, "sub" | "picture">): string {
  return `${user.sub.trim()}|${(user.picture ?? "").trim()}`;
}

export function getUserAvatarDisplay(): UserAvatarDisplay {
  return state;
}

export function subscribeUserAvatarDisplay(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Clear display state (logout). */
export function clearUserAvatarDisplay(): void {
  inflight = null;
  inflightKey = "";
  setState(EMPTY);
}

/**
 * Download + validate the user avatar (Rust). Updates the display store.
 * Safe to call from sync and from AuthProvider; concurrent calls coalesce.
 */
export async function ensureUserAvatar(
  user: Pick<ParasceneUserInfo, "sub" | "picture">,
): Promise<UserAvatarDisplay> {
  const sub = user.sub?.trim() ?? "";
  const picture = user.picture?.trim() || null;
  const key = avatarKey({ sub, picture: picture ?? undefined });

  if (!sub) {
    const next: UserAvatarDisplay = {
      src: null,
      ready: true,
      key: "",
      reason: "Missing user id",
    };
    setState(next);
    return next;
  }

  if (!picture) {
    const next: UserAvatarDisplay = {
      src: null,
      ready: true,
      key,
      reason: "No avatar URL",
    };
    setState(next);
    return next;
  }

  if (inflight && inflightKey === key) {
    return inflight;
  }

  // Keep showing the prior avatar only when the key matches; otherwise
  // clear src immediately so we never flash a stale/broken remote image.
  if (state.key !== key) {
    setState({ src: null, ready: false, key, reason: null });
  } else if (!state.ready) {
    /* already pending for this key */
  } else {
    setState({ ...state, ready: false });
  }

  inflightKey = key;
  inflight = (async (): Promise<UserAvatarDisplay> => {
    try {
      const result = await invoke<EnsureUserAvatarResult>(
        "auth_ensure_user_avatar",
        {
          userId: sub,
          pictureUrl: picture,
        },
      );
      const localPath = result.localPath?.trim() || null;
      const src =
        result.ok && localPath ? convertFileSrc(localPath) : null;
      const next: UserAvatarDisplay = {
        src,
        ready: true,
        key,
        reason: result.reason?.trim() || null,
      };
      // Only apply if this is still the latest request key.
      if (inflightKey === key) {
        setState(next);
      }
      return next;
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      const next: UserAvatarDisplay = {
        src: null,
        ready: true,
        key,
        reason,
      };
      if (inflightKey === key) {
        setState(next);
      }
      return next;
    } finally {
      if (inflightKey === key) {
        inflight = null;
      }
    }
  })();

  return inflight;
}

/** Mark the current avatar unusable (img onError). Keeps ready=true. */
export function rejectUserAvatarDisplay(reason = "Image failed to load"): void {
  if (!state.src && state.ready) return;
  setState({
    ...state,
    src: null,
    ready: true,
    reason,
  });
}

/**
 * Sync hook: ensure avatar for the in-memory session user.
 * Never throws — failures become placeholder display.
 */
export async function syncSessionUserAvatar(): Promise<void> {
  const session = getMemorySession();
  if (!session?.user?.sub) {
    clearUserAvatarDisplay();
    return;
  }
  await ensureUserAvatar(session.user);
}
