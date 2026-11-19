import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { retryPortBindingTimeout } from "./postgres-container.js";

const portBindingTimeout = () =>
  new Error("Timed out after 10000ms while waiting for container ports to be bound to the host");

function failingThen<T>(errors: readonly Error[], value: T) {
  let calls = 0;
  const start = async (): Promise<T> => {
    const error = errors[calls];
    calls += 1;
    if (error !== undefined) throw error;
    return value;
  };
  return { start, calls: () => calls };
}

describe("retryPortBindingTimeout", () => {
  it("retries a port binding timeout and returns the started container", async () => {
    const container = failingThen([portBindingTimeout(), portBindingTimeout()], "started");
    assert.equal(await retryPortBindingTimeout(container.start), "started");
    assert.equal(container.calls(), 3);
  });

  it("gives up after three port binding timeouts", async () => {
    const container = failingThen(
      [portBindingTimeout(), portBindingTimeout(), portBindingTimeout()],
      "started",
    );
    await assert.rejects(retryPortBindingTimeout(container.start), /container ports to be bound/u);
    assert.equal(container.calls(), 3);
  });

  it("does not retry any other error", async () => {
    const container = failingThen([new Error("pull access denied")], "started");
    await assert.rejects(retryPortBindingTimeout(container.start), /pull access denied/u);
    assert.equal(container.calls(), 1);
  });
});
