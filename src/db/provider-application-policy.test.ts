import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { activationReplaces, providerApplicationLockKey } from "./provider-application-policy.js";

describe("provider application policy", () => {
  it("keys a Slack app's lock by app and every other provider's by provider", () => {
    assert.deepEqual(providerApplicationLockKey("slack", "A1"), ["slack", "A1"]);
    assert.deepEqual(providerApplicationLockKey("slack", "B1"), ["slack", "B1"]);
    // A Slack row that no app owns yet takes the provider's key, as every other provider does.
    assert.deepEqual(providerApplicationLockKey("slack", null), ["slack"]);
    for (const provider of ["github", "discord", "linear"] as const) {
      assert.deepEqual(providerApplicationLockKey(provider, "app-1"), [provider]);
    }
  });

  it("lets a stored Slack app replace only an environment-managed one", () => {
    assert.equal(activationReplaces("slack", 1), "an environment-managed app");
    assert.equal(activationReplaces("slack", 7), "an environment-managed app");
    // An environment-managed Slack app (version 0) is alone, and every other provider runs one app.
    assert.equal(activationReplaces("slack", 0), "every other app");
    for (const provider of ["github", "discord", "linear"] as const) {
      assert.equal(activationReplaces(provider, 3), "every other app");
    }
  });
});
