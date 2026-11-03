/* IR Maker — support for "one row per IR" logs with one sheet per discipline
   (e.g. CIVIL / ARCH sheets: Type | Submittal No | … | Description | Location | CATEGORY | Send Date | Received Date | Code …),
   and for "table cell" IR forms (values sit in table cells under/next to their labels, reference also in the footer).
   Plugs into IREngine on top of engine.js + blocklog.js. */
(function (root) {
  'use strict';
  var E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.IREngine;
  var I = E._i, JSZipRef = I.JSZip, BL = E.block;
  var prev = {};
  ['loadLog', 'understand', 'finalize', 'appendRows', 'findDuplicate', 'dupKey', 'recordFromRow', 'learnFromFilledIr', 'buildForm', 'normalizeStations', 'isUSection'].forEach(function (k) { prev[k] = E[k]; });
  var prevBlock = {}; Object.keys(BL).forEach(function (k) { prevBlock[k] = BL[k]; });

  function isRows(log) { return !!(log && log.format === 'rows'); }
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function pad(n, w) { return String(n).padStart(w || 1, '0'); }
  function hk(s) { return low(s).replace(/[^a-z]/g, ''); }

  // ---------- reading ----------
  function findHeader(rows) {
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var k = rows[i].cells.map(hk);
      var serial = k.findIndex(function (v) { return /^submittal(no)?$|^submittalno$|^irno$|^serialno$|^refno$/.test(v) || /^submittal/.test(v); });
      var desc = k.findIndex(function (v) { return /^description/.test(v); });
      var send = k.findIndex(function (v) { return /^senddate|^submitteddate|^issuedate/.test(v); });
      if (serial >= 0 && desc >= 0 && send >= 0 && !k.some(function (v) { return v === 'revno'; })) return { i: i, r: rows[i].r, k: k, serial: serial, desc: desc };
    }
    return null;
  }
  function parseDate(v) {
    if (typeof v === 'number') return I.serialToDate(v);
    var m = String(v || '').match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]?\s*(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]) : null;
  }
  function codeOf(v) { var a = clean(v).toUpperCase(); if (!a) return 'W'; if (/^A\b|^A$/.test(a)) return 'A'; if (/^B/.test(a)) return 'B'; if (/^C/.test(a)) return 'C'; if (/^D/.test(a)) return 'D'; if (/^R/.test(a)) return 'R'; return 'W'; }
  function statusName(a) { return a === 'A' ? 'Approved' : a === 'B' ? 'Approved with comments' : a === 'C' ? 'Revise and resubmit' : a === 'D' || a === 'R' ? 'Rejected' : 'Pending'; }
  function splitSerial(s) {
    var m = String(s).trim().match(/^(.*?IR[-_ ]?[A-Za-z]*[-_ ]?)(\d+)(\s*-?\s*REV\.?\s*(\d+).*)?$/i);
    if (!m) { var m2 = String(s).trim().match(/^(.*?)(\d+)([^\d]*)$/); return m2 ? { prefix: m2[1], num: m2[2], suffix: m2[3] || '', rev: 0 } : null; }
    return { prefix: m[1], num: m[2], suffix: m[3] || '', rev: m[4] != null ? +m[4] : 0 };
  }
  async function isRowLog(zip) {
    var rels = I.relsMap(await zip.file('xl/_rels/workbook.xml.rels').async('string'), 'xl/workbook.xml');
    var ssPath = null; Object.keys(rels).forEach(function (k) { if (/sharedStrings$/.test(rels[k].type)) ssPath = rels[k].path; });
    var ss = ssPath && zip.file(ssPath) ? I.sharedStringsFrom(await zip.file(ssPath).async('string')) : [];
    var wb = await zip.file('xl/workbook.xml').async('string'), re = /<sheet\b([^>]*)\/?>/g, m;
    while ((m = re.exec(wb))) {
      var rid = (m[1].match(/\br:id="([^"]+)"/) || [])[1]; if (!rels[rid] || !zip.file(rels[rid].path)) continue;
      var sx = await zip.file(rels[rid].path).async('string');
      var cut = sx.indexOf('<row r="41"'); var rows = I.parseRows(cut > 0 ? sx.slice(0, cut) + '</sheetData>' : sx.slice(0, 300000), ss);
      if (findHeader(rows)) return true;
    }
    return false;
  }
  async function loadRowLog(zip, fileName) {
    var wb = await zip.file('xl/workbook.xml').async('string');
    var rels = I.relsMap(await zip.file('xl/_rels/workbook.xml.rels').async('string'), 'xl/workbook.xml');
    var ssPath = null; Object.keys(rels).forEach(function (k) { if (/sharedStrings$/.test(rels[k].type)) ssPath = rels[k].path; });
    var ss = ssPath && zip.file(ssPath) ? I.sharedStringsFrom(await zip.file(ssPath).async('string')) : [];
    var tabs = [], re = /<sheet\b([^>]*)\/?>/g, m, project = '';
    while ((m = re.exec(wb))) {
      var name = I.xmlDecode((m[1].match(/\bname="([^"]*)"/) || [])[1] || ''), rid = (m[1].match(/\br:id="([^"]+)"/) || [])[1];
      if (!rels[rid] || !zip.file(rels[rid].path)) continue;
      var path = rels[rid].path, sx = await zip.file(path).async('string'), rows = I.parseRows(sx, ss), h = findHeader(rows);
      if (!h) continue;
      var col = { serial: h.serial, desc: h.desc, sends: [] };
      h.k.forEach(function (v, i) {
        if (/^type$/.test(v) && col.type == null) col.type = i;
        if (/^location/.test(v) && col.loc == null) col.loc = i;
        if (/^category/.test(v) && col.cat == null) col.cat = i;
        if (/^senddate|^submitteddate|^issuedate/.test(v)) col.sends.push(i);
      });
      // each revision = Send date, Received date, Code
      col.revs = col.sends.map(function (s) { return { send: s, recv: s + 1, code: s + 2 }; });
      var recs = [];
      rows.forEach(function (r) {
        if (r.r <= h.r) return;
        var sv = r.cells[col.serial];
        var rec = { row: r.r, serial: clean(sv), type: col.type != null ? clean(r.cells[col.type]) : '', desc: String(r.cells[col.desc] == null ? '' : r.cells[col.desc]).replace(/\r/g, '').trim(),
          loc: col.loc != null ? clean(r.cells[col.loc]) : '', cat: col.cat != null ? clean(r.cells[col.cat]) : '' };
        if (!rec.serial || !/\d/.test(rec.serial)) { if (rec.type || rec.desc) recs.push(Object.assign(rec, { empty: !rec.serial && !rec.desc })); return; }
        var sp = splitSerial(rec.serial); if (!sp) return;
        rec.n = +sp.num; rec.prefix = sp.prefix; rec.width = sp.num.length; rec.suffix = sp.suffix; rec.rev = sp.rev;
        var lr = -1; col.revs.forEach(function (g, i) { if (r.cells[g.send] != null && String(r.cells[g.send]).trim() !== '') lr = i; });
        rec.lastGroup = Math.max(0, lr);
        var g = col.revs[rec.lastGroup] || col.revs[0];
        rec.sendRaw = g ? r.cells[g.send] : null; rec.date = parseDate(rec.sendRaw); rec.action = codeOf(g ? r.cells[g.code] : '');
        recs.push(rec);
      });
      var numbered = recs.filter(function (r) { return r.n != null; });
      var maxRec = numbered.reduce(function (a, r) { return !a || r.n > a.n || (r.n === a.n && r.row > a.row) ? r : a; }, null);
      var recent = numbered.filter(function (r) { return r.desc; }).slice(-15);
      var textDates = recent.filter(function (r) { return typeof r.sendRaw === 'string' && r.sendRaw.trim(); }).length;
      var sepM = recent.map(function (r) { return String(r.sendRaw || '').match(/\d{1,2}([\/.\-])\d{1,2}/); }).filter(Boolean)[0];
      var kind = clean(name).replace(/^ir[\s._-]*/i, '') || name;
      var typeVal = (recent.length ? recent[recent.length - 1].type : '') || (maxRec ? maxRec.type : '');
      tabs.push({ name: name, kind: kind, sheetPath: path, header: h.r, col: col, recs: recs, numbered: numbered,
        lastNum: maxRec ? maxRec.n : 0, lastRow: maxRec ? maxRec.row : h.r, prefix: maxRec ? maxRec.prefix : 'IR-' + kind + '-', width: maxRec ? maxRec.width : 3,
        suffix: maxRec ? maxRec.suffix.replace(/(\d+)(?!.*\d)/, function (d) { return pad(0, d.length); }) : '', typeVal: typeVal,
        dateAsText: textDates * 2 >= recent.length && recent.length > 0, dateSep: sepM ? sepM[1] : '/' });
    }
    if (!tabs.length) throw new Error('No IR sheet found in this workbook');
    var rows = [];
    tabs.forEach(function (t) {
      t.numbered.forEach(function (r) {
        if (!r.desc) return;
        rows.push({ ir: r.serial, rev: r.rev, desc: r.desc, date: r.date, action: r.action === 'R' ? 'C' : r.action, status: statusName(r.action),
          item: r.cat, subItem: '', tab: t.name, kind: t.kind, label: t.kind + ' ' + r.n, n: r.n, block: null, loc: r.loc, unit: '' });
      });
    });
    rows.sort(function (a, b) { return ((a.date ? +a.date : 0) - (b.date ? +b.date : 0)) || (a.n - b.n); });
    var pm = (fileName || '').match(/IR[_\s-]*LOG[_\s-]*([A-Za-z]{2,})/i);
    project = pm ? pm[1].toUpperCase() : '';
    var firstSerial = tabs[0].numbered[0] ? tabs[0].numbered[0].serial : '';
    if (!project) project = (firstSerial.match(/^([A-Z]{2,})-/) || [])[1] || '';
    return { format: 'rows', zip: zip, ss: ss, tabs: tabs, rows: rows, project: project, fileName: fileName || '', absPath: '', blocks: {}, lastNum: '', prefix: '', col: {}, shapes: {} };
  }

  // ---------- understanding ----------
  var STOP = ['for', 'the', 'of', 'and', 'to', 'in', 'on', 'at', 'a', 'an', 'with', 'inspection', 'check', 'no', 'ir', 'please'];
  function words(s) { return low(s).replace(/[^a-z0-9\u0600-\u06ff ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 1 && STOP.indexOf(w) < 0 && !/^\d+$/.test(w); }); }
  function near(a, b) { return a === b || (a.length > 3 && b.length > 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)); }
  var ARCH_WORDS = /plaster|paint|putty|primer|masonry|brick|block ?work|tile|tiling|ceramic|porcelain|marble|granite|ceiling|gypsum|door|window|curtain|cladding|stone|insulation|membrane|waterproof|screed|skirting|grc|cornice|aluminium|aluminum|glass|partition/;
  var CIVIL_WORDS = /reinforc|rft|rebar|formwork|shutter|concrete|casting|pour|excavat|backfill|compaction|footing|raft|column|beam|slab|foundation|pile|blinding|lean|anchor|trench|manhole|water test|sloped/;
  function guessTab(log, text) {
    var t = low(text), want = null;
    log.tabs.forEach(function (tb) { if (new RegExp('\\b' + low(tb.kind).replace(/[^a-z]/g, '') + '\\b').test(t)) want = tb; });
    if (want) return want;
    var pick = function (re) { return log.tabs.filter(function (tb) { return re.test(low(tb.name)); })[0] || null; };
    if (ARCH_WORDS.test(t)) return pick(/arch/);
    if (CIVIL_WORDS.test(t)) return pick(/civ|cvl|str/);
    return null;
  }
  function bestMatch(log, text, tab) {
    var uw = words(text), best = null, bs = 0;
    (tab ? [tab] : log.tabs).forEach(function (t) {
      t.numbered.forEach(function (r, i) {
        if (!r.desc) return;
        var rw = words(r.desc); if (!rw.length || !uw.length) return;
        var hit = 0; uw.forEach(function (w) { if (rw.some(function (x) { return near(w, x); })) hit++; });
        var back = 0; rw.forEach(function (x) { if (uw.some(function (w) { return near(w, x); })) back++; });
        var sc = hit / uw.length * 0.6 + back / rw.length * 0.4 + 0.03 * (i / Math.max(1, t.numbered.length));
        if (sc > bs) { bs = sc; best = { t: t, r: r }; }
      });
    });
    return best ? { t: best.t, r: best.r, score: bs } : null;
  }
  function understandRows(log, text, today) {
    var raw = String(text || '').replace(/\r/g, '').trim(), warnings = [];
    var tab = guessTab(log, raw), bm = bestMatch(log, raw, tab);
    tab = tab || (bm && bm.score > 0.3 ? bm.t : null) || log.tabs[0];
    if (!guessTab(log, raw) && !(bm && bm.score > 0.3)) warnings.push('Check the sheet (' + log.tabs.map(function (t) { return t.name; }).join(' / ') + ') before saving.');
    var upper = tab.numbered.slice(-30).filter(function (r) { return r.desc; });
    var mostlyUpper = upper.filter(function (r) { return r.desc === r.desc.toUpperCase(); }).length * 2 >= upper.length;
    var desc = mostlyUpper ? raw.toUpperCase() : raw;
    var src = bm && bm.t === tab && bm.score > 0.35 ? bm.r : null;
    var loc = src ? src.loc : '', cat = src ? src.cat : '';
    if (!loc) warnings.push('Add the location (area) before saving.');
    return { drafts: [{ desc: desc, tab: tab.name, loc: loc, cat: cat, rev: 0, date: today || new Date(), item: cat, subItem: '', block: null, formItem: cat }],
      warnings: warnings, rule: 'learned', alternatives: [] };
  }

  // ---------- duplicates ----------
  function keyOf(desc) {
    var toks = low(desc).replace(/reinforcment|rinforcment/g, 'reinforcement').replace(/form\s+work/g, 'formwork').replace(/[^a-z0-9.\u0600-\u06ff]+/g, ' ').split(' ')
      .filter(function (w) { return w && STOP.indexOf(w) < 0; });
    return toks.filter(function (w, i, a) { return a.indexOf(w) === i; }).sort().join(' ');
  }
  function dupRows(log, d) {
    var tab = log.tabs.filter(function (t) { return t.name === d.tab; })[0]; if (!tab) return null;
    var k = keyOf(d.desc), l = keyOf(d.loc || ''); if (!k) return null;
    var hit = tab.numbered.filter(function (r) { return r.desc && keyOf(r.desc) === k && (!l || !r.loc || keyOf(r.loc) === l); }).pop();
    if (!hit) return null;
    return { row: { date: hit.date }, n: hit.n, rev: hit.rev, action: hit.action, rejected: /[CDR]/.test(hit.action), status: statusName(hit.action), label: hit.serial, printKey: hit.serial };
  }

  // ---------- numbering & writing ----------
  function plan(log, drafts) {
    var st = {};
    log.tabs.forEach(function (t) { st[t.name] = { t: t, next: t.lastNum + 1, row: t.lastRow }; });
    return drafts.map(function (d) {
      var s = st[d.tab] || st[log.tabs[0].name], t = s.t, n = s.next++;
      // first empty row after the last numbered IR (rows prepared with only the Type filled count as empty)
      var used = {}; t.recs.forEach(function (r) { if (r.n != null || r.desc) used[r.row] = 1; });
      var row = s.row + 1; while (used[row] || (s.taken && s.taken[row])) row++;
      s.taken = s.taken || {}; s.taken[row] = 1; s.row = row;
      return { tab: t, n: n, serial: t.prefix + pad(n, t.width) + t.suffix, row: row };
    });
  }
  function dateCell(t, d) {
    if (!d) return null;
    if (t.dateAsText) return { s: pad(d.getDate(), 2) + t.dateSep + pad(d.getMonth() + 1, 2) + t.dateSep + d.getFullYear() };
    return { n: I.dateToSerial(d) };
  }
  function finalizeRows(log, drafts) {
    var p = plan(log, drafts);
    return drafts.map(function (d, i) {
      return { format: 'rows', tab: p[i].tab.name, kind: p[i].tab.kind, n: p[i].n, serial: p[i].serial, ir: p[i].serial, row: p[i].row, rev: 0,
        desc: d.desc, loc: d.loc, cat: d.cat, date: d.date, formIr: p[i].serial, attempt: 1, action: 'W', status: 'Pending' };
    });
  }
  // cell editing (same approach as the block adapter)
  function cellRe(ref) { return new RegExp('<c r="' + ref + '"(?:\\s[^>]*?)?(?:\\/>|>[\\s\\S]*?<\\/c>)'); }
  function setCell(xml, ref, val) {
    var re = cellRe(ref), m = xml.match(re), sAttr = m ? ((m[0].match(/\ss="(\d+)"/) || [])[0] || '') : '';
    var nc = val == null ? '<c r="' + ref + '"' + sAttr + '/>'
      : val.n != null ? '<c r="' + ref + '"' + sAttr + '><v>' + val.n + '</v></c>'
      : '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + I.xmlEsc(val.s) + '</t></is></c>';
    if (m) return xml.replace(re, function () { return nc; });
    var rr = ref.match(/^([A-Z]+)(\d+)$/), rowRe = new RegExp('(<row\\b[^>]*\\br="' + rr[2] + '"[^>]*?)(\\/>|>([\\s\\S]*?)<\\/row>)');
    if (!rowRe.test(xml)) return null;
    return xml.replace(rowRe, function (all, open, rest, inner) {
      inner = inner || ''; var ci = I.colToIdx(rr[1]), out = '', placed = false;
      inner.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, function (c) { var cr = c.match(/r="([A-Z]+)\d+"/); if (!placed && cr && I.colToIdx(cr[1]) > ci) { out += nc; placed = true; } out += c; return c; });
      if (!placed) out += nc;
      return open.replace(/\/$/, '') + '>' + out + '</row>';
    });
  }
  function ensureRow(xml, rowNum, tplRow) {
    if (new RegExp('<row\\b[^>]*\\br="' + rowNum + '"').test(xml)) return xml;
    // copy the template row (styles, height) and empty its values
    var m = xml.match(new RegExp('<row\\b[^>]*\\br="' + tplRow + '"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/row>)'));
    var nr = m ? m[0].replace(/(<row\b[^>]*\br=")\d+(")/, '$1' + rowNum + '$2').replace(/\shidden="1"/, '')
      .replace(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>[\s\S]*?<\/c>)/g, function (a, c, attrs) { return '<c r="' + c + rowNum + '"' + attrs.replace(/\s*t="[^"]*"/, '') + '/>'; })
      : '<row r="' + rowNum + '"/>';
    // insert in row order
    var after = null, re = /<row\b[^>]*\br="(\d+)"/g, mm;
    while ((mm = re.exec(xml))) { if (+mm[1] > rowNum) { after = mm.index; break; } }
    if (after == null) after = xml.lastIndexOf('</sheetData>');
    return xml.slice(0, after) + nr + xml.slice(after);
  }
  async function appendRowsRows(log, recs) {
    var zip = log.zip, byTab = {};
    recs.forEach(function (r) { (byTab[r.tab] = byTab[r.tab] || []).push(r); });
    for (var tn in byTab) {
      var t = log.tabs.filter(function (x) { return x.name === tn; })[0], col = t.col, C = I.idxToCol, xml = await zip.file(t.sheetPath).async('string');
      var maxRow = 0;
      byTab[tn].forEach(function (rec) {
        xml = ensureRow(xml, rec.row, t.lastRow);
        xml = xml.replace(new RegExp('(<row\\b[^>]*\\br="' + rec.row + '"[^>]*?)\\shidden="1"'), '$1');
        var put = function (c, v) { if (c == null) return; var nx = setCell(xml, C(c) + rec.row, v); if (nx) xml = nx; };
        if (col.type != null && t.typeVal) put(col.type, { s: t.typeVal });
        put(col.serial, { s: rec.serial });
        put(col.desc, { s: rec.desc });
        put(col.loc, rec.loc ? { s: rec.loc } : null);
        put(col.cat, rec.cat ? { s: rec.cat } : null);
        var g = col.revs[0]; if (g) { put(g.send, dateCell(t, rec.date)); put(g.recv, null); put(g.code, null); }
        maxRow = Math.max(maxRow, rec.row);
      });
      xml = xml.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)(\d+)("\s*\/>)/, function (a, p, n, q) { return p + Math.max(+n, maxRow) + q; });
      zip.file(t.sheetPath, xml);
      // grow the sheet's Excel table so its summary counts include the new rows
      var relF = zip.file(t.sheetPath.replace(/([^/]+)$/, '_rels/$1.rels'));
      if (relF) {
        var rels = I.relsMap(await relF.async('string'), t.sheetPath);
        for (var k in rels) {
          if (!/\/table$/.test(rels[k].type) || !rels[k].path || !zip.file(rels[k].path)) continue;
          var tx = await zip.file(rels[k].path).async('string'), rm = tx.match(/<table\b[^>]*\bref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/);
          if (rm && +rm[2] === t.header && maxRow > +rm[4]) {
            var nref = rm[1] + rm[2] + ':' + rm[3] + maxRow;
            tx = tx.replace(/(<table\b[^>]*\bref=")[^"]+(")/, '$1' + nref + '$2').replace(/(<autoFilter\b[^>]*\bref=")[^"]+(")/, '$1' + nref + '$2');
            zip.file(rels[k].path, tx);
          }
        }
      }
    }
    // let Excel refresh the summary counts (COUNTIF on the tables) when the log is opened
    var wbx = await zip.file('xl/workbook.xml').async('string');
    if (!/fullCalcOnLoad/.test(wbx)) {
      wbx = /<calcPr\b/.test(wbx) ? wbx.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"') : wbx.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      zip.file('xl/workbook.xml', wbx);
    }
    return { added: recs.length };
  }
  async function resubmitRows(log, serial, date, meta) {
    var tab = null, rec = null;
    log.tabs.forEach(function (t) { t.numbered.forEach(function (r) { if (r.serial === serial) { tab = t; rec = r; } }); });
    if (!rec) throw new Error('IR not found');
    var revs = tab.numbered.filter(function (r) { return r.n === rec.n; }), rev = revs.reduce(function (a, r) { return Math.max(a, r.rev || 0); }, 0) + 1;
    var sp = splitSerial(rec.serial), suf = (sp.suffix || tab.suffix || '-REV.00').replace(/(\d+)(?!.*\d)/, function (d) { return pad(rev, d.length); });
    var p = plan(log, [{ tab: tab.name }])[0];
    var r = { format: 'rows', tab: tab.name, kind: tab.kind, n: rec.n, serial: sp.prefix + sp.num + suf, row: p.row, rev: rev, desc: rec.desc, loc: rec.loc, cat: rec.cat, date: date, attempt: Math.min(rev + 1, 3) };
    r.ir = r.serial; r.formIr = r.serial;
    await appendRowsRows(log, [r]);
    return r;
  }

  // ---------- learning a "table cell" IR form ----------
  function cellsOf(xml) {
    var out = [], re = /<w:tc>[\s\S]*?<\/w:tc>|<w:tc\b[^>]*>[\s\S]*?<\/w:tc>/g, m;
    while ((m = re.exec(xml))) { if (/<w:tc[\s>]/.test(m[0].slice(5))) continue; out.push({ i: m.index, x: m[0] }); }
    return out;
  }
  function parasOf(x, base) { var out = [], re = /<w:p\b[^>]*\/>|<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, m; while ((m = re.exec(x))) out.push({ i: base + m.index, x: m[0], t: I.paraText(m[0]) }); return out; }
  function norm2(s) { return low(String(s).replace(/\u00a0/g, ' ').replace(/&amp;/g, '&')).replace(/\s+/g, ' ').replace(/\s*:\s*$/, '').trim(); }
  function placeholderPara(p, name) {
    var open = p.match(/^<w:p\b[^>]*>/); open = open ? open[0] : '<w:p>';
    var pPr = (p.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0];
    var rPr = (p.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)\s*<w:t/) || [null, ''])[1];
    return open + pPr + '<w:r>' + rPr + '<w:t>«' + name + '»</w:t></w:r></w:p>';
  }
  function fmtLike(sample, d) {
    var m = String(sample).match(/(\d{1,2})([\/.\-])(\d{1,2})\2(\d{2,4})/); var sep = m ? m[2] : '/';
    return pad(d.getDate(), 2) + sep + pad(d.getMonth() + 1, 2) + sep + (m && m[4].length === 2 ? String(d.getFullYear()).slice(2) : d.getFullYear());
  }
  async function learnCellForm(bytes, log) {
    var zip = await JSZipRef.loadAsync(bytes), f = zip.file('word/document.xml'); if (!f) throw new Error('This is not a Word .docx file');
    var xml = await f.async('string'), all = I.paraText(xml.replace(/<\/w:p>/g, '</w:p>\n'));
    // which IR is this? look for a serial of the log in the document
    var hit = null;
    log.tabs.forEach(function (t) {
      t.numbered.forEach(function (r) {
        if (hit || !r.desc) return;
        var core = (r.prefix + r.n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/(\d+)$/, function (d) { return '0*' + (+d); });
        if (new RegExp(core.replace(/0\*(\d+)$/, '0*$1') + '(?!\\d)', 'i').test(all)) hit = { t: t, r: r };
      });
    });
    if (!hit) throw new Error('Could not find an IR number from this log in the document. Upload a previous IR that exists in the log.');
    var r = hit.r, t = hit.t;
    var fields = [['IR_No', r.serial], ['Description', r.desc], ['Main_Location', r.loc], ['Item', r.cat], ['Submitted__Date', r.sendRaw]];
    var report = {}, meta = { kind: 'cell' }, used = {};
    var rewrites = [];
    cellsOf(xml).forEach(function (c) {
      var ps = parasOf(c.x, c.i).filter(function (p) { return p.t.trim(); });
      if (!ps.length) return;
      var label = ps.length > 1 && /:\s*$/.test(ps[0].t.replace(/\u00a0/g, ' ')) ? ps[0] : null;
      var vals = label ? ps.slice(1) : ps, vtext = norm2(vals.map(function (p) { return p.t; }).join(' '));
      fields.forEach(function (fd) {
        var name = fd[0], v = fd[1]; if (used[name] && name !== 'Description') return; if (v == null || v === '') return;
        var match = false;
        if (name === 'Submitted__Date') { var d = parseDate(v); if (d) { var dm = vtext.match(/(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/); match = !!dm && vtext.replace(/[^\d\/.\-]/g, '') === dm[0] && +dm[1] === d.getDate() && +dm[2] === d.getMonth() + 1; if (match) meta.dateSample = dm[0]; } }
        else match = vtext === norm2(v);
        if (!match) return;
        if (rewrites.some(function (w) { return w.from <= vals[0].i && w.to >= vals[vals.length - 1].i + vals[vals.length - 1].x.length; })) return;
        rewrites.push({ from: vals[0].i, to: vals[vals.length - 1].i + vals[vals.length - 1].x.length, x: placeholderPara(vals[0].x, name) });
        used[name] = 1; report[name] = 'found';
      });
    });
    // "Revision:00" next to the reference
    parasOf(xml, 0).forEach(function (p) {
      if (/^\s*rev(?:ision)?\.?\s*:?\s*\d{1,2}\s*$/i.test(p.t) && !rewrites.some(function (w) { return p.i >= w.from && p.i < w.to; })) {
        var lbl = p.t.match(/^\s*(rev(?:ision)?\.?\s*:?\s*)/i)[1];
        var open = (p.x.match(/^<w:p\b[^>]*>/) || ['<w:p>'])[0], pPr = (p.x.match(/<w:pPr>[\s\S]*?<\/w:pPr>/) || [''])[0], rPr = (p.x.match(/<w:r\b[^>]*>\s*(<w:rPr>[\s\S]*?<\/w:rPr>)/) || [null, ''])[1];
        rewrites.push({ from: p.i, to: p.i + p.x.length, x: open + pPr + '<w:r>' + rPr + '<w:t xml:space="preserve">' + I.xmlEsc(lbl) + '</w:t></w:r><w:r>' + rPr + '<w:t>«Rev_No»</w:t></w:r></w:p>' });
        report.Rev_No = 'found'; meta.revWidth = (p.t.match(/(\d{1,2})\s*$/) || [, '00'])[1].length;
      }
    });
    rewrites.sort(function (a, b) { return a.from - b.from; });
    var out = '', last = 0; rewrites.forEach(function (w) { if (w.from < last) return; out += xml.slice(last, w.from) + w.x; last = w.to; }); out += xml.slice(last);
    zip.file('word/document.xml', out);
    // the file reference in the footer
    var footers = Object.keys(zip.files).filter(function (k) { return /^word\/footer\d*\.xml$/.test(k); });
    for (var k = 0; k < footers.length; k++) {
      var fx = await zip.file(footers[k]).async('string'), ft = I.paraText(fx);
      var re2 = new RegExp(r.prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(\\d+)(\\s*-?\\s*REV\\.?\\s*\\d+)?', 'i'), fm = ft.match(re2);
      if (!fm) continue;
      // put the whole paragraph's reference text into one run, then make it a field
      var done = false;
      fx = fx.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, function (p) {
        if (done) return p; var pt = I.paraText(p); if (!re2.test(pt)) return p;
        var runs = []; p.replace(/<w:r\b[^>]*>[\s\S]*?<\/w:r>/g, function (rx) { runs.push(rx); return rx; });
        var acc = '', startRun = -1, endRun = -1, mpos = pt.search(re2), mend = mpos + pt.match(re2)[0].length;
        runs.forEach(function (rx, j) { var tt = I.paraText('<w:p>' + rx + '</w:p>'); var a0 = acc.length; acc += tt; if (startRun < 0 && acc.length > mpos) startRun = j; if (endRun < 0 && acc.length >= mend) endRun = j; });
        if (startRun < 0 || endRun < 0) return p;
        var rPr = (runs[startRun].match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
        var before = I.paraText('<w:p>' + runs.slice(0, startRun).join('') + '</w:p>'), sTxt = I.paraText('<w:p>' + runs[startRun] + '</w:p>'), eTxt = I.paraText('<w:p>' + runs[endRun] + '</w:p>');
        var headKeep = sTxt.slice(0, Math.max(0, mpos - before.length)), afterAll = I.paraText('<w:p>' + runs.slice(0, endRun + 1).join('') + '</w:p>'), tailKeep = afterAll.slice(mend);
        var rep = (headKeep ? '<w:r>' + rPr + '<w:t xml:space="preserve">' + I.xmlEsc(headKeep) + '</w:t></w:r>' : '') + '<w:r>' + rPr + '<w:t>«File_No»</w:t></w:r>' + (tailKeep ? '<w:r>' + rPr + '<w:t xml:space="preserve">' + I.xmlEsc(tailKeep) + '</w:t></w:r>' : '');
        var startIdx = p.indexOf(runs[startRun]), endIdx = p.indexOf(runs[endRun], startIdx) + runs[endRun].length;
        done = true; return p.slice(0, startIdx) + rep + p.slice(endIdx);
      });
      if (done) {
        // the file name was a FILENAME field (it would show the .docx name): make it plain text
        fx = fx.replace(/<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="begin"\/><\/w:r>(<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:instrText[^>]*>\s*FILENAME[^<]*<\/w:instrText><\/w:r>)?<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="separate"\/><\/w:r>(<w:r>(?:(?!<\/w:r>)[\s\S])*?«File_No»<\/w:t><\/w:r>)<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="end"\/><\/w:r>/, '$2');
        zip.file(footers[k], fx); report.File_No = 'found'; meta.fileWidth = fm[1].length; meta.fileSuffix = fm[2] || ''; meta.filePrefix = r.prefix; break; }
    }
    meta.logPrefix = r.prefix;
    zip.file('irmaker.json', JSON.stringify(meta));
    var tpl = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    return { bytes: tpl, report: report, sourceIr: r.serial, meta: meta, n: r.n };
  }
  function fileNo(meta, ir) {
    var sp = splitSerial(ir.serial || ir.ir); if (!sp) return ir.serial || '';
    var suf = (meta.fileSuffix || sp.suffix || '').replace(/(\d+)(?!.*\d)/, function (d) { return pad(ir.rev || 0, d.length); });
    return sp.prefix + pad(+sp.num, meta.fileWidth || sp.num.length) + suf;
  }
  async function buildCellForm(templateBytes, irs, meta) {
    var zip = await JSZipRef.loadAsync(templateBytes); if (zip.file('irmaker.json')) zip.remove('irmaker.json');
    var docPath = 'word/document.xml', xml = await zip.file(docPath).async('string');
    var bStart = xml.indexOf('<w:body>') + 8, sect = xml.lastIndexOf('<w:sectPr'), bodyEnd = xml.lastIndexOf('</w:body>');
    if (sect < bStart) sect = bodyEnd;
    var body = xml.slice(bStart, sect), head = xml.slice(0, bStart), tail = xml.slice(sect);
    var i = Math.max(body.lastIndexOf('<w:p '), body.lastIndexOf('<w:p>')), lastP = body.slice(i);
    var core = (i >= 0 && !/<w:t[\s>]|<w:drawing|<w:pict|<w:tbl/.test(lastP)) ? body.slice(0, i) : body;
    var trailing = body.slice(core.length) || '<w:p/>';
    var sectPr = tail.slice(0, tail.indexOf('</w:sectPr>') + 11);
    // one footer per IR so the file name in the footer is right on every page
    var relsPath = 'word/_rels/document.xml.rels', rels = await zip.file(relsPath).async('string');
    var footRefs = []; sectPr.replace(/<w:footerReference\b[^>]*r:id="([^"]+)"[^>]*\/>/g, function (a, id) { footRefs.push(id); return a; });
    var relTarget = function (id) { var m = rels.match(new RegExp('<Relationship\\b[^>]*Id="' + id + '"[^>]*\\/>')); return m ? (m[0].match(/Target="([^"]+)"/) || [])[1] : null; };
    var appX = zip.file('docProps/app.xml') ? await zip.file('docProps/app.xml').async('string') : '', pages = (appX.match(/<Pages>(\d+)<\/Pages>/) || [])[1] || '1';
    // several IRs in one file: "Page x of y" must count the pages of each IR only
    var multiPages = function (fx) {
      if (irs.length < 2) return fx;
      return fx.replace(/(<w:instrText[^>]*>\s*)NUMPAGES([^<]*<\/w:instrText><\/w:r>\s*<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:fldChar w:fldCharType="separate"\/><\/w:r>\s*<w:r\b[^>]*>(?:(?!<\/w:r>)[\s\S])*?<w:t[^>]*>)\d+(<\/w:t>)/g, '$1SECTIONPAGES$2' + pages + '$3');
    };
    var ctPath = '[Content_Types].xml', ct = await zip.file(ctPath).async('string'), seq = 900;
    var footerFor = async function (k, ir) {
      var map = {};
      for (var j = 0; j < footRefs.length; j++) {
        var tg = relTarget(footRefs[j]); if (!tg || !zip.file('word/' + tg)) continue;
        var fx = await zip.file('word/' + tg).async('string'); if (fx.indexOf('«File_No»') < 0) { map[footRefs[j]] = footRefs[j]; continue; }
        var name = 'footer_ir' + k + '_' + j + '.xml', id = 'rIdIR' + (seq++);
        zip.file('word/' + name, multiPages(I.fillFieldsXml(fx, { File_No: fileNo(meta, ir) })));
        rels = rels.replace('</Relationships>', '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="' + name + '"/></Relationships>');
        if (ct.indexOf('/word/' + name) < 0) ct = ct.replace('</Types>', '<Override PartName="/word/' + name + '" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/></Types>');
        map[footRefs[j]] = id;
      }
      var sp = sectPr; if (meta.kind === 'cell') sp = /<w:pgNumType\b/.test(sp) ? sp.replace(/<w:pgNumType\b([^>]*?)\s*w:start="\d+"/, '<w:pgNumType$1').replace(/<w:pgNumType\b/, '<w:pgNumType w:start="1"') : sp.replace(/(<w:cols\b|<w:formProt\b|<w:vAlign\b|<w:noEndnote\b|<w:titlePg\b|<w:textDirection\b|<w:bidi\b|<w:rtlGutter\b|<w:docGrid\b|<\/w:sectPr>)/, '<w:pgNumType w:start="1"/>$1'); Object.keys(map).forEach(function (old) { sp = sp.replace('r:id="' + old + '"', 'r:id="' + map[old] + '"'); });
      return sp;
    };
    var parts = [];
    for (var k = 0; k < irs.length; k++) {
      var ir = irs[k];
      var vals = { IR_No: ir.formIr || ir.serial, Description: ir.desc, Main_Location: ir.loc || ir.formLoc || '', Item: ir.cat || '',
        Submitted__Date: ir.date ? fmtLike(meta.dateSample || '01/01/2026', ir.date) : '', Rev_No: pad(ir.rev || 0, meta.revWidth || 2), File_No: fileNo(meta, ir) };
      var c = I.fillFieldsXml(core, vals), sp = await footerFor(k, ir);
      if (k < irs.length - 1) parts.push(c + '<w:p><w:pPr>' + sp.replace('<w:sectPr', '<w:sectPr') + '</w:pPr></w:p>');
      else { parts.push(c); tail = sp + tail.slice(tail.indexOf('</w:sectPr>') + 11); }
    }
    zip.file(docPath, head + parts.join('') + trailing + tail);
    zip.file(relsPath, rels); zip.file(ctPath, ct);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // ---------- plug in ----------
  E.loadLog = async function (bytes, fileName) {
    var zip = await JSZipRef.loadAsync(bytes);
    if (await isRowLog(zip)) return loadRowLog(zip, fileName);
    return prev.loadLog(bytes, fileName);
  };
  E.understand = function (log, text, today) { return isRows(log) ? understandRows(log, text, today) : prev.understand(log, text, today); };
  E.finalize = function (log, drafts) { return isRows(log) ? finalizeRows(log, drafts) : prev.finalize(log, drafts); };
  E.appendRows = function (log, recs) { return isRows(log) ? appendRowsRows(log, recs) : prev.appendRows(log, recs); };
  E.findDuplicate = function (log, d) { return isRows(log) ? dupRows(log, d) : prev.findDuplicate(log, d); };
  E.dupKey = function (desc, log) { return isRows(log) ? keyOf(desc) : prev.dupKey(desc, log); };
  E.normalizeStations = function (log) { return isRows(log) ? Promise.resolve(0) : prev.normalizeStations(log); };
  E.isUSection = function (log) { return isRows(log) ? false : prev.isUSection(log); };
  E.learnFromFilledIr = function (bytes, log) { return isRows(log) ? learnCellForm(bytes, log) : prev.learnFromFilledIr(bytes, log); };
  E.buildForm = async function (tpl, irs) {
    var meta = await BL.readTemplateMeta(tpl);
    if (meta && meta.kind === 'cell') return buildCellForm(tpl, irs, meta);
    return prev.buildForm(tpl, irs);
  };
  E.recordFromRow = function (log, r, meta) {
    if (!isRows(log)) return prev.recordFromRow(log, r, meta);
    var hit = null; log.tabs.forEach(function (t) { t.numbered.forEach(function (x) { if (x.serial === r.ir) hit = { t: t, x: x }; }); });
    if (!hit) return null;
    return { format: 'rows', tab: hit.t.name, kind: hit.t.kind, n: hit.x.n, serial: hit.x.serial, ir: hit.x.serial, rev: hit.x.rev, desc: hit.x.desc, loc: hit.x.loc, cat: hit.x.cat,
      date: hit.x.date || new Date(), formIr: hit.x.serial, attempt: Math.min((hit.x.rev || 0) + 1, 3) };
  };
  BL.isBlock = function (log) { return isRows(log) || prevBlock.isBlock(log); };
  BL.isRows = isRows;
  BL.preview = function (log, drafts) { return isRows(log) ? plan(log, drafts).map(function (p) { return p.serial; }) : prevBlock.preview(log, drafts); };
  BL.refOf = function (meta, serial, rev) { return meta && meta.kind === 'cell' ? serial : prevBlock.refOf(meta, serial, rev); };
  BL.resubmit = function (log, serial, date, meta) { return isRows(log) ? resubmitRows(log, serial, date, meta) : prevBlock.resubmit(log, serial, date, meta); };
  BL.findRecs = function (log, q) {
    if (!isRows(log)) return prevBlock.findRecs(log, q);
    q = clean(q); var n = (q.match(/(\d+)\s*$/) || q.match(/(\d+)/) || [])[1], out = [];
    log.tabs.forEach(function (t) {
      var word = low(q).replace(/[\d\s.-]+/g, '');
      t.numbered.forEach(function (r) {
        if (!r.desc) return;
        if (low(r.serial) === low(q) || (n != null && r.n === +n && (!word || low(r.serial).replace(/[^a-z]/g, ' ').split(' ').indexOf(word) >= 0 || low(t.name).indexOf(word) >= 0 || low(t.kind).indexOf(word) >= 0 || word.indexOf(low(t.kind)) >= 0))) out.push({ tab: t, rec: r });
      });
    });
    return out;
  };
})(typeof window !== 'undefined' ? window : this);
