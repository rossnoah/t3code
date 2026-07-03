import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  ContextMenuItem,
  EnvironmentId,
  ProjectId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Plus, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";

import { type DraftId } from "~/composerDraftStore";
import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { useThreadActions } from "~/hooks/useThreadActions";
import { cn } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import type { SidebarThreadSummary } from "~/types";
import { useUiStateStore } from "~/uiStateStore";
import { workspaceThreads } from "~/worktreeGrouping";
import { resolveThreadStatusPill } from "./Sidebar.logic";
import { ScrollArea } from "./ui/scroll-area";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type TabContextMenuAction = "archive";

interface WorktreeThreadTabsProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  worktreePath: string | null;
  branch: string | null;
  activeThreadId: ThreadId;
  routeKind: "server" | "draft";
  draftId?: DraftId | undefined;
}

function ThreadTab(props: {
  thread: SidebarThreadSummary;
  active: boolean;
  onActivate: (threadRef: ScopedThreadRef) => void;
  onArchive: (threadRef: ScopedThreadRef) => void;
}) {
  const { thread, active, onActivate, onArchive } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const lastVisitedAt = useUiStateStore(
    useShallow((state) => state.threadLastVisitedAtById[threadKey] ?? null),
  );
  const status = resolveThreadStatusPill({
    thread: {
      ...thread,
      ...(lastVisitedAt !== null ? { lastVisitedAt } : {}),
    },
  });
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const items: ContextMenuItem<TabContextMenuAction>[] = [
          { id: "archive", label: "Archive" },
        ];
        const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
        if (action === "archive") {
          onArchive(threadRef);
        }
      })();
    },
    [onArchive, threadRef],
  );
  const handleAuxClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onArchive(threadRef);
    },
    [onArchive, threadRef],
  );
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 1) return;
    // Prevent middle-click autoscroll so aux-click archives instead.
    event.preventDefault();
  }, []);

  return (
    <div
      data-active-tab={active}
      data-testid="worktree-thread-tab"
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "group flex h-7 min-w-24 max-w-48 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs",
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-1.5"
              onClick={() => onActivate(threadRef)}
            >
              {status ? (
                <span
                  aria-label={status.label}
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    status.dotClass,
                    status.pulse && "animate-pulse",
                  )}
                />
              ) : null}
              <span className="truncate">{thread.title}</span>
            </button>
          }
        />
        <TooltipPopup side="bottom">
          {status ? `${thread.title} — ${status.label}` : thread.title}
        </TooltipPopup>
      </Tooltip>
      <button
        type="button"
        className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
        aria-label={`Archive ${thread.title}`}
        onClick={(event) => {
          event.stopPropagation();
          onArchive(threadRef);
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/**
 * Chrome-like horizontal tab strip: one tab per thread of the active
 * workspace (same repository working tree). The active draft appears as a
 * provisional "New thread" tab; "+" starts another thread in this workspace.
 */
export const WorktreeThreadTabs = memo(function WorktreeThreadTabs({
  environmentId,
  projectId,
  worktreePath,
  branch,
  activeThreadId,
  routeKind,
  draftId,
}: WorktreeThreadTabsProps) {
  const navigate = useNavigate();
  const threadShells = useThreadShells();
  const handleNewThread = useNewThreadHandler();
  const { archiveThread } = useThreadActions();
  const tabListRef = useRef<HTMLDivElement>(null);

  const tabs = useMemo(
    () =>
      workspaceThreads(threadShells, {
        environmentId,
        projectId,
        worktreePath,
      }),
    [environmentId, projectId, threadShells, worktreePath],
  );
  const showDraftTab =
    routeKind === "draft" && !tabs.some((thread) => thread.id === activeThreadId);

  const activateThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  const activateDraft = useCallback(() => {
    if (!draftId) return;
    void navigate({ to: "/draft/$draftId", params: { draftId } });
  }, [draftId, navigate]);

  const handleArchive = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await archiveThread(threadRef);
        if (result._tag === "Failure") {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Unable to archive thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [archiveThread],
  );

  const startNewThread = useCallback(() => {
    void handleNewThread(scopeProjectRef(environmentId, projectId), {
      branch,
      worktreePath,
      envMode: worktreePath !== null ? "worktree" : "local",
    });
  }, [branch, environmentId, handleNewThread, projectId, worktreePath]);

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeThreadId]);

  return (
    <div
      data-worktree-thread-tabs
      className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2"
    >
      <ScrollArea
        ref={tabListRef}
        hideScrollbars
        scrollFade
        className="min-w-0 flex-1 rounded-none"
      >
        <div className="flex h-full w-max min-w-full items-center gap-1">
          {tabs.map((thread) => (
            <ThreadTab
              key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
              thread={thread}
              active={routeKind === "server" && thread.id === activeThreadId}
              onActivate={activateThread}
              onArchive={handleArchive}
            />
          ))}
          {showDraftTab ? (
            <div
              data-active-tab
              className="flex h-7 min-w-24 max-w-48 shrink-0 items-center gap-1.5 rounded-md bg-accent px-2 text-xs text-foreground"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onClick={activateDraft}
              >
                <span className="truncate italic">New thread</span>
              </button>
            </div>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="New thread in this workspace"
                  data-testid="worktree-new-thread-tab"
                  className="relative inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={startNewThread}
                />
              }
            >
              <Plus className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">New thread in this workspace</TooltipPopup>
          </Tooltip>
        </div>
      </ScrollArea>
    </div>
  );
});
