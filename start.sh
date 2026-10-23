#!/bin/sh
# Swing Desk Agent - start the app and open it in your browser (Mac / Linux). Run: ./start.sh
# Keep this terminal open while you use the app. Press Ctrl + C to stop.
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Run ./setup.sh first."
  exit 1
fi
exec node bin/desk.js start --open
