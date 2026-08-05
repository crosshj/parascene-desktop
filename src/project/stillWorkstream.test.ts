import { describe, expect, it } from "vitest";
import {
  appendWorkstreamEditNode,
  compositionInternalCreationIds,
  createComposition,
  createPlateWorkstream,
  defaultPlateRecipe,
  discardWorkstreamNode,
  discardInterimWorkstreamNodes,
  promoteWorkstreamNode,
  selectWorkstreamNode,
  selectWorkstreamPlate,
} from "./stillWorkstream";

const recipe = defaultPlateRecipe();

describe("stillWorkstream", () => {
  it("creates a composition sandbox without promoting assets", () => {
    const stream = createComposition({
      memberIds: ["a", "b"],
      recipe,
    });
    expect(stream.kind).toBe("plate");
    expect(stream.nodes).toHaveLength(0);
    expect(stream.selectedNodeId).toBeNull();
    expect(stream.memberIds).toEqual(["a", "b"]);
  });

  it("creates a plate stream with selected bake node kept inside", () => {
    const stream = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    expect(stream.kind).toBe("plate");
    expect(stream.nodes).toHaveLength(1);
    expect(stream.nodes[0]?.creationId).toBe("bake1");
    expect(stream.nodes[0]?.showOutside).toBe(false);
    expect(stream.nodes[0]?.status).toBe("selected");
    expect(stream.selectedNodeId).toBe(stream.nodes[0]?.id);
    expect(compositionInternalCreationIds([stream]).has("bake1")).toBe(true);
  });

  it("appends an edit and selects it", () => {
    const base = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    const parentId = base.nodes[0]!.id;
    const next = appendWorkstreamEditNode(base, {
      creationId: "edit1",
      parentNodeId: parentId,
      prompt: "fill gap",
      model: "owner/model",
    });
    expect(next.nodes).toHaveLength(2);
    expect(next.nodes[0]?.status).toBe("candidate");
    expect(next.nodes[1]?.status).toBe("selected");
    expect(next.nodes[1]?.showOutside).toBe(false);
    expect(next.selectedNodeId).toBe(next.nodes[1]?.id);
  });

  it("promotes a node out of the composition sandbox", () => {
    const stream = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    const promoted = promoteWorkstreamNode(stream, stream.nodes[0]!.id);
    expect(promoted.nodes[0]?.showOutside).toBe(true);
    expect(compositionInternalCreationIds([promoted]).has("bake1")).toBe(
      false,
    );
  });

  it("discards interim files but keeps provenance", () => {
    let stream = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    stream = appendWorkstreamEditNode(stream, {
      creationId: "edit1",
      parentNodeId: stream.nodes[0]!.id,
      prompt: "try 1",
    });
    stream = appendWorkstreamEditNode(stream, {
      creationId: "edit2",
      parentNodeId: stream.nodes[1]!.id,
      prompt: "try 2",
    });
    const { stream: cleaned, creationIdsToDelete } =
      discardInterimWorkstreamNodes(stream);
    expect(creationIdsToDelete).toEqual(["bake1", "edit1"]);
    expect(cleaned.nodes.filter((n) => n.status === "discarded")).toHaveLength(
      2,
    );
    expect(
      cleaned.nodes.find((n) => n.status === "selected")?.creationId,
    ).toBe("edit2");
  });

  it("can reselect an earlier candidate", () => {
    let stream = createPlateWorkstream({
      memberIds: ["a"],
      recipe: { ...recipe, resolution: 1024 },
      firstCreationId: "bake1",
    });
    const firstId = stream.nodes[0]!.id;
    stream = appendWorkstreamEditNode(stream, {
      creationId: "edit1",
      parentNodeId: firstId,
    });
    stream = selectWorkstreamNode(stream, firstId);
    expect(stream.selectedNodeId).toBe(firstId);
    expect(stream.nodes[0]?.status).toBe("selected");
    expect(stream.nodes[1]?.status).toBe("candidate");
  });

  it("can select the live plate as the edit base", () => {
    const stream = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    const next = selectWorkstreamPlate(stream);
    expect(next.selectedNodeId).toBeNull();
    expect(next.nodes[0]?.status).toBe("candidate");
  });

  it("deletes a selected run and falls back to its parent", () => {
    let stream = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    const firstId = stream.nodes[0]!.id;
    stream = appendWorkstreamEditNode(stream, {
      creationId: "edit1",
      parentNodeId: firstId,
    });
    const editId = stream.selectedNodeId!;
    const result = discardWorkstreamNode(stream, editId);
    expect(result.creationIdToDelete).toBe("edit1");
    expect(result.stream.selectedNodeId).toBe(firstId);
    expect(result.stream.nodes[0]?.status).toBe("selected");
    expect(result.stream.nodes[1]?.status).toBe("discarded");
    expect(result.stream.nodes[1]?.creationId).toBeNull();
  });

  it("allows legacy promoted runs to be discarded after the caller preserves a copy", () => {
    let stream = createPlateWorkstream({
      memberIds: ["a", "b"],
      recipe,
      firstCreationId: "bake1",
    });
    stream = promoteWorkstreamNode(stream, stream.selectedNodeId!);
    const result = discardWorkstreamNode(stream, stream.selectedNodeId!);
    expect(result.creationIdToDelete).toBe("bake1");
    expect(result.stream.selectedNodeId).toBeNull();
    expect(result.stream.nodes[0]?.status).toBe("discarded");
  });
});
