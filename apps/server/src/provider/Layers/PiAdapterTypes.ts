import type {
  ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import type * as Deferred from "effect/Deferred";
import type * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

import type {
  PiRpcRuntimeMessage,
  PiSessionRuntimeShape,
  PiWorkflowRunCursor,
} from "./PiSessionRuntime.ts";
import type { PiToolLifecyclePresentation, PiToolSnapshot } from "./PiToolPresentation.ts";
import type { PiPendingUserInputRequest } from "./PiExtensionUi.ts";
import type { PiUsageState, PiUsageContextChange } from "./PiUsage.ts";
import type { PiWorkflowEventMapper } from "./PiWorkflowMapper.ts";

export interface PiToolState {
  readonly toolName: string;
  readonly itemId: RuntimeItemId;
  readonly updates: Array<unknown>;
  readonly presentation: PiToolLifecyclePresentation;
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
  readonly workflowTails: Map<string, PiWorkflowTailCursor>;
  readonly workflowMonitorDisposers: Set<() => void>;
  readonly workflowMonitorRunIds: Set<string>;
  workflowMapper?: PiWorkflowEventMapper;
  sessionFile?: string;
  stopped: boolean;
  currentTurnId?: TurnId;
  turnCompleted: boolean;
  assistantItemId?: RuntimeItemId;
  reasoningItemId?: RuntimeItemId;
  usageRefreshTimerFiber?: Fiber.Fiber<void, never>;
  usageRefreshInFlight: boolean;
  usageRefreshQueued: boolean;
  usageRefreshQueuedForce: boolean;
  usageRefreshPendingOptions?: PiUsageRefreshOptions;
  usageRefreshQueuedOptions?: PiUsageRefreshOptions;
  readonly usageRefreshWaiters: Set<Deferred.Deferred<void>>;
  usageRefreshSequence: number;
  latestForcedUsageRefreshSequence: number;
  forcedUsageRefreshInFlight: number;
  readonly usageState: PiUsageState;
}

export interface PiWorkflowTailCursor {
  readonly offset: number;
  readonly line: number;
}

export type PiRuntimeEventOffer = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
) => Effect.Effect<void>;

export interface PiUsageRefreshOptions {
  readonly contextChange?: PiUsageContextChange;
}

export type PiUsageRefreshScheduler = (
  session: PiAdapterSessionContext,
  options?: PiUsageRefreshOptions,
) => Effect.Effect<void>;

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
