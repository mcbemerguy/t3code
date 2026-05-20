import { describe, expect, it } from "vitest";

import { extractAskQuestions, makeAskQuestionResponse } from "./AskQuestionExtension.ts";

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

  it("uses safe fallbacks for missing option lists and empty strings", () => {
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
        options: [{ label: "OK", description: "Continue" }],
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
