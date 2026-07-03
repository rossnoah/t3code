import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Option from "effect/Option";
import { memo, useCallback } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { CursorIcon } from "../Icons";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const activeEnvironment = useEnvironment(activeThreadEnvironmentId);
  const activeEnvironmentEntry = activeEnvironment?.entry ?? null;
  // The ssh config Host alias of the active environment; Cursor resolves
  // HostName/User/Port from the local ssh config through this alias.
  const sshRemoteHost =
    activeEnvironmentEntry !== null &&
    activeEnvironmentEntry.target._tag === "SshConnectionTarget" &&
    Option.isSome(activeEnvironmentEntry.profile) &&
    activeEnvironmentEntry.profile.value._tag === "SshConnectionProfile"
      ? activeEnvironmentEntry.profile.value.target.alias
      : null;
  const openInEditorMutation = useAtomCommand(shellEnvironment.openInEditor, "open in cursor");
  // Cursor always launches on the local (primary) machine: plain open for
  // local threads, `--remote ssh-remote+<alias>` for ssh-backed threads.
  const showOpenInCursor =
    openInCwd !== null &&
    primaryEnvironmentId !== null &&
    availableEditors.includes("cursor") &&
    (activeThreadEnvironmentId === primaryEnvironmentId || sshRemoteHost !== null);
  const openInCursor = useCallback(() => {
    if (!openInCwd || primaryEnvironmentId === null) return;
    void openInEditorMutation({
      environmentId: primaryEnvironmentId,
      input: {
        cwd: openInCwd,
        editor: "cursor",
        ...(sshRemoteHost !== null ? { sshRemoteHost } : {}),
      },
    });
  }, [openInCwd, openInEditorMutation, primaryEnvironmentId, sshRemoteHost]);
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {showOpenInCursor && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="outline"
                  aria-label="Open in Cursor"
                  onClick={openInCursor}
                />
              }
            >
              <CursorIcon aria-hidden="true" className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">Open in Cursor</TooltipPopup>
          </Tooltip>
        )}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
