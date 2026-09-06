import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const JOURNEY_PROJECT_TITLE_PREFIX = "agent-test-journey-";

export type GenerateJourneyState = {
  projectId: string;
  folderId: string;
  stillId: string;
  imagesGroupId: string;
  localPath: string;
  title: string;
};

const PATH = join(process.cwd(), "integration/.journey-generate.json");

export function writeGenerateJourney(state: GenerateJourneyState): void {
  writeFileSync(PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function readGenerateJourney(): GenerateJourneyState | null {
  if (!existsSync(PATH)) return null;
  return JSON.parse(readFileSync(PATH, "utf8")) as GenerateJourneyState;
}

export function clearGenerateJourney(): void {
  if (existsSync(PATH)) unlinkSync(PATH);
}

export function requireGenerateJourney(): GenerateJourneyState {
  const state = readGenerateJourney();
  if (!state?.projectId || !state.stillId || !state.localPath) {
    throw new Error(
      "Generate journey is missing. Run integration/05-generation.integration.test.ts first — 06 continues that same project and still.",
    );
  }
  return state;
}
