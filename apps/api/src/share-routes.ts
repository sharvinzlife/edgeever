import { collectMemoLinkIds, isPdfAttachment, MemoShareUpdateSchema, PublicShareUnlockSchema, resolveMemoContentDoc, resolvePlayableMediaMimeType, type MemoShare, type PublicMemoShare, type TiptapDoc } from "@edgeever/shared";
import { zValidator } from "@hono/zod-validator";
import type { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { AppContext, AppEnv } from "./api-context";
import { audit } from "./audit";
import { authenticateRequest } from "./auth-service";
import { hashPassword, randomToken, verifyPassword } from "./auth-crypto";
import { parseByteRange, rangeNotSatisfiable } from "./byte-range";
import { createId, isoNow, parseJsonArray } from "./entity-utils";
import { apiError, notFound } from "./http-errors";
import { getCachedPreview, previewCacheKey, putCachedPreview } from "./image-preview-contract";
import { resolveObjectStorage } from "./object-storage";
import { getAuditActor, getWorkspaceId, requireScopes, requireUser } from "./request-auth";
import { contentDispositionAttachment, contentDispositionInline } from "./resource-service";
import {
  createShareAccessCookieValue,
  isShareUnlockBlocked,
  isValidShareAccessCookieValue,
  nextShareUnlockFailure,
  SHARE_ACCESS_COOKIE,
  SHARE_ACCESS_MAX_AGE_SECONDS,
} from "./share-access";
import { generateSharePassword } from "./share-password";

const SHARE_TOKEN_BYTES = 32;
const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type MemoShareRow = {
  memo_id: string;
  token: string;
  created_at: string;
  updated_at: string;
  password_hash: string | null;
};
type PublicMemoShareRow = {
  workspace_id: string;
  title: string | null;
  content_json: string;
  content_markdown: string;
  tags_json: string;
  updated_at: string;
  password_hash: string | null;
};
// An authenticated resolve of a share token to its note. Deliberately carries
// content_json (no authenticated route exposes the Tiptap doc otherwise) and a
// passwordProtected boolean rather than the hash.
type ResolvedShareRow = {
  memo_id: string;
  title: string | null;
  content_json: string;
  tags_json: string;
  updated_at: string;
  password_hash: string | null;
};
type ShareGateRow = {
  workspace_id: string;
  password_hash: string | null;
  unlock_failed_count: number;
  unlock_window_started_at: string | null;
  unlock_blocked_until: string | null;
};
type ReferencedMemoShareRow = { memo_id: string; token: string };
type SharedResourceRow = {
  object_key: string;
  storage_config_id: string;
  kind: "image" | "attachment";
  mime_type: string | null;
  filename: string | null;
  byte_size: number;
  workspace_id: string;
  password_hash: string | null;
};

const mapMemoShare = (row: MemoShareRow, password?: string): MemoShare => ({
  memoId: row.memo_id,
  token: row.token,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  passwordProtected: Boolean(row.password_hash),
  ...(password ? { password } : {}),
});

const contentDisposition = (kind: SharedResourceRow["kind"], mimeType: string | null, filename: string | null) => {
  const inline = kind === "image" || isPdfAttachment(mimeType, filename) || Boolean(resolvePlayableMediaMimeType(mimeType, filename));
  return inline ? contentDispositionInline(filename) : contentDispositionAttachment(filename);
};

// The cache and crawler headers every public-share resource response carries.
// Applied last so object metadata cannot overwrite them.
const withPreviewHeaders = (headers: Headers) => {
  headers.set("Cache-Control", "private, no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  headers.set("X-Content-Type-Options", "nosniff");
  return headers;
};

const normalizeShareToken = (value: string) => {
  const token = value.trim();
  return SHARE_TOKEN_PATTERN.test(token) ? token : null;
};

const sharePasswordRequired = (c: AppContext) =>
  apiError(c, "share_password_required", "Password required to view this shared note", 403);

const sharePasswordInvalid = (c: AppContext) =>
  apiError(c, "share_password_invalid", "Incorrect share password", 403);

const shareUnlockRateLimited = (c: AppContext) =>
  apiError(c, "share_unlock_rate_limited", "Too many share password attempts. Try again later.", 429);

const shareAccessCookiePath = (token: string) => `/api/public/shares/${encodeURIComponent(token)}`;

const setShareAccessCookie = async (c: AppContext, token: string, passwordHash: string) => {
  const value = await createShareAccessCookieValue(passwordHash, token);
  setCookie(c, SHARE_ACCESS_COOKIE, value, {
    httpOnly: true,
    secure: new URL(c.req.url).protocol === "https:",
    sameSite: "Lax",
    path: shareAccessCookiePath(token),
    maxAge: SHARE_ACCESS_MAX_AGE_SECONDS,
  });
};

const hasShareAccessCookie = async (c: AppContext, token: string, passwordHash: string) =>
  isValidShareAccessCookieValue(getCookie(c, SHARE_ACCESS_COOKIE), passwordHash, token);

const isShareOwner = async (c: AppContext, workspaceId: string) => {
  const auth = await authenticateRequest(c, false);
  return auth?.workspaceId === workspaceId;
};

const allowPasswordProtectedShare = async (
  c: AppContext,
  token: string,
  workspaceId: string,
  passwordHash: string,
) => hasShareAccessCookie(c, token, passwordHash) || isShareOwner(c, workspaceId);

const loadShareGate = async (c: AppContext, token: string) =>
  c.env.storage.db.prepare(
    `SELECT ms.workspace_id, ms.password_hash, ms.unlock_failed_count, ms.unlock_window_started_at, ms.unlock_blocked_until
     FROM memo_shares ms
     INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
     WHERE ms.token = ? AND m.is_deleted = 0
     LIMIT 1`
  ).bind(token).first<ShareGateRow>();

const selectMemoShareSql = `SELECT memo_id, token, created_at, updated_at, password_hash
  FROM memo_shares WHERE memo_id = ? AND workspace_id = ?`;

export const registerPublicShareRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/public/shares/:token", async (c) => {
    const token = normalizeShareToken(c.req.param("token"));
    if (!token) return notFound(c, "Shared note not found");

    const row = await c.env.storage.db.prepare(
      `SELECT ms.workspace_id, m.title, mc.content_json, mc.content_markdown, m.tags_json, m.updated_at, ms.password_hash
       FROM memo_shares ms
       INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
       INNER JOIN memo_contents mc ON mc.memo_id = m.id
       WHERE ms.token = ? AND m.is_deleted = 0
       LIMIT 1`
    ).bind(token).first<PublicMemoShareRow>();
    if (!row) return notFound(c, "Shared note not found");
    if (row.password_hash && !(await allowPasswordProtectedShare(c, token, row.workspace_id, row.password_hash))) {
      return sharePasswordRequired(c);
    }

    const contentJson = JSON.parse(row.content_json) as TiptapDoc;
    const referencedMemoIds = collectMemoLinkIds(resolveMemoContentDoc(contentJson, row.content_markdown));
    const memoShareTokens: Record<string, string> = {};
    for (let offset = 0; offset < referencedMemoIds.length; offset += 80) {
      const batch = referencedMemoIds.slice(offset, offset + 80);
      const placeholders = batch.map(() => "?").join(", ");
      const linkedShares = await c.env.storage.db.prepare(
        `SELECT ms.memo_id, ms.token
         FROM memo_shares ms
         INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
         WHERE ms.workspace_id = ? AND ms.memo_id IN (${placeholders}) AND m.is_deleted = 0`
      ).bind(row.workspace_id, ...batch).all<ReferencedMemoShareRow>();
      for (const linkedShare of linkedShares.results) {
        memoShareTokens[linkedShare.memo_id] = linkedShare.token;
      }
    }

    const share: PublicMemoShare = {
      title: row.title,
      contentJson,
      contentMarkdown: row.content_markdown,
      tags: parseJsonArray(row.tags_json),
      updatedAt: row.updated_at,
      memoShareTokens,
    };
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    return c.json({ share });
  });

  app.post("/api/public/shares/:token/unlock", zValidator("json", PublicShareUnlockSchema), async (c) => {
    const token = normalizeShareToken(c.req.param("token"));
    if (!token) return notFound(c, "Shared note not found");

    const gate = await loadShareGate(c, token);
    if (!gate) return notFound(c, "Shared note not found");
    if (!gate.password_hash) {
      return apiError(c, "share_password_not_required", "This shared note does not require a password", 400);
    }
    if (isShareUnlockBlocked(gate.unlock_blocked_until)) {
      return shareUnlockRateLimited(c);
    }

    const password = c.req.valid("json").password;
    if (!(await verifyPassword(password, gate.password_hash))) {
      const failure = nextShareUnlockFailure(gate);
      await c.env.storage.db.prepare(
        `UPDATE memo_shares
         SET unlock_failed_count = ?, unlock_window_started_at = ?, unlock_blocked_until = ?
         WHERE token = ?`
      ).bind(failure.failureCount, failure.windowStartedAt, failure.blockedUntil, token).run();
      return failure.blockedUntil ? shareUnlockRateLimited(c) : sharePasswordInvalid(c);
    }

    await c.env.storage.db.prepare(
      `UPDATE memo_shares
       SET unlock_failed_count = 0, unlock_window_started_at = NULL, unlock_blocked_until = NULL
       WHERE token = ?`
    ).bind(token).run();
    await setShareAccessCookie(c, token, gate.password_hash);
    c.header("Cache-Control", "private, no-store");
    c.header("X-Robots-Tag", "noindex, nofollow, noarchive");
    return c.json({ ok: true });
  });

  app.get("/api/public/shares/:token/resources/:resourceId/blob", async (c) => {
    const token = normalizeShareToken(c.req.param("token"));
    if (!token) return notFound(c, "Shared resource not found");

    const resource = await c.env.storage.db.prepare(
      `SELECT r.object_key, r.storage_config_id, r.kind, r.mime_type, r.filename, r.byte_size,
              ms.workspace_id, ms.password_hash
       FROM memo_shares ms
       INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
       INNER JOIN resources r ON r.memo_id = m.id
       WHERE ms.token = ? AND r.id = ? AND m.is_deleted = 0 AND r.is_deleted = 0
       LIMIT 1`
    ).bind(token, c.req.param("resourceId")).first<SharedResourceRow>();
    if (!resource) return notFound(c, "Shared resource not found");
    if (resource.password_hash && !(await allowPasswordProtectedShare(c, token, resource.workspace_id, resource.password_hash))) {
      return sharePasswordRequired(c);
    }

    const byteRange = parseByteRange(c.req.header("Range"), resource.byte_size);
    if (byteRange.kind === "invalid") {
      const response = rangeNotSatisfiable(resource.byte_size);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
      return response;
    }

    const source = await resolveObjectStorage(c.env, resource.storage_config_id);
    const object = await source.store.get(
      resource.object_key,
      byteRange.kind === "range" ? { range: byteRange.range } : undefined,
    );
    if (!object) return notFound(c, "Shared resource not found");

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const playableMimeType = resolvePlayableMediaMimeType(resource.mime_type, resource.filename);
    headers.set(
      "Content-Type",
      isPdfAttachment(resource.mime_type, resource.filename)
        ? "application/pdf"
        : playableMimeType ?? resource.mime_type ?? headers.get("Content-Type") ?? "application/octet-stream",
    );
    headers.set("Accept-Ranges", "bytes");
    if (byteRange.kind === "range") {
      const length = object.range?.length ?? byteRange.range.length;
      headers.set("Content-Length", String(length));
      headers.set(
        "Content-Range",
        `bytes ${byteRange.range.offset}-${byteRange.range.offset + length - 1}/${resource.byte_size}`,
      );
    } else {
      headers.set("Content-Length", String(resource.byte_size));
    }
    headers.set("Content-Disposition", contentDisposition(resource.kind, resource.mime_type, resource.filename));
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    return new Response(object.body, { headers, status: byteRange.kind === "range" ? 206 : 200 });
  });

  // A preview-sized derivative of a shared image, for `og:image`.
  //
  // Why (2026-09-23): crawlers are fussy about image size. A share whose cover
  // was the 1,073,160-byte 1440x1800 photo `/sd` attached previewed in WhatsApp
  // with a title and description but no image, while every cover under ~540 KB
  // previewed fine. The original resource is never modified — this route serves
  // a derivative, or the original when no derivative can be produced.
  app.get("/api/public/shares/:token/resources/:resourceId/preview", async (c) => {
    const token = normalizeShareToken(c.req.param("token"));
    if (!token) return notFound(c, "Shared resource not found");

    const resource = await c.env.storage.db.prepare(
      `SELECT r.object_key, r.storage_config_id, r.kind, r.mime_type, r.filename, r.byte_size,
              ms.workspace_id, ms.password_hash
       FROM memo_shares ms
       INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
       INNER JOIN resources r ON r.memo_id = m.id
       WHERE ms.token = ? AND r.id = ? AND m.is_deleted = 0 AND r.is_deleted = 0
       LIMIT 1`
    ).bind(token, c.req.param("resourceId")).first<SharedResourceRow>();
    if (!resource) return notFound(c, "Shared resource not found");
    // Same gate as /blob: a locked share serves no image to a crawler at all.
    if (resource.password_hash && !(await allowPasswordProtectedShare(c, token, resource.workspace_id, resource.password_hash))) {
      return sharePasswordRequired(c);
    }

    const source = await resolveObjectStorage(c.env, resource.storage_config_id);
    const object = await source.store.get(resource.object_key);
    if (!object) return notFound(c, "Shared resource not found");

    const cacheKey = previewCacheKey(c.req.param("resourceId"), resource.byte_size);
    const cached = resource.kind === "image" ? getCachedPreview(cacheKey) : undefined;

    const jpegResponse = (bytes: Uint8Array) => {
      const headers = new Headers();
      headers.set("Content-Type", "image/jpeg");
      headers.set("Content-Length", String(bytes.byteLength));
      // Uint8Array is a valid body at runtime; the cast is the same lib-typing
      // friction handled in s3-compatible-storage-adapter.ts.
      return new Response(bytes as BodyInit, { headers: withPreviewHeaders(headers) });
    };

    const serveOriginal = (body: ReadableStream | Uint8Array) => {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("Content-Type", resource.mime_type ?? headers.get("Content-Type") ?? "application/octet-stream");
      headers.set("Content-Length", String(resource.byte_size));
      return new Response(body as BodyInit, { headers: withPreviewHeaders(headers) });
    };

    if (cached) return jpegResponse(cached.bytes);

    if (resource.kind === "image" && c.env.renderPreview) {
      const original = new Uint8Array(await new Response(object.body).arrayBuffer());
      const rendered = await c.env.renderPreview(original);
      if (rendered) {
        putCachedPreview(cacheKey, rendered);
        return jpegResponse(rendered.bytes);
      }
      // No derivative could be produced — serve exactly what /blob serves, so a
      // crawler never receives a broken image. The renderer logged the reason.
      return serveOriginal(original);
    }

    // Not an image, or no renderer injected (the Cloudflare Worker): stream the
    // resource the way /blob does.
    return serveOriginal(object.body as ReadableStream);
  });
};

export const registerMemoShareRoutes = (app: Hono<AppEnv>) => {
  app.get("/api/v1/memos/:id/share", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;

    const row = await c.env.storage.db.prepare(
      `SELECT ms.memo_id, ms.token, ms.created_at, ms.updated_at, ms.password_hash
       FROM memo_shares ms
       INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
       WHERE ms.memo_id = ? AND ms.workspace_id = ? AND m.is_deleted = 0
       LIMIT 1`
    ).bind(c.req.param("id"), getWorkspaceId(c)).first<MemoShareRow>();
    return c.json({ share: row ? mapMemoShare(row) : null });
  });

  app.post("/api/v1/memos/:id/share", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;

    const memoId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    const memo = await c.env.storage.db.prepare(
      `SELECT id FROM memos WHERE id = ? AND workspace_id = ? AND is_deleted = 0`
    ).bind(memoId, workspaceId).first<{ id: string }>();
    if (!memo) return notFound(c, "Memo not found");

    const existing = await c.env.storage.db.prepare(selectMemoShareSql)
      .bind(memoId, workspaceId).first<MemoShareRow>();
    if (existing) return c.json({ share: mapMemoShare(existing) });

    const now = isoNow();
    const token = randomToken(SHARE_TOKEN_BYTES);
    const actor = getAuditActor(c);
    await c.env.storage.db.prepare(
      `INSERT OR IGNORE INTO memo_shares (id, memo_id, workspace_id, token, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(createId("share"), memoId, workspaceId, token, actor.actorId, now, now).run();
    const created = await c.env.storage.db.prepare(selectMemoShareSql)
      .bind(memoId, workspaceId).first<MemoShareRow>();
    if (!created) {
      throw new Error("Could not allocate a unique memo share token");
    }
    const isNewShare = created.token === token;
    if (isNewShare) {
      await audit(c.env.storage.db, actor.actorType, actor.actorId, "memo.share_create", "memo", memoId, {});
    }
    return c.json({ share: mapMemoShare(created) }, isNewShare ? 201 : 200);
  });

  app.patch("/api/v1/memos/:id/share", zValidator("json", MemoShareUpdateSchema), async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;

    const memoId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    const existing = await c.env.storage.db.prepare(
      `${selectMemoShareSql} AND EXISTS (
         SELECT 1 FROM memos m WHERE m.id = memo_shares.memo_id AND m.workspace_id = memo_shares.workspace_id AND m.is_deleted = 0
       )`
    ).bind(memoId, workspaceId).first<MemoShareRow>();
    if (!existing) return notFound(c, "Active share not found");

    const now = isoNow();
    const actor = getAuditActor(c);
    if (!c.req.valid("json").passwordProtected) {
      await c.env.storage.db.prepare(
        `UPDATE memo_shares
         SET password_hash = NULL, unlock_failed_count = 0, unlock_window_started_at = NULL,
             unlock_blocked_until = NULL, updated_at = ?
         WHERE memo_id = ? AND workspace_id = ?`
      ).bind(now, memoId, workspaceId).run();
      await audit(c.env.storage.db, actor.actorType, actor.actorId, "memo.share_password_clear", "memo", memoId, {});
      const cleared = await c.env.storage.db.prepare(selectMemoShareSql)
        .bind(memoId, workspaceId).first<MemoShareRow>();
      return c.json({ share: mapMemoShare(cleared ?? { ...existing, password_hash: null, updated_at: now }) });
    }

    const password = generateSharePassword();
    const passwordHash = await hashPassword(password);
    await c.env.storage.db.prepare(
      `UPDATE memo_shares
       SET password_hash = ?, unlock_failed_count = 0, unlock_window_started_at = NULL,
           unlock_blocked_until = NULL, updated_at = ?
       WHERE memo_id = ? AND workspace_id = ?`
    ).bind(passwordHash, now, memoId, workspaceId).run();
    await audit(
      c.env.storage.db,
      actor.actorType,
      actor.actorId,
      existing.password_hash ? "memo.share_password_rotate" : "memo.share_password_set",
      "memo",
      memoId,
      {},
    );
    const updated = await c.env.storage.db.prepare(selectMemoShareSql)
      .bind(memoId, workspaceId).first<MemoShareRow>();
    return c.json({ share: mapMemoShare(updated ?? { ...existing, password_hash: passwordHash, updated_at: now }, password) });
  });

  app.delete("/api/v1/memos/:id/share", async (c) => {
    const denied = requireUser(c);
    if (denied) return denied;

    const memoId = c.req.param("id");
    const workspaceId = getWorkspaceId(c);
    const existing = await c.env.storage.db.prepare(
      `SELECT memo_id FROM memo_shares WHERE memo_id = ? AND workspace_id = ?`
    ).bind(memoId, workspaceId).first<{ memo_id: string }>();
    if (!existing) return notFound(c, "Active share not found");

    await c.env.storage.db.prepare(
      `DELETE FROM memo_shares WHERE memo_id = ? AND workspace_id = ?`
    ).bind(memoId, workspaceId).run();
    const actor = getAuditActor(c);
    await audit(c.env.storage.db, actor.actorType, actor.actorId, "memo.share_revoke", "memo", memoId, {});
    return c.json({ ok: true });
  });

  // Resolve a share token to its note, for trusted API-token callers (the
  // WhatsApp bot's /cv command). Not requireUser: that rejects API tokens.
  // The owner is exempt from the share password, so a locked share still
  // resolves here even though the public route would 403.
  app.get("/api/v1/shares/:token", async (c) => {
    const denied = requireScopes(c, "read:memos");
    if (denied) return denied;

    const token = normalizeShareToken(c.req.param("token"));
    if (!token) return notFound(c, "Shared note not found");

    const row = await c.env.storage.db.prepare(
      `SELECT ms.memo_id, m.title, mc.content_json, m.tags_json, m.updated_at, ms.password_hash
       FROM memo_shares ms
       INNER JOIN memos m ON m.id = ms.memo_id AND m.workspace_id = ms.workspace_id
       INNER JOIN memo_contents mc ON mc.memo_id = m.id
       WHERE ms.token = ? AND ms.workspace_id = ? AND m.is_deleted = 0
       LIMIT 1`
    ).bind(token, getWorkspaceId(c)).first<ResolvedShareRow>();
    // Unknown, malformed and other-workspace tokens answer identically, so this
    // cannot be used to probe for tokens outside the caller's workspace.
    if (!row) return notFound(c, "Shared note not found");

    return c.json({
      share: {
        memoId: row.memo_id,
        title: row.title,
        contentJson: JSON.parse(row.content_json) as TiptapDoc,
        tags: parseJsonArray(row.tags_json),
        passwordProtected: Boolean(row.password_hash),
        updatedAt: row.updated_at,
      },
    });
  });
};
