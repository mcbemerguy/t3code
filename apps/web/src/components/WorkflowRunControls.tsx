import { useMemo, useState } from "react";
import type { ProviderWorkflowControlAction, ProviderWorkflowRunCursor } from "@t3tools/contracts";
import { EllipsisIcon, LoaderIcon, PlayIcon, SquareIcon } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "./ui/menu";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { cn } from "~/lib/utils";

interface WorkflowRunControlsProps {
  workflowRuns: ReadonlyArray<ProviderWorkflowRunCursor>;
  isWorking: boolean;
  onStopRunningWorkflow: () => Promise<void>;
  onControlWorkflowRun: (runId: string, action: ProviderWorkflowControlAction) => Promise<void>;
}

function workflowStatusLabel(status: ProviderWorkflowRunCursor["status"]): string {
  switch (status) {
    case "interrupted":
      return "Interrupted";
    case "recovering":
      return "Recovering";
    case "paused":
      return "Paused";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "aborted":
      return "Aborted";
    case "running":
    default:
      return "Running";
  }
}

function shortRef(value: string): string {
  if (value.length <= 28) return value;
  return `${value.slice(0, 10)}…${value.slice(-14)}`;
}

function pathLeaf(value: string): string {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function continueActionForRun(
  run: ProviderWorkflowRunCursor,
): ProviderWorkflowControlAction | null {
  if (run.actions.includes("continue")) return "continue";
  if (run.actions.includes("resume")) return "resume";
  return null;
}

function WorkflowRunControls({
  workflowRuns,
  isWorking,
  onStopRunningWorkflow,
  onControlWorkflowRun,
}: WorkflowRunControlsProps) {
  const activeRuns = useMemo(() => workflowRuns.filter((run) => !run.terminal), [workflowRuns]);
  const [pendingControl, setPendingControl] = useState<string | null>(null);
  const [abortRun, setAbortRun] = useState<ProviderWorkflowRunCursor | null>(null);

  if (activeRuns.length === 0) return null;

  const runControl = async (
    run: ProviderWorkflowRunCursor,
    action: ProviderWorkflowControlAction,
  ) => {
    const key = `${run.runId}:${action}`;
    setPendingControl(key);
    try {
      await onControlWorkflowRun(run.runId, action);
    } finally {
      setPendingControl((current) => (current === key ? null : current));
    }
  };

  const stopRun = async (run: ProviderWorkflowRunCursor) => {
    const key = `${run.runId}:stop`;
    setPendingControl(key);
    try {
      await onStopRunningWorkflow();
    } finally {
      setPendingControl((current) => (current === key ? null : current));
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold tracking-widest text-muted-foreground/40 uppercase">
          Pi workflows
        </p>
        {activeRuns.length > 1 ? (
          <span className="text-[10px] text-muted-foreground/50">Choose a run</span>
        ) : null}
      </div>
      <div className="space-y-2">
        {activeRuns.map((run) => {
          const continueAction = continueActionForRun(run);
          const canAbort = run.actions.includes("abort");
          const canStop = run.status === "running" && isWorking;
          const runPending = pendingControl?.startsWith(`${run.runId}:`) ?? false;
          const stopPending = pendingControl === `${run.runId}:stop`;
          const continuePending = continueAction
            ? pendingControl === `${run.runId}:${continueAction}`
            : false;
          return (
            <div
              key={run.runId}
              className="rounded-lg border border-border/60 bg-background/45 p-2.5"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge
                      variant="secondary"
                      className={cn(
                        "rounded-md px-1.5 py-0 text-[10px] font-semibold",
                        run.status === "running" && "bg-blue-500/10 text-blue-400",
                        (run.status === "interrupted" || run.status === "paused") &&
                          "bg-amber-500/10 text-amber-400",
                        run.status === "recovering" && "bg-violet-500/10 text-violet-400",
                      )}
                    >
                      {workflowStatusLabel(run.status)}
                    </Badge>
                    {run.workflowId ? (
                      <span className="truncate text-[11px] text-muted-foreground/70">
                        {run.workflowId}
                      </span>
                    ) : null}
                  </div>
                  <div className="space-y-0.5 text-[11px] leading-relaxed text-muted-foreground/60">
                    <p title={run.runId}>
                      Run{" "}
                      <span className="font-mono text-muted-foreground/80">
                        {shortRef(run.runId)}
                      </span>
                    </p>
                    {run.auditPath ? (
                      <p title={run.auditPath}>
                        Audit{" "}
                        <span className="font-mono text-muted-foreground/80">
                          {pathLeaf(run.auditPath)}
                        </span>
                      </p>
                    ) : null}
                    {run.runDir ? (
                      <p title={run.runDir}>
                        Artifacts{" "}
                        <span className="font-mono text-muted-foreground/80">
                          {pathLeaf(run.runDir)}
                        </span>
                      </p>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {continueAction ? (
                    <Button
                      size="xs"
                      variant="secondary"
                      disabled={runPending}
                      onClick={() => void runControl(run, continueAction)}
                    >
                      {continuePending ? (
                        <LoaderIcon className="size-3 animate-spin" />
                      ) : (
                        <PlayIcon className="size-3" />
                      )}
                      {continueAction === "resume" ? "Resume" : "Continue"}
                    </Button>
                  ) : null}
                  {canStop ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={runPending}
                      onClick={() => void stopRun(run)}
                    >
                      {stopPending ? (
                        <LoaderIcon className="size-3 animate-spin" />
                      ) : (
                        <SquareIcon className="size-3" />
                      )}
                      Stop
                    </Button>
                  ) : null}
                  {canAbort ? (
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            disabled={runPending}
                            aria-label={`Workflow actions for ${run.runId}`}
                          />
                        }
                      >
                        <EllipsisIcon className="size-3.5" />
                      </MenuTrigger>
                      <MenuPopup align="end">
                        <MenuItem variant="destructive" onClick={() => setAbortRun(run)}>
                          Abort workflow
                        </MenuItem>
                      </MenuPopup>
                    </Menu>
                  ) : null}
                </div>
              </div>
              {run.status === "running" ? (
                <p className="mt-2 text-[11px] text-muted-foreground/50">
                  Stop interrupts the current turn and leaves this workflow recoverable. Abort is
                  terminal.
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
      <AlertDialog open={abortRun !== null} onOpenChange={(open) => !open && setAbortRun(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Abort workflow run?</AlertDialogTitle>
            <AlertDialogDescription>
              This terminal action marks the run aborted but keeps its audit and artifact files.
              {abortRun ? ` Run: ${abortRun.runId}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!abortRun || pendingControl === `${abortRun.runId}:abort`}
              onClick={() => {
                const run = abortRun;
                if (!run) return;
                setAbortRun(null);
                void runControl(run, "abort");
              }}
            >
              Abort workflow
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

export { WorkflowRunControls };
export type { WorkflowRunControlsProps };
