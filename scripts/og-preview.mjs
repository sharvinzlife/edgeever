// scripts/og-preview.mjs

/** Escape a value for safe interpolation inside a double-quoted HTML attribute. */
export const escapeHtmlAttribute = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/** Build the Open Graph / Twitter meta block for a share page. */
export const buildMetaBlock = ({ title, description, imageUrl, shareUrl }) => {
  const tags = [
    '<meta property="og:type" content="article">',
    `<meta property="og:title" content="${escapeHtmlAttribute(title)}">`,
    `<meta name="twitter:title" content="${escapeHtmlAttribute(title)}">`,
  ];
  if (description) {
    tags.push(`<meta property="og:description" content="${escapeHtmlAttribute(description)}">`);
    tags.push(`<meta name="twitter:description" content="${escapeHtmlAttribute(description)}">`);
  }
  if (shareUrl) {
    tags.push(`<meta property="og:url" content="${escapeHtmlAttribute(shareUrl)}">`);
  }
  if (imageUrl) {
    tags.push(`<meta property="og:image" content="${escapeHtmlAttribute(imageUrl)}">`);
    tags.push('<meta name="twitter:card" content="summary_large_image">');
    tags.push(`<meta name="twitter:image" content="${escapeHtmlAttribute(imageUrl)}">`);
  } else {
    tags.push('<meta name="twitter:card" content="summary">');
  }
  return tags.join("\n");
};

const RESOURCE_SRC = /^\/api\/v1\/resources\/([^/]+)\/blob\/?$/;
const SVG_SRC = /\.svg(?:[?#]|$)/i;

/** The resource id from an uploaded-image src, or null for external URLs. */
export const resourceIdOf = (src) => {
  const match = RESOURCE_SRC.exec(String(src ?? ""));
  return match ? match[1] : null;
};

/** attrs.src of every image node (incl. gallery items), in document order. */
export const collectImageSrcs = (doc) => {
  const srcs = [];
  const seen = new Set();
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    const current = /** @type {Record<string, unknown>} */ (node);
    const src = current.attrs && typeof current.attrs === "object"
      ? /** @type {Record<string, unknown>} */ (current.attrs).src
      : undefined;
    if (current.type === "image" && typeof src === "string" && src.trim()) {
      if (!seen.has(src)) { seen.add(src); srcs.push(src); }
    }
    if (Array.isArray(current.content)) current.content.forEach(walk);
  };
  walk(doc);
  return srcs;
};

/**
 * The default cover: the first image a crawler can actually render. Social
 * crawlers do not render SVG, so a note whose first image is an SVG badge is
 * better served by a later raster image. If every image is an SVG, keep the
 * first — nothing better exists.
 */
const defaultCoverSrc = (images) =>
  images.find((src) => !SVG_SRC.test(src)) ?? images[0] ?? null;

/** The cover src for a share: a `cover:` tag naming a present image, else the default cover. */
export const resolveCoverSrc = (share) => {
  const images = collectImageSrcs(share?.contentJson);
  const marker = (Array.isArray(share?.tags) ? share.tags : [])
    .find((tag) => typeof tag === "string" && tag.toLowerCase().startsWith("cover:"));
  if (marker) {
    const wanted = marker.slice(marker.indexOf(":") + 1).trim();
    const hit = images.find((src) => src === wanted || resourceIdOf(src) === wanted);
    if (hit) return hit;
  }
  return defaultCoverSrc(images);
};

/** Map a note image src to a URL a crawler can fetch without auth. */
export const toPublicImageUrl = (src, token, baseUrl) => {
  if (!src) return null;
  const id = resourceIdOf(src);
  const path = id
    ? `/api/public/shares/${encodeURIComponent(token)}/resources/${encodeURIComponent(id)}/blob`
    : src;
  if (/^https?:\/\//i.test(path)) return path;
  return `${String(baseUrl).replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
};

/**
 * A short plain-text summary of a share's markdown for og:description.
 * Underscores are left intact: they are far more common inside the resource
 * ids the app writes (`res_530dc5f2…`) than as emphasis markers, and blanking
 * them mangles the text a reader actually sees.
 */
export const describeShare = (share) => {
  const markdown = typeof share?.contentMarkdown === "string" ? share.contentMarkdown : "";
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*#>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 150);
};

/** Inject a meta block immediately before the closing </head>. */
export const injectMeta = (indexHtml, metaBlock) =>
  indexHtml.includes("</head>")
    ? indexHtml.replace("</head>", `${metaBlock}\n</head>`)
    : `${metaBlock}\n${indexHtml}`;

/**
 * Build a share-page renderer. Dependencies are injected so this is testable
 * without a running server.
 */
export const createSharePageRenderer = ({ fetchShare, readIndexHtml, describe }) =>
  async (token, shareUrl) => {
    try {
      const share = await fetchShare(token);
      if (!share) return null;
      const coverSrc = resolveCoverSrc(share);
      const meta = buildMetaBlock({
        title: share.title || "EdgeEver",
        description: describe(share),
        imageUrl: toPublicImageUrl(coverSrc, token, new URL(shareUrl).origin),
        shareUrl,
      });
      return injectMeta(await readIndexHtml(), meta);
    } catch {
      return null; // never let a preview failure break the page
    }
  };
