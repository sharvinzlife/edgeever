import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_FAILSAFE_BYTES,
  PREVIEW_MAX_EDGE,
  PREVIEW_TARGET_BYTES,
  clearPreviewCache,
  getCachedPreview,
  previewCacheKey,
  putCachedPreview,
} from "./image-preview-contract.ts";
import { renderPreview } from "./image-preview.ts";

// The preview derivative is produced by the libvips CLI, which the runtime image
// installs (apk vips-tools). These tests exercise the real binary rather than a
// stub: the whole point is that a >600 KB photo comes out small and baseline.
// A missing vips is a hard failure, not a skip — the feature cannot work without
// it, and a silently-skipped suite is how a broken preview ships.
const hasVips = spawnSync("vips", ["--version"], { encoding: "utf8" }).status === 0;
if (!hasVips) {
  throw new Error(
    "vips is not installed. The preview derivative needs libvips: `brew install vips` locally, " +
      "or `apk add vips-tools` in the runtime image.",
  );
}

const vips = (args) => {
  const result = spawnSync("vips", args, { encoding: "buffer" });
  if (result.status !== 0) {
    throw new Error(`vips ${args.join(" ")} failed: ${result.stderr?.toString() ?? ""}`);
  }
  return result.stdout;
};

const vipsheader = (field, path) => {
  const result = spawnSync("vipsheader", ["-f", field, path], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`vipsheader -f ${field} ${path} failed: ${result.stderr ?? ""}`);
  }
  return Number(result.stdout.trim());
};

const readDims = (path) => ({
  width: vipsheader("width", path),
  height: vipsheader("height", path),
});

let scratch;
const workDir = () => {
  if (!scratch) {
    scratch = mkdtempSync(join(tmpdir(), "edgeever-preview-"));
    process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
  }
  return scratch;
};

/**
 * A big, photo-like progressive JPEG: `gaussnoise` at sigma 20 over 1440x1800
 * compresses to ~1.53 MB at Q95, which is the shape of the real failing share
 * (a 1.07 MB Instagram photo) and large enough that Q82 misses the 300 KB target
 * (316,610 bytes) and only Q70 reaches it (213,549) — so the ladder is genuinely
 * exercised. The seed makes the fixture byte-identical on every run.
 */
const bigProgressiveJpeg = () => {
  const dir = workDir();
  const base = join(dir, `big-${Math.random().toString(36).slice(2)}`);
  const raw = `${base}.v`;
  const out = `${base}.jpg`;
  vips(["gaussnoise", raw, "1440", "1800", "--sigma", "20", "--seed", "42"]);
  vips(["jpegsave", raw, out, "--Q", "95", "--interlace"]);
  return out;
};

const smallJpeg = (width = 400, height = 300) => {
  const dir = workDir();
  const base = join(dir, `small-${Math.random().toString(36).slice(2)}`);
  const raw = `${base}.v`;
  const out = `${base}.jpg`;
  vips(["gaussnoise", raw, String(width), String(height), "--sigma", "8", "--seed", "7"]);
  vips(["jpegsave", raw, out, "--Q", "80"]);
  return out;
};

const bytesOf = (path) => new Uint8Array(readFileSync(path));

/** "baseline" or "progressive" as the JPEG SOF marker reports it. */
const scanType = (bytes) => {
  const dir = workDir();
  const path = join(dir, `scan-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(path, bytes);
  return spawnSync("file", ["-b", path], { encoding: "utf8" }).stdout.includes("progressive")
    ? "progressive"
    : "baseline";
};

const dimsOf = (bytes) => {
  const dir = workDir();
  const path = join(dir, `dims-${Math.random().toString(36).slice(2)}.jpg`);
  writeFileSync(path, bytes);
  return readDims(path);
};

describe("renderPreview", () => {
  test("a >600 KB 1440x1800 JPEG becomes a <=300 KB baseline preview with long edge <=1200", async () => {
    const source = bytesOf(bigProgressiveJpeg());
    expect(source.byteLength).toBeGreaterThan(PREVIEW_FAILSAFE_BYTES);

    const preview = await renderPreview(source);
    expect(preview).not.toBeNull();
    expect(preview.bytes.byteLength).toBeLessThanOrEqual(PREVIEW_TARGET_BYTES);
    expect(preview.bytes.byteLength).toBeLessThan(source.byteLength);

    const dims = dimsOf(preview.bytes);
    expect(Math.max(dims.width, dims.height)).toBeLessThanOrEqual(PREVIEW_MAX_EDGE);
    // 1440x1800 is 4:5, so the long edge is the height.
    expect(dims.height).toBe(PREVIEW_MAX_EDGE);
    expect(dims.width).toBe(960);

    expect(scanType(preview.bytes)).toBe("baseline");
    expect(preview.quality).toBeLessThan(82); // Q82 missed the target, so the ladder stepped down
  });

  test("a small image stays under the cap and is not upscaled", async () => {
    const preview = await renderPreview(bytesOf(smallJpeg(400, 300)));
    expect(preview).not.toBeNull();
    expect(preview.bytes.byteLength).toBeLessThanOrEqual(PREVIEW_TARGET_BYTES);

    const dims = dimsOf(preview.bytes);
    expect(dims.width).toBe(400);
    expect(dims.height).toBe(300);
  });

  test("alpha is flattened onto white, not black", async () => {
    const dir = workDir();
    const raw = join(dir, `alpha-${Math.random().toString(36).slice(2)}.v`);
    const png = `${raw}.png`;
    vips(["black", raw, "200", "200", "--bands", "4"]);
    vips(["pngsave", raw, png]);

    const preview = await renderPreview(bytesOf(png));
    expect(preview).not.toBeNull();

    const out = join(dir, `alpha-out-${Math.random().toString(36).slice(2)}.jpg`);
    writeFileSync(out, preview.bytes);
    const corner = vips(["getpoint", out, "0", "0"]).toString().trim();
    expect(corner).toBe("255 255 255");
  });

  test("undecodable input returns null and logs, never a broken image", async () => {
    const logged = [];
    const preview = await renderPreview(new TextEncoder().encode("this is not an image"), {
      warn: (message) => logged.push(message),
    });

    expect(preview).toBeNull();
    expect(logged.length).toBeGreaterThan(0);
    expect(logged.join(" ")).toContain("preview");
  });
});

describe("preview cache", () => {
  test("keys on resource id and source size, so a replaced upload misses", () => {
    expect(previewCacheKey("res_1", 100)).toBe("res_1:100");
    expect(previewCacheKey("res_1", 100)).not.toBe(previewCacheKey("res_1", 101));
    expect(previewCacheKey("res_1", 100)).not.toBe(previewCacheKey("res_2", 100));
  });

  test("stores and returns a derivative", () => {
    clearPreviewCache();
    const key = previewCacheKey("res_cache", 42);
    expect(getCachedPreview(key)).toBeUndefined();

    putCachedPreview(key, { bytes: new Uint8Array([1, 2, 3]), width: 1, height: 1, quality: 82 });
    expect(getCachedPreview(key)?.bytes.byteLength).toBe(3);
  });

  test("is bounded, evicting the oldest entries", () => {
    clearPreviewCache();
    for (let i = 0; i < 200; i += 1) {
      putCachedPreview(previewCacheKey(`res_${i}`, i), {
        bytes: new Uint8Array([i]),
        width: 1,
        height: 1,
        quality: 82,
      });
    }
    // The earliest keys must have been evicted; the newest must remain.
    expect(getCachedPreview(previewCacheKey("res_0", 0))).toBeUndefined();
    expect(getCachedPreview(previewCacheKey("res_199", 199))).not.toBeUndefined();
  });
});
