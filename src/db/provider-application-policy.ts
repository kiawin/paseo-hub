import type { Provider } from "../provider-applications/index.js";

/**
 * The lock key of one app. Slack runs several apps, each on its own key; every other provider runs
 * one, keyed by the provider alone, which GitHub installation sync also takes. Every writer of an
 * app's settings, activation or connection takes this key, so they serialize.
 */
export function providerApplicationLockKey(
  provider: Provider,
  applicationId: string | null,
): readonly string[] {
  return provider === "slack" && applicationId !== null ? [provider, applicationId] : [provider];
}

/**
 * Which other activations a new activation replaces. Slack runs several stored apps beside each
 * other, or one environment-managed app (version 0) alone: a stored app (version above 0) replaces
 * only a leftover version-0 row, and version 0 replaces every other. Every other provider runs one
 * app, so activating its app replaces the last.
 */
export function activationReplaces(
  provider: Provider,
  configurationVersion: number,
): "every other app" | "an environment-managed app" {
  return provider === "slack" && configurationVersion !== 0
    ? "an environment-managed app"
    : "every other app";
}
