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
