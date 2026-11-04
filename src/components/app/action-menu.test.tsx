import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { ActionMenu, type ActionMenuItem } from "./action-menu.js";

const ignore = () => {};
const ONE: readonly ActionMenuItem[] = [{ id: "A1", label: "App A1", onSelect: ignore }];
const TWO: readonly ActionMenuItem[] = [...ONE, { id: "B1", label: "App B1", onSelect: ignore }];

describe("action menu", () => {
  it("is just the button when there is one target", () => {
    const markup = renderToStaticMarkup(<ActionMenu label="Connect Slack" items={ONE} />);

    assert.match(markup, />Connect Slack<\/button>/u);
    assert.doesNotMatch(markup, /aria-haspopup/u);
  });

  it("opens a menu of targets when there are several", () => {
    const markup = renderToStaticMarkup(<ActionMenu label="Connect Slack" items={TWO} />);

    assert.match(markup, /aria-haspopup="menu"/u);
    assert.match(markup, /Connect Slack/u);
  });
});
