import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback } from "react";

import { readLocalApi } from "~/localApi";
import { assetEnvironment } from "~/state/assets";
import { usePreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";

import { createBrowserFileUrl } from "./openFileInPreview";

export const isHtmlFile = (path: string): boolean => /\.html?$/i.test(path);

/** Opens on the client machine, even when the file belongs to a remote environment. */
export function useOpenFileInDefaultBrowser(
  threadRef: ScopedThreadRef | undefined,
  workspaceRoot: string | undefined,
) {
  const connection = usePreparedConnection(threadRef?.environmentId ?? null);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });
  return useCallback(
    async (filePath: string) => {
      try {
        if (!threadRef || connection._tag === "None") {
          throw new Error("Environment is not connected.");
        }
        const api = readLocalApi();
        if (!api) throw new Error("Link opening is unavailable.");
        const result = await createBrowserFileUrl({
          threadRef,
          filePath,
          workspaceRoot,
          httpBaseUrl: connection.value.httpBaseUrl,
          createAssetUrl,
        });
        if (result._tag === "Failure") return result;
        await api.shell.openExternal(result.value);
        return AsyncResult.success(undefined);
      } catch (cause) {
        return AsyncResult.failure(Cause.die(cause));
      }
    },
    [connection, createAssetUrl, threadRef, workspaceRoot],
  );
}
