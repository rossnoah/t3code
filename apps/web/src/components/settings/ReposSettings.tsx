import { useAtomValue } from "@effect/atom-react";
import type { ProjectScript } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { FolderGit2Icon, PlusIcon, SettingsIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { useProjectScriptActions } from "../../hooks/useProjectScriptActions";
import { shortcutLabelForCommand } from "../../keybindings";
import { commandForProjectScript } from "../../projectScripts";
import { useProjects } from "../../state/entities";
import { projectEnvironment } from "../../state/projects";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ProjectScriptEditorDialog,
  ScriptIcon,
  type NewProjectScriptInput,
} from "../ProjectScriptEditorDialog";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function projectKey(project: EnvironmentProject): string {
  return `${project.environmentId}:${project.id}`;
}

function setupScriptOf(project: EnvironmentProject): ProjectScript | null {
  return project.scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

/**
 * Setup-script command as an inline editor: saving updates the project's
 * `runOnWorktreeCreate` script in place, creates a "Setup" script when the
 * repo has none, and deletes it when cleared.
 */
function SetupScriptEditor({
  project,
  onOpenFullEditor,
}: {
  project: EnvironmentProject;
  onOpenFullEditor: (script: ProjectScript) => void;
}) {
  const scriptActions = useProjectScriptActions();
  const setupScript = setupScriptOf(project);
  const persistedCommand = setupScript?.command ?? "";
  const [command, setCommand] = useState(persistedCommand);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setCommand(persistedCommand);
  }, [persistedCommand]);

  const dirty = command !== persistedCommand;

  const save = useCallback(async () => {
    const trimmed = command.trim();
    setSaving(true);
    try {
      const result = setupScript
        ? trimmed.length === 0
          ? await scriptActions.deleteScript(project, setupScript.id)
          : await scriptActions.updateScript(project, setupScript.id, {
              name: setupScript.name,
              command: trimmed,
              icon: setupScript.icon,
              runOnWorktreeCreate: true,
              keybinding: null,
              previewUrl: setupScript.previewUrl ?? null,
              autoOpenPreview: setupScript.autoOpenPreview ?? false,
            })
        : trimmed.length === 0
          ? null
          : await scriptActions.addScript(project, {
              name: "Setup",
              command: trimmed,
              icon: "configure",
              runOnWorktreeCreate: true,
              keybinding: null,
              previewUrl: null,
              autoOpenPreview: false,
            });
      if (result && result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not save setup script",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    } finally {
      setSaving(false);
    }
  }, [command, project, scriptActions, setupScript]);

  return (
    <div className="space-y-2 px-4 py-3.5 sm:px-5">
      <div className="flex items-center gap-1.5">
        <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          Setup script
        </h3>
        {setupScript ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Edit setup script details"
            onClick={() => onOpenFullEditor(setupScript)}
          >
            <SettingsIcon className="size-3.5" />
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Runs in the new worktree when a workspace is created.
      </p>
      <Textarea
        placeholder="pnpm install"
        className="font-mono text-xs"
        value={command}
        onChange={(event) => setCommand(event.target.value)}
      />
      {dirty ? (
        <div className="flex items-center gap-2">
          <Button size="xs" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => setCommand(persistedCommand)}
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * File patterns copied from the root checkout into every new worktree —
 * gitignored local files like `.env*`. One pattern per line; `*` and `?`
 * match within a path segment.
 */
function FilesToCopyEditor({ project }: { project: EnvironmentProject }) {
  const updateProject = useAtomCommand(projectEnvironment.update, { reportFailure: false });
  const persistedText = (project.copyFilePatterns ?? []).join("\n");
  const [text, setText] = useState(persistedText);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(persistedText);
  }, [persistedText]);

  const dirty = text !== persistedText;

  const save = useCallback(async () => {
    const patterns = text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    setSaving(true);
    try {
      const result = await updateProject({
        environmentId: project.environmentId,
        input: {
          projectId: project.id,
          copyFilePatterns: patterns,
        },
      });
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not save files to copy",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      }
    } finally {
      setSaving(false);
    }
  }, [project.environmentId, project.id, text, updateProject]);

  return (
    <div className="space-y-2 px-4 py-3.5 sm:px-5">
      <h3 className="text-[13px] font-semibold tracking-[-0.01em] text-foreground">
        Files to copy
      </h3>
      <p className="text-xs text-muted-foreground">
        Copied from the root checkout into each new worktree — gitignored local files the checkout
        won't carry, like env files. One pattern per line; <code>*</code> matches within a path
        segment (e.g. <code>.env*</code>). Existing files are never overwritten.
      </p>
      <Textarea
        placeholder={".env*"}
        className="font-mono text-xs"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {dirty ? (
        <div className="flex items-center gap-2">
          <Button size="xs" disabled={saving} onClick={() => void save()}>
            {saving ? "Saving…" : "Save"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={saving}
            onClick={() => setText(persistedText)}
          >
            Discard
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Conductor-style per-repo settings: pick a repo, then configure its
 * scripts — the setup script that prepares fresh worktrees and the run
 * scripts (actions) available from the chat header and keybindings.
 */
export function ReposSettingsPanel() {
  const projects = useProjects();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editorScript, setEditorScript] = useState<ProjectScript | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const scriptActions = useProjectScriptActions();

  const selectedProject = useMemo(() => {
    if (projects.length === 0) return null;
    return projects.find((project) => projectKey(project) === selectedKey) ?? projects[0] ?? null;
  }, [projects, selectedKey]);

  const projectItems = useMemo(
    () => projects.map((project) => ({ value: projectKey(project), label: project.title })),
    [projects],
  );

  const openEditor = useCallback((script: ProjectScript | null) => {
    setEditorScript(script);
    setEditorOpen(true);
  }, []);

  const handleAddScript = useCallback(
    async (input: NewProjectScriptInput) => {
      if (!selectedProject) throw new Error("No repo selected.");
      return scriptActions.addScript(selectedProject, input);
    },
    [scriptActions, selectedProject],
  );
  const handleUpdateScript = useCallback(
    async (scriptId: string, input: NewProjectScriptInput) => {
      if (!selectedProject) throw new Error("No repo selected.");
      return scriptActions.updateScript(selectedProject, scriptId, input);
    },
    [scriptActions, selectedProject],
  );
  const handleDeleteScript = useCallback(
    async (scriptId: string) => {
      if (!selectedProject) throw new Error("No repo selected.");
      return scriptActions.deleteScript(selectedProject, scriptId);
    },
    [scriptActions, selectedProject],
  );

  if (projects.length === 0 || !selectedProject) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FolderGit2Icon />
            </EmptyMedia>
            <EmptyTitle>No repos yet</EmptyTitle>
            <EmptyDescription>
              Repos appear here once you open a project. Each repo can define a setup script that
              runs in every new worktree, plus run scripts for quick actions.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }

  const runScripts = selectedProject.scripts.filter((script) => !script.runOnWorktreeCreate);

  return (
    <SettingsPageContainer>
      <div className="flex items-center gap-2 px-1">
        <Select
          modal={false}
          value={projectKey(selectedProject)}
          onValueChange={(value) => setSelectedKey(value as string)}
          items={projectItems}
        >
          <SelectTrigger variant="default" size="sm" aria-label="Repo">
            <ProjectFavicon
              environmentId={selectedProject.environmentId}
              cwd={selectedProject.workspaceRoot}
              className="size-4"
            />
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {projects.map((project) => (
              <SelectItem key={projectKey(project)} value={projectKey(project)}>
                <span className="inline-flex items-center gap-1.5">
                  <ProjectFavicon
                    environmentId={project.environmentId}
                    cwd={project.workspaceRoot}
                    className="size-4"
                  />
                  {project.title}
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <span className="truncate text-xs text-muted-foreground">
          {selectedProject.workspaceRoot}
        </span>
      </div>

      <SettingsSection title="Scripts">
        <SetupScriptEditor
          key={projectKey(selectedProject)}
          project={selectedProject}
          onOpenFullEditor={openEditor}
        />
      </SettingsSection>

      <SettingsSection title="Worktrees">
        <FilesToCopyEditor key={projectKey(selectedProject)} project={selectedProject} />
      </SettingsSection>

      <SettingsSection
        title="Run Scripts"
        headerAction={
          <Button size="xs" variant="outline" onClick={() => openEditor(null)}>
            <PlusIcon className="size-3.5" />
            Add
          </Button>
        }
      >
        {runScripts.length === 0 ? (
          <p className="px-4 py-3.5 text-xs text-muted-foreground sm:px-5">
            Shortcuts for quick actions, like running your dev server or test suite. No run scripts
            yet — add one to get started.
          </p>
        ) : (
          runScripts.map((script) => {
            const shortcutLabel = shortcutLabelForCommand(
              keybindings,
              commandForProjectScript(script.id),
            );
            return (
              <div
                key={script.id}
                className="flex items-center gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 sm:px-5"
              >
                <ScriptIcon icon={script.icon} className="size-3.5 shrink-0" />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold tracking-[-0.01em] text-foreground">
                      {script.name}
                    </span>
                    {shortcutLabel ? (
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {shortcutLabel}
                      </span>
                    ) : null}
                  </div>
                  <code className="block truncate font-mono text-xs text-muted-foreground">
                    {script.command}
                  </code>
                </div>
                <Button size="xs" variant="outline" onClick={() => openEditor(script)}>
                  Edit
                </Button>
              </div>
            );
          })
        )}
      </SettingsSection>

      <ProjectScriptEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        editingScript={editorScript}
        scripts={selectedProject.scripts}
        keybindings={keybindings}
        onAddScript={handleAddScript}
        onUpdateScript={handleUpdateScript}
        onDeleteScript={handleDeleteScript}
      />
    </SettingsPageContainer>
  );
}
