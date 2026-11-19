import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, beforeEach, it } from "vitest";
import { embeddedDatabaseRuntime, type DatabaseRuntimeBundle } from "./index.js";
import {
  assertMultiSlackUpgrade,
  MULTI_SLACK_APPS_MIGRATION,
  MULTI_SLACK_APPS_PRE_RENUMBER_WHEN,
  seedSingleAppProviders,
  SINGLE_APP_MIGRATION,
} from "../test-utils/multi-slack-upgrade.js";

let root: string;
let activeRuntime: DatabaseRuntimeBundle | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hub-pglite-migration-"));
});

afterEach(async () => {
  await activeRuntime?.runtime.close();
  activeRuntime = undefined;
  await rm(root, { recursive: true, force: true });
});

it("keys provider settings by app and keeps single-app data when opening Slack to more apps", async () => {
  const dataDirectory = join(root, "database");
  await applyMigrationsThrough(dataDirectory, SINGLE_APP_MIGRATION, async (client) => {
    await seedSingleAppProviders((text, values) => client.query(text, values));
  });

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  await activeRuntime.runtime.migrate();
  const runtime = activeRuntime.runtime;
  await assertMultiSlackUpgrade((text, values) => runtime.query(text, values));
}, 120_000);

it("upgrades a database that applied the multi-Slack migration before it was renumbered", async () => {
  const dataDirectory = join(root, "database");
  await applyMigrationsThrough(dataDirectory, SINGLE_APP_MIGRATION, async (client) => {
    await seedSingleAppProviders((text, values) => client.query(text, values));
    // An older fork release shipped this migration under an earlier number and "when", so the
    // runtime sees it as not yet applied and runs it a second time.
    const migration = await journalMigration(MULTI_SLACK_APPS_MIGRATION);
    for (const statement of migration.sql) await client.exec(statement);
    await client.query(
      `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
      [migration.hash, MULTI_SLACK_APPS_PRE_RENUMBER_WHEN],
    );
  });

  activeRuntime = await embeddedDatabaseRuntime(dataDirectory);
  await activeRuntime.runtime.migrate();
  const runtime = activeRuntime.runtime;
  await assertMultiSlackUpgrade((text, values) => runtime.query(text, values));
}, 120_000);

async function journalWhen(tag: string): Promise<number> {
  const journal = (await import("../../../drizzle/meta/_journal.json", { with: { type: "json" } }))
    .default as { entries: { tag: string; when: number }[] };
  const entry = journal.entries.find((candidate) => candidate.tag === tag);
  if (entry === undefined) throw new Error(`migration is absent from the journal: ${tag}`);
  return entry.when;
}

async function journalMigration(tag: string) {
  const when = await journalWhen(tag);
  const migration = readMigrationFiles({ migrationsFolder: join(process.cwd(), "drizzle") }).find(
    (candidate) => candidate.folderMillis === when,
  );
  if (migration === undefined) throw new Error(`migration file is missing: ${tag}`);
  return migration;
}

/** Builds an embedded database as an older Hub left it, the way the embedded runtime migrates. */
async function applyMigrationsThrough(
  dataDirectory: string,
  through: string,
  seed: (client: PGlite) => Promise<void>,
): Promise<void> {
  const migrations = readMigrationFiles({ migrationsFolder: join(process.cwd(), "drizzle") });
  const lastWhen = await journalWhen(through);
  const client = new PGlite(dataDirectory);
  try {
    await client.exec(`
      create schema if not exists drizzle;
      create table if not exists drizzle.__drizzle_migrations (
        id serial primary key,
        hash text not null,
        created_at bigint
      );
    `);
    for (const migration of migrations) {
      if (migration.folderMillis > lastWhen) break;
      for (const statement of migration.sql) await client.exec(statement);
      await client.query(
        `insert into drizzle.__drizzle_migrations (hash, created_at) values ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
    }
    await seed(client);
  } finally {
    await client.close();
  }
}
