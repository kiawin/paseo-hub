import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { Provider, ProviderApplicationOverview, ProviderApplicationView } from "./index.js";
import { connectedProviderCount, headlineStatus, sectionViews } from "./overview.js";

describe("provider application overview", () => {
  it("counts Slack once when either of its apps is connected", () => {
    assert.equal(connectedProviderCount(overview([view("slack", 1), view("slack", 0)])), 1);
    assert.equal(connectedProviderCount(overview([view("slack", 0), view("slack", 1)])), 1);
    assert.equal(connectedProviderCount(overview([view("slack", 1), view("slack", 1)], 1)), 2);
    assert.equal(connectedProviderCount(overview([view("slack", 0), view("slack", 0)])), 0);
    assert.equal(connectedProviderCount(overview([], 1)), 1);
  });

  it("heads a section of several apps with the one most in need of attention", () => {
    const needsAction = { ...view("slack", 1), status: "actionNeeded" as const };
    const verified = view("slack", 0);
    const saved = { ...verified, status: "verified" as const };
    assert.equal(headlineStatus([view("slack", 1), needsAction]), "actionNeeded");
    assert.equal(headlineStatus([view("slack", 1), saved]), "verified");
    assert.equal(headlineStatus([view("slack", 1)]), "connected");
    assert.equal(headlineStatus([]), "notConfigured");
  });

  it("gives the Slack section every saved app, and every other section its one app", () => {
    const apps = [view("slack", 1), view("slack", 0)];
    assert.deepEqual(sectionViews(overview(apps), "slack"), apps);
    assert.deepEqual(sectionViews(overview([]), "slack"), []);
    assert.deepEqual(
      sectionViews(overview([]), "github").map((entry) => entry.provider),
      ["github"],
    );
  });
});

function overview(
  slack: readonly ProviderApplicationView[],
  githubConnections = 0,
): ProviderApplicationOverview {
  return {
    callbackOrigin: "https://hub.test",
    providers: {
      github: view("github", githubConnections),
      slack,
      discord: view("discord", 0),
      linear: view("linear", 0),
    },
  };
}

function view(provider: Provider, connections: number): ProviderApplicationView {
  return {
    provider,
    status: connections > 0 ? "connected" : "notConfigured",
    managedByEnvironment: false,
    identifiers: {},
    identity: null,
    connections: Array.from({ length: connections }, (_, index) => ({
      id: `${provider}-${index}`,
      name: "Acme",
      applicationId: null,
      status: "connected" as const,
    })),
    eventsConfigured: false,
    lastEventAt: null,
    replaceable: connections === 0,
    configurationVersion: null,
  };
}
