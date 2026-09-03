import { describe, expect, it } from "vitest";
import type { ReplicateInputField } from "../replicate/replicateClient";
import {
  enumGroupsFromColonLabels,
  isPromptLikeField,
  promptSchemaField,
} from "./schemaForm";

function stringField(
  overrides: Partial<ReplicateInputField> & Pick<ReplicateInputField, "name">,
): ReplicateInputField {
  return {
    title: overrides.name,
    typeName: "string",
    required: false,
    fileLike: false,
    arrayItemFileLike: false,
    ...overrides,
  };
}

describe("enumGroupsFromColonLabels", () => {
  it("groups Blue checkpoints by prefix in first-seen order", () => {
    expect(
      enumGroupsFromColonLabels([
        { id: "a", label: "flux: flux1-dev" },
        { id: "b", label: "sd15: cyberrealistic_v20" },
        { id: "c", label: "flux: getphatFLUXReality_v10FP8" },
      ]),
    ).toEqual([
      { label: "flux", values: ["a", "c"] },
      { label: "sd15", values: ["b"] },
    ]);
  });

  it("stays flat when every option shares one prefix", () => {
    expect(
      enumGroupsFromColonLabels([
        { id: "a", label: "flux: flux1-dev" },
        { id: "b", label: "flux: other" },
      ]),
    ).toBeUndefined();
  });
});

describe("isPromptLikeField", () => {
  it("treats prompt-named strings as prompt-like", () => {
    expect(isPromptLikeField(promptSchemaField())).toBe(true);
    expect(isPromptLikeField(stringField({ name: "negative_prompt" }))).toBe(
      true,
    );
  });

  it("treats long-description strings as prompt-like", () => {
    expect(
      isPromptLikeField(
        stringField({
          name: "notes",
          description: "x".repeat(81),
        }),
      ),
    ).toBe(true);
  });

  it("leaves short named strings and enums as single-line", () => {
    expect(isPromptLikeField(stringField({ name: "seed" }))).toBe(false);
    expect(
      isPromptLikeField(
        stringField({ name: "prompt", enumValues: ["a", "b"] }),
      ),
    ).toBe(false);
  });
});
