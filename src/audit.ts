import { appendFileSync } from "node:fs";

export interface AuditEvent {
  timestamp: string;
  event: "exec_request" | "exec_blocked" | "exec_completed" | "exec_failed" | "list_hosts" | "auth_failed";
  host?: string;
  command?: string;
  reason?: string;
  pattern?: string;
  exitCode?: number | null;
  durationMs?: number;
  remoteAddr?: string;
  userAgent?: string;
}

export class AuditLogger {
  constructor(private readonly logPath: string | null) {}

  log(event: Omit<AuditEvent, "timestamp">): void {
    const entry: AuditEvent = {
      timestamp: new Date().toISOString(),
      ...event,
    };
    const line = JSON.stringify(entry);

    // Always emit to stderr so `docker logs` captures it
    console.error(line);

    if (this.logPath) {
      try {
        appendFileSync(this.logPath, line + "\n", "utf8");
      } catch (err) {
        console.error(
          JSON.stringify({
            timestamp: new Date().toISOString(),
            event: "audit_write_failed",
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    }
  }
}
