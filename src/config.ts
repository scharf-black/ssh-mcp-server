import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import {
  ServerConfig,
  HostConfig,
  ResolvedHost,
  DefaultsConfig,
  HostMode,
} from "./types.js";

const DEFAULT_DEFAULTS: DefaultsConfig = {
  user: "claude-ops",
  port: 22,
  privateKeyPath: "/secrets/id_ed25519",
  timeoutMs: 30000,
  blacklist: [
    // Catastrophic-only. The conversational layer is the primary defense; this
    // is a last-resort guard against unrecoverable typos and injection attacks.
    "rm\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\s+/(\\s|\\*|$)",       // rm -rf /
    "rm\\s+-[a-zA-Z]*[rR][a-zA-Z]*\\s+\\$\\{?\\w*\\}?/",   // rm -rf $var/  (var may be unset)
    "mkfs(\\.\\w+)?\\s+(-\\S+\\s+)*/dev/(sd|nvme|vd|hd)",  // format real disk
    "\\bdd\\b[^|]*\\bof=/dev/(sd|nvme|vd|hd)",             // dd to real disk
    ">\\s*/dev/(sd|nvme|vd|hd)\\w*\\b",                    // redirect into real disk
    "\\bshred\\b\\s+(\\S+\\s+)*/dev/",                     // shred a device
    ":\\s*\\(\\s*\\)\\s*\\{[^}]*:\\s*\\|\\s*:",            // fork bomb
  ],
};

function compilePattern(pattern: string): RegExp {
  return new RegExp(pattern);
}

function resolveHost(
  host: HostConfig,
  defaults: DefaultsConfig,
): ResolvedHost {
  const mode: HostMode = host.mode ?? "restricted";
  const whitelist = host.whitelist ?? [];

  if (mode === "restricted" && whitelist.length === 0) {
    throw new Error(
      `Host '${host.name}' is in 'restricted' mode but has no whitelist. ` +
        `Either add a whitelist or set 'mode: trusted'.`,
    );
  }

  return {
    name: host.name,
    address: host.address,
    description: host.description,
    mode,
    user: host.user ?? defaults.user,
    port: host.port ?? defaults.port,
    privateKeyPath: host.privateKeyPath ?? defaults.privateKeyPath,
    timeoutMs: host.timeoutMs ?? defaults.timeoutMs,
    whitelistPatterns: whitelist.map(compilePattern),
    blacklistPatterns: defaults.blacklist.map(compilePattern),
  };
}

export function loadConfig(path: string): Map<string, ResolvedHost> {
  const raw = readFileSync(path, "utf8");
  const parsed = parseYaml(raw) as ServerConfig;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Invalid config at ${path}: not an object`);
  }

  const defaults: DefaultsConfig = {
    ...DEFAULT_DEFAULTS,
    ...(parsed.defaults ?? {}),
    blacklist: [
      ...DEFAULT_DEFAULTS.blacklist,
      ...(parsed.defaults?.blacklist ?? []),
    ],
  };

  if (!Array.isArray(parsed.hosts) || parsed.hosts.length === 0) {
    throw new Error(`Invalid config at ${path}: 'hosts' must be a non-empty array`);
  }

  const resolved = new Map<string, ResolvedHost>();
  for (const host of parsed.hosts) {
    if (!host.name || !host.address) {
      throw new Error(`Invalid host entry: missing 'name' or 'address'`);
    }
    if (resolved.has(host.name)) {
      throw new Error(`Duplicate host name: ${host.name}`);
    }
    resolved.set(host.name, resolveHost(host, defaults));
  }

  return resolved;
}
