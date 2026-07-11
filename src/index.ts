import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { execOnHost, checkCommand } from "./ssh.js";
import { AuditLogger } from "./audit.js";
import { CommandRejectedError, ResolvedHost } from "./types.js";

const CONFIG_PATH = process.env.CONFIG_PATH ?? "/config/hosts.yaml";
const AUDIT_LOG_PATH = process.env.AUDIT_LOG_PATH ?? "/data/audit.log";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const PORT = parseInt(process.env.PORT ?? "3000", 10);
const BIND = process.env.BIND ?? "0.0.0.0";

if (!AUTH_TOKEN || AUTH_TOKEN.length < 16) {
  console.error(
    "FATAL: MCP_AUTH_TOKEN env var must be set to a value of 16+ characters.",
  );
  process.exit(1);
}

const hosts = loadConfig(CONFIG_PATH);
const audit = new AuditLogger(AUDIT_LOG_PATH);

console.error(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "startup",
    hostCount: hosts.size,
    hosts: [...hosts.keys()],
    configPath: CONFIG_PATH,
    auditLogPath: AUDIT_LOG_PATH,
  }),
);

function buildServer(): McpServer {
  const server = new McpServer({
    name: "ssh-mcp-server",
    version: "0.1.0",
  });

  const ListHostsInput = z.object({}).strict();

  server.registerTool(
    "ssh_list_hosts",
    {
      title: "List configured SSH hosts",
      description: `List all hosts the server is configured to connect to.

Returns each host's name, address, role/description, mode (trusted or restricted), the SSH user, and the command-pattern whitelist that applies in restricted mode. Call this first to discover which hosts exist and what kinds of commands are permitted on each.

Returns:
  {
    "hosts": [
      {
        "name": string,                  // Logical name to pass to ssh_exec
        "address": string,               // IP or hostname
        "description": string,           // Role / what runs there
        "mode": "trusted" | "restricted",
        "user": string,                  // SSH user this server connects as
        "whitelist": string[]            // Regex patterns of allowed commands (empty in trusted mode)
      }
    ]
  }`,
      inputSchema: ListHostsInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async () => {
      audit.log({ event: "list_hosts" });
      const list = [...hosts.values()].map((h: ResolvedHost) => ({
        name: h.name,
        address: h.address,
        description: h.description,
        mode: h.mode,
        user: h.user,
        whitelist: h.whitelistPatterns.map((p) => p.source),
      }));
      const output = { hosts: list };
      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    },
  );

  const ExecInput = z.object({
    host: z
      .string()
      .min(1)
      .describe("Logical host name as returned by ssh_list_hosts."),
    command: z
      .string()
      .min(1)
      .max(32000)   // NOT 2000: real agent commands (multi-line scripts, heredocs) routinely exceed 2k. The deployed image already used 32000; the repo had regressed to 2000.
      .describe(
        "Shell command to execute on the host. In restricted mode, must match the host's whitelist; in trusted mode, anything goes except patterns matching the global catastrophic-action blacklist. Run on a non-interactive PTY-less shell.",
      ),
  }).strict();

  server.registerTool(
    "ssh_exec",
    {
      title: "Execute a command on a configured SSH host",
      description: `Run a single shell command on a configured host via SSH and return stdout, stderr, and exit code.

The command is checked against:
  - A global catastrophic-action blacklist (rm -rf /, mkfs on real devices, dd to real devices, fork bombs, etc.) which always applies.
  - In 'restricted' mode: a per-host regex whitelist. The command must match at least one entry.
  - In 'trusted' mode: no whitelist gate; only the blacklist applies.

If rejected, the call returns an error and is logged as 'exec_blocked'.

Returns:
  {
    "host": string,
    "command": string,
    "exitCode": number | null,         // null if killed by signal
    "signal": string | null,
    "stdout": string,                  // Truncated at 256 KB
    "stderr": string,                  // Truncated at 256 KB
    "durationMs": number,
    "truncated": boolean
  }

Examples:
  - { host: "web-server", command: "df -h" }
  - { host: "db-server", command: "systemctl status postgresql" }
  - { host: "jump-host", command: "docker ps" }`,
      inputSchema: ExecInput.shape,
      annotations: {
        readOnlyHint: false, // command-dependent; safer to mark false
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ host: hostName, command }) => {
      const host = hosts.get(hostName);
      if (!host) {
        const available = [...hosts.keys()].join(", ");
        return {
          content: [
            {
              type: "text",
              text: `Error: Unknown host '${hostName}'. Available hosts: ${available}`,
            },
          ],
          isError: true,
        };
      }

      audit.log({
        event: "exec_request",
        host: host.name,
        command,
      });

      const check = checkCommand(host, command);
      if (!check.allowed) {
        audit.log({
          event: "exec_blocked",
          host: host.name,
          command,
          reason: check.reason,
          pattern: check.pattern,
        });
        return {
          content: [
            {
              type: "text",
              text: `Error: Command rejected. ${check.reason}${
                check.pattern ? ` (pattern: ${check.pattern})` : ""
              }`,
            },
          ],
          isError: true,
        };
      }

      try {
        const result = await execOnHost(host, command);
        audit.log({
          event: "exec_completed",
          host: host.name,
          command,
          exitCode: result.exitCode,
          durationMs: result.durationMs,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        audit.log({
          event: "exec_failed",
          host: host.name,
          command,
          reason,
        });
        if (err instanceof CommandRejectedError) {
          return {
            content: [{ type: "text", text: `Error: ${reason}` }],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `SSH error: ${reason}` }],
          isError: true,
        };
      }
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Bearer-token auth on /mcp
const authMiddleware = (req: Request, res: Response, next: NextFunction) => {
  const header = req.header("authorization") ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (
    header.length !== expected.length ||
    !cryptoSafeEqual(header, expected)
  ) {
    audit.log({
      event: "auth_failed",
      remoteAddr: req.ip,
      userAgent: req.header("user-agent"),
    });
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
};

function cryptoSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

app.get("/healthz", (_req, res) => {
  res.json({ status: "ok", hosts: hosts.size });
});

app.post("/mcp", authMiddleware, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => transport.close());
  const server = buildServer();
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, BIND, () => {
  console.error(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      event: "listening",
      bind: BIND,
      port: PORT,
      path: "/mcp",
    }),
  );
});
