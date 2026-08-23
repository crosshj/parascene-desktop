import type { GenerateIntentId, GenerateServerId } from "./previewIntent";
import {
  intentOffersTimelineDestination,
  isIntentServerWired,
} from "./previewIntent";
import type { StagedClipDraft } from "./stagedClip";

export type TimelinePlacementState =
  | { mode: "hidden" }
  | { mode: "active"; draft: StagedClipDraft }
  | { mode: "disabled"; draft: StagedClipDraft; title: string };

export function resolveAddAssetTimelinePlacement(opts: {
  placed: boolean;
  intentId: GenerateIntentId | null;
  server: GenerateServerId | null;
  draft: StagedClipDraft;
  comingSoon: boolean;
  needsCreds: boolean;
  canPlace: boolean;
  timelineSoon: boolean;
}): TimelinePlacementState {
  if (opts.placed) return { mode: "hidden" };
  if (!opts.intentId || !opts.server) return { mode: "hidden" };
  if (!intentOffersTimelineDestination(opts.intentId)) return { mode: "hidden" };
  if (opts.comingSoon || opts.needsCreds) return { mode: "hidden" };
  if (!isIntentServerWired(opts.intentId, opts.server)) return { mode: "hidden" };
  if (opts.canPlace) return { mode: "active", draft: opts.draft };
  if (opts.timelineSoon) {
    return { mode: "disabled", draft: opts.draft, title: "Coming soon" };
  }
  return { mode: "hidden" };
}

