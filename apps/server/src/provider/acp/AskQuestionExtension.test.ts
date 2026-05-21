import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  AskQuestionRequest,
  extractAskQuestions,
  makeAskQuestionResponse,
} from "./AskQuestionExtension.ts";

const decodeAskQuestionRequest = Schema.decodeUnknownSync(AskQuestionRequest);

describe("AskQuestionExtension", () => {
  it("normalizes Cursor-compatible ask-question requests", () => {
    expect(
      extractAskQuestions({
        toolCallId: "ask-1",
        title: "Need input",
        questions: [
          {
            id: "language",
            prompt: "Which language should I use?",
            options: [
              { id: "ts", label: "TypeScript" },
              { id: "rs", label: "Rust" },
            ],
            allowMultiple: true,
          },
        ],
      }),
    ).toEqual([
      {
        id: "language",
        header: "Question",
        question: "Which language should I use?",
        multiSelect: true,
        options: [
          { label: "TypeScript", description: "TypeScript" },
          { label: "Rust", description: "Rust" },
        ],
      },
    ]);
  });

  it("accepts pi-acp selection payloads for Pi ask_user_questions", () => {
    const request = decodeAskQuestionRequest({
      toolCallId: "ui-1",
      title: "Question 1/1: Pick a fruit",
      questions: [
        {
          id: "selection",
          prompt: "Question 1/1: Pick a fruit",
          options: [
            { id: "0", label: "Apple" },
            { id: "1", label: "Banana" },
            { id: "2", label: "Other (type your own answer)" },
          ],
          allowMultiple: false,
        },
      ],
    });

    expect(extractAskQuestions(request)).toEqual([
      {
        id: "selection",
        header: "Question",
        question: "Question 1/1: Pick a fruit",
        multiSelect: false,
        options: [
          { label: "Apple", description: "Apple" },
          { label: "Banana", description: "Banana" },
          {
            label: "Other (type your own answer)",
            description: "Other (type your own answer)",
          },
        ],
      },
    ]);

    expect(makeAskQuestionResponse({ selection: "Banana" })).toEqual({
      answers: { selection: "Banana" },
    });
    expect(makeAskQuestionResponse({ selection: "Dragonfruit" })).toEqual({
      answers: { selection: "Dragonfruit" },
    });
  });

  it("accepts pi-acp input and confirmation payloads for Pi RPC dialogs", () => {
    const inputRequest = decodeAskQuestionRequest({
      toolCallId: "ui-input",
      title: "Type custom answer",
      questions: [{ id: "value", prompt: "Type custom answer", allowMultiple: false }],
    });
    const confirmRequest = decodeAskQuestionRequest({
      toolCallId: "ui-confirm",
      title: "Continue?",
      questions: [
        {
          id: "confirmed",
          prompt: "Continue?",
          options: [
            { id: "yes", label: "Yes" },
            { id: "no", label: "No" },
          ],
          allowMultiple: false,
        },
      ],
    });

    expect(extractAskQuestions(inputRequest)).toEqual([
      {
        id: "value",
        header: "Question",
        question: "Type custom answer",
        multiSelect: false,
        options: [],
      },
    ]);
    expect(extractAskQuestions(confirmRequest)[0]).toMatchObject({
      id: "confirmed",
      question: "Continue?",
      multiSelect: false,
      options: [
        { label: "Yes", description: "Yes" },
        { label: "No", description: "No" },
      ],
    });
    expect(makeAskQuestionResponse({ value: "Typed answer", confirmed: "yes" })).toEqual({
      answers: { value: "Typed answer", confirmed: "yes" },
    });
  });

  it("uses safe fallbacks for empty ids and prompts without inventing text answers", () => {
    expect(
      extractAskQuestions({
        questions: [{ id: "  ", prompt: "", allowMultiple: false }],
      }),
    ).toEqual([
      {
        id: "question-1",
        header: "Question",
        question: "Continue?",
        multiSelect: false,
        options: [],
      },
    ]);
  });

  it("uses non-empty option label fallbacks", () => {
    expect(
      extractAskQuestions({
        questions: [
          {
            id: "choice",
            prompt: "Pick one",
            options: [
              { id: " fallback ", label: "  " },
              { id: "  ", label: "  " },
            ],
          },
        ],
      })[0]?.options,
    ).toEqual([
      { label: "fallback", description: "fallback" },
      { label: "Option", description: "Option" },
    ]);
  });

  it("returns the ACP response envelope with T3 answers", () => {
    const answers = { scope: "Workspace", files: ["A", "B"] };
    expect(makeAskQuestionResponse(answers)).toEqual({ answers });
  });
});
