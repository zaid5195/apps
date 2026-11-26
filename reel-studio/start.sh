#!/usr/bin/env sh
# macOS / Linux launcher: first run installs everything, then opens the browser.
cd "$(dirname "$0")"
[ -d node_modules ] || npm run setup || exit 1
( sleep 1.5; (command -v xdg-open >/dev/null && xdg-open http://127.0.0.1:4301/) || (command -v open >/dev/null && open http://127.0.0.1:4301/) ) >/dev/null 2>&1 &
exec node server.mjs
