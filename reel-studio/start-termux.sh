#!/data/data/com.termux/files/usr/bin/sh
# Android (Termux): run the server on the phone itself. Chromium isn't available in Termux,
# so videos are rendered by your phone's Chrome tab (WebCodecs) and saved by the server.
cd "$(dirname "$0")"
command -v node >/dev/null || pkg install -y nodejs-lts
command -v ffmpeg >/dev/null || pkg install -y ffmpeg
[ -d node_modules ] || PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=optional --omit=dev
termux-open-url http://127.0.0.1:4301/ 2>/dev/null &
exec node server.mjs
