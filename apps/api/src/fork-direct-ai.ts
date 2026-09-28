import type { Context } from "hono";
import { apiError } from "./http-errors";

/**
 * EdgeEver fork policy: the decrypted AI provider API key never leaves the server.
 *
 * Upstream's "client-direct AI" routes (`.../prepare`) return the provider
 * credentials so desktop, mobile and CORS-capable web clients can call the
 * model provider themselves. In this fork the key is the operator's LiteLLM
 * master key, so every such route answers 404 before any credential lookup.
 * All clients (packages/client runDirectOrProxy / runCompanionDirect /
 * streamAiGeneration, iOS APIClient.streamAiGeneration) treat 404 as "direct
 * mode unsupported" and fall back to the server-side proxy endpoints.
 *
 * `GET /api/v1/ai/direct-target` answers 404 too, so browser clients skip the
 * CORS probe instead of probing a provider they will never be allowed to use.
 *
 * Each call site is one line at the top of the upstream handler,
 * `if (DIRECT_AI_DISABLED) return directAiDisabled(c);`, so upstream syncs stay
 * trivial to merge. The flag is typed `boolean` (not the literal `true`) so the
 * upstream handler body stays reachable for the type checker.
 */
export const DIRECT_AI_DISABLED: boolean = true;

export const DIRECT_AI_DISABLED_CODE = "direct_ai_disabled";

export const directAiDisabled = (c: Context) =>
  apiError(c, DIRECT_AI_DISABLED_CODE, "Direct AI generation is disabled on this server.", 404);
