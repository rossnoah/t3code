import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";

import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { SshHostDiscoveryError } from "./errors.ts";

const NO_HOSTS: ReadonlyArray<string> = [] as const;

function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return (hashIndex >= 0 ? line.slice(0, hashIndex) : line).trim();
}

function splitDirectiveArgs(value: string): ReadonlyArray<string> {
  // ssh_config tokens are separated by whitespace or `=`; double quotes group
  // a token that contains separators (e.g. `User "svc user"`).
  const args: Array<string> = [];
  let current = "";
  let inQuotes = false;
  const flush = () => {
    if (current.length > 0) {
      args.push(current);
    }
    current = "";
  };
  for (const char of value) {
    if (inQuotes) {
      if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === " " || char === "\t" || char === "=") {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return args;
}

function expandHomePath(input: string, homeDir: string): string {
  return input.replace(/^~(?=$|\/|\\)/u, homeDir);
}

export const resolveSshConfigIncludePattern = Effect.fnUntraced(function* (
  includePattern: string,
  _directory: string,
  homeDir: string,
) {
  const path = yield* Path.Path;
  const expandedPattern = expandHomePath(includePattern, homeDir);
  return path.isAbsolute(expandedPattern)
    ? expandedPattern
    : path.resolve(path.join(homeDir, ".ssh"), expandedPattern);
});

function hasSshPattern(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.startsWith("!");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${escapeRegex(pattern).replace(/\\\*/gu, ".*").replace(/\\\?/gu, ".")}$`,
    "u",
  );
}

const expandGlob = Effect.fnUntraced(function* (pattern: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return (yield* fs.exists(pattern)) ? [pattern] : NO_HOSTS;
  }

  const directory = path.dirname(pattern);
  const basePattern = path.basename(pattern);
  if (!(yield* fs.exists(directory))) {
    return NO_HOSTS;
  }

  const matcher = globToRegExp(basePattern);
  const entries = yield* fs.readDirectory(directory);
  const matchedPaths: string[] = [];
  for (const entry of entries) {
    if (!matcher.test(entry)) {
      continue;
    }
    const entryPath = path.join(directory, entry);
    if (yield* fs.exists(entryPath)) {
      matchedPaths.push(entryPath);
    }
  }
  return matchedPaths.toSorted((left, right) => left.localeCompare(right));
});

interface SshConfigHostValues {
  hostname?: string;
  username?: string;
  port?: number;
}

/**
 * One `Host` (or unconditional `Match all`) section of an ssh config, in the
 * order it was encountered across the root file and every spliced `Include`.
 */
export interface SshConfigHostBlock {
  readonly patterns: ReadonlyArray<string>;
  readonly values: SshConfigHostValues;
}

interface SshConfigParseState {
  readonly blocks: Array<SshConfigHostBlock>;
  current: SshConfigHostBlock | null;
  readonly visited: Set<string>;
}

function makeSshConfigParseState(): SshConfigParseState {
  // Directives that appear before the first Host/Match section apply to every
  // host, and, per ssh_config first-obtained-value semantics, win over later
  // sections — modeled as an implicit leading `Host *` block.
  const globalBlock: SshConfigHostBlock = { patterns: ["*"], values: {} };
  return { blocks: [globalBlock], current: globalBlock, visited: new Set<string>() };
}

function parseSshPort(raw: string): number | undefined {
  if (!/^\d+$/u.test(raw)) {
    return undefined;
  }
  const port = Number.parseInt(raw, 10);
  return port >= 1 && port <= 65535 ? port : undefined;
}

const parseSshConfigFile = Effect.fnUntraced(function* (
  filePath: string,
  state: SshConfigParseState,
  homeDir: string,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedPath = path.resolve(filePath);
  if (state.visited.has(resolvedPath) || !(yield* fs.exists(resolvedPath))) {
    return;
  }
  state.visited.add(resolvedPath);

  const directory = path.dirname(resolvedPath);
  const raw = yield* fs.readFileString(resolvedPath);

  for (const line of raw.split(/\r?\n/u)) {
    const stripped = stripInlineComment(line);
    if (stripped.length === 0) {
      continue;
    }

    const [directive = "", ...rawArgs] = splitDirectiveArgs(stripped);
    switch (directive.toLowerCase()) {
      case "include": {
        // Included lines splice into the current section, so parsing shares
        // one state across files and `state.current` carries over.
        for (const includePattern of rawArgs) {
          const resolvedPattern = yield* resolveSshConfigIncludePattern(
            includePattern,
            directory,
            homeDir,
          );
          for (const includedPath of yield* expandGlob(resolvedPattern)) {
            yield* parseSshConfigFile(includedPath, state, homeDir);
          }
        }
        break;
      }
      case "host": {
        const block: SshConfigHostBlock = { patterns: rawArgs, values: {} };
        state.blocks.push(block);
        state.current = block;
        break;
      }
      case "match": {
        // `Match all` is unconditional; every other Match criterion depends
        // on runtime state we cannot evaluate, so its section is skipped.
        if (rawArgs.length > 0 && rawArgs.every((entry) => entry.toLowerCase() === "all")) {
          const block: SshConfigHostBlock = { patterns: ["*"], values: {} };
          state.blocks.push(block);
          state.current = block;
        } else {
          state.current = null;
        }
        break;
      }
      case "hostname": {
        const [value] = rawArgs;
        if (state.current !== null && value !== undefined) {
          state.current.values.hostname ??= value;
        }
        break;
      }
      case "user": {
        const [value] = rawArgs;
        if (state.current !== null && value !== undefined) {
          state.current.values.username ??= value;
        }
        break;
      }
      case "port": {
        const [value] = rawArgs;
        if (state.current !== null && value !== undefined) {
          const port = parseSshPort(value);
          if (port !== undefined) {
            state.current.values.port ??= port;
          }
        }
        break;
      }
      default:
        break;
    }
  }
});

function matchesSshHostPattern(host: string, pattern: string): boolean {
  return globToRegExp(pattern.toLowerCase()).test(host.toLowerCase());
}

function blockAppliesToHost(host: string, patterns: ReadonlyArray<string>): boolean {
  let matched = false;
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      if (pattern.length > 1 && matchesSshHostPattern(host, pattern.slice(1))) {
        return false;
      }
      continue;
    }
    if (!matched && matchesSshHostPattern(host, pattern)) {
      matched = true;
    }
  }
  return matched;
}

function expandSshHostnameTokens(value: string, host: string): string {
  return value.replace(/%[%h]/gu, (token) => (token === "%%" ? "%" : host));
}

export function resolveSshConfigHost(
  host: string,
  blocks: ReadonlyArray<SshConfigHostBlock>,
): Pick<DesktopDiscoveredSshHost, "hostname" | "username" | "port"> {
  let hostname: string | undefined;
  let username: string | undefined;
  let port: number | undefined;
  for (const block of blocks) {
    if (!blockAppliesToHost(host, block.patterns)) {
      continue;
    }
    hostname ??= block.values.hostname;
    username ??= block.values.username;
    port ??= block.values.port;
  }
  return {
    hostname: hostname === undefined ? host : expandSshHostnameTokens(hostname, host),
    username: username ?? null,
    port: port ?? null,
  };
}

export const collectSshConfigHostBlocks = Effect.fnUntraced(function* (
  filePath: string,
  homeDir: string,
): Effect.fn.Return<
  ReadonlyArray<SshConfigHostBlock>,
  PlatformError.PlatformError,
  FileSystem.FileSystem | Path.Path
> {
  const state = makeSshConfigParseState();
  yield* parseSshConfigFile(filePath, state, homeDir);
  return state.blocks;
});

function collectConcreteHostAliases(
  blocks: ReadonlyArray<SshConfigHostBlock>,
): ReadonlyArray<string> {
  const aliases = new Set<string>();
  for (const block of blocks) {
    for (const pattern of block.patterns) {
      if (!hasSshPattern(pattern)) {
        aliases.add(pattern);
      }
    }
  }
  return [...aliases].toSorted((left, right) => left.localeCompare(right));
}

function normalizeKnownHostsHostname(rawHost: string): string {
  const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(rawHost);
  if (bracketMatch?.[1]) {
    return bracketMatch[1];
  }

  if (!rawHost.includes(":")) {
    return rawHost;
  }

  const firstColonIndex = rawHost.indexOf(":");
  const lastColonIndex = rawHost.lastIndexOf(":");
  return firstColonIndex === lastColonIndex ? rawHost.slice(0, lastColonIndex) : rawHost;
}

export function parseKnownHostsHostnames(raw: string): ReadonlyArray<string> {
  const hostnames = new Set<string>();

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const withoutMarker = trimmed.startsWith("@")
      ? trimmed.split(/\s+/u).slice(1).join(" ")
      : trimmed;
    const [hostField = ""] = withoutMarker.split(/\s+/u);
    if (hostField.length === 0 || hostField.startsWith("|")) {
      continue;
    }

    for (const rawHost of hostField.split(",")) {
      const host = normalizeKnownHostsHostname(rawHost).trim();
      if (host.length === 0 || hasSshPattern(host)) {
        continue;
      }
      hostnames.add(host);
    }
  }

  return [...hostnames].toSorted((left, right) => left.localeCompare(right));
}

const readKnownHostsHostnames = Effect.fnUntraced(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(filePath))) {
    return NO_HOSTS;
  }
  return parseKnownHostsHostnames(yield* fs.readFileString(filePath));
});

export const discoverSshHosts = Effect.fnUntraced(
  function* (input: { readonly homeDir?: string }) {
    const path = yield* Path.Path;
    const env = yield* Config.all({
      home: Config.string("HOME").pipe(Config.option),
      userProfile: Config.string("USERPROFILE").pipe(Config.option),
    });
    const homeDir =
      input?.homeDir ??
      Option.getOrUndefined(env.home) ??
      Option.getOrUndefined(env.userProfile) ??
      "";
    if (homeDir.trim().length === 0) {
      return [];
    }

    const sshDirectory = path.join(homeDir, ".ssh");
    const blocks = yield* collectSshConfigHostBlocks(path.join(sshDirectory, "config"), homeDir);
    const configAliases = collectConcreteHostAliases(blocks);
    const knownHosts = yield* readKnownHostsHostnames(path.join(sshDirectory, "known_hosts"));
    const discovered = new Map<string, DesktopDiscoveredSshHost>();

    for (const alias of configAliases) {
      discovered.set(alias, {
        alias,
        ...resolveSshConfigHost(alias, blocks),
        source: "ssh-config",
      });
    }

    for (const hostname of knownHosts) {
      if (discovered.has(hostname)) {
        continue;
      }
      // Wildcard Host sections (e.g. `Host *`) still apply to hosts that are
      // only present in known_hosts, exactly as ssh itself would resolve them.
      discovered.set(hostname, {
        alias: hostname,
        ...resolveSshConfigHost(hostname, blocks),
        source: "known-hosts",
      });
    }

    // Named ssh-config hosts are what users reach for; raw known_hosts
    // entries (mostly bare IPs) sort after them.
    return [...discovered.values()].toSorted((left, right) =>
      left.source === right.source
        ? left.alias.localeCompare(right.alias)
        : left.source === "ssh-config"
          ? -1
          : 1,
    );
  },
  Effect.mapError(
    (cause) =>
      new SshHostDiscoveryError({
        message: "Failed to discover SSH hosts.",
        cause,
      }),
  ),
);
