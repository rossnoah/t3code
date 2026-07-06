import {
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  KeybindingCommand,
  ProjectId,
  ProjectScript,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import type { NewProjectScriptInput } from "../components/ProjectScriptEditorDialog";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import { decodeProjectScriptKeybindingRule } from "../lib/projectScriptKeybindings";
import { commandForProjectScript, nextProjectScriptId } from "../projectScripts";
import { projectEnvironment } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

/** The project a script mutation applies to. */
export interface ProjectScriptsTarget {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly scripts: ReadonlyArray<ProjectScript>;
}

/**
 * Add/update/delete project scripts (actions), persisting via the
 * `updateProject` RPC plus an optional keybinding upsert on desktop. Shared
 * by the chat header scripts control and the Repos settings section.
 * Setting `runOnWorktreeCreate` on one script clears it on all others —
 * a project has at most one setup script.
 */
export function useProjectScriptActions() {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const upsertKeybinding = useAtomCommand(serverEnvironment.upsertKeybinding, {
    reportFailure: false,
  });

  const persistProjectScripts = useCallback(
    async (input: {
      environmentId: EnvironmentId;
      projectId: ProjectId;
      nextScripts: ReadonlyArray<ProjectScript>;
      keybinding?: string | null;
      keybindingCommand: KeybindingCommand;
    }): Promise<AtomCommandResult<void, unknown>> => {
      const updateResult = mapAtomCommandResult(
        await updateProject({
          environmentId: input.environmentId,
          input: {
            projectId: input.projectId,
            scripts: input.nextScripts,
          },
        }),
        () => undefined,
      );
      if (updateResult._tag === "Failure") {
        return updateResult;
      }

      const keybindingRule = decodeProjectScriptKeybindingRule({
        keybinding: input.keybinding,
        command: input.keybindingCommand,
      });

      if (isElectron && keybindingRule) {
        return mapAtomCommandResult(
          await upsertKeybinding({
            environmentId: input.environmentId,
            input: keybindingRule,
          }),
          () => undefined,
        );
      }
      return updateResult;
    },
    [updateProject, upsertKeybinding],
  );

  const addScript = useCallback(
    async (
      project: ProjectScriptsTarget,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const nextId = nextProjectScriptId(
        input.name,
        project.scripts.map((script) => script.id),
      );
      const nextScript: ProjectScript = {
        id: nextId,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = input.runOnWorktreeCreate
        ? [
            ...project.scripts.map((script) =>
              script.runOnWorktreeCreate ? { ...script, runOnWorktreeCreate: false } : script,
            ),
            nextScript,
          ]
        : [...project.scripts, nextScript];

      return persistProjectScripts({
        environmentId: project.environmentId,
        projectId: project.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(nextId),
      });
    },
    [persistProjectScripts],
  );

  const updateScript = useCallback(
    async (
      project: ProjectScriptsTarget,
      scriptId: string,
      input: NewProjectScriptInput,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const existingScript = project.scripts.find((script) => script.id === scriptId);
      if (!existingScript) {
        return AsyncResult.failure(Cause.fail(new Error("Script not found.")));
      }

      const updatedScript: ProjectScript = {
        ...existingScript,
        name: input.name,
        command: input.command,
        icon: input.icon,
        runOnWorktreeCreate: input.runOnWorktreeCreate,
      };
      const nextScripts = project.scripts.map((script) =>
        script.id === scriptId
          ? updatedScript
          : input.runOnWorktreeCreate
            ? { ...script, runOnWorktreeCreate: false }
            : script,
      );

      return persistProjectScripts({
        environmentId: project.environmentId,
        projectId: project.id,
        nextScripts,
        keybinding: input.keybinding,
        keybindingCommand: commandForProjectScript(scriptId),
      });
    },
    [persistProjectScripts],
  );

  const deleteScript = useCallback(
    async (
      project: ProjectScriptsTarget,
      scriptId: string,
    ): Promise<AtomCommandResult<void, unknown>> => {
      const nextScripts = project.scripts.filter((script) => script.id !== scriptId);
      const deletedName = project.scripts.find((script) => script.id === scriptId)?.name;

      const result = await persistProjectScripts({
        environmentId: project.environmentId,
        projectId: project.id,
        nextScripts,
        keybinding: null,
        keybindingCommand: commandForProjectScript(scriptId),
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: `Deleted action "${deletedName ?? "Unknown"}"`,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not delete action",
            description: error instanceof Error ? error.message : "An unexpected error occurred.",
          }),
        );
      }
      return result;
    },
    [persistProjectScripts],
  );

  return useMemo(
    () => ({ addScript, updateScript, deleteScript }),
    [addScript, deleteScript, updateScript],
  );
}
