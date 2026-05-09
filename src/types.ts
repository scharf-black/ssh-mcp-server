export type HostMode = "trusted" | "restricted";

export interface HostConfig {
  name: string;
  address: string;
  description: string;
  mode?: HostMode;
  user?: string;
  port?: number;
  privateKeyPath?: string;
  timeoutMs?: number;
  whitelist?: string[];
}

export interface DefaultsConfig {
  user: string;
  port: number;
  privateKeyPath: string;
  timeoutMs: number;
  blacklist: string[];
}

export interface ServerConfig {
  defaults: DefaultsConfig;
  hosts: HostConfig[];
}

export interface ResolvedHost {
  name: string;
  address: string;
  description: string;
  mode: HostMode;
  user: string;
  port: number;
  privateKeyPath: string;
  timeoutMs: number;
  whitelistPatterns: RegExp[];
  blacklistPatterns: RegExp[];
}

export interface ExecResult {
  host: string;
  command: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export class CommandRejectedError extends Error {
  constructor(public readonly reason: string, public readonly pattern?: string) {
    super(reason);
    this.name = "CommandRejectedError";
  }
}
