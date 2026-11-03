import type { AuthServer } from "../../auth/server.js";
import { createHash } from "node:crypto";
import type { Database } from "../../db/types.js";
import { replyOutputTool } from "../../execution-capabilities/outputs.js";
import { logger } from "../../logger.js";
import { reportFailure } from "../../failures/index.js";
import { createDiscordRegistration } from "../../providers/discord/index.js";
import { createGitHubRegistration } from "../../providers/github/index.js";
import { createLinearRegistration } from "../../providers/linear/index.js";
import type {
  ProviderRegistration,
  TriggerProviderResources,
} from "../../providers/registration.js";
import { createSlackRegistration } from "../../providers/slack/index.js";
import type { TriggerHandler, TriggerProvider, TriggerSource } from "../../triggers/index.js";
import type {
  Provider,
  ProviderApplicationConfiguration,
  ProviderApplicationIdentity,
  ProviderRuntimeCandidate,
  ProviderRuntimeOwner,
} from "../index.js";
import { parseProviderApplicationConfiguration } from "./store.js";
import type { SlackIntakeHealth, SlackDeliveryStatus } from "../../triggers/slack/source/index.js";
import { GITHUB_TRIGGER_SOURCE_NAMES } from "../../triggers/github/classification.js";

/**
 * One provider's runtime. Trigger resources and the source handler belong to the provider, so an app
 * prepared after startup gets them. Slack runs one slot per app; every other provider runs one app,
 * so publishing its app retires any other.
 */
interface ProviderState {
  slots: Map<string, Slot>;
  triggerResources: TriggerProviderResources | undefined;
  handler: TriggerHandler | undefined;
}

interface Slot {
  active: ActiveRegistration | undefined;
  identity: ProviderApplicationIdentity | undefined;
}

interface ActiveRegistration {
  provider: Provider;
  applicationId: string;
  registration: ProviderRegistration;
  triggers: readonly TriggerProvider[];
  sourcesStarted: boolean;
  acceptingEvents: boolean;
  leases: number;
  retiring: boolean;
  retirement: Promise<void> | undefined;
}

class ProviderRuntimeUnavailableError extends Error {
  constructor(readonly code: string) {
    super(code.replaceAll("_", " "));
    this.name = "ProviderRuntimeUnavailableError";
  }
}

function unavailable(code: string): ProviderRuntimeUnavailableError {
  return new ProviderRuntimeUnavailableError(code);
}

type SlackInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onSlackInstallation"]>
>[0];
type LinearInstallationHandler = Parameters<
  NonNullable<ProviderRuntimeOwner["onLinearInstallation"]>
>[0];

interface DynamicProviderRuntimeOptions {
  database: Database;
  auth: AuthServer;
  applicationBaseUrl: string;
  fetch?: typeof fetch;
  registrationFactory?: (input: {
    provider: Provider;
    configuration: ProviderApplicationConfiguration;
    callbackOrigin: string;
    configurationVersion: number;
    expectedConfigurationVersion: number | undefined;
    activateConfiguration: boolean;
    onVerifiedSlackInstallation: SlackInstallationHandler;
    onVerifiedLinearInstallation: LinearInstallationHandler;
  }) => ProviderRegistration;
}

/** @package */
export class DynamicProviderRuntime implements ProviderRuntimeOwner {
  private readonly providers = new Map<Provider, ProviderState>([
    ["github", emptyState()],
    ["slack", emptyState()],
    ["discord", emptyState()],
    ["linear", emptyState()],
  ]);
  private readonly stable = new Map<Provider, ProviderRegistration>();
  private slackInstallationHandler: SlackInstallationHandler | undefined;
  private linearInstallationHandler: LinearInstallationHandler | undefined;

  constructor(private readonly options: DynamicProviderRuntimeOptions) {
    for (const provider of ["github", "slack", "discord", "linear"] as const) {
      this.stable.set(provider, this.stableRegistration(provider));
    }
  }

  registrations(): readonly ProviderRegistration[] {
    return [
      this.stable.get("github")!,
      this.stable.get("discord")!,
      this.stable.get("slack")!,
      this.stable.get("linear")!,
    ];
  }

  /** One app's identity; without an app id, the provider's first published app. */
  identity(provider: Provider, applicationId?: string): ProviderApplicationIdentity | undefined {
    const state = this.state(provider);
    if (applicationId !== undefined) return state.slots.get(applicationId)?.identity;
    return state.slots.values().next().value?.identity;
  }

  /** Socket Mode delivery of every published Slack app, one entry per app. */
  slackDeliveries(): readonly {
    applicationId: string;
    status(): SlackDeliveryStatus;
    retry(): Promise<void>;
    intake(): SlackIntakeHealth;
  }[] {
    return [...this.state("slack").slots].flatMap(([applicationId, slot]) => {
      const delivery = slot.active?.registration.slackDelivery;
      return delivery === undefined ? [] : [{ applicationId, ...delivery }];
    });
  }

  onSlackInstallation(
    handler: NonNullable<DynamicProviderRuntime["slackInstallationHandler"]>,
  ): void {
    this.slackInstallationHandler = handler;
  }

  onLinearInstallation(
    handler: NonNullable<DynamicProviderRuntime["linearInstallationHandler"]>,
  ): void {
    this.linearInstallationHandler = handler;
  }

  async prepare(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    identity: ProviderApplicationIdentity,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): Promise<ProviderRuntimeCandidate> {
    const registration = this.build(
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      activation,
    );
    const state = this.state(provider);
    const triggerResources = state.triggerResources;
    const active: ActiveRegistration = {
      provider,
      applicationId: identity.id,
      registration,
      triggers:
        triggerResources === undefined
          ? []
          : registration.triggerProviders
              .map((factory) => factory(triggerResources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined),
      sourcesStarted: false,
      acceptingEvents: false,
      leases: 0,
      retiring: false,
      retirement: undefined,
    };
    let published = false;
    return {
      start: async () => {
        if (state.handler === undefined) return;
        await startSources(active, state.handler);
      },
      beginConnection: async (request) => {
        const response = await registration.connection.actions["start"]?.(request);
        if (response === undefined || !response.ok)
          throw unavailable("provider_application_unavailable");
        const body: unknown = await response.json();
        const url =
          body !== null && typeof body === "object" && "url" in body
            ? Reflect.get(body, "url")
            : undefined;
        if (typeof url !== "string") throw unavailable("provider_application_unavailable");
        return { url };
      },
      publish: () => {
        // A new version replaces the same app; every provider but Slack runs only one app.
        const replaced = [...state.slots].filter(
          ([applicationId]) => applicationId === identity.id || provider !== "slack",
        );
        for (const [applicationId] of replaced) {
          if (applicationId !== identity.id) state.slots.delete(applicationId);
        }
        state.slots.set(identity.id, { active, identity });
        active.acceptingEvents = true;
        published = true;
        for (const [, previous] of replaced) {
          if (previous.active === undefined) continue;
          this.retireReplaced(previous.active);
        }
      },
      close: () => (published ? Promise.resolve() : stopSources(active)),
    };
  }

  private retireReplaced(previous: ActiveRegistration): void {
    previous.acceptingEvents = false;
    previous.retiring = true;
    void stopSources(previous).catch((error: unknown) => {
      reportFailure(error, {
        operation: "provider_runtime.retire_inbound",
        component: "provider_runtime",
        provider: previous.provider,
      });
    });
    void this.retireWhenDrained(previous);
  }

  private build(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    configurationVersion: number,
    activation?: {
      expectedConfigurationVersion: number | undefined;
      activateConfiguration: boolean;
    },
  ): ProviderRegistration {
    if (this.options.registrationFactory !== undefined) {
      return this.options.registrationFactory(
        this.customRegistrationInput(
          provider,
          configuration,
          callbackOrigin,
          configurationVersion,
          activation,
        ),
      );
    }
    const shared = {
      database: this.options.database,
      auth: this.options.auth,
      applicationBaseUrl: this.options.applicationBaseUrl,
      publicBaseUrl: callbackOrigin,
      configurationVersion,
      ...(this.options.fetch === undefined ? {} : { fetch: this.options.fetch }),
    };
    if (provider === "github" && configuration.provider === "github") {
      return createGitHubRegistration({ ...shared, configuration });
    }
    if (provider === "slack" && configuration.provider === "slack") {
      return createSlackRegistration({
        ...shared,
        configuration,
        ...(activation?.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: activation.expectedConfigurationVersion }),
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedInstallation: (input) => this.handleSlackInstallation(input),
      });
    }
    if (provider === "discord" && configuration.provider === "discord") {
      return createDiscordRegistration({
        ...shared,
        configuration: {
          clientId: configuration.applicationId,
          clientSecret: configuration.clientSecret,
          botToken: configuration.botToken,
        },
      });
    }
    if (provider === "linear" && configuration.provider === "linear") {
      return createLinearRegistration({
        ...shared,
        configuration,
        ...(activation?.expectedConfigurationVersion === undefined
          ? {}
          : { expectedConfigurationVersion: activation.expectedConfigurationVersion }),
        activateConfiguration: activation?.activateConfiguration ?? false,
        onVerifiedInstallation: (input) => this.handleLinearInstallation(input),
      });
    }
    throw new Error("provider configuration mismatch");
  }

  private customRegistrationInput(
    provider: Provider,
    configuration: ProviderApplicationConfiguration,
    callbackOrigin: string,
    configurationVersion: number,
    activation:
      | {
          expectedConfigurationVersion: number | undefined;
          activateConfiguration: boolean;
        }
      | undefined,
  ): Parameters<NonNullable<DynamicProviderRuntimeOptions["registrationFactory"]>>[0] {
    return {
      provider,
      configuration,
      callbackOrigin,
      configurationVersion,
      expectedConfigurationVersion: activation?.expectedConfigurationVersion,
      activateConfiguration: activation?.activateConfiguration ?? false,
      onVerifiedSlackInstallation: (input) => this.handleSlackInstallation(input),
      onVerifiedLinearInstallation: (input) => this.handleLinearInstallation(input),
    };
  }

  private handleSlackInstallation(input: Parameters<SlackInstallationHandler>[0]): Promise<void> {
    if (this.slackInstallationHandler === undefined) {
      throw unavailable("slack_installation_handler_unavailable");
    }
    return this.slackInstallationHandler(input);
  }

  private handleLinearInstallation(input: Parameters<LinearInstallationHandler>[0]): Promise<void> {
    if (this.linearInstallationHandler === undefined) {
      throw unavailable("linear_installation_handler_unavailable");
    }
    return this.linearInstallationHandler(input);
  }

  private stableRegistration(provider: Provider): ProviderRegistration {
    const state = this.state(provider);
    // Every provider but Slack runs one app, so each call goes to it. A Slack call goes to the app
    // it names, and fails when that app is not running.
    const select = (applicationId: string | undefined): ActiveRegistration | undefined =>
      provider === "slack"
        ? slackRegistration(state, applicationId)
        : state.slots.values().next().value?.active;
    const source: TriggerSource = {
      start: async (handler) => {
        state.handler = handler;
        for (const active of activeRegistrations(state)) await startSources(active, handler);
      },
      stop: async () => {
        state.handler = undefined;
        const results = await Promise.allSettled(
          activeRegistrations(state).map((active) => {
            active.acceptingEvents = false;
            return stopSources(active);
          }),
        );
        const rejected = results.find((result) => result.status === "rejected");
        if (rejected?.status === "rejected") throw rejected.reason;
      },
    };
    const connectionActions = Object.fromEntries(
      actionNames(provider).map((action) => [
        action,
        async (request: Request) => {
          let active: ActiveRegistration | undefined;
          try {
            active = await this.registrationForAction(provider, state, action, request);
          } catch (error) {
            if (!(error instanceof ProviderRuntimeUnavailableError)) throw error;
            return Response.json({ error: error.code }, { status: 409 });
          }
          if (active === undefined) {
            return Response.json({ error: "provider_not_configured" }, { status: 409 });
          }
          return this.withLease(
            active,
            () =>
              active.registration.connection.actions[action]?.(request) ??
              Promise.resolve(Response.json({ error: "provider_not_configured" }, { status: 409 })),
          );
        },
      ]),
    );
    return {
      connection: {
        name: provider,
        status: (connections) =>
          aggregateStatus(
            activeRegistrations(state).map((active) =>
              active.registration.connection.status(connections),
            ),
          ),
        actions: connectionActions,
      },
      ...(provider === "github"
        ? {
            integration: {
              resolve: (
                ...args: Parameters<NonNullable<ProviderRegistration["integration"]>["resolve"]>
              ) => {
                const active = select(undefined);
                const integration = active?.registration.integration;
                if (active === undefined || integration === undefined) {
                  throw unavailable("github_integration_unavailable");
                }
                return this.withLease(active, () => integration.resolve(...args));
              },
              githubAuthority: {
                mint: (
                  input: Parameters<
                    NonNullable<
                      NonNullable<ProviderRegistration["integration"]>["githubAuthority"]
                    >["mint"]
                  >[0],
                ) => {
                  const active = select(undefined);
                  const authority = active?.registration.integration?.githubAuthority;
                  if (active === undefined || authority === undefined) {
                    throw unavailable("github_authority_unavailable");
                  }
                  return this.withLease(active, () => authority.mint(input));
                },
                revoke: (token: string) => {
                  const active = select(undefined);
                  const authority = active?.registration.integration?.githubAuthority;
                  if (active === undefined || authority === undefined) {
                    throw unavailable("github_authority_unavailable");
                  }
                  return this.withLease(active, () => authority.revoke(token));
                },
              },
            },
          }
        : {}),
      triggerProviders: [
        (resources) => {
          state.triggerResources = resources;
          for (const active of activeRegistrations(state)) {
            active.triggers = active.registration.triggerProviders
              .map((factory) => factory(resources))
              .filter((trigger): trigger is TriggerProvider => trigger !== undefined);
          }
          return this.dynamicTrigger(provider, select);
        },
      ],
      sources: [source],
      outputs: [
        {
          type: `${provider}.reply`,
          tool: replyOutputTool,
          available: (context) => {
            let active: ActiveRegistration | undefined;
            try {
              active = select(applicationIdOf(context));
            } catch {
              return false;
            }
            const output = active?.registration.outputs.find(
              (candidate) => candidate.type === `${provider}.reply`,
            );
            return output !== undefined && (output.available?.(context) ?? true);
          },
          execute: (input) => {
            const active = select(applicationIdOf(input.outputContext));
            const output = active?.registration.outputs.find(
              (candidate) => candidate.type === `${provider}.reply`,
            );
            if (active === undefined || output === undefined) {
              throw unavailable(`${provider}_output_unavailable`);
            }
            return this.withLease(active, () => output.execute(input));
          },
        },
      ],
      requests:
        provider === "discord"
          ? []
          : [
              {
                name: provider === "github" ? "webhook" : `${provider}.events`,
                handle: (request) => {
                  const active = state.slots.values().next().value?.active;
                  const handler = active?.registration.requests[0];
                  return active === undefined || handler === undefined
                    ? Promise.resolve(new Response("Not Found", { status: 404 }))
                    : this.withLease(active, () => handler.handle(request));
                },
              },
            ],
      ...(provider === "slack" || provider === "discord"
        ? {
            attachment: {
              provider,
              resolve: (input) => {
                const active = select(applicationIdOf(input.locator));
                const attachment = active?.registration.attachment;
                if (active === undefined || attachment === undefined) {
                  throw unavailable(`${provider}_attachment_unavailable`);
                }
                return this.withLease(active, () => attachment.resolve(input));
              },
            },
          }
        : {}),
    };
  }

  private state(provider: Provider): ProviderState {
    const state = this.providers.get(provider);
    if (state === undefined) throw new Error(`unknown provider: ${provider}`);
    return state;
  }

  private dynamicTrigger(
    provider: Provider,
    select: (applicationId: string | undefined) => ActiveRegistration | undefined,
  ): TriggerProvider {
    // A Slack event names its app; every later hook finds it in the contexts the match produced.
    const current = (...contexts: unknown[]) => {
      const active = select(applicationIdOf(...contexts));
      const trigger = active?.triggers[0];
      if (active === undefined || trigger === undefined) {
        throw unavailable(`${provider}_trigger_unavailable`);
      }
      return { active, trigger };
    };
    const invoke = <T>(
      contexts: readonly unknown[],
      operation: (trigger: TriggerProvider) => Promise<T>,
    ) => {
      const selected = current(...contexts);
      return this.withLease(selected.active, () => operation(selected.trigger));
    };
    return {
      name: provider,
      eventNames: eventNames(provider),
      match: async (external) => {
        const selected = current({ applicationId: payloadApplicationId(external.payload) });
        return this.withLease(selected.active, () => selected.trigger.match(external));
      },
      materializeLaunch: (input) =>
        invoke(
          [input.triggerContext],
          (trigger) => trigger.materializeLaunch?.(input) ?? Promise.resolve({}),
        ),
      materializeContext: (input) =>
        invoke(
          [input.triggerContext],
          (trigger) => trigger.materializeContext?.(input) ?? Promise.resolve(undefined),
        ),
      onDispatchAccepted: (triggerContext, outputContext, reactionState) =>
        invoke(
          [outputContext, triggerContext],
          (trigger) =>
            trigger.onDispatchAccepted?.(triggerContext, outputContext, reactionState) ??
            Promise.resolve(),
        ),
      onAgentExecutionStarted: (triggerContext, outputContext, reactionState) =>
        invoke(
          [outputContext, triggerContext],
          (trigger) =>
            trigger.onAgentExecutionStarted?.(triggerContext, outputContext, reactionState) ??
            Promise.resolve(),
        ),
      onAgentExecutionCompleted: (triggerContext, outputContext, result, reactionState) =>
        invoke(
          [outputContext, triggerContext],
          (trigger) =>
            trigger.onAgentExecutionCompleted?.(
              triggerContext,
              outputContext,
              result,
              reactionState,
            ) ?? Promise.resolve(),
        ),
      onAgentExecutionFailed: (triggerContext, outputContext, reason, reactionState) =>
        invoke(
          [outputContext, triggerContext],
          (trigger) =>
            trigger.onAgentExecutionFailed?.(
              triggerContext,
              outputContext,
              reason,
              reactionState,
            ) ?? Promise.resolve(),
        ),
      onAgentExecutionTerminal: (executionId, triggerContext) =>
        invoke(
          [triggerContext],
          (trigger) =>
            trigger.onAgentExecutionTerminal?.(executionId, triggerContext) ?? Promise.resolve(),
        ),
      onMachineTerminated: (triggerContext, reason, reactionState) =>
        invoke(
          [triggerContext],
          (trigger) =>
            trigger.onMachineTerminated?.(triggerContext, reason, reactionState) ??
            Promise.resolve(),
        ),
    };
  }

  private async withLease<T>(active: ActiveRegistration, operation: () => Promise<T>): Promise<T> {
    active.leases += 1;
    try {
      return await operation();
    } finally {
      active.leases -= 1;
      if (active.retiring) {
        void this.retireWhenDrained(active);
      }
    }
  }

  private retireWhenDrained(active: ActiveRegistration): Promise<void> {
    if (active.leases > 0) return Promise.resolve();
    active.retirement ??= retire(active);
    return active.retirement;
  }

  /**
   * The registration that starts or disconnects a connection. A Slack start names its app, or uses
   * the only one. A disconnect goes to the connection's own app, whose client revokes its token; a
   * Socket Mode app has no client to do that.
   */
  private async connectionActionRegistration(
    provider: Provider,
    state: ProviderState,
    action: string,
    url: URL,
  ): Promise<ActiveRegistration | undefined> {
    const first = state.slots.values().next().value?.active;
    if (provider !== "slack") return first;
    const named = url.searchParams.get("applicationId") ?? undefined;
    if (action !== "disconnect" || named !== undefined) return slackRegistration(state, named);
    const connectionId = url.searchParams.get("connectionId");
    const owner =
      connectionId === null || !UUID.test(connectionId)
        ? undefined
        : await this.options.database.findSlackConnectionApplicationId(connectionId);
    // No such connection: any registration refuses it after checking the caller's access. A
    // connection from before apps were recorded goes to the only active app.
    if (owner === undefined) return first;
    return slackRegistration(state, owner ?? undefined);
  }

  private async registrationForAction(
    provider: Provider,
    providerState: ProviderState,
    action: string,
    request: Request,
  ): Promise<ActiveRegistration | undefined> {
    const first = providerState.slots.values().next().value?.active;
    const url = new URL(request.url);
    if (action !== "callback" && action !== "setup") {
      return this.connectionActionRegistration(provider, providerState, action, url);
    }
    const state = url.searchParams.get("state");
    if (state === null) return first;
    const snapshot = await this.options.database.findConnectionAttemptConfiguration(
      createHash("sha256").update(state).digest("hex"),
    );
    if (snapshot === undefined) return first;
    // The callback belongs to the app its attempt was started for.
    const current =
      snapshot.providerApplicationId === null
        ? first
        : providerState.slots.get(snapshot.providerApplicationId)?.active;
    const existing =
      current?.registration.configurationSnapshot?.version === snapshot.configurationVersion &&
      current.registration.configurationSnapshot.callbackOrigin === snapshot.callbackOrigin
        ? current
        : undefined;
    if (existing !== undefined) return existing;
    try {
      const configuration = parseProviderApplicationConfiguration(snapshot.configurationSnapshot);
      if (configuration.provider !== provider) return first;
      const registration = this.build(
        provider,
        configuration,
        snapshot.callbackOrigin,
        snapshot.configurationVersion,
        {
          expectedConfigurationVersion: snapshot.expectedConfigurationVersion ?? undefined,
          activateConfiguration: snapshot.activateConfiguration,
        },
      );
      const restored: ActiveRegistration = {
        provider,
        applicationId: snapshot.providerApplicationId ?? "",
        registration,
        triggers: [],
        sourcesStarted: false,
        acceptingEvents: false,
        leases: 0,
        retiring: false,
        retirement: undefined,
      };
      return restored;
    } catch (error) {
      reportFailure(error, {
        operation: "provider_runtime.restore_callback_snapshot",
        component: "provider_runtime",
        provider,
      });
      return first;
    }
  }
}

/**
 * The Slack registration a call belongs to. A call that names no app comes from before apps were
 * recorded, or from the one app in effect, so it goes to the only active app.
 */
function slackRegistration(
  state: ProviderState,
  applicationId: string | undefined,
): ActiveRegistration {
  if (applicationId !== undefined) {
    const active = state.slots.get(applicationId)?.active;
    if (active === undefined) throw unavailable("provider_not_configured");
    return active;
  }
  const actives = activeRegistrations(state);
  if (actives.length === 1) return actives[0]!;
  throw unavailable(
    actives.length === 0 ? "provider_not_configured" : "slack_application_required",
  );
}

/** The app id the first of these contexts records, directly or on its Slack `target`. */
function applicationIdOf(...contexts: unknown[]): string | undefined {
  for (const context of contexts) {
    if (!isRecord(context)) continue;
    const direct = nonEmptyString(context["applicationId"]);
    if (direct !== undefined) return direct;
    const target = context["target"];
    const nested = isRecord(target) ? nonEmptyString(target["applicationId"]) : undefined;
    if (nested !== undefined) return nested;
  }
  return undefined;
}

/** A normalized Slack event names the app that received it. */
function payloadApplicationId(payload: unknown): string | undefined {
  return isRecord(payload) ? nonEmptyString(payload["appId"]) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const STATUS_RANK = ["requiresReauthorization", "connected", "disconnected", "notConfigured"];

/** One status for a provider's apps: the one most in need of attention among the configured. */
function aggregateStatus(statuses: readonly unknown[]): unknown {
  const rank = (status: unknown) => {
    const value = isRecord(status) ? nonEmptyString(status["status"]) : undefined;
    const index = STATUS_RANK.indexOf(value ?? "");
    return index === -1 ? 0 : index;
  };
  return (
    statuses.toSorted((left, right) => rank(left) - rank(right))[0] ?? {
      status: "notConfigured" as const,
    }
  );
}

function emptyState(): ProviderState {
  return { slots: new Map(), triggerResources: undefined, handler: undefined };
}

function activeRegistrations(state: ProviderState): ActiveRegistration[] {
  return [...state.slots.values()].flatMap((slot) =>
    slot.active === undefined ? [] : [slot.active],
  );
}

function actionNames(provider: Provider): readonly string[] {
  if (provider === "github") return ["start", "disconnect", "setup", "callback"];
  return ["start", "disconnect", "callback"];
}

function eventNames(provider: Provider): TriggerProvider["eventNames"] {
  if (provider === "slack") return ["slack.mention"];
  if (provider === "discord") return ["discord.mention"];
  if (provider === "linear") return ["linear.issue", "linear.comment"];
  return GITHUB_TRIGGER_SOURCE_NAMES;
}

async function startSources(active: ActiveRegistration, handler: TriggerHandler): Promise<void> {
  if (active.sourcesStarted) return;
  const started: TriggerSource[] = [];
  try {
    for (const source of active.registration.sources) {
      await source.start((trigger) =>
        active.acceptingEvents
          ? handler(trigger)
          : Promise.reject(new Error("provider source was retired")),
      );
      started.push(source);
    }
    active.sourcesStarted = true;
  } catch (error) {
    const cleanup = await Promise.allSettled(started.toReversed().map((source) => source.stop()));
    for (const failure of cleanup) {
      if (failure.status === "rejected") {
        reportFailure(failure.reason, {
          operation: "provider_runtime.start_sources.cleanup",
          component: "provider_runtime",
          provider: active.provider,
        });
      }
    }
    throw error;
  }
}

async function stopSources(active: ActiveRegistration): Promise<void> {
  if (!active.sourcesStarted) return;
  active.sourcesStarted = false;
  const results = await Promise.allSettled(
    active.registration.sources.toReversed().map((source) => source.stop()),
  );
  const rejected = results.find((result) => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
}

async function retire(active: ActiveRegistration): Promise<void> {
  try {
    await stopSources(active);
  } catch (error) {
    reportFailure(
      error,
      {
        operation: "provider_runtime.retire",
        component: "provider_runtime",
        provider: active.provider,
      },
      { logger, kind: "internal" },
    );
  }
}
