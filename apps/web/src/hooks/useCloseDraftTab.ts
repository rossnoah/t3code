import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { type DraftId, useComposerDraftStore, workspaceDraftSessions } from "../composerDraftStore";
import { readEnvironmentThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { workspaceThreads } from "../worktreeGrouping";
import { useNewThreadHandler } from "./useHandleNewThread";

/**
 * Closes a draft ("New thread") tab: discards the draft and, when it is the
 * active route, activates the neighboring workspace tab — the draft to its
 * right, else the one to its left, else the workspace's last real thread. When
 * it was the workspace's only tab, a fresh draft is opened in the same worktree
 * so the workspace (including the repo root) never closes out to an empty state.
 */
export function useCloseDraftTab() {
  const router = useRouter();
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (draftId: DraftId) => {
      const store = useComposerDraftStore.getState();
      const session = store.getDraftSession(draftId);
      const clearDraft = () => store.clearDraftThread(draftId);
      const currentRouteParams =
        router.state.matches[router.state.matches.length - 1]?.params ?? {};
      const currentRouteTarget = resolveThreadRouteTarget(currentRouteParams);
      const isActive =
        currentRouteTarget?.kind === "draft" && currentRouteTarget.draftId === draftId;
      if (!session || !isActive) {
        clearDraft();
        return;
      }
      const workspace = {
        environmentId: session.environmentId,
        projectId: session.projectId,
        worktreePath: session.worktreePath,
      };
      const drafts = workspaceDraftSessions(store.draftThreadsByThreadKey, workspace);
      const threads = workspaceThreads(
        readEnvironmentThreadShells(session.environmentId),
        workspace,
      );
      // Draft tabs sit after the thread tabs in the strip, so the left
      // fallback of the first draft is the workspace's last real thread.
      const index = drafts.findIndex((candidate) => candidate.draftId === draftId);
      const neighborDraft =
        index === -1
          ? undefined
          : (drafts[index + 1] ?? (index > 0 ? drafts[index - 1] : undefined));
      const lastThread = threads[threads.length - 1];
      if (neighborDraft) {
        await router.navigate({
          to: "/draft/$draftId",
          params: { draftId: neighborDraft.draftId },
        });
      } else if (lastThread) {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(scopeThreadRef(lastThread.environmentId, lastThread.id)),
        });
      } else {
        // Last tab in the workspace: open a fresh draft in the same worktree and
        // navigate to it BEFORE discarding the old one, so we move straight to the
        // new tab with no flash of an empty workspace / home screen.
        await handleNewThread(scopeProjectRef(session.environmentId, session.projectId), {
          branch: session.branch,
          worktreePath: session.worktreePath,
          envMode: session.envMode,
          forceNew: true,
        });
        clearDraft();
        return;
      }
      clearDraft();
    },
    [handleNewThread, router],
  );
}
