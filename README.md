# YT → YouTube Music Sync

> **macOS only** · Tampermonkey + Go · No third-party dependencies

Automatically **pauses** your YouTube Music desktop app the moment a YouTube video starts playing in Chrome, and **resumes** it the moment you pause or stop the video. Works across multiple YouTube tabs — Music stays paused as long as *any* tab is playing.

```
YouTube video plays  →  YT Music pauses  ✓
YouTube video pauses →  YT Music resumes ✓
Two tabs open?       →  Music stays paused until both stop ✓
```

---

## How it works

Three pieces work together:

| File | Role |
|---|---|
| `main.go` | Tiny Go HTTP server (`127.0.0.1:8765`). Receives `/pause` and `/resume` calls and controls YT Music via AppleScript / System Events. |
| `yt-music-sync.user.js` | Tampermonkey userscript. Watches every `<video>` element on `youtube.com` and calls the bridge when playback changes. |
| `com.user.ytmsync.plist` | macOS LaunchAgent. Keeps the Go server running silently in the background, auto-starting at login. |

---

## Requirements

- macOS (Ventura 13+ recommended)
- [Go 1.21+](https://go.dev/dl/) — only needed to build the binary once
- Google Chrome
- [Tampermonkey](https://www.tampermonkey.net/) extension
- A YouTube Music desktop app (see [Supported apps](#supported-apps) below)

---

## Installation

### Step 1 — Clone and build

```bash
git clone https://github.com/rohanjadhavhub/Auto-playpause-server.git
cd Auto-playpause-server

go build -ldflags="-s -w" -o yt-music-bridge main.go
```

Verify the build:

```bash
./yt-music-bridge --help   # should print usage / start the server
```

### Step 2 — Find your app name

The bridge needs to know the exact name macOS uses for your YouTube Music app.
Run this to check:

```bash
ls /Applications ~/Applications | grep -i music
```

Common names:

| App | `YTM_APP_NAME` value |
|---|---|
| Safari Web App (most common) | `YT Music` |
| Electron wrapper | `YouTube Music` |
| YouTube Music Desktop App | `Youtube Music Desktop App` |

Quick sanity-check:

```bash
osascript -e 'tell application "YT Music" to activate'
```

If the app comes to the front without an error, the name is correct.

### Step 3 — Grant Accessibility permission

The bridge sends keystrokes to YT Music via System Events, which requires
Accessibility access:

1. **System Settings → Privacy & Security → Accessibility**
2. Click **+** and add the compiled `yt-music-bridge` binary
3. Toggle it **on**

> **Why?** Most YouTube Music apps don't have a full AppleScript dictionary,
> so the bridge falls back to sending a Space keystroke (the universal
> play/pause shortcut). System Events needs Accessibility permission to do this.

Without this step `/pause` and `/resume` will fail with a `500` error.

### Step 4 — Install the Tampermonkey userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/) in Chrome
2. Click the Tampermonkey icon → **Create a new script**
3. Delete the boilerplate and paste the full contents of `yt-music-sync.user.js`
4. Save (`Cmd+S`)
5. Confirm it appears as **enabled** in the Tampermonkey dashboard under `https://www.youtube.com/*`

### Step 5 — Test manually

Start the bridge in one terminal:

```bash
YTM_APP_NAME="YT Music" ./yt-music-bridge
# yt-music-bridge listening on http://127.0.0.1:8765 (target app: "YT Music")
```

In another terminal, fire test requests:

```bash
curl -X GET  http://127.0.0.1:8765/health   # → {"status":"ok"}
curl -X POST http://127.0.0.1:8765/pause    # YT Music should pause
curl -X POST http://127.0.0.1:8765/resume   # YT Music should resume
```

Then open YouTube in Chrome, play a video, and watch YT Music react.

### Step 6 — Run headlessly at login (LaunchAgent)

Edit `com.user.ytmsync.plist` — update the two paths to match where you cloned the repo and set your app name:

```xml
<!-- Line 22: absolute path to your binary -->
<string>/Users/YOUR_USERNAME/Auto-playpause-server/yt-music-bridge</string>

<!-- Line 37: same directory -->
<string>/Users/YOUR_USERNAME/Auto-playpause-server</string>

<!-- Line 47: your app name from Step 2 -->
<string>YT Music</string>
```

Then install:

```bash
cp com.user.ytmsync.plist ~/Library/LaunchAgents/com.user.ytmsync.plist
launchctl load ~/Library/LaunchAgents/com.user.ytmsync.plist
```

Verify it's running:

```bash
launchctl list | grep com.user.ytmsync   # PID should appear in first column
curl http://127.0.0.1:8765/health        # → {"status":"ok"}
```

The bridge will now start automatically every time you log in and restart
itself if it ever crashes.

---

## Supported apps

The bridge tries the native AppleScript `pause`/`play` verbs first (idempotent,
no side effects). If the app doesn't have an AppleScript dictionary — which is
common for Electron wrappers and Safari Web Apps — it falls back to sending a
Space keystroke directly to the background process via System Events (no window
focus animation).

| App type | Primary verb | Keystroke fallback |
|---|---|---|
| Apps with AppleScript dict | ✅ Works directly | Not needed |
| Electron / WKWebView wrappers | ❌ Fails → | ✅ Space keystroke |
| Safari Web Apps | ❌ Fails → | ✅ Space keystroke |

---

## Useful commands

```bash
# Check logs
cat /tmp/com.user.ytmsync.out.log
cat /tmp/com.user.ytmsync.err.log

# Stop the agent
launchctl unload ~/Library/LaunchAgents/com.user.ytmsync.plist

# Restart after updating the binary or plist
launchctl unload ~/Library/LaunchAgents/com.user.ytmsync.plist
launchctl load  ~/Library/LaunchAgents/com.user.ytmsync.plist
```

---

## Known limitations

- **Volume control** — `/volume` returns `501 Not Implemented` for apps
  without an AppleScript dictionary (most YouTube Music installs). There is no
  safe app-scoped volume keystroke on macOS.
- **State drift** — If you manually control YT Music while a video is playing
  (e.g. pause it from the app directly), the bridge's internal state may drift
  briefly. It self-corrects on the next play/pause event.
- **Accessibility permission** — Required for apps that lack an AppleScript
  dictionary. Without it, `/pause` and `/resume` return `500`.

---

## License

MIT
