# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-05-09

### Added

- Initial release.
- Two MCP tools: `ssh_list_hosts`, `ssh_exec`.
- Streamable HTTP transport with bearer-token auth.
- Per-host modes: `trusted` (blacklist only) and `restricted` (whitelist + blacklist).
- Built-in catastrophic-action blacklist (rm -rf /, mkfs on real devices, dd to real devices, redirects to real devices, shred, fork bombs).
- 256 KB output truncation per stream.
- Configurable per-host SSH timeout (default 30s).
- JSON-line audit log (`exec_request`, `exec_blocked`, `exec_completed`, `exec_failed`, `auth_failed`, `list_hosts`).
- Multi-stage Dockerfile, non-root container user, healthcheck.
- `setup-target-host.sh` script for provisioning targets with hardened `authorized_keys` (`from=` IP pin, `no-port-forwarding`, `no-agent-forwarding`, `no-X11-forwarding`, `no-user-rc`, `no-pty`).
