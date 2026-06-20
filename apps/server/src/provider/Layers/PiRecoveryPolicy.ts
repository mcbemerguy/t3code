import { PiRpcLifecycleError, type PiSessionRuntimeError } from "./PiRpcProtocol.ts";

export type PiRecoveryOperationKind =
  | "read"
  | "prompt"
  | "active-input"
  | "model-selection"
  | "workflow-control"
  | "workflow-continuation"
  | "interrupt-control"
  | "compact";

export type PiDeliveryState = "pre-delivery" | "ambiguous" | "not-lifecycle";

export interface PiRecoveryDecision {
  readonly recover: boolean;
  readonly retry: boolean;
  readonly delivery: PiDeliveryState;
}

export function isPiClosedLifecycleError(error: unknown): error is PiRpcLifecycleError {
  return (
    error instanceof PiRpcLifecycleError &&
    /(process exited|stdin is not writable|process has not started|process.*closed|exited=true|closed=true)/i.test(
      error.message,
    )
  );
}

export function classifyPiDeliveryState(error: unknown, command: string): PiDeliveryState {
  if (!isPiClosedLifecycleError(error)) return "not-lifecycle";
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (
    new RegExp(
      `(process exited before ${escaped} could be sent|stdin is not writable before ${escaped} could be sent|process has not started; cannot send ${escaped})`,
      "i",
    ).test(error.message)
  ) {
    return "pre-delivery";
  }
  return "ambiguous";
}

function retryPolicyForDelivery(
  kind: PiRecoveryOperationKind,
  delivery: PiDeliveryState,
): Pick<PiRecoveryDecision, "recover" | "retry"> {
  if (delivery === "not-lifecycle") return { recover: false, retry: false };
  if (kind === "read") return { recover: true, retry: true };
  if (delivery === "pre-delivery") return { recover: true, retry: true };
  return { recover: true, retry: false };
}

export function decidePiRecovery(input: {
  readonly error: PiSessionRuntimeError | unknown;
  readonly command: string;
  readonly kind: PiRecoveryOperationKind;
}): PiRecoveryDecision {
  const delivery = classifyPiDeliveryState(input.error, input.command);
  return { delivery, ...retryPolicyForDelivery(input.kind, delivery) };
}
