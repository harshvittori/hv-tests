/* HV Test Skill Assessment Scorecard: issue a checkable record and look one up.

   A scorecard is a short summary of one result (name, test, date, scores, level). It is saved only when the
   person asks for one, in Firestore (Firebase project "harsh-reset", collection "scorecards"), so anyone
   with the ID can check it on /hv-tests/verify/. Answers, age and profession are never saved.
   Records can be created and read by ID, never listed, changed or deleted (see the rules in AGENTS.md).

   It is an HV Test-issued self-assessment summary, NOT an accredited certification. Keep all wording that way. */
(function () {
  "use strict";

  var CFG = {
    apiKey: "AIzaSyDggasAVdqpvamkn1xeex2NmPUqG9JiZJ4",   // public web key (same Firebase web app as HV Vault)
    authDomain: "harsh-reset.firebaseapp.com",
    projectId: "harsh-reset",
    appId: "1:592094409539:web:57d3aa494464b867bbf5f6",
    appCheckSiteKey: "6LdZltEtAAAAANC5e-PJFqs2YrM1ubR3CKv0sOhl" // reCAPTCHA Enterprise, restricted to harshvittori.github.io
  };
  var DOCS = "https://firestore.googleapis.com/v1/projects/" + CFG.projectId + "/databases/(default)/documents/scorecards";
  var VERIFY_URL = "https://harshvittori.github.io/hv-tests/verify/";
  var VERIFY_SHOWN = "harshvittori.github.io/hv-tests/verify";
  var ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // 32 characters, no 0/O/1/I so IDs are easy to read out
  var ID_RE = /^HVT-[A-Z]{2}-[2-9A-HJ-NP-Z]{4}-[2-9A-HJ-NP-Z]{4}$/;
  var LEVELS = [["Developing", "0-40"], ["Emerging", "41-65"], ["Grounded", "66-85"], ["Highly Consistent", "86-100"]];

  function newId(code) {
    var bytes = new Uint8Array(8), s = "";
    crypto.getRandomValues(bytes);
    for (var i = 0; i < 8; i++) s += ALPHABET[bytes[i] & 31];
    return "HVT-" + code + "-" + s.slice(0, 4) + "-" + s.slice(4);
  }
  // Accepts pasted IDs with spaces, lower case, missing dashes or a full verify link
  function normalizeId(input) {
    var s = String(input || "").trim();
    var hash = s.indexOf("#");
    if (hash >= 0) s = s.slice(hash + 1);
    s = decodeURIComponent(s).toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!/^HVT[A-Z]{2}[A-Z0-9]{8}$/.test(s)) return null;
    var id = "HVT-" + s.slice(3, 5) + "-" + s.slice(5, 9) + "-" + s.slice(9);
    return ID_RE.test(id) ? id : null;
  }
  function verifyLink(id) { return VERIFY_URL + "#" + id; }

  /* ---------- App Check (only on the live site; the key is locked to that domain) ---------- */
  var appCheckReady = null;
  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[src="' + src + '"]')) return resolve();
      var el = document.createElement("script");
      el.src = src; el.onload = resolve; el.onerror = reject;
      document.head.appendChild(el);
    });
  }
  function withTimeout(p, ms) {
    return Promise.race([p, new Promise(function (resolve) { setTimeout(function () { resolve(null); }, ms); })]);
  }
  function appCheckToken() {
    if (location.hostname !== "harshvittori.github.io") return Promise.resolve(null);
    if (!appCheckReady) {
      var SDK = "https://www.gstatic.com/firebasejs/10.12.2/";
      appCheckReady = (async function () {
        if (!window.firebase) await loadScript(SDK + "firebase-app-compat.js");
        if (!window.firebase.appCheck) await loadScript(SDK + "firebase-app-check-compat.js");
        var app = window.firebase.apps.length ? window.firebase.app() : window.firebase.initializeApp(CFG);
        var ac = window.firebase.appCheck(app);
        try { ac.activate(new window.firebase.appCheck.ReCaptchaEnterpriseProvider(CFG.appCheckSiteKey), true); } catch (e) {}
        return ac;
      })().catch(function () { return null; });
    }
    return withTimeout(appCheckReady.then(function (ac) {
      if (!ac) return null;
      return ac.getToken(false).then(function (r) { return (r && r.token) || null; }, function () { return null; });
    }), 6000);
  }

  /* ---------- Firestore REST encoding ---------- */
  function enc(v) {
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (v && typeof v === "object") return { mapValue: { fields: encFields(v) } };
    return { stringValue: String(v) };
  }
  function encFields(o) { var f = {}; Object.keys(o).forEach(function (k) { f[k] = enc(o[k]); }); return f; }
  function dec(v) {
    if (!v) return null;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("timestampValue" in v) return new Date(v.timestampValue);
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(dec);
    if ("mapValue" in v) return decFields(v.mapValue.fields || {});
    return null;
  }
  function decFields(f) { var o = {}; Object.keys(f).forEach(function (k) { o[k] = dec(f[k]); }); return o; }

  async function headers(json) {
    var h = json ? { "Content-Type": "application/json" } : {};
    var t = await appCheckToken();
    if (t) h["X-Firebase-AppCheck"] = t;
    return h;
  }
  function friendly(status) {
    if (status === 0) return "No internet connection. Check it and try again.";
    if (status === 429) return "Too many requests right now. Try again in a minute.";
    return "Couldn't save your scorecard right now. Please try again in a moment.";
  }

  // Saves a new record under a fresh ID. Retries with another ID in the rare case one is taken.
  async function issue(record, code) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var id = newId(code), rec = Object.assign({}, record, { v: 1, id: id }), res;
      try {
        res = await fetch(DOCS + "?documentId=" + id + "&key=" + CFG.apiKey, {
          method: "POST", headers: await headers(true), body: JSON.stringify({ fields: encFields(rec) })
        });
      } catch (e) { return { ok: false, error: friendly(0) }; }
      if (res.ok) return { ok: true, record: rec };
      if (res.status === 409) continue;
      return { ok: false, status: res.status, error: friendly(res.status) };
    }
    return { ok: false, error: friendly(500) };
  }

  async function lookup(id) {
    var res;
    try { res = await fetch(DOCS + "/" + encodeURIComponent(id) + "?key=" + CFG.apiKey, { headers: await headers(false) }); }
    catch (e) { return { ok: false, error: "No internet connection. Check it and try again." }; }
    if (res.status === 404) return { ok: false, notFound: true };
    if (!res.ok) return { ok: false, status: res.status, error: "Couldn't check this ID right now. Please try again in a moment." };
    var json = await res.json();
    var rec = decFields(json.fields || {});
    if (rec.id !== id) return { ok: false, notFound: true };
    return { ok: true, record: rec };
  }

  /* ---------- On-screen card (design B) ---------- */
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function dateText(d) {
    d = d instanceof Date ? d : new Date(d);
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }
  function barColor(v) { return v >= 9 ? "#127A4F" : v >= 7 ? "#3E9A6E" : v >= 6 ? "#E3A23B" : "#D98A2B"; }
  function skillOf(rec, name) {
    var s = (rec.skills || []).filter(function (x) { return x.name === name; })[0];
    return s ? " " + s.score : "";
  }
  function qrSvg(text, size) {
    if (!window.qrcode) return "";
    var q = window.qrcode(0, "M"); q.addData(text); q.make();
    var n = q.getModuleCount(), m = 2, d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (q.isDark(r, c)) d += "M" + (c + m) + " " + (r + m) + "h1v1h-1z";
    return '<svg class="qr" width="' + size + '" height="' + size + '" viewBox="0 0 ' + (n + m * 2) + " " + (n + m * 2) +
      '" role="img" aria-label="QR code to check this scorecard" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + d + '" fill="#17231C"/></svg>';
  }
  function loadQr() {
    return window.qrcode ? Promise.resolve() :
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js").catch(function () {});
  }

  var CSS = [
    ".hvsc{--g:#127A4F;--gi:#0B4F33;--amber:#FFC54D;--ink:#17231C;--soft:#4A5A50;--faint:#6F8177;--ln:#DCE7DF;--tint:#F4F8F5;",
    "background:#fff;color:var(--ink);border:1px solid var(--ln);border-radius:16px;overflow:hidden;box-shadow:0 12px 32px -18px rgba(12,40,26,.45);text-align:left;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".hvsc .sc-hero{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;padding:22px 22px 20px;background:linear-gradient(135deg,#0F5A3B,#127A4F 60%,#1A8E5E);color:#fff}",
    ".hvsc .sc-top{display:flex;align-items:center;justify-content:space-between;gap:10px;grid-column:1/-1}",
    ".hvsc .sc-word{font-family:'Outfit',-apple-system,'Segoe UI',sans-serif;font-weight:700;font-size:15px;letter-spacing:.04em;display:inline-flex;align-items:center;gap:8px}",
    ".hvsc .sc-word b{color:var(--amber);font-weight:600}",
    ".hvsc .sc-word svg{border-radius:7px;box-shadow:0 0 0 1.5px rgba(255,255,255,.55)}",
    ".hvsc .sc-kind{font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.8);text-align:right}",
    ".hvsc .sc-name{font:400 27px/1.15 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif;margin:4px 0 4px;overflow-wrap:anywhere}",
    ".hvsc .sc-test{margin:0;color:rgba(255,255,255,.85);font-size:13.5px}",
    ".hvsc .sc-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:14px}",
    ".hvsc .sc-meta span{display:grid;gap:2px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.7)}",
    ".hvsc .sc-meta b{font-size:13px;letter-spacing:0;text-transform:none;color:#fff;font-weight:600}",
    ".hvsc .sc-meta .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    ".hvsc .sc-ring{position:relative;width:128px;height:128px}",
    ".hvsc .sc-ring svg{width:100%;height:100%;display:block}",
    ".hvsc .sc-ring div{position:absolute;inset:0;display:grid;place-items:center;text-align:center}",
    ".hvsc .sc-ring strong{font:600 40px/1 'Iowan Old Style','Palatino Linotype',Palatino,Georgia,serif}",
    ".hvsc .sc-ring small{font-size:14px;opacity:.8}",
    ".hvsc .sc-ring em{display:block;font-style:normal;font-size:10px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--amber);margin-top:5px;max-width:90px;line-height:1.25}",
    ".hvsc .sc-body{display:grid;gap:18px;padding:20px 22px}",
    ".hvsc h4{margin:0 0 10px;font-size:10.5px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}",
    ".hvsc .sc-bar{display:grid;grid-template-columns:minmax(0,138px) 1fr 26px;gap:10px;align-items:center;font-size:13px;margin-bottom:8px;font-variant-numeric:tabular-nums}",
    ".hvsc .sc-bar i{height:8px;border-radius:99px;background:#E6EFE9;position:relative;overflow:hidden}",
    ".hvsc .sc-bar i::after{content:'';position:absolute;inset:0;width:var(--w);border-radius:99px;background:var(--c)}",
    ".hvsc .sc-bar b{text-align:right;font-weight:700}",
    ".hvsc .sc-scale{display:flex;justify-content:space-between;font-size:10px;color:var(--faint);margin:0 36px 0 148px}",
    ".hvsc .sc-pills{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}",
    ".hvsc .sc-pill{padding:11px 13px;border-radius:12px}",
    ".hvsc .sc-pill h5{margin:0 0 5px;font-size:12px;font-weight:700}",
    ".hvsc .sc-pill ul{margin:0;padding-left:17px;font-size:12.5px;line-height:1.5}",
    ".hvsc .sc-good{background:#E9F5EE}.hvsc .sc-good h5{color:var(--gi)}",
    ".hvsc .sc-grow{background:#FDF3E1}.hvsc .sc-grow h5{color:#8A5A10}",
    ".hvsc .sc-next{background:var(--tint);border:1px solid var(--ln)}",
    ".hvsc .sc-levels{display:flex;flex-wrap:wrap;gap:6px;font-size:11px;color:var(--soft)}",
    ".hvsc .sc-levels span{padding:3px 9px;border-radius:99px;border:1px solid var(--ln)}",
    ".hvsc .sc-levels .on{background:var(--g);border-color:var(--g);color:#fff;font-weight:700}",
    ".hvsc .sc-strip{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;align-items:center;padding:14px 22px;background:var(--tint);border-top:1px solid var(--ln)}",
    ".hvsc .sc-strip .qr{display:block;border-radius:6px;border:1px solid var(--ln);background:#fff}",
    ".hvsc .sc-v{font-size:12.5px;line-height:1.55;color:var(--soft)}",
    ".hvsc .sc-v b{color:var(--ink);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-weight:600;white-space:nowrap}",
    ".hvsc .sc-v a{color:var(--g);font-weight:600}",
    ".hvsc .sc-status{display:inline-flex;align-items:center;gap:6px;font-size:11.5px;font-weight:700;color:var(--gi);background:#DFF1E6;padding:3px 10px;border-radius:99px;margin-bottom:4px}",
    ".hvsc .sc-status::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--g)}",
    ".hvsc .sc-disc{grid-column:1/-1;font-size:11.5px;color:var(--faint);border-top:1px dashed var(--ln);padding-top:8px;margin-top:4px}",
    "@media (max-width:480px){.hvsc .sc-hero{padding:18px 16px;gap:12px}.hvsc .sc-name{font-size:23px}.hvsc .sc-ring{width:100px;height:100px}",
    ".hvsc .sc-ring strong{font-size:31px}.hvsc .sc-ring small{font-size:12px}.hvsc .sc-ring em{font-size:9px;max-width:74px}",
    ".hvsc .sc-body{padding:16px}.hvsc .sc-strip{padding:12px 16px}.hvsc .sc-bar{grid-template-columns:minmax(0,118px) 1fr 22px;font-size:12.5px;gap:8px}",
    ".hvsc .sc-scale{margin:0 30px 0 126px}.hvsc .sc-kind{font-size:9.5px;max-width:120px}}"
  ].join("\n");
  function ensureCss() {
    if (document.getElementById("hvsc-css")) return;
    var st = document.createElement("style"); st.id = "hvsc-css"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  var MARK = '<svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#127A4F"/><circle cx="16.5" cy="16.5" r="5.5" stroke="#fff" stroke-width="3" fill="none"/><circle cx="31.5" cy="16.5" r="5.5" stroke="#fff" stroke-width="3" fill="none"/><circle cx="16.5" cy="31.5" r="5.5" stroke="#fff" stroke-width="3" fill="none"/><circle cx="31.5" cy="31.5" r="7.5" fill="#FFC54D"/><path d="M28 31.6l2.5 2.5 4.8-5" stroke="#17231C" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // opts.next: optional "Next 30 days" lines (shown to the owner, not saved in the record)
  function cardHTML(rec, opts) {
    ensureCss();
    opts = opts || {};
    var C = 314.16, off = (C * (1 - Math.max(0, Math.min(100, rec.score)) / 100)).toFixed(2);
    var link = verifyLink(rec.id);
    var list = function (items, withScore) {
      return "<ul>" + items.map(function (n) { return "<li>" + esc(n) + (withScore ? esc(skillOf(rec, n)) : "") + "</li>"; }).join("") + "</ul>";
    };
    return '<article class="hvsc" aria-label="Skill Assessment Scorecard for ' + esc(rec.name) + '">' +
      '<div class="sc-hero">' +
        '<div class="sc-top"><span class="sc-word">' + MARK + 'HV <b>TEST</b></span><span class="sc-kind">Skill Assessment Scorecard</span></div>' +
        "<div>" +
          '<h3 class="sc-name">' + esc(rec.name) + "</h3>" +
          '<p class="sc-test">' + esc(rec.testTitle) + " | " + esc(rec.category) + "</p>" +
          '<div class="sc-meta"><span>Completed<b>' + esc(dateText(rec.completedAt)) + '</b></span><span>ID<b class="mono">' + esc(rec.id) +
            "</b></span><span>Answered<b>" + esc(rec.answered) + " of " + esc(rec.total) + "</b></span></div>" +
        "</div>" +
        '<div class="sc-ring"><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="50" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="11"/>' +
          '<circle cx="60" cy="60" r="50" fill="none" stroke="#FFC54D" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + C + '" stroke-dashoffset="' + off + '" transform="rotate(-90 60 60)"/></svg>' +
          '<div><span><strong>' + esc(rec.score) + "<small>/100</small></strong><em>" + esc(rec.level) + "</em></span></div></div>" +
      "</div>" +
      '<div class="sc-body">' +
        "<div><h4>Skill-wise score | out of 10</h4>" +
          (rec.skills || []).map(function (s) {
            return '<div class="sc-bar"><span>' + esc(s.name) + '</span><i style="--w:' + (s.score * 10) + "%;--c:" + barColor(s.score) + '"></i><b>' + esc(s.score) + "</b></div>";
          }).join("") +
          '<div class="sc-scale" aria-hidden="true"><span>0</span><span>5</span><span>10</span></div></div>' +
        '<div class="sc-pills">' +
          '<div class="sc-pill sc-good"><h5>Strengths</h5>' + list(rec.strengths || [], true) + "</div>" +
          '<div class="sc-pill sc-grow"><h5>Work on</h5>' + list(rec.focus || [], true) + "</div>" +
          (opts.next && opts.next.length ? '<div class="sc-pill sc-next"><h5>Next 30 days</h5>' + list(opts.next, false) + "</div>" : "") +
        "</div>" +
        "<div><h4>Performance level</h4><div class=\"sc-levels\">" + LEVELS.map(function (l) {
          return "<span" + (l[0] === rec.level ? ' class="on"' : "") + ">" + l[0] + " " + l[1] + "</span>";
        }).join("") + "</div></div>" +
      "</div>" +
      '<div class="sc-strip">' +
        (window.qrcode ? qrSvg(link, 72) : "") +
        '<div class="sc-v"><span class="sc-status">Completed</span><br>Check this record at <a href="' + esc(link) + '" target="_blank" rel="noopener">' + VERIFY_SHOWN +
          "</a> with ID <b>" + esc(rec.id) + "</b></div>" +
        '<div class="sc-disc">Issued by HV Test. A self-assessment, not an accredited certification or qualification.</div>' +
      "</div>" +
    "</article>";
  }

  window.HVScorecard = {
    issue: issue, lookup: lookup, cardHTML: cardHTML, loadQr: loadQr, normalizeId: normalizeId,
    verifyLink: verifyLink, dateText: dateText, barColor: barColor, LEVELS: LEVELS,
    VERIFY_URL: VERIFY_URL, VERIFY_SHOWN: VERIFY_SHOWN, ID_RE: ID_RE
  };
})();
