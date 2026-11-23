// Gehret Sheep Co — showman codes (v55)
//
// Loaded after sync.js and before bundle.js.
//
// OWNER phones (signed in with the passcode):
//   * Find showman codes typed on exhibitor cards (Show Lambs > Roster > Exhibitors).
//   * For every code you've set up and turned on in Settings > Showman Codes, publish a
//     copy of ONLY that showman's sheep (per year the code is typed) to Firestore at
//     gsc_sm/{hash of code}. Price and county are never published.
//   * Watch gsc_sm/*/inbox for entries showmen add, check them against that code's
//     permissions, apply them to your records (tagged with who entered them), log them,
//     then delete them from the inbox.
//
// SHOWMAN phones (unlocked with a code):
//   * Read only gsc_sm/{their hash} and fill the app's normal storage with it, so the regular
//     Show Lambs screens work.
//   * When the app saves, compare against what they were sent; allowed changes go to
//     their inbox (queued offline by Firestore), anything not allowed is put back.
(function () {
  "use strict";
  var LS = "gsc:";
  var SM = window.__gscShowman || null;
  var TABS = ["roster", "weights", "feeds", "health", "weighday", "calendar", "results"];
  var KIND = { weight: "weights", feed: "feedLog", health: "records" };

  function lsGet(k) { try { var v = localStorage.getItem(LS + k); return v == null ? null : JSON.parse(v); } catch (e) { return null; } }
  function lsSet(k, v) { localStorage.setItem(LS + k, JSON.stringify(v)); }
  function norm(c) { return String(c || "").trim().toUpperCase().replace(/\s+/g, ""); }
  function nname(s) { return String(s || "").trim().toLowerCase(); }
  function rid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function fmt(d) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d || ""); return m ? (+m[2]) + "/" + (+m[3]) + "/" + m[1] : (d || ""); }
  function hashCode(c) {
    var b = new TextEncoder().encode("gsc-sm:" + norm(c));
    return crypto.subtle.digest("SHA-256", b).then(function (h) {
      return Array.from(new Uint8Array(h)).map(function (x) { return (x < 16 ? "0" : "") + x.toString(16); }).join("").slice(0, 40);
    });
  }
  function showmanMatch(names, txt) {
    var parts = String(txt || "").split(/\s*[\/,&]\s*|\s+and\s+/i).map(nname);
    return names.some(function (n) { return parts.indexOf(nname(n)) >= 0; });
  }
  function canEdit(perms, k) {
    if (!perms) return false;
    if (k === "weight") return perms.weights === "edit" || perms.weighday === "edit";
    if (k === "feed") return perms.feeds === "edit";
    if (k === "health") return perms.health === "edit";
    if (k === "result") return perms.results === "edit";
    return false;
  }
  function fieldTab(f) { return f === "targetWeight" || f === "targetDate" ? "weighday" : "roster"; }
  var LOCKED_FIELDS = { id: 1, showman: 1, price: 1, county: 1, by: 1, byName: 1 };
  function blank(v) { return v == null || v === ""; }

  // ---- shared: apply one showman entry to a year's records -------------------------
  function applyOp(d, op) {
    d.weights = d.weights || {}; d.feedLog = d.feedLog || {}; d.records = d.records || {};
    d.showResults = d.showResults || []; d.sheep = d.sheep || [];
    var tag = { by: op.by, byName: op.byName };
    if (op.k === "sheep") {
      var s = d.sheep.filter(function (x) { return x.id === op.sid; })[0];
      if (!s) return { ok: false, msg: "sheep not found" };
      Object.keys(op.patch || {}).forEach(function (f) { if (!LOCKED_FIELDS[f]) s[f] = op.patch[f]; });
      return { ok: true };
    }
    if (op.k === "result") {
      var arr = d.showResults, i = -1;
      arr.forEach(function (r, j) { if (r.id === op.e.id) i = j; });
      if (op.a === "del") { if (i < 0) return { ok: true }; if (arr[i].by !== op.by) return { ok: false, msg: "not their entry" }; arr.splice(i, 1); return { ok: true }; }
      var ne = Object.assign({}, op.e, tag, { sheepId: op.sid });
      if (i >= 0) { if (arr[i].by !== op.by) return { ok: false, msg: "not their entry" }; arr[i] = ne; } else arr.push(ne);
      return { ok: true };
    }
    var key = KIND[op.k]; if (!key) return { ok: false, msg: "unknown" };
    var list = (d[key][op.sid] || []).slice(), k = -1;
    list.forEach(function (x, j) { if (x.id === op.e.id) k = j; });
    var conflict = null;
    if (op.a === "del") {
      if (k < 0) return { ok: true };
      if (list[k].by !== op.by) return { ok: false, msg: "not their entry" };
      list.splice(k, 1);
    } else if (k >= 0) {
      if (list[k].by !== op.by) return { ok: false, msg: "not their entry" };
      list[k] = Object.assign({}, op.e, tag);
    } else {
      if (op.k === "weight") {
        var mine = list.filter(function (x) { return x.date === op.e.date && x.by !== op.by; })[0];
        if (mine) conflict = { y: op.y, sid: op.sid, mine: mine.id, theirs: op.e.id, date: op.e.date, mineW: mine.weight, theirsW: op.e.weight };
      }
      list.push(Object.assign({}, op.e, tag));
    }
    list.sort(function (a, b) { return new Date(a.date) - new Date(b.date); });
    d[key][op.sid] = list;
    return { ok: true, conflict: conflict };
  }

  function summary(op, sheepName) {
    var e = op.e || {}, v = op.a === "add" ? "Added" : op.a === "edit" ? "Changed" : "Deleted";
    if (op.k === "weight") return v + " weight" + (e.weight != null ? " " + e.weight + " lb" : "") + (e.date ? " on " + fmt(e.date) : "");
    if (op.k === "feed") return v + " feed record" + (e.date ? " for " + fmt(e.date) : "");
    if (op.k === "health") return v + " health record" + (e.product || e.type ? ": " + (e.product || e.type) : "") + (e.date ? " on " + fmt(e.date) : "");
    if (op.k === "result") return v + " result" + (e.placing ? ": " + e.placing : "") + (e.showName ? " at " + e.showName : "");
    if (op.k === "sheep") return "Changed " + Object.keys(op.patch || {}).join(", ");
    return v;
  }

  // =====================================================================================
  // OWNER
  // =====================================================================================
  var owner = null, pubTimer = null, hashToCode = {};
  function cfg() { var c = lsGet("sheepwrld:showman") || {}; c.codes = c.codes || {}; return c; }
  function scan() {
    var years = lsGet("sheepwrld:years") || [], map = {};
    years.forEach(function (y) {
      if (y === "All Time") return;
      var d = lsGet("sheepwrld:showbarn:" + y); if (!d) return;
      (d.exhibitors || []).forEach(function (e) {
        var c = norm(e.code); if (!c) return;
        var m = map[c] || (map[c] = { code: c, years: {}, names: [] });
        (m.years[y] = m.years[y] || []).push(e.name);
        if (e.name && m.names.indexOf(e.name) < 0) m.names.push(e.name);
      });
    });
    return map;
  }
  function codeSheep(c, y) {
    var f = scan()[c]; if (!f || !f.years[y]) return [];
    var d = lsGet("sheepwrld:showbarn:" + y) || {};
    return (d.sheep || []).filter(function (s) { return showmanMatch(f.years[y], s.showman); });
  }
  function buildYear(d, names, perms) {
    var ids = {};
    var sheep = (d.sheep || []).filter(function (s) { return showmanMatch(names, s.showman); });
    sheep.forEach(function (s) { ids[s.id] = 1; });
    function pick(m) { var o = {}; Object.keys(m || {}).forEach(function (k) { if (ids[k]) o[k] = m[k]; }); return o; }
    function hid(t) { return !perms[t] || perms[t] === "hidden"; }
    return {
      exhibitors: (d.exhibitors || []).filter(function (e) { return names.some(function (n) { return nname(n) === nname(e.name); }); })
        .map(function (e) { var c = Object.assign({}, e); delete c.code; return c; }),
      sheep: sheep.map(function (s) { var c = Object.assign({}, s); delete c.price; delete c.county; return c; }),
      weights: hid("weights") && hid("weighday") ? {} : pick(d.weights),
      records: hid("health") ? {} : pick(d.records),
      feedLog: hid("feeds") ? {} : pick(d.feedLog),
      customFeeds: hid("feeds") ? [] : (d.customFeeds || []),
      shows: hid("calendar") ? [] : (d.shows || []).map(function (sh) {
        var c = Object.assign({}, sh);
        c.attendees = (sh.attendees || []).filter(function (i) { return ids[i]; });
        Object.keys(c).forEach(function (k) {
          var v = c[k];
          if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length && Object.keys(v).every(function (i) { return /^[a-z0-9]{6,}$/i.test(i); })) {
            var o = {}; Object.keys(v).forEach(function (i) { if (ids[i]) o[i] = v[i]; }); c[k] = o;
          }
        });
        return c;
      }),
      showResults: hid("results") ? [] : (d.showResults || []).filter(function (r) { return ids[r.sheepId]; })
    };
  }
  function schedulePublish() { if (!owner) return; clearTimeout(pubTimer); pubTimer = setTimeout(publishAll, 2000); }
  async function publishAll() {
    if (!owner) return;
    var FB = window.__fb, db = owner.db, c = cfg(), found = scan(), log = lsGet("sheepwrld:showmanlog") || [];
    var known = lsGet("__smknown") || {}, codes = {};
    Object.keys(c.codes).forEach(function (k) { codes[k] = 1; });
    Object.keys(found).forEach(function (k) { codes[k] = 1; });
    Object.keys(known).forEach(function (k) { codes[k] = 1; });
    for (var code in codes) {
      try {
        var h = known[code] || await hashCode(code); hashToCode[h] = code;
        var conf = c.codes[code], f = found[code];
        if (!conf || !conf.setup) { if (!known[code]) continue; }
        var active = !!(conf && conf.setup && conf.on && f);
        var perms = (conf && conf.perms) || {};
        var root = {
          active: active, label: f ? f.names.join(" & ") : ((lsGet("__smpub:" + h) || {}).label || ""),
          perms: perms, years: f ? Object.keys(f.years).sort().reverse() : ((lsGet("__smpub:" + h) || {}).years || []),
          products: active && perms.health && perms.health !== "hidden" ? (lsGet("sheepwrld:healthproducts") || []) : [],
          processed: log.filter(function (l) { return l.code === code; }).map(function (l) { return l.id; }).slice(-300)
        };
        if (active) {
          for (var y in f.years) {
            var d = lsGet("sheepwrld:showbarn:" + y); if (!d) continue;
            var data = JSON.stringify(buildYear(d, f.years[y], perms)), pk = "__smpub:" + h + ":" + y;
            if (localStorage.getItem(LS + pk) !== data) {
              await FB.setDoc(FB.doc(db, "gsc_sm", h, "years", y), { data: data, ts: Date.now() });
              localStorage.setItem(LS + pk, data);
            }
          }
        }
        var prev = lsGet("__smpub:" + h);
        if (!prev || !same(prev, root)) {
          await FB.setDoc(FB.doc(db, "gsc_sm", h), Object.assign({}, root, { updated: Date.now() }));
          lsSet("__smpub:" + h, root);
        }
        known[code] = h;
      } catch (e) { console.error("[GSC Showman] publish failed for a code:", e && e.code, e); }
    }
    lsSet("__smknown", known);
  }
  function pushKey(k, v) { var s = JSON.stringify(v); localStorage.setItem(LS + k, s); if (window.__gscSyncPush) window.__gscSyncPush(k, s); if (window.gxExtSet) window.gxExtSet(k, v); }
  function addLog(entry) {
    var log = lsGet("sheepwrld:showmanlog") || [];
    if (log.some(function (l) { return l.id === entry.id; })) return false;
    log.push(entry); if (log.length > 500) log = log.slice(-500);
    pushKey("sheepwrld:showmanlog", log); return true;
  }
  // v64: showman entries wait for the owner's approval in sheepwrld:showmanpending
  function pendList() { return lsGet("sheepwrld:showmanpending") || []; }
  function sameEntry(a, b) {
    if (a.code !== b.code || a.y !== b.y || a.k !== b.op.k || a.sid !== b.op.sid) return false;
    if (a.k === "sheep") return true;
    return a.e && b.op.e && a.e.id === b.op.e.id;
  }
  function queueForApproval(code, label, op, sheepName) {
    var pend = pendList(), log = lsGet("sheepwrld:showmanlog") || [];
    if (pend.some(function (x) { return x.id === op.id; }) || log.some(function (l) { return l.id === op.id; })) return;
    var probe = { code: code, y: op.y, k: op.k, sid: op.sid, e: op.e }, prev = pend.filter(function (x) { return sameEntry(probe, x); })[0];
    var hidden = function (why) { addLog({ id: op.id, ts: Date.now(), code: code, label: label, y: op.y, k: op.k, a: op.a, sid: op.sid, sheep: sheepName, text: summary(op), seen: true, hidden: true, rejected: why }); };
    if (prev && op.k !== "sheep" && op.a === "del" && prev.op.a === "add") {
      // they deleted something you never approved: it never happened
      pend = pend.filter(function (x) { return x !== prev; });
      addLog({ id: prev.id, ts: Date.now(), code: code, label: label, y: prev.y, k: prev.op.k, a: prev.op.a, sid: prev.op.sid, sheep: prev.sheep, text: prev.text, seen: true, hidden: true, rejected: "withdrawn" });
      hidden("withdrawn");
    } else if (prev) {
      if (op.k === "sheep") prev.op.patch = Object.assign({}, prev.op.patch, op.patch);
      else if (op.a === "del") prev.op = Object.assign({}, op);
      else prev.op.e = op.e;
      prev.text = summary(prev.op); prev.ts = Date.now();
      hidden("combined");
    } else {
      pend.push({ id: op.id, ts: Date.now(), code: code, label: label, y: op.y, sid: op.sid, sheep: sheepName, text: summary(op, sheepName), op: op });
    }
    pushKey("sheepwrld:showmanpending", pend);
  }
  function applyApproved(x) {
    var op = x.op, key = "sheepwrld:showbarn:" + op.y, d = lsGet(key);
    if (!d) return { ok: false, msg: "that year is gone" };
    if (!(d.sheep || []).some(function (s) { return s.id === op.sid; })) return { ok: false, msg: "sheep no longer in " + op.y };
    var res = applyOp(d, op);
    if (res.ok) pushKey(key, d);
    return res;
  }
  async function handleInbox(docSnap) {
    var FB = window.__fb, ref = docSnap.ref, h = ref.parent.parent.id, code = hashToCode[h];
    if (!code) { await publishAll(); code = hashToCode[h]; }
    var op; try { op = JSON.parse(docSnap.data().op); } catch (e) { op = null; }
    var log = lsGet("sheepwrld:showmanlog") || [];
    if (!op || !code || log.some(function (l) { return l.id === op.id; })) { try { await FB.deleteDoc(ref); } catch (e) {} return; }
    var conf = cfg().codes[code], f = scan()[code];
    var label = f ? f.names.join(" & ") : code;
    op.by = "sm:" + h.slice(0, 10); op.byName = label; // who entered it comes from the code, never from the phone
    var res = { ok: false, msg: "code is off" }, sheepName = "", ok = false;
    if (conf && conf.setup && conf.on && f && f.years[op.y]) {
      var key = "sheepwrld:showbarn:" + op.y, d = lsGet(key) || {};
      var mineSheep = (d.sheep || []).filter(function (s) { return showmanMatch(f.years[op.y], s.showman); });
      var s = mineSheep.filter(function (x) { return x.id === op.sid; })[0];
      sheepName = s ? s.name : "";
      if (!s) res = { ok: false, msg: "not their sheep" };
      else if (op.k === "sheep") {
        var patch = {}, bad = false;
        Object.keys(op.patch || {}).forEach(function (fl) { if (LOCKED_FIELDS[fl] || conf.perms[fieldTab(fl)] !== "edit") bad = true; else patch[fl] = op.patch[fl]; });
        op.patch = patch;
        if (bad && !Object.keys(patch).length) res = { ok: false, msg: "no permission" }; else ok = true;
      } else if (!canEdit(conf.perms, op.k)) res = { ok: false, msg: "no permission" };
      else ok = true;
    }
    if (ok) queueForApproval(code, label, op, sheepName);
    else addLog({ id: op.id, ts: Date.now(), code: code, label: label, y: op.y, k: op.k, a: op.a, sid: op.sid, sheep: sheepName,
      text: summary(op, sheepName), seen: false, rejected: res.msg, conflict: null });
    try { await FB.deleteDoc(ref); } catch (e) { console.error("[GSC Showman] inbox delete failed:", e); }
    schedulePublish();
  }
  window.__gscSMOwnerStart = function (db) {
    if (SM || owner) return;
    owner = { db: db };
    var FB = window.__fb;
    // v65: no live listener — showman entries are pulled in only when you open Settings or tap Check now
    publishAll();
  };
  window.__gscSMOwnerTouch = function (key) {
    if (!owner) return;
    if (key === "*" || /^sheepwrld:(showbarn:|showman$|healthproducts$|years$)/.test(key)) schedulePublish();
  };
  // UI helpers for Settings > Showman Codes
  function decide(ids, approve) {
    var pend = pendList(), want = {}, any = false;
    ids.forEach(function (id) { want[id] = 1; });
    pend.filter(function (x) { return want[x.id]; }).sort(function (a, b) { return (a.op.ts || a.ts) - (b.op.ts || b.ts); }).forEach(function (x) {
      var res = approve ? applyApproved(x) : { ok: false, msg: "denied" };
      addLog({ id: x.id, ts: Date.now(), code: x.code, label: x.label, y: x.y, k: x.op.k, a: x.op.a, sid: x.sid, sheep: x.sheep, text: x.text,
        seen: !(res && res.conflict), approved: approve && res.ok, denied: !approve, rejected: res.ok ? null : (approve ? res.msg : "denied"), conflict: res.conflict || null });
      any = any || (approve && res.ok);
    });
    pushKey("sheepwrld:showmanpending", pendList().filter(function (x) { return !want[x.id]; }));
    if (any) { try { window.dispatchEvent(new Event("gsc-reload-season")); } catch (e) {} }
    schedulePublish();
  }
  var checking = null;
  function checkInbox() {
    if (!owner) return Promise.resolve({ ok: false, msg: "Not connected yet" });
    if (checking) return checking;
    var FB = window.__fb;
    checking = (owner.ready || (owner.ready = publishAll())).then(function () {
      return FB.getDocs(FB.collectionGroup(owner.db, "inbox"));
    }).then(async function (snap) {
      var docs = []; snap.forEach(function (x) { docs.push(x); });
      for (var i = 0; i < docs.length; i++) await handleInbox(docs[i]);
      lsSet("__smchecked", Date.now()); if (window.gxExtSet) window.gxExtSet("gx:smchecked", Date.now());
      return { ok: true, n: docs.length };
    }).catch(function (e) { console.error("[GSC Showman] check failed:", e && e.code, e); return { ok: false, msg: navigator.onLine === false ? "No signal" : "Couldn't check" }; })
      .then(function (r) { checking = null; return r; });
    return checking;
  }
  window.gscSM = {
    check: checkInbox, lastChecked: function () { return lsGet("__smchecked") || 0; }, ready: function () { return !!owner; },
    approve: function (ids) { decide(ids, true); }, deny: function (ids) { decide(ids, false); },
    scan: scan, norm: norm, codeSheep: codeSheep, publish: schedulePublish,
    resolve: function (logId, keep) {
      var log = lsGet("sheepwrld:showmanlog") || [], l = log.filter(function (x) { return x.id === logId; })[0];
      if (!l || !l.conflict) return;
      var c = l.conflict, key = "sheepwrld:showbarn:" + c.y, d = lsGet(key) || {}, w = (d.weights || {})[c.sid] || [];
      var drop = keep === "mine" ? c.theirs : c.mine;
      d.weights[c.sid] = w.filter(function (x) { return x.id !== drop; });
      pushKey(key, d);
      l.conflict = Object.assign({}, c, { resolved: keep }); l.seen = true;
      pushKey("sheepwrld:showmanlog", log);
      try { window.dispatchEvent(new Event("gsc-reload-season")); } catch (e) {}
      schedulePublish();
    }
  };

  // =====================================================================================
  // SHOWMAN
  // =====================================================================================
  var smDb = null, smStarted = false;
  function root() { return lsGet("__smroot") || { active: false, perms: {}, years: [], label: "" }; }
  function pending() { return lsGet("__smpend") || []; }
  function expected(y) {
    var base = lsGet("__smbase:" + y); if (!base) return null;
    var d = clone(base), r = root();
    pending().forEach(function (op) { if (op.y === y) applyOp(d, Object.assign({}, op, { by: SM.by, byName: r.label })); });
    return d;
  }
  var SEND_EVERY = 15 * 60 * 1000, IDLE_PAUSE = (+localStorage.getItem("gsc:__smIdleMs")) || 30 * 60 * 1000, smNextSend = 0, smPaused = false;
  function smNotify() { if (window.gxExtSet) window.gxExtSet("gx:smtick", Date.now()); smStatus(); }
  function sendOutbox() {
    if (!SM || !smDb) return 0;
    var FB = window.__fb, pend = pending(), n = 0;
    pend.forEach(function (op) {
      if (op.sent) return;
      op.sent = Date.now(); n++;
      var o = Object.assign({}, op); delete o.sent;
      FB.setDoc(FB.doc(smDb, "gsc_sm", SM.h, "inbox", op.id), { op: JSON.stringify(o), ts: op.ts, by: SM.by })
        .catch(function (e) { console.error("[GSC Showman] send failed:", e && e.code, e); });
    });
    lsSet("__smpend", pend); smNextSend = Date.now() + SEND_EVERY; smNotify();
    return n;
  }
  function smStatus() {
    if (!SM) return;
    var p = pending(), un = p.filter(function (o) { return !o.sent; }).length, wait = p.length - un, el = document.getElementById("gsc-sm-status");
    var txt = [smPaused ? "Paused \u2014 tap to resume" : "", un ? un + " waiting to send" : "", wait ? wait + " waiting for approval" : ""].filter(Boolean).join(" \u00b7 ");
    if (!txt) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement("div"); el.id = "gsc-sm-status";
      el.style.cssText = "position:fixed;bottom:10px;left:10px;z-index:9998;font:600 11px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:4px 9px;border-radius:999px;background:#8a6d00;color:#fff;pointer-events:none;";
      document.body.appendChild(el);
    }
    el.textContent = txt;
  }
  function rebuild(reload) {
    var r = root(), changed = false;
    (r.years || []).forEach(function (y) {
      var e = expected(y); if (!e) return;
      var s = JSON.stringify(e);
      if (localStorage.getItem(LS + "sheepwrld:showbarn:" + y) !== s) { localStorage.setItem(LS + "sheepwrld:showbarn:" + y, s); changed = true; }
    });
    var ys = JSON.stringify(r.years || []);
    if (localStorage.getItem(LS + "sheepwrld:years") !== ys) { localStorage.setItem(LS + "sheepwrld:years", ys); changed = true; }
    if (r.products) localStorage.setItem(LS + "sheepwrld:healthproducts", JSON.stringify(r.products));
    if (changed && reload) { try { window.dispatchEvent(new Event("gsc-reload-season")); } catch (e) {} }
    return changed;
  }
  function toast(msg) {
    var t = document.createElement("div");
    t.textContent = msg;
    t.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(46px + env(safe-area-inset-bottom));z-index:99998;background:#8C4A4A;color:#fff;" +
      "font:600 13px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 6px 18px rgba(0,0,0,.4);max-width:90vw;text-align:center;";
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3800);
  }
  function smBanner() {
    var r = root(), el = document.getElementById("gsc-sm-off");
    if (r.active) { if (el) el.remove(); return; }
    if (el) return;
    el = document.createElement("div"); el.id = "gsc-sm-off";
    el.textContent = "View only — this code has been turned off. Your records are still here to look at.";
    el.style.cssText = "position:sticky;top:0;z-index:9996;background:#5a5a5a;color:#fff;padding:8px 12px;text-align:center;font:600 12px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;";
    document.body.insertBefore(el, document.body.firstChild);
  }
  function diffYear(base, next, me, perms, active) {
    var ops = [], bad = [], quiet = [];
    var A = {}; (base.sheep || []).forEach(function (s) { A[s.id] = s; });
    var B = {}; (next.sheep || []).forEach(function (s) { B[s.id] = s; });
    Object.keys(B).forEach(function (id) {
      if (!A[id]) { bad.push("adding sheep"); return; }
      var a = A[id], b = B[id], patch = {}, any = false;
      Object.keys(Object.assign({}, a, b)).forEach(function (f) {
        if (f === "id" || same(a[f], b[f]) || (blank(a[f]) && blank(b[f]))) return;
        if (!active || LOCKED_FIELDS[f] || perms[fieldTab(f)] !== "edit") { bad.push("changing " + f); return; }
        patch[f] = b[f]; any = true;
      });
      if (any) ops.push({ k: "sheep", a: "edit", sid: id, patch: patch });
    });
    Object.keys(A).forEach(function (id) { if (!B[id]) bad.push("removing sheep"); });
    [["weight", "weights"], ["feed", "feedLog"], ["health", "records"]].forEach(function (kk) {
      var k = kk[0], key = kk[1], AA = base[key] || {}, BB = next[key] || {}, ok = active && canEdit(perms, k);
      Object.keys(Object.assign({}, AA, BB)).forEach(function (sid) {
        if (!A[sid]) return;
        var a = AA[sid] || [], b = BB[sid] || [], am = {}, bm = {};
        a.forEach(function (e) { if (e && e.id) am[e.id] = e; });
        b.forEach(function (e) { if (e && !e.id) e.id = rid(); if (e) bm[e.id] = e; });
        b.forEach(function (e) {
          var o = am[e.id];
          if (o && same(o, e)) return;
          if (o) { var o2 = Object.assign({}, o), e2 = Object.assign({}, e); delete o2.by; delete o2.byName; delete e2.by; delete e2.byName; if (same(o2, e2)) return; }
          if (!ok) { bad.push(k); return; }
          if (o && o.by !== me) { bad.push(k + " entered by Gehret Sheep Co"); return; }
          var ce = Object.assign({}, e); delete ce.by; delete ce.byName;
          ops.push({ k: k, a: o ? "edit" : "add", sid: sid, e: ce });
        });
        a.forEach(function (e) {
          if (!e || !e.id || bm[e.id]) return;
          // Weigh Day replaces a same-day weight; keep yours and let the new one be flagged instead
          if (k === "weight" && e.by !== me && b.some(function (x) { return x && x.date === e.date && !am[x.id]; })) { quiet.push(1); return; }
          if (!ok || e.by !== me) { bad.push("deleting " + k); return; }
          ops.push({ k: k, a: "del", sid: sid, e: { id: e.id } });
        });
      });
    });
    var RA = {}, RB = {};
    (base.showResults || []).forEach(function (r) { RA[r.id] = r; });
    (next.showResults || []).forEach(function (r) { if (!r.id) r.id = rid(); RB[r.id] = r; });
    var rok = active && canEdit(perms, "result");
    Object.keys(RB).forEach(function (id) {
      var o = RA[id], e = RB[id];
      if (o && same(o, e)) return;
      if (!rok || !A[e.sheepId] || (o && o.by !== me)) { bad.push("result"); return; }
      var ce = Object.assign({}, e); delete ce.by; delete ce.byName;
      ops.push({ k: "result", a: o ? "edit" : "add", sid: e.sheepId, e: ce });
    });
    Object.keys(RA).forEach(function (id) {
      if (RB[id]) return;
      if (!rok || RA[id].by !== me) { bad.push("deleting result"); return; }
      ops.push({ k: "result", a: "del", sid: RA[id].sheepId, e: { id: id } });
    });
    if (!same(base.exhibitors || [], next.exhibitors || [])) bad.push("exhibitor info");
    return { ops: ops, bad: bad, quiet: quiet.length > 0 };
  }
  window.__gscSMLocal = function (key, value) {
    if (!SM) return;
    var m = /^sheepwrld:showbarn:(.+)$/.exec(key || "");
    var r = root();
    if (!m || (r.years || []).indexOf(m[1]) < 0) return; // everything else stays on this phone only
    var y = m[1], base = expected(y); if (!base) return;
    var next; try { next = JSON.parse(value); } catch (e) { return; }
    var res = diffYear(base, next, SM.by, r.perms || {}, !!r.active);
    if (res.ops.length) {
      var pend = pending();
      res.ops.forEach(function (op) { op.id = rid(); op.y = y; op.ts = Date.now(); op.sent = 0; pend.push(op); });
      lsSet("__smpend", pend); smNotify();
    }
    if (!res.bad.length && res.quiet) setTimeout(function () { rebuild(true); }, 50);
    if (res.bad.length) {
      // put back what isn't allowed (keeps the allowed changes just sent)
      setTimeout(function () { rebuild(true); toast(r.active ? "That change isn't allowed in your view, so it wasn't saved." : "This code is view only now — changes aren't saved."); }, 50);
    }
  };
  window.__gscSMStart = function (db) {
    if (!SM || smStarted) return;
    smStarted = true; smDb = db;
    var FB = window.__fb;
    // entries are held on the phone and sent every 15 minutes (or with Send now)
    smNextSend = Date.now() + SEND_EVERY;
    setInterval(function () { if (!smPaused) sendOutbox(); }, SEND_EVERY);
    // v65: after 30 minutes without a tap, stop syncing until they touch the app again
    var lastTouch = Date.now();
    function touch() {
      lastTouch = Date.now();
      if (smPaused) {
        smPaused = false;
        FB.enableNetwork(db).catch(function () {}).then(function () { sendOutbox(); smNotify(); });
      }
    }
    ["pointerdown", "keydown", "touchstart"].forEach(function (ev) { document.addEventListener(ev, touch, true); });
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") touch(); });
    setInterval(function () {
      if (!smPaused && Date.now() - lastTouch > IDLE_PAUSE) {
        smPaused = true; FB.disableNetwork(db).catch(function () {}); smNotify();
        if (window.__gscPill) window.__gscPill("offline");
      }
    }, Math.min(60 * 1000, IDLE_PAUSE / 2));
    smNotify();
    FB.onSnapshot(FB.doc(db, "gsc_sm", SM.h), function (snap) {
      var r = root();
      if (!snap.exists()) r.active = false;
      else {
        var x = snap.data();
        r = { active: !!x.active, label: x.label || r.label, perms: x.perms || {}, years: (x.years && x.years.length ? x.years : r.years) || [], products: x.products || [], processed: x.processed || [] };
        var done = {}; r.processed.forEach(function (id) { done[id] = 1; });
        var week = Date.now() - 1000 * 60 * 60 * 24 * 30;
        lsSet("__smpend", pending().filter(function (op) { return !done[op.id] && op.ts > week; }));
      }
      lsSet("__smroot", r);
      rebuild(true); smBanner(); smStatus();
      if (window.__gscPill) window.__gscPill(navigator.onLine === false ? "offline" : "synced");
      if (window.gxExtSet) window.gxExtSet("gx:smroot", r);
    }, function (err) { console.error("[GSC Showman] code listener:", err && err.code, err); });
    FB.onSnapshot(FB.collection(db, "gsc_sm", SM.h, "years"), function (snap) {
      snap.docChanges().forEach(function (ch) {
        if (ch.type === "removed") return;
        try { lsSet("__smbase:" + ch.doc.id, JSON.parse(ch.doc.data().data)); } catch (e) {}
      });
      rebuild(true);
    }, function (err) { console.error("[GSC Showman] years listener:", err && err.code, err); });
  };
  window.__gscSMTryCode = async function (code, auth, db) {
    window.__gscSMChecking = true;
    try { return await tryCode(code, auth, db); } finally { window.__gscSMChecking = false; }
  };
  async function tryCode(code, auth, db) {
    var FB = window.__fb, c = norm(code);
    if (c.length < 4 || !window.crypto || !crypto.subtle) return false;
    var h = await hashCode(c);
    try { if (!auth.currentUser) await FB.signInAnonymously(auth); }
    catch (e) { return false; } // anonymous sign-in not turned on yet, or offline
    var snap;
    try { snap = await FB.getDoc(FB.doc(db, "gsc_sm", h)); } catch (e) { await FB.signOut(auth).catch(function () {}); return false; }
    if (!snap.exists()) { if (auth.currentUser && auth.currentUser.isAnonymous) await FB.signOut(auth).catch(function () {}); return false; }
    var x = snap.data(), ys = await FB.getDocs(FB.collection(db, "gsc_sm", h, "years"));
    if (localStorage.getItem(LS + "sheepwrld:herd") && !confirm("This phone has Gehret Sheep Co records on it. Switch it to the showman view for this code?")) {
      await FB.signOut(auth).catch(function () {}); location.reload(); return true;
    }
    Object.keys(localStorage).forEach(function (k) { if (k.indexOf(LS) === 0) localStorage.removeItem(k); });
    ys.forEach(function (d) { try { lsSet("__smbase:" + d.id, JSON.parse(d.data().data)); } catch (e) {} });
    lsSet("__smroot", { active: !!x.active, label: x.label || "", perms: x.perms || {}, years: x.years || [], products: x.products || [], processed: x.processed || [] });
    lsSet("sheepwrld:prefs", { openView: "showbarn", showTab: "roster" });
    SM = { h: h, by: "sm:" + h.slice(0, 10) };
    rebuild(false);
    localStorage.setItem(LS + "__sm", JSON.stringify(SM));
    location.reload();
    return true;
  }
  window.gscSMLeave = function () {
    if (!confirm("Leave the showman view on this phone? You'll need the code to get back in.")) return;
    Object.keys(localStorage).forEach(function (k) { if (k.indexOf(LS) === 0) localStorage.removeItem(k); });
    var go = function () { location.reload(); };
    try { window.__fb.signOut(window.__fb.getAuth()).then(go, go); } catch (e) { go(); }
  };
  window.gscSMInfo = function () {
    if (!SM) return null;
    var p = pending();
    return { root: root(), pending: p.length, unsent: p.filter(function (o) { return !o.sent; }).length,
      waiting: p.filter(function (o) { return o.sent; }).map(function (o) { return { id: o.id, y: o.y, text: summary(o) }; }),
      queued: p.filter(function (o) { return !o.sent; }).map(function (o) { return { id: o.id, y: o.y, text: summary(o) }; }),
      nextSend: smNextSend, paused: smPaused };
  };
  window.gscSMSendNow = function () { return sendOutbox(); };
})();
