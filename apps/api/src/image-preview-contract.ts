/**
 * The platform-neutral half of the `og:image` preview derivative.
 *
 * Deliberately free of Node built-ins: `apps/api` is bundled for BOTH the
 * Cloudflare Worker and the self-hosted Bun server, and the Worker has no
 * `node:child_process`. The libvips implementation lives in `image-preview.ts`,
 * which only `scripts/self-hosted-server.mjs` imports — the renderer reaches the
 * route as an injected runtime driver, the same way `storage` and
 * `publicNetworkFetch` do. Where no renderer is injected the route serves the
 * original bytes, which is exactly the pre-2026-09-23 behaviour.
 *
 * Why the derivative exists: a share whose cover was the 1,073,160-byte
 * 1440x1800 photo `/sd` attached previewed in WhatsApp with a title and
 * description but no image, while every cover under ~540 KB previewed fine.
 * WhatsApp is widely reported to drop `og:image` somewhere above ~600 KB,
 * undocumented. The original upload is never modified.
 */

export const PREVIEW_MAX_EDGE = 1200;
export const PREVIEW_TARGET_BYTES = 300 * 1024;
export const PREVIEW_FAILSAFE_BYTES = 600 * 1024;
export const PREVIEW_QUALITIES = [82, 70, 60] as const;

/** How many derivatives to keep. ~32 x 300 KB is roughly 10 MB of resident memory. */
export const PREVIEW_CACHE_LIMIT = 32;

export type PreviewLogger = { warn: (message: string) => void };

export type PreviewImage = {
  bytes: Uint8Array;
  width: number;
  height: number;
  quality: number;
};

/** A host-provided renderer. Returns null when no derivative could be made. */
export type PreviewRenderer = (source: Uint8Array, logger?: PreviewLogger) => Promise<PreviewImage | null>;

const previewCache = new Map<string, PreviewImage>();

// Keyed by resource id AND source size: resources are immutable per upload, but
// `PUT /api/v1/resources/:id/blob` can replace one, and a size change is enough
// to miss the stale entry.
export const previewCacheKey = (resourceId: string, byteSize: number) => `${resourceId}:${byteSize}`;

export const getCachedPreview = (key: string): PreviewImage | undefined => previewCache.get(key);

export function putCachedPreview(key: string, value: PreviewImage): void {
  // Re-insert so a re-read entry becomes the most recent.
  previewCache.delete(key);
  previewCache.set(key, value);
  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value;
    if (oldest === undefined) break;
    previewCache.delete(oldest);
  }
}

export const clearPreviewCache = (): void => previewCache.clear();
