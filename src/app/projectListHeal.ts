/**
 * Detect chooser/list drift: localStorage still has projects that React state
 * dropped (e.g. after a healthy-only publish while a sibling was corrupt).
 */
export function shouldHealStoredProjectsFromStorage(
  memoryIds: readonly string[],
  storageIds: readonly string[],
): boolean {
  if (storageIds.length === 0) return false;
  if (memoryIds.length === 0) return true;
  const memory = new Set(memoryIds);
  return storageIds.some((id) => !memory.has(id));
}
