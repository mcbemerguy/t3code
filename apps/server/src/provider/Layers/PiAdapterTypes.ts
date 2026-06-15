import type {
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

import type {
  PiRpcRuntimeMessage,
  PiSessionRuntimeShape,
  PiWorkflowRunCursor,
} from "./PiSessionRuntime.ts";
import type { PiToolSnapshot } from "./PiToolPresentation.ts";
import type { PiPendingUserInputRequest } from "./PiExtensionUi.ts";
import type { PiWorkflowEventMapper } from "./PiWorkflowMapper.ts";

export interface PiToolState {
  readonly toolName: string;
  readonly itemId: RuntimeItemId;
  readonly updates: Array<unknown>;
  readonly snapshot?: PiToolSnapshot;
}

export interface PiAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  readonly runtime: PiSessionRuntimeShape;
  eventFiber?: Fiber.Fiber<void, never>;
  readonly tools: Map<string, PiToolState>;
  readonly pendingUserInputs: Map<RuntimeRequestId, PiPendingUserInputRequest>;
  readonly workflowRuns: Map<string, PiWorkflowRunCursor>;
  readonly workflowMonitorDisposers: Set<() => void>;
  readonly workflowMonitorRunIds: Set<string>;
  workflowMapper?: PiWorkflowEventMapper;
  sessionFile?: string;
  stopped: boolean;
  currentTurnId?: TurnId;
  turnCompleted: boolean;
  assistantItemId?: RuntimeItemId;
  reasoningItemId?: RuntimeItemId;
  usageRefreshFiber?: Fiber.Fiber<void, never>;
  usageRefreshQueued: boolean;
  lastUsageKey?: string;
}

export type PiRuntimeEventOffer = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
) => Effect.Effect<void>;

export type PiUsageRefreshScheduler = (session: PiAdapterSessionContext) => Effect.Effect<void>;

export interface PiTurnCompletionDetail {
  readonly errorMessage?: string;
  readonly stopReason?: string;
}

export type PiTurnCompleter = (
  session: PiAdapterSessionContext,
  raw?: PiRpcRuntimeMessage,
  state?: "completed" | "failed" | "cancelled" | "interrupted",
  detail?: PiTurnCompletionDetail,
) => Effect.Effect<void>;
