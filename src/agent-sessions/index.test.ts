import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { expect, test } from "vitest";
import { AgentSessions } from "./index.js";
import { createMemoryDatabase } from "../db/memory.js";
import type { Database } from "../db/types.js";
import { createLogger } from "../logger.js";
import { OutputExecutorRegistry, replyOutputTool } from "../execution-capabilities/outputs.js";
import { createExecutionCapabilityServer } from "../execution-capabilities/server.js";
import type { AgentConnection, AgentSnapshot } from "../daemons/agents/index.js";
import type { LaunchMachineIntent } from "../dispatcher/launch-machine-intent.js";
import type { DaemonCreateAgentOptions } from "../daemons/protocol.js";

class TestAgents implements AgentConnection {
  readonly agents = new Map<string, AgentSnapshot>();
  readonly deliveries: { agentId: string; text: string }[] = [];
  readonly creates: DaemonCreateAgentOptions[] = [];
  readonly messages = new Set<string>();
  archives = 0;
  restorations = 0;
  async create(_key: string, options: DaemonCreateAgentOptions) {
    this.creates.push(options);
    const agent = { id: randomUUID(), workspaceId: randomUUID(), status: "idle" as const };
    this.agents.set(agent.id, agent);
    return agent;
  }
  async get(id: string) {
    const agent = this.agents.get(id);
    if (!agent) throw new Error("missing");
    return agent;
  }
  async send(agentId: string, messageId: string, text: string) {
    if (this.messages.has(messageId)) return;
    this.messages.add(messageId);
    this.deliveries.push({ agentId, text });
  }
  async watch() {
    return () => {};
  }
  async restore(workspaceId: string) {
    this.restorations++;
    for (const [id, agent] of this.agents)
      if (agent.workspaceId === workspaceId) this.agents.set(id, { ...agent, archivedAt: null });
    return true;
  }
  async control(agentId: string, _workspaceId: string, action: "interrupt" | "archive") {
    if (action === "archive") {
      this.archives++;
      this.agents.set(agentId, {
        ...(await this.get(agentId)),
        archivedAt: new Date().toISOString(),
      });
    }
  }
}

async function fixture(now = Date.now, database: Database = createMemoryDatabase()) {
  const connection = new TestAgents();
  const outputs = new OutputExecutorRegistry();
  const replies: { executionId: string; context: unknown }[] = [];
  outputs.register({
    type: "test.reply",
    tool: replyOutputTool,
    execute: async (input) => {
      replies.push({ executionId: input.agentExecutionId, context: input.outputContext });
    },
  });
  const logs: unknown[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      logs.push(JSON.parse(chunk.toString()));
      done();
    },
  });
  const logger = createLogger(stream);
  const sessions = new AgentSessions(database, "secret", "https://hub.test", outputs, now, logger);
  const capabilities = createExecutionCapabilityServer({
    database,
    outputs,
    completionTokenSecret: "secret",
    completeExecution: async ({ executionId }) =>
      (await database.transitionAgentExecution(executionId, "succeeded")).execution,
  });
  async function arrival(
    key: string | null | false = "conversation",
    target = "daemon",
    env: Record<string, string> = {},
    prompt = "hello",
    overrides: Partial<LaunchMachineIntent> = {},
  ) {
    const executionId = randomUUID();
    const intent: LaunchMachineIntent = {
      kind: "launch_machine",
      organizationId: "org",
      projectId: "project",
      triggerRunId: randomUUID(),
      triggerName: "answer",
      environmentName: "target",
      environment: { kind: "daemon", daemonId: target, authoredSlug: target, cwd: "/repo" },
      agent: { provider: "codex" },
      prompt,
      env,
      allowOutputs: [{ type: "test.reply", max: 1 }],
      autoArchive: true,
      background: false,
      triggerContext: {},
      outputContext: { arrival: executionId },
      configurationRevisionId: randomUUID(),
      hubConfig: {},
      ...(key === false ? {} : { continuation: { key, compatibility: { target } } }),
      ...overrides,
    };
    await database.insertAgentExecution({
      id: executionId,
      organizationId: "org",
      projectId: "project",
      machineId: null,
      triggerContext: {},
      outputContext: intent.outputContext,
      configurationRevisionId: intent.configurationRevisionId,
      launchIntent: intent,
      ...(intent.deadlineAt === undefined ? {} : { deadlineAt: intent.deadlineAt }),
    });
    return {
      executionId,
      dispatch: () =>
        sessions.dispatch({
          executionId,
          intent,
          connection,
          onEvent: () => {},
          createOptions: async () => ({
            provider: "codex",
            cwd: "/repo",
            env: intent.github === undefined ? {} : { GH_TOKEN: "scoped-github-token" },
            toolPolicy: { preapproved: [] },
          }),
        }),
    };
  }
  async function execution(id: string) {
    const item = await database.findAgentExecutionById(id);
    if (!item) throw new Error("missing execution");
    return item;
  }
  async function call(
    executionId: string,
    name: string,
    args: Record<string, unknown>,
    ownerId = executionId,
  ) {
    const owner = await execution(ownerId);
    const session = await database.findAgentSession(owner.agentSessionId!);
    const mcp = session!.creationOptions.mcpServers!["hub"]!;
    const response = await capabilities.handleSession(
      new Request(mcp.url, {
        method: "POST",
        headers: {
          ...mcp.headers,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name, arguments: { ...args, executionId } },
        }),
      }),
      session!.id,
    );
    const result: unknown = await response.json();
    return result;
  }
  return { database, connection, sessions, replies, logs, arrival, execution, call };
}

test("same-key arrivals share an agent; an earlier completion cannot archive newer work", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  const [a, b] = await Promise.all([first.dispatch(), second.dispatch()]);
  expect(a.agentId).toBe(b.agentId);
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.deliveries).toHaveLength(2);
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.control(await f.execution(first.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(0);
  await f.database.transitionAgentExecution(second.executionId, "succeeded");
  await f.sessions.control(await f.execution(second.executionId), f.connection, "archive");
  expect(f.connection.archives).toBe(1);
  const third = await f.arrival();
  expect(await third.dispatch()).toMatchObject({ agentId: a.agentId, action: "restored" });
  expect(f.connection.restorations).toBe(1);
});

test("session tools keep each arrival's destination and reject stale or foreign execution IDs", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const second = await f.arrival();
  await first.dispatch();
  await second.dispatch();
  expect(await f.call(first.executionId, "reply", { content: "first" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(await f.call(first.executionId, "finish_execution", {})).toMatchObject({
    result: { content: [{ type: "text", text: "Execution finished" }] },
  });
  expect(await f.call(first.executionId, "reply", { content: "stale" })).toMatchObject({
    result: { isError: true },
  });
  expect(await f.call(second.executionId, "reply", { content: "second" })).toMatchObject({
    result: { content: [{ type: "text", text: "Output sent" }] },
  });
  expect(f.replies).toEqual([
    { executionId: first.executionId, context: { arrival: first.executionId } },
    { executionId: second.executionId, context: { arrival: second.executionId } },
  ]);
  const foreign = await f.arrival("another");
  await foreign.dispatch();
  expect(
    await f.call(foreign.executionId, "finish_execution", {}, second.executionId),
  ).toMatchObject({ result: { isError: true } });
});

test("new-agent policy isolates arrivals and incompatible targets fail while the agent is busy", async () => {
  const f = await fixture();
  const a = await f.arrival(null);
  const b = await f.arrival(null);
  expect((await a.dispatch()).agentId).not.toBe((await b.dispatch()).agentId);
  const first = await f.arrival();
  await first.dispatch();
  const changed = await f.arrival("conversation", "different-daemon");
  await expect(changed.dispatch()).rejects.toThrow("Continuation settings differ");
  expect(f.connection.creates).toHaveLength(3);
});

test("incompatible settings replace an idle agent and detach the previous session", async () => {
  const f = await fixture();
  const first = await f.arrival();
  const original = await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  const previous = (await f.execution(first.executionId)).agentSessionId!;
  const changed = await f.arrival("conversation", "different-daemon");
  const replacement = await changed.dispatch();
  expect(replacement).toMatchObject({ action: "created" });
  expect(replacement.agentId).not.toBe(original.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(await f.database.findAgentSession(previous)).toMatchObject({ continuationKey: null });
  const current = (await f.execution(changed.executionId)).agentSessionId!;
  expect(current).not.toBe(previous);
  const keyed = await f.database.findAgentSessionByKey("project", "conversation");
  expect(keyed?.id).toBe(current);
  expect(f.logs).toEqual([
    expect.objectContaining({
      level: 30,
      previousSessionId: previous,
      sessionId: current,
      continuation: "conversation",
      msg: "replaced agent session with incompatible continuation settings",
    }),
  ]);
  const next = await f.arrival("conversation", "different-daemon");
  const continued = await next.dispatch();
  expect(continued).toMatchObject({ agentId: replacement.agentId, action: "continued" });
});

test("a session that keeps changing under dispatch fails instead of retrying forever", async () => {
  const database = createMemoryDatabase();
  const save = database.saveAgentSession.bind(database);
  let saves = 0;
  // Pretend another dispatcher keeps restoring the stale key after each detach.
  database.saveAgentSession = async (session) => {
    if (session.continuationKey !== null) return save(session);
    saves++;
  };
  const f = await fixture(Date.now, database);
  const first = await f.arrival();
  await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  const changed = await f.arrival("conversation", "different-daemon");
  await expect(changed.dispatch()).rejects.toThrow("agent_session_unsettled");
  expect(saves).toBe(3);
  expect(f.connection.creates).toHaveLength(1);
});

test("ordinary launches use agent sessions and preserve long prompts without enabling continuation", async () => {
  const f = await fixture();
  const prompt = "Investigate this request.\n" + "Full request context. ".repeat(1_000);
  const first = await f.arrival(false, "daemon", {}, prompt);
  const second = await f.arrival(false, "daemon", {}, prompt);
  const a = await first.dispatch();
  const replay = await first.dispatch();
  const b = await second.dispatch();
  expect(replay.agentId).toBe(a.agentId);
  expect(b.agentId).not.toBe(a.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(f.connection.deliveries).toEqual([
    { agentId: a.agentId, text: prompt },
    { agentId: b.agentId, text: prompt },
  ]);
});

test("steering keeps the active agent's scoped credentials instead of requiring a new agent", async () => {
  const f = await fixture();
  const env = { TOKEN: "${{ paseo.connections.support.token }}" };
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.arrival("conversation", "daemon", env, "first request", { github });
  const original = await first.dispatch();
  const next = await f.arrival("conversation", "daemon", env, "follow-up", { github });
  expect(await next.dispatch()).toMatchObject({ agentId: original.agentId, action: "continued" });
  expect(f.connection.creates).toHaveLength(1);
  expect(f.connection.creates[0]?.env).toEqual({ GH_TOKEN: "scoped-github-token" });
  expect(f.connection.deliveries).toHaveLength(2);
});

test("steering cannot extend the active agent's original max-runtime deadline", async () => {
  const f = await fixture();
  const deadlineAt = new Date("2030-01-01T01:00:00Z");
  const first = await f.arrival("conversation", "daemon", {}, "first request", { deadlineAt });
  await first.dispatch();
  const next = await f.arrival("conversation", "daemon", {}, "follow-up", {
    deadlineAt: new Date("2030-01-01T01:30:00Z"),
  });
  await next.dispatch();
  expect((await f.execution(first.executionId)).deadlineAt).toEqual(deadlineAt);
  expect((await f.execution(next.executionId)).deadlineAt).toEqual(deadlineAt);
});

test("a completed credentialed task gets a fresh agent and isolates the previous agent's tools", async () => {
  const f = await fixture();
  const github = {
    connection: "getpaseo-github",
    repositories: ["getpaseo/paseo"],
    permissions: { contents: "write" as const },
    durationMs: 60 * 60 * 1000,
  };
  const first = await f.arrival("conversation", "daemon", {}, "first", { github });
  const original = await first.dispatch();
  await f.database.transitionAgentExecution(first.executionId, "succeeded");
  await f.sessions.releaseAuthority(await f.execution(first.executionId), async () => {});
  const next = await f.arrival("conversation", "daemon", {}, "next task", { github });
  const fresh = await next.dispatch();
  expect(fresh.agentId).not.toBe(original.agentId);
  expect(f.connection.creates).toHaveLength(2);
  expect(await f.call(next.executionId, "finish_execution", {}, first.executionId)).toMatchObject({
    result: { isError: true },
  });
});

test("a ping cannot send more work after the inherited deadline while timeout cleanup is pending", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const f = await fixture(() => now);
  const first = await f.arrival("conversation", "daemon", {}, "first", {
    deadlineAt: new Date(now + 1000),
  });
  await first.dispatch();
  now += 1000;
  const next = await f.arrival("conversation", "daemon", {}, "too late", {
    deadlineAt: new Date(now + 1000),
  });
  await expect(next.dispatch()).rejects.toThrow("execution_deadline_exceeded");
  expect(f.connection.deliveries).toHaveLength(1);
});
