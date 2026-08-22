// ==UserScript==
// @name         YT -> YouTube Music Sync
// @namespace    yt-music-bridge
// @version      1.3.0
// @description  Pause/resume the macOS YouTube Music desktop app whenever a YouTube video plays/pauses in Chrome, via a local bridge server.
// @match        https://www.youtube.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
  'use strict';

  // Base URL of the local Go bridge server (main.go). Must match listenAddr.
  const BRIDGE_URL = 'http://127.0.0.1:8765';

  // Requests to the bridge are fire-and-forget and time out fast so a dead
  // or slow server never blocks/janks the YouTube page.
  const REQUEST_TIMEOUT_MS = 500;

  // Debounce window: multiple play/pause events firing within this window
  // (e.g. seeking, buffering blips, ad transitions) collapse into a single
  // bridge call reflecting only the final state.
  const DEBOUNCE_MS = 150;

  // --- State -----------------------------------------------------------
  // Tracks the last action actually sent to the bridge so we never fire a
  // duplicate /pause or /resume in a row (e.g. two <video> elements both
  // reporting "playing" back to back).
  let lastSentAction = null;
  let debounceTimer = null;

  // Tracks every <video> element we've already attached listeners to, so
  // MutationObserver churn (YouTube's SPA re-renders constantly) never
  // double-attaches.
  const observedVideos = new WeakSet();

  // --- Cross-tab coordination --------------------------------------------
  // Multiple YouTube tabs can be open at once, each running its own
  // independent copy of this script. localStorage is shared across all tabs
  // of the same origin, so we use it to track a shared registry of
  // "currently playing" tabs. The desired bridge action is then derived from
  // whether that registry is empty, not from this tab's state alone.
  //
  // Registry format: { [tabId]: lastSeenTimestampMs }
  //
  // WHY TIMESTAMPS (vs. plain array):
  //   The old array format had no expiry mechanism. If a tab crashed or the
  //   browser was force-quit, its TAB_ID stayed in localStorage forever.
  //   On the next session every markTabPlaying(false) would see the ghost
  //   entry and return anyTabStillPlaying=true, permanently blocking /resume.
  //   The TTL-stamped format makes every entry self-expiring: a tab must
  //   refresh its entry every REGISTRY_HEARTBEAT_MS while playing, or it is
  //   silently pruned by other tabs' reads within REGISTRY_TTL_MS.
  const REGISTRY_KEY = 'yt-music-sync:playing-tab-ids';
  const REGISTRY_TTL_MS = 12000;      // entry is stale after 12 s without a heartbeat
  const REGISTRY_HEARTBEAT_MS = 4000; // playing tabs refresh every 4 s

  const TAB_ID = Math.random().toString(36).slice(2) + '-' + Date.now();

  // Timer handle for the keep-alive heartbeat (non-null only while playing).
  let heartbeatTimer = null;

  function readRegistry() {
    try {
      const raw = localStorage.getItem(REGISTRY_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      // Gracefully migrate the old array format (v1.0-1.2): treat it as empty
      // so stale entries from the previous format don't linger.
      if (Array.isArray(parsed)) return {};
      return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * Returns a copy of `registry` containing only entries whose timestamps
   * fall within REGISTRY_TTL_MS. Entries from crashed tabs or previous
   * browser sessions are silently dropped here.
   */
  function liveEntries(registry) {
    const now = Date.now();
    return Object.fromEntries(
      Object.entries(registry).filter(([, ts]) => now - ts < REGISTRY_TTL_MS)
    );
  }

  function writeRegistry(registry) {
    try {
      localStorage.setItem(REGISTRY_KEY, JSON.stringify(registry));
    } catch (e) {
      // localStorage unavailable (private mode, quota, etc). Degrade to
      // single-tab-only behavior; not fatal.
    }
  }

  /**
   * Marks this tab as "playing" or "not playing" in the shared registry.
   * Stale entries from other tabs are pruned on every call.
   * Returns true if *any* live tab (including this one) is currently playing.
   */
  function markTabPlaying(isPlaying) {
    const live = liveEntries(readRegistry());
    if (isPlaying) {
      live[TAB_ID] = Date.now(); // upsert with fresh timestamp
    } else {
      delete live[TAB_ID];
    }
    writeRegistry(live);
    return Object.keys(live).length > 0;
  }

  /**
   * Starts the keep-alive heartbeat that refreshes this tab's registry
   * entry every REGISTRY_HEARTBEAT_MS. Without it, other tabs' TTL checks
   * would eventually prune a live-but-quiet tab's entry (e.g. a tab playing
   * a video but not pausing/playing for > 12 s). Idempotent: safe to call
   * multiple times while playing.
   */
  function startHeartbeat() {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (anyVideoPlaying()) {
        markTabPlaying(true); // refresh timestamp
      } else {
        stopHeartbeat(); // video stopped outside our event handlers (rare)
      }
    }, REGISTRY_HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  // Best-effort cleanup: if this tab closes/navigates away while marked as
  // playing, remove it from the registry so other tabs don't block on a ghost.
  window.addEventListener('pagehide', () => {
    stopHeartbeat();
    const live = liveEntries(readRegistry());
    delete live[TAB_ID];
    writeRegistry(live);
  });

  // ---------------------------------------------------------------------------

  /**
   * Sends a request to the bridge server. Uses GM_xmlhttpRequest when
   * available (works even if the page's CSP would block fetch, and isn't
   * subject to the page's own network restrictions); falls back to fetch
   * for environments where GM_xmlhttpRequest isn't granted.
   */
  function sendToBridge(path) {
    const url = BRIDGE_URL + path;
    console.log('[yt-music-sync] sending request:', url);

    if (typeof GM_xmlhttpRequest === 'function') {
      GM_xmlhttpRequest({
        method: 'POST',
        url,
        timeout: REQUEST_TIMEOUT_MS,
        onload: (res) => {
          console.log('[yt-music-sync] bridge response:', url, res.status, res.responseText);
        },
        onerror: (err) => {
          console.warn('[yt-music-sync] bridge request failed:', url, err);
        },
        ontimeout: () => {
          console.warn('[yt-music-sync] bridge request timed out:', url);
        },
      });
      return;
    }

    // Fallback: plain fetch with an abort-based timeout.
    console.log('[yt-music-sync] GM_xmlhttpRequest not available, using fetch fallback');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    fetch(url, { method: 'POST', signal: controller.signal })
      .then((res) => console.log('[yt-music-sync] bridge response:', url, res.status))
      .catch((err) => console.warn('[yt-music-sync] bridge request failed:', url, err))
      .finally(() => clearTimeout(timer));
  }

  /**
   * Debounced dispatch: schedules `action` ('pause' | 'resume') to be sent
   * after DEBOUNCE_MS of quiet, cancelling any previously scheduled action.
   * If the resolved action matches what we last actually sent, it's skipped
   * entirely to avoid redundant calls.
   */
  function scheduleAction(action) {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (action === lastSentAction) {
        return;
      }
      lastSentAction = action;
      sendToBridge('/' + action);
    }, DEBOUNCE_MS);
  }

  /**
   * Returns true if any video on the page is actively producing audio
   * (unmuted, playing, not ended). Muted videos are deliberately excluded:
   * YouTube hover-preview thumbnails on the home/feed page play silently and
   * should never interfere with Music control. If the user explicitly mutes
   * their video, we treat it the same as paused for Music-control purposes.
   */
  function anyVideoPlaying() {
    const videos = document.querySelectorAll('video');
    for (const v of videos) {
      if (!v.paused && !v.ended && v.readyState > 0 && !v.muted) {
        return true;
      }
    }
    return false;
  }

  /**
   * Shared "this tab's video stopped (or became silent)" logic. Checks
   * whether any OTHER unmuted video on this page is still running before
   * removing the tab from the registry, then decides whether to resume Music.
   */
  function handleVideoStop() {
    if (anyVideoPlaying()) {
      // Another unmuted video on this tab is still producing audio; do nothing.
      console.log('[yt-music-sync] video stopped but another is still playing, no-op');
      return;
    }
    stopHeartbeat();
    // Ensure the next play event always re-sends /pause even if this tab's
    // lastSentAction is 'pause' (prevents the dedup cache from blocking it).
    lastSentAction = null;
    const anyTabStillPlaying = markTabPlaying(false);
    if (!anyTabStillPlaying) {
      scheduleAction('resume');
    } else {
      console.log('[yt-music-sync] another tab is still playing, not resuming');
    }
  }

  /**
   * Attaches playing/pause/ended/volumechange listeners to a <video> element
   * exactly once.
   *
   * `playing`     - fires after buffering completes and real playback begins.
   * `pause`       - fires on user pause and on seek (seeking re-fires `playing`
   *                 almost immediately, so the debounce collapses the pair).
   * `ended`       - fires when the video finishes.
   * `volumechange`- fires when muted/unmuted; treat mute as pause and unmute
   *                 as play for Music-control purposes.
   */
  function attachVideoListeners(video) {
    if (observedVideos.has(video)) {
      return;
    }
    observedVideos.add(video);
    console.log('[yt-music-sync] attached listeners to video element', video);

    video.addEventListener('playing', () => {
      console.log('[yt-music-sync] video event: playing, muted=', video.muted);
      // Skip hover-preview thumbnails: they are muted by YouTube and produce
      // no audio, so they should not pause or hold Music paused.
      if (video.muted) return;
      markTabPlaying(true);
      startHeartbeat();
      scheduleAction('pause');
    });

    video.addEventListener('pause', () => {
      console.log('[yt-music-sync] video event: pause');
      handleVideoStop();
    });

    video.addEventListener('ended', () => {
      console.log('[yt-music-sync] video event: ended');
      handleVideoStop();
    });

    // Handle the user muting/unmuting the player mid-playback. Muting while
    // playing is semantically equivalent to pausing for our purposes (the
    // user no longer hears the video, so Music should resume). Unmuting
    // while playing means the video is now audible and Music should pause.
    video.addEventListener('volumechange', () => {
      if (video.paused || video.ended) return;
      if (!video.muted) {
        // Unmuted while playing -> now audible, block Music.
        console.log('[yt-music-sync] video event: unmuted while playing');
        markTabPlaying(true);
        startHeartbeat();
        scheduleAction('pause');
      } else if (!anyVideoPlaying()) {
        // Muted while playing, no other unmuted video on the page -> release Music.
        console.log('[yt-music-sync] video event: muted while playing, releasing Music');
        handleVideoStop();
      }
    });
  }

  /**
   * Scans the whole document (or a subtree) for <video> elements and attaches
   * listeners to any not already observed. Called on initial load and on every
   * MutationObserver callback to catch videos created during YouTube's SPA
   * navigations (watch page swaps, mini-player, Shorts, etc.).
   */
  function scanForVideos(root) {
    const scope = root || document;
    if (scope.tagName === 'VIDEO') {
      attachVideoListeners(scope);
    }
    const videos = scope.querySelectorAll ? scope.querySelectorAll('video') : [];
    videos.forEach(attachVideoListeners);
  }

  // --- Bootstrap ---------------------------------------------------------

  console.log('[yt-music-sync] userscript loaded on', location.href);

  // Initial pass in case a <video> is already present when the script runs.
  scanForVideos(document);

  // If a video is already actively playing when the script loads (e.g.
  // autoplay on a watch page, or the user navigated while a video was
  // mid-play), assert the correct bridge state immediately. Without this,
  // the script misses the initial `playing` event and Music is never paused.
  if (anyVideoPlaying()) {
    console.log('[yt-music-sync] video already playing on load, asserting pause');
    markTabPlaying(true);
    startHeartbeat();
    scheduleAction('pause');
  }

  // YouTube is a heavily dynamic SPA: watch pages, the mini-player, and ad
  // breaks all create/destroy <video> elements without a full page reload.
  // A MutationObserver on the whole document body reliably catches every
  // one of these insertions.
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        scanForVideos(node);
      });
    }
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Also handle YouTube's own SPA navigation event as a belt-and-suspenders
  // measure: right after navigating, re-scan in case the observer missed a
  // batched replacement.
  window.addEventListener('yt-navigate-finish', () => scanForVideos(document));

  // If this tab closes/navigates away entirely while it was the one keeping
  // Music paused, and no other live tab is still playing, resume Music so it
  // doesn't stay paused forever. The pagehide listener above already removed
  // this tab's entry and stopped the heartbeat; we just read the result.
  window.addEventListener('pagehide', () => {
    const live = liveEntries(readRegistry());
    if (lastSentAction === 'pause' && Object.keys(live).length === 0) {
      sendToBridge('/resume');
    }
  });

  // Cross-tab registry watcher. The browser fires 'storage' events in every
  // tab *except* the one that wrote, so this never triggers in the tab that
  // caused the change -- no self-loops.
  //
  // When another tab modifies the registry (e.g. Tab B's video ends and it
  // clears its entry, then sends /resume), Tab A gets this event. Without it,
  // Tab A's lastSentAction would still be 'pause' from when it started, and
  // the dedup gate inside scheduleAction would silently drop Tab A's re-pause
  // call, leaving Music playing while Tab A's video is still running.
  window.addEventListener('storage', (e) => {
    if (e.key !== REGISTRY_KEY) return;
    console.log('[yt-music-sync] registry changed by another tab:', e.newValue);
    // Invalidate per-tab dedup cache so the next action isn't suppressed.
    lastSentAction = null;
    // Re-assert if our video is still producing audio.
    if (anyVideoPlaying()) {
      markTabPlaying(true);
      scheduleAction('pause');
    }
  });
})();


