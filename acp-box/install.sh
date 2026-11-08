#!/usr/bin/env bash
# Installs the box as a service on a Linux machine with systemd and Node.js 22 or newer (a home server, or a free
# cloud VM). The box dials out to the resident, so nothing is opened to the outside and no tunnel is needed.
#
#   sudo ./install.sh --resident https://your-worker.workers.dev --code ABCD-EFGH
#   sudo ./install.sh --uninstall
#
# The helpers' keys stay on this machine, in /etc/aelios-box/env (mode 0600, read by the service only):
#   KIRO_API_KEY=ksk_…                   for the kiro plug (needs IPv4 egress, and `kiro-cli` installed)
#   CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat…  for the claude plug (from `claude setup-token`; works IPv6-only)
# Pass them as environment variables of this command, or edit the file afterwards and `systemctl restart aelios-box`.
# Run it again any time to update: the pairing and the keys are kept.
set -euo pipefail

resident=""
code=""
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --resident) resident="${2:-}"; shift ;;
    --code) code="${2:-}"; shift ;;
    --uninstall) uninstall=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "unknown option: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done
[ "$(id -u)" = 0 ] || { echo "run it with sudo" >&2; exit 1; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
unit=/etc/systemd/system/aelios-box.service
home=/var/lib/aelios-box
conf=/etc/aelios-box

if [ "$uninstall" = 1 ]; then
  systemctl disable --now aelios-box 2>/dev/null || true
  rm -rf "$unit" /opt/aelios-box "$home" "$conf"
  userdel aelios-box 2>/dev/null || true
  systemctl daemon-reload
  echo "aelios-box: removed (revoke the box on the settings page too)"
  exit 0
fi

node="$(command -v node || true)"
if [ -z "$node" ] || ! "$node" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
  echo "Node.js 22 or newer is needed: install it, then run this again" >&2
  exit 1
fi
npm="$(dirname "$node")/npm"

id aelios-box >/dev/null 2>&1 || useradd --system --create-home --home-dir "$home" --shell /usr/sbin/nologin aelios-box
install -d -m 755 /opt/aelios-box
cp -r "$here"/*.mjs "$here"/claude "$here"/plugs "$here"/package.json "$here"/package-lock.json /opt/aelios-box/
(cd /opt/aelios-box && PATH="$(dirname "$node"):$PATH" "$npm" ci --no-audit --no-fund --loglevel=error)

# The keys: kept if the file is there, otherwise made from the environment of this command.
install -d -m 755 "$conf"
if [ ! -f "$conf/env" ]; then
  install -m 600 /dev/null "$conf/env"
  [ -z "${KIRO_API_KEY:-}" ] || printf 'KIRO_API_KEY=%s\n' "$KIRO_API_KEY" >> "$conf/env"
  [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] || printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_CODE_OAUTH_TOKEN" >> "$conf/env"
fi
chown root:root "$conf/env"

# Pairing, once: the code is traded for this box's own token, kept in the service's home.
if [ -n "$resident" ] && [ -n "$code" ]; then
  (cd /opt/aelios-box && sudo -u aelios-box env AELIOS_BOX_HOME="$home/config" "$node" main.mjs --resident "$resident" --code "$code" --pair-only)
elif [ ! -f "$home/config/box.json" ]; then
  echo "pair it first: sudo ./install.sh --resident <address> --code <pairing code>" >&2
  exit 1
fi

cat > "$unit" <<EOF
# Made by Aelios-resident acp-box/install.sh
[Unit]
Description=Aelios box
After=network-online.target
Wants=network-online.target

[Service]
User=aelios-box
WorkingDirectory=/opt/aelios-box
Environment=AELIOS_BOX_HOME=$home/config
EnvironmentFile=-$conf/env
ExecStart=$node main.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now aelios-box
systemctl restart aelios-box
echo "aelios-box: running; the settings page lists it once it connects (journalctl -u aelios-box -f)"
