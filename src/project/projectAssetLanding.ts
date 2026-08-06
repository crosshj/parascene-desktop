/** Project-ID routed local asset imports. Native code resolves the project root. */

import {
  importProjectAssetPaths,
  type ImportLocalResult,
} from "../library/catalogClient";

export function importLocalPathsForProject(opts: {
  paths: string[];
  projectId: string;
}): Promise<ImportLocalResult> {
  return importProjectAssetPaths(opts.projectId, opts.paths);
}
