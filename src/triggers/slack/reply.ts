import { z } from "zod";
import type { OutputExecutor } from "../../execution-capabilities/outputs.js";
import type { SlackBotClient } from "./client.js";

const SlackReplyArgsSchema = z.object({ content: z.string().min(1) });
const SlackReplyOutputContextSchema = z.object({
  organizationId: z.string().min(1),
  connectionId: z.string().min(1).optional(),
  teamId: z.string().min(1),
  channelId: z.string().min(1),
  threadTs: z.string().min(1),
});

export function createSlackReplyExecutor(options: {
  client: SlackBotClient;
  /** The app's own connection in a workspace, for output contexts that name no connection. */
  connectionForWorkspace(organizationId: string, teamId: string): Promise<string | undefined>;
}): OutputExecutor {
  return async function executeSlackReply(input) {
    const args = SlackReplyArgsSchema.parse(input.args);
    const context = SlackReplyOutputContextSchema.parse(input.outputContext);
    // A context recorded before replies named their connection replies as the app's bot there.
    const connectionId =
      context.connectionId ??
      (await options.connectionForWorkspace(context.organizationId, context.teamId));
    if (connectionId === undefined) throw new Error("Slack connection is unavailable");
    await options.client.sendMessage({
      organizationId: context.organizationId,
      connectionId,
      channelId: context.channelId,
      threadTs: context.threadTs,
      content: args.content,
    });
  };
}
