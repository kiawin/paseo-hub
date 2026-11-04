import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, it } from "vitest";
import { PROVIDER_GUIDES } from "./guides.js";
import type { ProviderApplicationView } from "./index.js";
import { UNCONFIGURED_SLACK } from "./overview.js";
import {
  ManifestBlock,
  ManifestNameContext,
  ProviderSectionLoading,
  SlackApplications,
  type ApplicationSlot,
} from "./provider-section.js";
import { SLACK_APP_NAME_HINT } from "./guides.js";

function loadingMarkup(): string {
  return renderToStaticMarkup(
    <div>
      {PROVIDER_GUIDES.map((guide) => (
        <ProviderSectionLoading key={guide.provider} guide={guide} open={false} />
      ))}
    </div>,
  );
}

describe("provider application loading surface", () => {
  it("offers the three choices and nothing else", () => {
    const markup = loadingMarkup();

    for (const name of ["GitHub", "Slack", "Discord"]) assert.match(markup, new RegExp(name, "u"));
    assert.match(markup, /aria-busy="true"/u);
    for (const header of PROVIDER_GUIDES) {
      assert.ok(markup.includes(header.summary.slice(0, 20)), `${header.name} lost its sub-line`);
    }
  });

  it("opens no provider on its own, so nothing has to be closed before the choice is made", () => {
    const markup = loadingMarkup();

    assert.doesNotMatch(markup, /aria-expanded="true"/u);
    assert.equal(markup.match(/aria-expanded="false"/gu)?.length, PROVIDER_GUIDES.length);
    // Instructions belong to a section someone opened, never to the first paint.
    assert.doesNotMatch(markup, /Create a GitHub App/u);
    assert.doesNotMatch(markup, /Create a Slack app/u);
    assert.doesNotMatch(markup, /App manifest/u);
  });
});

describe("Slack apps in the settings section", () => {
  function slackMarkup(views: readonly ProviderApplicationView[]): {
    markup: string;
    rendered: (string | undefined)[];
  } {
    const rendered: (string | undefined)[] = [];
    const renderApplication = (view: ProviderApplicationView, slot: ApplicationSlot) => {
      rendered.push(slot.applicationId);
      return <p>workflow for {view.identity?.id ?? "a new app"}</p>;
    };
    const markup = renderToStaticMarkup(
      createElement(SlackApplications, {
        guide: SLACK_GUIDE,
        views,
        returned: undefined,
        renderApplication,
      }),
    );
    return { markup, rendered };
  }

  it("shows each saved app on its own, named, with a way to add another", () => {
    const { markup, rendered } = slackMarkup([slackApp("A1"), slackApp("B1")]);

    assert.match(markup, /<h2[^>]*>App A1<\/h2>/u);
    assert.match(markup, /<h2[^>]*>App B1<\/h2>/u);
    // Each saved app's workflow is handed that app's id, which its save, connect and retry send.
    assert.deepEqual(rendered, ["A1", "B1"]);
    assert.match(markup, />Add Slack app<\/button>/u);
  });

  it("gives each app its own status, so a second app needing attention is not hidden", () => {
    const { markup } = slackMarkup([slackApp("A1"), { ...slackApp("B1"), status: "actionNeeded" }]);

    assert.match(markup, /App A1<\/h2>.*?Connected/su);
    assert.match(markup, /App B1<\/h2>.*?Action needed/su);
  });

  it("starts the first app from the paste form, with nothing to add beside it", () => {
    const { markup, rendered } = slackMarkup([]);

    assert.deepEqual(rendered, [undefined]);
    assert.match(markup, /workflow for a new app/u);
    assert.doesNotMatch(markup, /Add Slack app/u);
  });

  it("offers no second app beside one set from the environment", () => {
    const { markup } = slackMarkup([{ ...slackApp("A1"), managedByEnvironment: true }]);

    assert.match(markup, /App A1/u);
    assert.doesNotMatch(markup, /Add Slack app/u);
  });
});

const HELD_NAME = { name: "AskMoe", setName: () => {} };

describe("Slack manifest step", () => {
  it("builds the manifest from the name in its field, and says why the name matters", () => {
    const markup = renderToStaticMarkup(
      createElement(
        ManifestNameContext,
        { value: HELD_NAME },
        createElement(ManifestBlock, { origin: "https://hub.test", transport: "socket" }),
      ),
    );

    assert.match(markup, /value="AskMoe"/u);
    assert.ok(markup.includes(SLACK_APP_NAME_HINT), "the field lost its explanation");
    assert.match(markup, /name: AskMoe/u);
    assert.match(markup, /display_name: AskMoe/u);
    assert.doesNotMatch(markup, /name: Paseo/u);
  });
});

const SLACK_GUIDE = PROVIDER_GUIDES.find((guide) => guide.provider === "slack")!;

function slackApp(id: string): ProviderApplicationView {
  return {
    ...UNCONFIGURED_SLACK,
    status: "connected",
    identity: { provider: "slack", id, name: id },
    identifiers: { transport: "socket" },
    replaceable: false,
    configurationVersion: 1,
  };
}
