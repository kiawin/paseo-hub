import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { flattenSlackMessage } from "./blocks.js";

describe("Slack message blocks", () => {
  it("flattens rich text and table rows and replaces Slack's interactive fallback", () => {
    assert.equal(
      flattenSlackMessage("<@UBOT> Review, with interactive elements", [
        {
          type: "rich_text",
          elements: [
            { type: "rich_text_section", elements: [{ type: "text", text: "<@UBOT> Review" }] },
          ],
        },
        {
          type: "table",
          rows: [
            [
              { type: "raw_text", text: "Service" },
              { type: "raw_text", text: "Status" },
            ],
            [
              { type: "raw_text", text: "API" },
              { type: "raw_text", text: "Degraded" },
            ],
          ],
        },
      ]),
      "<@UBOT> Review\nService | Status\nAPI | Degraded",
    );
  });

  it("leaves text unchanged when blocks have no supported text", () => {
    assert.equal(flattenSlackMessage("plain message", [{ type: "divider" }]), "plain message");
  });
});
