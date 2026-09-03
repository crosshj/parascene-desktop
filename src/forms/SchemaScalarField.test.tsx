import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ReplicateInputField } from "../replicate/replicateClient";
import { promptSchemaField } from "./schemaForm";
import { SchemaScalarField } from "./SchemaScalarField";

const modelField: ReplicateInputField = {
  name: "model",
  title: "Model",
  typeName: "string",
  required: true,
  enumValues: ["grok", "flux1", "sd15"],
  enumLabels: {
    grok: "X.ai Grok Imagine Image",
    flux1: "flux: flux1-dev",
    sd15: "sd15: cyberrealistic_v20",
  },
  enumGroups: [
    { label: "Replicate (3 credits)", values: ["grok"] },
    { label: "Blue (0.1 credits)", values: ["flux1", "sd15"] },
  ],
  fileLike: false,
  arrayItemFileLike: false,
};

describe("SchemaScalarField enum groups", () => {
  it("renders model options in server-order optgroups", () => {
    render(
      <SchemaScalarField
        field={modelField}
        values={{ model: "grok" }}
        onChange={() => {}}
        showFieldChrome={false}
      />,
    );
    const select = screen.getByRole("combobox", { name: "Model" });
    const groups = select.querySelectorAll("optgroup");
    expect([...groups].map((g) => g.label)).toEqual([
      "Replicate (3 credits)",
      "Blue (0.1 credits)",
    ]);
    expect(
      [...groups[1]!.querySelectorAll("option")].map((o) => o.value),
    ).toEqual(["flux1", "sd15"]);
  });
});

describe("SchemaScalarField prompt fields", () => {
  it("renders prompt-like strings as autosizing textareas", () => {
    render(
      <SchemaScalarField
        field={promptSchemaField("prompt", { description: "" })}
        values={{ prompt: "a cat on a roof" }}
        onChange={() => {}}
        showFieldChrome={false}
      />,
    );
    const area = screen.getByRole("textbox", { name: "Prompt" });
    expect(area.tagName).toBe("TEXTAREA");
    expect(area).toHaveClass("is-auto-size");
    expect(area).toHaveAttribute("rows", "3");
    expect(area.parentElement).toHaveClass("autosize-textarea");
  });
});
