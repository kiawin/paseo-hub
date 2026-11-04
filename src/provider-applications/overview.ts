import type { Provider, ProviderApplicationOverview, ProviderApplicationView } from "./index.js";

/** Slack counts once however many of its apps are connected: the count is of providers. */
export function connectedProviderCount(overview: ProviderApplicationOverview): number {
  const { slack, ...others } = overview.providers;
  const connected = (view: ProviderApplicationView) => view.connections.length > 0;
  return Object.values(others).filter(connected).length + (slack.some(connected) ? 1 : 0);
}

/** Slack has no view until an app is saved; its section then starts from an empty one. */
export const UNCONFIGURED_SLACK: ProviderApplicationView = {
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

/** Most in need of attention first: what a section's one pill shows when it holds several apps. */
const ATTENTION: readonly ProviderApplicationView["status"][] = [
  "actionNeeded",
  "verified",
  "connected",
  "managedByEnvironment",
  "notConfigured",
];

/** The status a section headed by several apps shows: the one an operator has to act on first. */
export function headlineStatus(
  views: readonly ProviderApplicationView[],
): ProviderApplicationView["status"] {
  return (
    views
      .map((view) => view.status)
      .toSorted((left, right) => ATTENTION.indexOf(left) - ATTENTION.indexOf(right))[0] ??
    "notConfigured"
  );
}

/** The apps one provider section renders: every saved Slack app, or the provider's one app. */
export function sectionViews(
  overview: ProviderApplicationOverview,
  provider: Provider,
): readonly ProviderApplicationView[] {
  return provider === "slack" ? overview.providers.slack : [overview.providers[provider]];
}
