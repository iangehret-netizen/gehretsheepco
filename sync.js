// Gehret Sheep Co — cross-device sync
//
// Loaded BEFORE bundle.js. Responsibilities:
//   1. Define window.__gscSyncPush synchronously so bundle.js's window.storage
//      wrapper can call it the instant it exists, even before Firebase is ready
//      (calls just queue up).
//   2. Show a full-screen passcode overlay that blocks interaction with the app
//      until the device is unlocked. The passcode is checked by Firebase Auth
//      server-side (real security), but the UI never shows "email" or "login" —
//      just a single passcode field. Once unlocked on a device, Firebase keeps
//      the session cached locally, so the passcode is only needed once per
//      device (and works offline after that first successful unlock).
//   3. Push local changes to Firestore (best-effort; Firestore's own offline
//      persistence queues writes automatically when there's no connection and
//      sends them once the device is back online — this is why Firebase was
//      chosen for this).
//   4. Listen for remote changes from other devices and merge them into
//      localStorage using last-write-wins (by timestamp), per storage key.
//      Since the app has already rendered from local data, a merged remote
//      update surfaces as a small "Refresh" banner rather than silently
//      yanking data out from under someone mid-edit.
//   5. Show a small sync-status pill (Locked / Syncing / Synced / Offline).
(function () {
  "use strict";

  var FIREBASE_CONFIG = {
    apiKey: "AIzaSyBScV9nunqzaXRVDrjs9uXkMDsqD03B9Ig",
    authDomain: "gehret-sheep-co.firebaseapp.com",
    projectId: "gehret-sheep-co",
    storageBucket: "gehret-sheep-co.firebasestorage.app",
    messagingSenderId: "739407963677",
    appId: "1:739407963677:web:d8acff03d95cca74f248f4",
  };

  // Single shared account backing every device. The app UI never shows this —
  // only a passcode field — but Firebase still does real server-side auth.
  var SYNC_EMAIL = "iangehret@gmail.com";

  var LOCAL_PREFIX = "gsc:";
  var META_PREFIX = "gsc:__syncmeta:";
  var SYNC_KEY_PREFIX = "sheepwrld:"; // only sync app data, not misc local keys

  // v55: showman mode. Set when a showman code (not the passcode) unlocked this phone.
  var SM = null;
  try { SM = JSON.parse(localStorage.getItem("gsc:__sm") || "null"); } catch (e) {}
  window.__gscShowman = SM;

  var pendingPushQueue = [];
  var fbApp, auth, db;
  var authReady = false;
  var currentUser = null;
  var firstSnapshotProcessed = false;
  var bannerShown = false;
  var pillEl = null;
  var overlayEl = null;

  // ---------------------------------------------------------------------
  // 1. Synchronous bridge — must exist before bundle.js runs.
  // ---------------------------------------------------------------------
  window.__gscSyncPush = function (key, value) {
    if (SM) { if (window.__gscSMLocal) window.__gscSMLocal(key, value); return; } // showman phones never write to the owner's records
    if (typeof key !== "string" || key.indexOf(SYNC_KEY_PREFIX) !== 0) return;
    pendingPushQueue.push({ key: key, value: value, ts: Date.now() });
    flushQueue();
    if (window.__gscSMOwnerTouch) window.__gscSMOwnerTouch(key);
  };

  function flushQueue() {
    if (!authReady || !currentUser || !db) return;
    while (pendingPushQueue.length) {
      var item = pendingPushQueue.shift();
      pushToFirestore(item.key, item.value, item.ts);
    }
  }

  // ---------------------------------------------------------------------
  // 2. UI (plain DOM, no framework — keeps this independent of bundle.js)
  // ---------------------------------------------------------------------
  function buildStatusPill() {
    var pill = document.createElement("div");
    pill.id = "gsc-sync-pill";
    pill.style.cssText =
      "position:fixed;bottom:10px;right:10px;z-index:9998;font-size:11px;" +
      "padding:4px 9px;border-radius:999px;background:rgba(0,0,0,.6);color:#fff;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "pointer-events:none;transition:opacity .3s;opacity:.9;letter-spacing:.2px;";
    document.body.appendChild(pill);
    return pill;
  }

  function setPillState(state) {
    if (!pillEl) return;
    var map = {
      locked: ["Locked", "#555"],
      syncing: ["Syncing…", "#8a6d00"],
      synced: ["Synced", "#2e7d32"],
      offline: ["Offline — saved on device", "#5a5a5a"],
      error: ["Sync error", "#8b2f2f"],
    };
    var m = map[state] || map.offline;
    pillEl.textContent = m[0];
    pillEl.style.background = m[1];
  }

  function buildOverlay() {
    var overlay = document.createElement("div");
    overlay.id = "gsc-sync-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:99999;background:#1B1B1B;display:flex;" +
      "align-items:center;justify-content:center;flex-direction:column;gap:14px;" +
      "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "color:#fff;padding:24px;box-sizing:border-box;text-align:center;";
    overlay.innerHTML =
      '<div style="font-size:20px;font-weight:600;">Gehret Sheep Co</div>' +
      '<div style="font-size:14px;color:#aaa;max-width:280px;">Enter the passcode or your showman code.</div>' +
      '<input id="gsc-sync-passcode" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" ' +
      'style="width:220px;padding:12px 14px;border-radius:8px;border:1px solid #444;background:#2A2A2A;color:#fff;' +
      'font-size:16px;text-align:center;" placeholder="Passcode" />' +
      '<button id="gsc-sync-unlock" style="width:220px;padding:12px;border-radius:8px;border:none;' +
      'background:#4F7942;color:#fff;font-size:15px;font-weight:600;cursor:pointer;">Unlock</button>' +
      '<div id="gsc-sync-error" style="font-size:13px;color:#e57373;min-height:16px;max-width:280px;"></div>';
    document.body.appendChild(overlay);

    var input = overlay.querySelector("#gsc-sync-passcode");
    var btn = overlay.querySelector("#gsc-sync-unlock");
    function submit() {
      var val = input.value;
      if (!val) return;
      attemptSignIn(val);
    }
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") submit();
    });
    setTimeout(function () {
      input.focus();
    }, 50);
    return overlay;
  }

  function setOverlayError(msg) {
    if (!overlayEl) return;
    var el = overlayEl.querySelector("#gsc-sync-error");
    if (el) el.textContent = msg || "";
  }

  function setOverlayBusy(busy) {
    if (!overlayEl) return;
    var btn = overlayEl.querySelector("#gsc-sync-unlock");
    var input = overlayEl.querySelector("#gsc-sync-passcode");
    if (btn) {
      btn.disabled = busy;
      btn.textContent = busy ? "Checking…" : "Unlock";
      btn.style.opacity = busy ? "0.7" : "1";
    }
    if (input) input.disabled = busy;
  }

  function hideOverlay() {
    if (overlayEl) overlayEl.style.display = "none";
  }
  function showOverlay() {
    if (overlayEl) overlayEl.style.display = "flex";
  }

  // v63: name what changed, and quietly reload right after opening instead of nagging.
  var bootAt = Date.now(), userBusy = false, changedNames = {};
  ["pointerdown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, function (e) {
      var t = e.target;
      if (t && t.closest && (t.closest("#gsc-cover") || t.closest("#gsc-sync-overlay") || t.closest("#gsc-sync-banner"))) return;
      userBusy = true;
    }, true);
  });
  function nameForKey(k) {
    var m;
    if ((m = /^sheepwrld:showbarn:(.+)$/.exec(k))) return "Show Lambs " + m[1];
    if (k === "sheepwrld:herd" || k === "sheepwrld:herdhealth") return "Herd View";
    if (/^sheepwrld:(of:|otherfarms)/.test(k)) return "Other Farms";
    if (/^sheepwrld:showman/.test(k)) return "Showman entries";
    if (k === "sheepwrld:years") return "year list";
    if (/^sheepwrld:seeded:/.test(k)) return null;
    return "settings";
  }
  var lastTyped = 0, pendingRec = {};
  ["input", "keydown"].forEach(function (ev) { document.addEventListener(ev, function (e) { var t = e.target; if (t && t.closest && t.closest("#gsc-sync-overlay")) return; lastTyped = Date.now(); }, true); });
  // v65: someone is mid-edit if a form/box is open, a field has focus, or they typed in the last 30 seconds
  function isEditing() {
    var a = document.activeElement;
    if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && !a.closest("#gsc-sync-overlay")) return true;
    if (Date.now() - lastTyped < 30000) return true;
    if (document.querySelector('div[style*="z-index: 9990"]')) return true;
    var btns = document.querySelectorAll("#root button");
    for (var i = 0; i < btns.length; i++) { var t = (btns[i].textContent || "").trim(); if ((t === "Cancel" || /^Save( |$)/.test(t)) && btns[i].offsetParent) return true; }
    return false;
  }
  function isRecordKey(k) { return /^sheepwrld:(showbarn:|herd$|of:|years$)/.test(k); }
  function extSet(k) {
    if (!window.gxExtSet) return;
    try { var v = localStorage.getItem(LOCAL_PREFIX + k); window.gxExtSet(k, v == null ? undefined : JSON.parse(v)); } catch (e) {}
  }
  // put changed records on screen without a page reload
  function liveApply(keys) {
    var full = false, season = false, herd = false;
    keys.forEach(function (k) {
      if (/^sheepwrld:of:/.test(k)) extSet(k);
      else if (/^sheepwrld:showbarn:/.test(k)) season = true;
      else if (k === "sheepwrld:herd") herd = true;
      else full = true;
    });
    if (full) { window.location.reload(); return; }
    try { if (season) window.dispatchEvent(new Event("gsc-reload-season")); if (herd) window.dispatchEvent(new Event("gsc-reload-herd")); } catch (e) {}
  }
  function applyRemote(keys) {
    var rec = [];
    keys.forEach(function (k) { extSet(k); if (isRecordKey(k)) rec.push(k); }); // everything else updates quietly
    if (!rec.length) return;
    if (quietReloadOk()) { try { sessionStorage.setItem("gsc:autoReload", String(Date.now())); } catch (e) {} window.location.reload(); return; }
    if (isEditing()) { rec.forEach(function (k) { pendingRec[k] = 1; var nm = nameForKey(k); if (nm) changedNames[nm] = 1; }); showUpdateBanner(); return; }
    liveApply(rec);
  }
  // once they finish editing, catch up on whatever came in meanwhile
  setInterval(function () {
    var ks = Object.keys(pendingRec);
    if (!ks.length || isEditing()) return;
    pendingRec = {}; changedNames = {};
    var b = document.getElementById("gsc-sync-banner"); if (b) b.remove(); bannerShown = false;
    liveApply(ks);
  }, 5000);
  function bannerText() { var n = Object.keys(changedNames); return "New data synced from another device" + (n.length ? ": " + n.join(", ") : "") + "."; }
  function quietReloadOk() {
    if (userBusy || Date.now() - bootAt > 15000) return false;
    var last = 0; try { last = +sessionStorage.getItem("gsc:autoReload") || 0; } catch (e) {}
    return Date.now() - last > 60000;
  }
  function showUpdateBanner() {
    if (bannerShown) { var s = document.querySelector("#gsc-sync-banner span"); if (s) s.textContent = bannerText(); return; }
    bannerShown = true;
    var banner = document.createElement("div");
    banner.id = "gsc-sync-banner";
    banner.style.cssText =
      "position:fixed;top:0;left:0;right:0;z-index:9997;background:#2f5233;color:#fff;" +
      "padding:10px 14px;display:flex;align-items:center;justify-content:center;gap:12px;" +
      "font-size:13px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;" +
      "box-shadow:0 2px 6px rgba(0,0,0,.3);";
    banner.innerHTML =
      "<span></span>" +
      '<button id="gsc-sync-refresh-btn" style="background:#fff;color:#2f5233;border:none;' +
      'border-radius:6px;padding:6px 12px;font-weight:600;cursor:pointer;font-size:12px;">Refresh</button>';
    document.body.appendChild(banner);
    banner.querySelector("span").textContent = bannerText();
    banner.querySelector("#gsc-sync-refresh-btn").addEventListener("click", function () {
      window.location.reload();
    });
  }

  // ---------------------------------------------------------------------
  // 3 & 4. Firebase wiring
  // ---------------------------------------------------------------------
  function attemptSignIn(passcode) {
    if (!auth) return;
    setOverlayError("");
    setOverlayBusy(true);
    // A showman code is checked first; if it isn't one, try it as the owner passcode.
    var tryCode = window.__gscSMTryCode ? window.__gscSMTryCode(passcode, auth, db) : Promise.resolve(false);
    tryCode.catch(function (e) { console.error("[GSC Sync] Showman code check failed:", e); return false; }).then(function (isShowman) {
    if (isShowman) return;
    return window.__fb
      .signInWithEmailAndPassword(auth, SYNC_EMAIL, passcode)
      .catch(function (err) {
        setOverlayBusy(false);
        var code = err && err.code;
        console.error("[GSC Sync] Sign-in error:", code, err);
        if (code === "auth/network-request-failed") {
          setOverlayError(
            "No internet connection. Connect once to unlock this device — after that it stays unlocked."
          );
        } else if (code === "auth/too-many-requests") {
          setOverlayError("Too many attempts. Wait a moment and try again.");
        } else {
          setOverlayError("Incorrect passcode or code. Try again.");
        }
      });
    });
  }

  function pushToFirestore(key, value, ts) {
    var FB = window.__fb;
    var ref = FB.doc(db, "gsc_sync", key);
    var payload =
      value === null
        ? { deleted: true, value: null, ts: ts, serverTs: FB.serverTimestamp() }
        : { deleted: false, value: value, ts: ts, serverTs: FB.serverTimestamp() };
    localStorage.setItem(META_PREFIX + key, String(ts));
    setPillState(navigator.onLine === false ? "offline" : "syncing");
    FB.setDoc(ref, payload).catch(function (err) {
      // Firestore's offline persistence normally queues this silently when
      // truly offline — but log it so a permissions/rules problem is visible.
      console.error("[GSC Sync] Write failed for", key, ":", err && err.code, err);
    });
  }

  function backfillMissingLocalKeys(remoteKeysSeen) {
    for (var i = 0; i < localStorage.length; i++) {
      var rawKey = localStorage.key(i);
      if (!rawKey || rawKey.indexOf(LOCAL_PREFIX + SYNC_KEY_PREFIX) !== 0) continue;
      if (rawKey.indexOf(META_PREFIX) === 0) continue;
      var key = rawKey.slice(LOCAL_PREFIX.length);
      if (remoteKeysSeen[key]) continue;
      var value = localStorage.getItem(rawKey);
      if (value === null) continue;
      var ts = Date.now();
      pushToFirestore(key, value, ts);
    }
  }

  function startListening() {
    var FB = window.__fb;
    var colRef = FB.collection(db, "gsc_sync");
    FB.onSnapshot(
      colRef,
      function (snap) {
        var sawChange = false, changedKeys = [];
        var remoteKeysSeen = {};
        snap.docChanges().forEach(function (change) {
          var key = change.doc.id;
          remoteKeysSeen[key] = true;
          var data = change.doc.data();
          if (!data) return;
          var remoteTs = data.ts || 0;
          var localTsRaw = localStorage.getItem(META_PREFIX + key);
          var localTs = localTsRaw ? parseInt(localTsRaw, 10) : 0;
          if (remoteTs <= localTs) return; // we already have this (or our own echoed write)

          if (data.deleted) {
            if (localStorage.getItem(LOCAL_PREFIX + key) != null) { localStorage.removeItem(LOCAL_PREFIX + key); changedKeys.push(key); sawChange = true; }
          } else if (typeof data.value === "string") {
            var existing = localStorage.getItem(LOCAL_PREFIX + key);
            if (existing === data.value) {
              localStorage.setItem(META_PREFIX + key, String(remoteTs));
              return;
            }
            localStorage.setItem(LOCAL_PREFIX + key, data.value);
            changedKeys.push(key); sawChange = true;
          }
          localStorage.setItem(META_PREFIX + key, String(remoteTs));
        });

        if (!firstSnapshotProcessed) {
          firstSnapshotProcessed = true;
          backfillMissingLocalKeys(remoteKeysSeen);
        }

        if (sawChange) applyRemote(changedKeys);
        if (sawChange && window.__gscSMOwnerTouch) window.__gscSMOwnerTouch("*");
        setPillState(navigator.onLine === false ? "offline" : "synced");
      },
      function (err) {
        console.error("[GSC Sync] Firestore listener error:", err && err.code, err);
        setPillState("offline");
      }
    );
  }

  function initFirebase() {
    var FB = window.__fb;
    if (!FB) {
      // firebase-vendor.js failed to load (e.g. blocked script) — app still
      // works fully offline via localStorage, just without cross-device sync.
      setPillState("error");
      hideOverlay();
      return;
    }
    try {
      fbApp = FB.initializeApp(FIREBASE_CONFIG);
      auth = FB.getAuth(fbApp);
      try {
        db = FB.initializeFirestore(fbApp, {
          localCache: FB.persistentLocalCache({ tabManager: FB.persistentMultipleTabManager({}) }),
        });
      } catch (e) {
        // Firestore already initialized (hot reload / duplicate script), or this
        // environment doesn't support persistent local cache (e.g. no IndexedDB,
        // private browsing) — fall back to an in-memory Firestore instance so
        // sync still works this session even without offline queuing.
        try {
          db = FB.initializeFirestore(fbApp, {});
        } catch (e2) {
          throw e2;
        }
      }

      FB.onAuthStateChanged(
        auth,
        function (user) {
          currentUser = user;
          if (SM) {
            // Showman phone: stays unlocked with an anonymous sign-in; only its own code's data is read.
            hideOverlay();
            if (user) { authReady = true; setPillState("syncing"); if (window.__gscSMStart) window.__gscSMStart(db, user); }
            else { setPillState("offline"); window.__fb.signInAnonymously(auth).catch(function (e) { console.error("[GSC Sync] Showman sign-in:", e); }); }
            return;
          }
          if (user && user.isAnonymous) {
            // leftover sign-in from checking a showman code; ignore while a check is running
            if (!window.__gscSMChecking && auth.currentUser && auth.currentUser.isAnonymous) window.__fb.signOut(auth);
            return;
          }
          if (user) {
            authReady = true;
            hideOverlay();
            setPillState("syncing");
            startListening();
            flushQueue();
            if (window.__gscSMOwnerStart) window.__gscSMOwnerStart(db);
          } else {
            authReady = false;
            setPillState("locked");
            showOverlay();
          }
        },
        function (err) {
          // Auth state listener itself errored (e.g. no IndexedDB at all) —
          // degrade to "no sync", but never block the app.
          console.error("[GSC Sync] Auth listener error:", err && err.code, err);
          setPillState("error");
          hideOverlay();
        }
      );
    } catch (e) {
      // Any unexpected Firebase init failure: the sheep records already live
      // safely in localStorage, so never let a sync problem block the app.
      console.error("[GSC Sync] Firebase init failed:", e);
      setPillState("error");
      hideOverlay();
    }
  }

  // ---------------------------------------------------------------------
  // Boot — runs synchronously as the script parses (document.body already
  // exists since this tag sits right after <div id="root">).
  // ---------------------------------------------------------------------
  pillEl = buildStatusPill();
  overlayEl = buildOverlay();
  setPillState("locked");
  if (SM) hideOverlay();

  window.__gscPill = setPillState;

  window.addEventListener("online", function () {
    if (currentUser) setPillState("syncing");
  });
  window.addEventListener("offline", function () {
    setPillState("offline");
  });

  initFirebase();
})();
