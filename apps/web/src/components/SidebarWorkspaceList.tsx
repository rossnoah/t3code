import {
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { GitBranchIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { cn } from "~/lib/utils";
import type { DraftId } from "~/composerDraftStore";
import type { SidebarThreadSummary } from "~/types";
import { useUiStateStore } from "~/uiStateStore";
import {
  buildSidebarWorkspaceGroups,
  UNNAMED_WORKSPACE_LABEL,
  type WorkspaceDraftInput,
  workspaceGroupRepresentative,
  type SidebarWorkspaceGroup,
  type WorkspaceGroup,
} from "~/worktreeGrouping";
import { resolveProjectStatusIndicator, resolveThreadStatusPill } from "./Sidebar.logic";
import { SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const SIDEBAR_ICON_ACTION_BUTTON_CLASS =
  "inline-flex h-6 min-w-6 cursor-pointer items-center justify-center rounded-md px-[calc(--spacing(1)-1px)] text-muted-foreground/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring";

export interface SidebarWorkspaceListProps {
  projectThreads: readonly SidebarThreadSummary[];
  projectRefs: readonly { environmentId: EnvironmentId; projectId: ProjectId }[];
  draftSessions: readonly WorkspaceDraftInput[];
  projectExpanded: boolean;
  activeRouteThreadKey: string | null;
  activeDraftId: DraftId | null;
  newThreadShortcutLabel: string | null;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  navigateToDraft: (draftId: DraftId) => void;
  onNewThreadInWorkspace: (group: WorkspaceGroup<SidebarThreadSummary>) => void;
  attachWorkspaceListAutoAnimateRef: (node: HTMLElement | null) => void;
}

const SidebarWorkspaceRow = memo(function SidebarWorkspaceRow(props: {
  group: SidebarWorkspaceGroup<SidebarThreadSummary>;
  isActive: boolean;
  newThreadShortcutLabel: string | null;
  navigateToThread: (threadRef: ScopedThreadRef) => void;
  navigateToDraft: (draftId: DraftId) => void;
  onNewThreadInWorkspace: (group: WorkspaceGroup<SidebarThreadSummary>) => void;
}) {
  const {
    group,
    isActive,
    newThreadShortcutLabel,
    navigateToThread,
    navigateToDraft,
    onNewThreadInWorkspace,
  } = props;
  const threadKeys = useMemo(
    () =>
      group.threads.map((thread) =>
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      ),
    [group.threads],
  );
  const lastVisitedAts = useUiStateStore(
    useShallow((state) => threadKeys.map((key) => state.threadLastVisitedAtById[key] ?? null)),
  );
  const status = useMemo(() => {
    const lastVisitedByKey = new Map(
      threadKeys.map((key, index) => [key, lastVisitedAts[index] ?? null]),
    );
    return resolveProjectStatusIndicator(
      group.threads.map((thread) => {
        const lastVisitedAt = lastVisitedByKey.get(
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
        );
        return resolveThreadStatusPill({
          thread: {
            ...thread,
            ...(lastVisitedAt !== null && lastVisitedAt !== undefined ? { lastVisitedAt } : {}),
          },
        });
      }),
    );
  }, [group.threads, lastVisitedAts, threadKeys]);

  const handleClick = useCallback(() => {
    const representative = workspaceGroupRepresentative(group);
    if (representative) {
      navigateToThread(scopeThreadRef(representative.environmentId, representative.id));
      return;
    }
    const firstDraftId = group.draftIds[0];
    if (firstDraftId) {
      navigateToDraft(firstDraftId as DraftId);
      return;
    }
    // Empty workspace (e.g. an untouched repo root): open a fresh draft in it.
    onNewThreadInWorkspace(group);
  }, [group, navigateToDraft, navigateToThread, onNewThreadInWorkspace]);

  const handleNewThread = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onNewThreadInWorkspace(group);
    },
    [group, onNewThreadInWorkspace],
  );

  return (
    <SidebarMenuSubItem className="group/workspace-row relative w-full">
      <SidebarMenuSubButton
        size="md"
        isActive={isActive}
        onClick={handleClick}
        className="h-8 w-full translate-x-0 justify-start gap-2 px-2 pr-8"
      >
        {/* Fixed-size slot: the status dot and branch icon differ in size, so
            swapping them bare would shift the workspace label sideways. */}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {status ? (
            <span
              aria-label={status.label}
              className={cn(
                "size-1.5 rounded-full",
                status.dotClass,
                status.pulse && "animate-pulse",
              )}
            />
          ) : (
            <GitBranchIcon className="size-3.5 text-muted-foreground/60" />
          )}
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            className={cn(
              "truncate text-xs text-foreground/90",
              group.label === UNNAMED_WORKSPACE_LABEL && "italic text-muted-foreground",
            )}
          >
            {group.label}
          </span>
          {group.threads.length + group.draftIds.length > 1 ? (
            <span className="shrink-0 text-[10px] text-muted-foreground/60">
              {group.threads.length + group.draftIds.length}
            </span>
          ) : null}
        </span>
      </SidebarMenuSubButton>
      <Tooltip>
        <TooltipTrigger
          render={
            <div className="pointer-events-none absolute top-1/2 right-0.5 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/workspace-row:pointer-events-auto group-hover/workspace-row:opacity-100 group-focus-within/workspace-row:pointer-events-auto group-focus-within/workspace-row:opacity-100">
              <button
                type="button"
                aria-label={`New thread in ${group.label}`}
                className={SIDEBAR_ICON_ACTION_BUTTON_CLASS}
                onClick={handleNewThread}
              >
                <span aria-hidden className="text-base leading-none">
                  +
                </span>
              </button>
            </div>
          }
        />
        <TooltipPopup side="top">
          {newThreadShortcutLabel ? `New thread (${newThreadShortcutLabel})` : "New thread"}
        </TooltipPopup>
      </Tooltip>
    </SidebarMenuSubItem>
  );
});

/**
 * Vertical list of workspaces (working trees) for a repository. Each row is a
 * workspace; the threads inside a workspace are presented as horizontal tabs in
 * the chat view, not here.
 */
export const SidebarWorkspaceList = memo(function SidebarWorkspaceList(
  props: SidebarWorkspaceListProps,
) {
  const {
    projectThreads,
    projectRefs,
    draftSessions,
    projectExpanded,
    activeRouteThreadKey,
    activeDraftId,
    newThreadShortcutLabel,
    navigateToThread,
    navigateToDraft,
    onNewThreadInWorkspace,
    attachWorkspaceListAutoAnimateRef,
  } = props;
  const groups = useMemo(
    () =>
      buildSidebarWorkspaceGroups({
        threads: projectThreads,
        drafts: draftSessions,
        projectRefs,
      }),
    [draftSessions, projectRefs, projectThreads],
  );

  if (!projectExpanded) {
    return null;
  }

  return (
    <SidebarMenuSub
      ref={attachWorkspaceListAutoAnimateRef}
      className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden px-1 py-0 sm:mx-1 sm:px-1.5"
    >
      {groups.length === 0 ? (
        <SidebarMenuSubItem className="w-full">
          <div className="flex h-6 w-full translate-x-0 items-center px-2 text-left text-[10px] text-muted-foreground/60">
            <span>No workspaces yet</span>
          </div>
        </SidebarMenuSubItem>
      ) : null}
      {groups.map((group) => {
        const groupThreadKeys = new Set(
          group.threads.map((thread) =>
            scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          ),
        );
        const isActive =
          (activeRouteThreadKey !== null && groupThreadKeys.has(activeRouteThreadKey)) ||
          (activeDraftId !== null && group.draftIds.includes(activeDraftId));
        return (
          <SidebarWorkspaceRow
            key={group.key}
            group={group}
            isActive={isActive}
            newThreadShortcutLabel={newThreadShortcutLabel}
            navigateToThread={navigateToThread}
            navigateToDraft={navigateToDraft}
            onNewThreadInWorkspace={onNewThreadInWorkspace}
          />
        );
      })}
    </SidebarMenuSub>
  );
});

export function workspaceProjectRef(group: WorkspaceGroup<SidebarThreadSummary>) {
  return scopeProjectRef(group.environmentId, group.projectId);
}
