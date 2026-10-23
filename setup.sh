#!/bin/sh
# Swing Desk Agent - first-time setup (Mac / Linux). Run: ./setup.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed yet. It is free: https://nodejs.org (install version 24), then run ./setup.sh again."
  exit 1
fi
exec node bin/desk.js setup
