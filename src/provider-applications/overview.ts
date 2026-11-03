import type { Provider, ProviderApplicationOverview, ProviderApplicationView } from "./index.js";

/** Slack counts once however many of its apps are connected: the count is of providers. */
export function connectedProviderCount(overview: ProviderApplicationOverview): number {
  const { slack, ...others } = overview.providers;
  const connected = (view: ProviderApplicationView) => view.connections.length > 0;
  return Object.values(others).filter(connected).length + (slack.some(connected) ? 1 : 0);
}

/** Slack has no view until an app is saved; its section then starts from an empty one. */
const UNCONFIGURED_SLACK: ProviderApplicationView = {
  provider: "slack",
  status: "notConfigured",
  managedByEnvironment: false,
  identifiers: {},
  identity: null,
  connections: [],
  eventsConfigured: false,
  lastEventAt: null,
  replaceable: true,
  configurationVersion: null,
};

/** The view one provider section renders. Slack's section shows its first app. */
export function sectionView(
  overview: ProviderApplicationOverview,
  provider: Provider,
): ProviderApplicationView {
  if (provider !== "slack") return overview.providers[provider];
  return overview.providers.slack[0] ?? UNCONFIGURED_SLACK;
}
