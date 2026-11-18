import assert from "node:assert/strict";
import { it } from "vitest";
import { agentFailureNotice, organizationBillingUrl } from "./failure-notice.js";
import { createMemoryDatabase } from "../db/memory.js";

it("links to the organization's billing route", async () => {
  const database = createMemoryDatabase({
    memberships: [
      {
        userId: "user-1",
        organizationId: "org-1",
        organizationName: "Acme",
        organizationSlug: "acme",
        membershipId: "member-1",
        role: "owner",
      },
    ],
  });
  assert.equal(
    await organizationBillingUrl(database, "https://hub.paseo.sh", "org-1"),
    "https://hub.paseo.sh/o/acme/settings/billing",
  );
});

it("uses the UTC month and next first for the execution limit", async () => {
  const reason = JSON.stringify({
    error: "entitlement_denied",
    entitlement: "executions.monthly",
    kind: "meter",
    limit: 50,
    current: 236,
  });
  const notice = await agentFailureNotice(
    reason,
    "org-1",
    async () => "https://hub.paseo.sh/o/acme/settings/billing",
    undefined,
    new Date("2026-12-31T23:30:00Z"),
  );
  assert.equal(
    notice,
    "This org has used its 50 free runs for December. Runs reset on January 1, or upgrade to Pro under Billing: https://hub.paseo.sh/o/acme/settings/billing",
  );
});

it("keeps other entitlement denials on the existing error path", async () => {
  const reason = JSON.stringify({
    error: "entitlement_denied",
    entitlement: "seats",
    kind: "cap",
    limit: 2,
    current: 2,
  });
  assert.equal(
    await agentFailureNotice(reason, "org-1", async () => {
      throw new Error("should not need a billing URL");
    }),
    `Paseo agent failed: ${reason}`,
  );
});

it("quotes and truncates the agent's last message under the failure reason", async () => {
  const noBilling = async () => {
    throw new Error("should not need a billing URL");
  };
  assert.equal(
    await agentFailureNotice("step_idle_timeout", "org-1", noBilling, "Line one\nLine two"),
    "Paseo agent failed: step_idle_timeout\n\nThe agent's last message before it stopped:\n> Line one\n> Line two",
  );
  const long = await agentFailureNotice("idle_timeout", "org-1", noBilling, "x".repeat(5_000));
  assert.equal(long.endsWith(`> ${"x".repeat(1_500)}…`), true);
  assert.equal(
    await agentFailureNotice("idle_timeout", "org-1", noBilling, "  "),
    "Paseo agent failed: idle_timeout",
  );
});
