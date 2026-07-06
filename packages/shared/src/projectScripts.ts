import type { ProjectScript } from "@t3tools/contracts";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { decodeJsonResult } from "./schemaJson.ts";

interface ProjectScriptRuntimeEnvInput {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
  extraEnv?: Record<string, string>;
}

export function projectScriptCwd(input: {
  project: {
    cwd: string;
  };
  worktreePath?: string | null;
}): string {
  return input.worktreePath ?? input.project.cwd;
}

export function projectScriptRuntimeEnv(
  input: ProjectScriptRuntimeEnvInput,
): Record<string, string> {
  const env: Record<string, string> = {
    T3CODE_PROJECT_ROOT: input.project.cwd,
  };
  if (input.worktreePath) {
    env.T3CODE_WORKTREE_PATH = input.worktreePath;
  }
  if (input.extraEnv) {
    return { ...env, ...input.extraEnv };
  }
  return env;
}

export function setupProjectScript(scripts: readonly ProjectScript[]): ProjectScript | null {
  return scripts.find((script) => script.runOnWorktreeCreate) ?? null;
}

/**
 * Repo-committed setup configuration (`{ "scripts": { "setup": "…" } }`),
 * read from the fresh worktree checkout when the project has no
 * UI-configured setup script.
 */
export const REPO_SETUP_CONFIG_FILES = ["t3code.json"] as const;
export type RepoSetupConfigFile = (typeof REPO_SETUP_CONFIG_FILES)[number];

const RepoSetupConfig = Schema.Struct({
  scripts: Schema.optional(
    Schema.Struct({
      setup: Schema.optional(Schema.String),
    }),
  ),
});
const decodeRepoSetupConfig = decodeJsonResult(RepoSetupConfig);

/** Extract `scripts.setup` from a repo config file; null for anything else. */
export function parseRepoSetupCommand(configText: string): string | null {
  const decoded = decodeRepoSetupConfig(configText);
  if (!Result.isSuccess(decoded)) {
    return null;
  }
  const command = decoded.success.scripts?.setup?.trim() ?? "";
  return command.length > 0 ? command : null;
}
