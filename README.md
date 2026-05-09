# ssh-mcp-server

A [Model Context Protocol](https://modelcontextprotocol.io) server that exposes scoped, audited SSH access to remote hosts. Stream over HTTP, sit behind an MCP gateway, and any MCP-compatible client (Claude, etc.) gets the same SSH tools — no per-device setup.

## What it does

Two tools:

- `ssh_list_hosts` — returns the configured inventory of hosts.
- `ssh_exec` — runs a single shell command on a host. Returns structured `{stdout, stderr, exitCode, signal, durationMs, truncated}`. Output truncated at 256 KB per stream. Hard timeout per host.

## Security model

**Layered defense, configurable per host.**

### Per-host modes

- **`mode: trusted`** — any command runs except those matching the catastrophic-action blacklist. Use when the LLM client is a trusted operator and you want full operational power (git, kubectl, docker, file edits, sudo, etc.).
- **`mode: restricted`** — must match a regex whitelist *and* not match the blacklist. Use for VLAN-segmented or third-party hosts where you want a tight audit boundary.

### Catastrophic-action blacklist (always applied)

Hard-blocked at the MCP layer before SSH connects. Cannot be removed; only added to via config.

- `rm -rf /` and obvious variants (`-fr`, `-rfv`, `rm -rf /*`, `rm -rf $UNSET_VAR/`)
- `mkfs` on `/dev/sd*`, `/dev/nvme*`, `/dev/vd*`, `/dev/hd*`
- `dd of=/dev/sd*` (and other real devices)
- Redirect (`>`) into `/dev/sd*` etc.
- `shred /dev/*`
- Fork bombs (`:(){ :|:& };:`)

33 unit-test cases cover both true positives and false positives like `rm -rf /tmp/foo`, `dd of=/tmp/x`, `mkfs.ext4 /tmp/loop.img` (all correctly allowed).

### Other defenses

- **Bearer token** at HTTP layer (`MCP_AUTH_TOKEN`, 16+ chars; 32-hex recommended).
- **Dedicated SSH key** mounted read-only into the container.
- **`from=` clause** on every `authorized_keys` entry — pin the key to your MCP host's IP.
- **`no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc,no-pty`** restrictions on every key (set by `setup-target-host.sh`).
- **JSON-line audit log** of every request, block, completion, and auth failure to `/data/audit.log` and stderr.
- **Non-root container user** (`app`, uid 100, gid 101).

## Quick start

```bash
git clone https://github.com/scharf-black/ssh-mcp-server.git
cd ssh-mcp-server

# 1. Generate a dedicated SSH key for the MCP server
mkdir -p secrets data config
ssh-keygen -t ed25519 -N '' -f secrets/id_ed25519 -C "ssh-mcp-server@$(hostname)"

# 2. Provision each target host (run on the target, not here)
#    Copy secrets/id_ed25519.pub to the target first.
sudo bash scripts/setup-target-host.sh /tmp/id_ed25519.pub <your-mcp-host-ip>

# 3. Configure your inventory
cp config/hosts.example.yaml config/hosts.yaml
# Edit config/hosts.yaml with your hosts.

# 4. Set the auth token
echo "MCP_AUTH_TOKEN=$(openssl rand -hex 32)" > .env

# 5. Bring it up
docker compose up -d --build
docker compose logs -f
```

You should see a startup line listing the configured hosts.

## Configuration

### `config/hosts.yaml`

```yaml
defaults:
  user: claude-ops
  port: 22
  privateKeyPath: /secrets/id_ed25519
  timeoutMs: 30000
  blacklist:
    # Add your own host-agnostic deny patterns here. Built-ins already cover
    # destructive verbs.
    - "/etc/(passwd|shadow|sudoers)"

hosts:
  - name: web-server
    address: 10.0.0.10
    user: ops
    mode: trusted
    description: Production web tier (nginx + node)

  - name: jump-host
    address: 10.0.0.5
    mode: restricted
    description: VLAN jump host with read-only access
    whitelist:
      - "^ls( |$)"
      - "^cat\\s+/var/log/"
      - "^journalctl\\b"
      - "^systemctl\\s+status\\b"
```

See [`config/hosts.example.yaml`](config/hosts.example.yaml) for a fuller example.

### Environment variables

| Var | Default | Notes |
|-----|---------|-------|
| `MCP_AUTH_TOKEN` | (required) | 16+ char bearer token |
| `PORT` | `3000` | HTTP listen port |
| `BIND` | `0.0.0.0` | HTTP listen address |
| `CONFIG_PATH` | `/config/hosts.yaml` | Inventory path |
| `AUDIT_LOG_PATH` | `/data/audit.log` | JSON-line audit log |

## Verify it's running

```bash
# Healthcheck
curl http://localhost:3000/healthz
# -> {"status":"ok","hosts":2}

# tools/list
TOKEN=$(grep MCP_AUTH_TOKEN .env | cut -d= -f2)
curl -X POST http://localhost:3000/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

## Connecting from a client

Any MCP-compatible client supporting Streamable HTTP transport works. Configure with:

- **URL**: `http://<mcp-host>:3000/mcp`
- **Auth header**: `Authorization: Bearer <token>`

## Adding a host

1. Append to `config/hosts.yaml`.
2. Copy `secrets/id_ed25519.pub` to the new target.
3. Run `setup-target-host.sh` on the target.
4. `docker compose restart`.
5. Verify via `ssh_list_hosts` then a smoke `ssh_exec`.

## Audit log

Every request, block, completion, and auth failure appended as one JSON object per line to `/data/audit.log`. Tail or ship to your log stack:

```bash
tail -f data/audit.log | jq
```

Event types:

- `list_hosts`
- `exec_request`
- `exec_blocked` (with `reason` and `pattern`)
- `exec_completed` (with `exitCode` and `durationMs`)
- `exec_failed` (with `reason`)
- `auth_failed` (with `remoteAddr` and `userAgent`)

## Things that are deliberately not features

- No file upload/download (use `scp` from a shell if you need it).
- No persistent shell sessions (each call is a one-shot exec).
- No password auth (key only).
- No interactive PTY (commands must be non-interactive).
- No automatic install of binaries on the target.

## Architecture

```
MCP client
    ↓  (HTTPS, optional gateway in between)
ssh-mcp-server (this project)
    ↓  (ssh2 with mounted key)
    ├── host A (trusted mode)
    ├── host B (trusted mode)
    └── host C (restricted mode + whitelist)
```

## Development

```bash
npm install
npm run typecheck
npm run build
npm run dev   # tsx watch
```

Requires Node ≥ 20.

## License

MIT — see [LICENSE](LICENSE).
