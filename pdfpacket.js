/* Gehret Sheep Co — PDF packet builder.
 * Recreates the layout of the 2026 template PDF (cover logo, Showmen, Sheep roster,
 * Weights grid, Show calendar, one Show Results page per show) from live app data.
 * Needs jsPDF (jspdf.umd.min.js) loaded first. Exposes window.gscExportPacket(data).
 */
(function () {
  var PW = 612, PH = 792, M = 36, USABLE = PW - 2 * M;

  function isoParts(v) {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v || "");
    return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
  }
  function fmtFull(v) {
    var p = isoParts(v);
    return p ? p.m + "/" + p.d + "/" + p.y : (v == null ? "" : String(v));
  }
  function fmtMD(v) {
    var p = isoParts(v);
    if (p) return p.m + "/" + p.d;
    var s = String(v == null ? "" : v);
    var m = /^(\d{1,2})[\/-](\d{1,2})/.exec(s);
    return m ? +m[1] + "/" + +m[2] : s;
  }
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  function ordinal(n) {
    var j = n % 10, k = n % 100;
    if (j === 1 && k !== 11) return n + "st";
    if (j === 2 && k !== 12) return n + "nd";
    if (j === 3 && k !== 13) return n + "rd";
    return n + "th";
  }
  function fmtLong(v) {
    var p = isoParts(v);
    return p ? MONTHS[p.m - 1] + " " + ordinal(p.d) : (v == null ? "" : String(v));
  }
  function dateKey(v) {
    var p = isoParts(v);
    if (p) return p.y * 10000 + p.m * 100 + p.d;
    var t = Date.parse(v);
    return isNaN(t) ? 99999999 : t;
  }
  function str(v) { return v == null ? "" : String(v); }

  // Wrap text to a width, hard-breaking words that are too long for the cell.
  function wrap(doc, text, maxW) {
    var out = [];
    String(text).split(/\r?\n/).forEach(function (para) {
      var lines = doc.splitTextToSize(para, maxW);
      lines.forEach(function (ln) {
        if (doc.getTextWidth(ln) <= maxW + 0.5) { out.push(ln); return; }
        var cur = "";
        for (var i = 0; i < ln.length; i++) {
          if (doc.getTextWidth(cur + ln[i]) > maxW && cur) { out.push(cur); cur = ln[i]; } else cur += ln[i];
        }
        if (cur) out.push(cur);
      });
    });
    return out.length ? out : [""];
  }

  function drawHeader(doc, x, y, widths, labels, fs, h) {
    var total = widths.reduce(function (a, b) { return a + b; }, 0);
    doc.setFillColor(0, 0, 0);
    doc.rect(x, y, total, h, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(fs);
    var cx = x;
    for (var i = 0; i < widths.length; i++) {
      if (labels[i]) doc.text(String(labels[i]), cx + widths[i] / 2, y + h / 2, { align: "center", baseline: "middle" });
      cx += widths[i];
    }
    doc.setTextColor(0, 0, 0);
  }

  function drawRow(doc, x, y, widths, cells, rh, fs, aligns, boldCols) {
    doc.setLineWidth(0.5);
    doc.setDrawColor(0, 0, 0);
    var cx = x, lh = fs * 1.2;
    for (var i = 0; i < widths.length; i++) {
      doc.rect(cx, y, widths[i], rh);
      var txt = cells && cells[i] != null ? String(cells[i]) : "";
      if (txt) {
        doc.setFont("helvetica", boldCols && boldCols.indexOf(i) >= 0 ? "bold" : "normal");
        doc.setFontSize(fs);
        var lines = wrap(doc, txt, widths[i] - 6);
        var top = y + (rh - lines.length * lh) / 2;
        var al = (aligns && aligns[i]) || "center";
        var tx = al === "left" ? cx + 3 : cx + widths[i] / 2;
        doc.text(lines, tx, top, { align: al === "left" ? "left" : "center", baseline: "top", lineHeightFactor: 1.2 });
      }
      cx += widths[i];
    }
  }

  function rowHeight(doc, widths, cells, fs, minRh) {
    var lh = fs * 1.2, most = 1;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(fs);
    for (var i = 0; i < widths.length; i++) {
      var t = cells && cells[i] != null ? String(cells[i]) : "";
      if (t) most = Math.max(most, wrap(doc, t, widths[i] - 6).length);
    }
    return Math.max(minRh, most * lh + 8);
  }

  // Paginated table. opts: widths, headers, rows, fs, minRh, headerH, aligns, boldCols,
  // title (string drawn above the header on each page), topExtra (fn(doc,y)->y), padBlank (bool)
  function table(doc, opts, firstPageAlreadyStarted) {
    var widths = opts.widths, total = widths.reduce(function (a, b) { return a + b; }, 0);
    var x = (PW - total) / 2, headerH = opts.headerH || 16, bottom = PH - M;
    var needPage = !firstPageAlreadyStarted;
    var y;
    function startPage() {
      if (needPage) doc.addPage();
      needPage = true;
      y = M + 10;
      if (opts.band) {
        doc.setFillColor(0, 0, 0);
        doc.rect(x, y, total, 16, "F");
        doc.setTextColor(255, 255, 255);
        doc.setFont("helvetica", "bold");
        doc.setFontSize(8.5);
        doc.text(opts.band, PW / 2, y + 8, { align: "center", baseline: "middle", maxWidth: total - 10 });
        doc.setTextColor(0, 0, 0);
        doc.setDrawColor(255, 255, 255);
        doc.setLineWidth(0.5);
        y += 16;
        doc.line(x, y, x + total, y);
      }
      if (opts.title) {
        doc.setFont("helvetica", "bold");
        doc.setFontSize(opts.titleFs || 9);
        doc.setTextColor(0, 0, 0);
        doc.text(opts.title, PW / 2, y + 8, { align: "center", baseline: "middle" });
        y += 22;
      }
      drawHeader(doc, x, y, widths, opts.headers, opts.hfs || opts.fs, headerH);
      y += headerH;
    }
    startPage();
    opts.rows.forEach(function (cells) {
      var rh = rowHeight(doc, widths, cells, opts.fs, opts.minRh);
      if (y + rh > bottom) startPage();
      drawRow(doc, x, y, widths, cells, rh, opts.fs, opts.aligns, opts.boldCols);
      y += rh;
    });
    if (opts.padBlank) {
      while (y + opts.minRh <= bottom) {
        drawRow(doc, x, y, widths, null, opts.minRh, opts.fs, opts.aligns, opts.boldCols);
        y += opts.minRh;
      }
    }
    return y;
  }

  function loadImage(url) {
    return fetch(url).then(function (r) { return r.blob(); }).then(function (b) {
      return new Promise(function (res, rej) {
        var fr = new FileReader();
        fr.onload = function () {
          var img = new Image();
          img.onload = function () { res({ data: fr.result, w: img.naturalWidth, h: img.naturalHeight }); };
          img.onerror = rej;
          img.src = fr.result;
        };
        fr.onerror = rej;
        fr.readAsDataURL(b);
      });
    });
  }

  function buildCover(doc, logo) {
    if (!logo) return;
    var w = 400, h = w * logo.h / logo.w;
    doc.addImage(logo.data, "PNG", (PW - w) / 2, PH / 2 - h / 2 - 20, w, h);
  }

  function buildShowmen(doc, d) {
    doc.addPage();
    var fall = /fall/i.test(d.year || "");
    var rows = (d.exhibitors || []).map(function (e) {
      var n = e.numSheep;
      if (n === "" || n == null) {
        n = (d.sheep || []).filter(function (s) { return s.showman && s.showman === e.name; }).length || "";
      }
      return [e.name, e.age, e.county, n, e.targetShow, fmtFull(e.targetShowDate), e.osf ? "X" : ""];
    });
    table(doc, {
      title: str(d.year) + " Showmen",
      widths: [100, 50, 70, 60, 75, 85, 50],
      headers: ["Name", "4H Age", "County", "# of Sheep", "Target Show", "Target Show Date", fall ? "NAILE?" : "OSF?"],
      rows: rows, fs: 8, minRh: 30, headerH: 18, boldCols: [0]
    }, true);
  }

  function buildRoster(doc, d) {
    doc.addPage();
    var rows = (d.sheep || []).map(function (s) {
      return [s.name, s.sex, s.lEar, s.rEar, fmtFull(s.birthdate), s.breed, s.sire, s.dam, s.breeder, s.price, s.showman, s.county, s.notes];
    });
    table(doc, {
      widths: [46, 30, 36, 30, 42, 38, 48, 58, 36, 34, 46, 36, 60],
      headers: ["Name", "Sex", "L Ear", "R Ear", "Birthdate", "Breed", "Sire", "Dam", "Breeder", "Price", "Showman", "County", "Additional Notes"],
      rows: rows, fs: 5.5, hfs: 5.5, minRh: 22, headerH: 13, boldCols: [0]
    }, true);
  }

  function buildWeights(doc, d) {
    var sheep = d.sheep || [], weights = d.weights || {};
    if (!sheep.length) return;
    var dateSet = {};
    sheep.forEach(function (s) { (weights[s.id] || []).forEach(function (w) { if (w && w.date) dateSet[w.date] = 1; }); });
    var dates = Object.keys(dateSet).sort(function (a, b) { return dateKey(a) - dateKey(b); });
    var NAMEW = 62, DW = 27, perPage = Math.floor((USABLE - NAMEW) / DW);
    var rowH = 22, headerH = 15, rowsPerPage = Math.floor((PH - 2 * M - 10 - headerH) / rowH);
    var dateChunks = [];
    for (var i = 0; i < Math.max(dates.length, 1); i += perPage) dateChunks.push(dates.slice(i, i + perPage));
    dateChunks.forEach(function (chunk) {
      var cols = chunk.slice();
      while (cols.length < perPage) cols.push(null);
      var widths = [NAMEW].concat(cols.map(function () { return DW; }));
      var headers = ["Name"].concat(cols.map(function (c) { return c ? fmtMD(c) : ""; }));
      for (var r = 0; r < sheep.length; r += rowsPerPage) {
        doc.addPage();
        var y = M + 10;
        var x = (PW - widths.reduce(function (a, b) { return a + b; }, 0)) / 2;
        drawHeader(doc, x, y, widths, headers, 6, headerH);
        y += headerH;
        sheep.slice(r, r + rowsPerPage).forEach(function (s) {
          var map = {};
          (weights[s.id] || []).forEach(function (w) { if (w && w.date) map[w.date] = w.weight; });
          var cells = [s.name].concat(cols.map(function (c) { return c && map[c] != null ? map[c] : ""; }));
          drawRow(doc, x, y, widths, cells, rowH, 6, ["left"].concat(cols.map(function () { return "center"; })), [0]);
          y += rowH;
        });
      }
    });
  }

  function buildCalendar(doc, d) {
    var shows = (d.shows || []).slice().sort(function (a, b) { return dateKey(a.date || "9999-12-31") - dateKey(b.date || "9999-12-31"); });
    if (!shows.length) return;
    doc.addPage();
    var widths = [70, 190, 90, 35, 155];
    var rows = shows.map(function (s) { return [fmtLong(s.date), s.name, s.city, s.state, s.judge]; });
    table(doc, {
      title: "SHOWS",
      titleFs: 7,
      widths: widths,
      headers: ["Date", "Show Name", "City", "State", "Judge"],
      rows: rows, fs: 7.5, hfs: 7.5, minRh: 22, headerH: 16, aligns: ["left", "center", "center", "center", "left"]
    }, true);
  }

  function buildResults(doc, d) {
    var results = d.results || [], sheep = d.sheep || [];
    var order = [], groups = {};
    var shows = (d.shows || []).slice().sort(function (a, b) { return dateKey(a.date || "9999-12-31") - dateKey(b.date || "9999-12-31"); });
    results.forEach(function (r) {
      var k = str(r.showName).trim();
      if (!k) return;
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    });
    shows.forEach(function (s) { if (groups[s.name] && order.indexOf(s.name) < 0) order.push(s.name); });
    Object.keys(groups).forEach(function (k) { if (order.indexOf(k) < 0) order.push(k); });
    order.forEach(function (name) {
      doc.addPage();
      var rows = groups[name].map(function (r) {
        var sp = r.sheepId ? sheep.filter(function (s) { return s.id === r.sheepId; })[0] : null;
        return [r.exhibitor, sp ? sp.name : str(r.sheepName), r.showedAs, r.placing];
      });
      table(doc, {
        band: name,
        widths: [110, 100, 150, 180],
        headers: ["Showman", "Sheep", "Showed As", "Placing"],
        rows: rows, fs: 7, hfs: 7.5, minRh: 22, headerH: 15, padBlank: true
      }, true);
    });
  }

  window.gscExportPacket = function (data) {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert("PDF engine didn't load. Open the app once with a connection, then try again.");
      return Promise.resolve();
    }
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ unit: "pt", format: "letter" });
    return loadImage("./logo-pdf.png").catch(function () { return null; }).then(function (logo) {
      buildCover(doc, logo);
      buildShowmen(doc, data);
      buildRoster(doc, data);
      buildWeights(doc, data);
      buildCalendar(doc, data);
      buildResults(doc, data);
      var name = "Gehret Sheep Co - " + (data.year || "Packet") + ".pdf";
      doc.save(name);
    }).catch(function (err) {
      console.error(err);
      alert("Couldn't build the PDF: " + (err && err.message ? err.message : err));
    });
  };
})();
