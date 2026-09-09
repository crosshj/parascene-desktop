export type LeftoverFolderSnap = {
  id?: string;
  title?: string;
  projectId?: string | null;
};

export type LeftoverProjectSnap = {
  id?: string;
  title?: string;
};

export type LeftoverProjectHit = {
  projectId?: string;
  folderId?: string;
};

function titleMatches(
  title: string | null | undefined,
  needles: string[],
): boolean {
  if (!title || !needles.length) return false;
  return needles.some((needle) => needle && title.includes(needle));
}

/** Projects / folders whose titles match this-run leftover needles. */
export function leftoverProjectsFromState(
  titleContains: string[],
  state: {
    folders?: LeftoverFolderSnap[];
    projects?: LeftoverProjectSnap[];
    openProjectId?: string | null;
    openProjectTitle?: string | null;
  },
): LeftoverProjectHit[] {
  const needles = titleContains.filter(Boolean);
  if (!needles.length) return [];

  const hits = new Map<string, LeftoverProjectHit>();
  const remember = (hit: LeftoverProjectHit) => {
    const key = hit.projectId || hit.folderId;
    if (!key) return;
    const prev = hits.get(key) ?? {};
    hits.set(key, {
      projectId: hit.projectId ?? prev.projectId,
      folderId: hit.folderId ?? prev.folderId,
    });
  };

  for (const folder of state.folders ?? []) {
    if (!titleMatches(folder.title, needles)) continue;
    remember({
      projectId: folder.projectId?.trim() || undefined,
      folderId: folder.id,
    });
  }
  for (const project of state.projects ?? []) {
    if (!titleMatches(project.title, needles) || !project.id) continue;
    remember({ projectId: project.id });
  }
  if (
    titleMatches(state.openProjectTitle, needles) &&
    state.openProjectId
  ) {
    remember({ projectId: state.openProjectId });
  }

  return [...hits.values()];
}
