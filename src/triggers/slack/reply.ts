import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { SlackBotClient } from "./client.js";

const SlackReplyArgsSchema = z.object({ content: z.string().min(1) });
const SlackReplyOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  connectionId: z.string().min(1),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});

export function createSlackReplyExecutor(options: { client: SlackBotClient }): OutputExecutor {
  return async function executeSlackReply(input) {
    const args = SlackReplyArgsSchema.parse(input.args);
    const context = SlackReplyOutputContextSchema.parse(input.outputContext);
    await options.client.sendMessage({
      organizationId: context.organizationId,
      connectionId: context.connectionId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      content: args.content,
    });
  };
}
