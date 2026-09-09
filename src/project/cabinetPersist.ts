/**
 * One project-document write after Assets Remove/Delete.
 * Never hide a cabinet cover the project still points at — that fails save
 * and leaves Generate appending to a deleted group.
 */

export type CabinetPersistPatch = {
  imagesGroupId: string | null;
  videosGroupId: string | null;
  hideIds: string[];
  addIds: string[];
};

export function cabinetPersistPatch(opts: {
  imagesGroupId: string | null;
  videosGroupId: string | null;
  hideIds?: readonly string[];
  addIds?: readonly string[];
}): CabinetPersistPatch {
  const addIds = [
    ...new Set(
      (opts.addIds ?? []).map((id) => id.trim()).filter(Boolean),
    ),
  ];
  const hide = new Set(
    (opts.hideIds ?? []).map((id) => id.trim()).filter(Boolean),
  );
  for (const id of addIds) hide.delete(id);

  let imagesGroupId = opts.imagesGroupId?.trim() || null;
  let videosGroupId = opts.videosGroupId?.trim() || null;
  if (imagesGroupId && hide.has(imagesGroupId)) imagesGroupId = null;
  if (videosGroupId && hide.has(videosGroupId)) videosGroupId = null;
  if (imagesGroupId) hide.delete(imagesGroupId);
  if (videosGroupId) hide.delete(videosGroupId);

  return {
    imagesGroupId,
    videosGroupId,
    hideIds: [...hide],
    addIds,
  };
}
