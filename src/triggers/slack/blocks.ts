/** Converts the Slack block elements that carry message text into stable plain text. */
export function flattenSlackMessage(text: string, blocks: readonly unknown[] = []): string {
  const structured = blocks.map(flattenBlock).filter(Boolean).join("\n").trim();
  if (!structured || text.includes(structured)) return text;

  const fallback = text.replace(/(?:^|[,\s]+)with interactive elements\s*$/iu, "").trimEnd();
  if (structured.startsWith(fallback)) return structured;
  if (fallback.startsWith(structured)) return fallback;
  return [fallback, structured].filter(Boolean).join("\n");
}

function flattenBlock(value: unknown): string {
  if (!isRecord(value)) return "";
  const block = value;
  if (block["type"] === "table" && Array.isArray(block["rows"])) {
    return block["rows"]
      .map((row) => (Array.isArray(row) ? row.map(flattenElement).filter(Boolean).join(" | ") : ""))
      .filter(Boolean)
      .join("\n");
  }
  if (block["type"] === "rich_text") return flattenElements(block["elements"]);
  return flattenElement(block);
}

function flattenElement(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return flattenElements(value);
  if (!isRecord(value)) return "";
  const element = value;
  const richText = flattenRichTextElement(element, element["type"]);
  if (richText !== undefined) return richText;
  if (typeof element["text"] === "string") return element["text"];
  if (Array.isArray(element["cells"])) return flattenElements(element["cells"]);
  if (Array.isArray(element["elements"])) return flattenElements(element["elements"]);
  return "";
}

function flattenRichTextElement(
  element: Record<string, unknown>,
  type: unknown,
): string | undefined {
  if (type === "user" && typeof element["user_id"] === "string") return `<@${element["user_id"]}>`;
  if (type === "channel" && typeof element["channel_id"] === "string")
    return `<#${element["channel_id"]}>`;
  if (type === "emoji" && typeof element["name"] === "string") return `:${element["name"]}:`;
  if (type === "broadcast" && typeof element["range"] === "string") return `<!${element["range"]}>`;
  if (type === "usergroup" && typeof element["usergroup_id"] === "string")
    return `<!subteam^${element["usergroup_id"]}>`;
  if (type === "link" && typeof element["url"] === "string")
    return typeof element["text"] === "string" ? element["text"] : element["url"];
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenElements(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values.map(flattenElement).filter(Boolean).join("");
}
