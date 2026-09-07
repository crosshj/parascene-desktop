import { existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { invokeOk, loadAgentManifest, requireSignedIn } from "./agentClient";
import { expectCloudMissing } from "./cloudIdentity";
import { sweepTestCreations } from "./teardown";

type ImportResult = {
  creations?: Array<{ id: string; localPath?: string | null }>;
};

type LookupRow = {
  id: string;
  localOnly?: boolean;
  origin?: string;
  localPath?: string | null;
};

type LookupResult = {
  found?: LookupRow[];
};

/** 1×1 PNG so import does not depend on Help media. */
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const stamp = Date.now();
const TITLE_PREFIX = "agent-test-localonly-";
const importPath = join(tmpdir(), `${TITLE_PREFIX}${stamp}.png`);
writeFileSync(importPath, TINY_PNG);

let creationId = "";

describe("agent local-only", () => {
  afterAll(async () => {
    const agent = await loadAgentManifest();
    await sweepTestCreations(agent, {
      ids: [creationId],
      titleContains: [TITLE_PREFIX],
      pathContains: [TITLE_PREFIX],
    });
  }, 120_000);

  it(
    "imports a disk file that Sync newest does not prune and never exists on Parascene",
    async () => {
      const agent = await loadAgentManifest();
      await requireSignedIn(agent);
      expect(existsSync(importPath)).toBe(true);
      await invokeOk(agent, "project.close").catch(() => {});

      const imported = await invokeOk<ImportResult>(agent, "library.import", {
        paths: [importPath],
      });
      creationId = imported.creations?.[0]?.id ?? "";
      expect(creationId).toBeTruthy();

      const afterImport = await invokeOk<LookupResult>(agent, "library.lookup", {
        id: creationId,
      });
      expect(afterImport.found).toHaveLength(1);
      expect(afterImport.found?.[0]?.id).toBe(creationId);
      expect(afterImport.found?.[0]?.localOnly).toBe(true);
      expect(afterImport.found?.[0]?.origin).toBe("local");
      expect(afterImport.found?.[0]?.localPath).toBeTruthy();
      expect(existsSync(afterImport.found?.[0]?.localPath ?? "")).toBe(true);

      await expectCloudMissing(agent, creationId);

      await invokeOk(agent, "sync.start");

      const afterSync = await invokeOk<LookupResult>(agent, "library.lookup", {
        id: creationId,
      });
      expect(afterSync.found).toHaveLength(1);
      expect(afterSync.found?.[0]?.id).toBe(creationId);
      expect(afterSync.found?.[0]?.localOnly).toBe(true);
      expect(afterSync.found?.[0]?.origin).toBe("local");

      await expectCloudMissing(agent, creationId);
    },
    6 * 60_000,
  );
});
