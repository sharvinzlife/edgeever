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

import { collectImageSrcs, describeShare, resolveCoverSrc, resourceIdOf, toPublicImageUrl } from "./og-preview.mjs";

const A = "/api/v1/resources/res_aaa/blob";
const B = "/api/v1/resources/res_bbb/blob";
const SVG = "https://deploy.example.com/button.svg";
const CF = "https://deploy.workers.cloudflare.com/button";
const BADGE = "https://img.shields.io/github/stars/tianma-if/edgeever?style=social";
const PNG = "https://cdn.example.com/cover.png";
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

describe("resolveCoverSrc raster preference", () => {
  test("skips an svg when a raster image is also present", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([SVG, A]) })).toBe(A);
  });

  test("skips an svg carrying a query string", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([`${SVG}?v=2`, A]) })).toBe(A);
  });

  test("falls back to the svg when it is the only image", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([SVG]) })).toBe(SVG);
  });

  test("an explicit cover tag naming the svg still wins", () => {
    expect(resolveCoverSrc({ tags: ["cover:res_bbb"], contentJson: doc([SVG, B]) })).toBe(B);
  });
});

describe("resolveCoverSrc renderable preference", () => {
  test("skips a shields.io badge that serves svg from an extension-less url", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([BADGE, A]) })).toBe(A);
  });

  test("skips the extension-less cloudflare deploy button", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([CF, A]) })).toBe(A);
  });

  test("skips an extension-less badge in favour of a later external raster", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([BADGE, PNG]) })).toBe(PNG);
  });

  test("keeps document order among renderable images", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([PNG, A]) })).toBe(PNG);
  });

  test("falls back to the first image when no image has a renderable type", () => {
    expect(resolveCoverSrc({ tags: [], contentJson: doc([BADGE, CF, SVG]) })).toBe(BADGE);
  });

  test("an explicit cover tag naming an extension-less badge still wins", () => {
    expect(resolveCoverSrc({ tags: ["cover:res_bbb"], contentJson: doc([BADGE, B]) })).toBe(B);
  });
});

describe("resolveCoverSrc video poster tag", () => {
  // A video note: /sd writes the video as an edgeeverFileAttachment link, so
  // there is no `image` node — only the poster the bot uploaded beside it,
  // named by a `cover:` tag.
  const videoDoc = {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "edgeeverFileAttachment",
            attrs: { url: "/api/v1/resources/res_clip/blob", mimeType: "video/mp4" },
          },
        ],
      },
    ],
  };
  const POSTER = "/api/v1/resources/res_poster/blob";

  test("a cover tag naming a poster the note does not embed is used", () => {
    expect(resolveCoverSrc({ tags: ["instagram", "cover:res_poster"], contentJson: videoDoc })).toBe(POSTER);
  });

  test("a cover tag holding the whole poster src is used too", () => {
    expect(resolveCoverSrc({ tags: [`cover:${POSTER}`], contentJson: videoDoc })).toBe(POSTER);
  });

  test("a video note with no cover tag still has no cover", () => {
    expect(resolveCoverSrc({ tags: ["instagram"], contentJson: videoDoc })).toBeNull();
  });

  test("a cover tag naming something that is not a resource is not invented", () => {
    expect(resolveCoverSrc({ tags: ["cover:https://cdn/x.jpg"], contentJson: videoDoc })).toBeNull();
  });

  test("with an image present, an absent-resource cover tag still falls back to it", () => {
    // The older behaviour is deliberately kept: a stale poster tag must not
    // beat an image the note actually shows.
    expect(resolveCoverSrc({ tags: ["cover:res_zzz"], contentJson: doc([A, B]) })).toBe(A);
  });

  test("a poster tag is not used when the note has any image", () => {
    expect(resolveCoverSrc({ tags: ["cover:res_poster"], contentJson: doc([A]) })).toBe(A);
  });
});

describe("describeShare", () => {
  test("keeps underscores so identifiers stay intact", () => {
    expect(describeShare({ contentMarkdown: "see res_530dc5f2 for details" }))
      .toBe("see res_530dc5f2 for details");
  });

  test("replaces an image with nothing and keeps link text", () => {
    expect(describeShare({ contentMarkdown: "![shot](https://x/a.png) read [the docs](https://x/d) now" }))
      .toBe("read the docs now");
  });

  test("strips heading, emphasis, and quote markers", () => {
    expect(describeShare({ contentMarkdown: "# Title\n\n> quoted *bold* `code`" }))
      .toBe("Title quoted bold code");
  });

  test("collapses whitespace, trims, and caps the length", () => {
    expect(describeShare({ contentMarkdown: "  a\n\n   b  " })).toBe("a b");
    expect(describeShare({ contentMarkdown: "x".repeat(400) }).length).toBe(150);
  });

  test("a non-string contentMarkdown yields an empty string", () => {
    expect(describeShare({})).toBe("");
    expect(describeShare(null)).toBe("");
  });
});

describe("toPublicImageUrl", () => {
  test("maps an uploaded resource to the public share preview url", () => {
    expect(toPublicImageUrl(A, "tok", "https://notes.example")).toBe(
      "https://notes.example/api/public/shares/tok/resources/res_aaa/preview",
    );
  });

  test("never points at the full-size blob, which WhatsApp may refuse to render", () => {
    const url = toPublicImageUrl(A, "tok", "https://notes.example");
    expect(url).not.toContain("/blob");
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
    expect(html).toContain("/api/public/shares/tok/resources/res_aaa/preview");
    expect(html).not.toContain("/resources/res_aaa/blob");
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

describe("createSharePageRenderer failure isolation", () => {
  test("resolves to null when readIndexHtml throws", async () => {
    const broken = createSharePageRenderer({
      fetchShare: async () => ({ title: "T", contentJson: doc([A]), tags: [] }),
      readIndexHtml: async () => { throw new Error("index.html is missing"); },
      describe: () => "text",
    });
    expect(await broken("tok", "https://notes.example/share/tok")).toBeNull();
  });
});

// The whole point of the video poster path, end to end through the renderer:
// a note whose only media is a video has no image node, so its og:image can
// come from nothing but the cover tag the bot wrote.
describe("createSharePageRenderer with a video cover", () => {
  const shellHtml = "<html><head><title>EdgeEver</title></head><body><div id=root></div></body></html>";
  const videoShare = (tags) => ({
    title: "Ab Circuit",
    contentMarkdown: "> **TL;DR** A home ab circuit.",
    contentJson: {
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{
          type: "edgeeverFileAttachment",
          attrs: { url: "/api/v1/resources/res_clip/blob", mimeType: "video/mp4" },
        }],
      }],
    },
    tags,
  });
  const render = (share) => createSharePageRenderer({
    fetchShare: async () => share,
    readIndexHtml: async () => shellHtml,
    describe: describeShare,
  })("tok", "https://notes.example/share/tok");

  test("previews a video note with the poster the bot uploaded", async () => {
    const html = await render(videoShare(["workout", "instagram", "cover:res_poster"]));
    expect(html).toContain(
      '<meta property="og:image" content="https://notes.example/api/public/shares/tok/resources/res_poster/preview">',
    );
    expect(html).toContain('<meta property="og:title" content="Ab Circuit">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  test("still previews with no picture when the video has no cover tag", async () => {
    const html = await render(videoShare(["workout", "instagram"]));
    expect(html).not.toContain("og:image");
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });
});
