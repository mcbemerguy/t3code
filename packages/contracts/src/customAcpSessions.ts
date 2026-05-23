import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const CustomAcpSessionListInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  cursor: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type CustomAcpSessionListInput = typeof CustomAcpSessionListInput.Type;

export const CustomAcpExternalSession = Schema.Struct({
  sessionId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  title: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type CustomAcpExternalSession = typeof CustomAcpExternalSession.Type;

export const CustomAcpSessionListResult = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  sessions: Schema.Array(CustomAcpExternalSession),
  nextCursor: Schema.NullOr(TrimmedNonEmptyString),
});
export type CustomAcpSessionListResult = typeof CustomAcpSessionListResult.Type;

export const CustomAcpSessionImportInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  projectId: ProjectId,
  cwd: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  title: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  updatedAt: Schema.optional(Schema.NullOr(IsoDateTime)),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type CustomAcpSessionImportInput = typeof CustomAcpSessionImportInput.Type;

export const CustomAcpSessionImportResult = Schema.Struct({
  threadId: ThreadId,
  sequence: Schema.Number,
});
export type CustomAcpSessionImportResult = typeof CustomAcpSessionImportResult.Type;

export class CustomAcpSessionImportError extends Schema.TaggedErrorClass<CustomAcpSessionImportError>()(
  "CustomAcpSessionImportError",
  {
    operation: Schema.Literals(["list", "import"]),
    providerInstanceId: Schema.optional(ProviderInstanceId),
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
