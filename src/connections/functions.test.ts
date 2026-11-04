import assert from "node:assert/strict";
import { it } from "vitest";
import { connectionStatusSchema } from "./functions.js";

it("keeps provider readiness separate from connection inventory", () => {
  const status = connectionStatusSchema.parse({
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "disconnected" },
    linear: { status: "disconnected" },
  });
  assert.deepEqual(status, {
    canManage: true,
    github: { status: "connected" },
    discord: { status: "connected" },
    slack: { status: "disconnected" },
    linear: { status: "disconnected" },
  });
});

it("keeps the Slack apps a project can choose between", () => {
  const status = connectionStatusSchema.parse({
    canManage: true,
    github: { status: "notConfigured" },
    discord: { status: "notConfigured" },
    slack: { status: "connected", applications: ["A1", "B1"] },
    linear: { status: "notConfigured" },
  });
  assert.deepEqual(status.slack, { status: "connected", applications: ["A1", "B1"] });
});
