import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  buildSidebarWorkspaceGroups,
  buildWorkspaceGroups,
  MAIN_WORKSPACE_LABEL,
  resolveWorkspaceTerminalAnchorRef,
  UNNAMED_WORKSPACE_LABEL,
  type WorkspaceDraftInput,
  workspaceDisplayLabel,
  workspaceGroupKey,
  workspaceGroupRepresentative,
  workspaceThreads,
  type WorkspaceGroupableThread,
} from "./worktreeGrouping";

const env = "env-1" as EnvironmentId;
const otherEnv = "env-2" as EnvironmentId;
const project = "project-1" as ProjectId;

function makeThread(input: {
  id: string;
  worktreePath?: string | null;
  branch?: string | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
  environmentId?: EnvironmentId;
  projectId?: ProjectId;
}): WorkspaceGroupableThread {
  return {
    id: input.id as ThreadId,
    environmentId: input.environmentId ?? env,
    projectId: input.projectId ?? project,
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: input.updatedAt ?? "2026-01-01T00:00:00.000Z",
    archivedAt: input.archivedAt ?? null,
  };
}

describe("buildWorkspaceGroups", () => {
  it("groups threads by worktree and drops archived threads", () => {
    const groups = buildWorkspaceGroups([
      makeThread({ id: "a", worktreePath: "/repos/app/.worktrees/feature-x" }),
      makeThread({ id: "b", worktreePath: "/repos/app/.worktrees/feature-x" }),
      makeThread({ id: "c" }),
      makeThread({
        id: "d",
        worktreePath: "/repos/app/.worktrees/feature-x",
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    expect(groups).toHaveLength(2);
    const main = groups.find((group) => group.worktreePath === null);
    const worktree = groups.find((group) => group.worktreePath !== null);
    expect(main?.threads.map((thread) => thread.id)).toEqual(["c"]);
    expect(main?.label).toBe(MAIN_WORKSPACE_LABEL);
    expect(worktree?.threads.map((thread) => thread.id)).toEqual(["a", "b"]);
    expect(worktree?.label).toBe("feature-x");
  });

  it("orders worktrees by latest activity, with the main checkout pinned to the bottom", () => {
    const groups = buildWorkspaceGroups([
      makeThread({ id: "old", worktreePath: "/w/old", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeThread({ id: "new", worktreePath: "/w/new", updatedAt: "2026-03-01T00:00:00.000Z" }),
      makeThread({ id: "main", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]);

    expect(groups.map((group) => group.worktreePath)).toEqual(["/w/new", "/w/old", null]);
  });

  it("keeps tab order stable by creation time", () => {
    const groups = buildWorkspaceGroups([
      makeThread({ id: "later", worktreePath: "/w/x", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeThread({ id: "earlier", worktreePath: "/w/x", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);

    expect(groups[0]?.threads.map((thread) => thread.id)).toEqual(["earlier", "later"]);
  });

  it("separates identical worktree paths across environments and projects", () => {
    const groups = buildWorkspaceGroups([
      makeThread({ id: "a", worktreePath: "/w/x" }),
      makeThread({ id: "b", worktreePath: "/w/x", environmentId: otherEnv }),
    ]);

    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((group) => group.key)).size).toBe(2);
  });

  it("uses the newest thread's branch as the group branch", () => {
    const groups = buildWorkspaceGroups([
      makeThread({
        id: "a",
        worktreePath: "/w/x",
        branch: "old-branch",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      makeThread({
        id: "b",
        worktreePath: "/w/x",
        branch: "new-branch",
        updatedAt: "2026-02-01T00:00:00.000Z",
      }),
    ]);

    expect(groups[0]?.branch).toBe("new-branch");
  });

  it("labels workspaces from the branch once it has a generated name", () => {
    const groups = buildWorkspaceGroups([
      makeThread({ id: "a", worktreePath: "/w/noah-1a2b3c4d", branch: "noah/fix-tab-widths" }),
    ]);

    expect(groups[0]?.label).toBe("fix-tab-widths");
  });
});

describe("workspaceDisplayLabel", () => {
  it("labels the main checkout", () => {
    expect(workspaceDisplayLabel({ worktreePath: null, branch: "main" })).toBe(
      MAIN_WORKSPACE_LABEL,
    );
  });

  it("shows a placeholder while the branch is still the temporary one", () => {
    expect(
      workspaceDisplayLabel({ worktreePath: "/w/noah-1a2b3c4d", branch: "noah/1a2b3c4d" }),
    ).toBe(UNNAMED_WORKSPACE_LABEL);
  });

  it("strips the worktree namespace from generated branch names", () => {
    expect(
      workspaceDisplayLabel({ worktreePath: "/w/noah-1a2b3c4d", branch: "noah/fix-tab-widths" }),
    ).toBe("fix-tab-widths");
  });

  it("shows other branches as-is", () => {
    expect(workspaceDisplayLabel({ worktreePath: "/w/pr-123", branch: "feature/dark-mode" })).toBe(
      "feature/dark-mode",
    );
  });

  it("falls back to the directory basename when the branch is unknown", () => {
    expect(
      workspaceDisplayLabel({ worktreePath: "/repos/app/.worktrees/feature-x", branch: null }),
    ).toBe("feature-x");
  });
});

describe("workspaceGroupRepresentative", () => {
  it("picks the most recently updated thread", () => {
    const groups = buildWorkspaceGroups([
      makeThread({ id: "stale", worktreePath: "/w/x", updatedAt: "2026-01-01T00:00:00.000Z" }),
      makeThread({ id: "fresh", worktreePath: "/w/x", updatedAt: "2026-02-01T00:00:00.000Z" }),
    ]);
    const group = groups[0];
    expect(group && workspaceGroupRepresentative(group)?.id).toBe("fresh");
  });
});

describe("buildSidebarWorkspaceGroups", () => {
  const projectRefs = [{ environmentId: env, projectId: project }];

  function makeDraft(input: {
    draftId: string;
    worktreePath?: string | null;
    branch?: string | null;
    createdAt?: string;
  }): WorkspaceDraftInput {
    return {
      draftId: input.draftId,
      environmentId: env,
      projectId: project,
      worktreePath: input.worktreePath ?? null,
      branch: input.branch ?? null,
      createdAt: input.createdAt ?? "2026-01-01T00:00:00.000Z",
    };
  }

  it("always includes a main workspace row, pinned to the bottom, even with no threads", () => {
    const groups = buildSidebarWorkspaceGroups({ threads: [], drafts: [], projectRefs });
    expect(groups).toHaveLength(1);
    expect(groups[0]?.worktreePath).toBeNull();
    expect(groups[0]?.label).toBe(MAIN_WORKSPACE_LABEL);
    expect(groups[0]?.threads).toEqual([]);
    expect(groups[0]?.draftIds).toEqual([]);
  });

  it("keeps a worktree workspace alive from a draft-only tab, above main", () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [],
      drafts: [makeDraft({ draftId: "d1", worktreePath: "/w/feature", branch: "feature/login" })],
      projectRefs,
    });
    expect(groups.map((group) => group.worktreePath)).toEqual(["/w/feature", null]);
    const workspace = groups[0];
    expect(workspace?.threads).toEqual([]);
    expect(workspace?.draftIds).toEqual(["d1"]);
    expect(workspace?.label).toBe("feature/login");
  });

  it("merges draft tabs into a workspace that also has live threads", () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [makeThread({ id: "t1", worktreePath: "/w/feature" })],
      drafts: [makeDraft({ draftId: "d1", worktreePath: "/w/feature" })],
      projectRefs,
    });
    const workspace = groups.find((group) => group.worktreePath === "/w/feature");
    expect(workspace?.threads.map((thread) => thread.id)).toEqual(["t1"]);
    expect(workspace?.draftIds).toEqual(["d1"]);
  });

  it("orders worktrees by recency and never puts main above a worktree", () => {
    const groups = buildSidebarWorkspaceGroups({
      threads: [
        makeThread({ id: "m", worktreePath: null, updatedAt: "2026-05-01T00:00:00.000Z" }),
        makeThread({ id: "old", worktreePath: "/w/old", updatedAt: "2026-01-01T00:00:00.000Z" }),
        makeThread({ id: "new", worktreePath: "/w/new", updatedAt: "2026-03-01T00:00:00.000Z" }),
      ],
      drafts: [],
      projectRefs,
    });
    expect(groups.map((group) => group.worktreePath)).toEqual(["/w/new", "/w/old", null]);
  });
});

describe("resolveWorkspaceTerminalAnchorRef", () => {
  it("anchors to the oldest live thread of the workspace", () => {
    const threads = [
      makeThread({ id: "b", worktreePath: "/w/x", createdAt: "2026-01-02T00:00:00.000Z" }),
      makeThread({ id: "a", worktreePath: "/w/x", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeThread({ id: "z", worktreePath: null }),
    ];

    const anchor = resolveWorkspaceTerminalAnchorRef(threads, {
      environmentId: env,
      projectId: project,
      worktreePath: "/w/x",
      threadId: "b" as ThreadId,
    });

    expect(anchor).toEqual({ environmentId: env, threadId: "a" });
  });

  it("skips archived threads when picking the anchor", () => {
    const threads = [
      makeThread({
        id: "a",
        worktreePath: "/w/x",
        createdAt: "2026-01-01T00:00:00.000Z",
        archivedAt: "2026-01-03T00:00:00.000Z",
      }),
      makeThread({ id: "b", worktreePath: "/w/x", createdAt: "2026-01-02T00:00:00.000Z" }),
    ];

    const anchor = resolveWorkspaceTerminalAnchorRef(threads, {
      environmentId: env,
      projectId: project,
      worktreePath: "/w/x",
      threadId: "b" as ThreadId,
    });

    expect(anchor.threadId).toBe("b");
  });

  it("falls back to the active thread when the workspace has no live threads", () => {
    const anchor = resolveWorkspaceTerminalAnchorRef([], {
      environmentId: env,
      projectId: project,
      worktreePath: null,
      threadId: "draft-thread" as ThreadId,
    });

    expect(anchor).toEqual({ environmentId: env, threadId: "draft-thread" });
  });
});

describe("workspaceThreads", () => {
  it("returns only live threads of the target workspace in tab order", () => {
    const threads = [
      makeThread({ id: "c", worktreePath: "/w/x", createdAt: "2026-01-03T00:00:00.000Z" }),
      makeThread({ id: "a", worktreePath: "/w/x", createdAt: "2026-01-01T00:00:00.000Z" }),
      makeThread({ id: "other", worktreePath: "/w/y" }),
      makeThread({ id: "gone", worktreePath: "/w/x", archivedAt: "2026-01-04T00:00:00.000Z" }),
    ];

    const result = workspaceThreads(threads, {
      environmentId: env,
      projectId: project,
      worktreePath: "/w/x",
    });

    expect(result.map((thread) => thread.id)).toEqual(["a", "c"]);
  });
});

describe("workspaceGroupKey", () => {
  it("treats missing and null worktree paths identically", () => {
    expect(workspaceGroupKey({ environmentId: env, projectId: project, worktreePath: null })).toBe(
      workspaceGroupKey({ environmentId: env, projectId: project, worktreePath: null }),
    );
  });
});
