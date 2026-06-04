import type * as EffectAcpSchema from "effect-acp/schema";

export const ACP_SESSION_DELETE_METHOD = "session/delete";

export interface AcpSessionLifecycleCapabilities {
  readonly close: boolean;
  readonly delete: boolean;
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

  return {
    close: hasAdvertisedCapability(sessionCapabilities, "close"),
    delete:
      hasAdvertisedCapability(sessionCapabilities, "delete") ||
      hasPiAcpDeleteCapability(agentCapabilities) ||
      hasPiAcpDeleteCapability(initializeResult),
  };
}

function hasPiAcpDeleteCapability(container: unknown): boolean {
  if (!isRecord(container)) return false;
  const meta = container._meta;
  if (!isRecord(meta)) return false;
  const piAcp = meta.piAcp;
  if (!isRecord(piAcp)) return false;
  return piAcp.sessionDelete === true || piAcp.deleteSession === true;
}

function hasAdvertisedCapability(capabilities: unknown, key: string): boolean {
  if (!isRecord(capabilities)) return false;
  const value = capabilities[key];
  return value !== undefined && value !== null && value !== false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
