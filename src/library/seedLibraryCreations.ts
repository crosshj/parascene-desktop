/**
 * @awesome beginning Library state: one unpublished 1:1 still that is also
 * the account avatar. Integration teardown and `cloud.delete` must never
 * remove these ids.
 */
export const SEED_LIBRARY_CREATION_IDS: readonly string[] = ["28006"];

export function isSeedLibraryCreationId(
  id: string | number | null | undefined,
): boolean {
  if (id == null) return false;
  return SEED_LIBRARY_CREATION_IDS.includes(String(id).trim());
}
