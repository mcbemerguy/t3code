import type * as EffectAcpSchema from "effect-acp/schema";

export const ACP_SESSION_DELETE_METHOD = "_pi/session/delete";
const LEGACY_UNSTABLE_SESSION_DELETE_METHOD = "session/delete";

export interface AcpSessionLifecycleCapabilities {
  readonly close: boolean;
  readonly delete: boolean;
  readonly deleteMethod: string | undefined;
}

export interface DeleteSessionRequest {
  readonly sessionId: string;
}

export type DeleteSessionResponse = { readonly _meta?: { readonly [key: string]: unknown } | null };

export function extractAcpSessionLifecycleCapabilities(
  initializeResult: EffectAcpSchema.InitializeResponse,
): AcpSessionLifecycleCapabilities {
  const agentCapabilities = initializeResult.agentCapabilities as unknown;
  const sessionCapabilities = isRecord(agentCapabilities)
    ? agentCapabilities.sessionCapabilities
    : undefined;
  const deleteMethod =
    piAcpDeleteMethod(agentCapabilities) ??
    piAcpDeleteMethod(initializeResult) ??
    (hasAdvertisedCapability(sessionCapabilities, "delete")
      ? LEGACY_UNSTABLE_SESSION_DELETE_METHOD
      : undefined);

  return {
    close: hasAdvertisedCapability(sessionCapabilities, "close"),
    delete: deleteMethod !== undefined,
    deleteMethod,
  };
}

function piAcpDeleteMethod(container: unknown): string | undefined {
  if (!isRecord(container)) return undefined;
  const meta = container._meta;
  if (!isRecord(meta)) return undefined;
  const piAcp = meta.piAcp;
  if (!isRecord(piAcp)) return undefined;
  if (piAcp.sessionDelete !== true && piAcp.deleteSession !== true) return undefined;
  return (
    stringMethod(piAcp.sessionDeleteMethod) ??
    stringMethod(piAcp.deleteSessionMethod) ??
    ACP_SESSION_DELETE_METHOD
  );
}

function stringMethod(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const method = value.trim();
  return method.startsWith("_") ? method : undefined;
}

function hasAdvertisedCapability(capabilities: unknown, key: string): boolean {
  if (!isRecord(capabilities)) return false;
  const value = capabilities[key];
  return value !== undefined && value !== null && value !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
