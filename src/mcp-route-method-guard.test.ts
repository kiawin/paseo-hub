import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { Route as executionRoute } from "./routes/agent-executions/$executionId/mcp.js";
import { Route as sessionRoute } from "./routes/agent-sessions/$sessionId/mcp.js";

/**
 * TanStack's `Constrain<ObjectLiteral, Fn>` handlers type resolves member
 * access against the function-form branch of the union even though this
 * route declares the plain object-literal form, so the generated route
 * type cannot express calling an individual method handler directly.
 */
interface McpRouteMethodHandlers {
  GET(): Response | Promise<Response>;
  DELETE(): Response | Promise<Response>;
}

// The execution and agent-session MCP servers are stateless and POST-only. Without a guard, an
// unhandled GET (SSE stream open) or DELETE (session terminate) fell through to the SPA route
// render and answered 500. A 500 makes MCP Streamable HTTP clients treat the server as dead
// instead of retrying with the one method it actually supports.
describe.each([
  ["execution", executionRoute],
  ["agent-session", sessionRoute],
])("%s MCP route", (_name, route) => {
  it.each(["GET", "DELETE"] as const)(
    "rejects %s with 405 and an Allow: POST header",
    async (method) => {
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the generated route type cannot express calling one handler directly
      const handlers = route.options.server?.handlers as unknown as McpRouteMethodHandlers;
      const response = await handlers[method]();

      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "POST");
    },
  );
});
