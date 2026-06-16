import assert from "node:assert/strict";

import { describe, it } from "@effect/vitest";

import {
  describeFireAndForgetExtensionUiEvent,
  parsePiExtensionUiDialogRequest,
} from "./PiExtensionUi.ts";

const dimAnsi = "\u001b[38;2;128;128;128m";
const resetAnsi = "\u001b[39m";
const eraseLineAnsi = "\u001b[2K";
const cursorUpAnsi = "\u001b[1A";
const hyperlinkStartAnsi = "\u001b]8;;https://example.com\u0007";
const hyperlinkEndAnsi = "\u001b]8;;\u0007";

describe("PiExtensionUi", () => {
  it("ignores fire-and-forget status and widget updates", () => {
    assert.equal(
      describeFireAndForgetExtensionUiEvent({
        type: "extension_ui_request",
        method: "setStatus",
        statusText: `${dimAnsi}cache: warm${resetAnsi}`,
      }),
      undefined,
    );
    assert.equal(
      describeFireAndForgetExtensionUiEvent({
        type: "extension_ui_request",
        method: "setWidget",
        widgetKey: "image-support",
      }),
      undefined,
    );
    assert.equal(
      describeFireAndForgetExtensionUiEvent({
        type: "extension_ui_request",
        method: "setTitle",
        title: "Pi",
      }),
      undefined,
    );
    assert.equal(
      describeFireAndForgetExtensionUiEvent({
        type: "extension_ui_request",
        method: "set_editor_text",
        text: "draft",
      }),
      undefined,
    );
  });

  it("keeps notifications user-visible and strips ANSI text", () => {
    assert.equal(
      describeFireAndForgetExtensionUiEvent({
        type: "extension_ui_request",
        method: "notify",
        message: `${eraseLineAnsi}${hyperlinkStartAnsi}${dimAnsi}Pi needs attention${resetAnsi}${hyperlinkEndAnsi}`,
      }),
      "Pi needs attention",
    );
  });

  it("strips ANSI from dialog text before presentation", () => {
    const request = parsePiExtensionUiDialogRequest({
      type: "extension_ui_request",
      id: "ask-1",
      method: "input",
      title: `${dimAnsi}Question${resetAnsi}`,
      message: `${cursorUpAnsi}${hyperlinkStartAnsi}${dimAnsi}What next?${resetAnsi}${hyperlinkEndAnsi}`,
      placeholder: `${eraseLineAnsi}${dimAnsi}Type here${resetAnsi}`,
    });

    assert.equal(request?.title, "Question");
    assert.equal(request?.prompt, "What next?");
    assert.equal(request?.placeholder, "Type here");
  });
});
