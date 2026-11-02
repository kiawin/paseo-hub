import assert from "node:assert/strict";
import type { QueryRow } from "../runtime/index.js";

/** Runs one statement against the database under test, whichever engine it is. */
export type UpgradeQuery = (text: string, values?: unknown[]) => Promise<{ rows: QueryRow[] }>;

/** The migration that keys provider settings by app, so Slack can run more than one. */
export const MULTI_SLACK_APPS_MIGRATION = "0050_multi_slack_apps";
/** The migration just before it: the single-app shape the upgrade starts from. */
export const SINGLE_APP_MIGRATION = "0049_github_installation_syncs";

const PROVIDERS = [
  {
    provider: "discord",
    // Discord's verified identity is the bot user, which differs from the configured application.
    configuration: {
      provider: "discord",
      applicationId: "D-APP",
      clientSecret: "secret",
      botToken: "token",
    },
    identityId: "D-BOT",
    version: 1,
  },
  {
    provider: "github",
    configuration: { provider: "github", appId: "42", appSlug: "hub" },
    identityId: "42",
    version: 2,
  },
  {
    provider: "linear",
    configuration: { provider: "linear", clientId: "L-CLIENT" },
    identityId: "L-CLIENT",
    version: 5,
  },
  {
    provider: "slack",
    configuration: { provider: "slack", transport: "socket", appId: "A-SIAN" },
    identityId: "A-SIAN",
    version: 3,
  },
] as const;

/** Seeds one configured and activated app per provider, plus an owned and a legacy Slack connection. */
export async function seedSingleAppProviders(query: UpgradeQuery): Promise<void> {
  await query(`insert into organization (id, name, slug) values ('org', 'Org', 'org')`);
  for (const entry of PROVIDERS) {
    await query(
      `insert into runtime_provider_configuration
         (provider, configuration, verified_external_identity, version, verified_at, updated_at)
       values ($1, $2, $3, $4, now(), now())`,
      [
        entry.provider,
        JSON.stringify(entry.configuration),
        JSON.stringify({ provider: entry.provider, id: entry.identityId, name: entry.identityId }),
        entry.version,
      ],
    );
    await query(
      `insert into runtime_provider_activation
         (provider, provider_application_id, configuration_version)
       values ($1, $2, $3)`,
      [entry.provider, entry.identityId, entry.version],
    );
  }
  await query(
    `insert into slack_connections
       (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token,
        provider_application_id)
     values ('org', 'T1', 'slack-t1', 'Acme', 'U-SIAN', 'xoxb-sian', 'A-SIAN'),
            ('org', 'T2', 'legacy-slack', 'Legacy', 'U-OLD', 'xoxb-old', null)`,
  );
}

/** Proves the upgrade kept every app, version, activation and slug, and opened Slack to more apps. */
export async function assertMultiSlackUpgrade(query: UpgradeQuery): Promise<void> {
  const configurations = await query(
    `select provider, application_id, version from runtime_provider_configuration order by provider`,
  );
  assert.deepEqual(
    configurations.rows,
    PROVIDERS.map((entry) => ({
      provider: entry.provider,
      application_id: entry.identityId,
      version: entry.version,
    })),
  );
  const activations = await query(
    `select provider, provider_application_id, configuration_version
     from runtime_provider_activation order by provider`,
  );
  assert.deepEqual(
    activations.rows,
    PROVIDERS.map((entry) => ({
      provider: entry.provider,
      provider_application_id: entry.identityId,
      configuration_version: entry.version,
    })),
  );
  const connections = await query(
    `select team_id, provider_application_id, slug from slack_connections order by team_id`,
  );
  assert.deepEqual(connections.rows, [
    { team_id: "T1", provider_application_id: "A-SIAN", slug: "slack-t1" },
    { team_id: "T2", provider_application_id: "A-SIAN", slug: "legacy-slack" },
  ]);

  await assert.rejects(
    query(
      `insert into runtime_provider_configuration
         (provider, application_id, configuration, verified_external_identity, verified_at)
       values ('github', '43', '{}', '{}', now())`,
    ),
    /single_app_unique|duplicate key/u,
  );
  await assert.rejects(
    query(
      `insert into runtime_provider_activation
         (provider, provider_application_id, configuration_version)
       values ('github', '43', 1)`,
    ),
    /single_app_unique|duplicate key/u,
  );
  await query(
    `insert into runtime_provider_configuration
       (provider, application_id, configuration, verified_external_identity, verified_at)
     values ('slack', 'A-MOE', '{}', '{}', now())`,
  );
  await query(
    `insert into runtime_provider_activation
       (provider, provider_application_id, configuration_version)
     values ('slack', 'A-MOE', 1)`,
  );
  await query(
    `insert into slack_connections
       (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token,
        provider_application_id)
     values ('org', 'T1', 'slack-t1-a-moe', 'Acme', 'U-MOE', 'xoxb-moe', 'A-MOE')`,
  );
  await assert.rejects(
    query(
      `insert into slack_connections
         (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token,
          provider_application_id)
       values ('org', 'T1', 'slack-t1-again', 'Acme', 'U-SIAN', 'xoxb-sian', 'A-SIAN')`,
    ),
    /application_team_unique|duplicate key/u,
  );
}
