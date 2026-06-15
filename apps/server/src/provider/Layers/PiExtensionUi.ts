import {
  RuntimeRequestId,
  type ProviderUserInputAnswers,
  type UserInputQuestion,
} from "@t3tools/contracts";

import type {
  PiExtensionUiResponseInput,
  PiRpcEvent,
  PiRpcRuntimeMessage,
} from "./PiSessionRuntime.ts";

const PI_OTHER_ANSWER_LABEL = "Other (type your own answer)";
const PI_OTHER_CUSTOM_ANSWER_LABEL = `${PI_OTHER_ANSWER_LABEL} [custom answer]`;

const SELECTION_QUESTION_ID = "selection";
const INPUT_QUESTION_ID = "value";
const CONFIRM_QUESTION_ID = "confirmed";

const DIALOG_METHODS = new Set(["select", "input", "editor", "confirm"]);

export interface PiExtensionUiDialogRequest {
  readonly id: string;
  readonly requestId: RuntimeRequestId;
  readonly method: "select" | "input" | "editor" | "confirm";
  readonly title: string;
  readonly prompt: string;
  readonly options: ReadonlyArray<string>;
  readonly placeholder?: string;
  readonly prefill?: string;
  readonly raw?: PiRpcRuntimeMessage;
}

export interface PiPendingUserInputRequest extends PiExtensionUiDialogRequest {
  readonly questionId: string;
}

export function isPiExtensionUiRequest(event: PiRpcEvent): boolean {
  return readString(event.type) === "extension_ui_request";
}

export function isDialogExtensionUiMethod(method: string): boolean {
  return DIALOG_METHODS.has(method);
}

export function parsePiExtensionUiDialogRequest(
  event: PiRpcEvent,
  raw?: PiRpcRuntimeMessage,
): PiExtensionUiDialogRequest | undefined {
  const id = coerceId(event.id);
  if (!id) return undefined;

  const method = readString(event.method);
  if (!method || !isDialogExtensionUiMethod(method)) return undefined;

  const title =
    readString(event.title) ?? readString(event.message) ?? readString(event.prompt) ?? method;
  const prompt = readString(event.message) ?? readString(event.prompt) ?? title;
  const placeholder = readString(event.placeholder);
  const prefill = readString(event.prefill) ?? readString(event.text) ?? readString(event.value);

  return {
    id,
    requestId: RuntimeRequestId.make(`pi-extension-ui-${sanitizeId(id)}`),
    method: method as PiExtensionUiDialogRequest["method"],
    title,
    prompt,
    options: toOptionLabels(event.options),
    ...(placeholder !== undefined ? { placeholder } : {}),
    ...(prefill !== undefined ? { prefill } : {}),
    ...(raw !== undefined ? { raw } : {}),
  };
}

export function questionFromPiExtensionUiDialog(
  request: PiExtensionUiDialogRequest,
): PiPendingUserInputRequest | undefined {
  switch (request.method) {
    case "select": {
      const labels = filterPiGeneratedCustomAnswerOption(request.options);
      if (labels.length === 0) return undefined;
      return {
        ...request,
        questionId: SELECTION_QUESTION_ID,
        options: labels,
      };
    }
    case "input":
      return { ...request, questionId: INPUT_QUESTION_ID };
    case "editor":
      return { ...request, questionId: INPUT_QUESTION_ID };
    case "confirm":
      return { ...request, questionId: CONFIRM_QUESTION_ID };
  }
}

export function toUserInputQuestion(request: PiPendingUserInputRequest): UserInputQuestion {
  return {
    id: request.questionId,
    header: request.title,
    question: buildQuestionText(request),
    options: buildQuestionOptions(request),
    multiSelect: false,
  } satisfies UserInputQuestion;
}

export function normalizePiExtensionUiResponse(
  request: PiPendingUserInputRequest,
  answers: ProviderUserInputAnswers,
): PiExtensionUiResponseInput {
  switch (request.method) {
    case "select": {
      const value = normalizeSelectionAnswer(answers, request.questionId, request.options);
      return value ? { id: request.id, value } : cancellationResponse(request);
    }
    case "input":
    case "editor": {
      const value = normalizeTextAnswer(answers, request.questionId);
      return value ? { id: request.id, value } : cancellationResponse(request);
    }
    case "confirm": {
      const confirmed = normalizeConfirmAnswer(extractAnswer(answers, request.questionId));
      return { id: request.id, confirmed: confirmed === true };
    }
  }
}

export function cancellationResponse(
  request: Pick<PiExtensionUiDialogRequest, "id" | "method">,
): PiExtensionUiResponseInput {
  return request.method === "confirm"
    ? { id: request.id, confirmed: false }
    : { id: request.id, cancelled: true };
}

export function describeFireAndForgetExtensionUiEvent(event: PiRpcEvent): string | undefined {
  const method = readString(event.method);
  if (!method) return undefined;

  switch (method) {
    case "notify":
      return readString(event.message) ?? "Pi sent a notification.";
    case "setStatus": {
      const status = readString(event.statusText);
      return status ? `Pi status: ${status}` : "Pi cleared a status indicator.";
    }
    case "setWidget": {
      const key = readString(event.widgetKey);
      return key ? `Pi updated widget: ${key}` : "Pi updated an extension widget.";
    }
    case "setTitle": {
      const title = readString(event.title);
      return title ? `Pi title: ${title}` : "Pi updated the extension title.";
    }
    case "set_editor_text":
      return "Pi updated extension editor text.";
    default:
      return isDialogExtensionUiMethod(method) ? undefined : `Pi extension UI event: ${method}`;
  }
}

function buildQuestionText(request: PiPendingUserInputRequest): string {
  if (request.method === "input" && request.placeholder) {
    return `${request.prompt}\n${request.placeholder}`;
  }
  if (request.method === "editor" && request.prefill) {
    return `${request.prompt}\n\n${request.prefill}`;
  }
  return request.prompt;
}

function buildQuestionOptions(request: PiPendingUserInputRequest): UserInputQuestion["options"] {
  if (request.method === "confirm") {
    return [
      { label: "Yes", description: "Confirm" },
      { label: "No", description: "Cancel" },
    ];
  }
  return request.options.map((label) => ({ label, description: label }));
}

function normalizeSelectionAnswer(
  response: ProviderUserInputAnswers,
  questionId: string,
  options: ReadonlyArray<string>,
): string | null {
  const text = normalizeAnswerToString(extractAnswer(response, questionId));
  if (!text) return null;

  const byIndex = Number.parseInt(text, 10);
  if (String(byIndex) === text && byIndex >= 0 && byIndex < options.length) {
    return options[byIndex] ?? null;
  }

  const byLabel = options.find((label) => label === text);
  return byLabel ?? text;
}

function normalizeTextAnswer(
  response: ProviderUserInputAnswers,
  questionId: string,
): string | null {
  return normalizeAnswerToString(extractAnswer(response, questionId));
}

function normalizeConfirmAnswer(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;

  const text = normalizeAnswerToString(value);
  if (!text) return null;

  const normalized = text.trim().toLowerCase();
  if (["yes", "y", "true", "1", "confirmed", "confirm"].includes(normalized)) return true;
  if (["no", "n", "false", "0", "cancelled", "canceled", "deny", "denied"].includes(normalized))
    return false;
  return null;
}

function extractAnswer(response: ProviderUserInputAnswers, questionId: string): unknown {
  const answers = response.answers;
  if (answers && typeof answers === "object" && !Array.isArray(answers)) {
    const answerMap = answers as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(answerMap, questionId)) return answerMap[questionId];
    const firstKey = Object.keys(answerMap)[0];
    if (firstKey) return answerMap[firstKey];
  }

  if (Object.prototype.hasOwnProperty.call(response, questionId)) return response[questionId];
  if (Object.prototype.hasOwnProperty.call(response, "value")) return response.value;
  if (Object.prototype.hasOwnProperty.call(response, "answer")) return response.answer;

  const firstKey = Object.keys(response)[0];
  return firstKey ? response[firstKey] : undefined;
}

function normalizeAnswerToString(value: unknown): string | null {
  if (typeof value === "string") return value.trim() ? value : null;

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = normalizeAnswerToString(item);
      if (text) return text;
    }
    return null;
  }

  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return (
      normalizeAnswerToString(object.label) ??
      normalizeAnswerToString(object.value) ??
      normalizeAnswerToString(object.id)
    );
  }

  if (typeof value === "number" || typeof value === "boolean") return String(value);

  return null;
}

function filterPiGeneratedCustomAnswerOption(
  options: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const filtered = options.filter((label) => !isPiGeneratedCustomAnswerOption(label));
  return filtered.length > 0 ? filtered : options;
}

function isPiGeneratedCustomAnswerOption(label: string): boolean {
  const normalized = label.trim();
  return normalized === PI_OTHER_ANSWER_LABEL || normalized === PI_OTHER_CUSTOM_ANSWER_LABEL;
}

function toOptionLabels(options: unknown): ReadonlyArray<string> {
  if (!Array.isArray(options)) return [];

  const labels: Array<string> = [];
  for (const option of options) {
    const label =
      typeof option === "string"
        ? option
        : option && typeof option === "object"
          ? (readString((option as Record<string, unknown>).label) ??
            readString((option as Record<string, unknown>).value))
          : undefined;

    if (label?.trim()) labels.push(label.trim());
  }

  return labels;
}

function coerceId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "-");
}
