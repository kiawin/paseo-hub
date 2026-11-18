import { createFileRoute } from "@tanstack/react-router";
import { getApplication } from "../../../server/runtime.js";

export const Route = createFileRoute("/agent-sessions/$sessionId/mcp")({
  server: {
    handlers: {
      POST: async ({ request }) =>
        (await getApplication()).operations.handleSessionCapabilities(
          request,
          new URL(request.url).pathname.split("/")[2] ?? "",
        ),
      // Stateless and POST-only, like the execution MCP route: there is no SSE stream to resume
      // (GET) or session to terminate (DELETE). Without a handler these methods fall through to
      // the SPA route render and answer 500, which makes MCP clients mark the server as dead
      // instead of treating the method as unsupported (405).
      GET: methodNotAllowed,
      DELETE: methodNotAllowed,
    },
  },
});

function methodNotAllowed(): Response {
  return Response.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { Allow: "POST" } },
  );
}
