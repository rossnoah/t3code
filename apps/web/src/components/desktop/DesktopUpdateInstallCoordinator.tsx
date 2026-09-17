import { useAtomValue } from "@effect/atom-react";
import { XIcon } from "lucide-react";
import { useEffect, useSyncExternalStore } from "react";

import {
  desktopRestartActivityAtom,
  desktopUpdateInstallController as controller,
} from "../../state/desktopUpdateInstall";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import {
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "../desktopUpdate.logic";
import { openDesktopUpdateReleaseNotes } from "../desktopUpdate.toast";
import { Button } from "../ui/button";

function QueuedRestartActivity() {
  const activity = useAtomValue(desktopRestartActivityAtom);
  const bootstraps = useDesktopLocalBootstraps();
  useEffect(() => {
    controller.activityChanged(
      activity.idle && bootstraps.every((backend) => activity.backendIds.has(backend.id)),
    );
  }, [activity, bootstraps]);
  return null;
}

export function DesktopUpdateInstallCoordinator() {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const update = useDesktopUpdateState();
  useEffect(() => {
    if (update) controller.updateChanged(update);
  }, [update]);
  useEffect(() => () => controller.dispose(), []);

  if (state.status === "idle") return null;
  const queued = state.status === "queued";
  const installing = state.status === "installing";
  const releaseUrl = getDesktopUpdateReleaseUrl(state.target.downloadedVersion);
  const canInstall = update?.enabled && resolveDesktopUpdateButtonAction(update) === "install";

  return (
    <>
      {queued ? <QueuedRestartActivity /> : null}
      <section
        aria-label="Desktop update"
        className="fixed right-4 bottom-4 z-50 w-fit max-w-[calc(100vw-2rem)] rounded-xl border bg-popover p-4 text-sm text-popover-foreground shadow-xl"
      >
        {!installing ? (
          <Button
            aria-label={queued ? "Cancel queued restart and dismiss update" : "Dismiss update"}
            className="absolute -top-2 -left-2 size-5 rounded-full border bg-popover"
            size="icon-xs"
            variant="outline"
            onClick={controller.cancel}
          >
            <XIcon className="size-3" />
          </Button>
        ) : null}
        <div role="status" aria-live="polite">
          <p className="font-medium">
            {installing
              ? "Restarting to update…"
              : queued
                ? "Restart queued"
                : "New update available"}
          </p>
          {queued ? (
            <p className="mt-1 max-w-sm text-xs text-muted-foreground">
              Waiting for agents to finish. Keep the app open.
            </p>
          ) : null}
        </div>
        {!installing ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {releaseUrl ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void openDesktopUpdateReleaseNotes(window.desktopBridge, releaseUrl);
                }}
              >
                See changes
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!queued && !canInstall}
              onClick={queued ? controller.cancelRestart : controller.queue}
            >
              {queued ? "Cancel restart" : "Restart when idle"}
            </Button>
            <Button size="sm" disabled={!canInstall} onClick={controller.restartNow}>
              Restart
            </Button>
          </div>
        ) : null}
      </section>
    </>
  );
}
