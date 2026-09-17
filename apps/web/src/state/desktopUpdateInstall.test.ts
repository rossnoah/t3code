import {
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type EnvironmentPresentation,
} from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createDesktopRestartActivityAtom } from "./desktopUpdateInstall";

const PRIMARY = EnvironmentId.make("primary-env");
const WSL = EnvironmentId.make("wsl-env");
const REMOTE = EnvironmentId.make("remote-env");

function shell(status: EnvironmentShellState["status"]): EnvironmentShellState {
  return {
    status,
    error: Option.none(),
    snapshot:
      status === "empty"
        ? Option.none()
        : Option.some({
            snapshotSequence: 1,
            updatedAt: "2026-09-15T00:00:00Z",
            projects: [],
            threads: [],
          }),
  };
}

function setup() {
  const entries: EnvironmentCatalogState["entries"] = new Map(
    [PRIMARY, WSL, REMOTE].map((environmentId) => [
      environmentId,
      {
        target:
          environmentId === PRIMARY
            ? new PrimaryConnectionTarget({
                environmentId,
                label: "Desktop",
                httpBaseUrl: "http://localhost:3000",
                wsBaseUrl: "ws://localhost:3000",
              })
            : new BearerConnectionTarget({
                environmentId,
                label: environmentId,
                connectionId: environmentId === WSL ? "local:wsl:Ubuntu" : "remote",
              }),
        profile: Option.none(),
        enabled: true,
      },
    ]),
  );
  const catalog = Atom.make<EnvironmentCatalogState>({ isReady: true, entries });
  const presentations = Atom.make<ReadonlyMap<EnvironmentId, EnvironmentPresentation>>(
    new Map(
      [...entries].map(([id, entry]) => [
        id,
        {
          entry,
          connection: { phase: "connected" as const, error: null, traceId: null },
          serverConfig: null,
        },
      ]),
    ),
  );
  const shells = Atom.family((_id: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(shell("live")),
  );
  const activity = createDesktopRestartActivityAtom({
    catalogValueAtom: catalog,
    presentationsAtom: presentations,
    shellStateValueAtom: shells,
  });
  const registry = AtomRegistry.make();
  return { catalog, presentations, shells, activity, registry };
}

describe("desktop restart environment activity", () => {
  it("includes primary and WSL backends and ignores unrelated remote environments", () => {
    const h = setup();
    h.registry.set(h.shells(REMOTE), shell("empty"));
    expect(h.registry.get(h.activity)).toEqual({
      idle: true,
      backendIds: new Set(["primary", "wsl:Ubuntu"]),
    });
    h.registry.dispose();
  });

  it.each(["empty", "cached", "synchronizing"] as const)(
    "waits for a %s WSL snapshot",
    (status) => {
      const h = setup();
      h.registry.set(h.shells(WSL), shell(status));
      expect(h.registry.get(h.activity).idle).toBe(false);
      h.registry.set(h.shells(WSL), shell("live"));
      expect(h.registry.get(h.activity).idle).toBe(true);
      h.registry.dispose();
    },
  );

  it("does not use an idle snapshot from a disconnected backend", () => {
    const h = setup();
    const presentations = new Map(h.registry.get(h.presentations));
    const wsl = presentations.get(WSL)!;
    presentations.set(WSL, {
      ...wsl,
      connection: { phase: "reconnecting", error: null, traceId: null },
    });
    h.registry.set(h.presentations, presentations);
    expect(h.registry.get(h.activity).idle).toBe(false);
    h.registry.dispose();
  });

  it("waits for initial catalog discovery", () => {
    const h = setup();
    h.registry.set(h.catalog, { ...h.registry.get(h.catalog), isReady: false });
    expect(h.registry.get(h.activity).idle).toBe(false);
    h.registry.dispose();
  });
});
