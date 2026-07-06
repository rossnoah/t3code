import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

/**
 * Copies a project's `copyFilePatterns` matches — gitignored local files
 * like `.env*` that a fresh checkout won't carry — from the root checkout
 * into a newly created worktree.
 *
 * Patterns are matched per path segment (`*` and `?` never cross a `/`), so
 * `.env*` matches root env files and a pattern like `apps/<star>/.env.local`
 * reaches one level into a monorepo. Files already present in the worktree
 * (i.e. tracked files the checkout produced) are never overwritten, and
 * every failure is per-file and non-fatal: preparing a worktree must not
 * break because one file could not be read.
 */

/** Compile one pattern into per-segment matchers; null for empty patterns. */
export function compileCopyFilePattern(pattern: string): RegExp[] | null {
  const segments = pattern
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length === 0 || segments.some((segment) => segment === "..")) {
    return null;
  }
  return segments.map((segment) => {
    const source = segment
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]");
    return new RegExp(`^${source}$`);
  });
}

export interface CopyWorktreeFilesInput {
  readonly rootPath: string;
  readonly worktreePath: string;
  readonly patterns: ReadonlyArray<string>;
}

export interface CopyWorktreeFilesResult {
  /** Root-relative paths copied into the worktree. */
  readonly copied: ReadonlyArray<string>;
  /** Matches skipped because the worktree already has the file. */
  readonly skipped: ReadonlyArray<string>;
}

export const copyWorktreeFiles = Effect.fn("copyWorktreeFiles")(function* (
  input: CopyWorktreeFilesInput,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const statOption = (absolutePath: string) =>
    fileSystem.stat(absolutePath).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<FileSystem.File.Info>()),
    );

  // Pattern-guided walk: only directories a pattern prefix matches are
  // listed, so `.env*` never traverses node_modules.
  const matched = new Set<string>();
  const frames: Array<{ relativeDir: string; segments: readonly RegExp[] }> = [];
  for (const pattern of input.patterns) {
    const segments = compileCopyFilePattern(pattern);
    if (segments) {
      frames.push({ relativeDir: "", segments });
    }
  }
  while (frames.length > 0) {
    const frame = frames.pop();
    if (!frame) break;
    const [head, ...rest] = frame.segments;
    if (!head) continue;
    const absoluteDir = path.join(input.rootPath, frame.relativeDir);
    const entries = yield* fileSystem
      .readDirectory(absoluteDir)
      .pipe(Effect.orElseSucceed((): string[] => []));
    for (const entry of entries) {
      if (entry === ".git" || !head.test(entry)) {
        continue;
      }
      const relativePath = frame.relativeDir ? `${frame.relativeDir}/${entry}` : entry;
      const info = yield* statOption(path.join(input.rootPath, relativePath));
      if (Option.isNone(info)) {
        continue;
      }
      if (rest.length === 0) {
        if (info.value.type === "File") {
          matched.add(relativePath);
        }
      } else if (info.value.type === "Directory") {
        frames.push({ relativeDir: relativePath, segments: rest });
      }
    }
  }

  const copied: string[] = [];
  const skipped: string[] = [];
  for (const relativePath of [...matched].sort()) {
    const destination = path.join(input.worktreePath, relativePath);
    const existing = yield* statOption(destination);
    if (Option.isSome(existing)) {
      skipped.push(relativePath);
      continue;
    }
    yield* fileSystem
      .makeDirectory(path.dirname(destination), { recursive: true })
      .pipe(Effect.ignore);
    yield* fileSystem.copyFile(path.join(input.rootPath, relativePath), destination).pipe(
      Effect.matchCauseEffect({
        onSuccess: () => {
          copied.push(relativePath);
          return Effect.void;
        },
        onFailure: (cause) =>
          Effect.logWarning("copyWorktreeFiles failed to copy file into worktree", {
            rootPath: input.rootPath,
            worktreePath: input.worktreePath,
            relativePath,
            cause: Cause.pretty(cause),
          }),
      }),
    );
  }

  return { copied, skipped };
});
