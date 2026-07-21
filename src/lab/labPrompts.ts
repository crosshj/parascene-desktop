/**
 * Shared Lab suite prompts — one subject/look so Project groups → create →
 * mutate → a2v feel like the same test character across the run.
 */

/** Core subject kept identical across still / edit / animate steps. */
export const LAB_TEST_SUBJECT =
  "a young musician in a dim recording studio, facing camera, soft rim light, cinematic music-video look";

/** Project groups Images seed + Parascene create (image) default. */
export const LAB_STILL_PROMPT =
  `${LAB_TEST_SUBJECT}, sharp focus on face and shoulders, calm neutral expression ready for performance, shallow background bokeh, high detail, motion-ready pose`;

/** Project groups Videos (i2v) + Parascene create (video / i2v) default. */
export const LAB_ANIMATE_PROMPT =
  "Subtle natural motion of the same musician: slight head turn and breathing, soft hair movement, gentle camera push-in, keep identity and framing stable, cinematic music-video feel";

/** Image mutate default — same person, clear but small change. */
export const LAB_MUTATE_PROMPT =
  "Same musician and wardrobe as the source, lower camera angle, stronger cinematic lighting, keep face identity and studio setting";

/** a2v compose default — performance on the same still. */
export const LAB_A2V_PROMPT =
  "Same musician lip syncing to the vocals, subtle head motion and breathing, soft camera push-in, keep framing and identity";

/** Prefer a project-saved still prompt; fall back to the shared Lab default. */
export function resolveLabStillPrompt(
  stored: string | null | undefined,
): string {
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  return trimmed || LAB_STILL_PROMPT;
}

/** Prefer a project-saved animate prompt; fall back to the shared Lab default. */
export function resolveLabAnimatePrompt(
  stored: string | null | undefined,
): string {
  const trimmed = typeof stored === "string" ? stored.trim() : "";
  return trimmed || LAB_ANIMATE_PROMPT;
}
