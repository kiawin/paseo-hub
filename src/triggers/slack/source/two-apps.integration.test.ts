import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createDatabase } from "../../../db/pg.js";
import { embeddedDatabaseRuntime } from "../../../db/runtime/index.js";
import { acceptSlackEvent } from "./internal/intake.js";
import { slackSocketSignatureHash } from "./internal/socket.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("one Slack event delivered to two apps", () => {
  it("records a receipt for each app's connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "hub-slack-two-apps-"));
    roots.push(root);
    const bundle = await embeddedDatabaseRuntime(root);
    try {
      await bundle.runtime.migrate();
      await bundle.runtime.query(
        `insert into organization (id, name, slug) values ('org', 'Org', 'org')`,
      );
      await bundle.runtime.query(
        `insert into slack_connections
           (organization_id, team_id, slug, team_name, bot_user_id, bot_access_token,
            provider_application_id)
         values ('org', 'T1', 'slack-t1', 'Acme', 'U-A', 'xoxb-a', 'A1'),
                ('org', 'T1', 'slack-t1-b1', 'Acme', 'U-B', 'xoxb-b', 'B1')`,
      );
      const database = createDatabase(bundle.runtime, bundle.locks);
      const receiptIds: string[] = [];
      // Slack hands each app the same workspace event under one event id and envelope id.
      for (const appId of ["A1", "B1"]) {
        await acceptSlackEvent(
          mention(appId),
          slackSocketSignatureHash(appId, "envelope-1"),
          new Set([() => Promise.resolve()]),
          {
            appId,
            accept: async (input) => {
              const acceptance = await database.acceptSlackEvent({
                ...input,
                providerApplicationId: appId,
              });
              receiptIds.push(acceptance.receiptId);
              return acceptance;
            },
          },
        );
      }

      assert.equal(new Set(receiptIds).size, 2);
      const receipts = await bundle.runtime.query<{
        delivery_id: string;
        provider_application_id: string;
      }>(
        `select receipt.delivery_id, connection.provider_application_id
         from provider_event_receipts receipt
         join slack_connections connection on connection.id = receipt.connection_id
         order by receipt.delivery_id`,
      );
      assert.deepEqual(receipts.rows, [
        { delivery_id: "slack-A1-Ev1", provider_application_id: "A1" },
        { delivery_id: "slack-B1-Ev1", provider_application_id: "B1" },
      ]);
    } finally {
      await bundle.runtime.close();
    }
  });
});

function mention(appId: string) {
  return {
    type: "event_callback",
    team_id: "T1",
    api_app_id: appId,
    event_id: "Ev1",
    event_time: 1_700_000_900,
    event: {
      type: "app_mention",
      user: "U123",
      channel: "C123",
      text: "<@U999> investigate",
      ts: "1700000000.000100",
      event_ts: "1700000000.000100",
    },
  };
}
