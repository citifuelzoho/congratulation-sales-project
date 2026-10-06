#!/bin/sh
# Deploy on a Linux server: run `sh deploy.sh` from this folder (again after every update).
# Installs Node.js if missing, runs server.js as a service that restarts on crash and reboot,
# opens the port in the firewall and checks that the server answers.
set -eu

APP=sales-celebration
cd "$(dirname "$0")"
DIR=$(pwd)

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

# Root needs no sudo; everyone else uses sudo when it exists.
if [ "$(id -u)" -eq 0 ]; then SUDO=""
elif command -v sudo >/dev/null 2>&1; then SUDO="sudo"
else SUDO="none"; fi

# 1. Settings
if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  die "Created .env from .env.example. Set WEBHOOK_SECRET in .env, then run 'sh deploy.sh' again."
fi
PORT=$(sed -n 's/^[[:space:]]*PORT[[:space:]]*=[[:space:]]*\([0-9]*\).*/\1/p' .env | tail -n 1)
PORT=${PORT:-4000}
SECRET=$(sed -n 's/^[[:space:]]*WEBHOOK_SECRET[[:space:]]*=[[:space:]]*//p' .env | tail -n 1 | tr -d '\r')
case "$SECRET" in ""|change-me*) die "Set WEBHOOK_SECRET in .env to a long random word first.";; esac

# 2. Node.js 18 or newer
node_ok() {
  command -v node >/dev/null 2>&1 &&
    [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]
}
if ! node_ok; then
  say "Installing Node.js 20"
  [ "$SUDO" = "none" ] && die "Node.js 18+ is missing and there is no sudo. Install Node.js 18+ and run again."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    $SUDO apt-get install -y ca-certificates curl
    curl -fsSL https://deb.nodesource.com/setup_20.x | $SUDO bash -
    $SUDO apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | $SUDO bash -
    if command -v dnf >/dev/null 2>&1; then $SUDO dnf install -y nodejs; else $SUDO yum install -y nodejs; fi
  else
    die "Could not install Node.js automatically. Install Node.js 18+ and run again."
  fi
  node_ok || die "Node.js install failed."
fi
NODE=$(command -v node)
say "Using Node.js $(node -v) at $NODE"

# 3. Run as a service
stop_background() {
  if [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null; then
    kill "$(cat server.pid)" && sleep 1
  fi
  rm -f server.pid
}

if [ "$SUDO" != "none" ] && [ -d /run/systemd/system ]; then
  say "Installing systemd service '$APP'"
  stop_background   # an older 'nohup' copy would hold the port
  $SUDO tee /etc/systemd/system/$APP.service >/dev/null <<EOF
[Unit]
Description=Sales celebration display
After=network-online.target
Wants=network-online.target

[Service]
User=$(id -un)
WorkingDirectory=$DIR
ExecStart=$NODE $DIR/server.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable $APP >/dev/null 2>&1
  $SUDO systemctl restart $APP
  MODE=systemd
else
  say "No systemd or sudo: running in the background with nohup (will not survive a reboot)"
  stop_background
  nohup "$NODE" server.js >> server.log 2>&1 &
  echo $! > server.pid
  MODE=nohup
fi

# 4. Firewall
if [ "$SUDO" != "none" ]; then
  if command -v ufw >/dev/null 2>&1 && $SUDO ufw status 2>/dev/null | grep -q "Status: active"; then
    say "Opening port $PORT in ufw"
    $SUDO ufw allow "$PORT"/tcp >/dev/null
  elif command -v firewall-cmd >/dev/null 2>&1 && $SUDO firewall-cmd --state >/dev/null 2>&1; then
    say "Opening port $PORT in firewalld"
    $SUDO firewall-cmd --permanent --add-port="$PORT"/tcp >/dev/null
    $SUDO firewall-cmd --reload >/dev/null
  fi
fi

# 5. Check it answers
say "Checking http://localhost:$PORT/"
i=0
until curl -fsS -o /dev/null "http://localhost:$PORT/" 2>/dev/null; do
  i=$((i + 1))
  if [ $i -ge 10 ]; then
    if [ "$MODE" = systemd ]; then $SUDO journalctl -u $APP -n 30 --no-pager || true
    else tail -n 30 server.log || true; fi
    die "Server did not start on port $PORT (log above)."
  fi
  sleep 1
done
if [ "$MODE" = systemd ]; then
  $SUDO systemctl is-active --quiet $APP || die "Service '$APP' is not running."
else
  kill -0 "$(cat server.pid)" 2>/dev/null || die "Server exited; another program may be using port $PORT. See server.log."
fi

IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
IP=${IP:-YOUR-SERVER-IP}
say "Deployed"
echo "  Display:  http://$IP:$PORT/"
echo "  Webhook:  POST http://$IP:$PORT/webhook?secret=$SECRET"
if [ "$MODE" = systemd ]; then
  echo "  Logs:     sudo journalctl -u $APP -f"
  echo "  Restart:  sudo systemctl restart $APP"
else
  echo "  Logs:     tail -f $DIR/server.log"
  echo "  Stop:     kill \$(cat $DIR/server.pid)"
fi
