import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const HELP_JS = readFileSync(join(process.cwd(), "public/help/help.js"), "utf8");

function mountHelp(html: string): void {
  document.body.innerHTML = html;
  window.eval(HELP_JS);
}

afterEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
});

describe("help lightbox", () => {
  it("opens a figure image, steps with arrows, and closes on Escape or backdrop", () => {
    mountHelp(`
      <main>
        <figure>
          <img src="one.png" alt="First still" />
          <figcaption>First caption</figcaption>
        </figure>
        <figure>
          <img src="two.png" alt="Second still" />
          <figcaption>Second caption</figcaption>
        </figure>
      </main>
    `);

    const first = document.querySelector('img[alt="First still"]') as HTMLImageElement;
    first.click();

    const root = document.querySelector(".help-lightbox") as HTMLElement;
    const shown = document.querySelector(".help-lightbox-img") as HTMLImageElement;
    expect(root.classList.contains("is-open")).toBe(true);
    expect(root.hidden).toBe(false);
    expect(shown.src).toContain("one.png");
    expect(document.querySelector(".help-lightbox-caption")?.textContent).toBe(
      "First caption",
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight" }));
    expect(shown.src).toContain("two.png");
    expect(document.querySelector(".help-lightbox-caption")?.textContent).toBe(
      "Second caption",
    );

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(root.hidden).toBe(true);
    expect(root.classList.contains("is-open")).toBe(false);

    first.click();
    root.click();
    expect(root.hidden).toBe(true);
  });

  it("does not require each help page to implement a lightbox", () => {
    const pages = [
      "generate.html",
      "audio.html",
      "image-models.html",
      "video-models.html",
      "getting-started.html",
      "settings.html",
    ];
    for (const page of pages) {
      const html = readFileSync(join(process.cwd(), "public/help", page), "utf8");
      expect(html, page).toContain('src="help.js"');
      expect(html, page).not.toContain("help-lightbox");
    }
  });
});
