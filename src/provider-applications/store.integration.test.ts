import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, it } from "vitest";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "../db/runtime/index.js";
import { createDatabase } from "../db/pg.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import {
  createProviderApplicationInventory,
  createProviderApplicationStore,
  type ProviderApplicationConfiguration,
} from "./index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider application persistence", () => {
  it("persists, versions, and reopens write-only provider configuration in PGlite", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-provider-applications-"));
    roots.push(root);
    const first = await embeddedDatabaseRuntime(root);
    await exercisePersistence(first);
    await exerciseSlackAtomicTransition(first);
    await exerciseSeveralSlackApps(first);
    await exerciseLinearScopeHealth(first);
    await first.runtime.close();

    const reopened = await embeddedDatabaseRuntime(root);
    await reopened.runtime.migrate();
    const stored = await createProviderApplicationStore(reopened.runtime, reopened.locks).read(
      "github",
    );
    assert.equal(stored?.version, 2);
    assert.equal(stored?.configuration.provider, "github");
    if (stored?.configuration.provider === "github") {
      assert.equal(stored.configuration.clientSecret, "rotated");
    }
    await reopened.runtime.close();
  });

  it("persists and serializes concurrent first saves in PostgreSQL", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    try {
      const bundle = await postgresDatabaseRuntime(postgres.getConnectionUri());
      await exercisePersistence(bundle);
      await exerciseSlackAtomicTransition(bundle);
      await exerciseSeveralSlackApps(bundle);
      await exerciseLinearScopeHealth(bundle);
      await bundle.runtime.close();

      const reopened = await postgresDatabaseRuntime(postgres.getConnectionUri());
      const stored = await createProviderApplicationStore(reopened.runtime, reopened.locks).read(
        "github",
      );
      assert.equal(stored?.version, 2);
      await reopened.runtime.close();
    } finally {
      await postgres.stop();
    }
  });
});

async function exercisePersistence(bundle: DatabaseRuntimeBundle) {
  await bundle.runtime.migrate();
  await bundle.runtime.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                         must_change_password, is_instance_operator)
     values ('operator', 'Operator', 'operator@example.test', true, now(), now(), false, true)`,
  );
  const store = createProviderApplicationStore(bundle.runtime, bundle.locks);
  const configuration = {
    provider: "github" as const,
    appId: "42",
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "secret",
    privateKey: "private-key",
    webhookSecret: "webhook-secret",
  };
  const identity = {
    provider: "github" as const,
    id: "42",
    name: "Paseo",
    ownerLogin: "acme",
  };
  const attempts = await Promise.allSettled([
    store.save({
      provider: "github",
      configuration,
      identity,
      expectedVersion: undefined,
      updatedByUserId: "operator",
    }),
    store.save({
      provider: "github",
      configuration,
      identity,
      expectedVersion: undefined,
      updatedByUserId: "operator",
    }),
  ]);
  assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = attempts.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected");
  assert.equal(
    rejected.reason instanceof Error ? rejected.reason.name : undefined,
    "ProviderConfigurationConflictError",
  );

  const rotated = await store.save({
    provider: "github",
    configuration: { ...configuration, clientSecret: "rotated" },
    identity,
    expectedVersion: 1,
    updatedByUserId: "operator",
  });
  assert.equal(rotated.version, 2);
}

async function exerciseSlackAtomicTransition(bundle: DatabaseRuntimeBundle) {
  const database = createDatabase(bundle.runtime, bundle.locks);
  await bundle.runtime.query(
    `insert into organization (id, name, slug) values ('org', 'Org', 'org')`,
  );
  await bundle.runtime.query(
    `insert into session (id, token, user_id, active_organization_id, expires_at)
     values ('session', 'session-token', 'operator', 'org', now() + interval '1 hour')`,
  );
  await bundle.runtime.query(
    `insert into member (id, organization_id, user_id, role)
     values ('member', 'org', 'operator', 'owner')`,
  );
  const configuration = {
    provider: "slack" as const,
    transport: "webhook" as const,
    appId: "A1",
    clientId: "client",
    clientSecret: "secret",
    signingSecret: "signing-secret",
  };
  const store = createProviderApplicationStore(bundle.runtime, bundle.locks, database);
  const startAttempt = async (stateVerifier: string, expectedVersion: number | null) => {
    await database.startConnectionAttempt({
      provider: "slack",
      stateVerifier,
      access: {
        sessionId: "session",
        userId: "operator",
        membershipId: "member",
        organizationId: "org",
        returnRoute: "/settings/apps",
      },
      lifetimeMinutes: 10,
      configurationVersion: (expectedVersion ?? 0) + 1,
      providerApplicationId: configuration.appId,
      callbackOrigin: "https://hub.test",
      configurationSnapshot: configuration,
      expectedConfigurationVersion: expectedVersion,
      activateConfiguration: true,
    });
  };
  const complete = (stateVerifier: string, teamId: string, expectedVersion: number | undefined) =>
    store.completeSlackInstallation({
      configuration,
      identity: { provider: "slack", id: "A1", name: "Acme" },
      expectedVersion,
      updatedByUserId: "operator",
      binding: {
        providerApplicationId: "A1",
        stateVerifier,
        phase: "slack_authorization",
        access: { sessionId: "session", userId: "operator" },
        teamId,
        teamName: "Acme",
        botUserId: "UBOT",
        botAccessToken: "xoxb-token",
        scopes: ["chat:write"],
      },
    });

  await startAttempt("state-ok", null);
  await complete("state-ok", "T1", undefined);
  assert.equal((await store.read("slack"))?.version, 1);
  assert.equal((await database.findSlackConnection("T1"))?.providerApplicationId, "A1");
  assert.equal(
    (await createProviderApplicationInventory(bundle.runtime).connectedIdentities("slack"))[0]
      ?.status,
    "actionNeeded",
  );

  await startAttempt("state-conflict", 1);
  await assert.rejects(() => complete("state-conflict", "T2", 99));
  assert.equal(await database.findSlackConnection("T2"), undefined);
  assert.equal((await store.read("slack"))?.version, 1);
  assert.equal(
    (
      await bundle.runtime.query<{ consumed_at: Date | null }>(
        `select consumed_at from organization_connection_attempts where state_verifier = 'state-conflict'`,
      )
    ).rows[0]?.consumed_at,
    null,
  );

  await bundle.runtime.query(
    `create function reject_slack_attempt_consumption() returns trigger language plpgsql as $$
       begin
         if new.state_verifier = 'state-crash' and new.consumed_at is not null then
           raise exception 'simulated crash boundary';
         end if;
         return new;
       end;
     $$`,
  );
  await bundle.runtime.query(
    `create trigger reject_slack_attempt_consumption
     before update on organization_connection_attempts
     for each row execute function reject_slack_attempt_consumption()`,
  );
  await startAttempt("state-crash", 1);
  await assert.rejects(
    () => complete("state-crash", "T3", 1),
    (error: unknown) =>
      error !== null &&
      typeof error === "object" &&
      String(Reflect.get(Reflect.get(error, "cause") ?? {}, "message")) ===
        "simulated crash boundary",
  );
  assert.equal(await database.findSlackConnection("T3"), undefined);
  assert.equal((await store.read("slack"))?.version, 1);
  assert.equal(
    (
      await bundle.runtime.query<{ consumed_at: Date | null }>(
        `select consumed_at from organization_connection_attempts where state_verifier = 'state-crash'`,
      )
    ).rows[0]?.consumed_at,
    null,
  );

  const socket = await store.completeSlackSocketApplication({
    configuration: {
      provider: "slack",
      transport: "socket",
      appId: "A1",
      appToken: "xapp-secret",
    },
    identity: { provider: "slack", id: "A1", name: "A1" },
    expectedVersion: 1,
    updatedByUserId: "operator",
    organizationId: "org",
    installation: {
      appId: "A1",
      teamId: "T2",
      teamName: "Socket Workspace",
      botUserId: "UBOT2",
      botAccessToken: "xoxb-socket",
      scopes: [
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "files:read",
        "groups:history",
        "reactions:write",
        "users:read",
      ],
    },
  });
  assert.equal(socket.version, 2);
  assert.equal(socket.configuration.provider, "slack");
  assert.equal(
    socket.configuration.provider === "slack" ? socket.configuration.transport : undefined,
    "socket",
  );
  assert.equal((await database.findSlackConnection("T2"))?.providerApplicationId, "A1");
}

/** Runs after `exerciseSlackAtomicTransition`, which leaves app A1 at version 2 with two teams. */
async function exerciseSeveralSlackApps(bundle: DatabaseRuntimeBundle) {
  const database = createDatabase(bundle.runtime, bundle.locks);
  const store = createProviderApplicationStore(bundle.runtime, bundle.locks, database);
  const webhook = (appId: string) => ({
    provider: "slack" as const,
    transport: "webhook" as const,
    appId,
    clientId: `client-${appId}`,
    clientSecret: `secret-${appId}`,
    signingSecret: `signing-${appId}`,
  });
  const identity = (appId: string) => ({ provider: "slack" as const, id: appId, name: appId });
  const snapshot = async (appId: string) => {
    const configuration = await bundle.runtime.query<{ version: number }>(
      `select version, configuration::text as configuration, verified_external_identity::text
              as identity, updated_at
       from runtime_provider_configuration where provider = 'slack' and application_id = $1`,
      [appId],
    );
    const activation = await bundle.runtime.query<{ configuration_version: number }>(
      `select configuration_version, activated_at from runtime_provider_activation
       where provider = 'slack' and provider_application_id = $1`,
      [appId],
    );
    return { configuration: configuration.rows, activation: activation.rows };
  };
  const startAttempt = (
    stateVerifier: string,
    configuration: ProviderApplicationConfiguration,
    configurationVersion: number,
    expectedVersion: number | null,
    activateConfiguration: boolean,
  ) =>
    database.startConnectionAttempt({
      provider: "slack",
      stateVerifier,
      access: {
        sessionId: "session",
        userId: "operator",
        membershipId: "member",
        organizationId: "org",
        returnRoute: "/settings/apps",
      },
      lifetimeMinutes: 10,
      configurationVersion,
      providerApplicationId: configuration.provider === "slack" ? configuration.appId : "",
      callbackOrigin: "https://hub.test",
      configurationSnapshot: configuration,
      expectedConfigurationVersion: expectedVersion,
      activateConfiguration,
    });
  let a = await snapshot("A1");
  assert.equal(a.configuration[0]?.version, 2);

  // App B through save and activate. App A owns connections; they do not conflict with B.
  const savedB = await store.save({
    provider: "slack",
    configuration: webhook("B1"),
    identity: identity("B1"),
    expectedVersion: undefined,
    updatedByUserId: "operator",
  });
  assert.equal(savedB.version, 1);
  await store.activate({ provider: "slack", identity: identity("B1"), configurationVersion: 1 });
  assert.deepEqual(await snapshot("A1"), a);
  assert.equal((await store.read("slack", "B1"))?.version, 1);
  assert.equal((await store.read("slack", "A1"))?.version, 2);
  await assert.rejects(() => store.read("slack"), /several/u);
  assert.deepEqual(
    (await store.list("slack")).map((application) => application.identity.id),
    ["A1", "B1"],
  );
  const b = await snapshot("B1");

  // A version conflict on A leaves B untouched.
  await assert.rejects(
    () =>
      store.save({
        provider: "slack",
        configuration: webhook("A1"),
        identity: identity("A1"),
        expectedVersion: 1,
        updatedByUserId: "operator",
      }),
    (error: unknown) =>
      error instanceof Error && error.name === "ProviderConfigurationConflictError",
  );
  assert.deepEqual(await snapshot("A1"), a);
  assert.deepEqual(await snapshot("B1"), b);

  // A successful change to A leaves B untouched.
  const changedA = await store.save({
    provider: "slack",
    configuration: {
      provider: "slack",
      transport: "socket",
      appId: "A1",
      appToken: "xapp-rotated",
    },
    identity: identity("A1"),
    expectedVersion: 2,
    updatedByUserId: "operator",
  });
  assert.equal(changedA.version, 3);
  assert.deepEqual(await snapshot("B1"), b);
  a = await snapshot("A1");

  // App C through Socket Mode, fresh.
  const socketC = await store.completeSlackSocketApplication({
    configuration: { provider: "slack", transport: "socket", appId: "C1", appToken: "xapp-c" },
    identity: identity("C1"),
    expectedVersion: undefined,
    updatedByUserId: "operator",
    organizationId: "org",
    installation: {
      appId: "C1",
      teamId: "T21",
      teamName: "Socket C",
      botUserId: "UBOT-C",
      botAccessToken: "xoxb-c",
      scopes: [...SLACK_REQUIRED_BOT_SCOPES],
    },
  });
  assert.equal(socketC.version, 1);
  assert.deepEqual(await snapshot("A1"), a);
  assert.deepEqual(await snapshot("B1"), b);
  assert.equal((await snapshot("C1")).activation[0]?.configuration_version, 1);

  // Changing C through Socket Mode leaves A and B untouched.
  const rotatedC = await store.completeSlackSocketApplication({
    configuration: { provider: "slack", transport: "socket", appId: "C1", appToken: "xapp-c2" },
    identity: identity("C1"),
    expectedVersion: 1,
    updatedByUserId: "operator",
    organizationId: "org",
    installation: {
      appId: "C1",
      teamId: "T21",
      teamName: "Socket C",
      botUserId: "UBOT-C",
      botAccessToken: "xoxb-c2",
      scopes: [...SLACK_REQUIRED_BOT_SCOPES],
    },
  });
  assert.equal(rotatedC.version, 2);
  assert.deepEqual(await snapshot("A1"), a);
  assert.deepEqual(await snapshot("B1"), b);
  const c = await snapshot("C1");
  assert.equal(c.activation[0]?.configuration_version, 2);

  // An OAuth attempt for B is checked against B's activation, not A's version.
  const bindB = (stateVerifier: string, teamId: string) =>
    database.bindSlackConnection({
      stateVerifier,
      access: { sessionId: "session", userId: "operator" },
      providerApplicationId: "B1",
      phase: "slack_authorization",
      teamId,
      teamName: "Workspace B",
      botUserId: "UBOT-B",
      botAccessToken: "xoxb-b",
      scopes: [...SLACK_REQUIRED_BOT_SCOPES],
    });
  await startAttempt("state-b-at-a-version", webhook("B1"), 2, null, false);
  await assert.rejects(() => bindB("state-b-at-a-version", "T20"));
  await startAttempt("state-b-current", webhook("B1"), 1, null, false);
  await bindB("state-b-current", "T20");
  assert.equal((await database.findSlackConnection("T20"))?.providerApplicationId, "B1");

  // B's webhook install through bindSlackTransition moves only B.
  const rotatedB = { ...webhook("B1"), clientSecret: "secret-B1-rotated" };
  await startAttempt("state-b-install", rotatedB, 2, 1, true);
  await store.completeSlackInstallation({
    configuration: rotatedB,
    identity: identity("B1"),
    expectedVersion: 1,
    updatedByUserId: "operator",
    binding: {
      providerApplicationId: "B1",
      stateVerifier: "state-b-install",
      phase: "slack_authorization",
      access: { sessionId: "session", userId: "operator" },
      teamId: "T22",
      teamName: "Workspace B2",
      botUserId: "UBOT-B2",
      botAccessToken: "xoxb-b2",
      scopes: [...SLACK_REQUIRED_BOT_SCOPES],
    },
  });
  assert.equal((await store.read("slack", "B1"))?.version, 2);
  assert.equal((await snapshot("B1")).activation[0]?.configuration_version, 2);
  assert.deepEqual(await snapshot("A1"), a);
  assert.deepEqual(await snapshot("C1"), c);

  // A connection from before apps were recorded still conflicts with every new Slack app.
  await bundle.runtime.query(
    `insert into slack_connections
       (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token)
     values ('org', 'T30', 'legacy-slack', 'Legacy', 'U-OLD', 'xoxb-old')`,
  );
  await assert.rejects(
    () =>
      store.save({
        provider: "slack",
        configuration: webhook("D1"),
        identity: identity("D1"),
        expectedVersion: undefined,
        updatedByUserId: "operator",
      }),
    (error: unknown) =>
      error instanceof Error && error.name === "ProviderApplicationIdentityConflictError",
  );
  await startAttempt("state-d-install", webhook("D1"), 1, null, true);
  await assert.rejects(() =>
    store.completeSlackInstallation({
      configuration: webhook("D1"),
      identity: identity("D1"),
      expectedVersion: undefined,
      updatedByUserId: "operator",
      binding: {
        providerApplicationId: "D1",
        stateVerifier: "state-d-install",
        phase: "slack_authorization",
        access: { sessionId: "session", userId: "operator" },
        teamId: "T31",
        teamName: "Workspace D",
        botUserId: "UBOT-D",
        botAccessToken: "xoxb-d",
        scopes: [...SLACK_REQUIRED_BOT_SCOPES],
      },
    }),
  );
  assert.deepEqual(await snapshot("D1"), { configuration: [], activation: [] });
  assert.equal(await database.findSlackConnection("T31"), undefined);
  await bundle.runtime.query(`delete from slack_connections where team_id = 'T30'`);

  // Every other provider keeps one app: a second GitHub app is refused and the first stays.
  await assert.rejects(
    () =>
      store.save({
        provider: "github",
        configuration: {
          provider: "github",
          appId: "43",
          appSlug: "second",
          clientId: "client-43",
          clientSecret: "secret-43",
          privateKey: "private-key-43",
          webhookSecret: "webhook-secret-43",
        },
        identity: { provider: "github", id: "43", name: "Second", ownerLogin: "acme" },
        expectedVersion: undefined,
        updatedByUserId: "operator",
      }),
    (error: unknown) =>
      error instanceof Error && error.name === "ProviderConfigurationConflictError",
  );
  assert.deepEqual(
    (await store.list("github")).map((application) => [
      application.identity.id,
      application.version,
    ]),
    [["42", 2]],
  );
}

async function exerciseLinearScopeHealth(bundle: DatabaseRuntimeBundle) {
  await bundle.runtime.query(
    `insert into linear_connections
       (organization_id, linear_organization_id, provider_application_id, slug,
        linear_organization_name, app_user_id, access_token, scopes, connected_by_user_id)
     values ('org', 'linear-org', 'linear-app', 'acme-linear', 'Acme', 'linear-app-user',
             'linear-token', '["read"]'::jsonb, 'operator')`,
  );

  assert.equal(
    (await createProviderApplicationInventory(bundle.runtime).connectedIdentities("linear"))[0]
      ?.status,
    "actionNeeded",
  );

  await bundle.runtime.query(
    `update linear_connections
     set scopes = '["read", "comments:create"]'::jsonb,
         access_token_expires_at = '2000-01-01T00:00:00.000Z',
         refresh_token = null
     where linear_organization_id = 'linear-org'`,
  );
  assert.equal(
    (await createProviderApplicationInventory(bundle.runtime).connectedIdentities("linear"))[0]
      ?.status,
    "actionNeeded",
  );

  await bundle.runtime.query(
    `update linear_connections set refresh_token = 'linear-refresh-token'
     where linear_organization_id = 'linear-org'`,
  );
  assert.equal(
    (await createProviderApplicationInventory(bundle.runtime).connectedIdentities("linear"))[0]
      ?.status,
    "connected",
  );
}
