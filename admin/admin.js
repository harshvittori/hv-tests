/* HV Test admin: sign in with the admin Google account, then read scorecard and test-finished numbers from Firestore.
   Access is enforced by the Firestore rules (isAdmin() = one Firebase account ID), not by this page.
   Open admin/?setup to see the signed-in account ID and the rules to paste (only needed to set or change the admin).
   Local testing: on localhost, add ?emu to use the Firebase emulators (auth 9099, Firestore 8089, project demo-hv). */
(function () {
  "use strict";
  var EMU = /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && /[?&]emu\b/.test(location.search);
  var CFG = Object.assign({}, HVScorecard.config, EMU ? { projectId: "demo-hv" } : {});
  var BASE = (EMU ? "http://127.0.0.1:8089" : "https://firestore.googleapis.com") + "/v1/projects/" + CFG.projectId + "/databases/(default)/documents";
  var DOCPATH = "projects/" + CFG.projectId + "/databases/(default)/documents";
  var RULES = "rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    // The HV Test admin: the Firebase account ID shown on hv-tests/admin after signing in\n    function isAdmin() {\n      return request.auth != null && request.auth.uid == 'ADMIN_UID_HERE';\n    }\n    // HV Vault: a signed-in user can read/write only their own data under users/{uid}/\n    match /users/{uid}/{document=**} {\n      allow read, write: if request.auth != null && request.auth.uid == uid;\n    }\n    // Harsh Reset progress sync. Only someone with the long private sync code can read or write it.\n    match /reset/{syncId} {\n      allow read: if syncId.size() >= 32;\n      allow write: if syncId.size() >= 32\n        && request.resource.data.keys().hasOnly(['json', 'updatedAt'])\n        && request.resource.data.json is string\n        && request.resource.data.json.size() < 500000;\n    }\n    // HV Test scorecards: anyone can check one by its ID; created once, never changed. Only the admin can list or delete.\n    match /scorecards/{id} {\n      allow get: if true;\n      allow list, delete: if isAdmin();\n      allow update: if false;\n      allow create: if id.matches('HVT-[A-Z]{2}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}')\n        && request.resource.data.keys().hasOnly(['v','id','name','test','testTitle','category','completedAt','score','level','answered','total','skills','strengths','focus'])\n        && request.resource.data.v == 1\n        && request.resource.data.id == id\n        && request.resource.data.name is string && request.resource.data.name.size() > 0 && request.resource.data.name.size() <= 60\n        && request.resource.data.test is string && request.resource.data.test.size() <= 60\n        && request.resource.data.testTitle is string && request.resource.data.testTitle.size() <= 80\n        && request.resource.data.category is string && request.resource.data.category.size() <= 60\n        && request.resource.data.level is string && request.resource.data.level.size() <= 40\n        && request.resource.data.completedAt is timestamp\n        && request.resource.data.completedAt > request.time - duration.value(2, 'd')\n        && request.resource.data.completedAt < request.time + duration.value(10, 'm')\n        && request.resource.data.score is int && request.resource.data.score >= 0 && request.resource.data.score <= 100\n        && request.resource.data.answered is int && request.resource.data.total is int\n        && request.resource.data.answered >= 0 && request.resource.data.answered <= request.resource.data.total && request.resource.data.total <= 200\n        && request.resource.data.skills is list && request.resource.data.skills.size() <= 20\n        && request.resource.data.strengths is list && request.resource.data.strengths.size() <= 5\n        && request.resource.data.focus is list && request.resource.data.focus.size() <= 5;\n    }\n    // HV World live settings (maintenance, banner, home page switches): anyone can read, only the admin can change\n    match /config/{doc} {\n      allow read: if true;\n      allow write: if isAdmin() && doc == 'site'\n        && request.resource.data.keys().hasOnly(['json', 'updatedAt', 'by'])\n        && request.resource.data.json is string && request.resource.data.json.size() < 100000;\n    }\n    // HV Test anonymous counter: one number per test per day (+1 when someone finishes a test). Only the admin can read it.\n    match /stats/{key} {\n      allow read: if isAdmin();\n      allow create: if key.matches('[a-z0-9-]{1,60}_20[0-9]{2}-[01][0-9]-[0-3][0-9]')\n        && request.resource.data.keys().hasOnly(['completed']) && request.resource.data.completed == 1;\n      allow update: if request.resource.data.keys().hasOnly(['completed'])\n        && request.resource.data.completed == resource.data.completed + 1;\n    }\n  }\n}";
  var LEVELS = HVScorecard.LEVELS.map(function (l) { return l[0]; });
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var num = function (n) { return Number(n || 0).toLocaleString("en-IN"); };

  firebase.initializeApp(CFG);
  var auth = firebase.auth();
  if (EMU) auth.useEmulator("http://127.0.0.1:9099");
  var user = null;

  /* ---------- Firestore REST ---------- */
  function dec(v) {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("timestampValue" in v) return new Date(v.timestampValue);
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
    if ("mapValue" in v) { var o = {}, f = v.mapValue.fields || {}; Object.keys(f).forEach(function (k) { o[k] = dec(f[k]); }); return o; }
    if ("nullValue" in v) return null;
    return null;
  }
  function fields(doc) { var o = {}, f = (doc && doc.fields) || {}; Object.keys(f).forEach(function (k) { o[k] = dec(f[k]); }); return o; }
  async function api(path, opts) {
    opts = opts || {};
    var h = { Authorization: "Bearer " + (await user.getIdToken()) };
    if (opts.body) h["Content-Type"] = "application/json";
    var ac = EMU ? null : await HVScorecard.appCheckToken();
    if (ac) h["X-Firebase-AppCheck"] = ac;
    var res = await fetch(BASE + path + (path.indexOf("?") < 0 ? "?" : "&") + "key=" + CFG.apiKey,
      { method: opts.method || (opts.body ? "POST" : "GET"), headers: h, body: opts.body ? JSON.stringify(opts.body) : undefined });
    if (!res.ok) { var e = new Error("HTTP " + res.status); e.status = res.status; throw e; }
    return res.status === 204 ? null : res.json();
  }
  var ts = function (d) { return { timestampValue: d.toISOString() }; };
  var whereGte = function (d) { return { fieldFilter: { field: { fieldPath: "completedAt" }, op: "GREATER_THAN_OR_EQUAL", value: ts(d) } }; };
  var whereLevel = function (l) { return { fieldFilter: { field: { fieldPath: "level" }, op: "EQUAL", value: { stringValue: l } } }; };
  async function aggregate(where, withAvg) {
    var q = { from: [{ collectionId: "scorecards" }] };
    if (where) q.where = where;
    var aggs = [{ alias: "n", count: {} }];
    if (withAvg) aggs.push({ alias: "avg", avg: { field: { fieldPath: "score" } } });
    var r = await api(":runAggregationQuery", { body: { structuredAggregationQuery: { structuredQuery: q, aggregations: aggs } } });
    var f = (r[0] && r[0].result && r[0].result.aggregateFields) || {};
    return { n: dec(f.n) || 0, avg: dec(f.avg) };
  }
  async function query(q) {
    var r = await api(":runQuery", { body: { structuredQuery: q } });
    return r.filter(function (x) { return x.document; }).map(function (x) { return fields(x.document); });
  }
  async function listAll(collection, pageSize) {
    var out = [], token = "";
    do {
      var r = await api("/" + collection + "?pageSize=" + pageSize + (token ? "&pageToken=" + encodeURIComponent(token) : ""));
      (r.documents || []).forEach(function (d) { var o = fields(d); o._key = d.name.split("/").pop(); out.push(o); });
      token = r.nextPageToken || "";
    } while (token);
    return out;
  }

  /* ---------- dates (India time) ---------- */
  var istDay = HVScorecard.istDay;
  function istStart(daysAgo) {
    var d = new Date(istDay() + "T00:00:00+05:30");
    d.setUTCDate(d.getUTCDate() - daysAgo);
    return d;
  }
  var DAYS = [];
  for (var i = 29; i >= 0; i--) DAYS.push(istDay(istStart(i)));

  /* ---------- screens ---------- */
  function show(id) { ["gate", "nope", "denied", "dash"].forEach(function (s) { $(s).hidden = s !== id; }); }
  // The setup helper (account ID + rules to paste) only shows with ?setup in the link; other accounts just see "Access denied"
  var SETUP = /[?&]setup\b/.test(location.search);
  $("signin").addEventListener("click", async function () {
    $("gate-status").textContent = "Opening Google sign-in...";
    try { await auth.signInWithPopup(new firebase.auth.GoogleAuthProvider()); }
    catch (e) { $("gate-status").textContent = e && e.code === "auth/popup-closed-by-user" ? "" : "Couldn't sign in. Please try again."; }
  });
  [$("signout"), $("d-out"), $("n-out")].forEach(function (b) { b.addEventListener("click", function () { auth.signOut(); }); });
  $("d-retry").addEventListener("click", load);
  $("refresh").addEventListener("click", load);
  $("d-copy").addEventListener("click", async function () {
    try { await navigator.clipboard.writeText($("d-rules").value); $("d-status").textContent = "Rules copied."; }
    catch (e) { $("d-rules").select(); $("d-status").textContent = "Press Ctrl+C to copy."; }
  });
  auth.onAuthStateChanged(function (u) {
    user = u;
    if (!u) { show("gate"); $("gate-status").textContent = ""; return; }
    load();
  });

  /* ---------- dashboard ---------- */
  var rows = [], cursor = null, PAGE = 50;
  async function load() {
    $("gate-status").textContent = "Loading...";
    try {
      var totals = await aggregate(null, true);
      showDash();
      $("k-total").textContent = num(totals.n);
      $("k-avg").textContent = totals.avg == null ? "-" : Math.round(totals.avg);
      var r = await Promise.all([aggregate(whereGte(istStart(0))), aggregate(whereGte(istStart(6))), aggregate(whereGte(istStart(29)))]
        .concat(LEVELS.map(function (l) { return aggregate(whereLevel(l)); })));
      $("k-today").textContent = num(r[0].n); $("k-7").textContent = num(r[1].n); $("k-30").textContent = num(r[2].n);
      renderLevels(r.slice(3).map(function (x) { return x.n; }), totals.n);
      var stats = await listAll("stats", 300);
      var finished = { total: 0, byDay: {}, first: null };
      stats.forEach(function (s) {
        var day = s._key.slice(-10);
        finished.total += s.completed || 0;
        finished.byDay[day] = (finished.byDay[day] || 0) + (s.completed || 0);
        if (!finished.first || day < finished.first) finished.first = day;
      });
      $("k-fin").textContent = num(finished.total);
      $("k-fin-s").textContent = finished.first ? "since " + fmtDay(finished.first) + " (counting began)" : "counting starts with the next finished test";
      var fin30 = DAYS.reduce(function (a, d) { return a + (finished.byDay[d] || 0); }, 0);
      $("k-conv").textContent = fin30 ? Math.min(100, Math.round(r[2].n / fin30 * 100)) + "%" : "-";
      $("k-nosave").textContent = fin30 ? num(Math.max(0, fin30 - r[2].n)) : "-";
      var recent = await query({ from: [{ collectionId: "scorecards" }], where: whereGte(istStart(29)), select: { fields: [{ fieldPath: "completedAt" }] }, limit: 20000 });
      var issuedByDay = {};
      recent.forEach(function (x) { var d = istDay(x.completedAt); issuedByDay[d] = (issuedByDay[d] || 0) + 1; });
      renderChart(finished.byDay, issuedByDay);
      rows = []; cursor = null; $("rows").innerHTML = ""; await loadMore();
      $("gate-status").textContent = "";
    } catch (e) {
      if (e.status === 403) return showDenied();
      show("gate"); $("gate-status").textContent = "Couldn't load the data (" + (e.message || "error") + "). Please try again.";
    }
  }
  function showDash() {
    show("dash");
    $("me-name").textContent = (user.displayName || "") + (user.email ? " (" + user.email + ")" : "");
    if (user.photoURL) $("me-pic").src = user.photoURL; else $("me-pic").hidden = true;
  }
  function showDenied() {
    if (!SETUP) { show("nope"); $("n-email").textContent = user.email || user.displayName || "another account"; return; }
    show("denied");
    $("d-email").textContent = user.email || user.displayName || "this account";
    $("d-uid").textContent = user.uid;
    $("d-rules").value = RULES.replace("ADMIN_UID_HERE", user.uid);
  }
  function fmtDay(d) { var p = d.split("-"); return Number(p[2]) + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(p[1]) - 1] + " " + p[0]; }

  function renderLevels(counts, total) {
    $("levels").innerHTML = LEVELS.map(function (l, i) {
      var pct = total ? Math.round(counts[i] / total * 100) : 0;
      return '<div class="lv"><span>' + l + '</span><i style="--w:' + pct + '%"></i><b>' + num(counts[i]) + ' <small style="color:var(--ink-faint);font-weight:400">' + pct + '%</small></b></div>';
    }).join("");
  }
  function renderChart(fin, iss) {
    var W = 600, H = 190, pad = 24, bw = (W - pad) / DAYS.length;
    var max = Math.max(1, Math.max.apply(null, DAYS.map(function (d) { return Math.max(fin[d] || 0, iss[d] || 0); })));
    var y = function (v) { return H - 22 - (H - 40) * v / max; };
    var bars = DAYS.map(function (d, i) {
      var x = pad + i * bw, f = fin[d] || 0, s = iss[d] || 0;
      return '<g><title>' + fmtDay(d) + ": " + f + " finished, " + s + " scorecards</title>" +
        '<rect x="' + (x + bw * .12) + '" y="' + y(f) + '" width="' + bw * .38 + '" height="' + (H - 22 - y(f)) + '" rx="2" fill="var(--line)"/>' +
        '<rect x="' + (x + bw * .5) + '" y="' + y(s) + '" width="' + bw * .38 + '" height="' + (H - 22 - y(s)) + '" rx="2" fill="var(--accent)"/></g>';
    }).join("");
    var labels = [0, 7, 14, 21, 29].map(function (i) { return '<text x="' + (pad + i * bw + bw / 2) + '" y="' + (H - 6) + '" font-size="10" text-anchor="middle" fill="var(--ink-faint)">' + fmtDay(DAYS[i]).slice(0, -5) + "</text>"; }).join("");
    var grid = '<text x="0" y="' + (y(max) + 4) + '" font-size="10" fill="var(--ink-faint)">' + max + '</text><line x1="' + pad + '" x2="' + W + '" y1="' + y(max) + '" y2="' + y(max) + '" stroke="var(--line)" stroke-dasharray="3 4"/>' +
      '<line x1="' + pad + '" x2="' + W + '" y1="' + (H - 22) + '" y2="' + (H - 22) + '" stroke="var(--line)"/>';
    $("chart").innerHTML = '<svg viewBox="0 0 ' + W + " " + H + '" role="img" aria-label="Tests finished and scorecards issued per day, last 30 days">' + grid + bars + labels + "</svg>";
  }

  /* ---------- table ---------- */
  var COLS = ["id", "name", "testTitle", "score", "level", "completedAt"];
  async function loadMore() {
    $("more").disabled = true; $("t-status").textContent = "Loading...";
    var q = { from: [{ collectionId: "scorecards" }], orderBy: [{ field: { fieldPath: "completedAt" }, direction: "DESCENDING" }], limit: PAGE,
      select: { fields: COLS.map(function (f) { return { fieldPath: f }; }) } };
    if (cursor) q.startAt = { values: [ts(cursor)], before: false };
    try {
      var got = await query(q);
      rows = rows.concat(got);
      if (got.length) cursor = got[got.length - 1].completedAt;
      $("more").hidden = got.length < PAGE;
      renderRows();
      $("t-status").textContent = rows.length ? "Showing " + num(rows.length) + " newest." : "No scorecards yet.";
    } catch (e) { $("t-status").textContent = "Couldn't load the list. Please refresh."; }
    $("more").disabled = false;
  }
  function renderRows() {
    var q = $("q").value.trim().toLowerCase();
    var list = q ? rows.filter(function (r) { return (r.name || "").toLowerCase().indexOf(q) >= 0 || (r.id || "").toLowerCase().indexOf(q) >= 0; }) : rows;
    $("rows").innerHTML = list.map(function (r) {
      var d = r.completedAt instanceof Date ? r.completedAt : new Date(r.completedAt);
      return '<tr data-id="' + esc(r.id) + '"><td class="id">' + esc(r.id) + "</td><td>" + esc(r.name) + '</td><td class="hide-s">' + esc(r.testTitle) +
        '</td><td class="n">' + esc(r.score) + '</td><td class="hide-s"><span class="pill">' + esc(r.level) + "</span></td><td>" +
        d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) +
        '</td><td class="acts"><a class="btn ghost small" href="../verify/#' + encodeURIComponent(r.id) + '" target="_blank" rel="noopener">View</a><button class="btn danger small" data-del="' + esc(r.id) + '">Delete</button></td></tr>';
    }).join("") || (q ? '<tr><td colspan="7" style="color:var(--ink-faint)">No match in the loaded list.</td></tr>' : "");
  }
  $("more").addEventListener("click", loadMore);
  $("q").addEventListener("input", async function () {
    renderRows();
    var id = HVScorecard.normalizeId($("q").value);
    if (id && !rows.some(function (r) { return r.id === id; })) {
      var res = await HVScorecard.lookup(id);
      if (res.ok && HVScorecard.normalizeId($("q").value) === id) { rows.unshift(res.record); renderRows(); }
    }
  });
  $("rows").addEventListener("click", async function (e) {
    var id = e.target.getAttribute && e.target.getAttribute("data-del");
    if (!id) return;
    if (!confirm("Delete scorecard " + id + "?\n\nIts QR code and ID will stop working. This can't be undone.")) return;
    e.target.disabled = true;
    try {
      await api("/scorecards/" + encodeURIComponent(id), { method: "DELETE" });
      rows = rows.filter(function (r) { return r.id !== id; }); renderRows();
      $("t-status").textContent = "Deleted " + id + ". Refresh to update the numbers.";
    } catch (err) { e.target.disabled = false; $("t-status").textContent = "Couldn't delete " + id + "."; }
  });
  $("csv").addEventListener("click", async function () {
    var b = $("csv"); b.disabled = true; $("t-status").textContent = "Preparing the CSV...";
    try {
      var all = await listAll("scorecards", 300);
      all.sort(function (a, c) { return c.completedAt - a.completedAt; });
      var head = ["ID", "Name", "Test", "Category", "Score", "Level", "Answered", "Total", "Issued (ISO)", "Strengths", "Work on"];
      var cell = function (v) { v = String(v == null ? "" : v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
      var lines = [head.join(",")].concat(all.map(function (r) {
        return [r.id, r.name, r.testTitle, r.category, r.score, r.level, r.answered, r.total, r.completedAt && r.completedAt.toISOString(), (r.strengths || []).join("; "), (r.focus || []).join("; ")].map(cell).join(",");
      }));
      var blob = new Blob(["﻿" + lines.join("\n")], { type: "text/csv" });
      var a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "hv-test-scorecards-" + istDay() + ".csv";
      document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
      $("t-status").textContent = "Downloaded " + num(all.length) + " scorecards.";
    } catch (e) { $("t-status").textContent = "Couldn't build the CSV."; }
    b.disabled = false;
  });
})();
