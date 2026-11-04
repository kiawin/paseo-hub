import type { AuthServer } from "../../auth/server.js";
import type { Database } from "../../db/types.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { createLinearRegistration } from "../../providers/linear/index.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import {
  createSlackSocketInstallationVerifier,
  type SlackSocketInstallationVerifier,
} from "../../providers/slack/installation.js";
import { startSlackSocketFixture } from "../../test-utils/slack-socket-fixture.js";
import type { SlackConnectionClient, SlackInstallation } from "../../providers/slack/client.js";
import type { LinearConnectionClient, LinearInstallation } from "../../providers/linear/client.js";
import type { ProviderRegistration } from "../../providers/registration.js";
import {
  ProviderVerificationError,
  type Provider,
  type ProviderApplicationConfiguration,
  type ProviderApplicationIdentity,
  type ProviderApplicationVerifier,
} from "../../provider-applications/index.js";
import {
  BrowserDiscordBot,
  BrowserDiscordConnections,
  BrowserGitHubAuth,
  BrowserGitHubConnections,
  BrowserGitHubConfiguration,
  BrowserGitHubReactions,
  BrowserSlackBot,
  type BrowserProviderScenario,
} from "./browser-providers.js";

/**
 * The credentials the fixture providers accept. A browser journey types exactly these to make
 * verification succeed and anything else to make it fail, so the failure path exercises a real
 * server answer rather than a client-side guess about what the provider would have said.
 */
export const FIXTURE_APP_CREDENTIALS = {
  github: {
    appId: "42",
    appSlug: "paseo",
    clientId: "client",
    clientSecret: "secret",
    privateKey: "fixture-private-key",
  },
  discord: {
    applicationId: "900",
    clientSecret: "secret",
    botToken: "token",
  },
  slack: {
    appId: "browser-slack-app",
    clientId: "browser-slack-client",
    clientSecret: "browser-slack-client-secret",
  },
  linear: {
    clientId: "browser-linear-client",
    clientSecret: "browser-linear-client-secret",
    webhookSecret: "browser-linear-webhook-secret",
  },
} as const;

export const FIXTURE_SLACK_SOCKET_CREDENTIALS = {
  appToken: "xapp-browser-fixture",
  botToken: "xoxb-browser-fixture",
} as const;

/**
 * The Socket Mode apps the Slack fixture runs, in the one workspace `T-ACME`: the first is the app
 * every single-app journey uses, the second the bot a two-app journey adds beside it.
 */
export const FIXTURE_SLACK_SOCKET_APPS = [
  {
    appId: FIXTURE_APP_CREDENTIALS.slack.appId,
    ...FIXTURE_SLACK_SOCKET_CREDENTIALS,
    botId: "B-BROWSER",
    botUserId: "B1",
  },
  {
    appId: "browser-slack-app-2",
    appToken: "xapp-browser-fixture-2",
    botToken: "xoxb-browser-fixture-2",
    botId: "B-BROWSER-2",
    botUserId: "B2",
  },
] as const;

type SlackSocketFixtureServer = Awaited<ReturnType<typeof startSlackSocketFixture>>;

/** A provider-side HTTP + WebSocket fixture. Browser journeys cross the same wire boundaries as
 * production; only Slack's side of the internet is local. Each fixture app has its own Slack
 * endpoint, as each app's tokens only open that app's socket. */
export class BrowserSlackSocketFixture {
  private readonly fixtures = new Map<string, SlackSocketFixtureServer>();

  constructor(private readonly scenario: BrowserProviderScenario = "connected") {}

  async start(): Promise<void> {
    for (const app of FIXTURE_SLACK_SOCKET_APPS) {
      this.fixtures.set(
        app.appId,
        await startSlackSocketFixture([], {
          ...app,
          teamId: "T-ACME",
          ...(this.scenario === "slack-permission-missing" ? { scopes: ["chat:write"] } : {}),
        }),
      );
    }
  }

  /** The first app's endpoint. */
  get apiBaseUrl(): string {
    return this.apiBaseUrlFor(FIXTURE_APP_CREDENTIALS.slack.appId);
  }

  /** The endpoint of the app with this id. */
  apiBaseUrlFor(appId: string): string {
    return this.fixture(appId).apiBaseUrl;
  }

  /** Verifies against the endpoint of the app the tokens belong to, as Slack would. */
  verifier(): SlackSocketInstallationVerifier {
    return {
      verify: (appToken, botToken) => {
        // Tokens no fixture app owns are Slack's refusal, answered by the first app's endpoint.
        const app = FIXTURE_SLACK_SOCKET_APPS.find((entry) => entry.appToken === appToken);
        return createSlackSocketInstallationVerifier({
          apiBaseUrl: this.apiBaseUrlFor(app?.appId ?? FIXTURE_SLACK_SOCKET_APPS[0].appId),
        }).verify(appToken, botToken);
      },
    };
  }

  async deliverMention(
    eventId: string,
    appId: string = FIXTURE_APP_CREDENTIALS.slack.appId,
  ): Promise<void> {
    const fixture = this.fixture(appId);
    const app = FIXTURE_SLACK_SOCKET_APPS.find((entry) => entry.appId === appId);
    if (app === undefined) throw new Error(`Slack fixture runs no app ${appId}`);
    const envelopeId = `envelope-${eventId}`;
    fixture.send({
      type: "events_api",
      envelope_id: envelopeId,
      payload: {
        type: "event_callback",
        team_id: "T-ACME",
        api_app_id: appId,
        event_id: eventId,
        event_time: 1_700_000_000,
        event: {
          type: "app_mention",
          user: "U1",
          channel: "C1",
          text: `<@${app.botUserId}> socket delivery`,
          ts: "1700000000.000100",
          // A reply in a thread, so launching the run reads the thread before the mention.
          thread_ts: "1700000000.000001",
          event_ts: "1700000000.000100",
        },
      },
    });
    const deadline = Date.now() + 5_000;
    while (
      !fixture.acks.some(
        (ack) =>
          ack !== null && typeof ack === "object" && Reflect.get(ack, "envelope_id") === envelopeId,
      )
    ) {
      if (Date.now() >= deadline)
        throw new Error("Slack fixture did not receive an acknowledgement");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async close(): Promise<void> {
    await Promise.all([...this.fixtures.values()].map((fixture) => fixture.close()));
  }

  private fixture(appId: string): SlackSocketFixtureServer {
    if (!FIXTURE_SLACK_SOCKET_APPS.some((app) => app.appId === appId)) {
      throw new Error(`Slack fixture runs no app ${appId}`);
    }
    const fixture = this.fixtures.get(appId);
    if (fixture === undefined) throw new Error("Slack fixture is not running");
    return fixture;
  }
}

export const FIXTURE_APP_IDENTITIES: Readonly<Record<Provider, ProviderApplicationIdentity>> = {
  github: { provider: "github", id: "42", name: "Paseo Hub", ownerLogin: "acme-inc" },
  discord: { provider: "discord", id: "900", name: "Paseo" },
  slack: { provider: "slack", id: "browser-slack-app", name: "Paseo" },
  linear: { provider: "linear", id: "browser-linear-client", name: "Paseo" },
};

/** The identity an environment-configured provider activates with at boot. */
export function fixtureEnvironmentIdentity(provider: Provider): ProviderApplicationIdentity {
  return FIXTURE_APP_IDENTITIES[provider];
}

/**
 * Stands in for authenticating as the App at GitHub and for `users/@me` at Discord. It answers
 * the way those endpoints do — identity on a match, rejection otherwise — so the surface's honest
 * status ladder is driven by a real round trip through the provider-applications boundary.
 */
export class BrowserProviderApplicationVerifier implements ProviderApplicationVerifier {
  constructor(private readonly scenario: BrowserProviderScenario = "connected") {}

  verify(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
  ): Promise<ProviderApplicationIdentity> {
    if (provider !== configuration.provider) {
      return Promise.reject(new ProviderVerificationError("credentialsRejected"));
    }
    if (configuration.provider === "github") {
      if (this.scenario === "github-verification-internal") {
        return Promise.reject(new Error("fixture github verification fault"));
      }
      const expected = FIXTURE_APP_CREDENTIALS.github;
      if (configuration.privateKey !== expected.privateKey) {
        return Promise.reject(
          new ProviderVerificationError("credentialsRejected", 401, { subject: "privateKey" }),
        );
      }
      // The key authenticated an App; the App ID names which one. A mismatch is its own answer.
      return configuration.appId === expected.appId
        ? Promise.resolve(FIXTURE_APP_IDENTITIES.github)
        : Promise.reject(
            new ProviderVerificationError("credentialsRejected", undefined, {
              subject: "identityMismatch",
            }),
          );
    }
    if (configuration.provider === "discord") {
      if (this.scenario === "discord-verification-network") {
        return Promise.reject(new ProviderVerificationError("network"));
      }
      if (this.scenario === "discord-rate-limited") {
        return Promise.reject(new ProviderVerificationError("rateLimited", 429));
      }
      if (
        this.scenario === "discord-disallowed-intents" &&
        configuration.applicationId === FIXTURE_APP_CREDENTIALS.discord.applicationId
      ) {
        return Promise.resolve(FIXTURE_APP_IDENTITIES.discord);
      }
      const expected = FIXTURE_APP_CREDENTIALS.discord;
      if (configuration.botToken !== expected.botToken) {
        return Promise.reject(
          new ProviderVerificationError("credentialsRejected", 401, { subject: "botToken" }),
        );
      }
      if (configuration.applicationId !== expected.applicationId) {
        return Promise.reject(
          new ProviderVerificationError("credentialsRejected", undefined, {
            subject: "identityMismatch",
          }),
        );
      }
      // Discord's client credentials grant is the only thing that can prove the Client Secret,
      // so the fixture checks it too — otherwise "Verified" would mean less here than in production.
      return this.scenario === "discord-client-secret-rejected" ||
        configuration.clientSecret !== expected.clientSecret
        ? Promise.reject(
            new ProviderVerificationError("credentialsRejected", 401, { subject: "clientSecret" }),
          )
        : Promise.resolve(FIXTURE_APP_IDENTITIES.discord);
    }
    // Slack matches production: client credentials have no honest verification endpoint, so the
    // installation callback is the only thing that can accept them.
    return Promise.reject(new ProviderVerificationError("credentialsRejected"));
  }
}

export interface BrowserProviderApplicationFixtures {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  scenario: BrowserProviderScenario;
  bot: BrowserDiscordBot;
  slackBot: BrowserSlackBot;
  githubConfiguration: BrowserGitHubConfiguration;
  slackSocket: BrowserSlackSocketFixture;
}

/**
 * Builds a registration from a configuration the operator just saved, wired to the fixture
 * provider clients instead of the real APIs. This is the same seam `src/index.ts` leaves open for
 * production, so the dynamic activation path under test is the production one.
 */
export function browserRegistrationFactory(fixtures: BrowserProviderApplicationFixtures) {
  // These clients model the provider, not one Hub registration. Connection starts use a
  // short-lived registration while callbacks may be handled by the active or reconstructed
  // registration, so the provider-side authorization state must outlive either one.
  const githubConnections = new BrowserGitHubConnections(
    fixtures.applicationBaseUrl,
    fixtures.scenario,
  );
  const discordConnections = new BrowserDiscordConnections(
    fixtures.applicationBaseUrl,
    fixtures.scenario,
  );
  return (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: NonNullable<
      Parameters<typeof createSlackRegistration>[0]["onVerifiedInstallation"]
    >;
    onVerifiedLinearInstallation: NonNullable<
      Parameters<typeof createLinearRegistration>[0]["onVerifiedInstallation"]
    >;
  }): ProviderRegistration => {
    const shared = {
      database: fixtures.database,
      auth: fixtures.auth,
      applicationBaseUrl: fixtures.applicationBaseUrl,
      publicBaseUrl: input.callbackOrigin,
      configurationVersion: input.configurationVersion,
    };
    const { configuration } = input;
    if (configuration.provider === "github") {
      return createGitHubRegistration({
        ...shared,
        configuration,
        appAuth: new BrowserGitHubAuth(),
        connectionClient: githubConnections,
        configurationProvider: fixtures.githubConfiguration,
        reactionClient: new BrowserGitHubReactions(),
      });
    }
    if (configuration.provider === "discord") {
      return createDiscordRegistration({
        ...shared,
        configuration: {
          clientId: configuration.applicationId,
          clientSecret: configuration.clientSecret,
          botToken: configuration.botToken,
        },
        bot: fixtures.bot,
        connectionClient: discordConnections,
      });
    }
    if (configuration.provider === "linear") {
      return createLinearRegistration({
        ...shared,
        configuration,
        connectionClient: new BrowserLinearConnections(input.callbackOrigin),
        ...(input.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: input.expectedConfigurationVersion }),
        activateConfiguration: input.activateConfiguration,
        onVerifiedInstallation: input.onVerifiedLinearInstallation,
      });
    }
    return createSlackRegistration({
      ...shared,
      configuration,
      botClient: fixtures.slackBot,
      connectionClient: new BrowserSlackConnections(
        input.callbackOrigin,
        fixtures.scenario,
        configuration.appId,
      ),
      ...(input.expectedConfigurationVersion === undefined
        ? {}
        : { expectedConfigurationVersion: input.expectedConfigurationVersion }),
      activateConfiguration: input.activateConfiguration,
      onVerifiedInstallation: input.onVerifiedSlackInstallation,
      socket: {
        // Only a Socket Mode app opens a socket, and Slack's answer for it is its own app's.
        apiUrl: `${fixtures.slackSocket.apiBaseUrlFor(
          configuration.transport === "socket"
            ? configuration.appId
            : FIXTURE_SLACK_SOCKET_APPS[0].appId,
        )}/apps.connections.open`,
      },
    });
  };
}

class BrowserLinearConnections implements LinearConnectionClient {
  constructor(private readonly publicBaseUrl: string) {}

  authorizationUrl(state: string): string {
    const url = new URL("/e2e/providers/linear/authorize", this.publicBaseUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  exchangeCode(code: string): Promise<LinearInstallation> {
    if (code !== "accepted") return Promise.reject(new Error("installation rejected"));
    return Promise.resolve({
      linearOrganizationId: "linear-acme",
      linearOrganizationName: "Acme",
      appUserId: "linear-app-user",
      accessToken: "linear-token",
      refreshToken: "linear-refresh-token",
      accessTokenExpiresAt: null,
      scopes: ["read", "comments:create"],
    });
  }

  refresh(): Promise<never> {
    return Promise.reject(new Error("unused"));
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }
}

/** Slack's OAuth side for one app: an installation names that app and its own bot. */
class BrowserSlackConnections implements SlackConnectionClient {
  constructor(
    private readonly publicBaseUrl: string,
    private readonly scenario: BrowserProviderScenario,
    private readonly appId: string = FIXTURE_APP_CREDENTIALS.slack.appId,
  ) {}

  private get bot(): (typeof FIXTURE_SLACK_SOCKET_APPS)[number] {
    return (
      FIXTURE_SLACK_SOCKET_APPS.find((app) => app.appId === this.appId) ??
      FIXTURE_SLACK_SOCKET_APPS[0]
    );
  }

  authorizationUrl(state: string): string {
    const url = new URL("/e2e/providers/slack/authorize", this.publicBaseUrl);
    url.searchParams.set("state", state);
    return url.toString();
  }

  exchangeCode(code: string): Promise<SlackInstallation> {
    if (code !== "accepted") return Promise.reject(new Error("installation rejected"));
    return Promise.resolve({
      appId: this.appId,
      teamId: "T-ACME",
      teamName: "Acme",
      botUserId: this.bot.botUserId,
      botAccessToken:
        this.appId === FIXTURE_APP_CREDENTIALS.slack.appId
          ? "xoxb-fixture"
          : `xoxb-fixture-${this.appId}`,
      scopes:
        this.scenario === "slack-permission-missing"
          ? ["chat:write"]
          : [
              "app_mentions:read",
              "channels:history",
              "chat:write",
              "files:read",
              "groups:history",
              "reactions:write",
              "users:read",
            ],
    });
  }

  verifyInstallation(installation: SlackInstallation): Promise<void> {
    if (installation.teamId !== "T-ACME" || installation.botUserId !== this.bot.botUserId) {
      return Promise.reject(new Error("auth.test rejected the bot"));
    }
    return Promise.resolve();
  }

  revoke(): Promise<void> {
    return Promise.resolve();
  }
}
