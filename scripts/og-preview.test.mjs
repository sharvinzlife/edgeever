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

import { collectImageSrcs, resolveCoverSrc, resourceIdOf, toPublicImageUrl } from "./og-preview.mjs";

const A = "/api/v1/resources/res_aaa/blob";
const B = "/api/v1/resources/res_bbb/blob";
const doc = (srcs) => ({
  type: "doc",
  content: [{ type: "paragraph", content: srcs.map((src) => ({ type: "image", attrs: { src } })) }],
});

describe("collectImageSrcs", () => {
  test("returns image srcs in document order, including gallery items", () => {
    const d = {
      type: "doc",
      content: [
        { type: "image", attrs: { src: A } },
        { type: "edgeeverImageGallery", content: [{ type: "image", attrs: { src: B } }] },
      ],
    };
    expect(collectImageSrcs(d)).toEqual([A, B]);
  });

  test("ignores nodes without a src and non-objects", () => {
    expect(collectImageSrcs({ type: "doc", content: [{ type: "image", attrs: {} }, null] })).toEqual([]);
  });
});

describe("resourceIdOf", () => {
  test("extracts the resource id", () => expect(resourceIdOf(A)).toBe("res_aaa"));
  test("returns null for an external url", () => expect(resourceIdOf("https://cdn/x.jpg")).toBeNull());
});

describe("resolveCoverSrc", () => {
  test("defaults to the first image", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([A, B]) })).toBe(A);
  });

  test("a cover tag naming an id overrides the first image", () => {
    expect(resolveCoverSrc({ tags: ["prompts", "cover:res_bbb"], contentJson: doc([A, B]) })).toBe(B);
  });

  test("a cover tag naming a missing image falls back to the first image", () => {
    expect(resolveCoverSrc({ tags: ["cover:res_zzz"], contentJson: doc([A, B]) })).toBe(A);
  });

  test("no images returns null", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([]) })).toBeNull();
  });
});

describe("toPublicImageUrl", () => {
  test("maps an uploaded resource to the public share blob url", () => {
    expect(toPublicImageUrl(A, "tok", "https://notes.example")).toBe(
      "https://notes.example/api/public/shares/tok/resources/res_aaa/blob",
    );
  });

  test("uses an external url verbatim", () => {
    expect(toPublicImageUrl("https://cdn/x.jpg", "tok", "https://notes.example")).toBe("https://cdn/x.jpg");
  });

  test("null src yields null", () => expect(toPublicImageUrl(null, "tok", "https://notes.example")).toBeNull());
});

import { createSharePageRenderer } from "./og-preview.mjs";

const shell = "<html><head><title>EdgeEver</title></head><body><div id=root></div></body></html>";
const renderer = (share) => createSharePageRenderer({
  fetchShare: async () => share,
  readIndexHtml: async () => shell,
  describe: (s) => String(s?.contentMarkdown ?? "").slice(0, 150),
});

describe("createSharePageRenderer", () => {
  test("injects og tags for an unlocked share with an image", async () => {
    const html = await renderer({
      title: "T", contentMarkdown: "body text",
      contentJson: doc([A]), tags: [],
    })("tok", "https://notes.example/share/tok");
    expect(html).toContain('<meta property="og:title" content="T">');
    expect(html).toContain("og:image");
    expect(html).toContain("/api/public/shares/tok/resources/res_aaa/blob");
    expect(html.indexOf("<meta")).toBeGreaterThan(html.indexOf("<head>"));
  });

  test("returns null (plain shell) when the share is missing or locked", async () => {
    expect(await renderer(null)("tok", "https://notes.example/share/tok")).toBeNull();
  });

  test("emits no og:image when the note has no image", async () => {
    const html = await renderer({ title: "T", contentJson: doc([]), tags: [] })("tok", "https://notes.example/share/tok");
    expect(html).not.toContain("og:image");
  });
});
