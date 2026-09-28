// EdgeEver fork: the server answers 404 on every client-direct AI route
// (see apps/api/src/fork-direct-ai.ts). Guard that every client entry point
// still reaches the server-side proxy, in both desktop/mobile and browser modes.
import { expect, test } from "bun:test";
import { createEdgeEverClient } from "./index.ts";

const sse = 'data: {"type":"text-delta","text":"proxied"}\n\n';
const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const turnId = "11111111-1111-4111-8111-111111111111";

const proxies = {
  "/api/v1/ai/generate": () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  "/api/v1/ai/tag-suggestions": () => json({ suggestions: [] }),
  "/api/v1/plugins/ai/generate": () => json({ text: "proxied" }),
  "/api/v1/companion/discovery/check": () => json({ items: [] }),
  "/api/v1/companion/turns": () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
  [`/api/v1/companion/turns/${turnId}/resume`]: () => new Response(sse, { headers: { "content-type": "text/event-stream" } }),
};

for (const mode of [{ directAiGeneration: true }, { tryDirectAiGeneration: true }]) {
  test(`fork: every AI entry point falls back to the proxy on 404 (${Object.keys(mode)[0]})`, async () => {
    const paths = [];
    const client = createEdgeEverClient({
      baseUrl: "https://notes.example",
      ...mode,
      fetch: async (url) => {
        const path = new URL(String(url)).pathname;
        paths.push(path);
        if (path.endsWith("/prepare") || path === "/api/v1/ai/direct-target") {
          return new Response(JSON.stringify({ error: { code: "direct_ai_disabled" } }), { status: 404 });
        }
        const proxy = proxies[path];
        if (!proxy) throw new Error(`unexpected request ${path}`);
        return proxy();
      },
      providerFetch: async (url) => { throw new Error(`provider must not be called: ${url}`); },
    });
    const onEvent = () => {};
    await client.streamAiGeneration({ action: "summarize", title: "Note", contentMarkdown: "Body" }, { onEvent });
    expect(await client.suggestAiTags({ title: "Note", contentMarkdown: "Body", currentTags: [] })).toEqual({ suggestions: [] });
    expect(await client.pluginAi.generate({ system: "", prompt: "hello" })).toEqual({ text: "proxied" });
    expect(await client.checkCompanionDiscoveries("en-US")).toEqual({ items: [] });
    await client.streamCompanion({ id: turnId, threadId: turnId, message: "hi", useMemory: false, allowNotes: false, locale: "en-US" }, { onEvent });
    await client.resumeCompanionTurn(turnId, {}, { onEvent });
    for (const proxy of Object.keys(proxies)) expect(paths).toContain(proxy);
    if (mode.tryDirectAiGeneration) expect(paths.some((path) => path.endsWith("/prepare"))).toBe(false);
  });
}
