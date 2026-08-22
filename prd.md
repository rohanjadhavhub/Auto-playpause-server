I need a complete, production-ready, low-latency solution to automatically pause/resume the YouTube Music desktop app on macOS whenever a YouTube video starts or stops playing in Google Chrome, along with independent volume control.

### Architecture Requirements:
1. **Local Go Bridge Server (`main.go`)**:
   - Runs a lightweight HTTP server on `127.0.0.1:8765`.
   - Include CORS headers (`Access-Control-Allow-Origin: *`, allowed methods, headers) so Chrome/Tampermonkey can make requests without preflight blocks.
   - Endpoints:
     - `POST /pause`: Pauses the macOS YouTube Music desktop application.
     - `POST /resume`: Resumes playback in YouTube Music.
     - `POST /volume?level={0-100}`: Adjusts the YouTube Music sound volume independently.
   - Mechanism: Provide ultra-fast execution using `osascript` targeting `"YouTube Music"`, structured so that non-blocking goroutines or fast command execution are used to keep latency under 20ms.

2. **Tampermonkey Userscript for Chrome (`yt-music-sync.user.js`)**:
   - Runs on `https://www.youtube.com/*`.
   - Uses a `MutationObserver` to reliably detect and attach listeners to dynamically loaded HTML5 `<video>` elements across YouTube's Single Page App (SPA) navigation.
   - Event handling:
     - Fire `POST /pause` on video `playing`.
     - Fire `POST /resume` on video `pause` and `ended` (ignoring intermediate pause events triggered by user scrubbing/seeking).
   - Use `GM_xmlhttpRequest` (or standard `fetch`) with minimal timeout and debouncing/state tracking to prevent rapid duplicate API calls.

3. **macOS Background Service (`com.user.ytmsync.plist`)**:
   - Provide the complete LaunchAgent `.plist` configuration to run the compiled Go binary headlessly on user login with `KeepAlive` and `RunAtLoad` enabled.
   - Include the correct file path conventions (`~/Library/LaunchAgents/`).

4. **Setup & Verification Guide**:
   - Exact CLI commands to compile the Go binary with optimization flags (`go build -ldflags="-s -w"`).
   - How to install the userscript in Tampermonkey.
   - Commands to register, load, and test the `launchd` service.

Please write clean, well-commented, idiomatic code for all three components with zero external third-party Go dependencies (standard library only).