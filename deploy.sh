#!/bin/sh
# Deploy on a Linux server: run `sh deploy.sh` from this folder (again after every update).
# Installs Node.js and PM2 if missing, runs server.js under PM2 (restarts on crash and reboot),
# opens the port in the firewall and checks that the server answers.
set -eu

APP=sales-celebration
cd "$(dirname "$0")"

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

# 3. Run under PM2
if ! command -v pm2 >/dev/null 2>&1; then
  say "Installing PM2"
  npm install -g pm2 >/dev/null 2>&1 || {
    [ "$SUDO" = "none" ] && die "Could not install PM2 and there is no sudo. Run 'npm install -g pm2' and run again."
    $SUDO npm install -g pm2
  }
  command -v pm2 >/dev/null 2>&1 || die "PM2 install failed."
fi
PM2=$(command -v pm2)

# Copies started by older versions of this script would hold the port.
if [ -f server.pid ]; then
  kill "$(cat server.pid)" 2>/dev/null && sleep 1 || true
  rm -f server.pid
fi
if [ "$SUDO" != "none" ] && [ -f /etc/systemd/system/$APP.service ]; then
  say "Removing the old systemd service '$APP' (PM2 runs the app now)"
  $SUDO systemctl disable --now $APP >/dev/null 2>&1 || true
  $SUDO rm -f /etc/systemd/system/$APP.service
  $SUDO systemctl daemon-reload
fi

say "Starting '$APP' with PM2"
"$PM2" startOrRestart ecosystem.config.js --update-env
"$PM2" save >/dev/null

# Bring PM2 (and the saved app) back after a reboot.
if [ "$SUDO" = "none" ]; then
  echo "No sudo: the app will not start again after a reboot. Run 'pm2 startup' as root to fix that."
elif ! $SUDO env PATH="$PATH" "$PM2" startup -u "$(id -un)" --hp "$HOME" >/dev/null 2>&1; then
  echo "Could not enable start on boot. Run 'pm2 startup' and the command it prints."
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
    "$PM2" logs $APP --lines 30 --nostream || true
    die "Server did not start on port $PORT (log above)."
  fi
  sleep 1
done
PID=$("$PM2" pid $APP 2>/dev/null || true)
case "$PID" in ""|0) die "'$APP' is not running under PM2; another program may be using port $PORT. See 'pm2 logs $APP'.";; esac

IP=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}')
IP=${IP:-YOUR-SERVER-IP}
say "Deployed"
echo "  Display:  http://$IP:$PORT/"
echo "  Webhook:  POST http://$IP:$PORT/webhook?secret=$SECRET"
echo "  Logs:     pm2 logs $APP"
echo "  Restart:  pm2 restart $APP"
echo "  Status:   pm2 status"
