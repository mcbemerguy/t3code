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
  PiResumeCursor,
  PiRpcRuntimeMessage,
  PiSessionRuntimeOptions,
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
  readonly turnId?: TurnId;
  readonly updates: Array<unknown>;
  readonly presentation: PiToolLifecyclePresentation;
  readonly snapshot?: PiToolSnapshot;
}

export interface PiAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly scope: Scope.Closeable;
  runtime: PiSessionRuntimeShape;
  runtimeOptions: PiSessionRuntimeOptions;
  runtimeRecovery?: PiRuntimeRecoveryState;
  eventFiber?: Fiber.Fiber<void, never>;
  readonly tools: Map<string, PiToolState>;
  readonly pendingUserInputs: Map<RuntimeRequestId, PiPendingUserInputRequest>;
  readonly workflowRuns: Map<string, PiWorkflowRunCursor>;
  readonly workflowTails: Map<string, PiWorkflowTailCursor>;
  readonly workflowRunTurnIds: Map<string, TurnId>;
  readonly workflowMonitorDisposers: Set<() => void>;
  readonly workflowMonitorRunIds: Set<string>;
  workflowMapper?: PiWorkflowEventMapper;
  sessionFile?: string;
  stopped: boolean;
  currentTurnId?: TurnId;
  latestTurnId?: TurnId;
  turnCompleted: boolean;
  readonly completedTurnIds: Set<TurnId>;
  readonly cancellingTurnIds: Set<TurnId>;
  activePromptEventId?: string;
  promptAccepted: boolean;
  quarantinePromptEventsUntilAcceptedDrain: boolean;
  requirePromptStartBeforeCompletion: boolean;
  nextTurnRequiresPromptStart: boolean;
  readonly completedPromptEventIds: Set<string>;
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

export interface PiRuntimeRecoveryState {
  readonly reason: string;
  readonly discardedAt: string;
  readonly resumeCursor?: PiResumeCursor;
  readonly missingResumeErrorEmitted?: boolean;
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
