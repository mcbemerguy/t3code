import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const unsupported = (method: string) =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail:
        "Native Pi sessions are not wired yet. Phase 1 only registers the provider surface and status snapshot.",
    }),
  );

export const makePiAdapter = (): Effect.Effect<ProviderAdapterShape<ProviderAdapterRequestError>> =>
  Effect.succeed({
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "unsupported" },
    startSession: () => unsupported("startSession"),
    sendTurn: () => unsupported("sendTurn"),
    interruptTurn: () => unsupported("interruptTurn"),
    respondToRequest: () => unsupported("respondToRequest"),
    respondToUserInput: () => unsupported("respondToUserInput"),
    stopSession: () => Effect.void,
    listSessions: () => Effect.succeed([]),
    hasSession: () => Effect.succeed(false),
    readThread: () => unsupported("readThread"),
    rollbackThread: () => unsupported("rollbackThread"),
    stopAll: () => Effect.void,
    streamEvents: Stream.empty,
  });
