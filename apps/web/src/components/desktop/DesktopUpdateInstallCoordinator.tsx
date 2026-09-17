import { useAtomValue } from "@effect/atom-react";
import { useEffect, useSyncExternalStore } from "react";

import {
  desktopRestartActivityAtom,
  desktopUpdateInstallController as controller,
} from "../../state/desktopUpdateInstall";
import { useDesktopUpdateState } from "../../state/desktopUpdate";
import { useDesktopLocalBootstraps } from "../../connection/useDesktopLocalBootstraps";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";

function QueuedRestart() {
  const activity = useAtomValue(desktopRestartActivityAtom);
  const bootstraps = useDesktopLocalBootstraps();
  useEffect(() => {
    controller.activityChanged(
      activity.idle && bootstraps.every((backend) => activity.backendIds.has(backend.id)),
    );
  }, [activity, bootstraps]);

  return (
    <div
      className="fixed bottom-4 left-1/2 z-50 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-xl border bg-popover px-4 py-3 text-sm text-popover-foreground shadow-lg"
      role="status"
    >
      <span>Update queued. Waiting for agents to finish. Keep the app open.</span>
      <Button size="sm" variant="outline" onClick={controller.cancel}>
        Cancel restart
      </Button>
    </div>
  );
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

  return (
    <>
      <AlertDialog
        open={state.status === "prompt"}
        onOpenChange={(open) => {
          if (!open) controller.cancel();
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Restart to install update
              {state.status !== "idle" ? ` ${state.target.downloadedVersion}` : ""}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Restart now interrupts running agents. A queued restart waits for all agents hosted by
              this desktop app to finish. Terminal commands may be interrupted by either option.
              Keep the app open for a queued restart.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="outline" onClick={controller.restartNow}>
              Restart now
            </Button>
            <Button onClick={controller.queue}>Restart when agents finish</Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {state.status === "queued" ? <QueuedRestart /> : null}
    </>
  );
}
