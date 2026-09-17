import type { DesktopUpdateState, OrchestrationSession } from "@t3tools/contracts";
import { ThreadId, TurnId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopUpdateInstallController,
  DESKTOP_UPDATE_IDLE_DELAY_MS,
  isThreadBlockingDesktopRestart,
} from "./desktopUpdateInstallController";

const update: DesktopUpdateState = {
  enabled: true,
  status: "downloaded",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "arm64",
  appArch: "arm64",
  runningUnderArm64Translation: false,
  availableVersion: "1.1.0",
  downloadedVersion: "1.1.0",
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: 100,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

function deferredUpdate() {
  let resolve!: (value: DesktopUpdateState) => void;
  const promise = new Promise<DesktopUpdateState>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(idle = false) {
  const input = {
    canRestart: vi.fn(() => idle),
    getUpdateState: vi.fn(async () => update),
    installUpdate: vi.fn(async () => ({ accepted: true, completed: false, state: update })),
    onError: vi.fn(),
  };
  const controller = createDesktopUpdateInstallController(input);
  controller.request(update);
  return { controller, ...input };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_IDLE_DELAY_MS);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("queued desktop updates", () => {
  it("waits for agents, then installs once after a quiet period", async () => {
    const h = setup();
    h.controller.queue();
    await settle();
    expect(h.installUpdate).not.toHaveBeenCalled();
    h.canRestart.mockReturnValue(true);
    h.controller.activityChanged();
    await settle();
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
    h.controller.activityChanged();
    await settle();
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("starts a fresh quiet period if work resumes or a connection drops", async () => {
    const h = setup(true);
    h.controller.queue();
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_IDLE_DELAY_MS - 1);
    h.canRestart.mockReturnValue(false);
    h.controller.activityChanged();
    await settle();
    expect(h.installUpdate).not.toHaveBeenCalled();
    h.canRestart.mockReturnValue(true);
    h.controller.activityChanged();
    await vi.advanceTimersByTimeAsync(DESKTOP_UPDATE_IDLE_DELAY_MS - 1);
    expect(h.installUpdate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("cancels a queued restart", async () => {
    const h = setup(true);
    h.controller.queue();
    h.controller.cancel();
    await settle();
    expect(h.installUpdate).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("idle");
  });

  it.each(["cancel", "dispose"] as const)(
    "ignores an IPC read completed after %s",
    async (action) => {
      const h = setup(true);
      const pending = deferredUpdate();
      h.getUpdateState.mockReturnValue(pending.promise);
      h.controller.queue();
      await settle();
      h.controller[action]();
      pending.resolve(update);
      await settle();
      expect(h.installUpdate).not.toHaveBeenCalled();
    },
  );

  it("rechecks activity after reading update state", async () => {
    const h = setup(true);
    const pending = deferredUpdate();
    h.getUpdateState.mockReturnValueOnce(pending.promise);
    h.controller.queue();
    await settle();
    h.canRestart.mockReturnValue(false);
    h.controller.activityChanged();
    h.canRestart.mockReturnValue(true);
    h.controller.activityChanged();
    pending.resolve(update);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.installUpdate).not.toHaveBeenCalled();
    await settle();
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("keeps waiting while the updater checks for another release", async () => {
    const h = setup(true);
    h.getUpdateState.mockResolvedValueOnce({ ...update, status: "checking" });
    h.controller.queue();
    await settle();
    expect(h.installUpdate).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("queued");
    expect(h.onError).not.toHaveBeenCalled();
    h.controller.activityChanged();
    await settle();
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("requires a new choice when the download or track changes", async () => {
    const h = setup(true);
    h.getUpdateState.mockResolvedValue({ ...update, channel: "nightly" });
    h.controller.queue();
    await settle();
    expect(h.installUpdate).not.toHaveBeenCalled();
    expect(h.controller.getSnapshot().status).toBe("idle");
    expect(h.onError).toHaveBeenCalledOnce();
  });

  it("allows an immediate restart while agents are running without duplicate installs", async () => {
    const h = setup();
    h.controller.restartNow();
    h.controller.restartNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("clears the queue on a rejected install instead of retrying automatically", async () => {
    const h = setup(true);
    h.installUpdate.mockResolvedValue({ accepted: false, completed: false, state: update });
    h.controller.queue();
    await settle();
    expect(h.controller.getSnapshot().status).toBe("idle");
    expect(h.onError).toHaveBeenCalledOnce();
    h.controller.activityChanged();
    await settle();
    expect(h.installUpdate).toHaveBeenCalledTimes(1);
  });

  it("reports a late installer failure and permits a manual retry", async () => {
    const h = setup(true);
    h.controller.queue();
    await settle();
    h.controller.updateChanged({
      ...update,
      status: "error",
      errorContext: "install",
      message: "Install failed",
    });
    expect(h.controller.getSnapshot().status).toBe("idle");
    expect(h.onError).toHaveBeenCalledWith("Install failed");
    h.controller.request(update);
    expect(h.controller.getSnapshot().status).toBe("prompt");
  });

  it("clears queued state immediately when the update changes", () => {
    const h = setup();
    h.controller.queue();
    h.controller.updateChanged({ ...update, downloadedVersion: "1.2.0" });
    expect(h.controller.getSnapshot().status).toBe("idle");
  });
});

const idleThread = {
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  backgroundLiveness: null,
};
const session: OrchestrationSession = {
  threadId: ThreadId.make("thread-1"),
  status: "ready",
  providerName: "codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-09-15T00:00:00Z",
};

describe("agent activity that blocks a restart", () => {
  it("allows idle threads and ready provider sessions", () => {
    expect(isThreadBlockingDesktopRestart(idleThread)).toBe(false);
    expect(isThreadBlockingDesktopRestart({ ...idleThread, session })).toBe(false);
  });

  it.each(["starting", "running"] as const)("waits for %s sessions", (status) => {
    expect(isThreadBlockingDesktopRestart({ ...idleThread, session: { ...session, status } })).toBe(
      true,
    );
  });

  it("waits for requested turns before their provider starts", () => {
    expect(
      isThreadBlockingDesktopRestart({
        ...idleThread,
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "running",
          requestedAt: session.updatedAt,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ).toBe(true);
  });

  it.each([
    { hasPendingApprovals: true },
    { hasPendingUserInput: true },
    { backgroundLiveness: "working" as const },
    { backgroundLiveness: "monitoring" as const },
    { session: { ...session, activeTurnId: TurnId.make("turn-1") } },
  ])("waits for outstanding work after a session becomes ready: %j", (patch) => {
    expect(isThreadBlockingDesktopRestart({ ...idleThread, ...patch })).toBe(true);
  });
});
