import { describe, expect, it } from "vitest";
import { agentFetch, agentJson, loadAgentManifest } from "./agentClient";

describe("agent API", () => {
  it("answers health on the running desktop app", async () => {
    const agent = await loadAgentManifest();
    const { status, body } = await agentJson<{
      ok?: boolean;
      service?: string;
    }>(agent, "/agent/v1/health");
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("parascene-agent");
  });

  it("rejects calls without the bearer token", async () => {
    const agent = await loadAgentManifest();
    const res = await agentFetch(agent, "/agent/v1/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("lists wired actions", async () => {
    const agent = await loadAgentManifest();
    const { status, body } = await agentJson<{
      actions?: Array<{ id: string; status: string }>;
    }>(agent, "/agent/v1/actions");
    expect(status).toBe(200);
    const ids = (body.actions ?? []).map((row) => row.id);
    expect(ids).toContain("project.create");
    expect(ids).toContain("sync.start");
    expect(ids).toContain("library.clearLocal");
    expect(ids).toContain("project.delete");
    expect(ids).toContain("folder.delete");
    expect(ids).toContain("sync.folders");
    expect(ids).toContain("sync.thumbs");
    expect(ids).toContain("sync.media");
    expect(ids).toContain("generation.start");
    expect(ids).toContain("cloud.delete");
    expect(ids).toContain("library.lookup");
    expect(body.actions?.find((row) => row.id === "project.create")?.status).toBe(
      "wired",
    );
  });
});
