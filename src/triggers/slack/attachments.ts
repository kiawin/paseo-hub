import type {
  AttachmentResolver,
  AttachmentResolverInput,
} from "../../attachments/capabilities.js";
import type { SlackBotClient } from "./client.js";

/** Downloads a file with the bot token of the connection the attachment was registered under. */
export function createSlackAttachmentResolver(client: SlackBotClient): AttachmentResolver {
  return async (input) => {
    const fileId = readSlackFileId(input);
    if (client.downloadAttachment === undefined) {
      throw new Error("Slack attachment download is unavailable");
    }
    return client.downloadAttachment({
      organizationId: input.organizationId,
      connectionId: input.connectionId,
      fileId,
    });
  };
}

function readSlackFileId(input: AttachmentResolverInput): string {
  if (!isRecord(input.locator)) {
    throw new Error("invalid Slack attachment locator");
  }
  const fileId = input.locator["fileId"];
  if (typeof fileId !== "string" || fileId.length === 0) {
    throw new Error("invalid Slack attachment locator");
  }
  return fileId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
