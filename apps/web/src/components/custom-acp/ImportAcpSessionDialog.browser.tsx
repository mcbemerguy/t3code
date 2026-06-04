import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type EnvironmentApi,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { notifyCustomAcpSessionsChanged } from "../../lib/customAcpSessionRefresh";
import { ImportAcpSessionDialog } from "./ImportAcpSessionDialog";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const CWD = "/workspace/project";
const PROVIDER_ID = ProviderInstanceId.make("custom-one");

function provider(input?: { readonly id?: string }): ServerProvider {
  const id = input?.id ?? PROVIDER_ID;
  return {
    instanceId: ProviderInstanceId.make(id),
    driver: ProviderDriverKind.make("customAcp"),
    displayName: id,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "unknown" },
    checkedAt: "2026-05-23T00:00:00.000Z",
    availability: "available",
    models: [{ slug: "acp-model", name: "ACP Model", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}

function api(input: {
  readonly listSessions: EnvironmentApi["customAcp"]["listSessions"];
  readonly importSession?: EnvironmentApi["customAcp"]["importSession"];
}): EnvironmentApi {
  return {
    customAcp: {
      listSessions: input.listSessions,
      importSession:
        input.importSession ??
        vi.fn(async () => ({ threadId: ThreadId.make("thread-imported"), sequence: 1 })),
    },
  } as unknown as EnvironmentApi;
}

async function renderDialog(input: {
  readonly environmentApi: EnvironmentApi;
  readonly providers?: ReadonlyArray<ServerProvider>;
  readonly onImported?: (threadId: ThreadId) => void;
}) {
  const screen = await render(
    <ImportAcpSessionDialog
      open
      onOpenChange={vi.fn()}
      api={input.environmentApi}
      environmentId={ENVIRONMENT_ID}
      projectId={PROJECT_ID}
      cwd={CWD}
      providers={input.providers ?? [provider()]}
      settings={DEFAULT_UNIFIED_SETTINGS}
      onImported={input.onImported ?? vi.fn()}
    />,
  );
  return {
    cleanup: () => screen.unmount(),
  };
}

describe("ImportAcpSessionDialog", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("passes the strict project cwd when listing sessions", async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [],
      nextCursor: null,
      providerInstanceId: PROVIDER_ID,
    }));
    const mounted = await renderDialog({ environmentApi: api({ listSessions }) });

    try {
      await vi.waitFor(() => {
        expect(listSessions).toHaveBeenCalledWith({ providerInstanceId: PROVIDER_ID, cwd: CWD });
      });
      await expect.element(page.getByText("No sessions found for this project.")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("loads every paginated session page", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        providerInstanceId: PROVIDER_ID,
        nextCursor: "cursor-2",
        sessions: [
          {
            sessionId: "session-1",
            cwd: CWD,
            title: "Recent work",
            updatedAt: "2026-05-23T01:02:03.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        providerInstanceId: PROVIDER_ID,
        nextCursor: null,
        sessions: [
          {
            sessionId: "session-2",
            cwd: CWD,
            title: "Older work",
            updatedAt: "2026-05-22T01:02:03.000Z",
          },
        ],
      });
    const mounted = await renderDialog({ environmentApi: api({ listSessions }) });

    try {
      await expect.element(page.getByRole("button", { name: /Recent work/ })).toBeVisible();
      await expect.element(page.getByRole("button", { name: /Older work/ })).toBeVisible();
      expect(listSessions).toHaveBeenNthCalledWith(1, {
        providerInstanceId: PROVIDER_ID,
        cwd: CWD,
      });
      expect(listSessions).toHaveBeenNthCalledWith(2, {
        providerInstanceId: PROVIDER_ID,
        cwd: CWD,
        cursor: "cursor-2",
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("refreshes the session list after a Custom ACP session deletion notification", async () => {
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        providerInstanceId: PROVIDER_ID,
        nextCursor: null,
        sessions: [
          {
            sessionId: "session-deleted",
            cwd: CWD,
            title: "Deleted work",
            updatedAt: "2026-05-23T01:02:03.000Z",
          },
        ],
      })
      .mockResolvedValueOnce({
        providerInstanceId: PROVIDER_ID,
        nextCursor: null,
        sessions: [],
      });
    const mounted = await renderDialog({ environmentApi: api({ listSessions }) });

    try {
      await expect.element(page.getByRole("button", { name: /Deleted work/ })).toBeVisible();
      notifyCustomAcpSessionsChanged(ENVIRONMENT_ID);
      await vi.waitFor(() => {
        expect(listSessions).toHaveBeenCalledTimes(2);
      });
      await expect.element(page.getByText("No sessions found for this project.")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders list state and imports then reports the returned thread", async () => {
    const importedThreadId = ThreadId.make("thread-imported");
    const importSession = vi.fn(async () => ({ threadId: importedThreadId, sequence: 7 }));
    const onImported = vi.fn();
    const mounted = await renderDialog({
      environmentApi: api({
        listSessions: vi.fn(async () => ({
          providerInstanceId: PROVIDER_ID,
          nextCursor: null,
          sessions: [
            {
              sessionId: "session-1",
              cwd: CWD,
              title: "Prior work",
              updatedAt: "2026-05-23T01:02:03.000Z",
            },
          ],
        })),
        importSession,
      }),
      onImported,
    });

    try {
      await expect.element(page.getByRole("button", { name: /Prior work/ })).toBeVisible();
      await page.getByRole("button", { name: /Prior work/ }).click();

      await vi.waitFor(() => {
        expect(importSession).toHaveBeenCalledWith(
          expect.objectContaining({
            providerInstanceId: PROVIDER_ID,
            projectId: PROJECT_ID,
            cwd: CWD,
            sessionId: "session-1",
          }),
        );
        expect(onImported).toHaveBeenCalledWith(importedThreadId);
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("keeps the session list visible when an import fails", async () => {
    const mounted = await renderDialog({
      environmentApi: api({
        listSessions: vi.fn(async () => ({
          providerInstanceId: PROVIDER_ID,
          nextCursor: null,
          sessions: [
            {
              sessionId: "session-1",
              cwd: CWD,
              title: "Prior work",
              updatedAt: "2026-05-23T01:02:03.000Z",
            },
          ],
        })),
        importSession: vi.fn(async () => Promise.reject(new Error("Import denied"))),
      }),
    });

    try {
      await expect.element(page.getByRole("button", { name: /Prior work/ })).toBeVisible();
      await page.getByRole("button", { name: /Prior work/ }).click();

      await expect.element(page.getByText("Unable to import ACP session")).toBeVisible();
      await expect.element(page.getByText("Import denied")).toBeVisible();
      await expect.element(page.getByRole("button", { name: /Prior work/ })).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("renders an error state", async () => {
    const mounted = await renderDialog({
      environmentApi: api({
        listSessions: vi.fn(async () => Promise.reject(new Error("No list"))),
      }),
    });

    try {
      await expect.element(page.getByText("Unable to load ACP sessions")).toBeVisible();
      await expect.element(page.getByText("No list")).toBeVisible();
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a provider picker when multiple Custom ACP providers are available", async () => {
    const listSessions = vi.fn(async () => ({
      sessions: [],
      nextCursor: null,
      providerInstanceId: ProviderInstanceId.make("custom-two"),
    }));
    const mounted = await renderDialog({
      environmentApi: api({ listSessions }),
      providers: [provider({ id: "custom-one" }), provider({ id: "custom-two" })],
    });

    try {
      await expect
        .element(page.getByText("Select a Custom ACP provider to list sessions."))
        .toBeVisible();
      const picker = document.querySelector<HTMLSelectElement>(
        "[data-testid='custom-acp-provider-picker']",
      );
      expect(picker).not.toBeNull();
      picker!.value = "custom-two";
      picker!.dispatchEvent(new Event("change", { bubbles: true }));

      await vi.waitFor(() => {
        expect(listSessions).toHaveBeenCalledWith({
          providerInstanceId: ProviderInstanceId.make("custom-two"),
          cwd: CWD,
        });
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
