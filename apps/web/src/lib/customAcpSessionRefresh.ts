import type { EnvironmentId } from "@t3tools/contracts";

const CUSTOM_ACP_SESSIONS_CHANGED_EVENT = "t3code:custom-acp-sessions-changed";

type CustomAcpSessionsChangedDetail = {
  readonly environmentId: EnvironmentId;
};

export function notifyCustomAcpSessionsChanged(environmentId: EnvironmentId): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<CustomAcpSessionsChangedDetail>(CUSTOM_ACP_SESSIONS_CHANGED_EVENT, {
      detail: { environmentId },
    }),
  );
}

export function subscribeCustomAcpSessionsChanged(
  environmentId: EnvironmentId,
  listener: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<CustomAcpSessionsChangedDetail>).detail;
    if (detail?.environmentId === environmentId) {
      listener();
    }
  };
  window.addEventListener(CUSTOM_ACP_SESSIONS_CHANGED_EVENT, handler);
  return () => window.removeEventListener(CUSTOM_ACP_SESSIONS_CHANGED_EVENT, handler);
}
