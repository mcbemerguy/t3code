import type { ProviderUserInputAnswers, UserInputQuestion } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const AskQuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
});

const AskQuestion = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  options: Schema.optional(Schema.Array(AskQuestionOption)),
  allowMultiple: Schema.optional(Schema.Boolean),
});

export const AskQuestionRequest = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  questions: Schema.Array(AskQuestion),
});
export type AskQuestionRequest = typeof AskQuestionRequest.Type;

export interface AskQuestionResponse {
  readonly answers: ProviderUserInputAnswers;
}

function nonEmptyOrFallback(value: string | null | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

export function extractAskQuestions(params: AskQuestionRequest): ReadonlyArray<UserInputQuestion> {
  return params.questions.map((question, index) => {
    const options = question.options ?? [];
    return {
      id: nonEmptyOrFallback(question.id, `question-${index + 1}`),
      header: "Question",
      question: nonEmptyOrFallback(question.prompt, "Continue?"),
      multiSelect: question.allowMultiple === true,
      options:
        options.length > 0
          ? options.map((option) => {
              const label = nonEmptyOrFallback(
                option.label,
                nonEmptyOrFallback(option.id, "Option"),
              );
              return {
                label,
                description: label,
              };
            })
          : [{ label: "OK", description: "Continue" }],
    };
  });
}

export function makeAskQuestionResponse(answers: ProviderUserInputAnswers): AskQuestionResponse {
  return { answers };
}
