import { TextGenerationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { TextGenerationShape } from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Native Pi text generation is intentionally unsupported; use a chat-capable provider for Git/title generation until Pi RPC text-generation helpers are implemented.",
    }),
  );

export const makeUnsupportedPiTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: () => unsupported("generateCommitMessage"),
  generatePrContent: () => unsupported("generatePrContent"),
  generateBranchName: () => unsupported("generateBranchName"),
  generateThreadTitle: () => unsupported("generateThreadTitle"),
});
