import { expect } from "@playwright/test";
import { test } from "./app.js";
import {
  SECOND_SLACK_SOCKET_CREDENTIALS,
  expectSlackDelivered,
  slackPersistedState,
} from "./helpers/apps.js";
import { slackTriggerRoutes } from "./helpers/hub.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const SHOTS = "e2e/screenshots/triggers";
const owner = {
  name: "Trigger Owner",
  email: "trigger-owner@example.com",
  password: "trigger-owner-password",
};

test("requires daemon setup before trigger configuration", async ({ hub, page }) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const triggers = new OrganizationTriggers(page);

  await triggers.open();
  await expect(page.getByRole("alert")).toContainText("Add a daemon first");
  await expect(page.getByRole("link", { name: "Go to Daemons" })).toHaveAttribute(
    "href",
    /\/o\/[^/]+\/daemons$/u,
  );
  await page.screenshot({ path: `${SHOTS}/00-no-daemon-callout.png`, fullPage: true });
  await triggers.startNew();
  await triggers.expectWaitingForDaemon();
  await triggers.exploreEventQualifiers();
  await expect(
    page.getByText("No daemon is connected to this organization yet", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Run on daemon" })).toBeHidden();
  await expect(page.getByText("Choose a daemon first", { exact: false })).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/00-no-daemons.png`, fullPage: true });
  await page.getByRole("link", { name: "Go to Daemons" }).click();
  await expect(page).toHaveURL(/\/daemons$/u);
  await expect(page.getByRole("heading", { name: "Daemons", level: 1 })).toBeVisible();
});

test("creates a trigger visually, preserves advanced YAML through the form, and explains legacy workflows", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  await hub.seedSlackConnection("owner", "company-slack", "Acme Slack");
  const triggers = new OrganizationTriggers(page);

  await test.step("the flat organization trigger list is the starting point", async () => {
    await triggers.open();
    await triggers.expectEmpty();
    await triggers.capture(`${SHOTS}/01-empty-trigger-list.png`);
  });

  await test.step("the common setup stays in one small form", async () => {
    await triggers.startNew();
    await triggers.expectDaemonPreselected(daemon);
    await page.screenshot({ path: `${SHOTS}/01b-daemon-required.png`, fullPage: true });
    await triggers.expectRefusedOnSubmit("Working directory is required.");
    await triggers.configureSlackMention({
      name: "slack-help",
      connection: "company-slack",
      daemon,
      cwd: "/workspace/acme",
      users: "U123, U456",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "high",
      providerOptions: '{"sandbox_mode":"workspace-write"}',
      prompt: "Handle the Slack request.",
    });
    await triggers.exerciseContinuity();
    await triggers.expectMergeTagsAndAutosizing();
    await triggers.expectAgentSearch();
    await triggers.expectComboboxes();
    await triggers.changePrompt("Handle the Slack request.");
    await triggers.expectDisclosureRailsAtPhoneWidth();
    await page.evaluate(() => window.scrollTo({ top: 0 }));
    await triggers.capture(`${SHOTS}/02-configured-form.png`);
    await triggers.captureInstructions(`${SHOTS}/02b-agent-instructions.png`);
    await triggers.captureExpandedAgent(`${SHOTS}/02c-expanded-model-combobox.png`);
  });

  await test.step("YAML mirrors the form and remains the canonical editable document", async () => {
    await triggers.switchToYaml();
    await page.waitForFunction(() => window.scrollY === 0);
    await triggers.expectYamlContains(
      "provider: opencode",
      "model: gateway/vendor/model-v1",
      "mode: full-access",
      "sandbox_mode: workspace-write",
      "mode: conversation",
    );
    await triggers.capture(`${SHOTS}/03-generated-yaml.png`);
  });

  await test.step("a mode the daemon does not offer is refused at save, not at the first run", async () => {
    // `Invalid mode 'default' for provider 'opencode'. Available modes: build, plan` was a
    // production run failure. The daemon's catalog answers before anything is stored.
    await triggers.replaceYaml(
      advancedTriggerYaml(daemon).replace("mode: full-access", "mode: default"),
    );
    await triggers.expectRefusedOnSubmit(
      "run.agent.mode: Mode 'default' is not available for provider 'opencode'",
    );
    await triggers.replaceYaml(
      advancedTriggerYaml(daemon).replace("provider: opencode", "provider: omp"),
    );
    await triggers.expectRefusedOnSubmit("Provider 'omp' cannot run unattended Hub automations");
    await triggers.capture(`${SHOTS}/03b-refused-mode.png`);
  });

  await test.step("valid YAML saves and lists", async () => {
    await triggers.replaceYaml(advancedTriggerYaml(daemon));
    await triggers.save("slack-help");
    await triggers.expectOperationalList("slack-help");
    await triggers.capture(`${SHOTS}/04-saved-trigger-list.png`);
  });

  await test.step("the form projects advanced YAML without hiding or deleting it", async () => {
    await triggers.openTrigger("slack-help");
    await triggers.expectFormAgent({
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      providerOptions: '{\n  "sandbox_mode": "workspace-write",\n  "approval_policy": "never"\n}',
      prompt: "Handle the Slack request.",
    });
    await triggers.capture(`${SHOTS}/05-round-tripped-form.png`);
    await triggers.changePrompt("Handle the Slack request and report what changed.");
    await triggers.save("slack-help");
  });

  await test.step("a form save retains comments and every YAML-only field", async () => {
    await triggers.openTrigger("slack-help");
    await triggers.switchToYaml();
    await triggers.expectYamlContains(
      "# survives form edits",
      "thinkingOptionId: high",
      "newBranch: trigger-work",
      "channels:",
      "slack.reply:",
      "auto_archive: false",
      "Handle the Slack request and report what changed.",
    );
    await triggers.capture(`${SHOTS}/06-preserved-advanced-yaml.png`);
    await page.getByRole("button", { name: "Triggers" }).click();
  });

  await test.step("legacy multi-step workflows remain visible and are never silently flattened", async () => {
    await hub.seedLegacyTrigger("owner", "legacy-review", legacyWorkflowYaml);
    await triggers.open();
    await triggers.openTrigger("legacy-review");
    await triggers.expectLegacyReadOnly();
    await triggers.capture(`${SHOTS}/07-legacy-workflow-warning.png`);
  });
});

test("routes one trigger to each Slack app's connection in one workspace", async ({
  hub,
  page,
}) => {
  await hub.signUpAs("owner", owner);
  await hub.createOrganization("owner", "Acme");
  const daemon = await hub.connectProviderDaemon("owner", "Acme");
  // Two bots in the one workspace: each app's installation is its own connection.
  await hub.seedSlackConnection("owner", "acme-sian", "Acme", {
    teamId: "T-SHARED",
    applicationId: "browser-slack-app",
    botUserId: "B1",
    botAccessToken: "xoxb-seeded-1",
  });
  await hub.seedSlackConnection("owner", "acme-moe", "Acme", {
    teamId: "T-SHARED",
    applicationId: "browser-slack-app-2",
    botUserId: "B2",
    botAccessToken: "xoxb-seeded-2",
  });
  const triggers = new OrganizationTriggers(page);
  await triggers.open();
  for (const [name, connection] of [
    ["ask-sian", "acme-sian"],
    ["ask-moe", "acme-moe"],
  ] as const) {
    await triggers.startNew();
    await triggers.configureSlackMention({
      name,
      connection,
      daemon,
      cwd: "/workspace/acme",
      users: "U123",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "high",
      providerOptions: '{"sandbox_mode":"workspace-write"}',
      prompt: `Answer as ${name}.`,
    });
    await triggers.save(name);
  }
  await triggers.expectOperationalList("ask-moe");
  // The editor stored one route per connection; the next test mentions each bot against them.
  expect(
    (await hub.slackTriggerRoutes("T-SHARED")).map(
      ({ connectionId: _connectionId, ...route }) => route,
    ),
  ).toEqual([
    { trigger: "ask-moe", connection: "acme-moe", app: "browser-slack-app-2" },
    { trigger: "ask-sian", connection: "acme-sian", app: "browser-slack-app" },
  ]);
});

test("a mention of each Slack app launches only the trigger routed to its own connection", async ({
  hub,
}) => {
  const session = await hub.openAppSetup({
    account: {
      name: "Two Bots Operator",
      email: "two-bots-operator@example.com",
      password: "two-bots-operator-password",
    },
  });
  try {
    const { page, surface, application } = session;
    const slack = surface.slack;
    const [first, second] = ["browser-slack-app", "browser-slack-app-2"] as const;
    // Two real Socket Mode apps in one workspace, each with the bot and token it was saved with.
    await slack.expand();
    await slack.fillWorkingCredentials();
    await slack.save();
    await slack.expectSlackAppStatus(first, "Connected");
    await slack.addSlackApp();
    await slack.fill(SECOND_SLACK_SOCKET_CREDENTIALS);
    await slack.save();
    await slack.expectSlackAppStatus(second, "Connected");
    const state = await slackPersistedState(application);
    expect(state[first]?.connection?.botAccessToken).not.toEqual(
      state[second]?.connection?.botAccessToken,
    );
    const slugs = {
      [first]: String(state[first]?.connection?.slug),
      [second]: String(state[second]?.connection?.slug),
    };
    await surface.leave("Finish");
    const daemon = await session.connectDaemon();

    // One trigger per bot, each routed to its own app's connection from the trigger form.
    const triggers = new OrganizationTriggers(page);
    await triggers.open();
    for (const [name, appId] of [
      ["ask-sian", first],
      ["ask-moe", second],
    ] as const) {
      await triggers.startNew();
      await triggers.configureSlackMention({
        name,
        connection: slugs[appId],
        daemon,
        cwd: "/workspace/acme",
        users: "U1",
        agent: "opencode/gateway/vendor/model-v1",
        mode: "full-access",
        thinking: "high",
        providerOptions: '{"sandbox_mode":"workspace-write"}',
        prompt: `Answer as ${name}.`,
      });
      await triggers.save(name);
    }
    const routes = await slackTriggerRoutes(
      (sql, params) => application.query(sql, params),
      "T-ACME",
    );
    expect(routes.map(({ trigger, app }) => ({ trigger, app }))).toEqual([
      { trigger: "ask-moe", app: second },
      { trigger: "ask-sian", app: first },
    ]);

    // Each bot is mentioned once. Each mention starts one run, of the trigger bound to the
    // connection that received it: the other bot's trigger is not launched.
    const eventId = "browser-trigger-two-apps";
    await Promise.all([
      session.deliverSlackSocketMention(eventId, first),
      session.deliverSlackSocketMention(eventId, second),
    ]);
    await expectSlackDelivered(session, eventId, first);
    await expectSlackDelivered(session, eventId, second);
    const runs = await application.query(
      `select receipt.delivery_id delivery, run.configured_trigger_name trigger,
         run.output_context->>'connectionId' connection
       from trigger_runs run
       join provider_event_receipts receipt on receipt.id = run.provider_event_receipt_id
       where receipt.delivery_id like $1 order by receipt.delivery_id`,
      [`slack-%-${eventId}`],
    );
    const routeOf = (trigger: string) => routes.find((route) => route.trigger === trigger);
    expect(runs).toEqual([
      {
        delivery: `slack-${second}-${eventId}`,
        trigger: "ask-moe",
        connection: routeOf("ask-moe")?.connectionId,
      },
      {
        delivery: `slack-${first}-${eventId}`,
        trigger: "ask-sian",
        connection: routeOf("ask-sian")?.connectionId,
      },
    ]);
    expect(routeOf("ask-moe")?.connectionId).not.toEqual(routeOf("ask-sian")?.connectionId);
  } finally {
    await session.close();
  }
});

for (const scenario of [
  { event: "github.issue_label_added", name: "issue-label" },
  { event: "github.pull_request_label_added", name: "pr-label" },
]) {
  test(`saves, reloads, and requires a label for ${scenario.event}`, async ({ hub, page }) => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    const daemon = await hub.connectProviderDaemon("owner", "Acme");
    await hub.connectGitHub("owner");
    const triggers = new OrganizationTriggers(page);

    await test.step("reject an otherwise complete form with an empty or blank label", async () => {
      await triggers.open();
      await triggers.startNew();
      await triggers.configureLabelAdded({ ...scenario, daemon });
      await triggers.expectLabelRequiredOnSubmit();
      await triggers.changeAddedLabel("   ");
      await triggers.expectLabelRequiredOnSubmit();
      await triggers.capture(`${SHOTS}/${scenario.name}-required.png`);
    });

    await test.step("save through the form and verify persisted YAML after reload", async () => {
      await triggers.changeAddedLabel("ready-for-review");
      await triggers.save(scenario.name);
      await triggers.openTrigger(scenario.name);
      await triggers.expectPersistedLabel(scenario.event, "ready-for-review");
    });

    await test.step("reject clearing a saved label without changing the saved trigger", async () => {
      await triggers.changeAddedLabel("");
      await triggers.expectLabelRequiredOnSubmit();
      await triggers.expectPersistedLabel(scenario.event, "ready-for-review");
    });

    await test.step("edit the label and verify the new value survives another reload", async () => {
      await triggers.changeAddedLabel("ready-to-ship");
      await triggers.save(scenario.name);
      await triggers.openTrigger(scenario.name);
      await triggers.expectPersistedLabel(scenario.event, "ready-to-ship");
      await triggers.capture(`${SHOTS}/${scenario.name}-persisted.png`);
    });
  });
}

function advancedTriggerYaml(daemon: string) {
  return `# survives form edits
name: slack-help
enabled: true
on:
  slack.mention:
    connection: company-slack
    filters:
      from_users: [U123, U456]
      channels: [engineering]
run:
  target:
    daemon: ${daemon}
    cwd: /workspace/acme
    worktree:
      mode: branch-off
      newBranch: trigger-work
  agent:
    provider: opencode
    model: gateway/vendor/model-v1
    mode: full-access
    thinkingOptionId: high
    options:
      sandbox_mode: workspace-write
      approval_policy: never
  prompt: Handle the Slack request.
  max_runtime: 90m
  idle_timeout: 15m
  outputs:
    slack.reply:
      max: 5
  auto_archive: false
`;
}

const legacyWorkflowYaml = `name: legacy-review
on: slack.mention
steps:
  - id: classify
    agent: classifier
    prompt: Classify the request.
  - id: implement
    agent: engineer
    prompt: Implement it.
`;
