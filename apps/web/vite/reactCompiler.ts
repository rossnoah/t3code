// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - Build-time cache; no Effect runtime is available.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import babel from "@rolldown/plugin-babel";
import { reactCompilerPreset } from "@vitejs/plugin-react";

type CompilerResult = { code: string; map: string | null };
// Named explicitly so declaration emit never has to reference rolldown's package path.
type BabelPlugin = Awaited<ReturnType<typeof babel>>;

export function compilerCacheKey(inputs: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
}

/** Cache only Babel's code and source map, before bundling or release-version substitution. */
export function createCompilerCache(directory: string) {
  let hits = 0;
  let misses = 0;
  const ready = NodeFSP.mkdir(directory, { recursive: true }).catch(() => undefined);
  return {
    stats: () => ({ hits, misses }),
    async transform(key: string, compile: () => Promise<CompilerResult | undefined>) {
      await ready;
      const file = NodePath.join(directory, `${key}.json`);
      try {
        const cached: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
        if (
          cached !== null &&
          typeof cached === "object" &&
          "code" in cached &&
          typeof cached.code === "string" &&
          "map" in cached &&
          (cached.map === null || typeof cached.map === "string")
        ) {
          hits++;
          return { code: cached.code, map: cached.map };
        }
      } catch {
        // Missing, incomplete or unreadable cache entries fall back to compilation.
      }
      misses++;
      const result = await compile();
      if (result) await NodeFSP.writeFile(file, JSON.stringify(result)).catch(() => undefined);
      return result;
    },
  };
}

export async function reactCompilerPlugin(
  cacheDirectory?: string,
): Promise<BabelPlugin | BabelPlugin[]> {
  const plugin = await babel({
    // Workspace packages live outside the web cwd; parse their TS/JSX explicitly.
    parserOpts: { plugins: ["typescript", "jsx"] },
    presets: [reactCompilerPreset()],
  });
  if (!cacheDirectory || !plugin.transform || typeof plugin.transform === "function") return plugin;

  // Include the compiler configuration, dependency lock and this adapter. Source
  // maps contain absolute paths, so individual keys also include the full module id.
  const inputs = await Promise.all([
    NodeFSP.readFile(new URL("../../../pnpm-lock.yaml", import.meta.url), "utf8"),
    NodeFSP.readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    NodeFSP.readFile(new URL("./reactCompiler.ts", import.meta.url), "utf8"),
  ]);
  const namespace = compilerCacheKey([
    ...inputs,
    process.version,
    process.env.NODE_ENV ?? "",
    process.env.BABEL_ENV ?? "",
  ]);
  const cache = createCompilerCache(NodePath.join(cacheDirectory, namespace));
  const transform = plugin.transform.handler;
  plugin.transform.handler = async function (code, id, options) {
    const key = compilerCacheKey([code, id, options?.moduleType ?? "js"]);
    return cache.transform(key, async () => {
      const result = await transform.call(this, code, id, options);
      if (!result || typeof result !== "object" || typeof result.code !== "string")
        return undefined;
      return {
        code: result.code,
        map:
          result.map == null
            ? null
            : typeof result.map === "string"
              ? result.map
              : JSON.stringify(result.map),
      };
    });
  };
  return [
    plugin,
    {
      name: "t3code:react-compiler-cache-stats",
      closeBundle() {
        const { hits, misses } = cache.stats();
        console.log(`[react-compiler-cache] ${hits} hits, ${misses} misses`);
      },
    },
  ];
}
