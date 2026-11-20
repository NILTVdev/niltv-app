import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const html = (text: string, images?: Record<string, string>) => renderToStaticMarkup(<Markdown text={text} images={images} />);

describe("Markdown", () => {
  it("renders the GitHub basics", () => {
    const out = html("**bold** and ~~gone~~\n\n- [x] done\n\n| a |\n|---|\n| b |");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<del>gone</del>");
    expect(out).toContain('type="checkbox"');
    expect(out).toContain("<table>");
  });

  it("keeps a single line break", () => {
    expect(html("one\ntwo")).toContain("<br/>");
  });

  it("never renders raw HTML", () => {
    const out = html('<script>alert(1)</script><img src=x onerror="alert(1)">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
  });

  it("drops script links", () => {
    expect(html("[x](javascript:alert(1))")).not.toContain("javascript:");
    expect(html("![x](javascript:alert(1))")).not.toContain("javascript:");
  });

  it("opens links in a new tab without handing over the page", () => {
    const out = html("[site](https://niltv.com)");
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it("shows an uploaded image through its link", () => {
    expect(html("![shot](portal-image:img-1)", { "img-1": "https://s3.example/a" })).toContain('src="https://s3.example/a"');
  });

  it("shows nothing for an image it has no link for", () => {
    expect(html("![shot](portal-image:img-1)")).not.toContain("<img");
  });

  it("takes outside images", () => {
    expect(html("![x](https://niltv.com/a.png)")).toContain('src="https://niltv.com/a.png"');
  });
});
