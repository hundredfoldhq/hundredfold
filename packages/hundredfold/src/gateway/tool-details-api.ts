import type { ServerResponse } from "node:http";
import { getSession } from "../sessions/registry.js";
import { getToolDetail } from "../sessions/tool-details.js";
import { json, matchRoute, notFound, type ParsedRoute } from "./route-helpers.js";

/**
 * GET /api/sessions/:id/tool-details/:toolId: the whole input and output of one tool call whose chat
 * card was cut, for the card's "show full". The call's row says it has them (`meta.tool.full`).
 *
 *   200 { input?, output?, isError?, outputChars?, inputChars? }
 *   404 when the session or the call has nothing stored
 *
 * `outputChars` and `inputChars` appear only when what is kept is itself a head of a longer text.
 * Held to the visibility of `GET /api/sessions/:id` (the same session rule, so a session a scoped
 * caller cannot read answers 404), and no agent tool reads it: the details are for a person looking at the chat.
 */
export function handleToolDetailsApi(res: ServerResponse, route: ParsedRoute): boolean {
  const params = route.method === "GET" ? matchRoute("/api/sessions/:id/tool-details/:toolId", route.pathname) : null;
  if (!params) return false;
  const detail = getSession(params.id) ? getToolDetail(params.id, params.toolId) : undefined;
  if (!detail) notFound(res);
  else json(res, detail);
  return true;
}
