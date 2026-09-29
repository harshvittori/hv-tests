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

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  function dateText(d) {
    d = d instanceof Date ? d : new Date(d);
    return d.getDate() + " " + MONTHS[d.getMonth()] + " " + d.getFullYear();
  }

  /* ---------- Fonts, served from assets/fonts next to this script ---------- */
  var FONT_BASE = (function () { try { return new URL("fonts/", document.currentScript.src).href; } catch (e) { return "fonts/"; } })();
  var FONTS = [["HVSora", "Sora-Regular.ttf", "400"], ["HVSora", "Sora-SemiBold.ttf", "600"], ["HVMono", "GeistMono-Medium.ttf", "500"],
               ["HVOutfit", "Outfit-SemiBold.ttf", "600"], ["HVOutfit", "Outfit-Bold.ttf", "700"]];
  var fontsReady = null;
  function loadFonts() {
    if (!fontsReady) {
      fontsReady = Promise.all(FONTS.map(function (f) {
        if (!window.FontFace) return null;
        var face = new FontFace(f[0], "url(" + FONT_BASE + f[1] + ")", { weight: f[2] });
        return face.load().then(function (x) { document.fonts.add(x); }, function () {});
      })).catch(function () {});
    }
    return fontsReady;
  }
  function loadQr() {
    return window.qrcode ? Promise.resolve() :
      loadScript("https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js").catch(function () {});
  }

  /* ---------- The scorecard image (design D): 1080 x 1350, 4:5 so it fits WhatsApp, Instagram and LinkedIn.
     The same image is shown on the results page, shared as a PNG, placed on page 1 of the Report PDF
     and shown on the verify page. A record without an id is a preview: no ID or QR yet. ---------- */
  var SORA = "HVSora,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
  var BRAND = "HVOutfit," + SORA;
  var MONO = "HVMono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
  var INK = "#0E1411", SOFT = "#48524C", FAINT = "#7A857F", GREEN = "#127A4F", LINE = "#E3E8E5";

  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function spaced(ctx, px) { if ("letterSpacing" in ctx) ctx.letterSpacing = px + "px"; }
  function drawMark(ctx, x, y, size) {
    var k = size / 48;
    ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
    ctx.fillStyle = GREEN; rr(ctx, 0, 0, 48, 48, 12); ctx.fill();
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
  function card(ctx, x, y, w, h, r) {
    ctx.save();
    ctx.shadowColor = "rgba(14,20,17,.08)"; ctx.shadowBlur = 30; ctx.shadowOffsetY = 12;
    ctx.fillStyle = "#fff"; rr(ctx, x, y, w, h, r); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; rr(ctx, x + .75, y + .75, w - 1.5, h - 1.5, r); ctx.stroke();
  }
  function label(ctx, t, x, y, size) {
    spaced(ctx, (size || 12.5) * .24); ctx.font = "600 " + (size || 12.5) + "px " + SORA; ctx.fillStyle = FAINT;
    ctx.fillText(t.toUpperCase(), x, y); spaced(ctx, 0);
  }

  // opts.scale: pixel density (2 for the PDF)
  async function renderImage(rec, opts) {
    opts = opts || {};
    await Promise.all([loadFonts(), loadQr()]);
    var S = opts.scale || 1, W = 1080, H = 1350, L = 72, R = W - 72, saved = !!rec.id;
    var cv = document.createElement("canvas"); cv.width = W * S; cv.height = H * S;
    var ctx = cv.getContext("2d"); ctx.scale(S, S);
    ctx.textBaseline = "alphabetic";

    // Background with a soft green glow top right
    ctx.fillStyle = "#FAFBFA"; ctx.fillRect(0, 0, W, H);
    var glow = ctx.createRadialGradient(950, 70, 0, 950, 70, 640);
    glow.addColorStop(0, "rgba(227,242,234,1)"); glow.addColorStop(1, "rgba(227,242,234,0)");
    ctx.fillStyle = glow; ctx.fillRect(0, 0, W, H);

    // Brand row
    drawMark(ctx, L, 70, 52);
    spaced(ctx, 1.2); ctx.font = "700 30px " + BRAND; ctx.fillStyle = INK; ctx.fillText("HV", L + 66, 107);
    var hvw = ctx.measureText("HV ").width;
    ctx.font = "600 30px " + BRAND; ctx.fillStyle = GREEN; ctx.fillText("TEST", L + 66 + hvw, 107);
    spaced(ctx, 4.2); ctx.font = "600 14px " + SORA;
    var kind = "SKILL ASSESSMENT SCORECARD", kw = ctx.measureText(kind).width + 36;
    ctx.fillStyle = "#fff"; rr(ctx, R - kw, 76, kw, 40, 20); ctx.fill(); ctx.strokeStyle = "#DDE3DF"; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.fillStyle = SOFT; ctx.fillText(kind, R - kw + 18, 101); spaced(ctx, 0);

    // Name
    label(ctx, "Scorecard for", L, 280, 14);
    spaced(ctx, -2); fit(ctx, rec.name, 560, "600 {s}px " + SORA, 78, 40);
    ctx.fillStyle = INK; ctx.fillText(rec.name, L, 360); spaced(ctx, 0);
    ctx.font = "400 21px " + SORA; ctx.fillStyle = "#5B6660"; ctx.fillText(rec.testTitle + " · " + rec.category, L, 412);

    // Score ring
    var cx = 858, cy = 342, r = 128;
    ctx.lineWidth = 16; ctx.strokeStyle = "#EDF0EE"; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    var sc = Math.max(0, Math.min(100, rec.score));
    if (sc > 0) {
      var gr = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
      gr.addColorStop(0, "#3FB27F"); gr.addColorStop(1, "#0E5A3B");
      ctx.strokeStyle = gr; ctx.lineCap = "round"; ctx.beginPath(); ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * sc / 100); ctx.stroke(); ctx.lineCap = "butt";
    }
    spaced(ctx, -4.5); ctx.font = "600 96px " + SORA; var sw = ctx.measureText(String(rec.score)).width;
    spaced(ctx, 0); ctx.font = "400 26px " + SORA; var ow = ctx.measureText("/100").width;
    var sx = cx - (sw + ow) / 2;
    spaced(ctx, -4.5); ctx.font = "600 96px " + SORA; ctx.fillStyle = INK; ctx.fillText(String(rec.score), sx, cy + 18);
    spaced(ctx, 0); ctx.font = "400 26px " + SORA; ctx.fillStyle = FAINT; ctx.fillText("/100", sx + sw, cy + 18);
    spaced(ctx, 3); ctx.font = "600 13px " + SORA;
    var lv = rec.level.toUpperCase(), lw = ctx.measureText(lv).width + 28;
    ctx.fillStyle = GREEN; rr(ctx, cx - lw / 2, cy + 40, lw, 28, 14); ctx.fill();
    ctx.fillStyle = "#fff"; ctx.textAlign = "center"; ctx.fillText(lv, cx + 1.5, cy + 59); ctx.textAlign = "left"; spaced(ctx, 0);

    // Meta cards
    var mw = (R - L - 28) / 3, my = 532;
    [["Completed", dateText(rec.completedAt), false], ["Scorecard ID", saved ? rec.id : "Given when saved", saved], ["Answered", rec.answered + " of " + rec.total, false]].forEach(function (m, i) {
      var x = L + i * (mw + 14);
      card(ctx, x, my, mw, 88, 18);
      label(ctx, m[0], x + 23, my + 33, 12);
      ctx.font = m[2] ? "500 20px " + MONO : "600 22px " + SORA; ctx.fillStyle = saved || i !== 1 ? INK : FAINT;
      ctx.fillText(m[1], x + 23, my + 67);
    });

    // Skill-wise score
    var gy = 638, lw2 = 500, rx = L + lw2 + 18, rw = R - rx;
    card(ctx, L, gy, lw2, 444, 22);
    label(ctx, "Skill-wise score · out of 10", L + 29, gy + 45);
    var by = gy + 84, bx = L + 243, bw = 185;
    (rec.skills || []).forEach(function (s) {
      ctx.font = "400 17px " + SORA; ctx.fillStyle = "#1D2622"; ctx.fillText(s.name, L + 29, by);
      ctx.fillStyle = "#EDF0EE"; rr(ctx, bx, by - 9, bw, 6, 3); ctx.fill();
      if (s.score > 0) { ctx.fillStyle = s.score >= 7 ? GREEN : INK; rr(ctx, bx, by - 9, Math.max(6, bw * s.score / 10), 6, 3); ctx.fill(); }
      ctx.font = "600 17px " + SORA; ctx.fillStyle = INK; ctx.textAlign = "right"; ctx.fillText(String(s.score), L + lw2 - 32, by); ctx.textAlign = "left";
      by += 34;
    });

    // Strengths / Work on chips. Boxes size to their chips (long names can wrap to one chip per row).
    var chipW = function (n) {
      var sk = (rec.skills || []).filter(function (x) { return x.name === n; })[0];
      ctx.font = "400 18px " + SORA; var nw = ctx.measureText(n + "  ").width;
      ctx.font = "600 18px " + SORA; var vw = sk ? ctx.measureText(String(sk.score)).width : 0;
      return { n: n, s: sk, nw: nw, w: nw + vw + 28 };
    };
    var layout = function (items) {
      var rows = [[]], x = 0, maxW = rw - 56;
      items.map(chipW).forEach(function (c) {
        if (x && x + c.w > maxW) { rows.push([]); x = 0; }
        rows[rows.length - 1].push(c); x += c.w + 8;
      });
      return rows;
    };
    var sRows = layout(rec.strengths || []), fRows = layout(rec.focus || []);
    var step = 50, chipH = 40, head = 70, pad = 22, gap = 18, total = 444;
    var need = function () { return 2 * (head + pad) + (sRows.length + fRows.length) * step - 2 * (step - chipH) + gap; };
    if (need() > total) { step = 44; chipH = 36; head = 64; pad = 18; }
    var sH = head + sRows.length * step - (step - chipH) + pad;
    var tagPanel = function (py, ph, title, rows, bg, fg) {
      card(ctx, rx, py, rw, ph, 22);
      label(ctx, title, rx + 28, py + 45);
      rows.forEach(function (row, ri) {
        var tx = rx + 28, ty = py + head + ri * step;
        row.forEach(function (c) {
          ctx.fillStyle = bg; rr(ctx, tx, ty, c.w, chipH, 12); ctx.fill();
          ctx.fillStyle = fg; ctx.font = "400 18px " + SORA; ctx.fillText(c.n, tx + 14, ty + chipH / 2 + 6);
          if (c.s) { ctx.font = "600 18px " + SORA; ctx.fillText(String(c.s.score), tx + 14 + c.nw, ty + chipH / 2 + 6); }
          tx += c.w + 8;
        });
      });
    };
    tagPanel(gy, sH, "Strengths", sRows, "#E6F4EC", "#0B4F33");
    tagPanel(gy + sH + gap, total - sH - gap, "Work on", fRows, "#F1F3F2", "#1D2622");

    // Footer: QR, ID, disclaimer
    ctx.fillStyle = LINE; ctx.fillRect(L, 1142, R - L, 1.5);
    var tx2 = L;
    if (saved && window.qrcode) {
      var q = window.qrcode(0, "M"); q.addData(verifyLink(rec.id)); q.make();
      var n = q.getModuleCount(), cell = Math.floor(104 / n), qsz = cell * n, box = qsz + 24;
      ctx.fillStyle = "#fff"; rr(ctx, L, 1165, box, box, 14); ctx.fill(); ctx.strokeStyle = LINE; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = INK;
      for (var a = 0; a < n; a++) for (var b = 0; b < n; b++) if (q.isDark(a, b)) ctx.fillRect(L + 12 + b * cell, 1177 + a * cell, cell, cell);
      tx2 = L + box + 26;
    }
    ctx.font = "400 17px " + SORA; ctx.fillStyle = SOFT;
    if (saved) {
      ctx.fillText("Scan the QR code to check this scorecard.", tx2, 1204);
      ctx.fillText("ID", tx2, 1233);
      var iw = ctx.measureText("ID ").width; ctx.font = "500 17px " + MONO; ctx.fillStyle = INK; ctx.fillText(rec.id, tx2 + iw, 1233);
    } else {
      spaced(ctx, 2); ctx.font = "600 12px " + SORA; var pw = ctx.measureText("PREVIEW").width + 24;
      ctx.fillStyle = "#F1F3F2"; rr(ctx, tx2, 1176, pw, 26, 13); ctx.fill(); ctx.fillStyle = SOFT; ctx.fillText("PREVIEW", tx2 + 12, 1194); spaced(ctx, 0);
      ctx.font = "400 17px " + SORA; ctx.fillStyle = SOFT;
      ctx.fillText("Save it to get a unique ID and QR code, so anyone can scan and check it.", tx2, 1233);
    }
    ctx.font = "400 13.5px " + SORA; ctx.fillStyle = FAINT;
    ctx.fillText("Issued by HV Test. A self-assessment, not an accredited certification or qualification.", tx2, 1268);
    return cv;
  }

  window.HVScorecard = {
    renderImage: renderImage, issue: issue, lookup: lookup, loadQr: loadQr, normalizeId: normalizeId,
    verifyLink: verifyLink, dateText: dateText, LEVELS: LEVELS,
    VERIFY_URL: VERIFY_URL, VERIFY_SHOWN: VERIFY_SHOWN, ID_RE: ID_RE
  };
})();
