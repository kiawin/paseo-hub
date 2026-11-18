/** How long a provider may take to answer with a status and headers. */
export const ATTACHMENT_HEADERS_TIMEOUT_MS = 10_000;
/** How long a started download may go without receiving data before it is abandoned. */
export const ATTACHMENT_BODY_IDLE_TIMEOUT_MS = 10_000;

/**
 * Downloads a provider file without capping the total transfer time. The provider has
 * `headersTimeoutMs` to answer. After that the body may take as long as it likes, as long as
 * no gap between chunks exceeds `idleTimeoutMs`. A fixed deadline would cut off a large file
 * that is still making progress, after its status and headers were already forwarded.
 */
export async function fetchAttachment(
  request: typeof fetch,
  url: URL,
  init: Omit<RequestInit, "signal">,
  timeouts: { headersTimeoutMs?: number; idleTimeoutMs?: number } = {},
): Promise<Response> {
  const headersTimeoutMs = timeouts.headersTimeoutMs ?? ATTACHMENT_HEADERS_TIMEOUT_MS;
  const idleTimeoutMs = timeouts.idleTimeoutMs ?? ATTACHMENT_BODY_IDLE_TIMEOUT_MS;
  const controller = new AbortController();
  const headersTimer = setTimeout(() => controller.abort(timeoutError()), headersTimeoutMs);
  let response: Response;
  try {
    response = await request(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(headersTimer);
  }
  if (response.body === null) return response;

  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      let idleTimer: NodeJS.Timeout | undefined;
      const idle = new Promise<never>((_resolve, reject) => {
        idleTimer = setTimeout(() => reject(timeoutError()), idleTimeoutMs);
      });
      try {
        const chunk = await Promise.race([reader.read(), idle]);
        if (chunk.done) stream.close();
        else stream.enqueue(chunk.value);
      } catch (error) {
        controller.abort(error);
        reader.cancel(error).catch(() => undefined);
        stream.error(error);
      } finally {
        clearTimeout(idleTimer);
      }
    },
    cancel(reason) {
      controller.abort(reason);
      return reader.cancel(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function timeoutError(): DOMException {
  return new DOMException("The operation timed out.", "TimeoutError");
}
