// Command yt-music-bridge runs a lightweight local HTTP server that lets a
// Chrome/Tampermonkey userscript remote-control the macOS "YouTube Music"
// desktop app (pause/resume/volume) whenever a YouTube tab starts or stops
// playing video. It uses osascript (AppleScript) exclusively -- no third
// party Go dependencies are required.
//
// Endpoints:
//
//	POST /pause            -> pauses YouTube Music
//	POST /resume           -> resumes/plays YouTube Music
//	POST /volume?level=N   -> sets YouTube Music's own sound volume (0-100)
//	GET  /health           -> simple liveness probe
//
// Every route also responds to OPTIONS for CORS preflight, and every
// response carries permissive CORS headers so that the userscript running
// on https://www.youtube.com can call this server without being blocked by
// the browser.
package main

import (
	"context"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

// defaultAppName is the name osascript uses to address the target
// application when the YTM_APP_NAME environment variable isn't set. This
// must match the .app bundle's display name exactly as macOS/System Events
// knows it (run `osascript -e 'tell application "YouTube Music" to activate'`
// to check). Different YouTube Music installs register under different
// names -- e.g. "YouTube Music" (many Electron wrappers), "YT Music" (Safari
// Web Apps), "Youtube Music Desktop App", etc. Override at runtime with:
//
//	YTM_APP_NAME="YT Music" ./yt-music-bridge
const defaultAppName = "YouTube Music"

// appName is resolved once at startup from YTM_APP_NAME, falling back to
// defaultAppName.
var appName = resolveAppName()

func resolveAppName() string {
	if name := os.Getenv("YTM_APP_NAME"); name != "" {
		return name
	}
	return defaultAppName
}

// playbackState tracks what we believe YouTube Music's play/pause state to
// be, so that repeated /pause or /resume calls are idempotent. This matters
// because the keystroke fallback (spaceKeystrokeAppleScript) sends a single
// Space key, which *toggles* play/pause rather than setting it absolutely.
//
// Without this tracking, two YouTube tabs acting independently can fight
// each other: e.g. tab A's video starts playing and pauses Music, then tab
// B's video also starts playing and calls /pause again -- with a bare
// toggle keystroke, that second call would flip Music from paused back to
// playing instead of leaving it alone. Centralizing state in the server
// (shared by every tab, unlike each tab's independent JS state) fixes this,
// since the Go server is the single source of truth all tabs funnel through.
//
// This is best-effort: if the user manually pauses/plays YouTube Music
// directly (outside our control), our believed state can drift from
// reality until the next action resyncs it.
type playbackState struct {
	mu     sync.Mutex
	paused *bool // nil = unknown (no action taken yet, or app wasn't running)
}

var state playbackState

// desiredState returns true if action == "pause".
func desiredState(action string) bool {
	return action == "pause"
}

// commandTimeout bounds how long we allow a single osascript invocation to
// run. AppleScript calls to a healthy, running app typically complete in a
// few milliseconds; this timeout exists purely as a safety net so a hung
// osascript process can never wedge the server.
const commandTimeout = 2 * time.Second

// server is the port the bridge listens on. Bound to loopback only so it is
// never reachable from outside the machine.
const listenAddr = "127.0.0.1:8765"

func main() {
	mux := http.NewServeMux()

	mux.HandleFunc("/pause", withCORS(handlePause))
	mux.HandleFunc("/resume", withCORS(handleResume))
	mux.HandleFunc("/volume", withCORS(handleVolume))
	mux.HandleFunc("/health", withCORS(handleHealth))

	srv := &http.Server{
		Addr:    listenAddr,
		Handler: mux,
		// Keep these tight: this is a purely local, low-latency control
		// plane, not a public-facing service.
		ReadTimeout:       3 * time.Second,
		WriteTimeout:      3 * time.Second,
		ReadHeaderTimeout: 2 * time.Second,
	}

	log.Printf("yt-music-bridge listening on http://%s (target app: %q)", listenAddr, appName)
	log.Fatal(srv.ListenAndServe())
}

// withCORS wraps a handler so every response (including OPTIONS preflight)
// carries the headers Chrome requires to allow the Tampermonkey userscript
// on youtube.com to call this loopback server via fetch()/GM_xmlhttpRequest.
func withCORS(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
		h.Set("Access-Control-Max-Age", "86400")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next(w, r)
	}
}

// handlePause pauses playback in YouTube Music.
func handlePause(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	runPlaybackCommand(w, "pause", pauseAppleScript())
}

// handleResume resumes/starts playback in YouTube Music.
func handleResume(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}
	runPlaybackCommand(w, "resume", resumeAppleScript())
}

// handleVolume sets YouTube Music's own output volume, independent of the
// system-wide macOS volume. Expects a `level` query parameter in [0, 100].
func handleVolume(w http.ResponseWriter, r *http.Request) {
	if !requireMethod(w, r, http.MethodPost) {
		return
	}

	levelStr := r.URL.Query().Get("level")
	level, err := strconv.Atoi(levelStr)
	if err != nil || level < 0 || level > 100 {
		http.Error(w, `{"error":"level query param must be an integer between 0 and 100"}`, http.StatusBadRequest)
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), commandTimeout)
	defer cancel()

	script := fmt.Sprintf(`tell application %q to set sound volume to %d`, appName, level)
	if err := runOsascript(ctx, script); err != nil {
		// Unlike play/pause, there is no safe universal keystroke fallback
		// for per-app volume (there is no OS-level "set this app's volume"
		// shortcut), so we surface the failure instead of silently doing
		// something unexpected like changing system volume.
		log.Printf("volume: AppleScript failed for level=%d: %v", level, err)
		http.Error(w, fmt.Sprintf(`{"error":"volume control not supported by %q: %v"}`, appName, err), http.StatusNotImplemented)
		return
	}

	writeJSON(w, http.StatusOK, fmt.Sprintf(`{"status":"ok","volume":%d}`, level))
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, `{"status":"ok"}`)
}

// runPlaybackCommand executes the primary AppleScript verb for a play/pause
// action, and if the target app doesn't support that verb (i.e. it lacks an
// AppleScript dictionary, which is common for Electron/WKWebView wrappers),
// falls back to sending the Space key -- YouTube Music's native play/pause
// shortcut -- via System Events. The fallback briefly activates the app
// (System Events can only deliver keystrokes to the frontmost app) and then
// restores whichever app was frontmost beforehand, so the user's focus
// (e.g. Chrome) isn't stolen.
//
// If the target app isn't currently running, this is a no-op: we never
// launch it just to pause/resume it, since doing so both defeats the point
// (there's nothing playing to control) and causes macOS to emit an error
// beep when the subsequent AppleScript/keystroke attempt fails against a
// freshly-launched-but-not-yet-ready app.
func runPlaybackCommand(w http.ResponseWriter, action, primaryScript string) {
	ctx, cancel := context.WithTimeout(context.Background(), commandTimeout)
	defer cancel()

	running, err := isAppRunning(ctx)
	if err != nil {
		log.Printf("%s: failed to check if %q is running: %v", action, appName, err)
	} else if !running {
		log.Printf("%s: %q is not running, skipping", action, appName)
		// The app isn't running, so any belief we had about its play state
		// is now stale (it'll come up in whatever state it comes up in).
		state.mu.Lock()
		state.paused = nil
		state.mu.Unlock()
		writeJSON(w, http.StatusOK, fmt.Sprintf(`{"status":"skipped","reason":"app not running","action":%q}`, action))
		return
	}

	// Always attempt the primary AppleScript verb first. The native pause/play
	// commands are *idempotent* (pausing an already-paused track, or playing an
	// already-playing one, is a harmless no-op). We deliberately do NOT guard
	// this path with the cached playbackState: doing so causes silent skips
	// whenever the user manually controls YT Music outside our bridge (state
	// drift), which inverts subsequent behavior when the Space-key fallback is
	// in use. Calling the idempotent verb unconditionally self-corrects drift.
	if err := runOsascript(ctx, primaryScript); err != nil {
		log.Printf("%s: primary AppleScript verb failed (%v), falling back to keystroke", action, err)

		// The Space keystroke is a *toggle*, not an idempotent setter. Guard it
		// with our cached state to prevent concurrent /pause (or /resume) calls
		// from two tabs both slipping through and sending two keystrokes that
		// cancel each other out. The optimistic update happens before execution
		// so a second concurrent request sees the updated state immediately.
		want := desiredState(action)
		state.mu.Lock()
		alreadyInState := state.paused != nil && *state.paused == want
		if !alreadyInState {
			state.paused = &want // claim optimistically before releasing the lock
		}
		state.mu.Unlock()

		if alreadyInState {
			log.Printf("%s: keystroke guard: already in desired state, skipping toggle", action)
			writeJSON(w, http.StatusOK, fmt.Sprintf(`{"status":"skipped","reason":"already in desired state","action":%q}`, action))
			return
		}

		fallbackCtx, fallbackCancel := context.WithTimeout(context.Background(), commandTimeout)
		defer fallbackCancel()

		if fbErr := runOsascript(fallbackCtx, spaceKeystrokeAppleScript()); fbErr != nil {
			log.Printf("%s: fallback keystroke also failed: %v", action, fbErr)
			// Reset to unknown so the next call retries rather than silently
			// believing state is correct when it isn't.
			state.mu.Lock()
			state.paused = nil
			state.mu.Unlock()
			http.Error(w, fmt.Sprintf(`{"error":"%s failed: %v"}`, action, fbErr), http.StatusInternalServerError)
			return
		}
	} else {
		// Primary verb succeeded. Update cached state so the keystroke guard
		// has accurate information if the app later loses its AppleScript dict.
		want := desiredState(action)
		state.mu.Lock()
		state.paused = &want
		state.mu.Unlock()
	}

	writeJSON(w, http.StatusOK, fmt.Sprintf(`{"status":"ok","action":%q}`, action))
}

// isAppRunning checks whether the target app is currently running, without
// launching it (unlike a plain `tell application ... to activate/pause`,
// which macOS will happily use to launch a not-yet-running app).
func isAppRunning(ctx context.Context) (bool, error) {
	script := fmt.Sprintf(`application %q is running`, appName)
	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("%v (output: %s)", err, string(output))
	}
	return strings.TrimSpace(string(output)) == "true", nil
}

// pauseAppleScript returns the primary AppleScript for pausing YouTube
// Music. It targets the "pause" verb directly; apps without an AppleScript
// dictionary will error, triggering the keystroke fallback.
func pauseAppleScript() string {
	return fmt.Sprintf(`tell application %q to pause`, appName)
}

// resumeAppleScript returns the primary AppleScript for resuming playback.
func resumeAppleScript() string {
	return fmt.Sprintf(`tell application %q to play`, appName)
}

// spaceKeystrokeAppleScript activates the target app and sends a Space
// keystroke through System Events, which toggles play/pause in virtually
// every web-based YouTube Music client, then restores whichever app was
// frontmost beforehand (typically Chrome) so focus isn't stolen from the
// user. This requires the user to grant Accessibility permissions to the
// compiled binary under System Settings > Privacy & Security >
// Accessibility.
func spaceKeystrokeAppleScript() string {
	return fmt.Sprintf(`
set previousApp to ""
tell application "System Events"
	try
		set previousApp to name of first process whose frontmost is true
	end try
end tell

tell application %q to activate
delay 0.05
tell application "System Events" to keystroke " "

if previousApp is not "" and previousApp is not %q then
	delay 0.05
	tell application previousApp to activate
end if`, appName, appName)
}

// runOsascript executes the given AppleScript source via `osascript -e`.
// Execution runs in its own goroutine-friendly context: the caller
// controls cancellation/timeout, and exec.CommandContext ensures the
// underlying process is killed if the deadline is exceeded, keeping
// worst-case latency bounded.
func runOsascript(ctx context.Context, script string) error {
	cmd := exec.CommandContext(ctx, "osascript", "-e", script)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%v (output: %s)", err, string(output))
	}
	return nil
}

// requireMethod writes a 405 response and returns false if the request
// method doesn't match what's expected.
func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method != method {
		w.Header().Set("Allow", method+", OPTIONS")
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return false
	}
	return true
}

// writeJSON writes a pre-formatted JSON body with the correct content type.
func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(body))
}
