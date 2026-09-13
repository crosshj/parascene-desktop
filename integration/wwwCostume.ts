import { expect } from "vitest";
import type { WwwCostumeSnapshot } from "../src/agent/inspectCreation";
import { invokeOk, type AgentManifest } from "./agentClient";
import type { CloudLookupResult } from "./cloudIdentity";

const PROJECT_WWW_LOCKDOWN = [
  "publish",
  "ungroup",
  "reorder",
  "set_cover",
  "remix",
  "carousel",
  "delete",
  "edit",
  "share",
  "challenge_submit",
  "challenge_assign",
] as const;

export type WwwLookupResult = CloudLookupResult & {
  view?: string;
  www?: WwwCostumeSnapshot;
};

export type WwwProjectCostumeOpts = {
  title?: string | RegExp;
  unpublished?: boolean;
  empty?: boolean;
  memberIds?: string[];
  absentMemberIds?: string[];
  coverId?: string;
  memberMedia?: Record<string, string>;
  requirePixels?: string[];
};

export async function lookupWww(
  agent: AgentManifest,
  id: string,
): Promise<WwwLookupResult> {
  return invokeOk<WwwLookupResult>(agent, "cloud.lookup", {
    id,
    view: "www",
  });
}

export async function expectWwwMissing(
  agent: AgentManifest,
  id: string,
): Promise<WwwLookupResult> {
  const looked = await lookupWww(agent, id);
  expect(looked.found).toBe(false);
  expect([404, 410]).toContain(looked.status);
  return looked;
}

/** Website GET of a project tile. Soft on undeployed costume keys. */
export async function expectWwwProjectCostume(
  agent: AgentManifest,
  id: string,
  opts: WwwProjectCostumeOpts = {},
): Promise<WwwCostumeSnapshot> {
  const looked = await lookupWww(agent, id);
  expect(
    looked.found,
    `www lookup ${id} missing (${looked.status ?? "?"} ${looked.error ?? ""})`,
  ).toBe(true);
  expect(looked.view).toBe("www");
  const www = looked.www;
  expect(www, "cloud.lookup view=www should return a www snapshot").toBeTruthy();
  if (!www) throw new Error("missing www snapshot");
  expect(www.id).toBe(id);
  if (opts.title != null) {
    if (opts.title instanceof RegExp) expect(www.title).toMatch(opts.title);
    else expect(www.title).toBe(opts.title);
  }
  if (opts.unpublished !== false) expect(www.published).toBe(false);
  if (www.costumeApplied) {
    expect(www.rawItemsLeaked).toBe(false);
    expect(www.groupKind).toBe("group_creations");
    if (www.badge) expect(www.badge).toBe("project");
    if (www.creationType) expect(www.creationType).toBe("project");
  }
  if (www.supported) {
    for (const key of PROJECT_WWW_LOCKDOWN) {
      if (key in www.supported) {
        expect(www.supported[key], `supported.${key}`).toBe(false);
      }
    }
  }
  if (opts.empty) expect(www.members).toEqual([]);
  const memberIds = www.members.map((member) => member.id);
  for (const memberId of opts.memberIds ?? []) {
    expect(memberIds, `www costume missing member ${memberId}`).toContain(
      memberId,
    );
  }
  for (const memberId of opts.absentMemberIds ?? []) {
    expect(memberIds).not.toContain(memberId);
  }
  if (opts.coverId && www.coverSourceId) {
    expect(www.coverSourceId).toBe(opts.coverId);
  }
  for (const [memberId, mediaType] of Object.entries(opts.memberMedia ?? {})) {
    const member = www.members.find((row) => row.id === memberId);
    expect(member, `www costume missing ${memberId}`).toBeTruthy();
    if (member?.mediaType) expect(member.mediaType).toBe(mediaType);
  }
  for (const memberId of opts.requirePixels ?? []) {
    const member = www.members.find((row) => row.id === memberId);
    expect(member, `www costume missing ${memberId}`).toBeTruthy();
    if (member?.filePath != null) {
      expect(member.filePath.length).toBeGreaterThan(0);
    }
  }
  return www;
}
