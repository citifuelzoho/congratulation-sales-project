#!/bin/sh
cd "$(dirname "$0")"
[ -f .env ] || cp .env.example .env
( sleep 1; (xdg-open http://localhost:3000 || open http://localhost:3000) >/dev/null 2>&1 ) &
node server.js
