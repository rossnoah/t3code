import type {
  DesktopUpdateActionResult,
  DesktopUpdateState,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

import { resolveDesktopUpdateButtonAction } from "../components/desktopUpdate.logic";

// Leave time for follow-up turns and checkpoint work to settle before restarting.
export const DESKTOP_UPDATE_IDLE_DELAY_MS = 5_000;

type UpdateTarget = Pick<DesktopUpdateState, "downloadedVersion" | "channel">;
export type DesktopUpdateInstallState =
  | { readonly status: "idle" }
  | { readonly status: "prompt" | "queued" | "installing"; readonly target: UpdateTarget };

export function isThreadBlockingDesktopRestart(
  thread: Pick<
    OrchestrationThreadShell,
    "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness"
  >,
): boolean {
  return (
    thread.session?.status === "starting" ||
    thread.session?.status === "running" ||
    thread.session?.activeTurnId != null ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingApprovals ||
    thread.hasPendingUserInput ||
    thread.backgroundLiveness != null
  );
}

/** One queue for all update entry points, owned by the app rather than a route. */
export function createDesktopUpdateInstallController(input: {
  readonly getUpdateState: () => Promise<DesktopUpdateState>;
  readonly installUpdate: () => Promise<DesktopUpdateActionResult>;
  readonly canRestart: () => boolean;
  readonly onError: (message: string) => void;
}) {
  let state: DesktopUpdateInstallState = { status: "idle" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  let activityRevision = 0;
  let announcedTarget: string | undefined;

  const clearTimer = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const publish = (next: DesktopUpdateInstallState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  const cancel = () => {
    if (state.status === "installing") return;
    clearTimer();
    publish({ status: "idle" });
  };

  const install = async (request: DesktopUpdateInstallState, whenIdle: boolean) => {
    if (request.status === "idle" || state !== request) return;
    const revision = activityRevision;
    let installing: DesktopUpdateInstallState | undefined;
    try {
      // A track change or a new download must never silently change what was queued.
      const latest = await input.getUpdateState();
      if (state !== request) return;
      if (whenIdle && latest.status === "checking") return;
      if (
        !latest.enabled ||
        latest.channel !== request.target.channel ||
        latest.downloadedVersion !== request.target.downloadedVersion ||
        resolveDesktopUpdateButtonAction(latest) !== "install"
      ) {
        cancel();
        input.onError("The downloaded update changed. Choose the update again to restart.");
        return;
      }
      // Recheck after the asynchronous IPC read; an agent may have started meanwhile.
      if (whenIdle && (revision !== activityRevision || !input.canRestart())) return;
      installing = { status: "installing", target: request.target };
      publish(installing);
      const result = await input.installUpdate();
      if (state !== installing) return;
      if (!result.accepted || result.state.errorContext === "install") {
        publish({ status: "idle" });
        input.onError(
          result.state.message ?? "The update could not be installed. Please try again.",
        );
      }
    } catch (error) {
      if (state !== request && state !== installing) return;
      publish({ status: "idle" });
      input.onError(error instanceof Error ? error.message : "The update could not be installed.");
    }
  };

  const activityChanged = (ready = input.canRestart()) => {
    if (state.status !== "queued") return;
    if (!ready || !input.canRestart()) {
      activityRevision += 1;
      clearTimer();
      return;
    }
    if (timer !== undefined) return;
    const request = state;
    timer = setTimeout(() => {
      timer = undefined;
      if (state === request && input.canRestart()) void install(request, true);
    }, DESKTOP_UPDATE_IDLE_DELAY_MS);
  };

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    request: (update: DesktopUpdateState) => {
      if (state.status !== "idle" || resolveDesktopUpdateButtonAction(update) !== "install") return;
      announcedTarget = `${update.channel}:${update.downloadedVersion}`;
      publish({ status: "prompt", target: update });
    },
    queue: () => {
      if (state.status !== "prompt") return;
      publish({ status: "queued", target: state.target });
      activityChanged();
    },
    restartNow: () => {
      if (state.status !== "prompt" && state.status !== "queued") return;
      clearTimer();
      void install(state, false);
    },
    cancelRestart: () => {
      if (state.status !== "queued") return;
      clearTimer();
      publish({ status: "prompt", target: state.target });
    },
    cancel,
    activityChanged,
    updateChanged: (update: DesktopUpdateState) => {
      if (
        state.status === "installing" &&
        update.status === "error" &&
        update.errorContext === "install"
      ) {
        publish({ status: "idle" });
        input.onError(update.message ?? "The update could not be installed. Please try again.");
      } else if (
        (state.status === "queued" || state.status === "prompt") &&
        (!update.enabled ||
          update.channel !== state.target.channel ||
          update.downloadedVersion !== state.target.downloadedVersion)
      ) {
        const wasQueued = state.status === "queued";
        cancel();
        if (wasQueued) {
          input.onError("The downloaded update changed. Choose the update again to restart.");
        }
      }
      const targetKey = `${update.channel}:${update.downloadedVersion}`;
      if (
        state.status === "idle" &&
        update.enabled &&
        update.status === "downloaded" &&
        update.downloadedVersion &&
        announcedTarget !== targetKey
      ) {
        announcedTarget = targetKey;
        publish({ status: "prompt", target: update });
      }
      if (state.status === "queued" && update.status === "downloaded") activityChanged();
    },
    dispose: () => {
      clearTimer();
      announcedTarget = undefined;
      publish({ status: "idle" });
    },
  };
}
