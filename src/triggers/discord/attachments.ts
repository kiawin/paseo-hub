import type {
  AttachmentResolver,
  AttachmentResolverInput,
} from "../../attachments/capabilities.js";
import { fetchAttachment } from "../../attachments/download.js";

const DISCORD_ATTACHMENT_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);

export function createDiscordAttachmentResolver(
  options: {
    fetch?: typeof fetch;
    requestTimeoutMs?: number;
  } = {},
): AttachmentResolver {
  const request = options.fetch ?? fetch;
  return async (input) => {
    const url = readDiscordAttachmentUrl(input);
    const timeout = options.requestTimeoutMs;
    return fetchAttachment(
      request,
      url,
      { method: "GET" },
      timeout === undefined ? {} : { headersTimeoutMs: timeout, idleTimeoutMs: timeout },
    );
  };
}

function readDiscordAttachmentUrl(input: AttachmentResolverInput): URL {
  if (!isRecord(input.locator)) {
    throw new Error("invalid Discord attachment locator");
  }
  const value = input.locator["url"];
  if (typeof value !== "string") throw new Error("invalid Discord attachment locator");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !DISCORD_ATTACHMENT_HOSTS.has(url.hostname) ||
    !url.pathname.startsWith("/attachments/")
  ) {
    throw new Error("invalid Discord attachment URL");
  }
  return url;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
