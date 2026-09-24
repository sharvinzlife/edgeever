import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { globSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { hashPassword } from "./auth-crypto.ts";
import { clearPreviewCache, getCachedPreview, previewCacheKey } from "./image-preview-contract.ts";
import { renderPreview } from "./image-preview.ts";
import { registerMemoShareRoutes, registerPublicShareRoutes } from "./share-routes.ts";

class SqliteD1PreparedStatement {
  constructor(db, sql, bindings = []) {
    this.db = db;
    this.sql = sql;
    this.bindings = bindings;
  }

  bind(...bindings) {
    return new SqliteD1PreparedStatement(this.db, this.sql, bindings);
  }

  async all() {
    return { results: this.db.query(this.sql).all(...this.bindings), success: true, meta: {} };
  }

  async first() {
    return this.db.query(this.sql).get(...this.bindings) ?? null;
  }

  async run() {
    this.db.query(this.sql).run(...this.bindings);
    return { success: true, meta: {} };
  }
}

class SqliteD1Database {
  constructor(db) {
    this.db = db;
  }

  prepare(sql) {
    return new SqliteD1PreparedStatement(this.db, sql);
  }

  async batch(statements) {
    return this.db.transaction(() => statements.map((statement) =>
      this.db.query(statement.sql).run(...statement.bindings)))();
  }
}

const sourceToken = "s".repeat(43);
const targetToken = "t".repeat(43);

const createDatabaseEnvironment = () => {
  const sqlite = new Database(":memory:");
  for (const migration of globSync("migrations/*.sql").sort()) {
    sqlite.exec(readFileSync(migration, "utf8"));
  }
  sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES (?, ?, 1)")
    .run("ws_member", "Member workspace");
  sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES (?, ?, ?)")
    .run("nb_member", "ws_member", "Inbox");

  const contentJson = JSON.stringify({
    type: "doc",
    content: [{
      type: "paragraph",
      content: [
        { type: "text", text: "Public", marks: [{ type: "link", attrs: { href: "#memo=memo_target" } }] },
        { type: "text", text: "Private", marks: [{ type: "link", attrs: { href: "#memo=memo_private" } }] },
      ],
    }],
  });
  for (const [id, title, content] of [
    ["memo_source", "Source", contentJson],
    ["memo_target", "Target", JSON.stringify({ type: "doc", content: [] })],
    ["memo_private", "Private", JSON.stringify({ type: "doc", content: [] })],
  ]) {
    sqlite.query("INSERT INTO memos (id, workspace_id, notebook_id, title) VALUES (?, ?, ?, ?)")
      .run(id, "ws_member", "nb_member", title);
    sqlite.query("INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_hash) VALUES (?, ?, '', ?)")
      .run(id, content, `${id}-hash`);
  }
  sqlite.query("INSERT INTO memo_shares (id, memo_id, workspace_id, token) VALUES (?, ?, ?, ?)")
    .run("share_source", "memo_source", "ws_member", sourceToken);
  sqlite.query("INSERT INTO memo_shares (id, memo_id, workspace_id, token) VALUES (?, ?, ?, ?)")
    .run("share_target", "memo_target", "ws_member", targetToken);

  return {
    sqlite,
    environment: { storage: { db: new SqliteD1Database(sqlite), resources: {} } },
  };
};

describe("public memo shares", () => {
  test("returns share tokens only for referenced notes that are also public", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(`/api/public/shares/${sourceToken}`, {}, environment);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      share: { memoShareTokens: { memo_target: targetToken } },
    });
    sqlite.close();
  });

  test("serves shared PDF byte ranges with public-share cache controls", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'attachment', 'application/pdf', '共享报告.pdf', 10)`,
    ).run("res_shared", "memo_source", "shared-key");
    let requestedOptions;
    environment.storage.resources = {
      get: async (_key, options) => {
        requestedOptions = options;
        return {
          body: new Blob([new TextEncoder().encode("2345")]).stream(),
          size: 10,
          range: { offset: 2, length: 4 },
          writeHttpMetadata: () => {},
        };
      },
    };
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_shared/blob`,
      { headers: { Range: "bytes=2-5" } },
      environment,
    );

    expect(requestedOptions).toEqual({ range: { offset: 2, length: 4 } });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe("bytes 2-5/10");
    expect(response.headers.get("Content-Disposition")).toBe(
      "inline; filename=\"download.pdf\"; filename*=UTF-8''%E5%85%B1%E4%BA%AB%E6%8A%A5%E5%91%8A.pdf",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await response.text()).toBe("2345");
    sqlite.close();
  });

  test("serves filename-detected shared audio inline", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'attachment', 'application/octet-stream', 'recording.mp3', 10)`,
    ).run("res_audio", "memo_source", "audio-key");
    environment.storage.resources = {
      get: async () => ({
        body: new Blob([new Uint8Array(10)]).stream(),
        size: 10,
        writeHttpMetadata: () => {},
      }),
    };
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_audio/blob`,
      {},
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(response.headers.get("Content-Disposition")).toBe(
      "inline; filename=\"recording.mp3\"; filename*=UTF-8''recording.mp3",
    );
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    sqlite.close();
  });

  test("serves filename-detected shared video inline", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'attachment', 'application/octet-stream', 'walkthrough.webm', 10)`,
    ).run("res_video", "memo_source", "video-key");
    environment.storage.resources = {
      get: async () => ({
        body: new Blob([new Uint8Array(10)]).stream(),
        size: 10,
        writeHttpMetadata: () => {},
      }),
    };
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_video/blob`,
      {},
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/webm");
    expect(response.headers.get("Content-Disposition")).toBe(
      "inline; filename=\"walkthrough.webm\"; filename*=UTF-8''walkthrough.webm",
    );
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    sqlite.close();
  });
});

const memberAuth = {
  kind: "user",
  actorType: "user",
  actorId: "user_member",
  username: "member",
  displayName: "Member",
  scopes: [],
  workspaceId: "ws_member",
  role: "member",
};

const createShareApp = (environment) => {
  const app = new Hono();
  app.use("/api/v1/*", async (c, next) => {
    c.set("auth", memberAuth);
    await next();
  });
  registerPublicShareRoutes(app);
  registerMemoShareRoutes(app);
  return app;
};

const readCookieValue = (response, name) => {
  const header = response.headers.get("Set-Cookie") ?? "";
  const prefix = `${name}=`;
  const part = header.split(";").find((item) => item.trim().startsWith(prefix));
  return part ? part.trim().slice(prefix.length) : "";
};

describe("password-protected memo shares", () => {
  test("keeps existing shares public until a password is enabled", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const app = createShareApp(environment);

    const publicResponse = await app.request(`/api/public/shares/${sourceToken}`, {}, environment);
    expect(publicResponse.status).toBe(200);
    expect(await publicResponse.json()).toMatchObject({ share: { title: "Source" } });

    const enabled = await app.request(`/api/v1/memos/memo_source/share`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passwordProtected: true }),
    }, environment);
    expect(enabled.status).toBe(200);
    const enabledBody = await enabled.json();
    expect(enabledBody.share.passwordProtected).toBe(true);
    expect(enabledBody.share.password).toHaveLength(8);
    expect(enabledBody.share).not.toHaveProperty("passwordHash");

    const locked = await app.request(`/api/public/shares/${sourceToken}`, {}, environment);
    expect(locked.status).toBe(403);
    expect(await locked.json()).toEqual({
      error: { code: "share_password_required", message: "Password required to view this shared note" },
    });
    sqlite.close();
  });

  test("unlocks with the generated password and then serves the note and attachments", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const password = "testPass";
    sqlite.query("UPDATE memo_shares SET password_hash = ? WHERE token = ?")
      .run(await hashPassword(password), sourceToken);
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'attachment', 'application/pdf', 'shared.pdf', 10)`,
    ).run("res_locked", "memo_source", "locked-key");
    environment.storage.resources = {
      get: async () => ({
        body: new Blob([new Uint8Array(10)]).stream(),
        size: 10,
        writeHttpMetadata: () => {},
      }),
    };
    const app = createShareApp(environment);

    const deniedResource = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_locked/blob`,
      {},
      environment,
    );
    expect(deniedResource.status).toBe(403);

    const wrong = await app.request(`/api/public/shares/${sourceToken}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    }, environment);
    expect(wrong.status).toBe(403);
    expect((await wrong.json()).error.code).toBe("share_password_invalid");

    const unlocked = await app.request(`/api/public/shares/${sourceToken}/unlock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }, environment);
    expect(unlocked.status).toBe(200);
    const cookie = readCookieValue(unlocked, "ee_share");
    expect(cookie).toBeTruthy();

    const headers = { Cookie: `ee_share=${cookie}` };
    const share = await app.request(`/api/public/shares/${sourceToken}`, { headers }, environment);
    expect(share.status).toBe(200);
    expect(await share.json()).toMatchObject({ share: { title: "Source" } });

    const resource = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_locked/blob`,
      { headers },
      environment,
    );
    expect(resource.status).toBe(200);
    sqlite.close();
  });

  test("clearing the password makes the existing link public again", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query("UPDATE memo_shares SET password_hash = ? WHERE token = ?")
      .run(await hashPassword("secretPwd"), sourceToken);
    const app = createShareApp(environment);

    const cleared = await app.request(`/api/v1/memos/memo_source/share`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ passwordProtected: false }),
    }, environment);
    expect(cleared.status).toBe(200);
    const clearedBody = await cleared.json();
    expect(clearedBody.share).toMatchObject({ passwordProtected: false });
    expect(clearedBody.share.password).toBeUndefined();

    const publicResponse = await app.request(`/api/public/shares/${sourceToken}`, {}, environment);
    expect(publicResponse.status).toBe(200);
    sqlite.close();
  });
});

// Mirrors the shape authenticateApiToken builds (auth-service.ts): an API token
// is an "agent" auth, and hasScopes only exempts kind === "user".
const agentAuth = (scopes) => ({
  kind: "agent",
  actorType: "agent",
  actorId: "tok_bot",
  username: "bot",
  displayName: "bot",
  scopes,
  workspaceId: "ws_member",
  role: "member",
  tokenId: "tok_bot",
});

const createAgentShareApp = (environment, scopes) => {
  const app = new Hono();
  app.use("/api/v1/*", async (c, next) => {
    c.set("auth", agentAuth(scopes));
    await next();
  });
  registerPublicShareRoutes(app);
  registerMemoShareRoutes(app);
  return app;
};

describe("authenticated share resolve", () => {
  test("resolves a share token to its note for an API token", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const app = createAgentShareApp(environment, ["read:memos"]);

    const response = await app.request(`/api/v1/shares/${sourceToken}`, {}, environment);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.share.memoId).toBe("memo_source");
    expect(body.share.title).toBe("Source");
    expect(body.share.contentJson.type).toBe("doc");
    expect(Array.isArray(body.share.tags)).toBe(true);
    expect(body.share.passwordProtected).toBe(false);
    // The hash and the linked-memo token map must never leave the server.
    expect(body.share).not.toHaveProperty("password");
    expect(body.share).not.toHaveProperty("passwordHash");
    expect(body.share).not.toHaveProperty("memoShareTokens");
    sqlite.close();
  });

  test("resolves a password-protected share for the owner", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query("UPDATE memo_shares SET password_hash = ? WHERE token = ?")
      .run(await hashPassword("secretPwd"), sourceToken);
    const app = createAgentShareApp(environment, ["read:memos"]);

    const publicResponse = await app.request(`/api/public/shares/${sourceToken}`, {}, environment);
    expect(publicResponse.status).toBe(403);

    const response = await app.request(`/api/v1/shares/${sourceToken}`, {}, environment);
    expect(response.status).toBe(200);
    expect((await response.json()).share.passwordProtected).toBe(true);
    sqlite.close();
  });

  test("answers 404 for unknown, malformed and other-workspace tokens alike", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query("INSERT INTO workspaces (id, name, is_personal) VALUES (?, ?, 1)")
      .run("ws_other", "Other workspace");
    sqlite.query("INSERT INTO notebooks (id, workspace_id, name) VALUES (?, ?, ?)")
      .run("nb_other", "ws_other", "Inbox");
    sqlite.query("INSERT INTO memos (id, workspace_id, notebook_id, title) VALUES (?, ?, ?, ?)")
      .run("memo_other", "ws_other", "nb_other", "Other");
    sqlite.query("INSERT INTO memo_contents (memo_id, content_json, content_markdown, content_hash) VALUES (?, ?, '', ?)")
      .run("memo_other", JSON.stringify({ type: "doc", content: [] }), "memo_other-hash");
    const foreignToken = "f".repeat(43);
    sqlite.query("INSERT INTO memo_shares (id, memo_id, workspace_id, token) VALUES (?, ?, ?, ?)")
      .run("share_other", "memo_other", "ws_other", foreignToken);
    const app = createAgentShareApp(environment, ["read:memos"]);

    for (const token of ["z".repeat(43), "too-short", foreignToken]) {
      const response = await app.request(`/api/v1/shares/${token}`, {}, environment);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: { code: "not_found", message: "Shared note not found" },
      });
    }
    sqlite.close();
  });

  test("answers 404 once the note is deleted", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    sqlite.query("UPDATE memos SET is_deleted = 1 WHERE id = ?").run("memo_source");
    const app = createAgentShareApp(environment, ["read:memos"]);

    const response = await app.request(`/api/v1/shares/${sourceToken}`, {}, environment);
    expect(response.status).toBe(404);
    sqlite.close();
  });

  test("requires the read:memos scope for API tokens", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const app = createAgentShareApp(environment, ["write:memos"]);

    const response = await app.request(`/api/v1/shares/${sourceToken}`, {}, environment);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "forbidden", message: "Missing required scope: read:memos" },
    });
    sqlite.close();
  });
});

// The /preview derivative exists because WhatsApp drops an og:image somewhere
// over ~600 KB. These tests use the real libvips binary, like image-preview's.
const makeJpegBytes = (width, height) => {
  const dir = mkdtempSync(join(tmpdir(), "edgeever-route-"));
  const raw = join(dir, "a.v");
  const out = join(dir, "a.jpg");
  const run = (args) => {
    const result = spawnSync("vips", args, { encoding: "buffer" });
    if (result.status !== 0) {
      throw new Error(`vips ${args.join(" ")} failed: ${result.stderr?.toString() ?? ""}`);
    }
  };
  run(["gaussnoise", raw, String(width), String(height), "--sigma", "20", "--seed", "42"]);
  run(["jpegsave", raw, out, "--Q", "95"]);
  const bytes = new Uint8Array(readFileSync(out));
  rmSync(dir, { recursive: true, force: true });
  return bytes;
};

const serveResource = (environment, bytes, renderer = renderPreview) => {
  environment.storage.resources = {
    get: async () => ({
      body: new Blob([bytes]).stream(),
      size: bytes.byteLength,
      writeHttpMetadata: () => {},
    }),
  };
  // The self-hosted server injects the libvips renderer; the Worker injects none.
  if (renderer) environment.renderPreview = renderer;
};

describe("public share image preview", () => {
  test("serves a resized baseline JPEG instead of the full-size upload", async () => {
    clearPreviewCache();
    const { sqlite, environment } = createDatabaseEnvironment();
    const original = makeJpegBytes(1440, 1800);
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', ?)`,
    ).run("res_img", "memo_source", "img-key", original.byteLength);
    serveResource(environment, original);
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_img/preview`,
      {},
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, nofollow, noarchive");

    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(bytes.byteLength).toBeLessThan(original.byteLength);
    expect(bytes.byteLength).toBeLessThanOrEqual(300 * 1024);
    // JPEG SOI marker — a real image, not an error page.
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
    // The derivative is cached, so the next crawler hit skips the resize.
    expect(getCachedPreview(previewCacheKey("res_img", original.byteLength))).toBeDefined();
    sqlite.close();
  });

  test("falls back to the original bytes when the image cannot be decoded", async () => {
    clearPreviewCache();
    const { sqlite, environment } = createDatabaseEnvironment();
    const original = new TextEncoder().encode("not really an image");
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'image', 'image/jpeg', 'broken.jpg', ?)`,
    ).run("res_broken", "memo_source", "broken-key", original.byteLength);
    serveResource(environment, original);
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_broken/preview`,
      {},
      environment,
    );

    // A crawler must never receive a broken image: same bytes as /blob would give.
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    sqlite.close();
  });

  test("serves the original when no renderer is injected, as in the Cloudflare Worker", async () => {
    clearPreviewCache();
    const { sqlite, environment } = createDatabaseEnvironment();
    const original = makeJpegBytes(1440, 1800);
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', ?)`,
    ).run("res_worker", "memo_source", "worker-key", original.byteLength);
    serveResource(environment, original, null);
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_worker/preview`,
      {},
      environment,
    );

    // No libvips on the Worker, so nothing is resized and nothing is broken.
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/jpeg");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    sqlite.close();
  });

  test("streams a non-image resource unchanged", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const original = new Uint8Array([1, 2, 3, 4, 5]);
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'attachment', 'application/pdf', 'doc.pdf', ?)`,
    ).run("res_pdf", "memo_source", "pdf-key", original.byteLength);
    serveResource(environment, original);
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_pdf/preview`,
      {},
      environment,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
    sqlite.close();
  });

  test("serves nothing for a locked share, exactly like /blob", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const original = makeJpegBytes(400, 300);
    sqlite.query("UPDATE memo_shares SET password_hash = ? WHERE token = ?")
      .run(await hashPassword("secretPwd"), sourceToken);
    sqlite.query(
      `INSERT INTO resources (id, memo_id, object_key, kind, mime_type, filename, byte_size)
       VALUES (?, ?, ?, 'image', 'image/jpeg', 'photo.jpg', ?)`,
    ).run("res_locked", "memo_source", "locked-key", original.byteLength);
    serveResource(environment, original);
    const app = new Hono();
    registerPublicShareRoutes(app);

    const response = await app.request(
      `/api/public/shares/${sourceToken}/resources/res_locked/preview`,
      {},
      environment,
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: { code: "share_password_required", message: "Password required to view this shared note" },
    });
    sqlite.close();
  });

  test("404s for an unknown resource or a malformed token", async () => {
    const { sqlite, environment } = createDatabaseEnvironment();
    const app = new Hono();
    registerPublicShareRoutes(app);

    for (const path of [
      `/api/public/shares/${sourceToken}/resources/res_missing/preview`,
      "/api/public/shares/short/resources/res_missing/preview",
    ]) {
      const response = await app.request(path, {}, environment);
      expect(response.status).toBe(404);
    }
    sqlite.close();
  });
});
