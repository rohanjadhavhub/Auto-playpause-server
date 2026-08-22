# YT -> YouTube Music Sync

Automatically pauses/resumes the `YT Music.app` desktop app on macOS
whenever a YouTube video starts or stops playing in Chrome. Three pieces:

1. `main.go` — local Go HTTP bridge server (`127.0.0.1:8765`), stdlib only.
2. `yt-music-sync.user.js` — Tampermonkey userscript for `youtube.com`.
3. `com.user.ytmsync.plist` — LaunchAgent to run the bridge headlessly at login.

## Your setup: `YT Music.app`

The PRD assumes the target app is scriptable via `tell application "YouTube
Music" to pause/play/set sound volume`. The app actually installed on this
machine is **`YT Music.app`** (a Safari Web App wrapper, bundle id
`com.apple.Safari.WebApp...`), and it has **no AppleScript dictionary at
all** — `pause`, `play`, and `sound volume` all fail with "variable ... is
not defined" when tested directly. This is common: most Electron/WKWebView
wrappers don't ship an `.sdef`.

To handle this, the bridge does two things:

- **Play/pause/resume**: tries the AppleScript verb first; since `YT
  Music.app` doesn't support it, it falls back to activating the app and
  sending a Space keystroke via System Events (YouTube Music's native
  play/pause shortcut). Verified working end-to-end against `YT Music.app`.
- **Volume**: only uses the AppleScript `sound volume` property, which `YT
  Music.app` doesn't support, so `/volume` will always return
  `501 Not Implemented`. You've said you'll manage volume separately, so
  this is left as-is — see Known Limitations below.

The bridge is already configured for this app via the `YTM_APP_NAME`
environment variable (defaults to `"YouTube Music"` per the PRD if unset):

```bash
YTM_APP_NAME="YT Music" ./yt-music-bridge
```

`com.user.ytmsync.plist` already sets `YTM_APP_NAME=YT Music`, so no edits
are needed there for this app.

If you ever reinstall under a different app name, re-check with:

```bash
ls /Applications ~/Applications | grep -i music
osascript -e 'tell application "YT Music" to activate'   # sanity-check the name
osascript -e 'tell application "YT Music" to pause'      # check AppleScript support
```

## 1. Build the Go bridge server

Requires Go 1.21+ (check with `go version`).

```bash
cd /Users/rohanjadhav/Code/Projects/yt-playpause-server
go build -ldflags="-s -w" -o yt-music-bridge main.go
```

`-ldflags="-s -w"` strips debug symbols and DWARF info for a smaller binary;
functionally identical, just leaner.

Run it manually to test:

```bash
YTM_APP_NAME="YT Music" ./yt-music-bridge
```

You should see:

```
yt-music-bridge listening on http://127.0.0.1:8765 (target app: "YT Music")
```

### Grant Accessibility permission (required for the keystroke fallback)

Since `YT Music.app` isn't scriptable, the keystroke fallback needs
Accessibility access to send keystrokes via System Events:

1. System Settings > Privacy & Security > Accessibility.
2. Add and enable the binary you compiled (`yt-music-bridge`), or the
   terminal app you're running it from during manual testing.
3. Without this, `/pause` and `/resume` will return a `500` error
   mentioning `osascript is not allowed to send keystrokes (1002)`.

### Verify the endpoints manually

```bash
curl -X GET  http://127.0.0.1:8765/health
curl -X POST http://127.0.0.1:8765/pause
curl -X POST http://127.0.0.1:8765/resume
curl -X POST "http://127.0.0.1:8765/volume?level=50"
```

Expected: `{"status":"ok",...}` with HTTP 200 on success. `/volume` returns
`400` for an out-of-range level and `501` if your app doesn't support
AppleScript volume control.

## 2. Install the Tampermonkey userscript

1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension in
   Chrome if you don't already have it.
2. Click the Tampermonkey icon > Create a new script (or Dashboard >
   Utilities > Import from file).
3. Delete the boilerplate and paste in the full contents of
   `yt-music-sync.user.js`.
4. Save (Cmd+S). Confirm it's listed as enabled in the Tampermonkey
   dashboard, matching `https://www.youtube.com/*`.
5. Open/reload `youtube.com`, open the browser console, and play a video.
   You should see no errors; if the bridge server isn't running you'll see
   a `[yt-music-sync] bridge request failed` warning (harmless — YouTube
   playback itself is unaffected).

The script's `BRIDGE_URL` constant assumes the default
`http://127.0.0.1:8765`; update it if you changed `listenAddr` in `main.go`.

## 3. Register the LaunchAgent (run headlessly at login)

`com.user.ytmsync.plist` is already configured for this machine: it points
`ProgramArguments`/`WorkingDirectory` at
`/Users/rohanjadhav/Code/Projects/yt-playpause-server/yt-music-bridge` and
sets `YTM_APP_NAME=YT Music`. No edits needed unless you move the binary or
switch apps.

1. Copy it into place:

   ```bash
   cp com.user.ytmsync.plist ~/Library/LaunchAgents/com.user.ytmsync.plist
   ```

3. Load and start it:

   ```bash
   launchctl load ~/Library/LaunchAgents/com.user.ytmsync.plist
   ```

   (On macOS Ventura+, `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.ytmsync.plist`
   is the modern equivalent if `load` is deprecated on your OS version.)

4. Verify it's running:

   ```bash
   launchctl list | grep com.user.ytmsync
   curl http://127.0.0.1:8765/health
   ```

5. Check logs if something's wrong:

   ```bash
   cat /tmp/com.user.ytmsync.out.log
   cat /tmp/com.user.ytmsync.err.log
   ```

6. To stop/unload:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.user.ytmsync.plist
   ```

7. To restart after editing the binary or plist:

   ```bash
   launchctl unload ~/Library/LaunchAgents/com.user.ytmsync.plist
   launchctl load ~/Library/LaunchAgents/com.user.ytmsync.plist
   ```

The agent will now start automatically every time you log in
(`RunAtLoad`), and `launchd` will restart it if it ever crashes
(`KeepAlive`).

## End-to-end test

1. Start the LaunchAgent (or run the binary manually).
2. Open `YT Music.app` and start it playing something.
3. Open a YouTube video in Chrome and press play — `YT Music.app` should
   pause within roughly a debounce window (150ms) plus AppleScript/keystroke
   execution time (single-digit to low double-digit milliseconds).
4. Pause the YouTube video — `YT Music.app` should resume.
5. Seek/scrub the YouTube video repeatedly — `YT Music.app` should **not**
   flicker pause/resume, since the debounce collapses the pause+play burst
   from scrubbing into a no-op.

## Known limitations

- **Volume control is not supported.** `YT Music.app` has no AppleScript
  dictionary, so `/volume` always returns `501`. There's no universal, safe,
  app-scoped volume keystroke on macOS — only system-wide volume keys exist,
  which would violate "independent" volume control, so no fallback is
  attempted. Volume is being handled separately, outside this bridge.
- **The keystroke fallback briefly activates `YT Music.app`** (`activate` +
  `delay 0.05` + `keystroke " "`) because System Events can only deliver
  keystrokes to the frontmost app. This causes a very brief app switch/focus
  steal; if `YT Music.app` is already frontmost this is imperceptible.
- **Accessibility permission is required** for the keystroke fallback,
  since `YT Music.app` isn't AppleScript-scriptable.
