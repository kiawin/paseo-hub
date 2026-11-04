import { z } from "zod";
import { reportFailure } from "../../failures/index.js";

const SlackApiResponseSchema = z
  .object({ ok: z.boolean(), error: z.string().optional() })
  .passthrough();
const SlackFileSchema = z
  .object({
    id: z.string().min(1).max(255),
    name: z.string().min(1).max(255).optional(),
    title: z.string().min(1).max(255).optional(),
    mimetype: z.string().min(1).max(255).optional(),
    size: z.number().int().nonnegative().optional(),
  })
  .passthrough();
const SlackThreadMessageSchema = z
  .object({
    ts: z.string().regex(/^\d+\.\d+$/u),
    text: z.string().default(""),
    user: z.string().min(1).max(255).optional(),
    bot_id: z.string().min(1).max(255).optional(),
    files: z.array(SlackFileSchema).optional(),
  })
  .passthrough();
const SlackThreadRepliesSchema = SlackApiResponseSchema.extend({
  messages: z.array(SlackThreadMessageSchema).optional(),
  response_metadata: z.object({ next_cursor: z.string().optional() }).optional(),
});
const SlackFileInfoSchema = SlackApiResponseSchema.extend({
  file: z
    .object({
      id: z.string().min(1).max(255),
      url_private_download: z.url(),
    })
    .optional(),
});
const SlackUserInfoSchema = SlackApiResponseSchema.extend({
  user: z.object({ name: z.string().min(1).max(255) }).optional(),
});
const SLACK_API_TIMEOUT_MS = 10_000;
const SLACK_THREAD_REPLIES_MAX_PAGES = 10;
const SLACK_THREAD_CONTEXT_LIMIT = 200;
const SLACK_REACTION_TARGET_GONE = ["message_not_found", "channel_not_found"] as const;

export interface SlackAttachmentMetadata {
  id: string;
  filename: string;
  contentType: string | null;
  size: number | null;
}

export interface SlackThreadMessage {
  ts: string;
  createdAt: string;
  content: string;
  author: { id: string };
  attachments: SlackAttachmentMetadata[];
}

export interface SlackThreadReadResult {
  messages: SlackThreadMessage[];
  complete: boolean;
}

/** Every call is made with one Slack connection's bot token, so it acts as that app's bot. */
export interface SlackBotClient {
  sendMessage(input: {
    organizationId: string;
    connectionId: string;
    channelId: string;
    threadTs: string;
    content: string;
  }): Promise<void>;
  addReaction(input: {
    organizationId: string;
    connectionId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  removeReaction(input: {
    organizationId: string;
    connectionId: string;
    channelId: string;
    messageTs: string;
    name: string;
  }): Promise<void>;
  readThreadMessages?(input: {
    organizationId: string;
    connectionId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
  }): Promise<SlackThreadReadResult>;
  lookupUserName?(input: {
    organizationId: string;
    connectionId: string;
    userId: string;
  }): Promise<string | undefined>;
  downloadAttachment?(input: {
    organizationId: string;
    connectionId: string;
    fileId: string;
  }): Promise<Response>;
}

/** Carries Slack's error code, which Hub logs; the message is never logged. */
export class SlackApiError extends Error {
  readonly code: string;

  constructor(error: string | undefined) {
    const code = error ?? "unknown_error";
    super(`Slack API ${code}`);
    this.name = "SlackApiError";
    this.code = code;
  }
}

export function createSlackBotClient(options: {
  tokenForConnection(organizationId: string, connectionId: string): Promise<string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}): SlackBotClient {
  const request = options.fetch ?? fetch;

  async function call(
    organizationId: string,
    connectionId: string,
    method: string,
    body: Record<string, string>,
    settledErrors: readonly string[] = [],
  ): Promise<void> {
    const token = await options.tokenForConnection(organizationId, connectionId);
    if (token === undefined) throw new Error("Slack connection is unavailable");
    const response = await request(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    const result = SlackApiResponseSchema.parse(await response.json());
    if (!result.ok && !settledErrors.includes(result.error ?? "")) {
      throw new SlackApiError(result.error);
    }
  }

  async function queryJson(
    organizationId: string,
    connectionId: string,
    method: string,
    query: Record<string, string>,
  ): Promise<unknown> {
    const token = await options.tokenForConnection(organizationId, connectionId);
    if (token === undefined) throw new Error("Slack connection is unavailable");
    const url = new URL(`https://slack.com/api/${method}`);
    for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
    const response = await request(url, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Slack API HTTP ${response.status}`);
    return response.json();
  }

  async function readThreadMessages(input: {
    organizationId: string;
    connectionId: string;
    channelId: string;
    threadTs: string;
    beforeTs: string;
  }): Promise<SlackThreadReadResult> {
    let cursor: string | undefined;
    let root: SlackThreadMessage | undefined;
    let selectedReplies: SlackThreadMessage[] = [];
    const seenCursors = new Set<string>();
    let complete = true;
    let pagesRead = 0;
    while (true) {
      let result: z.infer<typeof SlackThreadRepliesSchema>;
      try {
        result = SlackThreadRepliesSchema.parse(
          await queryJson(input.organizationId, input.connectionId, "conversations.replies", {
            channel: input.channelId,
            ts: input.threadTs,
            latest: input.beforeTs,
            inclusive: "false",
            limit: "100",
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        if (!result.ok) throw new SlackApiError(result.error);
      } catch (error) {
        if (root === undefined && selectedReplies.length === 0) throw error;
        reportFailure(
          error,
          { operation: "slack.thread.history.page", component: "providers", provider: "slack" },
          {
            diagnostic: { connectionId: input.connectionId, channelId: input.channelId, pagesRead },
          },
        );
        complete = false;
        break;
      }
      const page = (result.messages ?? [])
        .map(normalizeThreadMessage)
        .filter((message) => compareSlackTs(message.ts, input.beforeTs) < 0);
      root ??= page.find((message) => message.ts === input.threadTs);
      const replies = [
        ...selectedReplies,
        ...page.filter((message) => message.ts !== input.threadTs),
      ].sort((left, right) => compareSlackTs(right.ts, left.ts));
      if (replies.length > SLACK_THREAD_CONTEXT_LIMIT - 1) complete = false;
      selectedReplies = replies.slice(0, SLACK_THREAD_CONTEXT_LIMIT - 1);
      pagesRead += 1;
      const next = result.response_metadata?.next_cursor;
      cursor = next === undefined || next.length === 0 ? undefined : next;
      if (cursor === undefined) break;
      if (seenCursors.has(cursor)) {
        complete = false;
        break;
      }
      seenCursors.add(cursor);
      if (pagesRead === SLACK_THREAD_REPLIES_MAX_PAGES) {
        complete = false;
        break;
      }
    }

    if (root === undefined) throw new Error("Slack thread root unavailable");
    return {
      messages: [root, ...selectedReplies.sort((left, right) => compareSlackTs(left.ts, right.ts))],
      complete,
    };
  }

  async function downloadAttachment(input: {
    organizationId: string;
    connectionId: string;
    fileId: string;
  }): Promise<Response> {
    const token = await options.tokenForConnection(input.organizationId, input.connectionId);
    if (token === undefined) throw new Error("Slack connection is unavailable");
    const result = SlackFileInfoSchema.parse(
      await queryJson(input.organizationId, input.connectionId, "files.info", {
        file: input.fileId,
      }),
    );
    if (!result.ok || result.file?.id !== input.fileId) {
      throw new Error(`Slack file ${input.fileId} is unavailable`);
    }
    const downloadUrl = new URL(result.file.url_private_download);
    if (
      downloadUrl.protocol !== "https:" ||
      !["files.slack.com", "slack.com"].includes(downloadUrl.hostname)
    ) {
      throw new Error("Slack returned an invalid attachment URL");
    }
    return request(downloadUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(options.requestTimeoutMs ?? SLACK_API_TIMEOUT_MS),
    });
  }

  async function lookupUserName(input: {
    organizationId: string;
    connectionId: string;
    userId: string;
  }): Promise<string | undefined> {
    const result = SlackUserInfoSchema.parse(
      await queryJson(input.organizationId, input.connectionId, "users.info", {
        user: input.userId,
      }),
    );
    if (!result.ok) throw new SlackApiError(result.error);
    return result.user?.name;
  }

  return {
    sendMessage: (input) =>
      call(input.organizationId, input.connectionId, "chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.content,
      }),
    // A retried delivery finds the reaction already in place, or already gone. When the
    // message or its channel is gone there is nothing left to react to, and retrying
    // cannot succeed.
    addReaction: (input) =>
      call(
        input.organizationId,
        input.connectionId,
        "reactions.add",
        { channel: input.channelId, timestamp: input.messageTs, name: input.name },
        ["already_reacted", ...SLACK_REACTION_TARGET_GONE],
      ),
    removeReaction: (input) =>
      call(
        input.organizationId,
        input.connectionId,
        "reactions.remove",
        { channel: input.channelId, timestamp: input.messageTs, name: input.name },
        ["no_reaction", ...SLACK_REACTION_TARGET_GONE],
      ),
    readThreadMessages,
    lookupUserName,
    downloadAttachment,
  };
}

function normalizeThreadMessage(
  message: z.infer<typeof SlackThreadMessageSchema>,
): SlackThreadMessage {
  return {
    ts: message.ts,
    createdAt: new Date(Number(message.ts) * 1_000).toISOString(),
    content: message.text,
    author: { id: message.user ?? message.bot_id ?? "unknown" },
    attachments: (message.files ?? []).map((file) => ({
      id: file.id,
      filename: file.name ?? file.title ?? file.id,
      contentType: file.mimetype ?? null,
      size: file.size ?? null,
    })),
  };
}

function compareSlackTs(left: string, right: string): number {
  return Number(left) - Number(right);
}
