import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, DesktopUpdateState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { desktopLocalBackendId } from "../connection/desktopLocal";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { toastManager } from "../components/ui/toast";
import { environmentPresentations } from "./presentation";
import { environmentShell } from "./shell";
import {
  createDesktopUpdateInstallController,
  isThreadBlockingDesktopRestart,
} from "./desktopUpdateInstallController";

export function createDesktopRestartActivityAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly presentationsAtom: Atom.Atom<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>;
  readonly shellStateValueAtom: (id: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  return Atom.make((get) => {
    const catalog = get(input.catalogValueAtom);
    const presentations = get(input.presentationsAtom);
    const backendIds = new Set<string>();
    let idle = catalog.isReady;
    for (const [environmentId, entry] of catalog.entries) {
      const backendId =
        entry.target._tag === "PrimaryConnectionTarget"
          ? "primary"
          : desktopLocalBackendId(entry.target);
      if (backendId === null) continue;
      backendIds.add(backendId);
      const shell = get(input.shellStateValueAtom(environmentId));
      if (
        presentations.get(environmentId)?.connection.phase !== "connected" ||
        shell.status !== "live" ||
        Option.isNone(shell.snapshot)
      ) {
        idle = false;
        continue;
      }
      if (shell.snapshot.value.threads.some(isThreadBlockingDesktopRestart)) idle = false;
    }
    return { idle, backendIds };
  }).pipe(Atom.withLabel("desktop:restart-activity"));
}

export const desktopRestartActivityAtom = createDesktopRestartActivityAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  presentationsAtom: environmentPresentations.presentationsAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});

function canRestartDesktop(): boolean {
  const activity = appAtomRegistry.get(desktopRestartActivityAtom);
  const bridge = window.desktopBridge;
  if (!bridge || !activity.idle) return false;
  try {
    // Include backends which have not reached the connection catalog yet.
    const backends = bridge.getLocalEnvironmentBootstraps();
    return backends.length > 0 && backends.every((backend) => activity.backendIds.has(backend.id));
  } catch {
    return false;
  }
}

export const desktopUpdateInstallController = createDesktopUpdateInstallController({
  getUpdateState: () => {
    if (!window.desktopBridge) return Promise.reject(new Error("Desktop updates are unavailable."));
    return window.desktopBridge.getUpdateState();
  },
  installUpdate: () => {
    if (!window.desktopBridge) return Promise.reject(new Error("Desktop updates are unavailable."));
    return window.desktopBridge.installUpdate();
  },
  canRestart: canRestartDesktop,
  onError: (description) =>
    toastManager.add({ type: "error", title: "Could not restart for update", description }),
});

export function requestDesktopUpdateInstall(state: DesktopUpdateState): void {
  desktopUpdateInstallController.request(state);
}
