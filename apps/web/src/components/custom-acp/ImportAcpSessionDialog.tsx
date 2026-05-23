import {
  DEFAULT_RUNTIME_MODE,
  type CustomAcpExternalSession,
  type EnvironmentApi,
  type ProjectId,
  ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { Loader2Icon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  formatCustomAcpImportError,
  resolveCustomAcpImportModelSelection,
  resolveCustomAcpProviderForImport,
} from "../../lib/customAcpSessionImport";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export interface ImportAcpSessionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly api: EnvironmentApi | null;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly preferredProviderInstanceId?: ProviderInstanceId | null;
  readonly onImported: (threadId: ThreadId) => void;
}

type LoadState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "loaded"; readonly sessions: ReadonlyArray<CustomAcpExternalSession> };

function sessionTitle(session: CustomAcpExternalSession): string {
  return session.title?.trim() || "Untitled ACP session";
}

function formatUpdatedAt(value: string | null): string {
  if (!value) return "Updated time unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export function ImportAcpSessionDialog(props: ImportAcpSessionDialogProps) {
  const providerResolution = useMemo(
    () =>
      resolveCustomAcpProviderForImport({
        providers: props.providers,
        preferredProviderInstanceId: props.preferredProviderInstanceId,
      }),
    [props.preferredProviderInstanceId, props.providers],
  );
  const [selectedProviderId, setSelectedProviderId] = useState<ProviderInstanceId | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "idle" });
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);

  useEffect(() => {
    if (!props.open) {
      setLoadState({ kind: "idle" });
      setImportingSessionId(null);
      return;
    }
    if (providerResolution.kind === "selected") {
      setSelectedProviderId(providerResolution.provider.instanceId);
      return;
    }
    setSelectedProviderId(null);
  }, [props.open, providerResolution]);

  useEffect(() => {
    if (!props.open || !props.api || !selectedProviderId) {
      return;
    }

    let cancelled = false;
    setLoadState({ kind: "loading" });
    void props.api.customAcp
      .listSessions({ providerInstanceId: selectedProviderId, cwd: props.cwd })
      .then((result) => {
        if (!cancelled) {
          setLoadState({ kind: "loaded", sessions: result.sessions });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setLoadState({ kind: "error", message: formatCustomAcpImportError(error) });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [props.api, props.cwd, props.open, selectedProviderId]);

  const selectedProvider = useMemo(() => {
    if (!selectedProviderId) return null;
    if (providerResolution.kind === "selected") return providerResolution.provider;
    if (providerResolution.kind === "picker") {
      return (
        providerResolution.providers.find((entry) => entry.instanceId === selectedProviderId) ??
        null
      );
    }
    return null;
  }, [providerResolution, selectedProviderId]);

  const importSession = async (session: CustomAcpExternalSession) => {
    if (!props.api || !selectedProvider) return;
    setImportingSessionId(session.sessionId);
    try {
      const result = await props.api.customAcp.importSession({
        providerInstanceId: selectedProvider.instanceId,
        projectId: props.projectId,
        cwd: props.cwd,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        modelSelection: resolveCustomAcpImportModelSelection({
          providerInstanceId: selectedProvider.instanceId,
          providers: props.providers,
          settings: props.settings,
        }),
      });
      props.onOpenChange(false);
      props.onImported(result.threadId);
    } catch (error) {
      setLoadState({ kind: "error", message: formatCustomAcpImportError(error) });
    } finally {
      setImportingSessionId(null);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import ACP session</DialogTitle>
          <DialogDescription>
            Resume an external ACP session for this project. Previous transcript is not copied;
            future turns continue the selected agent session.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">Workspace</div>
            <div className="mt-1 break-all" data-testid="custom-acp-import-cwd">
              {props.cwd}
            </div>
          </div>

          {props.api === null ? (
            <div role="alert" className="rounded-md border border-destructive/30 p-4 text-sm">
              This project environment is not connected.
            </div>
          ) : null}

          {providerResolution.kind === "none" ? (
            <div role="status" className="rounded-md border border-destructive/30 p-4 text-sm">
              No enabled Custom ACP provider is available.
            </div>
          ) : null}

          {providerResolution.kind === "picker" ? (
            <label className="block space-y-2 text-sm">
              <span className="font-medium">Custom ACP provider</span>
              <select
                data-testid="custom-acp-provider-picker"
                className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                value={selectedProviderId ?? ""}
                onChange={(event) =>
                  setSelectedProviderId(ProviderInstanceId.make(event.currentTarget.value))
                }
              >
                <option value="" disabled>
                  Select a provider…
                </option>
                {providerResolution.providers.map((provider) => (
                  <option key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          {loadState.kind === "idle" && providerResolution.kind === "picker" ? (
            <div role="status" className="rounded-md border p-4 text-sm text-muted-foreground">
              Select a Custom ACP provider to list sessions.
            </div>
          ) : null}

          {loadState.kind === "loading" ? (
            <div role="status" className="flex items-center gap-2 rounded-md border p-4 text-sm">
              <Loader2Icon className="size-4 animate-spin" /> Loading ACP sessions…
            </div>
          ) : null}

          {loadState.kind === "error" ? (
            <div role="alert" className="rounded-md border border-destructive/30 p-4 text-sm">
              <div className="font-medium text-destructive">Unable to load ACP sessions</div>
              <div className="mt-1 text-muted-foreground">{loadState.message}</div>
            </div>
          ) : null}

          {loadState.kind === "loaded" && loadState.sessions.length === 0 ? (
            <div role="status" className="rounded-md border p-4 text-sm text-muted-foreground">
              No sessions found for this project.
            </div>
          ) : null}

          {loadState.kind === "loaded" && loadState.sessions.length > 0 ? (
            <div className="space-y-2" data-testid="custom-acp-session-list">
              {loadState.sessions.map((session) => (
                <button
                  key={session.sessionId}
                  type="button"
                  className="w-full rounded-md border p-3 text-left hover:bg-accent disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={importingSessionId !== null}
                  onClick={() => void importSession(session)}
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-sm font-medium">
                      {sessionTitle(session)}
                    </div>
                    {importingSessionId === session.sessionId ? (
                      <Loader2Icon className="size-4 shrink-0 animate-spin" />
                    ) : null}
                  </div>
                  <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                    <div>{formatUpdatedAt(session.updatedAt)}</div>
                    <div className="break-all">{session.cwd}</div>
                    <div className="break-all">{session.sessionId}</div>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="secondary" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
