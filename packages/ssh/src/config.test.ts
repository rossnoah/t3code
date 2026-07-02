import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  discoverSshHosts,
  parseKnownHostsHostnames,
  resolveSshConfigIncludePattern,
} from "./config.ts";

function makeTempHomeDir() {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.makeTempDirectoryScoped({ prefix: "t3-ssh-test-" });
  });
}

const writeSshFile = (relativePath: string, lines: ReadonlyArray<string>, homeDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(homeDir, ".ssh", relativePath);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, [...lines, ""].join("\n"));
  });

describe("ssh config", () => {
  it.effect("discovers ssh config hosts across included files", () =>
    Effect.gen(function* () {
      const homeDir = yield* makeTempHomeDir();
      yield* writeSshFile(
        "config",
        [
          "Host devbox",
          "  HostName devbox.example.com",
          "Host=equalsbox",
          "Include=config.d/*.conf",
        ],
        homeDir,
      );
      yield* writeSshFile(
        "config.d/team.conf",
        ["Host staging", "  HostName staging.example.com", "Host *", "  ServerAliveInterval 30"],
        homeDir,
      );
      yield* writeSshFile(
        "known_hosts",
        [
          "known.example.com ssh-ed25519 AAAA",
          "|1|hashed|entry ssh-ed25519 AAAA",
          "[bastion.example.com]:2222 ssh-ed25519 AAAA",
        ],
        homeDir,
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      // ssh-config hosts list before known_hosts entries.
      assert.deepEqual(hosts, [
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "equalsbox",
          hostname: "equalsbox",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "staging",
          hostname: "staging.example.com",
          username: null,
          port: null,
          source: "ssh-config",
        },
        {
          alias: "bastion.example.com",
          hostname: "bastion.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: null,
          port: null,
          source: "known-hosts",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("resolves hostname, user, and port with first-obtained-value semantics", () =>
    Effect.gen(function* () {
      const homeDir = yield* makeTempHomeDir();
      yield* writeSshFile(
        "config",
        [
          "Host *.internal !secret.internal",
          "  User deploy",
          "  Port 2222",
          "Host web1.internal",
          "  HostName 10.0.0.5",
          "  Port 2200 # first obtained value (2222) must win",
          "Host secret.internal",
          "  HostName vault.example.com",
          "Host quoted",
          '  HostName "quoted.example.com"',
          '  User "svc user"',
          "Host *",
          "  User fallback",
        ],
        homeDir,
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "quoted",
          hostname: "quoted.example.com",
          username: "svc user",
          port: null,
          source: "ssh-config",
        },
        {
          alias: "secret.internal",
          hostname: "vault.example.com",
          username: "fallback",
          port: null,
          source: "ssh-config",
        },
        {
          alias: "web1.internal",
          hostname: "10.0.0.5",
          username: "deploy",
          port: 2222,
          source: "ssh-config",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("applies global directives, Match sections, and %h expansion", () =>
    Effect.gen(function* () {
      const homeDir = yield* makeTempHomeDir();
      yield* writeSshFile(
        "config",
        [
          "Port 2022",
          "Host devbox",
          "  HostName %h.example.com",
          "  Port 22",
          "Match host ignored",
          "  User leaked",
          "Match all",
          "  User everyone",
          "Host devbox2",
          "  Port not-a-port",
        ],
        homeDir,
      );

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "everyone",
          // The pre-Host global Port comes first, so it wins over the block value.
          port: 2022,
          source: "ssh-config",
        },
        {
          alias: "devbox2",
          hostname: "devbox2",
          username: "everyone",
          port: 2022,
          source: "ssh-config",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("applies wildcard host sections to known_hosts entries", () =>
    Effect.gen(function* () {
      const homeDir = yield* makeTempHomeDir();
      yield* writeSshFile("config", ["Host *.example.com", "  User admin"], homeDir);
      yield* writeSshFile("known_hosts", ["known.example.com ssh-ed25519 AAAA"], homeDir);

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "known.example.com",
          hostname: "known.example.com",
          username: "admin",
          port: null,
          source: "known-hosts",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("continues the active host section across include boundaries", () =>
    Effect.gen(function* () {
      const homeDir = yield* makeTempHomeDir();
      yield* writeSshFile(
        "config",
        ["Host spliced", "Include config.d/spliced.conf", "  Port 2222"],
        homeDir,
      );
      yield* writeSshFile("config.d/spliced.conf", ["  HostName spliced.example.com"], homeDir);

      const hosts = yield* discoverSshHosts({ homeDir });
      assert.deepEqual(hosts, [
        {
          alias: "spliced",
          hostname: "spliced.example.com",
          username: null,
          port: 2222,
          source: "ssh-config",
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("parses known_hosts entries without returning hashed hosts", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseKnownHostsHostnames(
          [
            "github.com ssh-ed25519 AAAA",
            "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
            "|1|hashed|entry ssh-ed25519 CCCC",
            "@cert-authority *.example.com ssh-ed25519 DDDD",
            "[ssh.example.com]:2200 ssh-ed25519 EEEE",
            "port.example.com:22 ssh-ed25519 HHHH",
            "::1 ssh-ed25519 FFFF",
            "2001:db8::1 ssh-ed25519 GGGG",
            "",
          ].join("\n"),
        ),
        [
          "::1",
          "2001:db8::1",
          "github.com",
          "gitlab-alias",
          "gitlab.com",
          "port.example.com",
          "ssh.example.com",
        ],
      );
    }),
  );

  it.effect("expands tilde-prefixed ssh config include patterns", () =>
    Effect.gen(function* () {
      const pattern = yield* resolveSshConfigIncludePattern(
        "~/.ssh/config.d/*.conf",
        "/tmp/project",
        "/tmp/home",
      );
      assert.equal(pattern, "/tmp/home/.ssh/config.d/*.conf");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
