import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Wordmark } from "./Wordmark";
import { ParasceneWordmark } from "./svgs";

describe("brand SVGs", () => {
  it("stores the Parascene wordmark with the lockup viewBox", () => {
    const { container } = render(<ParasceneWordmark />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveAttribute("viewBox", "0 0 185 40");
    expect(svg?.querySelectorAll("path")).toHaveLength(3);
  });

  it("renders the wordmark as the Parascene label", () => {
    render(<Wordmark />);
    expect(screen.getByLabelText("Parascene")).toBeInTheDocument();
    expect(screen.getByLabelText("Parascene").querySelector("svg")).toBeTruthy();
  });

});
