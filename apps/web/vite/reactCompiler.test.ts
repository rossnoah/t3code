// @effect-diagnostics nodeBuiltinImport:off - Exercises the build-time filesystem cache without an Effect runtime.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { compilerCacheKey, createCompilerCache } from "./reactCompiler";

const directories: string[] = [];
async function fixture() {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-compiler-cache-"));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

it("reuses code and source maps across separate builds", async () => {
  const directory = await fixture();
  const key = compilerCacheKey(["export const App = () => <p />", "/repo/App.tsx", "tsx"]);
  const result = {
    code: "compiled code",
    map: JSON.stringify({ version: 3, sources: ["App.tsx"], mappings: "AAAA" }),
  };
  await createCompilerCache(directory).transform(key, async () => result);
  const warm = createCompilerCache(directory);
  expect(
    await warm.transform(key, async () => {
      throw new Error("must not recompile");
    }),
  ).toEqual(result);
  expect(warm.stats()).toEqual({ hits: 1, misses: 0 });
});

it("recompiles when source, module path, syntax or compiler namespace changes", async () => {
  const directory = await fixture();
  const original = ["source", "/repo/App.tsx", "tsx", "compiler-v1"];
  const cache = createCompilerCache(directory);
  await cache.transform(compilerCacheKey(original), async () => ({ code: "old", map: null }));
  for (const index of [0, 1, 2, 3]) {
    const changed = [...original];
    changed[index] += "-changed";
    const result = { code: `new-${index}`, map: null };
    expect(await cache.transform(compilerCacheKey(changed), async () => result)).toEqual(result);
  }
  expect(cache.stats()).toEqual({ hits: 0, misses: 5 });
});

it.each(["{incomplete", '{"code":42,"map":null}'])(
  "rebuilds corrupt entries: %s",
  async (contents) => {
    const directory = await fixture();
    const key = compilerCacheKey(["source"]);
    await NodeFSP.writeFile(NodePath.join(directory, `${key}.json`), contents);
    const result = { code: "rebuilt", map: null };
    expect(await createCompilerCache(directory).transform(key, async () => result)).toEqual(result);
  },
);

it("builds normally when cache storage is unavailable", async () => {
  const directory = await fixture();
  const file = NodePath.join(directory, "not-a-directory");
  await NodeFSP.writeFile(file, "occupied");
  const result = { code: "compiled", map: null };
  expect(await createCompilerCache(file).transform("key", async () => result)).toEqual(result);
});

it("propagates compilation failures and retries them on the next build", async () => {
  const cache = createCompilerCache(await fixture());
  await expect(
    cache.transform("key", async () => {
      throw new Error("syntax error");
    }),
  ).rejects.toThrow("syntax error");
  expect(await cache.transform("key", async () => ({ code: "fixed", map: null }))).toEqual({
    code: "fixed",
    map: null,
  });
});
