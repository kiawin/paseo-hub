import { expect } from "@playwright/test";
import { test } from "./app.js";
import { projectApp } from "./helpers/projects/index.js";
import { OrganizationTriggers } from "./helpers/triggers.js";

const owner = {
  name: "Imani",
  email: "imani-continuation@example.com",
  password: "imani-continuation-password",
};

const SCREENSHOTS = "e2e/screenshots/continuation-replacement";

test.describe.configure({ timeout: 180_000 });

test("changing a continuation trigger's agent replaces the idle agent instead of failing", async ({
  hub,
  page,
}) => {
  const app = projectApp(page);
  const triggers = new OrganizationTriggers(page);
  const deployRows = page
    .getByRole("table", { name: "Trigger activity" })
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "deploy", exact: true }) });
  let daemonSlug = "";

  await test.step("sign up, create an organization, and register a daemon", async () => {
    await hub.signUpAs("owner", owner);
    await hub.createOrganization("owner", "Acme");
    daemonSlug = await hub.connectProviderDaemon("owner", "Acme");
  });

  await test.step("install a manual trigger that keeps one conversation", async () => {
    await app.navigation.openOrganizationSection("Triggers");
    await triggers.startNew();
    await triggers.configureManual({
      name: "deploy",
      daemon: daemonSlug,
      cwd: "/workspace",
      agent: "opencode/gateway/vendor/model-v1",
      mode: "full-access",
      thinking: "low",
      prompt: "${{ paseo.prompt }}",
    });
    await triggers.useContinuationKey("release-thread");
    await triggers.capture(`${SCREENSHOTS}/01-continuation-key.png`);
    await triggers.save("deploy");
  });

  const runApiKey = await hub.createRunApiKey("owner");

  await test.step("the first run starts the conversation's agent and finishes", async () => {
    const first = await hub.runManualInput({
      rawInput: "ship the first release",
      deliveryKey: "continuation-run-1",
      apiKey: runApiKey,
    });
    expect(first.workflowStatus).toBe("running");
    await hub.finishSessionRun(first.triggerRunId!);
    await app.navigation.openOrganizationSection("Activity");
    await expect(async () => {
      await page.reload();
      await expect(deployRows).toHaveCount(1);
      await expect(deployRows.first().getByRole("cell", { name: "Succeeded" })).toBeVisible();
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
    await page.screenshot({ path: `${SCREENSHOTS}/02-first-run.png`, fullPage: true });
  });

  await test.step("switch the trigger to a different model", async () => {
    await app.navigation.openOrganizationSection("Triggers");
    await triggers.openTrigger("deploy");
    await triggers.changeAgent("opencode/gateway/vendor/model-v2", "full-access", "high");
    await triggers.save("deploy");
  });

  await test.step("the next run gets a new agent instead of failing", async () => {
    const second = await hub.runManualInput({
      rawInput: "ship the second release",
      deliveryKey: "continuation-run-2",
      apiKey: runApiKey,
    });
    expect(second.workflowStatus).toBe("running");
    const dispatch = await hub.settledRunDispatch(second.triggerRunId!);
    await app.navigation.openOrganizationSection("Activity");
    // Before the fix, dispatch failed: "Continuation settings differ from the existing agent".
    const shown = dispatch.status === "failed" ? "Failed" : "Running";
    await expect(async () => {
      await page.reload();
      await expect(deployRows).toHaveCount(2);
      await expect(deployRows.first().getByRole("cell", { name: shown })).toBeVisible();
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
    await page.screenshot({ path: `${SCREENSHOTS}/03-second-run-dispatched.png`, fullPage: true });
    expect(dispatch.status, JSON.stringify(dispatch.result)).toBe("running");
    await hub.finishSessionRun(second.triggerRunId!);
    await expect(async () => {
      await page.reload();
      await expect(deployRows.getByRole("cell", { name: "Succeeded" })).toHaveCount(2);
    }).toPass({ timeout: 30_000, intervals: [1_000, 2_000] });
    await page.screenshot({ path: `${SCREENSHOTS}/04-second-run-finished.png`, fullPage: true });
  });
});
