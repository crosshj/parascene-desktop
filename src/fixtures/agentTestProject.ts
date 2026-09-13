import { join } from "node:path";

const screens = join(process.cwd(), "public/help/desktop/screens");

export const AGENT_TEST_LIBRARY_PROJECT_SCREEN = join(
  screens,
  "library-project.png",
);
export const AGENT_TEST_LIBRARY_PROJECT_DELETE_SCREEN = join(
  screens,
  "library-project-delete.png",
);
