// EdgeEver fork: the decrypted provider API key must never reach a client.
// Every client-direct AI route answers 404 so clients use the server proxy.
import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { globSync, readFileSync } from "node:fs";
import { Hono } from "hono";
import { createSelfHostedStorageAdapter } from "./self-hosted-storage-adapter.ts";
import { registerAiRoutes } from "./ai-routes.ts";
import { registerPluginCapabilityRoutes } from "./plugin-capability-routes.ts";
import { registerCompanionRoutes } from "./companion-routes.ts";
import { beginCompanionTurn, getCompanionTurn } from "./companion-service.ts";

const SECRET = "sk-litellm-master-DO-NOT-LEAK";
const scope = { workspaceId: "ws_member", ownerId: "usr_member" };
const databases = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const companionInput = () => ({
  id: crypto.randomUUID(), threadId: crypto.randomUUID(), message: "hello",
  useMemory: false, allowNotes: false, locale: "en-US",
});

async function fixture() {
  const sqlite = new Database(":memory:");
  databases.push(sqlite);
  for (const path of globSync("migrations/*.sql").sort()) sqlite.exec(readFileSync(path, "utf8"));
  sqlite.query("INSERT INTO workspaces(id, name, is_personal) VALUES (?, ?, 1)").run(scope.workspaceId, "Member");
  const storage = createSelfHostedStorageAdapter(sqlite, "/tmp/edgeever-fork-direct-ai-unused");
  const env = { storage, EDGE_EVER_AUTH_PASSWORD: "x".repeat(32) };
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("auth", { kind: "user", actorType: "user", actorId: scope.ownerId, username: "member",
      displayName: "Member", workspaceId: scope.workspaceId, role: "member", scopes: [] });
    await next();
  });
  // No credential stubs: the real loaders would decrypt SECRET if reached.
  registerAiRoutes(app, { isDemoMode: () => false });
  registerPluginCapabilityRoutes(app, { isDemoMode: () => false });
  registerCompanionRoutes(app, { isDemoMode: () => false });
  const call = (path, method = "GET", body) => app.request(path, {
    method, headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }, env);
  const created = await call("/api/v1/ai/providers", "POST", {
    provider: "openai-compatible", displayName: "LiteLLM", baseUrl: "https://litellm.internal.example/v1",
    apiKey: SECRET, isEnabled: true, initialModelId: "model-a",
  });
  expect(created.status).toBe(201);
  expect(await created.text()).not.toContain(SECRET);
  return { call, db: storage.db };
}

test("fork: every client-direct AI route answers 404 and never returns the provider key", async () => {
  const { call, db } = await fixture();
  const interrupted = companionInput();
  await beginCompanionTurn(db, scope, interrupted, "model-a");
  await db.prepare("UPDATE companion_turns SET status = 'interrupted' WHERE id = ?").bind(interrupted.id).run();
  const fresh = companionInput();

  const routes = [
    ["GET", "/api/v1/ai/direct-target"],
    ["POST", "/api/v1/ai/generate/prepare", { action: "summarize", title: "Note", contentMarkdown: "Body" }],
    ["POST", "/api/v1/ai/tag-suggestions/prepare", { title: "Note", contentMarkdown: "Body", currentTags: [] }],
    ["POST", "/api/v1/plugins/ai/generate/prepare", { system: "Translate", prompt: "hello", maxOutputTokens: 100 }],
    ["POST", "/api/v1/companion/discovery/check/prepare?locale=en-US", {}],
    // Resume before a new turn: an owner may hold only one running turn.
    ["POST", `/api/v1/companion/turns/${interrupted.id}/resume/prepare`, {}],
    ["POST", "/api/v1/companion/turns/prepare", fresh],
  ];
  for (const [method, path, body] of routes) {
    const response = await call(path, method, body);
    const text = await response.text();
    expect(`${method} ${path} -> ${response.status}`).toBe(`${method} ${path} -> 404`);
    expect(text).not.toContain(SECRET);
    expect(JSON.parse(text)).toMatchObject({ error: { code: "direct_ai_disabled" } });
  }
  // Refused before any side effect: no new turn, the interrupted turn is untouched.
  expect(await getCompanionTurn(db, scope, fresh.id)).toBeNull();
  expect((await getCompanionTurn(db, scope, interrupted.id)).status).toBe("interrupted");
});
