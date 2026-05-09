import { readFileSync } from "node:fs";
import { Client } from "ssh2";
import {
  ResolvedHost,
  ExecResult,
  CommandRejectedError,
} from "./types.js";

const MAX_OUTPUT_BYTES = 256 * 1024;

export function checkCommand(
  host: ResolvedHost,
  command: string,
): { allowed: true } | { allowed: false; reason: string; pattern?: string } {
  const trimmed = command.trim();

  if (trimmed.length === 0) {
    return { allowed: false, reason: "Empty command" };
  }

  // Catastrophic blacklist applies to ALL hosts, including trusted.
  for (const pattern of host.blacklistPatterns) {
    if (pattern.test(trimmed)) {
      return {
        allowed: false,
        reason: `Command matches catastrophic-action blacklist`,
        pattern: pattern.source,
      };
    }
  }

  // Trusted hosts skip the whitelist gate.
  if (host.mode === "trusted") {
    return { allowed: true };
  }

  // Restricted hosts must match at least one whitelist entry.
  for (const pattern of host.whitelistPatterns) {
    if (pattern.test(trimmed)) {
      return { allowed: true };
    }
  }

  return {
    allowed: false,
    reason: `Command does not match any whitelist pattern for host '${host.name}'`,
  };
}

function truncate(buf: Buffer): { text: string; truncated: boolean } {
  if (buf.length <= MAX_OUTPUT_BYTES) {
    return { text: buf.toString("utf8"), truncated: false };
  }
  const head = buf.subarray(0, MAX_OUTPUT_BYTES).toString("utf8");
  return {
    text: `${head}\n\n[...output truncated at ${MAX_OUTPUT_BYTES} bytes; ${
      buf.length - MAX_OUTPUT_BYTES
    } more bytes suppressed]`,
    truncated: true,
  };
}

export async function execOnHost(
  host: ResolvedHost,
  command: string,
): Promise<ExecResult> {
  const check = checkCommand(host, command);
  if (!check.allowed) {
    throw new CommandRejectedError(check.reason, check.pattern);
  }

  let privateKey: Buffer;
  try {
    privateKey = readFileSync(host.privateKeyPath);
  } catch (err) {
    throw new Error(
      `Failed to read SSH private key at ${host.privateKeyPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return new Promise<ExecResult>((resolve, reject) => {
    const conn = new Client();
    const start = Date.now();
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let timer: NodeJS.Timeout | null = null;
    let settled = false;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      try {
        conn.end();
      } catch {
        // ignore
      }
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    conn.on("ready", () => {
      conn.exec(command, { pty: false }, (err, stream) => {
        if (err) {
          settle(() => reject(err));
          return;
        }

        let exitCode: number | null = null;
        let signal: string | null = null;

        stream
          .on("close", () => {
            const stdoutBuf = Buffer.concat(stdoutChunks);
            const stderrBuf = Buffer.concat(stderrChunks);
            const out = truncate(stdoutBuf);
            const errOut = truncate(stderrBuf);
            settle(() =>
              resolve({
                host: host.name,
                command,
                exitCode,
                signal,
                stdout: out.text,
                stderr: errOut.text,
                durationMs: Date.now() - start,
                truncated: out.truncated || errOut.truncated,
              }),
            );
          })
          .on("exit", (code: number | null, sig: string | null) => {
            exitCode = code;
            signal = sig;
          });

        stream.on("data", (chunk: Buffer) => {
          if (Buffer.concat(stdoutChunks).length < MAX_OUTPUT_BYTES * 2) {
            stdoutChunks.push(chunk);
          }
        });
        stream.stderr.on("data", (chunk: Buffer) => {
          if (Buffer.concat(stderrChunks).length < MAX_OUTPUT_BYTES * 2) {
            stderrChunks.push(chunk);
          }
        });
      });
    });

    conn.on("error", (err) => {
      settle(() => reject(err));
    });

    timer = setTimeout(() => {
      settle(() =>
        reject(new Error(`SSH command timed out after ${host.timeoutMs}ms`)),
      );
    }, host.timeoutMs);

    conn.connect({
      host: host.address,
      port: host.port,
      username: host.user,
      privateKey,
      readyTimeout: Math.min(host.timeoutMs, 10000),
      keepaliveInterval: 5000,
    });
  });
}
