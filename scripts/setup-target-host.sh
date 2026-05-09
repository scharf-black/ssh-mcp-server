#!/usr/bin/env bash
# setup-target-host.sh
#
# Run this on each target host ONCE to provision the claude-ops user with
# hardened SSH access for ssh-mcp-server.
#
# Usage:
#   sudo ./setup-target-host.sh <pubkey-file> <mcp-host-ip>
#
# Example:
#   sudo ./setup-target-host.sh /tmp/id_ed25519.pub 10.0.0.100
#
# The <mcp-host-ip> is the IP of the host running the MCP container. It's
# pinned via the from= clause in authorized_keys so the key is useless from
# anywhere else even if it leaks.

set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <pubkey-file> <mcp-host-ip>" >&2
  exit 1
fi

PUBKEY_FILE="$1"
MCP_HOST_IP="$2"
USERNAME="${SSH_MCP_USER:-claude-ops}"

if [[ ! -f "$PUBKEY_FILE" ]]; then
  echo "Public key file not found: $PUBKEY_FILE" >&2
  exit 1
fi

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (or via sudo)" >&2
  exit 1
fi

if ! id -u "$USERNAME" >/dev/null 2>&1; then
  useradd -m -s /bin/bash "$USERNAME"
  passwd -l "$USERNAME"
  echo "Created user $USERNAME with locked password"
else
  echo "User $USERNAME already exists; reusing"
fi

USER_HOME=$(getent passwd "$USERNAME" | cut -d: -f6)
SSH_DIR="$USER_HOME/.ssh"
AUTH_KEYS="$SSH_DIR/authorized_keys"

install -d -m 700 -o "$USERNAME" -g "$USERNAME" "$SSH_DIR"

PUBKEY=$(<"$PUBKEY_FILE")

RESTRICTIONS="from=\"${MCP_HOST_IP}\",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-user-rc,no-pty"
LINE="${RESTRICTIONS} ${PUBKEY}"

if [[ -f "$AUTH_KEYS" ]] && grep -qF "$PUBKEY" "$AUTH_KEYS"; then
  echo "Public key already authorized; updating restrictions"
  grep -vF "$PUBKEY" "$AUTH_KEYS" > "$AUTH_KEYS.tmp" || true
  mv "$AUTH_KEYS.tmp" "$AUTH_KEYS"
fi

echo "$LINE" >> "$AUTH_KEYS"
chown "$USERNAME:$USERNAME" "$AUTH_KEYS"
chmod 600 "$AUTH_KEYS"

echo
echo "Done. Test from the MCP host with:"
echo "  ssh -i /path/to/private/key ${USERNAME}@$(hostname -I | awk '{print $1}') uptime"
