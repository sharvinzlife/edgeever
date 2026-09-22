// scripts/og-preview.test.mjs
import { describe, expect, test } from "bun:test";
import { buildMetaBlock, escapeHtmlAttribute } from "./og-preview.mjs";

describe("escapeHtmlAttribute", () => {
  test("escapes the five attribute-critical characters", () => {
    expect(escapeHtmlAttribute(`a&b<c>d"e'f`)).toBe("a&amp;b&lt;c&gt;d&quot;e&#39;f");
  });

  test("stringifies null/undefined without throwing", () => {
    expect(escapeHtmlAttribute(null)).toBe("");
    expect(escapeHtmlAttribute(undefined)).toBe("");
  });
});

describe("buildMetaBlock", () => {
  const base = { title: "Hello", description: "World", imageUrl: "https://x/i.jpg", shareUrl: "https://x/s/t" };

  test("emits og title/description/image and a large twitter card when an image exists", () => {
    const html = buildMetaBlock(base);
    expect(html).toContain('<meta property="og:title" content="Hello">');
    expect(html).toContain('<meta property="og:description" content="World">');
    expect(html).toContain('<meta property="og:image" content="https://x/i.jpg">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  test("omits og:image and downgrades the card when there is no image", () => {
    const html = buildMetaBlock({ ...base, imageUrl: null });
    expect(html).not.toContain("og:image");
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  test("escapes a title containing markup", () => {
    const html = buildMetaBlock({ ...base, title: `<img src=x onerror=alert(1)>` });
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
