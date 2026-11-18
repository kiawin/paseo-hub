import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { fetchAttachment } from "./download.js";

const url = new URL("https://files.example.test/file.bin");
const encoder = new TextEncoder();

function slowBody(chunks: number, gapMs: number, stallAfter?: number): ReadableStream<Uint8Array> {
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stallAfter !== undefined && sent === stallAfter) {
        await new Promise(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, gapMs));
      if (sent === chunks) {
        controller.close();
        return;
      }
      sent += 1;
      controller.enqueue(encoder.encode("x"));
    },
  });
}

function neverAnswers(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const signal = init?.signal;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("fetchAttachment", () => {
  it("finishes a download that outlasts the idle timeout in total but never stalls", async () => {
    const response = await fetchAttachment(
      () => Promise.resolve(new Response(slowBody(8, 20), { status: 200 })),
      url,
      {},
      { headersTimeoutMs: 50, idleTimeoutMs: 100 },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.text()).length, 8);
  });

  it("aborts a download that stops sending data", async () => {
    const response = await fetchAttachment(
      () => Promise.resolve(new Response(slowBody(8, 5, 2))),
      url,
      {},
      { headersTimeoutMs: 50, idleTimeoutMs: 50 },
    );
    await assert.rejects(response.text(), { name: "TimeoutError" });
  });

  it("aborts a request whose headers never arrive", async () => {
    await assert.rejects(fetchAttachment(neverAnswers, url, {}, { headersTimeoutMs: 10 }), {
      name: "TimeoutError",
    });
  });

  it("keeps the status and headers and aborts the provider request when the consumer cancels", async () => {
    let providerSignal: AbortSignal | undefined;
    const response = await fetchAttachment(
      (_input, init) => {
        providerSignal = init?.signal ?? undefined;
        return Promise.resolve(
          new Response(slowBody(8, 5), { status: 206, headers: { etag: '"a"' } }),
        );
      },
      url,
      {},
    );
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("etag"), '"a"');
    await response.body?.cancel();
    assert.equal(providerSignal?.aborted, true);
  });
});
