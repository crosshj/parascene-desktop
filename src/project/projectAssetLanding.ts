/** Project-ID routed local asset imports. Native code resolves the project root. */

import {
  importLocalPaths,
  importProjectAssetPaths,
  type ImportLocalResult,
} from "../library/catalogClient";
import { loadStoredProjects } from "./projectStore";
import { isStoredProjectV2 } from "./projectV2";

export function importLocalPathsForProject(opts: {
  paths: string[];
  projectId: string;
}): Promise<ImportLocalResult> {
  const stored = loadStoredProjects().find(
    (project) => project.id === opts.projectId,
  );
  if (stored && isStoredProjectV2(stored)) {
    return importLocalPaths(opts.paths);
  }
  return importProjectAssetPaths(opts.projectId, opts.paths);
}
