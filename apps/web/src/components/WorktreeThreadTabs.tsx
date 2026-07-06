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

import {
  type DraftId,
  type ProjectDraftSession,
  useWorkspaceDraftSessions,
} from "~/composerDraftStore";
import { useCloseDraftTab } from "~/hooks/useCloseDraftTab";
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
type DraftTabContextMenuAction = "close";

/**
 * Every tab shares one fixed footprint (uniform chrome-like strip). The
 * thread-title prompt (`buildThreadTitlePrompt`) targets this width — at
 * text-xs roughly 18 characters fit next to the close button.
 */
const TAB_CLASS = "relative flex h-7 w-36 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs";

/**
 * Status indicator drawn as an underline along the tab's bottom edge —
 * out of the text flow, so the title never shifts when a thread starts
 * or stops working.
 */
function TabStatusUnderline(props: {
  status: { label: string; dotClass: string; pulse: boolean } | null;
}) {
  const { status } = props;
  if (!status) return null;
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-2 bottom-0.5 h-0.5 rounded-full transition-colors duration-300",
        status.dotClass,
        status.pulse && "animate-pulse",
      )}
    />
  );
}

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
  // Activate on mousedown like real browser tabs: focusing a partially
  // clipped tab scrolls it under the cursor, which would otherwise swallow
  // the click and force a second one. Keyboard activation still fires the
  // button's click handler.
  const handleActivateMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      onActivate(threadRef);
    },
    [onActivate, threadRef],
  );

  return (
    <div
      data-active-tab={active}
      data-testid="worktree-thread-tab"
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "group",
        TAB_CLASS,
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
              onMouseDown={handleActivateMouseDown}
              onClick={() => onActivate(threadRef)}
            >
              <span className="truncate">{thread.title}</span>
              {status ? <span className="sr-only">{status.label}</span> : null}
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
      <TabStatusUnderline status={status} />
    </div>
  );
}

function DraftTab(props: {
  session: ProjectDraftSession;
  active: boolean;
  onActivate: (draftId: DraftId) => void;
  onClose: (session: ProjectDraftSession) => void;
}) {
  const { session, active, onActivate, onClose } = props;
  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      void (async () => {
        const items: ContextMenuItem<DraftTabContextMenuAction>[] = [
          { id: "close", label: "Close" },
        ];
        const action = await api.contextMenu.show(items, { x: event.clientX, y: event.clientY });
        if (action === "close") {
          onClose(session);
        }
      })();
    },
    [onClose, session],
  );
  const handleAuxClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 1) return;
      event.preventDefault();
      event.stopPropagation();
      onClose(session);
    },
    [onClose, session],
  );
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 1) return;
    // Prevent middle-click autoscroll so aux-click closes instead.
    event.preventDefault();
  }, []);
  // Mousedown activation, mirroring ThreadTab (see comment there).
  const handleActivateMouseDown = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      onActivate(session.draftId);
    },
    [onActivate, session.draftId],
  );

  return (
    <div
      data-active-tab={active}
      data-testid="worktree-draft-tab"
      onMouseDown={handleMouseDown}
      onAuxClick={handleAuxClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "group",
        TAB_CLASS,
        active
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1.5"
        onMouseDown={handleActivateMouseDown}
        onClick={() => onActivate(session.draftId)}
      >
        <span className="truncate italic">New thread</span>
      </button>
      <button
        type="button"
        className="flex size-4 shrink-0 items-center justify-center rounded opacity-0 hover:bg-muted focus:opacity-100 group-hover:opacity-100"
        aria-label="Close new thread"
        onClick={(event) => {
          event.stopPropagation();
          onClose(session);
        }}
      >
        <X className="size-3" />
      </button>
    </div>
  );
}

/**
 * Chrome-like horizontal tab strip: one tab per thread of the active
 * workspace (same repository working tree), then one provisional "New
 * thread" tab per open draft of the workspace; "+" opens another draft.
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
  const closeDraftTab = useCloseDraftTab();
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
  const draftSessions = useWorkspaceDraftSessions({ environmentId, projectId, worktreePath });
  // The active draft can be missing from the workspace list mid-promotion;
  // keep a provisional tab for it so the strip never loses the active tab.
  const showFallbackDraftTab =
    routeKind === "draft" &&
    !tabs.some((thread) => thread.id === activeThreadId) &&
    !draftSessions.some((session) => session.draftId === draftId);

  const activateThread = useCallback(
    (threadRef: ScopedThreadRef) => {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });
    },
    [navigate],
  );

  const activateDraft = useCallback(
    (targetDraftId: DraftId) => {
      void navigate({ to: "/draft/$draftId", params: { draftId: targetDraftId } });
    },
    [navigate],
  );

  const closeDraft = useCallback(
    (session: ProjectDraftSession) => {
      void closeDraftTab(session.draftId);
    },
    [closeDraftTab],
  );

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
      forceNew: true,
    });
  }, [branch, environmentId, handleNewThread, projectId, worktreePath]);

  useEffect(() => {
    const activeTab = tabListRef.current?.querySelector<HTMLElement>("[data-active-tab='true']");
    activeTab?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeThreadId, draftId]);

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
          {draftSessions.map((session) => (
            <DraftTab
              key={session.draftId}
              session={session}
              active={routeKind === "draft" && session.draftId === draftId}
              onActivate={activateDraft}
              onClose={closeDraft}
            />
          ))}
          {showFallbackDraftTab ? (
            <div data-active-tab className={cn(TAB_CLASS, "bg-accent text-foreground")}>
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-1.5"
                onClick={() => draftId && activateDraft(draftId)}
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
