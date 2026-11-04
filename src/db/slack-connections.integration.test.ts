import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { afterEach, describe, it } from "vitest";
import { createProviderApplicationStore } from "../provider-applications/index.js";
import { SLACK_REQUIRED_BOT_SCOPES } from "../providers/slack/client.js";
import { createDatabase } from "./pg.js";
import {
  embeddedDatabaseRuntime,
  postgresDatabaseRuntime,
  type DatabaseRuntimeBundle,
} from "./runtime/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Slack connections of several apps in one workspace", () => {
  it("keeps each app's connection apart in PGlite", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-slack-connections-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(root);
    try {
      await exerciseSharedWorkspace(bundle);
    } finally {
      await bundle.runtime.close();
    }
  });

  it("keeps each app's connection apart and serializes workspace installs in PostgreSQL", async () => {
    const postgres = await new PostgreSqlContainer("postgres:17-alpine").start();
    try {
      const bundle = await postgresDatabaseRuntime(postgres.getConnectionUri());
      try {
        await exerciseSharedWorkspace(bundle);
      } finally {
        await bundle.runtime.close();
      }
    } finally {
      await postgres.stop();
    }
  });
});

async function exerciseSharedWorkspace(bundle: DatabaseRuntimeBundle) {
  await bundle.runtime.migrate();
  await seedOrganization(bundle, "org", "operator");
  await seedOrganization(bundle, "other", "intruder");
  const database = createDatabase(bundle.runtime, bundle.locks);
  const store = createProviderApplicationStore(bundle.runtime, bundle.locks, database);
  const row = async (applicationId: string, teamId: string) =>
    (
      await bundle.runtime.query<{ row: string }>(
        `select row_to_json(slack_connections)::text as row from slack_connections
         where provider_application_id = $1 and team_id = $2`,
        [applicationId, teamId],
      )
    ).rows[0]?.row;
  const slugOf = async (applicationId: string, teamId: string) =>
    (await database.findSlackConnection(applicationId, teamId))?.slug;

  const socket = (
    applicationId: string,
    teamId: string,
    organizationId: string,
    expectedVersion: number | undefined,
    token = `xoxb-${applicationId}`,
  ) =>
    store.completeSlackSocketApplication({
      configuration: {
        provider: "slack",
        transport: "socket",
        appId: applicationId,
        appToken: `xapp-${applicationId}`,
      },
      identity: { provider: "slack", id: applicationId, name: applicationId },
      expectedVersion,
      updatedByUserId: userOf(organizationId),
      organizationId,
      installation: {
        appId: applicationId,
        teamId,
        teamName: "Acme",
        botUserId: `U-${applicationId}`,
        botAccessToken: token,
        scopes: [...SLACK_REQUIRED_BOT_SCOPES],
      },
    });

  const webhook = async (
    applicationId: string,
    teamId: string,
    organizationId: string,
    expectedVersion: number | undefined,
    stateVerifier: string,
  ) => {
    const configuration = {
      provider: "slack" as const,
      transport: "webhook" as const,
      appId: applicationId,
      clientId: `client-${applicationId}`,
      clientSecret: `secret-${stateVerifier}`,
      signingSecret: `signing-${applicationId}`,
    };
    await database.startConnectionAttempt({
      provider: "slack",
      stateVerifier,
      access: {
        sessionId: `session-${organizationId}`,
        userId: userOf(organizationId),
        membershipId: `member-${organizationId}`,
        organizationId,
        returnRoute: "/settings/apps",
      },
      lifetimeMinutes: 10,
      configurationVersion: (expectedVersion ?? 0) + 1,
      providerApplicationId: applicationId,
      callbackOrigin: "https://hub.test",
      configurationSnapshot: configuration,
      expectedConfigurationVersion: expectedVersion ?? null,
      activateConfiguration: true,
    });
    return store.completeSlackInstallation({
      configuration,
      identity: { provider: "slack", id: applicationId, name: applicationId },
      expectedVersion,
      updatedByUserId: userOf(organizationId),
      binding: {
        providerApplicationId: applicationId,
        stateVerifier,
        phase: "slack_authorization",
        access: { sessionId: `session-${organizationId}`, userId: userOf(organizationId) },
        teamId,
        teamName: "Acme",
        botUserId: `U-${applicationId}`,
        botAccessToken: `xoxb-${applicationId}`,
        scopes: [...SLACK_REQUIRED_BOT_SCOPES],
      },
    });
  };

  // App A joins workspace T1 first and keeps the plain workspace slug.
  await socket("A1", "T1", "org", undefined);
  assert.equal(await slugOf("A1", "T1"), "slack-t1");
  const a = await row("A1", "T1");

  // App B joins the same workspace through webhooks: its own row, bot user, token and a free slug.
  await webhook("B1", "T1", "org", undefined, "state-b");
  const b = await database.findSlackConnection("B1", "T1");
  assert.equal(b?.botUserId, "U-B1");
  assert.equal(b?.botAccessToken, "xoxb-B1");
  assert.notEqual(b?.slug, "slack-t1");
  assert.equal(await row("A1", "T1"), a);
  const bRow = await row("B1", "T1");

  // App C joins through Socket Mode and is told apart by its app id.
  await socket("C1", "T1", "org", undefined);
  assert.equal(await slugOf("C1", "T1"), "slack-t1-c1");
  assert.equal((await database.findSlackConnection("C1", "T1"))?.botAccessToken, "xoxb-C1");
  assert.equal(await row("A1", "T1"), a);
  assert.equal(await row("B1", "T1"), bRow);
  const cRow = await row("C1", "T1");

  // Reinstalling A changes only A's row, and A keeps its slug.
  await socket("A1", "T1", "org", 1, "xoxb-A1-rotated");
  assert.equal((await database.findSlackConnection("A1", "T1"))?.botAccessToken, "xoxb-A1-rotated");
  assert.equal(await slugOf("A1", "T1"), "slack-t1");
  assert.equal(await row("B1", "T1"), bRow);
  assert.equal(await row("C1", "T1"), cRow);
  const rotatedA = await row("A1", "T1");

  // A workspace belongs to one organization, whichever app joins it.
  await assert.rejects(
    () => webhook("D1", "T1", "other", undefined, "state-d"),
    (error: unknown) => error instanceof Error && error.name === "ConnectionConflictError",
  );
  await assert.rejects(
    () => socket("E1", "T1", "other", undefined),
    (error: unknown) =>
      error instanceof Error && error.name === "ProviderApplicationIdentityConflictError",
  );
  assert.equal(await database.findSlackConnection("D1", "T1"), undefined);
  assert.equal(await database.findSlackConnection("E1", "T1"), undefined);
  assert.deepEqual(
    [await row("A1", "T1"), await row("B1", "T1"), await row("C1", "T1")],
    [rotatedA, bRow, cRow],
  );

  // An event for app B in T1 belongs to B's connection, not A's.
  await database.acceptSlackEvent({
    providerApplicationId: "B1",
    teamId: "T1",
    deliveryId: "slack-B1-event",
    source: "slack.mention",
    payload: {},
    receivedAt: new Date(0),
  });
  const receipt = await bundle.runtime.query<{ connection_id: string }>(
    `select connection_id::text from provider_event_receipts where delivery_id = 'slack-B1-event'`,
  );
  assert.equal(receipt.rows[0]?.connection_id, b?.id);
  assert.deepEqual(
    await database.acceptSlackEvent({
      providerApplicationId: "Z9",
      teamId: "T1",
      deliveryId: "slack-Z9-event",
      source: "slack.mention",
      payload: {},
      receivedAt: new Date(0),
    }),
    { status: "dropped", receiptId: "slack-Z9-event", reason: "slack_unbound" },
  );

  // A connection is found by id only within its organization.
  assert.equal((await database.findSlackConnectionById("org", b.id))?.providerApplicationId, "B1");
  assert.equal(await database.findSlackConnectionById("other", b.id), undefined);

  // A callback knows which app it was started for.
  await database.startConnectionAttempt({
    provider: "slack",
    stateVerifier: "state-lookup",
    access: {
      sessionId: "session-org",
      userId: "operator",
      membershipId: "member-org",
      organizationId: "org",
      returnRoute: "/settings/apps",
    },
    lifetimeMinutes: 10,
    configurationVersion: 1,
    providerApplicationId: "B1",
    callbackOrigin: "https://hub.test",
    configurationSnapshot: { provider: "slack" },
    expectedConfigurationVersion: null,
    activateConfiguration: false,
  });
  assert.equal(
    (await database.findConnectionAttemptConfiguration("state-lookup"))?.providerApplicationId,
    "B1",
  );

  // Two apps joining one new workspace for different organizations: exactly one wins.
  const raced = await Promise.allSettled([
    socket("A1", "T9", "org", 2),
    webhook("B1", "T9", "other", 1, "state-race"),
  ]);
  assert.equal(raced.filter((result) => result.status === "fulfilled").length, 1);
  const owners = await bundle.runtime.query<{ organization_id: string }>(
    `select distinct organization_id from slack_connections where team_id = 'T9'`,
  );
  assert.equal(owners.rows.length, 1);
}

function userOf(organizationId: string): string {
  return organizationId === "org" ? "operator" : "intruder";
}

async function seedOrganization(
  bundle: DatabaseRuntimeBundle,
  organizationId: string,
  userId: string,
): Promise<void> {
  await bundle.runtime.query(
    `insert into "user" (id, name, email, email_verified, created_at, updated_at,
                         must_change_password, is_instance_operator)
     values ($1, $1, $2, true, now(), now(), false, true)`,
    [userId, `${userId}@example.test`],
  );
  await bundle.runtime.query(`insert into organization (id, name, slug) values ($1, $1, $1)`, [
    organizationId,
  ]);
  await bundle.runtime.query(
    `insert into session (id, token, user_id, active_organization_id, expires_at)
     values ($1, $1, $2, $3, now() + interval '1 hour')`,
    [`session-${organizationId}`, userId, organizationId],
  );
  await bundle.runtime.query(
    `insert into member (id, organization_id, user_id, role) values ($1, $2, $3, 'owner')`,
    [`member-${organizationId}`, organizationId, userId],
  );
}
