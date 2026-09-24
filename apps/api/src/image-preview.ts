import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PREVIEW_FAILSAFE_BYTES,
  PREVIEW_MAX_EDGE,
  PREVIEW_QUALITIES,
  PREVIEW_TARGET_BYTES,
  type PreviewImage,
  type PreviewLogger,
} from "./image-preview-contract";

/**
 * The libvips implementation of the preview derivative.
 *
 * Node-only, and imported ONLY by `scripts/self-hosted-server.mjs` — never by
 * anything in the Cloudflare Worker's module graph. The route reaches it as an
 * injected `renderPreview` binding; see `image-preview-contract.ts` for why.
 *
 * libvips rather than `sharp` because the self-hosted runtime stage ships a
 * single bundled `self-hosted-server.js` with no `node_modules` at all, so a
 * native npm module could not be loaded there, while an Alpine package adds a
 * real binary with no bundling step. `vips-tools` is built for musl and aarch64,
 * which is what the on-host OCI build needs.
 *
 * A derivative is produced lazily, on the first crawler hit, and then cached by
 * the route — so the resize cost is paid once per resource, not per unfurl.
 */

/** One libvips call is bounded so a pathological image cannot pin a request open. */
const VIPS_TIMEOUT_MS = 20_000;

const run = (bin: string, args: string[]): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`${bin} ${args[0] ?? ""} timed out after ${VIPS_TIMEOUT_MS}ms`));
      }
    }, VIPS_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const detail = Buffer.concat(stderr).toString().trim();
        reject(new Error(`${bin} ${args.join(" ")} exited ${code}${detail ? `: ${detail}` : ""}`));
      }
    });
  });

const headerField = async (field: string, path: string) =>
  Number((await run("vipsheader", ["-f", field, path])).toString().trim());

/**
 * Resize one image to a preview-sized baseline JPEG.
 *
 * Returns `null` when no derivative could be produced — the caller must then
 * serve the original bytes, so a crawler never receives a broken image.
 */
export async function renderPreview(
  source: Uint8Array,
  logger: PreviewLogger = console,
): Promise<PreviewImage | null> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "edgeever-preview-"));
    const sourcePath = join(dir, "source");
    await writeFile(sourcePath, source);

    // `--size down` never upscales, so a small cover keeps its own dimensions.
    const thumbPath = join(dir, "thumb.v");
    await run("vips", [
      "thumbnail",
      sourcePath,
      thumbPath,
      String(PREVIEW_MAX_EDGE),
      "--height",
      String(PREVIEW_MAX_EDGE),
      "--size",
      "down",
    ]);

    const width = await headerField("width", thumbPath);
    const height = await headerField("height", thumbPath);

    // JPEG has no alpha channel, and libvips composites it onto black — a
    // transparent logo would preview as a black box. Flatten onto white first.
    // (`jpegsave --background` does NOT do this; it is a save option, not a
    // composite, and the alpha is still dropped.)
    let encodablePath = thumbPath;
    if ((await headerField("bands", thumbPath)) >= 4) {
      encodablePath = join(dir, "flattened.v");
      await run("vips", ["flatten", thumbPath, encodablePath, "--background", "255 255 255"]);
    }

    let smallest: { bytes: Uint8Array; quality: number } | undefined;
    for (const quality of PREVIEW_QUALITIES) {
      const outPath = join(dir, `q${quality}.jpg`);
      // No `--interlace`: libvips writes baseline JPEG by default, which is what
      // the cap is documented against.
      await run("vips", ["jpegsave", encodablePath, outPath, "--Q", String(quality), "--strip"]);
      const bytes = new Uint8Array(await readFile(outPath));
      if (!smallest || bytes.byteLength < smallest.bytes.byteLength) {
        smallest = { bytes, quality };
      }
      if (bytes.byteLength <= PREVIEW_TARGET_BYTES) {
        return { bytes, width, height, quality };
      }
    }

    if (smallest && smallest.bytes.byteLength <= PREVIEW_FAILSAFE_BYTES) {
      return { bytes: smallest.bytes, width, height, quality: smallest.quality };
    }

    throw new Error(
      `no quality in ${PREVIEW_QUALITIES.join("/")} reached the ${PREVIEW_FAILSAFE_BYTES}-byte fail-safe`,
    );
  } catch (error) {
    logger.warn(
      `[preview] could not build a derivative, serving the original: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return null;
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
