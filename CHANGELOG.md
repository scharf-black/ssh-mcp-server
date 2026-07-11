# Changelog

## 0.2.0 — 2026-07-11
Reconciled the repo with what was actually running in production. The deployed image and
this repo had drifted **in both directions**; 4 of 5 compiled modules (`types`, `audit`,
`config`, `ssh`) were byte-identical, and only `index` differed.

- **FIX (regression): `ssh_exec` command limit 2000 -> 32000 chars.** The repo capped
  commands at 2000; the deployed image used 32000. Real agent commands (multi-line
  scripts, heredocs, inline python) routinely exceed 2k, so building from the repo as-is
  would have started rejecting normal work. 32000 is now the source of truth.
- **KEPT from the repo (absent in the deployed image):** `mode` (`trusted` | `restricted`)
  is surfaced in `ssh_list_hosts` output, and the tool descriptions accurately document
  trusted vs restricted semantics (trusted skips the whitelist gate; the catastrophic
  blacklist always applies).
- Server identifies as `ssh-mcp-server` (the deployed image self-identified as
  `homelab-ssh-mcp-server`; cosmetic only).

Provenance note: the deployed image was built ad-hoc on unraid and its build context was
never persisted, so the repo had silently stopped matching production. Rebuild from THIS
repo from now on.

## 0.1.0 — 2026-05-09
Initial commit.
