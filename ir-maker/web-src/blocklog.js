/* IR Maker — support for "submittal" style IR logs:
   one tab per discipline (IR-Civil, IR-Survey, IR ELEC, IR MECH…), each IR is a block of rows
   (Issue date / Reply Date / Action / Duration / Link) with revisions across columns REV00…REV10.
   Also learns an English "label: value" IR form (References No / Date / Subject / Location …)
   including its drawn check boxes. Plugs into IREngine by wrapping its functions. */
(function (root) {
  'use strict';
  var E = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : root.IREngine;
  var I = E._i, JSZipRef = I.JSZip;
  var base = {};
  ['loadLog', 'understand', 'finalize', 'appendRows', 'findDuplicate', 'dupKey', 'recordFromRow', 'learnFromFilledIr',
   'buildForm', 'normalizeStations', 'isUSection', 'inspectTemplate'].forEach(function (k) { base[k] = E[k]; });

  function isBlock(log) { return !!(log && log.format === 'block'); }
  function low(s) { return String(s == null ? '' : s).toLowerCase(); }
  function clean(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }
  function pad(n, w) { return String(n).padStart(w || 1, '0'); }
  function irNum(s) { var m = String(s || '').match(/(\d+)\s*$/); return m ? +m[1] : null; }

  // ---------- reading ----------
  function findHeader(rows) {
    for (var i = 0; i < Math.min(rows.length, 40); i++) {
      var c = rows[i].cells, txt = c.map(function (v) { return low(v); });
      var si = txt.findIndex(function (v) { return /serial/.test(v); }), ri = txt.findIndex(function (v) { return /rev\.?\s*no/.test(v); });
      if (si >= 0 && ri >= 0) return { i: i, r: rows[i].r, cells: c, txt: txt, serial: si, revno: ri };
    }
    return null;
  }
  async function isBlockLog(zip) {
    var wb = zip.file('xl/workbook.xml'); if (!wb) return false;
    var rels = I.relsMap(await zip.file('xl/_rels/workbook.xml.rels').async('string'), 'xl/workbook.xml');
    var ssPath = null; Object.keys(rels).forEach(function (k) { if (/sharedStrings$/.test(rels[k].type)) ssPath = rels[k].path; });
    var ss = ssPath && zip.file(ssPath) ? I.sharedStringsFrom(await zip.file(ssPath).async('string')) : [];
    var xml = await wb.async('string'), re = /<sheet\b([^>]*)\/?>/g, m, hits = 0;
    while ((m = re.exec(xml))) {
      var rid = (m[1].match(/\br:id="([^"]+)"/) || [])[1]; if (!rels[rid] || !zip.file(rels[rid].path)) continue;
      var sx = await zip.file(rels[rid].path).async('string');
      var rows = I.parseRows(sx.slice(0, 200000), ss);
      var h = findHeader(rows); if (h) hits++;
      if (rows.length && rows[0].cells.some(function (v) { return /^ir\s*no/i.test(String(v || '')); })) return false; // classic one-sheet log
    }
    return hits > 0;
  }
  function kindOf(name, serial) {
    var t = low(name + ' ' + serial);
    if (/survey/.test(t)) return 'Survey';
    if (/elec/.test(t)) return 'ELEC';
    if (/mech|plumb|hvac/.test(t)) return 'MECH';
    if (/arch/.test(t)) return 'Arch';
    if (/civil|struct/.test(t)) return 'Civil';
    return clean(name).replace(/^ir[\s_-]*/i, '') || 'IR';
  }
  function actionCode(v) {
    var a = clean(v).toUpperCase();
    if (/^A\b/.test(a)) return 'A'; if (/^B\b/.test(a)) return 'B'; if (/^C\b/.test(a)) return 'C'; if (/^D\b/.test(a)) return 'D';
    return 'W';
  }
  function statusName(a) { return a === 'A' ? 'Approved' : a === 'B' ? 'Approved as noted' : a === 'C' ? 'Revise and resubmit' : a === 'D' ? 'Rejected' : 'Pending'; }

  async function loadBlockLog(zip, fileName) {
    var wb = await zip.file('xl/workbook.xml').async('string');
    var rels = I.relsMap(await zip.file('xl/_rels/workbook.xml.rels').async('string'), 'xl/workbook.xml');
    var ssPath = null; Object.keys(rels).forEach(function (k) { if (/sharedStrings$/.test(rels[k].type)) ssPath = rels[k].path; });
    var ss = ssPath && zip.file(ssPath) ? I.sharedStringsFrom(await zip.file(ssPath).async('string')) : [];
    var tabs = [], project = '', re = /<sheet\b([^>]*)\/?>/g, m;
    while ((m = re.exec(wb))) {
      var name = I.xmlDecode((m[1].match(/\bname="([^"]*)"/) || [])[1] || ''), rid = (m[1].match(/\br:id="([^"]+)"/) || [])[1];
      if (!rels[rid] || !zip.file(rels[rid].path)) continue;
      var path = rels[rid].path, sx = await zip.file(path).async('string'), rows = I.parseRows(sx, ss), h = findHeader(rows);
      if (!h) continue;
      if (!project) rows.slice(0, h.i).forEach(function (r) { r.cells.forEach(function (v) { var pm = String(v || '').match(/project\s*:\s*(.+)/i); if (pm && !project) project = clean(pm[1]); }); });
      var col = { serial: h.serial, revno: h.revno, revs: [] };
      h.txt.forEach(function (v, i) {
        if (v === 's' && col.s == null) col.s = i;
        if (/^description/.test(v)) col.desc = i;
        if (/^type/.test(v)) col.type = i;
        if (/^remark/.test(v)) col.remarks = i;
        if (/^rev\s*\d+$/.test(v.replace(/\s+/g, ''))) col.revs.push(i);
      });
      if (col.s == null && h.serial > 0) col.s = h.serial - 1;
      var byRow = {}; rows.forEach(function (r) { byRow[r.r] = r.cells; });
      var cell = function (r, c) { return byRow[r] ? byRow[r][c] : null; };
      var recs = [];
      rows.forEach(function (r) {
        if (r.r <= h.r) return;
        var sv = r.cells[col.serial];
        if (!sv || !/ir/i.test(String(sv)) || !/\d/.test(String(sv))) return;
        recs.push({ row: r.r, serial: clean(sv) });
      });
      recs.forEach(function (rec, k) {
        var next = recs[k + 1] ? recs[k + 1].row : rec.row + 5;
        rec.size = Math.max(3, Math.min(8, next - rec.row));
        // which row holds what, by the label in the REV. NO column
        var off = { issue: 0, reply: 1, action: 2, dur: 3, link: 4 };
        for (var d = 0; d < rec.size; d++) {
          var lb = low(cell(rec.row + d, col.revno));
          if (/issue/.test(lb)) off.issue = d; else if (/reply/.test(lb)) off.reply = d; else if (/action/.test(lb)) off.action = d;
          else if (/duration/.test(lb)) off.dur = d; else if (/link/.test(lb)) off.link = d;
        }
        rec.off = off;
        rec.n = irNum(rec.serial);
        var pm = rec.serial.match(/^(.*?)(\d+)$/); rec.prefix = pm ? pm[1] : rec.serial; rec.width = pm ? pm[2].length : 4;
        rec.desc = clean(cell(rec.row, col.desc));
        rec.type = col.type != null ? clean(cell(rec.row, col.type)) : '';
        rec.sNum = col.s != null ? cell(rec.row, col.s) : null;
        rec.revs = col.revs.map(function (c) { return { issue: cell(rec.row + off.issue, c), reply: cell(rec.row + off.reply, c), action: cell(rec.row + off.action, c) }; });
        var lr = -1; rec.revs.forEach(function (v, i) { if (typeof v.issue === 'number') lr = i; });
        rec.lastRev = Math.max(0, lr);
        var lv = rec.revs[rec.lastRev] || {};
        rec.action = actionCode(lv.action);
        rec.date = typeof lv.issue === 'number' ? I.serialToDate(lv.issue) : null;
      });
      var kind = kindOf(name, recs[0] ? recs[0].serial : '');
      var described = recs.filter(function (r) { return r.desc; });
      var maxDesc = described.reduce(function (a, r) { return Math.max(a, r.n || 0); }, 0);
      var tab = { name: name, kind: kind, sheetPath: path, header: h.r, col: col, recs: recs,
        prefix: recs.length ? recs[recs.length - 1].prefix : 'IR-' + kind + '-', width: recs.length ? recs[recs.length - 1].width : 4,
        lastNum: recs.reduce(function (a, r) { return Math.max(a, r.n || 0); }, 0), maxDescribed: maxDesc };
      // empty rows already prepared at the end of the tab (serial ready, no description yet)
      tab.slots = recs.filter(function (r) { return !r.desc && r.n > maxDesc && r.lastRev === 0; }).sort(function (a, b) { return a.n - b.n; });
      tabs.push(tab);
    }
    if (!tabs.length) throw new Error('No IR tab found in this workbook');
    var rows = [];
    tabs.forEach(function (t) {
      t.recs.forEach(function (r) {
        if (!r.desc) return;
        rows.push({ ir: r.serial, rev: r.lastRev, desc: r.desc, date: r.date, action: r.action, status: statusName(r.action),
          item: r.type || t.kind, subItem: '', tab: t.name, kind: t.kind, label: t.kind + ' ' + r.n, n: r.n, block: null, loc: '', unit: unitOf(r.desc) });
      });
    });
    rows.sort(function (a, b) { return ((a.date ? +a.date : 0) - (b.date ? +b.date : 0)) || (a.n - b.n); });
    var absPath = I.xmlDecode((wb.match(/absPath url="([^"]*)"/) || [])[1] || '');
    return { format: 'block', zip: zip, ss: ss, tabs: tabs, rows: rows, project: project, fileName: fileName || '', absPath: absPath,
      blocks: {}, lastNum: '', prefix: '', width: 4, col: {}, shapes: {} };
  }

  // ---------- understanding a request (English, log wording) ----------
  var STOP = ['for', 'the', 'of', 'and', 'to', 'in', 'on', 'at', 'a', 'an', 'with', 'unit', 'units', 'plot', 'building', 'bldg', 'no', 'ir', 'please', 'want', 'need'];
  function words(s) {
    return low(s).replace(/[+-]?\d+(\.\d+)?/g, ' ').replace(/[^a-z؀-ۿ ]/g, ' ').split(/\s+/)
      .filter(function (w) { return w.length > 1 && STOP.indexOf(w) < 0; });
  }
  function near(a, b) { return a === b || (a.length > 3 && b.length > 3 && (a.indexOf(b) === 0 || b.indexOf(a) === 0)); }
  function unitsIn(s) { var out = [], re = /(^|[^\d.+])(\d{3})(?![\d.])/g, m; s = String(s); while ((m = re.exec(s))) if (out.indexOf(m[2]) < 0) out.push(m[2]); return out; }
  function levelsIn(s) { var out = [], re = /[+-]\s?\d+(?:\.\d+)?|\d+\.\d+/g, m; while ((m = re.exec(String(s)))) out.push(m[0].replace(/\s/g, '')); return out; }
  function unitOf(desc) { var u = unitsIn(desc); return u.length ? u[u.length - 1] : ''; }
  function tabFor(log, text) {
    var t = low(text), want = null;
    if (/\bsurvey|co-?axis|setting out|as[- ]?built|traverse|check (soil )?level/.test(t)) want = 'Survey';
    else if (/\belec|lighting|electrical|cable|conduit/.test(t)) want = 'ELEC';
    else if (/\bmech|plumb|hvac|drain|builder work|fire/.test(t)) want = 'MECH';
    else if (/\bcivil|struct/.test(t)) want = 'Civil';
    return want ? log.tabs.filter(function (x) { return x.kind === want; })[0] || null : null;
  }
  function adapt(tpl, text) {
    var us = unitsIn(text), ls = levelsIn(text), out = tpl;
    if (us.length) {
      var tu = unitsIn(tpl);
      if (tu.length) tu.forEach(function (u) { out = out.replace(new RegExp('(^|[^\\d.+])' + u + '(?![\\d.])', 'g'), '$1' + us[0]); });
      else out = clean(out) + ' ( ' + us[0] + ' )';
    }
    if (ls.length) { var tl = levelsIn(tpl), k = 0; tl.forEach(function (l) { if (ls[k] != null) { out = out.replace(l, ls[k]); k++; } }); }
    return clean(out);
  }
  function understandBlock(log, text, today) {
    var raw = clean(text), tab = tabFor(log, raw), warnings = [], uw = words(raw);
    var pool = []; (tab ? [tab] : log.tabs).forEach(function (t) { t.recs.forEach(function (r, i) { if (r.desc) pool.push({ t: t, r: r, i: i }); }); });
    var best = null, bs = 0;
    pool.forEach(function (p) {
      var rw = words(p.r.desc); if (!rw.length || !uw.length) return;
      var hit = 0; uw.forEach(function (w) { if (rw.some(function (x) { return near(w, x); })) hit++; });
      var back = 0; rw.forEach(function (x) { if (uw.some(function (w) { return near(w, x); })) back++; });
      var pairs = 0; for (var q = 0; q + 1 < uw.length; q++) { var ia = rw.findIndex(function (x) { return near(uw[q], x); }), ib = rw.findIndex(function (x) { return near(uw[q + 1], x); }); if (ia >= 0 && ib === ia + 1) pairs++; }
      var sc = hit / uw.length * 0.7 + back / rw.length * 0.3 + 0.04 * pairs + 0.02 * (p.i / Math.max(1, p.t.recs.length));
      if (sc > bs) { bs = sc; best = p; }
    });
    var units = unitsIn(raw), list = units.length > 1 ? units : [units[0] || null];
    var drafts = [];
    list.forEach(function (u) {
      var t = raw.replace(new RegExp('(^|[^\\d.+])\\d{3}(?![\\d.])', 'g'), '$1').trim();
      var src = u ? t + ' ' + u : raw, desc, useTab = tab;
      if (best && bs >= 0.62) { desc = adapt(best.r.desc, src); useTab = useTab || best.t; }
      else { desc = clean(src); if (!useTab) warnings.push('No similar IR in the log. Check the tab and the wording before saving.'); }
      useTab = useTab || log.tabs[0];
      if (!unitsIn(desc).length) warnings.push('No unit / plot number found. Add it, e.g. 445');
      drafts.push({ desc: desc, tab: useTab.name, unit: unitOf(desc), rev: 0, date: today || new Date(), item: useTab.kind, subItem: '', unit2: '', block: null, formItem: useTab.kind });
    });
    return { drafts: drafts, warnings: warnings.filter(function (w, i, a) { return a.indexOf(w) === i; }), rule: best && bs >= 0.62 ? 'learned' : null, alternatives: [] };
  }

  // ---------- duplicates ----------
  // same words + same numbers, in any order (common typos folded)
  function keyOf(desc) {
    var t = low(desc).replace(/inespection/g, 'inspection').replace(/celing/g, 'ceiling').replace(/preperation/g, 'preparation').replace(/layter/g, 'layer').replace(/checl\b/g, 'check')
      .replace(/\bground floor\b/g, 'gf').replace(/\bfirst floor\b/g, 'ff').replace(/\breinforcement\b/g, 'rft');
    var toks = t.replace(/[^a-z0-9.+؀-ۿ]+/g, ' ').split(' ').filter(function (w) { return w && STOP.indexOf(w) < 0; });
    return toks.filter(function (w, i, a) { return a.indexOf(w) === i; }).sort().join(' ');
  }
  function dupBlock(log, d) {
    var tab = log.tabs.filter(function (t) { return t.name === d.tab; })[0]; if (!tab) return null;
    var k = keyOf(d.desc); if (!k) return null;
    var hit = tab.recs.filter(function (r) { return r.desc && keyOf(r.desc) === k; }).pop();
    if (!hit) return null;
    return { row: { date: hit.date }, n: hit.n, rev: hit.lastRev, action: hit.action, rejected: hit.action === 'C' || hit.action === 'D',
      status: statusName(hit.action), label: hit.serial + '-R' + pad(hit.lastRev, 2), printKey: hit.serial };
  }

  // ---------- numbering ----------
  function plan(log, drafts) {
    var st = {};
    log.tabs.forEach(function (t) { st[t.name] = { slots: t.slots.slice(), next: t.lastNum + 1, t: t }; });
    return drafts.map(function (d) {
      var s = st[d.tab] || st[log.tabs[0].name], t = s.t, slot = s.slots.shift(), n, serial;
      if (slot) { n = slot.n; serial = slot.serial; }
      else { n = s.next++; serial = t.prefix + pad(n, t.width); }
      return { tab: t, n: n, serial: serial, slot: slot || null };
    });
  }
  function preview(log, drafts) { return plan(log, drafts).map(function (p) { return p.serial; }); }

  // ---------- form defaults (subject / location / reference) ----------
  function dateText(meta, d) {
    if (!d) return '';
    var dd = pad(d.getDate(), 2), mm = pad(d.getMonth() + 1, 2), sep = (meta && meta.dateSep) || '-';
    return dd + sep + mm + sep + d.getFullYear();
  }
  function formDefaults(meta, ir) {
    meta = meta || {};
    var desc = clean(ir.desc), unit = ir.unit || unitOf(desc);
    var subj = desc;
    if (meta.subjStripUnit && unit) subj = clean(subj.replace(new RegExp('\\(?\\s*' + unit + '\\s*\\)?'), ' ').replace(/\(\s*\)/g, ''));
    subj = clean(subj) + (meta.subjSuffix || '');
    var loc = meta.locTpl ? (unit ? meta.locTpl.replace('{U}', unit) : meta.locTpl.replace(/\s*\{U\}/, '')) : (unit ? 'Unit ' + unit : '');
    var core = clean(desc.replace(new RegExp('\\(?\\s*' + (unit || 'xxxx') + '\\s*\\)?'), ' ').replace(/\(\s*\)/g, ''));
    var attach = meta.attachTpl ? meta.attachTpl.replace('{SU}', core.toUpperCase()).replace('{S}', core) : '';
    var types = { Civil: 'Civil/Struct.', Survey: 'Survey', ELEC: 'Electrical', MECH: 'Plumbing', Arch: 'Architectural' };
    return { subject: subj, loc: loc, attach: attach, insType: types[ir.kind] || 'Others' };
  }
  function refOf(meta, serial, rev) {
    meta = meta || {};
    var s = meta.refUpper ? serial.toUpperCase() : serial;
    return s + (meta.revSep != null ? meta.revSep : '-R') + pad(rev || 0, meta.revWidth || 2);
  }

  function finalizeBlock(log, drafts) {
    var p = plan(log, drafts);
    return drafts.map(function (d, i) {
      var t = p[i].tab;
      return { format: 'block', tab: t.name, kind: t.kind, n: p[i].n, serial: p[i].serial, ir: p[i].serial, slot: p[i].slot, rev: 0,
        desc: d.desc, unit: d.unit || unitOf(d.desc), date: d.date, subject: d.subject, formLoc: d.formLoc, attach: d.attach, insType: d.insType,
        formItem: d.insType || t.kind, attempt: 1, action: 'W', status: 'Pending' };
    });
  }

  // ---------- writing the workbook ----------
  function cellRe(ref) { return new RegExp('<c r="' + ref + '"(?:\\s[^>]*?)?(?:\\/>|>[\\s\\S]*?<\\/c>)'); }
  function setCell(xml, ref, val) {
    var re = cellRe(ref), m = xml.match(re), sAttr = '';
    var styleOf = function (c) { var mm = c.match(/\ss="(\d+)"/); return mm ? ' s="' + mm[1] + '"' : ''; };
    if (m) sAttr = styleOf(m[0]);
    var nc;
    if (val == null) nc = '<c r="' + ref + '"' + sAttr + '/>';
    else if (val.f != null) nc = '<c r="' + ref + '"' + sAttr + '><f>' + I.xmlEsc(val.f) + '</f></c>';
    else if (val.n != null) nc = '<c r="' + ref + '"' + sAttr + '><v>' + val.n + '</v></c>';
    else nc = '<c r="' + ref + '"' + sAttr + ' t="inlineStr"><is><t xml:space="preserve">' + I.xmlEsc(val.s) + '</t></is></c>';
    if (m) return xml.replace(re, function () { return nc; });
    // the cell does not exist yet: put it in its row, in column order
    var rr = ref.match(/^([A-Z]+)(\d+)$/), rowRe = new RegExp('(<row\\b[^>]*\\br="' + rr[2] + '"[^>]*?)(\\/>|>([\\s\\S]*?)<\\/row>)');
    return xml.replace(rowRe, function (all, open, rest, inner) {
      inner = inner || ''; var ci = I.colToIdx(rr[1]), out = '', placed = false;
      inner.replace(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g, function (c) {
        var cr = c.match(/r="([A-Z]+)\d+"/); if (!placed && cr && I.colToIdx(cr[1]) > ci) { out += nc; placed = true; } out += c; return c;
      });
      if (!placed) out += nc;
      return open + '>' + out + '</row>';
    });
  }
  function shiftFormula(f, dCol, dRow, rowFrom, rowTo) {
    return f.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, function (all, d1, c, d2, r) {
      var ci = I.colToIdx(c) + (d1 ? 0 : dCol), rn = +r;
      if (!d2 && rn >= rowFrom && rn <= rowTo) rn += dRow;
      return d1 + I.idxToCol(ci) + d2 + rn;
    });
  }
  function cloneBlock(xml, from, size, to) {
    var dRow = to - from, rows = [];
    for (var r = from; r < from + size; r++) {
      var m = xml.match(new RegExp('<row\\b[^>]*\\br="' + r + '"[^>]*?(?:\\/>|>[\\s\\S]*?<\\/row>)'));
      rows.push(m ? m[0] : '<row r="' + r + '"/>');
    }
    var masters = {};
    rows.forEach(function (rx) { rx.replace(/<c r="([A-Z]+)(\d+)"[^>]*>\s*<f\b([^>]*)>([^<]*)<\/f>/g, function (a, c, rn, attrs, f) { var si = (attrs.match(/si="(\d+)"/) || [])[1]; if (si != null && /t="shared"/.test(attrs)) masters[si] = { col: I.colToIdx(c), f: I.xmlDecode(f) }; return a; }); });
    return rows.map(function (rx) {
      rx = rx.replace(/(<row\b[^>]*\br=")(\d+)(")/, function (a, p, n, q) { return p + (+n + dRow) + q; });
      return rx.replace(/<c r="([A-Z]+)(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g, function (all, c, rn, attrs, tail, inner) {
        var ref = c + (+rn + dRow);
        if (!inner) return '<c r="' + ref + '"' + attrs + '/>';
        var fm = inner.match(/<f\b([^>]*?)(?:\/>|>([^<]*)<\/f>)/);
        if (fm) {
          var fa = fm[1], ftxt = fm[2] != null ? I.xmlDecode(fm[2]) : null, si = (fa.match(/si="(\d+)"/) || [])[1];
          if (ftxt == null && si != null && masters[si]) ftxt = shiftFormula(masters[si].f, I.colToIdx(c) - masters[si].col, 0, 0, 0);
          if (ftxt == null) return '<c r="' + ref + '"' + attrs.replace(/\s*t="[^"]*"/, '') + '/>';
          var ca = /ca="1"/.test(fa) ? ' ca="1"' : '';
          return '<c r="' + ref + '"' + attrs.replace(/\s*t="[^"]*"/, '') + '><f' + ca + '>' + I.xmlEsc(shiftFormula(ftxt, 0, dRow, from, from + size - 1)) + '</f></c>';
        }
        return '<c r="' + ref + '"' + attrs + '>' + inner + '</c>';
      });
    }).join('');
  }
  async function appendBlock(log, recs) {
    var zip = log.zip, byTab = {};
    recs.forEach(function (r) { (byTab[r.tab] = byTab[r.tab] || []).push(r); });
    for (var tn in byTab) {
      var tab = log.tabs.filter(function (t) { return t.name === tn; })[0], col = tab.col, xml = await zip.file(tab.sheetPath).async('string');
      var C = function (i) { return I.idxToCol(i); }, rev0 = col.revs[0];
      var last = tab.recs[tab.recs.length - 1], size = last ? last.size : 5, off = last ? last.off : { issue: 0, reply: 1, action: 2, dur: 3, link: 4 };
      var endRow = last ? last.row + size - 1 : tab.header, sMax = tab.recs.reduce(function (a, r) { return Math.max(a, +r.sNum || 0); }, 0);
      var added = 0, merges = [];
      if (last) (xml.match(/<mergeCell ref="[A-Z]+\d+:[A-Z]+\d+"\/>/g) || []).forEach(function (mc) {
        var mm = mc.match(/ref="([A-Z]+)(\d+):([A-Z]+)(\d+)"/); if (+mm[2] >= last.row && +mm[4] <= endRow) merges.push(mm);
      });
      for (var k = 0; k < byTab[tn].length; k++) {
        var rec = byTab[tn][k], top;
        if (rec.slot) top = rec.slot.row;
        else {
          top = endRow + 1 + added * size; added++;
          var block = cloneBlock(xml, last.row, size, top);
          var sd = xml.lastIndexOf('</sheetData>'); xml = xml.slice(0, sd) + block + xml.slice(sd);
          var newM = merges.map(function (mm) { return '<mergeCell ref="' + mm[1] + (+mm[2] + top - last.row) + ':' + mm[3] + (+mm[4] + top - last.row) + '"/>'; }).join('');
          if (newM) xml = xml.replace(/<mergeCells count="(\d+)">/, function (a, n) { return '<mergeCells count="' + (+n + merges.length) + '">'; }).replace('</mergeCells>', newM + '</mergeCells>');
          if (col.s != null) xml = setCell(xml, C(col.s) + top, { n: ++sMax });
          xml = setCell(xml, C(col.serial) + top, { s: rec.serial });
          // clear revision cells of the copied block; keep formulas (duration / link rows)
          col.revs.forEach(function (c, i) {
            [off.issue, off.reply, off.action].forEach(function (o) { xml = setCell(xml, C(c) + (top + o), (i === 0 && o === off.reply) ? { f: 'TODAY()' } : null); });
            if (i === 0) xml = setCell(xml, C(c) + (top + off.link), null);
          });
          if (col.remarks != null) xml = setCell(xml, C(col.remarks) + top, null);
        }
        xml = setCell(xml, C(col.desc) + top, { s: rec.desc });
        xml = setCell(xml, C(rev0) + (top + off.issue), { n: I.dateToSerial(rec.date) });
        xml = setCell(xml, C(rev0) + (top + off.action), { s: 'Pending' });
      }
      if (added) xml = xml.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)(\d+)("\s*\/>)/, function (a, p, n, q) { return p + Math.max(+n, endRow + added * size) + q; });
      zip.file(tab.sheetPath, xml);
    }
    var wbx = await zip.file('xl/workbook.xml').async('string');
    if (!/fullCalcOnLoad/.test(wbx)) {
      wbx = /<calcPr\b/.test(wbx) ? wbx.replace(/<calcPr\b/, '<calcPr fullCalcOnLoad="1"') : wbx.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      zip.file('xl/workbook.xml', wbx);
    }
    return { added: recs.length };
  }
  // next revision of an existing IR (same serial, next REV column)
  async function resubmitBlock(log, serial, date, meta) {
    var tab = null, rec = null;
    log.tabs.forEach(function (t) { t.recs.forEach(function (r) { if (r.serial === serial) { tab = t; rec = r; } }); });
    if (!rec) throw new Error('IR not found');
    var rev = rec.lastRev + 1; if (rev >= tab.col.revs.length) throw new Error('No free revision column left for this IR');
    var c = I.idxToCol(tab.col.revs[rev]), xml = await log.zip.file(tab.sheetPath).async('string');
    xml = setCell(xml, c + (rec.row + rec.off.issue), { n: I.dateToSerial(date) });
    xml = setCell(xml, c + (rec.row + rec.off.action), { s: 'Pending' });
    log.zip.file(tab.sheetPath, xml);
    var d = { format: 'block', tab: tab.name, kind: tab.kind, n: rec.n, serial: rec.serial, ir: rec.serial, rev: rev, desc: rec.desc, unit: unitOf(rec.desc), date: date, attempt: Math.min(rev + 1, 3) };
    var fd = formDefaults(meta, d); d.subject = fd.subject; d.formLoc = fd.loc; d.attach = fd.attach; d.insType = fd.insType; d.formIr = refOf(meta, rec.serial, rev);
    return d;
  }
  function findRecs(log, q) {
    q = clean(q); var n = irNum(q), out = [];
    log.tabs.forEach(function (t) {
      t.recs.forEach(function (r) {
        if (!r.desc) return;
        if (low(r.serial) === low(q) || (n != null && r.n === n && (!/[a-z]/i.test(q.replace(/\d+/g, '')) || low(q).indexOf(low(t.kind)) >= 0 || low(t.name).indexOf(low(q).replace(/[\d\s-]+/g, '')) >= 0))) out.push({ tab: t, rec: r });
      });
    });
    return out;
  }
  function recordOf(log, tab, rec, meta, rev) {
    rev = rev == null ? rec.lastRev : rev;
    var lv = rec.revs[rev] || {};
    var d = { format: 'block', tab: tab.name, kind: tab.kind, n: rec.n, serial: rec.serial, ir: rec.serial, rev: rev, desc: rec.desc, unit: unitOf(rec.desc),
      date: typeof lv.issue === 'number' ? I.serialToDate(lv.issue) : (rec.date || new Date()), attempt: Math.min(rev + 1, 3) };
    var fd = formDefaults(meta, d); d.subject = fd.subject; d.formLoc = fd.loc; d.attach = fd.attach; d.insType = fd.insType; d.formIr = refOf(meta, rec.serial, rev);
    return d;
  }

  // ---------- learning an English "label: value" IR form ----------
  var LABELS = [
    ['IR_No', /^\s*references?\s*no\.?\s*:/i], ['Insp_Date', /^\s*date\s+of\s+inspection\s*:/i], ['Submitted__Date', /^\s*date\s*:/i],
    ['Description', /^\s*subject\s*:/i], ['Main_Location', /^\s*location\s*:/i], ['Attachment', /^\s*attachments?\s*:/i]
  ];
  var TYPE_LABELS = [['Architectural', /architectural/i], ['Civil/Struct.', /civil\s*\/?\s*struct/i], ['Electrical', /electrical/i], ['HVAC', /hvac/i],
    ['Plumbing', /plumbing/i], ['Fire Protection', /fire\s*protection/i], ['Survey', /survey/i], ['Others', /others/i]];
  function runsOf(p) { var out = [], re = /<w:r\b[^>]*>[\s\S]*?<\/w:r>|<w:r\b[^>]*\/>/g, m; while ((m = re.exec(p))) out.push({ i: m.index, x: m[0], t: I.paraText('<w:p>' + m[0] + '</w:p>') }); return out; }
  function rewriteLabelPara(p, field) {
    var runs = runsOf(p); if (!runs.length) return null;
    var acc = '', ci = -1, cut = 0;
    for (var k = 0; k < runs.length; k++) { var pos = runs[k].t.indexOf(':'); if (pos >= 0) { ci = k; cut = pos + 1; break; } acc += runs[k].t; }
    if (ci < 0) return null;
    var lastVal = -1; for (var j = runs.length - 1; j >= 0; j--) { var tt = j === ci ? runs[j].t.slice(cut) : runs[j].t; if (j >= ci && /\S/.test(tt)) { lastVal = j; break; } }
    var valRun = runs.slice(ci + 1).filter(function (r) { return /\S/.test(r.t); })[0] || runs[Math.min(runs.length - 1, ci + 1)] || runs[ci];
    var rPr = (valRun.x.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    var colonRun = runs[ci], cpr = (colonRun.x.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
    var head = p.slice(0, colonRun.i), keepCol = '<w:r>' + cpr + '<w:t xml:space="preserve">' + I.xmlEsc(colonRun.t.slice(0, cut)) + ' </w:t></w:r>';
    var mid = '<w:r>' + rPr + '<w:t xml:space="preserve">«' + field + '»</w:t></w:r>';
    var tail = '';
    for (var q = Math.max(ci, lastVal) + 1; q < runs.length; q++) tail += runs[q].x;
    // keep drawings anchored in the replaced runs
    for (var z = ci; z <= lastVal; z++) { var dm = runs[z].x.match(/<mc:AlternateContent>[\s\S]*?<\/mc:AlternateContent>|<w:pict>[\s\S]*?<\/w:pict>|<w:drawing>[\s\S]*?<\/w:drawing>/g); if (dm) tail = '<w:r>' + dm.join('') + '</w:r>' + tail; }
    var last = runs[runs.length - 1], end = p.slice(last.i + last.x.length);
    return head + keepCol + mid + tail + end;
  }
  function rectsIn(p, offset) {
    var out = [], re = /<v:rect\b([^>]*?)\/?>/g, m;
    while ((m = re.exec(p))) {
      var st = (m[1].match(/style="([^"]*)"/) || [])[1] || '', ml = (st.match(/margin-left:\s*(-?[\d.]+)/) || [])[1], mt = (st.match(/margin-top:\s*(-?[\d.]+)/) || [])[1];
      out.push({ at: offset + m.index, left: ml != null ? +ml : 0, top: mt != null ? +mt : 0, filled: /fillcolor="black/i.test(m[1]) });
    }
    return out;
  }
  async function learnLabelForm(bytes, log) {
    var zip = await JSZipRef.loadAsync(bytes), f = zip.file('word/document.xml'); if (!f) throw new Error('This is not a Word .docx file');
    var xml = await f.async('string'), paras = [], re = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, m;
    while ((m = re.exec(xml))) paras.push({ i: m.index, x: m[0], t: I.paraText(m[0]) });
    var meta = { kind: 'label' }, report = {}, values = {}, done = {};
    // check boxes (drawn rectangles), numbered in document order
    var allRects = []; paras.forEach(function (p) { rectsIn(p.x, p.i).forEach(function (r) { allRects.push(r); }); });
    allRects.sort(function (a, b) { return a.at - b.at; });
    var idxOf = function (r) { return allRects.indexOf(r); };
    var typeMap = {}, inspMap = {}, pending = [];
    paras.forEach(function (p, k) {
      var rs = rectsIn(p.x, p.i).map(function (r) { return allRects.filter(function (a) { return a.at === r.at; })[0]; });
      var labs = TYPE_LABELS.map(function (L) { var mm = p.t.search(L[1]); return mm >= 0 ? { name: L[0], pos: mm } : null; }).filter(Boolean).sort(function (a, b) { return a.pos - b.pos; });
      if (/1\s*st/i.test(p.t) && /2\s*nd/i.test(p.t)) {
        var il = [['1st', p.t.search(/1\s*st/i)], ['2nd', p.t.search(/2\s*nd/i)], ['Others', p.t.search(/others/i)]].filter(function (x) { return x[1] >= 0; }).sort(function (a, b) { return a[1] - b[1]; });
        rs.slice().sort(function (a, b) { return a.left - b.left; }).forEach(function (r, i) { if (il[i]) inspMap[il[i][0]] = idxOf(r); });
        return;
      }
      if (labs.length >= 2) {
        var sorted = rs.slice().sort(function (a, b) { return a.left - b.left; }), startAt = sorted.length === labs.length ? 0 : (sorted.length === labs.length - 1 ? 1 : 0);
        sorted.forEach(function (r, i) { var L = labs[i + startAt]; if (L) typeMap[L.name] = idxOf(r); });
        if (startAt === 1) pending.push(labs[0].name);
        return;
      }
      if (/type\s+of\s+inspection/i.test(p.t) && rs.length) p.lineRects = rs.slice().sort(function (a, b) { return a.top - b.top; });
    });
    var lineP = paras.filter(function (p) { return p.lineRects; })[0];
    if (lineP) lineP.lineRects.forEach(function (r, i) { if (pending[i]) typeMap[pending[i]] = idxOf(r); });
    if (Object.keys(typeMap).length) { meta.typeRects = typeMap; report.type = 'found'; }
    if (Object.keys(inspMap).length) { meta.inspRects = inspMap; report.insp = 'found'; }
    // label: value fields
    var out = '', last = 0;
    paras.forEach(function (p) {
      for (var j = 0; j < LABELS.length; j++) {
        var L = LABELS[j]; if (done[L[0]] || !L[1].test(p.t)) continue;
        var nx = rewriteLabelPara(p.x, L[0]); if (!nx) continue;
        values[L[0]] = clean(p.t.slice(p.t.indexOf(':') + 1)); done[L[0]] = 1; report[L[0]] = 'found';
        out += xml.slice(last, p.i) + nx; last = p.i + p.x.length; break;
      }
    });
    out += xml.slice(last);
    // learn the value formats from the old IR
    var ref = values.IR_No || '', rm = ref.match(/^(.*?)(\d{2,6})(\s*[-_ /]?\s*R(?:ev)?\.?\s*)(\d{1,2})$/i);
    if (rm) { meta.refUpper = rm[1] === rm[1].toUpperCase() && /[A-Z]/.test(rm[1]); meta.revSep = rm[3].replace(/\s+/g, ''); meta.revWidth = rm[4].length; }
    else { meta.refUpper = ref === ref.toUpperCase() && /[A-Z]/.test(ref); meta.revSep = '-R'; meta.revWidth = 2; }
    var dm = (values.Submitted__Date || values.Insp_Date || '').match(/\d{1,2}\s*([-./])\s*\d{1,2}\s*[-./]\s*\d{2,4}/); meta.dateSep = dm ? dm[1] : '-';
    var subj = values.Description || '', sm = subj.match(/\s*\.\s*$/); meta.subjSuffix = sm ? (/^\s/.test(sm[0]) ? ' .' : '.') : '';
    var subjCore = clean(subj.replace(/\s*\.\s*$/, ''));
    meta.subjStripUnit = !unitsIn(subjCore).length;
    var loc = values.Main_Location || ''; var lu = unitsIn(loc);
    meta.locTpl = lu.length ? loc.replace(new RegExp('(^|[^\\d])' + lu[lu.length - 1] + '(?!\\d)'), '$1{U}') : loc;
    var att = values.Attachment || '';
    if (att && subjCore) {
      var na = low(att).replace(/\s+/g, ' '), ns = low(subjCore).replace(/\s+/g, ' ');
      if (na.indexOf(ns) === 0) { var rest = att.replace(/\s+/g, ' ').slice(subjCore.replace(/\s+/g, ' ').length); var head0 = att.replace(/\s+/g, ' ').slice(0, subjCore.replace(/\s+/g, ' ').length); meta.attachTpl = (head0 === head0.toUpperCase() ? '{SU}' : '{S}') + rest; }
      else meta.attachTpl = '';
    } else meta.attachTpl = '';
    // empty the old check marks so a fresh copy starts clean
    zip.file('word/document.xml', out);
    zip.file('irmaker.json', JSON.stringify(meta));
    var tpl = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
    var nmatch = irNum(ref.replace(/[-_ /]?\s*R(?:ev)?\.?\s*\d{1,2}$/i, ''));
    return { bytes: tpl, report: report, sourceIr: ref || 'the uploaded IR', meta: meta, n: nmatch };
  }
  async function readTemplateMeta(bytes) {
    try { var z = await JSZipRef.loadAsync(bytes), f = z.file('irmaker.json'); return f ? JSON.parse(await f.async('string')) : null; } catch (e) { return null; }
  }
  function setRects(xml, meta, ir) {
    if (!meta.typeRects && !meta.inspRects) return xml;
    var want = {};
    if (meta.typeRects) Object.keys(meta.typeRects).forEach(function (k) { want[meta.typeRects[k]] = (k === ir.insType); });
    if (meta.inspRects) { var pick = ir.attempt >= 2 ? '2nd' : '1st'; Object.keys(meta.inspRects).forEach(function (k) { want[meta.inspRects[k]] = (k === pick); }); }
    var i = -1;
    return xml.replace(/<v:rect\b([^>]*?)(\/?)>/g, function (all, attrs, selfClose) {
      i++; if (!(i in want)) return all;
      attrs = attrs.replace(/\s*fillcolor="[^"]*"/, '').replace(/\s*filled="[^"]*"/, '').replace(/\s*strokecolor="[^"]*"/, '').replace(/\s*strokeweight="[^"]*"/, '');
      return '<v:rect' + attrs + ' fillcolor="' + (want[i] ? 'black' : 'white') + '" filled="t"' + selfClose + '>';
    });
  }
  // drop the last paragraph of the body only if it is empty, so copies don't add a blank page
  function stripTrailingEmptyPara(body) {
    var i = Math.max(body.lastIndexOf('<w:p '), body.lastIndexOf('<w:p>'));
    if (i < 0) return body;
    var lastP = body.slice(i);
    if (!/^<w:p\b[^>]*(\/>|>[\s\S]*<\/w:p>)\s*$/.test(lastP)) return body;
    if (/<w:t[\s>]|<w:drawing|<w:pict|<mc:AlternateContent|<w:br\b|<w:tbl/.test(lastP)) return body;
    return body.slice(0, i);
  }
  async function buildLabelForm(templateBytes, irs, meta) {
    var zip = await JSZipRef.loadAsync(templateBytes); if (zip.file('irmaker.json')) zip.remove('irmaker.json');
    var docPath = 'word/document.xml', xml = await zip.file(docPath).async('string');
    var bStart = xml.indexOf('<w:body>') + 8, sect = xml.lastIndexOf('<w:sectPr'), bodyEnd = xml.lastIndexOf('</w:body>');
    if (sect < bStart) sect = bodyEnd;
    var body = xml.slice(bStart, sect), head = xml.slice(0, bStart), tail = xml.slice(sect);
    var core = stripTrailingEmptyPara(body);
    var trailing = body.slice(core.length) || '<w:p/>';
    var pageBreak = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:br w:type="page"/></w:r></w:p>';
    var copies = irs.map(function (ir) {
      var fd = formDefaults(meta, ir);
      var vals = { IR_No: ir.formIr || refOf(meta, ir.serial || ir.ir, ir.rev), Submitted__Date: dateText(meta, ir.date), Insp_Date: dateText(meta, ir.date),
        Description: ir.subject != null ? ir.subject : fd.subject, Main_Location: ir.formLoc != null ? ir.formLoc : fd.loc, Attachment: ir.attach != null ? ir.attach : fd.attach };
      var c = I.fillFieldsXml(core, vals);
      return setRects(c, meta, { insType: ir.insType || fd.insType, attempt: ir.attempt || 1 });
    });
    zip.file(docPath, head + copies.join(pageBreak) + trailing + tail);
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // ---------- plug into the engine ----------
  E.loadLog = async function (bytes, fileName) {
    var zip = await JSZipRef.loadAsync(bytes);
    if (await isBlockLog(zip)) return loadBlockLog(zip, fileName);
    return base.loadLog(bytes, fileName);
  };
  E.understand = function (log, text, today) { return isBlock(log) ? understandBlock(log, text, today) : base.understand(log, text, today); };
  E.finalize = function (log, drafts) { return isBlock(log) ? finalizeBlock(log, drafts) : base.finalize(log, drafts); };
  E.appendRows = function (log, recs) { return isBlock(log) ? appendBlock(log, recs) : base.appendRows(log, recs); };
  E.findDuplicate = function (log, d) { return isBlock(log) ? dupBlock(log, d) : base.findDuplicate(log, d); };
  E.dupKey = function (desc, log) { return isBlock(log) ? keyOf(desc) : base.dupKey(desc); };
  E.normalizeStations = function (log) { return isBlock(log) ? Promise.resolve(0) : base.normalizeStations(log); };
  E.isUSection = function (log) { return isBlock(log) ? false : base.isUSection(log); };
  E.learnFromFilledIr = function (bytes, log) { return isBlock(log) ? learnLabelForm(bytes, log) : base.learnFromFilledIr(bytes, log); };
  E.buildForm = async function (tpl, irs) {
    var meta = await readTemplateMeta(tpl);
    if (meta && meta.kind === 'label') return buildLabelForm(tpl, irs, meta);
    return base.buildForm(tpl, irs);
  };
  E.recordFromRow = function (log, r, meta) {
    if (!isBlock(log)) return base.recordFromRow(log, r);
    var hit = null; log.tabs.forEach(function (t) { t.recs.forEach(function (x) { if (x.serial === r.ir) hit = { t: t, x: x }; }); });
    return hit ? recordOf(log, hit.t, hit.x, meta, r.rev) : null;
  };
  E.block = { isBlock: isBlock, preview: preview, formDefaults: formDefaults, refOf: refOf, readTemplateMeta: readTemplateMeta,
    resubmit: resubmitBlock, findRecs: findRecs, recordOf: recordOf, unitOf: unitOf, statusName: statusName };
})(typeof window !== 'undefined' ? window : this);
