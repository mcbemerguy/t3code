import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { checkPiProviderStatus } from "./PiProvider.ts";

it.layer(NodeServices.layer)("checkPiProviderStatus", (it) => {
  it.effect("marks an installed Pi CLI as limited until native sessions are wired", () =>
    Effect.gen(function* () {
      const provider = yield* checkPiProviderStatus({ enabled: true, binaryPath: "node" });

      expect(provider.installed).toBe(true);
      expect(provider.status).toBe("warning");
      expect(provider.models.map((model) => model.slug)).toEqual(["default"]);
      expect(provider.message).toContain("native Pi sessions are not wired yet");
    }),
  );
});
