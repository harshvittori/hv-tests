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
  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateText(d) {
    d = d instanceof Date ? d : new Date(d);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  /* ---------- Scorecard fonts, served from assets/fonts next to this script ---------- */
  var FONT_BASE = (function () { try { return new URL("fonts/", document.currentScript.src).href; } catch (e) { return "fonts/"; } })();
  var FONTS = [["HVSerif", "CormorantGaramond-SemiBold.ttf", "600"], ["HVSerif", "CormorantGaramond-SemiBoldItalic.ttf", "600", "italic"], ["HVMono", "JetBrainsMono-Medium.ttf", "500"],
               ["HVOutfit", "Outfit-Regular.ttf", "400"], ["HVOutfit", "Outfit-SemiBold.ttf", "600"], ["HVOutfit", "Outfit-Bold.ttf", "700"]];
  var fontsReady = null;
  function loadFonts() {
    if (!fontsReady) {
      fontsReady = Promise.all(FONTS.map(function (f) {
        if (!window.FontFace) return null;
        var face = new FontFace(f[0], "url(" + FONT_BASE + f[1] + ")", { weight: f[2], style: f[3] || "normal" });
        return face.load().then(function (x) { document.fonts.add(x); }, function () {});
      })).catch(function () {});
    }
    return fontsReady;
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
    ".hvsc{--g:#127A4F;--gi:#0B4F33;--amber:#F2C14E;--ink:#17231C;--soft:#4A5A50;--faint:#6F8177;--ln:#DCE7DF;--tint:#F4F8F5;",
    "background:#fff;color:var(--ink);border:1px solid var(--ln);border-radius:16px;overflow:hidden;box-shadow:0 12px 32px -18px rgba(12,40,26,.45);text-align:left;font-family:HVOutfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}",
    ".hvsc .sc-hero{display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;padding:22px 22px 20px;background:#0E5438;color:#fff;border-bottom:4px solid #F2C14E}",
    ".hvsc .sc-top{display:flex;align-items:center;justify-content:space-between;gap:10px;grid-column:1/-1}",
    ".hvsc .sc-word{font-family:'Outfit',-apple-system,'Segoe UI',sans-serif;font-weight:700;font-size:15px;letter-spacing:.04em;display:inline-flex;align-items:center;gap:8px}",
    ".hvsc .sc-word b{color:var(--amber);font-weight:600}",
    ".hvsc .sc-word svg{border-radius:7px;box-shadow:0 0 0 1.5px rgba(255,255,255,.55)}",
    ".hvsc .sc-kind{font-size:10.5px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:rgba(255,255,255,.8);text-align:right}",
    ".hvsc .sc-name{font:italic 600 34px/1.1 HVSerif,'Iowan Old Style',Georgia,serif;margin:4px 0 4px;overflow-wrap:anywhere}",
    ".hvsc .sc-test{margin:0;color:rgba(255,255,255,.85);font-size:13.5px}",
    ".hvsc .sc-meta{display:flex;flex-wrap:wrap;gap:8px 18px;margin-top:14px}",
    ".hvsc .sc-meta span{display:grid;gap:2px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.7)}",
    ".hvsc .sc-meta b{font-size:13px;letter-spacing:0;text-transform:none;color:#fff;font-weight:600}",
    ".hvsc .sc-meta .mono{font-family:HVMono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}",
    ".hvsc .sc-ring{position:relative;width:128px;height:128px}",
    ".hvsc .sc-ring svg{width:100%;height:100%;display:block}",
    ".hvsc .sc-ring div{position:absolute;inset:0;display:grid;place-items:center;text-align:center}",
    ".hvsc .sc-ring strong{font:600 46px/1 HVSerif,'Iowan Old Style',Georgia,serif}",
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
    ".hvsc .sc-status.sc-pre{color:#8A5A10;background:#FDF3E1}.hvsc .sc-status.sc-pre::before{background:#E3A23B}",
    ".hvsc .sc-disc{grid-column:1/-1;font-size:11.5px;color:var(--faint);border-top:1px dashed var(--ln);padding-top:8px;margin-top:4px}",
    "@media (max-width:480px){.hvsc .sc-hero{padding:18px 16px;gap:12px}.hvsc .sc-name{font-size:23px}.hvsc .sc-ring{width:100px;height:100px}",
    ".hvsc .sc-ring strong{font-size:31px}.hvsc .sc-ring small{font-size:12px}.hvsc .sc-ring em{font-size:8.5px;letter-spacing:.05em;max-width:78px}",
    ".hvsc .sc-body{padding:16px}.hvsc .sc-strip{padding:12px 16px}.hvsc .sc-bar{grid-template-columns:minmax(0,118px) 1fr 22px;font-size:12.5px;gap:8px}",
    ".hvsc .sc-scale{margin:0 30px 0 126px}.hvsc .sc-kind{font-size:9.5px;max-width:120px}}"
  ].join("\n");
  function ensureCss() {
    if (document.getElementById("hvsc-css")) return;
    loadFonts();
    var st = document.createElement("style"); st.id = "hvsc-css"; st.textContent = CSS;
    document.head.appendChild(st);
  }
  var MARK = '<svg width="24" height="24" viewBox="0 0 48 48" aria-hidden="true"><rect width="48" height="48" rx="12" fill="#127A4F"/><circle cx="16.5" cy="16.5" r="5.5" stroke="#fff" stroke-width="3" fill="none"/><circle cx="31.5" cy="16.5" r="5.5" stroke="#fff" stroke-width="3" fill="none"/><circle cx="16.5" cy="31.5" r="5.5" stroke="#fff" stroke-width="3" fill="none"/><circle cx="31.5" cy="31.5" r="7.5" fill="#FFC54D"/><path d="M28 31.6l2.5 2.5 4.8-5" stroke="#17231C" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // opts.next: optional "Next 30 days" lines (shown to the owner, not saved in the record)
  // A record without an id is a preview: same card, but no ID or QR until it is saved
  function cardHTML(rec, opts) {
    ensureCss();
    opts = opts || {};
    var C = 314.16, off = (C * (1 - Math.max(0, Math.min(100, rec.score)) / 100)).toFixed(2);
    var saved = !!rec.id, link = saved ? verifyLink(rec.id) : "";
    var list = function (items, withScore) {
      return "<ul>" + items.map(function (n) { return "<li>" + esc(n) + (withScore ? esc(skillOf(rec, n)) : "") + "</li>"; }).join("") + "</ul>";
    };
    return '<article class="hvsc" aria-label="Skill Assessment Scorecard for ' + esc(rec.name) + '">' +
      '<div class="sc-hero">' +
        '<div class="sc-top"><span class="sc-word">' + MARK + 'HV <b>TEST</b></span><span class="sc-kind">Skill Assessment Scorecard</span></div>' +
        "<div>" +
          '<h3 class="sc-name">' + esc(rec.name) + "</h3>" +
          '<p class="sc-test">' + esc(rec.testTitle) + " | " + esc(rec.category) + "</p>" +
          '<div class="sc-meta"><span>Completed<b>' + esc(dateText(rec.completedAt)) + '</b></span><span>ID<b class="mono">' + (saved ? esc(rec.id) : "Given when saved") +
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
        (saved ? (window.qrcode ? qrSvg(link, 72) : "") +
        '<div class="sc-v"><span class="sc-status">Completed</span><br>Scan the QR code to check this scorecard.<br>ID <b>' + esc(rec.id) + "</b></div>"
        : '<div class="sc-v" style="grid-column:1/-1"><span class="sc-status sc-pre">Preview</span><br>Save it below to get a unique ID and QR code, so anyone can scan and check it.</div>') +
        '<div class="sc-disc">Issued by HV Test. A self-assessment, not an accredited certification or qualification.</div>' +
      "</div>" +
    "</article>";
  }

  /* ---------- Scorecard as an image (1080 x 1350 PNG, 4:5 so it fits WhatsApp, Instagram and LinkedIn) ---------- */
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function spaced(ctx, px) { if ("letterSpacing" in ctx) ctx.letterSpacing = px + "px"; }
  function drawMark(ctx, x, y, size) {
    var k = size / 48;
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    ctx.fillStyle = "#127A4F"; rr(ctx, 0, 0, 48, 48, 12); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
    [[16.5, 16.5], [31.5, 16.5], [16.5, 31.5]].forEach(function (c) { ctx.beginPath(); ctx.arc(c[0], c[1], 5.5, 0, Math.PI * 2); ctx.stroke(); });
    ctx.fillStyle = "#FFC54D"; ctx.beginPath(); ctx.arc(31.5, 31.5, 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#17231C"; ctx.lineWidth = 2.6; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(28, 31.6); ctx.lineTo(30.5, 34.1); ctx.lineTo(35.3, 29.1); ctx.stroke();
    ctx.restore();
  }
  function fit(ctx, text, maxW, font, size, min) {
    do { ctx.font = font.replace("{s}", size); } while (ctx.measureText(text).width > maxW && --size > min);
    return size;
  }
  function wrap(ctx, text, maxW) {
    var words = String(text).split(" "), lines = [], line = "";
    words.forEach(function (w) { var t = line ? line + " " + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line);
    return lines;
  }
  var SERIF = "HVSerif,'Iowan Old Style',Georgia,serif";
  var SANS = "HVOutfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  var MONO = "HVMono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

  async function renderImage(rec) {
    await loadQr();
    await loadFonts();
    var W = 1080, H = 1350, L = 64, R = W - 64, saved = !!rec.id;
    var cv = document.createElement("canvas"); cv.width = W; cv.height = H;
    var ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);

    // Hero: deep green, faint rings around the score, gold rule
    var GOLD = "#F2C14E", MINT = "#C4E5D3", DIM = "#96C7AE";
    var cx = 862, cy = 250, r = 116;
    ctx.fillStyle = "#0E5438"; ctx.fillRect(0, 0, W, 440);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, 440); ctx.clip();
    ctx.strokeStyle = "#1B6546"; ctx.lineWidth = 1.6;
    [185, 240, 295, 350, 405].forEach(function (rad) { ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke(); });
    ctx.restore();
    ctx.fillStyle = GOLD; ctx.fillRect(0, 440, W, 5);
    ctx.fillStyle = "#fff"; rr(ctx, L - 4, 52, 64, 64, 16); ctx.fill();
    drawMark(ctx, L, 56, 56);
    ctx.textBaseline = "alphabetic";
    spaced(ctx, 1.5);
    ctx.font = "700 40px " + SANS; ctx.fillStyle = "#fff"; ctx.fillText("HV", L + 80, 99);
    var hvw = ctx.measureText("HV ").width;
    ctx.font = "600 40px " + SANS; ctx.fillStyle = GOLD; ctx.fillText("TEST", L + 80 + hvw, 99);
    spaced(ctx, 4.5); ctx.font = "600 19px " + SANS; ctx.fillStyle = GOLD; ctx.textAlign = "right";
    ctx.fillText("SKILL ASSESSMENT SCORECARD", R, 92); ctx.textAlign = "left";
    spaced(ctx, 4); ctx.font = "600 17px " + SANS; ctx.fillStyle = DIM; ctx.fillText("SCORECARD FOR", L, 158);
    spaced(ctx, 0);
    fit(ctx, rec.name, 590, "italic 600 {s}px " + SERIF, 88, 40);
    ctx.fillStyle = "#fff"; ctx.fillText(rec.name, L, 238);
    ctx.font = "400 29px " + SANS; ctx.fillStyle = MINT; ctx.fillText(rec.testTitle + "   \u00B7   " + rec.category, L, 286);
    ctx.fillStyle = "#26704F"; ctx.fillRect(L, 316, 560, 2);
    var meta = [["COMPLETED", dateText(rec.completedAt), SANS, 176], ["SCORECARD ID", saved ? rec.id : "Given when saved", saved ? MONO : SANS, 260], ["ANSWERED", rec.answered + " of " + rec.total, SANS, 0]];
    var mx = L;
    meta.forEach(function (m) {
      spaced(ctx, 3.5); ctx.font = "600 16px " + SANS; ctx.fillStyle = DIM; ctx.fillText(m[0], mx, 358);
      spaced(ctx, 0); ctx.font = (m[2] === MONO ? "500 26px " : "600 28px ") + m[2]; ctx.fillStyle = "#fff"; ctx.fillText(m[1], mx, 398);
      mx += Math.max(m[3], ctx.measureText(m[1]).width + 40);
    });

    // Ring
    ctx.lineWidth = 24; ctx.strokeStyle = "#216C4C"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    var sc = Math.max(0, Math.min(100, rec.score));
    if (sc > 0) { ctx.strokeStyle = GOLD; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sc / 100); ctx.stroke(); ctx.lineCap = "butt"; }
    ctx.font = "600 116px " + SERIF; var sw = ctx.measureText(String(rec.score)).width;
    ctx.font = "400 30px " + SANS; var ow = ctx.measureText("/100").width;
    ctx.fillStyle = "#fff"; ctx.font = "600 116px " + SERIF; ctx.fillText(String(rec.score), cx - (sw + ow) / 2, cy + 20);
    ctx.font = "400 30px " + SANS; ctx.fillStyle = MINT; ctx.fillText("/100", cx - (sw + ow) / 2 + sw, cy + 20);
    spaced(ctx, 3); ctx.textAlign = "center"; ctx.fillStyle = GOLD;
    fit(ctx, rec.level.toUpperCase(), 150, "600 {s}px " + SANS, 20, 13); ctx.fillText(rec.level.toUpperCase(), cx, cy + 62);
    ctx.textAlign = "left"; spaced(ctx, 0);

    // Skill bars
    var label = function (t, x, y) { spaced(ctx, 3); ctx.font = "700 18px " + SANS; ctx.fillStyle = "#6F8177"; ctx.fillText(t, x, y); spaced(ctx, 0); };
    label("SKILL-WISE SCORE  |  OUT OF 10", L, 510);
    var y = 566, bx = 330, bw = 220;
    (rec.skills || []).forEach(function (s) {
      ctx.font = "400 27px " + SANS; ctx.fillStyle = "#17231C"; ctx.fillText(s.name, L, y);
      ctx.fillStyle = "#E6EFE9"; rr(ctx, bx, y - 17, bw, 14, 7); ctx.fill();
      if (s.score > 0) { ctx.fillStyle = barColor(s.score); rr(ctx, bx, y - 17, Math.max(14, bw * s.score / 10), 14, 7); ctx.fill(); }
      ctx.font = "700 27px " + SANS; ctx.fillStyle = "#17231C"; ctx.textAlign = "right"; ctx.fillText(String(s.score), 600, y); ctx.textAlign = "left";
      y += 53;
    });
    ctx.font = "400 17px " + SANS; ctx.fillStyle = "#6F8177";
    ctx.fillText("0", bx, y - 18); ctx.textAlign = "center"; ctx.fillText("5", bx + bw / 2, y - 18); ctx.textAlign = "right"; ctx.fillText("10", bx + bw, y - 18); ctx.textAlign = "left";

    // Strengths / Work on
    var px = 648, pw = R - px;
    var pill = function (py, title, items, fill, tc) {
      var h = 64 + items.length * 36;
      ctx.fillStyle = fill; rr(ctx, px, py, pw, h, 20); ctx.fill();
      ctx.font = "700 26px " + SANS; ctx.fillStyle = tc; ctx.fillText(title, px + 26, py + 46);
      ctx.font = "400 25px " + SANS; ctx.fillStyle = "#17231C";
      items.forEach(function (n, i) {
        var s = (rec.skills || []).filter(function (x) { return x.name === n; })[0];
        var yy = py + 86 + i * 36;
        ctx.beginPath(); ctx.arc(px + 32, yy - 8, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillText(n + (s ? "  " + s.score : ""), px + 48, yy);
      });
      return py + h + 22;
    };
    var py = pill(478, "Strengths", rec.strengths || [], "#E9F5EE", "#0B4F33");
    py = pill(py, "Work on", rec.focus || [], "#FDF3E1", "#8A5A10");

    // Performance level
    label("PERFORMANCE LEVEL", px, py + 24);
    var ly = py + 44;
    LEVELS.forEach(function (lv) {
      var on = lv[0] === rec.level, t = lv[0] + "  " + lv[1];
      ctx.font = (on ? "700 " : "400 ") + "21px " + SANS;
      var w = ctx.measureText(t).width + 30;
      if (on) { ctx.fillStyle = "#127A4F"; rr(ctx, px, ly, w, 34, 17); ctx.fill(); ctx.fillStyle = "#fff"; }
      else { ctx.strokeStyle = "#DCE7DF"; ctx.lineWidth = 2; rr(ctx, px, ly, w, 34, 17); ctx.stroke(); ctx.fillStyle = "#4A5A50"; }
      ctx.fillText(t, px + 15, ly + 24);
      ly += 40;
    });

    // Check strip
    var sy = 1112;
    ctx.fillStyle = "#F4F8F5"; ctx.fillRect(0, sy, W, H - sy);
    ctx.fillStyle = "#DCE7DF"; ctx.fillRect(0, sy, W, 2);
    var tx = L;
    if (saved && window.qrcode) {
      var q = window.qrcode(0, "M"); q.addData(verifyLink(rec.id)); q.make();
      var n = q.getModuleCount(), qs = 176, cell = Math.floor((qs - 40) / n), off = (qs - cell * n) / 2;
      ctx.fillStyle = "#fff"; rr(ctx, L, sy + 18, qs, qs, 14); ctx.fill(); ctx.strokeStyle = "#DCE7DF"; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = "#17231C";
      for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) if (q.isDark(a, b)) ctx.fillRect(L + off + b * cell, sy + 18 + off + a * cell, cell, cell);
      tx = L + qs + 34;
    }
    var st = saved ? "Completed" : "Preview";
    ctx.font = "700 21px " + SANS; var stw = ctx.measureText(st).width + 52;
    ctx.fillStyle = saved ? "#DFF1E6" : "#FDF3E1"; rr(ctx, tx, sy + 34, stw, 40, 20); ctx.fill();
    ctx.fillStyle = saved ? "#127A4F" : "#E3A23B"; ctx.beginPath(); ctx.arc(tx + 22, sy + 54, 6, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = saved ? "#0B4F33" : "#8A5A10"; ctx.fillText(st, tx + 36, sy + 61);
    ctx.font = "400 25px " + SANS; ctx.fillStyle = "#4A5A50";
    if (saved) {
      ctx.fillText("Scan the QR code to check this scorecard.", tx, sy + 122);
      ctx.font = "400 25px " + SANS; ctx.fillStyle = "#4A5A50"; ctx.fillText("ID", tx, sy + 168);
      var iw = ctx.measureText("ID  ").width; ctx.font = "500 27px " + MONO; ctx.fillStyle = "#17231C"; ctx.fillText(rec.id, tx + iw, sy + 168);
    } else {
      wrap(ctx, "Save it to get a unique ID and QR code, so anyone can scan and check it.", R - tx).forEach(function (l, i) { ctx.fillText(l, tx, sy + 116 + i * 34); });
    }
    ctx.font = "400 19px " + SANS; ctx.fillStyle = "#6F8177";
    ctx.fillText("Issued by HV Test. A self-assessment, not an accredited certification or qualification.", L, H - 20);
    return cv;
  }

  window.HVScorecard = {
    renderImage: renderImage,
    issue: issue, lookup: lookup, cardHTML: cardHTML, loadQr: loadQr, normalizeId: normalizeId,
    verifyLink: verifyLink, dateText: dateText, barColor: barColor, LEVELS: LEVELS,
    VERIFY_URL: VERIFY_URL, VERIFY_SHOWN: VERIFY_SHOWN, ID_RE: ID_RE
  };
})();
