import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { AccountAccessValue } from "../auth/organization-access.js";
import {
  ProviderApplicationError,
  activateProviderApplicationsAtStartup,
  createProviderApplications,
  providerApplicationReturnRoute,
  type ConnectedProviderIdentity,
  type ProviderApplicationConfiguration,
  type ProviderApplicationIdentity,
  type Provider,
  type ProviderApplicationStore,
  type ProviderApplicationView,
  type ProviderRuntimeCandidate,
  type ProviderRuntimeOwner,
  type SlackApplicationDelivery,
} from "./index.js";

const githubConfiguration: ProviderApplicationConfiguration = {
  provider: "github",
  appId: "42",
  appSlug: "paseo",
  clientId: "client",
  clientSecret: "client-secret",
  privateKey: "private-key",
  webhookSecret: "webhook-secret",
};
const slackConfiguration = {
  provider: "slack",
  transport: "webhook",
  appId: "A1",
  clientId: "client",
  clientSecret: "client-secret",
  signingSecret: "signing-secret",
} satisfies ProviderApplicationConfiguration;
const linearConfiguration: ProviderApplicationConfiguration = {
  provider: "linear",
  clientId: "linear-client",
  clientSecret: "linear-client-secret",
  webhookSecret: "linear-webhook-secret",
};

describe("provider applications", () => {
  it("reveals no provider state to a signed-in non-operator", async () => {
    const fixture = createFixture({ operator: false });

    await assert.rejects(
      fixture.applications.overview(request()),
      (error: unknown) => error instanceof ProviderApplicationError && error.code === "forbidden",
    );
    assert.equal(fixture.store.reads, 0);
  });

  it("rejects cross-origin mutations before reading or changing provider state", async () => {
    const fixture = createFixture({ rejectMutation: true });

    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration),
      (error: unknown) => error instanceof ProviderApplicationError && error.code === "forbidden",
    );

    assert.equal(fixture.store.reads, 0);
    assert.equal(fixture.runtime.prepareCount("github"), 0);
  });

  it("keeps secrets write-only in every overview projection", async () => {
    const fixture = createFixture();
    await fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration);

    const overview = await fixture.applications.overview(request());
    const serialized = JSON.stringify(overview);
    assert.equal(serialized.includes("client-secret"), false);
    assert.equal(serialized.includes("private-key"), false);
    assert.equal(serialized.includes("webhook-secret"), false);
    assert.deepEqual(overview.providers.github.identifiers, {
      appId: "42",
      appSlug: "paseo",
      clientId: "client",
    });
  });

  it("shows signed-event evidence only for the active identity and configuration version", async () => {
    const fixture = createFixture({ eventEvidenceVersion: 1 });
    await fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration);
    assert.equal(
      (await fixture.applications.overview(request())).providers.github.lastEventAt,
      "2026-08-14T10:00:00.000Z",
    );

    await fixture.applications.verifyAndSave(request("POST"), "github", {
      ...githubConfiguration,
      clientSecret: "rotated-secret",
      expectedVersion: 1,
    });

    assert.equal(
      (await fixture.applications.overview(request())).providers.github.lastEventAt,
      null,
    );
  });

  it("shows Action needed when canonical connection health reports a legacy partial grant", async () => {
    const fixture = createFixture({ connected: true, connectionStatus: "actionNeeded" });
    await fixture.store.save({
      provider: "github",
      configuration: githubConfiguration,
      identity: { provider: "github", id: "42", name: "Paseo", ownerLogin: "acme" },
      expectedVersion: undefined,
      updatedByUserId: "operator",
    });

    assert.equal(
      (await fixture.applications.overview(request())).providers.github.status,
      "actionNeeded",
    );
  });

  it("serializes saves per provider while allowing different providers to proceed", async () => {
    const fixture = createFixture();
    fixture.runtime.block("github");
    fixture.runtime.block("discord");
    const firstGitHub = fixture.applications.verifyAndSave(
      request("POST"),
      "github",
      githubConfiguration,
    );
    await fixture.runtime.waitUntilPrepared("github");
    const secondGitHub = fixture.applications.verifyAndSave(
      request("POST"),
      "github",
      githubConfiguration,
    );
    const discord = fixture.applications.verifyAndSave(request("POST"), "discord", {
      provider: "discord",
      applicationId: "100",
      clientSecret: "discord-secret",
      botToken: "discord-token",
    });

    await fixture.runtime.waitUntilPrepared("discord");
    assert.equal(fixture.runtime.prepareCount("github"), 1);
    fixture.runtime.release("github");
    await firstGitHub;
    await fixture.runtime.waitUntilPrepared("github", 2);
    fixture.runtime.release("github");
    fixture.runtime.release("discord");
    await assert.rejects(
      secondGitHub,
      (error: unknown) =>
        error instanceof ProviderApplicationError && error.code === "configurationConflict",
    );
    await discord;
  });

  it("resolves a queued connection from the configuration saved ahead of it", async () => {
    const fixture = createFixture();
    fixture.runtime.block("github");
    const save = fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration);
    await fixture.runtime.waitUntilPrepared("github");
    const connect = fixture.applications.beginConnection(request("POST"), "github", "org");
    let connectError: unknown;
    const observedConnect = connect.catch((error: unknown) => {
      connectError = error;
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(connectError, undefined);

    fixture.runtime.release("github");
    await save;
    await observedConnect;
    assert.equal(connectError, undefined);

    assert.deepEqual(fixture.runtime.preparedConfigurationIds("github"), ["42", "42"]);
    assert.deepEqual(fixture.runtime.preparedVersions("github"), [1, 1]);
  });

  it("preserves the prior active provider and persisted row when candidate start fails", async () => {
    const fixture = createFixture();
    await fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration);
    const previous = fixture.runtime.active("github");
    const stored = fixture.store.values.get("github");
    fixture.runtime.failNextStart("github");

    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "github", {
        ...githubConfiguration,
        clientSecret: "rotated-secret",
      }),
      (error: unknown) => error instanceof ProviderApplicationError && error.code === "internal",
    );

    assert.equal(fixture.runtime.active("github"), previous);
    assert.equal(fixture.store.values.get("github"), stored);
  });

  it("refuses an external application identity change while connections exist", async () => {
    const fixture = createFixture({ connected: true });
    fixture.store.values.set("github", {
      provider: "github",
      configuration: githubConfiguration,
      identity: { provider: "github", id: "42", name: "Paseo", ownerLogin: "acme" },
      version: 1,
      verifiedAt: new Date("2026-08-14T10:00:00Z"),
      updatedAt: new Date("2026-08-14T10:00:00Z"),
      updatedByUserId: "operator",
    });
    fixture.verificationIdentity = {
      provider: "github",
      id: "99",
      name: "Other App",
      ownerLogin: "acme",
    };

    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration),
      (error: unknown) =>
        error instanceof ProviderApplicationError &&
        error.code === "identityConflict" &&
        error.safeContext === "Paseo",
    );
    assert.equal(fixture.runtime.prepareCount("github"), 0);
  });

  it("uses a complete environment override without overwriting the stored configuration", async () => {
    const environmentConfiguration = {
      ...githubConfiguration,
      appId: "84",
      appSlug: "environment-app",
      clientId: "environment-client",
    };
    const fixture = createFixture({ environment: { github: environmentConfiguration } });
    fixture.store.values.set("github", {
      provider: "github",
      configuration: githubConfiguration,
      identity: { provider: "github", id: "42", name: "Stored", ownerLogin: "acme" },
      version: 3,
      verifiedAt: new Date(),
      updatedAt: new Date(),
      updatedByUserId: "operator",
    });

    const overridden = await fixture.applications.overview(request());
    assert.equal(overridden.providers.github.status, "managedByEnvironment");
    assert.deepEqual(overridden.providers.github.identifiers, {
      appId: "84",
      appSlug: "environment-app",
      clientId: "environment-client",
    });
    assert.equal(fixture.store.values.get("github")?.version, 3);

    const resumed = createFixture();
    resumed.store.values.set("github", fixture.store.values.get("github")!);
    assert.deepEqual(
      (await resumed.applications.overview(request())).providers.github.identifiers,
      {
        appId: "42",
        appSlug: "paseo",
        clientId: "client",
      },
    );
  });

  it("refuses a changed environment-managed identity when restarting with existing connections", async () => {
    const fixture = createFixture();
    await fixture.store.save({
      provider: "github",
      configuration: githubConfiguration,
      identity: { provider: "github", id: "42", name: "Stored", ownerLogin: "acme" },
      expectedVersion: undefined,
      updatedByUserId: "operator",
    });
    const failures = await activateProviderApplicationsAtStartup({
      store: fixture.store,
      environment: { github: { ...githubConfiguration, appId: "84", clientSecret: "rotated" } },
      runtime: fixture.runtime,
      verifier: {
        verify: () =>
          Promise.resolve({ provider: "github", id: "84", name: "Other", ownerLogin: "acme" }),
      },
      inventory: connectedInventory("42"),
      callbackOrigin: "https://hub.test",
    });

    assert.equal(failures[0]?.provider, "github");
    assert.equal(fixture.runtime.active("github"), undefined);
  });

  it("allows a same-identity environment secret rotation when restarting with connections", async () => {
    const fixture = createFixture();
    await fixture.store.save({
      provider: "github",
      configuration: githubConfiguration,
      identity: { provider: "github", id: "42", name: "Stored", ownerLogin: "acme" },
      expectedVersion: undefined,
      updatedByUserId: "operator",
    });
    const failures = await activateProviderApplicationsAtStartup({
      store: fixture.store,
      environment: { github: { ...githubConfiguration, clientSecret: "rotated" } },
      runtime: fixture.runtime,
      verifier: {
        verify: () =>
          Promise.resolve({ provider: "github", id: "42", name: "Stored", ownerLogin: "acme" }),
      },
      inventory: connectedInventory("42"),
      callbackOrigin: "https://hub.test",
    });

    assert.deepEqual(failures, []);
    assert.equal(fixture.runtime.active("github")?.configurationId, "42");
  });

  it("persists and activates Slack only after the verified OAuth installation", async () => {
    const fixture = createFixture();

    const result = await fixture.applications.verifyAndSave(
      request("POST"),
      "slack",
      slackConfiguration,
    );

    assert.deepEqual(result, {
      status: "continuing",
      provider: "slack",
      url: "https://slack.test/install",
    });
    assert.equal(fixture.store.values.has("slack:A1"), false);
    assert.equal(fixture.runtime.active("slack"), undefined);

    await fixture.runtime.completeSlack({
      configuration: slackConfiguration,
      expectedConfigurationVersion: undefined,
      callbackOrigin: "https://hub.test",
      userId: "operator",
      installation: {
        appId: "A1",
        teamId: "T1",
        teamName: "Acme",
        botUserId: "UBOT",
        botAccessToken: "token",
        scopes: ["chat:write"],
      },
      binding: slackBinding(),
    });

    assert.equal(fixture.store.values.get("slack:A1")?.version, 1);
    assert.notEqual(fixture.runtime.active("slack"), undefined);
  });

  it("persists and activates Linear only after the verified OAuth installation", async () => {
    const fixture = createFixture();

    const result = await fixture.applications.verifyAndSave(
      request("POST"),
      "linear",
      linearConfiguration,
    );

    assert.deepEqual(result, {
      status: "continuing",
      provider: "linear",
      url: "https://slack.test/install",
    });
    assert.equal(fixture.store.values.has("linear"), false);
    assert.equal(fixture.runtime.active("linear"), undefined);

    await fixture.runtime.completeLinear({
      configuration: linearConfiguration,
      expectedConfigurationVersion: undefined,
      callbackOrigin: "https://hub.test",
      userId: "operator",
      installation: {
        linearOrganizationId: "linear-acme",
        linearOrganizationName: "Acme",
        appUserId: "linear-app-user",
        accessToken: "linear-token",
        refreshToken: "linear-refresh-token",
        accessTokenExpiresAt: null,
        scopes: ["read", "comments:create"],
      },
      binding: linearBinding(),
    });

    assert.equal(fixture.store.values.get("linear")?.version, 1);
    assert.notEqual(fixture.runtime.active("linear"), undefined);
  });

  it("requires HTTPS before starting a Linear configuration", async () => {
    const fixture = createFixture();

    await assert.rejects(
      fixture.applications.verifyAndSave(
        request("POST", "http://hub.test"),
        "linear",
        linearConfiguration,
      ),
      (error: unknown) =>
        error instanceof ProviderApplicationError &&
        error.code === "httpsRequired" &&
        error.safeContext === "http://hub.test",
    );

    assert.equal(fixture.store.reads, 0);
    assert.equal(fixture.runtime.prepareCount("linear"), 0);
  });

  it("requires HTTPS before starting an environment-managed Linear connection", async () => {
    const fixture = createFixture({ environment: { linear: linearConfiguration } });

    await assert.rejects(
      fixture.applications.beginConnection(request("POST", "http://hub.test"), "linear", "org"),
      (error: unknown) =>
        error instanceof ProviderApplicationError &&
        error.code === "httpsRequired" &&
        error.safeContext === "http://hub.test",
    );

    assert.equal(fixture.store.reads, 0);
    assert.equal(fixture.runtime.prepareCount("linear"), 0);
  });

  it("verifies and atomically publishes Socket Mode with its first workspace", async () => {
    const fixture = createFixture();

    const result = await fixture.applications.configureSlackSocket(request("POST"), {
      appToken: "xapp-secret",
      botToken: "xoxb-secret",
    });

    assert.deepEqual(result, {
      status: "verified",
      provider: "slack",
      identity: { provider: "slack", id: "A1", name: "A1" },
      configurationVersion: 1,
    });
    assert.deepEqual(fixture.store.values.get("slack:A1")?.configuration, {
      provider: "slack",
      transport: "socket",
      appId: "A1",
      appToken: "xapp-secret",
    });
    assert.equal(fixture.store.socketOrganizationId, "org");
    assert.notEqual(fixture.runtime.active("slack"), undefined);
  });

  it("keeps Slack unconfigured when post-OAuth activation fails", async () => {
    const fixture = createFixture();
    await fixture.applications.verifyAndSave(request("POST"), "slack", slackConfiguration);
    fixture.runtime.failNextStart("slack");

    await assert.rejects(() =>
      fixture.runtime.completeSlack({
        configuration: slackConfiguration,
        expectedConfigurationVersion: undefined,
        callbackOrigin: "https://hub.test",
        userId: "operator",
        installation: {
          appId: "A1",
          teamId: "T1",
          teamName: "Acme",
          botUserId: "UBOT",
          botAccessToken: "token",
          scopes: ["chat:write"],
        },
        binding: slackBinding(),
      }),
    );
    assert.equal(fixture.store.values.has("slack:A1"), false);
    assert.equal(fixture.runtime.active("slack"), undefined);
  });

  it("keeps the prior Slack store and runtime when the atomic bind transition fails", async () => {
    const fixture = createFixture();
    const oldConfiguration = { ...slackConfiguration, clientSecret: "old-secret" };
    await fixture.store.save({
      provider: "slack",
      configuration: oldConfiguration,
      identity: { provider: "slack", id: "A1", name: "Acme" },
      expectedVersion: undefined,
      updatedByUserId: "operator",
    });
    assert.deepEqual(
      await activateProviderApplicationsAtStartup({
        store: fixture.store,
        environment: {},
        runtime: fixture.runtime,
        verifier: { verify: () => Promise.reject(new Error("unused")) },
        inventory: connectedInventory("A1"),
        callbackOrigin: "https://hub.test",
      }),
      [],
    );
    const oldRuntime = fixture.runtime.active("slack");
    fixture.store.failNextSlackCompletion();

    await assert.rejects(() =>
      fixture.runtime.completeSlack({
        configuration: { ...slackConfiguration, expectedVersion: 1 },
        expectedConfigurationVersion: 1,
        callbackOrigin: "https://hub.test",
        userId: "operator",
        installation: {
          appId: "A1",
          teamId: "T1",
          teamName: "Acme",
          botUserId: "UBOT",
          botAccessToken: "token",
          scopes: ["chat:write"],
        },
        binding: slackBinding(),
      }),
    );

    assert.equal(fixture.store.values.get("slack:A1")?.configuration, oldConfiguration);
    assert.equal(fixture.runtime.active("slack"), oldRuntime);
    assert.equal(fixture.runtime.latestCandidate("slack")?.closeCount, 1);
  });

  it("closes an unusable Slack installation candidate exactly once", async () => {
    const fixture = createFixture();
    fixture.runtime.makeConnectionUnavailable("slack");

    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "slack", slackConfiguration),
      (error: unknown) => error instanceof ProviderApplicationError && error.code === "internal",
    );

    assert.equal(fixture.runtime.latestCandidate("slack")?.closeCount, 1);
  });

  it("sends a connection back to the surface it started from, and nowhere else", async () => {
    const fixture = createFixture();
    await fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration);

    await fixture.applications.beginConnection(request("POST"), "github", "org", "appSetup");
    await fixture.applications.beginConnection(request("POST"), "github", "org", "apps");
    await fixture.applications.beginConnection(request("POST"), "github", "org");

    assert.deepEqual(fixture.returnRoutes, ["/", "/apps", "/apps"]);
  });

  it("carries the surface through a Slack installation", async () => {
    const fixture = createFixture();

    const result = await fixture.applications.verifyAndSave(
      request("POST"),
      "slack",
      slackConfiguration,
      "appSetup",
    );

    assert.equal(result.status, "continuing");
    assert.deepEqual(fixture.returnRoutes, ["/"]);
  });

  it("resolves an unspecified surface to the durable one", () => {
    assert.equal(providerApplicationReturnRoute(undefined), "/apps");
    assert.equal(providerApplicationReturnRoute("appSetup"), "/");
    assert.equal(providerApplicationReturnRoute("apps"), "/apps");
  });
});

describe("several Slack apps", () => {
  it("adds and activates a second app beside a connected one without touching the first", async () => {
    const fixture = createFixture({ connections: { slack: [slackConnection("A1")] } });
    await saveSlack(fixture, "A1");
    assert.deepEqual(await startUp(fixture), []);
    const first = fixture.runtime.active("slack", "A1");
    fixture.socketApps.set("xapp-b", "B1");

    const result = await fixture.applications.configureSlackSocket(request("POST"), {
      appToken: "xapp-b",
      botToken: "xoxb-b",
    });

    assert.deepEqual(result.identity, { provider: "slack", id: "B1", name: "B1" });
    assert.equal(result.configurationVersion, 1);
    assert.equal(fixture.store.values.get("slack:A1")?.version, 1);
    assert.equal(fixture.store.values.get("slack:A1")?.configuration, slackConfiguration);
    assert.equal(fixture.runtime.active("slack", "A1"), first);
    assert.equal(fixture.runtime.active("slack", "B1")?.configurationId, "B1");
    assert.deepEqual(fixture.store.activations, [
      { provider: "slack", applicationId: "A1", version: 1 },
    ]);
  });

  it("installs a second webhook app beside a connected one without an identity conflict", async () => {
    const fixture = createFixture({ connections: { slack: [slackConnection("A1")] } });
    await saveSlack(fixture, "A1");
    await startUp(fixture);
    const first = fixture.runtime.active("slack", "A1");
    const second = { ...slackConfiguration, appId: "B1", clientId: "client-b" };

    assert.equal(
      (await fixture.applications.verifyAndSave(request("POST"), "slack", second)).status,
      "continuing",
    );
    await fixture.runtime.completeSlack({
      configuration: second,
      expectedConfigurationVersion: undefined,
      callbackOrigin: "https://hub.test",
      userId: "operator",
      installation: { ...slackInstallation(), appId: "B1", botUserId: "UBOT-B" },
      binding: slackBinding("B1"),
    });

    assert.equal(fixture.store.values.get("slack:B1")?.version, 1);
    assert.equal(fixture.store.values.get("slack:A1")?.version, 1);
    assert.equal(fixture.runtime.active("slack", "A1"), first);
    assert.equal(fixture.runtime.active("slack", "B1")?.configurationId, "B1");
  });

  it("changes only the app it names, with that app's version", async () => {
    const fixture = createFixture();
    await saveSlack(fixture, "A1");
    await saveSlack(fixture, "B1");

    await assert.rejects(
      fixture.applications.verifyAndSave(
        request("POST"),
        "slack",
        { ...slackConfiguration, appId: "B1", expectedVersion: 1 },
        undefined,
        "A1",
      ),
      (error: unknown) =>
        error instanceof ProviderApplicationError && error.code === "invalidInput",
    );
    // A save that names no app adds one, so it cannot land on an app that is already saved.
    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "slack", {
        ...slackConfiguration,
        appId: "B1",
      }),
      (error: unknown) =>
        error instanceof ProviderApplicationError && error.code === "configurationConflict",
    );
    fixture.socketApps.set("xapp-b", "B1");
    await assert.rejects(
      fixture.applications.configureSlackSocket(request("POST"), {
        appToken: "xapp-b",
        botToken: "xoxb-b",
        expectedVersion: 1,
        applicationId: "A1",
      }),
      (error: unknown) =>
        error instanceof ProviderApplicationError &&
        error.code === "credentialsRejected" &&
        error.safeContext === "applicationMismatch",
    );
    assert.equal(fixture.runtime.prepareCount("slack"), 0);

    const changed = await fixture.applications.verifyAndSave(
      request("POST"),
      "slack",
      { ...slackConfiguration, appId: "B1", expectedVersion: 1 },
      undefined,
      "B1",
    );
    assert.equal(changed.status, "continuing");
    assert.deepEqual(fixture.runtime.preparedConfigurationIds("slack"), ["B1"]);
    assert.deepEqual(fixture.runtime.preparedVersions("slack"), [2]);
  });

  it("queues each Slack app's saves on their own", async () => {
    const fixture = createFixture();
    fixture.runtime.block("slack:A1");
    fixture.socketApps.set("xapp-b", "B1");
    const first = fixture.applications.configureSlackSocket(request("POST"), {
      appToken: "xapp-a",
      botToken: "xoxb-a",
    });
    await fixture.runtime.waitUntilPrepared("slack");

    await fixture.applications.configureSlackSocket(request("POST"), {
      appToken: "xapp-b",
      botToken: "xoxb-b",
    });

    assert.equal(fixture.runtime.active("slack", "B1")?.configurationId, "B1");
    assert.equal(fixture.runtime.active("slack", "A1"), undefined);
    fixture.runtime.release("slack", "A1");
    await first;
    assert.equal(fixture.runtime.active("slack", "A1")?.configurationId, "A1");
  });

  it("lists every Slack app with its own connections, version and delivery", async () => {
    const fixture = createFixture({
      // Each app's evidence is under its own id and version; a lookup that mixes them up shows it.
      eventEvidence: { "A1:1": "2026-08-14T10:00:00.000Z", "B1:2": "2026-08-15T10:00:00.000Z" },
      connections: { slack: [slackConnection("A1"), slackConnection("B1")] },
      deliveries: [delivery("B1", { state: "connected" })],
    });
    await saveSlack(fixture, "A1");
    await saveSlack(fixture, "B1");
    await saveSlack(fixture, "B1", 1);

    const views = (await fixture.applications.overview(request())).providers.slack;

    assert.deepEqual(views.map(slackViewSummary), [
      {
        app: "A1",
        status: "connected",
        version: 1,
        connections: ["connection-A1"],
        lastEventAt: "2026-08-14T10:00:00.000Z",
        delivery: "stopped",
      },
      {
        app: "B1",
        status: "connected",
        version: 2,
        connections: ["connection-B1"],
        lastEventAt: "2026-08-15T10:00:00.000Z",
        delivery: "connected",
      },
    ]);
  });

  it("gives a connection with no app to the only Slack app, and to none of several", async () => {
    const legacy = { ...slackConnection("A1"), id: "legacy", applicationId: null };
    const one = createFixture({ connections: { slack: [legacy] } });
    await saveSlack(one, "A1");
    const several = createFixture({ connections: { slack: [legacy, slackConnection("B1")] } });
    await saveSlack(several, "A1");
    await saveSlack(several, "B1");

    assert.deepEqual(await slackConnectionIds(one), [["legacy"]]);
    assert.deepEqual(await slackConnectionIds(several), [[], ["connection-B1"]]);
  });

  it("starts every stored Slack app, each with its own connection", async () => {
    const fixture = createFixture();
    await saveSlack(fixture, "A1");
    await saveSlack(fixture, "B1");

    const failures = await activateProviderApplicationsAtStartup({
      store: fixture.store,
      environment: {},
      runtime: fixture.runtime,
      verifier: { verify: () => Promise.reject(new Error("unused")) },
      inventory: {
        ...connectedInventory("unused"),
        connectedIdentities: (provider: Provider) =>
          Promise.resolve(
            provider === "slack" ? [slackConnection("A1"), slackConnection("B1")] : [],
          ),
      },
      callbackOrigin: "https://hub.test",
    });

    assert.deepEqual(failures, []);
    assert.equal(fixture.runtime.active("slack", "A1")?.configurationId, "A1");
    assert.equal(fixture.runtime.active("slack", "B1")?.configurationId, "B1");
    assert.deepEqual(fixture.store.activations, [
      { provider: "slack", applicationId: "A1", version: 1 },
      { provider: "slack", applicationId: "B1", version: 1 },
    ]);
  });

  it("asks which app to connect or retry once there are several", async () => {
    const retried: string[] = [];
    const fixture = createFixture({
      deliveries: [
        delivery("A1", { state: "connected" }, retried),
        delivery("B1", { state: "connected" }, retried),
      ],
    });
    await saveSlack(fixture, "A1");
    await saveSlack(fixture, "B1");
    const required = (error: unknown) =>
      error instanceof ProviderApplicationError && error.code === "slackApplicationRequired";

    await assert.rejects(
      fixture.applications.beginConnection(request("POST"), "slack", "org"),
      required,
    );
    await assert.rejects(fixture.applications.retrySlackSocket(request("POST")), required);
    await fixture.applications.beginConnection(request("POST"), "slack", "org", "apps", "B1");
    await fixture.applications.retrySlackSocket(request("POST"), "B1");

    assert.deepEqual(fixture.runtime.preparedConfigurationIds("slack"), ["B1"]);
    assert.deepEqual(retried, ["B1"]);
  });

  it("connects and retries the only Slack app without naming it", async () => {
    const retried: string[] = [];
    const fixture = createFixture({
      deliveries: [delivery("A1", { state: "connected" }, retried)],
    });
    await saveSlack(fixture, "A1");

    await fixture.applications.beginConnection(request("POST"), "slack", "org");
    await fixture.applications.retrySlackSocket(request("POST"));

    assert.deepEqual(fixture.runtime.preparedConfigurationIds("slack"), ["A1"]);
    assert.deepEqual(retried, ["A1"]);
  });

  it("keeps an environment-managed Slack app as the only Slack app", async () => {
    const retried: string[] = [];
    const environment: ProviderApplicationConfiguration = {
      provider: "slack",
      transport: "socket",
      appId: "E1",
      appToken: "xapp-environment",
    };
    const fixture = createFixture({
      environment: { slack: environment },
      deliveries: [delivery("E1", { state: "connected" }, retried)],
    });
    // A Slack app saved before the environment took over is ignored, not shown beside it.
    await saveSlack(fixture, "B1");
    assert.deepEqual(
      await activateProviderApplicationsAtStartup({
        store: fixture.store,
        environment: { slack: environment },
        runtime: fixture.runtime,
        verifier: { verify: () => Promise.reject(new Error("unused")) },
        inventory: connectedInventory("unused"),
        callbackOrigin: "https://hub.test",
      }),
      [],
    );
    const managed = (error: unknown) =>
      error instanceof ProviderApplicationError && error.code === "managedByEnvironment";

    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "slack", slackConfiguration),
      managed,
    );
    await assert.rejects(
      fixture.applications.verifyAndSave(
        request("POST"),
        "slack",
        { ...slackConfiguration, appId: "E1" },
        undefined,
        "E1",
      ),
      managed,
    );
    await assert.rejects(
      fixture.applications.configureSlackSocket(request("POST"), {
        appToken: "xapp-new",
        botToken: "xoxb-new",
      }),
      managed,
    );
    const views = (await fixture.applications.overview(request())).providers.slack;
    assert.deepEqual(
      views.map((view) => [view.status, view.identifiers["appId"], view.configurationVersion]),
      [["managedByEnvironment", "E1", 0]],
    );

    await fixture.applications.beginConnection(request("POST"), "slack", "org");
    await fixture.applications.retrySlackSocket(request("POST"));
    assert.deepEqual(fixture.runtime.preparedConfigurationIds("slack"), ["E1", "E1"]);
    assert.deepEqual(fixture.runtime.preparedVersions("slack"), [0, 0]);
    assert.deepEqual(retried, ["E1"]);
    await assert.rejects(
      fixture.applications.beginConnection(request("POST"), "slack", "org", "apps", "B1"),
      (error: unknown) =>
        error instanceof ProviderApplicationError && error.code === "invalidInput",
    );
  });

  it("claims legacy connections for an environment-managed app only when no app owns any", async () => {
    const legacy = { ...slackConnection("E1"), id: "legacy", applicationId: null };

    assert.deepEqual(await startEnvironmentSlack([legacy]), {
      codes: [],
      claims: ["E1"],
      active: true,
    });
    // Another app's row beside a legacy one: refused before anything is written.
    assert.deepEqual(await startEnvironmentSlack([legacy, slackConnection("B1")]), {
      codes: ["identityConflict"],
      claims: [],
      active: false,
    });
    // Another app's rows alone are that app's: the environment app starts beside them.
    assert.deepEqual(await startEnvironmentSlack([slackConnection("B1")]), {
      codes: [],
      claims: [],
      active: true,
    });
  });

  it("still refuses a second GitHub app", async () => {
    const fixture = createFixture();
    const otherApp: ProviderApplicationConfiguration = {
      provider: "github",
      appId: "99",
      appSlug: "other",
      clientId: "client-99",
      clientSecret: "client-secret",
      privateKey: "private-key",
    };
    await fixture.applications.verifyAndSave(request("POST"), "github", githubConfiguration);
    fixture.verificationIdentity = {
      provider: "github",
      id: "99",
      name: "Other App",
      ownerLogin: "acme",
    };

    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "github", otherApp),
      (error: unknown) =>
        error instanceof ProviderApplicationError && error.code === "configurationConflict",
    );
    await assert.rejects(
      fixture.applications.verifyAndSave(request("POST"), "github", otherApp, undefined, "99"),
      (error: unknown) =>
        error instanceof ProviderApplicationError && error.code === "invalidInput",
    );
    assert.deepEqual(
      (await fixture.store.list("github")).map((value) => value.identity.id),
      ["42"],
    );
  });
});

async function saveSlack(
  fixture: ReturnType<typeof createFixture>,
  applicationId: string,
  expectedVersion?: number,
) {
  await fixture.store.save({
    provider: "slack",
    configuration:
      applicationId === "A1" ? slackConfiguration : { ...slackConfiguration, appId: applicationId },
    identity: { provider: "slack", id: applicationId, name: applicationId },
    expectedVersion,
    updatedByUserId: "operator",
  });
}

function startUp(fixture: ReturnType<typeof createFixture>) {
  return activateProviderApplicationsAtStartup({
    store: fixture.store,
    environment: {},
    runtime: fixture.runtime,
    verifier: { verify: () => Promise.reject(new Error("unused")) },
    inventory: {
      ...connectedInventory("unused"),
      connectedIdentities: (provider: Provider) =>
        Promise.resolve(provider === "slack" ? [slackConnection("A1")] : []),
    },
    callbackOrigin: "https://hub.test",
  });
}

async function slackConnectionIds(fixture: ReturnType<typeof createFixture>) {
  const views = (await fixture.applications.overview(request())).providers.slack;
  return views.map((view) => view.connections.map((connection) => connection.id));
}

/** Starts env-managed Slack app E1 over the given connections, recording every legacy claim. */
async function startEnvironmentSlack(connections: ConnectedProviderIdentity[]) {
  const fixture = createFixture();
  const claims: string[] = [];
  const failures = await activateProviderApplicationsAtStartup({
    store: fixture.store,
    environment: {
      slack: { provider: "slack", transport: "socket", appId: "E1", appToken: "xapp-environment" },
    },
    runtime: fixture.runtime,
    verifier: { verify: () => Promise.reject(new Error("unused")) },
    inventory: {
      ...connectedInventory("unused"),
      connectedIdentities: () => Promise.resolve(connections),
      claimLegacyConnections: (_provider: Provider, identity: ProviderApplicationIdentity) => {
        claims.push(identity.id);
        return Promise.resolve(true);
      },
    },
    callbackOrigin: "https://hub.test",
  });
  return {
    codes: failures.map((failure) =>
      failure.error instanceof ProviderApplicationError ? failure.error.code : "other",
    ),
    claims,
    active: fixture.runtime.active("slack", "E1") !== undefined,
  };
}

function slackViewSummary(view: ProviderApplicationView) {
  return {
    app: view.identity?.id,
    status: view.status,
    version: view.configurationVersion,
    connections: view.connections.map((connection) => connection.id),
    lastEventAt: view.lastEventAt,
    delivery: view.deliveryStatus?.state,
  };
}

function slackConnection(applicationId: string): ConnectedProviderIdentity {
  return { id: `connection-${applicationId}`, name: "Acme", applicationId, status: "connected" };
}

function slackInstallation() {
  return {
    appId: "A1",
    teamId: "T1",
    teamName: "Acme",
    botUserId: "UBOT",
    botAccessToken: "token",
    scopes: ["chat:write"],
  };
}

function delivery(
  applicationId: string,
  status: ReturnType<SlackApplicationDelivery["status"]>,
  retried: string[] = [],
): SlackApplicationDelivery {
  return {
    applicationId,
    status: () => status,
    retry: () => {
      retried.push(applicationId);
      return Promise.resolve();
    },
  };
}

function request(method = "GET", origin = "https://hub.test") {
  return new Request(`${origin}/apps`, {
    method,
    headers: {
      cookie: "session=operator",
      origin,
      "x-paseo-trusted-request-origin": origin,
    },
  });
}

function createFixture(
  options: {
    operator?: boolean;
    connected?: boolean;
    connectionStatus?: "connected" | "actionNeeded";
    environment?: Partial<Record<Provider, ProviderApplicationConfiguration>>;
    rejectMutation?: boolean;
    eventEvidenceVersion?: number;
    /** Signed-event times by `<app id>:<configuration version>`; replaces `eventEvidenceVersion`. */
    eventEvidence?: Record<string, string>;
    /** Replaces the default connections of the providers it names. */
    connections?: Partial<Record<Provider, ConnectedProviderIdentity[]>>;
    deliveries?: SlackApplicationDelivery[];
  } = {},
) {
  const store = new MemoryStore();
  const runtime = new BlockingRuntime();
  const returnRoutes: string[] = [];
  /** The Slack app each Socket Mode app token belongs to; any other token is app A1's. */
  const socketApps = new Map<string, string>();
  let verificationIdentity: ProviderApplicationIdentity = {
    provider: "github",
    id: "42",
    name: "Paseo",
    ownerLogin: "acme",
  };
  const applications = createProviderApplications({
    auth: {
      resolveAccount: () =>
        Promise.resolve({
          session: { id: "session", activeOrganizationId: "org" },
          account: { id: "operator", name: "Operator", email: "operator@hub.test" },
          isInstanceOperator: options.operator ?? true,
        } satisfies AccountAccessValue),
      rejectCookieMutation: () =>
        options.rejectMutation === true ? new Response("forbidden", { status: 403 }) : undefined,
    },
    store,
    environment: options.environment ?? {},
    runtime,
    verifier: {
      verify: (provider) => Promise.resolve(identityFor(provider, verificationIdentity)),
    },
    slackSocketVerifier: {
      verify: (appToken, botToken) =>
        Promise.resolve({
          appId: socketApps.get(appToken) ?? "A1",
          teamId: "T1",
          teamName: "Acme",
          botId: "B1",
          botUserId: "U1",
          botAccessToken: botToken,
          scopes: ["app_mentions:read", "chat:write"],
        }),
    },
    ...(options.deliveries === undefined ? {} : { slackDeliveries: () => options.deliveries! }),
    inventory: {
      connectedIdentities: (provider) =>
        Promise.resolve(
          options.connections?.[provider] ??
            (options.connected && provider === "github"
              ? [
                  {
                    id: "connection",
                    name: "acme",
                    applicationId: "42",
                    status: options.connectionStatus ?? "connected",
                  },
                ]
              : []),
        ),
      claimLegacyConnections: () => Promise.resolve(true),
      lastEventAt: (_provider, identity?: ProviderApplicationIdentity, version?: number) => {
        if (options.eventEvidence !== undefined) {
          const at = options.eventEvidence[`${identity?.id}:${version}`];
          return Promise.resolve(at === undefined ? null : new Date(at));
        }
        return Promise.resolve(
          version === options.eventEvidenceVersion ? new Date("2026-08-14T10:00:00Z") : null,
        );
      },
    },
    callbackOrigin: (incoming) =>
      Promise.resolve(incoming.headers.get("x-paseo-trusted-request-origin")!),
    beginCandidateConnection: (incoming, _organizationId, returnRoute, begin) => {
      returnRoutes.push(returnRoute);
      return begin(incoming);
    },
  });
  return {
    applications,
    store,
    runtime,
    returnRoutes,
    socketApps,
    get verificationIdentity() {
      return verificationIdentity;
    },
    set verificationIdentity(identity: ProviderApplicationIdentity) {
      verificationIdentity = identity;
    },
  };
}

function identityFor(
  provider: Provider,
  github: ProviderApplicationIdentity,
): ProviderApplicationIdentity {
  if (provider === "github") return github;
  if (provider === "discord") return { provider, id: "100", name: "Paseo" };
  if (provider === "linear") return { provider, id: "linear-client", name: "Paseo" };
  return { provider, id: "A1", name: "Paseo" };
}

function connectedInventory(applicationId: string) {
  return {
    connectedIdentities: (provider: Provider) =>
      Promise.resolve(
        provider === "github"
          ? [
              {
                id: "connection",
                name: "acme",
                applicationId,
                status: "connected" as const,
              },
            ]
          : [],
      ),
    claimLegacyConnections: () => Promise.resolve(true),
    lastEventAt: () => Promise.resolve(null),
  };
}

/** Slack rows are keyed `slack:<app id>`, as Slack runs several apps; the others by provider. */
function storeKey(provider: Provider, applicationId: string): string {
  return provider === "slack" ? `slack:${applicationId}` : provider;
}

class MemoryStore implements ProviderApplicationStore {
  readonly values = new Map<string, Awaited<ReturnType<ProviderApplicationStore["read"]>> & {}>();
  readonly activations: { provider: Provider; applicationId: string; version: number }[] = [];
  reads = 0;
  private failSlackCompletion = false;
  socketOrganizationId: string | undefined;

  failNextSlackCompletion() {
    this.failSlackCompletion = true;
  }

  read(provider: Provider, applicationId?: string) {
    this.reads += 1;
    if (applicationId !== undefined) {
      return Promise.resolve(this.values.get(storeKey(provider, applicationId)));
    }
    const stored = this.own(provider);
    if (stored.length > 1) return Promise.reject(new Error(`several ${provider} apps are stored`));
    return Promise.resolve(stored[0]);
  }

  readAll() {
    this.reads += 1;
    return Promise.resolve([...this.values.values()].filter((value) => value !== undefined));
  }

  list(provider: Provider) {
    this.reads += 1;
    return Promise.resolve(this.own(provider));
  }

  private own(provider: Provider) {
    return [...this.values.values()].filter((value) => value.provider === provider);
  }

  save(input: Parameters<ProviderApplicationStore["save"]>[0]) {
    const key = storeKey(input.provider, input.identity.id);
    const previous = this.values.get(key);
    if (previous?.version !== input.expectedVersion) {
      const error = new Error("changed");
      error.name = "ProviderConfigurationConflictError";
      return Promise.reject(error);
    }
    const value = {
      ...input,
      version: (previous?.version ?? 0) + 1,
      verifiedAt: new Date(),
      updatedAt: new Date(),
    };
    this.values.set(key, value);
    return Promise.resolve(value);
  }

  activate(input: Parameters<ProviderApplicationStore["activate"]>[0]) {
    this.activations.push({
      provider: input.provider,
      applicationId: input.identity.id,
      version: input.configurationVersion,
    });
    return Promise.resolve();
  }

  async completeSlackInstallation(
    input: Parameters<ProviderApplicationStore["completeSlackInstallation"]>[0],
  ) {
    if (this.failSlackCompletion) {
      this.failSlackCompletion = false;
      throw new Error("atomic bind failed");
    }
    await this.save({
      provider: "slack",
      configuration: input.configuration,
      identity: input.identity,
      expectedVersion: input.expectedVersion,
      updatedByUserId: input.updatedByUserId,
    });
  }

  async completeLinearInstallation(
    input: Parameters<ProviderApplicationStore["completeLinearInstallation"]>[0],
  ) {
    await this.save({
      provider: "linear",
      configuration: input.configuration,
      identity: input.identity,
      expectedVersion: input.expectedVersion,
      updatedByUserId: input.updatedByUserId,
    });
  }

  completeSlackSocketApplication(
    input: Parameters<ProviderApplicationStore["completeSlackSocketApplication"]>[0],
  ) {
    this.socketOrganizationId = input.organizationId;
    return this.save({
      provider: "slack",
      configuration: input.configuration,
      identity: input.identity,
      expectedVersion: input.expectedVersion,
      updatedByUserId: input.updatedByUserId,
    });
  }
}

class BlockingRuntime implements ProviderRuntimeOwner {
  private readonly candidates = new Map<string, Candidate[]>();
  private readonly activeCandidates = new Map<string, Candidate>();
  private readonly failures = new Set<string>();
  private readonly blocked = new Set<string>();
  private readonly unavailableConnections = new Set<string>();
  private slackInstallationHandler:
    | Parameters<NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>>[0]
    | undefined;
  private linearInstallationHandler:
    | Parameters<NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>>[0]
    | undefined;

  onSlackInstallation(
    handler: Parameters<NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>>[0],
  ) {
    this.slackInstallationHandler = handler;
  }

  completeSlack(
    input: Parameters<Parameters<NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>>[0]>[0],
  ) {
    if (this.slackInstallationHandler === undefined) throw new Error("handler unavailable");
    return this.slackInstallationHandler(input);
  }

  onLinearInstallation(
    handler: Parameters<NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>>[0],
  ) {
    this.linearInstallationHandler = handler;
  }

  completeLinear(
    input: Parameters<Parameters<NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>>[0]>[0],
  ) {
    if (this.linearInstallationHandler === undefined) throw new Error("handler unavailable");
    return this.linearInstallationHandler(input);
  }

  prepare(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    _callbackOrigin: string,
    identity: ProviderApplicationIdentity,
    configurationVersion: number,
  ): Promise<ProviderRuntimeCandidate> {
    const candidate = new Candidate(
      provider,
      this,
      candidateConfigurationId(configuration),
      configurationVersion,
      identity,
    );
    const candidates = this.candidates.get(provider) ?? [];
    candidates.push(candidate);
    this.candidates.set(provider, candidates);
    return Promise.resolve(candidate);
  }

  prepareCount(provider: string) {
    return this.candidates.get(provider)?.length ?? 0;
  }

  /** The live candidate of one app; without an app id, the provider's first. */
  active(provider: string, applicationId?: string) {
    if (applicationId !== undefined)
      return this.activeCandidates.get(`${provider}:${applicationId}`);
    return [...this.activeCandidates.values()].find((candidate) => candidate.provider === provider);
  }

  identity(provider: Provider, applicationId?: string) {
    return this.active(provider, applicationId)?.identity;
  }

  latestCandidate(provider: string) {
    return this.candidates.get(provider)?.at(-1);
  }

  preparedConfigurationIds(provider: string) {
    return this.candidates.get(provider)?.map((candidate) => candidate.configurationId) ?? [];
  }

  preparedVersions(provider: string) {
    return this.candidates.get(provider)?.map((candidate) => candidate.configurationVersion) ?? [];
  }

  makeConnectionUnavailable(provider: string) {
    this.unavailableConnections.add(provider);
  }

  connectionUnavailable(provider: string) {
    return this.unavailableConnections.has(provider);
  }

  failNextStart(provider: string) {
    this.failures.add(provider);
  }

  block(provider: string) {
    this.blocked.add(provider);
  }

  /** Blocks every app of a provider, or one app named `<provider>:<app id>`. */
  shouldBlock(provider: string, configurationId: string) {
    return this.blocked.has(provider) || this.blocked.has(`${provider}:${configurationId}`);
  }

  shouldFail(provider: string) {
    return this.failures.delete(provider);
  }

  publish(candidate: Candidate) {
    this.activeCandidates.set(`${candidate.provider}:${candidate.configurationId}`, candidate);
  }

  release(provider: string, applicationId?: string) {
    this.candidates
      .get(provider)
      ?.findLast(
        (candidate) => applicationId === undefined || candidate.configurationId === applicationId,
      )
      ?.release();
  }

  async waitUntilPrepared(provider: string, count = 1) {
    while (this.prepareCount(provider) < count)
      await new Promise((resolve) => setImmediate(resolve));
  }
}

class Candidate implements ProviderRuntimeCandidate {
  private unblock: (() => void) | undefined;
  private released = false;
  readonly beginConnection?: () => Promise<{ url: string }>;
  closeCount = 0;

  constructor(
    readonly provider: Provider,
    private readonly owner: BlockingRuntime,
    readonly configurationId: string,
    readonly configurationVersion: number,
    readonly identity: ProviderApplicationIdentity,
  ) {
    if (!owner.connectionUnavailable(provider)) {
      this.beginConnection = () => Promise.resolve({ url: "https://slack.test/install" });
    }
  }

  async start() {
    if (this.owner.shouldFail(this.provider)) throw new Error("candidate failed");
    if (!this.owner.shouldBlock(this.provider, this.configurationId)) return;
    await new Promise<void>((resolve) => {
      if (this.released) {
        resolve();
        return;
      }
      this.unblock = resolve;
    });
  }

  publish() {
    this.owner.publish(this);
  }

  close() {
    this.closeCount += 1;
    return Promise.resolve();
  }

  release() {
    this.released = true;
    this.unblock?.();
  }
}

function candidateConfigurationId(configuration: ProviderApplicationConfiguration): string {
  if (configuration.provider === "github" || configuration.provider === "slack") {
    return configuration.appId;
  }
  if (configuration.provider === "linear") return configuration.clientId;
  return configuration.applicationId;
}

function slackBinding(applicationId = "A1") {
  return {
    providerApplicationId: applicationId,
    stateVerifier: "state",
    phase: "slack_authorization" as const,
    access: { sessionId: "session", userId: "operator" },
    teamId: "T1",
    teamName: "Acme",
    botUserId: "UBOT",
    botAccessToken: "token",
    scopes: ["chat:write"],
  };
}

function linearBinding() {
  return {
    providerApplicationId: "linear-client",
    stateVerifier: "state",
    phase: "linear_authorization" as const,
    access: { sessionId: "session", userId: "operator" },
    linearOrganizationId: "linear-acme",
    linearOrganizationName: "Acme",
    appUserId: "linear-app-user",
    accessToken: "linear-token",
    refreshToken: "linear-refresh-token",
    accessTokenExpiresAt: null,
    scopes: ["read", "comments:create"],
  };
}
