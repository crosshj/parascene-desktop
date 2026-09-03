import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AutosizeTextarea } from "./AutosizeTextarea";

describe("AutosizeTextarea", () => {
  it("mirrors value onto the replica and keeps a 3-row minimum", () => {
    const { rerender } = render(
      <AutosizeTextarea aria-label="Prompt" value="short" onChange={() => {}} />,
    );
    const area = screen.getByRole("textbox", { name: "Prompt" });
    const wrap = area.parentElement;
    expect(wrap).toHaveClass("autosize-textarea");
    expect(wrap).toHaveAttribute("data-autosize", "short");
    expect(area).toHaveAttribute("rows", "3");

    const long = "line\n".repeat(8);
    rerender(
      <AutosizeTextarea aria-label="Prompt" value={long} onChange={() => {}} />,
    );
    expect(area.parentElement).toHaveAttribute("data-autosize", long);
  });
});
