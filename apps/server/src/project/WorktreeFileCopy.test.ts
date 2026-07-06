import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { compileCopyFilePattern, copyWorktreeFiles } from "./WorktreeFileCopy.ts";

const makeDirWithFiles = (prefix: string, files: Record<string, string>) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix });
    for (const [relativePath, contents] of Object.entries(files)) {
      yield* fileSystem
        .makeDirectory(path.dirname(path.join(dir, relativePath)), { recursive: true })
        .pipe(Effect.orDie);
      yield* fileSystem.writeFileString(path.join(dir, relativePath), contents).pipe(Effect.orDie);
    }
    return dir;
  });

const readWorktreeFile = (worktreePath: string, relativePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fileSystem
      .readFileString(path.join(worktreePath, relativePath))
      .pipe(Effect.orElseSucceed(() => null));
  });

describe("compileCopyFilePattern", () => {
  it("compiles per-segment wildcards", () => {
    const segments = compileCopyFilePattern("apps/*/.env*");
    expect(segments).toHaveLength(3);
    expect(segments?.[1]?.test("web")).toBe(true);
    expect(segments?.[2]?.test(".env.local")).toBe(true);
    expect(segments?.[2]?.test("env")).toBe(false);
  });

  it("rejects empty and parent-escaping patterns", () => {
    expect(compileCopyFilePattern("   ")).toBeNull();
    expect(compileCopyFilePattern("../secrets")).toBeNull();
  });
});

describe("copyWorktreeFiles", () => {
  it.effect("copies matching root files into the worktree", () =>
    Effect.gen(function* () {
      const rootPath = yield* makeDirWithFiles("t3code-copy-root-", {
        ".env": "A=1",
        ".env.local": "B=2",
        "README.md": "readme",
      });
      const worktreePath = yield* makeDirWithFiles("t3code-copy-worktree-", {});

      const result = yield* copyWorktreeFiles({
        rootPath,
        worktreePath,
        patterns: [".env*"],
      });

      expect(result.copied).toEqual([".env", ".env.local"]);
      expect(yield* readWorktreeFile(worktreePath, ".env")).toBe("A=1");
      expect(yield* readWorktreeFile(worktreePath, ".env.local")).toBe("B=2");
      expect(yield* readWorktreeFile(worktreePath, "README.md")).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("never overwrites files the checkout already produced", () =>
    Effect.gen(function* () {
      const rootPath = yield* makeDirWithFiles("t3code-copy-root-", {
        ".env": "root value",
      });
      const worktreePath = yield* makeDirWithFiles("t3code-copy-worktree-", {
        ".env": "checked out value",
      });

      const result = yield* copyWorktreeFiles({
        rootPath,
        worktreePath,
        patterns: [".env*"],
      });

      expect(result.copied).toEqual([]);
      expect(result.skipped).toEqual([".env"]);
      expect(yield* readWorktreeFile(worktreePath, ".env")).toBe("checked out value");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reaches into subdirectories only as deep as the pattern", () =>
    Effect.gen(function* () {
      const rootPath = yield* makeDirWithFiles("t3code-copy-root-", {
        "apps/web/.env.local": "web",
        "apps/server/.env": "server",
        "apps/web/nested/.env": "too deep",
        ".git/config": "git internals",
      });
      const worktreePath = yield* makeDirWithFiles("t3code-copy-worktree-", {});

      const result = yield* copyWorktreeFiles({
        rootPath,
        worktreePath,
        patterns: ["apps/*/.env*", "*/config"],
      });

      expect(result.copied).toEqual(["apps/server/.env", "apps/web/.env.local"]);
      expect(yield* readWorktreeFile(worktreePath, "apps/web/nested/.env")).toBeNull();
      expect(yield* readWorktreeFile(worktreePath, ".git/config")).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
