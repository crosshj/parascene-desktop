import { expect } from "vitest";
import { invokeOk, type AgentManifest } from "./agentClient";

export type CloudLookupResult = {
  id?: string;
  found?: boolean;
  status?: number;
  error?: string;
  memberIds?: string[];
};

/** Grouped members often 404 on GET; the cover still lists the same id. */
export async function expectCloudHasCreation(
  agent: AgentManifest,
  id: string,
  groupId?: string | null,
): Promise<CloudLookupResult> {
  const direct = await invokeOk<CloudLookupResult>(agent, "cloud.lookup", {
    id,
  });
  if (direct.found) {
    expect(direct.id).toBe(id);
    return direct;
  }
  const coverId = groupId?.trim() || "";
  if (!coverId || coverId === id) {
    throw new Error(
      `cloud.lookup ${id} missing (${direct.status ?? "?"} ${direct.error ?? ""})`,
    );
  }
  const cover = await invokeOk<CloudLookupResult>(agent, "cloud.lookup", {
    id: coverId,
  });
  expect(
    cover.found,
    `cloud.lookup cover ${coverId} missing (${cover.status ?? "?"} ${cover.error ?? ""})`,
  ).toBe(true);
  expect(cover.memberIds ?? []).toContain(id);
  return cover;
}

export async function expectCloudMissing(
  agent: AgentManifest,
  id: string,
): Promise<CloudLookupResult> {
  const looked = await invokeOk<CloudLookupResult>(agent, "cloud.lookup", {
    id,
  });
  expect(looked.found).toBe(false);
  expect([404, 410]).toContain(looked.status);
  return looked;
}
