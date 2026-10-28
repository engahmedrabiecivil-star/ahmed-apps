/* IR Generator engine — reads the IR log (xlsx), understands requests, appends rows, fills the Word form.
   Works in the browser and in Node (for tests). Needs JSZip. */
(function (root) {
  'use strict';
  var JSZipRef = (typeof JSZip !== 'undefined') ? JSZip : (typeof require !== 'undefined' ? require('jszip') : null);

  // ---------- helpers ----------
  function xmlDecode(s) {
    return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-fA-F]+);/g, function (_, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (_, d) { return String.fromCodePoint(parseInt(d, 10)); })
      .replace(/&amp;/g, '&');
  }
  function xmlEsc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function colToIdx(col) { var n = 0; for (var i = 0; i < col.length; i++) n = n * 26 + (col.charCodeAt(i) - 64); return n - 1; }
  function idxToCol(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
  function serialToDate(n) { var ms = Math.round((n - 25569) * 86400000); var d = new Date(ms); return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); }
  function dateToSerial(d) { return Math.round((Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000) + 25569); }
  function fmtDate(d) { return d.getDate() + '/' + (d.getMonth() + 1) + '/' + d.getFullYear(); }
  function toArabicDigitsLatin(s) { return String(s).replace(/[٠-٩]/g, function (c) { return String(c.charCodeAt(0) - 0x660); }).replace(/[۰-۹]/g, function (c) { return String(c.charCodeAt(0) - 0x6F0); }); }

  // Arabic normalisation for matching
  function norm(s) {
    return toArabicDigitsLatin(String(s || ''))
      .replace(/[ً-ْـ]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
      .replace(/[،,]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function stripAl(w) { return w.length > 4 && w.indexOf('ال') === 0 ? w.slice(2) : (w.length > 4 && w.indexOf('لل') === 0 ? w.slice(2) : w); }
  function tokens(s) { return norm(s).replace(/[^؀-ۿa-z0-9 ]/g, ' ').split(' ').filter(Boolean).map(stripAl); }

  // station helpers: "9+140" <-> numeric 9140 ; form style "140+9"
  function parseStation(s) {
    if (s == null) return null;
    var t = toArabicDigitsLatin(String(s)).replace(/\s/g, '');
    var m = t.match(/^(\d)\+(\d{3})$/); if (m) return (+m[1]) * 1000 + (+m[2]);
    m = t.match(/^(\d{3})\+(\d)$/); if (m) return (+m[2]) * 1000 + (+m[1]);
    return null;
  }
  function stationStr(n) { var k = Math.floor(n / 1000), r = n % 1000; return k + '+' + String(r).padStart(3, '0'); }
  function stationFormStr(n) { var k = Math.floor(n / 1000), r = n % 1000; return String(r).padStart(3, '0') + '+' + k; }

  // ---------- XLSX reading ----------
  function sharedStringsFrom(xml) {
    var out = [];
    if (!xml) return out;
    var re = /<si>([\s\S]*?)<\/si>/g, m;
    while ((m = re.exec(xml))) {
      var body = m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
      var t = '', r2 = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t\s*\/>/g, mm;
      while ((mm = r2.exec(body))) t += (mm[1] || '');
      out.push(xmlDecode(t));
    }
    return out;
  }
  function resolvePath(base, target) {
    if (target.charAt(0) === '/') return target.slice(1);
    var parts = base.split('/'); parts.pop();
    target.split('/').forEach(function (p) { if (p === '..') parts.pop(); else if (p !== '.') parts.push(p); });
    return parts.join('/');
  }
  function relsMap(xml, basePath) {
    var map = {}, re = /<Relationship\b([^>]*)\/?>/g, m;
    while ((m = re.exec(xml || ''))) {
      var a = m[1], id = (a.match(/\bId="([^"]+)"/) || [])[1], tg = (a.match(/\bTarget="([^"]+)"/) || [])[1], ty = (a.match(/\bType="([^"]+)"/) || [])[1];
      if (id) map[id] = { target: tg, type: ty, path: tg && !/TargetMode="External"/.test(a) ? resolvePath(basePath, tg) : null };
    }
    return map;
  }

  function parseRows(sheetXml, ss) {
    var rows = [];
    var sd = sheetXml.indexOf('<sheetData'); var se = sheetXml.indexOf('</sheetData>');
    var data = sheetXml.slice(sd, se < 0 ? undefined : se);
    var rre = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g, rm;
    while ((rm = rre.exec(data))) {
      var rnum = +((rm[1].match(/\br="(\d+)"/) || [])[1]);
      var cells = [];
      var cre = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, cm;
      while ((cm = cre.exec(rm[2] || ''))) {
        var attrs = cm[1], inner = cm[2] || '';
        var ref = (attrs.match(/\br="([A-Z]+)\d+"/) || [])[1]; if (!ref) continue;
        var t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        var v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        var val = null;
        if (t === 's') val = v != null ? ss[+v] : null;
        else if (t === 'inlineStr') { var tt = '', r3 = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m3; while ((m3 = r3.exec(inner))) tt += m3[1]; val = xmlDecode(tt); }
        else if (t === 'str' || t === 'e') val = v != null ? xmlDecode(v) : null;
        else if (t === 'b') val = v === '1';
        else val = v != null && v !== '' ? Number(v) : null;
        cells[colToIdx(ref)] = val;
      }
      rows.push({ r: rnum, cells: cells });
    }
    return rows;
  }

  var HEAD_KEYS = {
    ir: ['irno'], rev: ['revno'], sub: ['subrev'], unit: ['unitplantno', 'unit'], block: ['blockno'], loc: ['mainlocation'],
    from: ['fromst'], to: ['tost'], desc: ['description'], item: ['item'], subItem: ['subitem'], date: ['submitteddate'],
    appr: ['approvaldate'], action: ['action'], status: ['status']
  };
  function headKey(s) { return String(s || '').toLowerCase().replace(/[^a-z]/g, ''); }

  async function loadLog(bytes, fileName) {
    var zip = await JSZipRef.loadAsync(bytes);
    var wb = await zip.file('xl/workbook.xml').async('string');
    var wbRels = relsMap(await zip.file('xl/_rels/workbook.xml.rels').async('string'), 'xl/workbook.xml');
    var sheets = [], sre = /<sheet\b([^>]*)\/?>/g, sm;
    while ((sm = sre.exec(wb))) sheets.push({ name: xmlDecode((sm[1].match(/\bname="([^"]*)"/) || [])[1] || ''), rid: (sm[1].match(/\br:id="([^"]+)"/) || [])[1] });
    var sheet = sheets.filter(function (s) { return /mailing/i.test(s.name); })[0] || sheets[0];
    var sheetPath = wbRels[sheet.rid].path;
    var ssPath = null; Object.keys(wbRels).forEach(function (k) { if (/sharedStrings$/.test(wbRels[k].type)) ssPath = wbRels[k].path; });
    var ss = ssPath && zip.file(ssPath) ? sharedStringsFrom(await zip.file(ssPath).async('string')) : [];
    var sheetXml = await zip.file(sheetPath).async('string');
    var raw = parseRows(sheetXml, ss);
    if (!raw.length) throw new Error('The sheet is empty');
    var header = raw[0].cells, col = {};
    header.forEach(function (h, i) {
      var k = headKey(h);
      Object.keys(HEAD_KEYS).forEach(function (key) { if (col[key] == null && HEAD_KEYS[key].indexOf(k) >= 0) col[key] = i; });
    });
    var defaults = { ir: 0, rev: 1, sub: 2, unit: 3, block: 4, loc: 5, from: 6, to: 7, desc: 8, item: 9, subItem: 10, date: 11, appr: 12, action: 13, status: 14 };
    Object.keys(defaults).forEach(function (k) { if (col[k] == null) col[k] = defaults[k]; });
    var rows = [];
    raw.slice(1).forEach(function (r) {
      var c = r.cells; var ir = c[col.ir];
      if (!ir || !/\d/.test(String(ir))) return;
      var dv = c[col.date];
      rows.push({
        r: r.r, ir: String(ir).trim(), rev: c[col.rev] == null ? 0 : c[col.rev], sub: c[col.sub], unit: c[col.unit],
        block: c[col.block], loc: c[col.loc], from: c[col.from], to: c[col.to], desc: c[col.desc] == null ? '' : String(c[col.desc]),
        item: c[col.item], subItem: c[col.subItem], date: typeof dv === 'number' ? serialToDate(dv) : null,
        action: c[col.action], status: c[col.status]
      });
    });
    var log = { ss: ss, zip: zip, sheetPath: sheetPath, sheetName: sheet.name, col: col, rows: rows, fileName: fileName || '', absPath: xmlDecode((wb.match(/absPath url="([^"]*)"/) || [])[1] || '') };
    analyse(log);
    return log;
  }

  // ---------- understanding the log ----------
  function blockNum(s) { var m = String(s || '').match(/(\d+)/); return m ? +m[1] : null; }
  function irNum(s) { var m = String(s || '').match(/(\d+)\s*$/); return m ? +m[1] : null; }

  function isUSection(log) { return /u[\s._-]*section/i.test((log.absPath || '') + ' ' + (log.fileName || '')); }
  function analyse(log) {
    var blocks = {}, maxN = 0, prefix = 'HAC-HYDRO-IR-US-', width = 3, lastIr = null;
    log.rows.forEach(function (r) {
      var n = irNum(r.ir); if (n != null && n >= maxN) { maxN = n; lastIr = r.ir; }
      var b = blockNum(r.block); if (b == null || !/block|فاصل/i.test(String(r.block) + String(r.loc))) return;
      var B = blocks[b] || (blocks[b] = { n: b, labels: {}, locs: [], st: {} });
      B.labels[r.block] = (B.labels[r.block] || 0) + 1;
      if (r.loc) B.locs.push(String(r.loc));
      var a = parseStation(r.from), z = parseStation(r.to);
      if (a != null && z != null && a !== z) { var key = Math.min(a, z) + '-' + Math.max(a, z); B.st[key] = (B.st[key] || 0) + 1; }
    });
    if (isUSection(log)) BLOCK_TABLE.forEach(function (t) {
      var B = blocks[t[0]] || (blocks[t[0]] = { n: t[0], labels: {}, locs: [], st: {} });
      B.fixed = [t[1], t[2]];
      if (!Object.keys(B.labels).length) B.labels['Block no  ' + t[0]] = 1;
    });
    if (lastIr) { var mm = lastIr.match(/^(.*?)(\d+)\s*$/); prefix = mm[1]; width = mm[2].length; }
    Object.keys(blocks).forEach(function (k) {
      var B = blocks[k];
      B.label = Object.keys(B.labels).sort(function (a, b) { return B.labels[b] - B.labels[a]; })[0];
      var best = Object.keys(B.st).sort(function (a, b) { return B.st[b] - B.st[a]; })[0];
      if (B.fixed) { B.from = B.fixed[0]; B.to = B.fixed[1]; delete B.fixed; }
      else if (best) { var p = best.split('-'); B.from = +p[0]; B.to = +p[1]; }
      B.loc = B.from != null ? ('فاصل رقم ' + B.n + ' من محطة\n ' + stationFormStr(B.from) + ' الي ' + stationFormStr(B.to)) : (B.locs.length ? B.locs[B.locs.length - 1] : ('فاصل رقم ' + B.n));
      delete B.labels; delete B.st; delete B.locs;
    });
    log.blocks = blocks; log.lastNum = maxN; log.prefix = prefix; log.width = width;
    // learned usage: latest item/subItem/unit for each normalised description shape
    log.shapes = {};
    log.rows.forEach(function (r, i) {
      var key = shapeKey(r.desc); if (!key) return;
      var S = log.shapes[key] || (log.shapes[key] = { count: 0, last: i, sample: r });
      S.count++; S.last = i; S.sample = r;
    });
  }
  function shapeKey(desc) { return norm(desc).replace(/[\d.]+/g, '#').replace(/[^؀-ۿa-z# ]/g, ' ').replace(/\s+/g, ' ').trim(); }

  function nextIrNumbers(log, count) {
    var out = [];
    for (var i = 1; i <= count; i++) {
      var n = log.lastNum + i;
      out.push({ n: n, log: log.prefix + String(n).padStart(log.width, '0') });
    }
    return out;
  }
  function formIrNo(log, n, rev) { return log.prefix + String(n).padStart(4, '0') + '-' + String(rev || 0).padStart(2, '0'); }
  function formLocation(B) {
    if (B && B.from != null) return 'الفاصل رقم ' + B.n + ' من محطة ' + stationFormStr(B.from) + ' الي ' + stationFormStr(B.to);
    return B ? String(B.loc).replace(/\s+/g, ' ').trim() : '';
  }
  // Blocks & stations from the approved block schedule (St 8+500 → 9+500)
  var BLOCK_TABLE = [[1,8500,8540],[2,8540,8580],[3,8580,8620],[4,8620,8660],[5,8660,8700],[6,8700,8740],[7,8740,8780],[8,8780,8820],[9,8820,8860],[10,8860,8900],
    [11,8900,8940],[12,8940,8980],[13,8980,9020],[14,9020,9060],[15,9060,9100],[16,9100,9140],[17,9140,9180],[18,9180,9220],[19,9220,9260],[20,9260,9300],
    [21,9300,9330],[22,9330,9360],[23,9360,9390],[24,9390,9420],[25,9420,9460],[26,9460,9500]];
  function blockForStation(log, st) {
    var hit = null; Object.keys(log.blocks).forEach(function (k) { var B = log.blocks[k]; if (B.from != null && st >= B.from && st < B.to) hit = B; });
    if (!hit) Object.keys(log.blocks).forEach(function (k) { var B = log.blocks[k]; if (B.to === st) hit = B; });
    return hit;
  }

  // ---------- understanding a request ----------
  var ORD = [
    { k: ['اولي', 'اول', '1', 'الاولي', 'الاول', 'first', '1st'], f: 'الاولى', fx: 'اولى' },
    { k: ['ثانيه', 'تانيه', 'ثاني', 'تاني', '2', 'second', '2nd'], f: 'الثانية', fx: 'ثانية' },
    { k: ['ثالثه', 'تالته', 'ثالث', 'تالت', '3', 'third', '3rd'], f: 'الثالثة', fx: 'ثالثة' },
    { k: ['رابعه', 'رابع', '4', 'fourth', '4th'], f: 'الرابعة', fx: 'رابعة' },
    { k: ['خامسه', 'خامس', '5', 'fifth', '5th'], f: 'الخامسة', fx: 'خامسة' },
    { k: ['سادسه', 'سادس', '6', 'sixth', '6th'], f: 'السادسة', fx: 'سادسة' }
  ];
  var _nc = {};
  function has(t, words) { for (var i = 0; i < words.length; i++) { var w = _nc[words[i]] || (_nc[words[i]] = norm(words[i])); if (t.indexOf(w) >= 0) return true; } return false; }

  function parseRequest(log, text) {
    var raw = toArabicDigitsLatin(text || '');
    var t = ' ' + norm(raw) + ' ';
    var ctx = { text: raw, t: t, blocks: [], sides: [], layers: [], ops: {}, level: null, piles: [], count: null, warnings: [] };

    // piles first (so their numbers are not mistaken for blocks)
    var pre = /\bp\s*-?\s*(\d{1,4})/gi, pm; var tNoP = t;
    while ((pm = pre.exec(t))) { ctx.piles.push('P' + pm[1]); }
    tNoP = t.replace(/\bp\s*-?\s*\d{1,4}/gi, ' ');

    // stations
    var stations = [], sre = /(\d)\s*\+\s*(\d{3})|(\d{3})\s*\+\s*(\d)/g, sm2;
    while ((sm2 = sre.exec(tNoP))) stations.push(sm2[1] ? (+sm2[1]) * 1000 + (+sm2[2]) : (+sm2[4]) * 1000 + (+sm2[3]));
    var tNoSt = tNoP.replace(/(\d)\s*\+\s*(\d{3})|(\d{3})\s*\+\s*(\d)/g, ' ');

    // level (منسوب)
    var lm = tNoSt.match(/(?:منسوب|level|lvl|el\.?)\s*(-?\s*\d+(?:\.\d+)?\s*-?)/) || tNoSt.match(/(-?\d+\.\d+-?)/);
    if (lm) {
      var lv = lm[1].replace(/\s/g, ''); var neg = /-/.test(lv); var num = lv.replace(/-/g, '');
      ctx.level = { num: num, neg: neg };
    }
    var tNoLv = lm ? tNoSt.replace(lm[0], ' ') : tNoSt;

    // count (عدد N)
    var cm = (tNoLv.match(/(?:عدد|count|no\.? of)\s*(\d+)/) || tNoLv.match(/(\d+)\s*wells?/)); if (cm) ctx.count = +cm[1];

    // blocks: "فاصل 5" / "فواصل 5 و 9 و 11" / "ف5" / "block 5"
    var bre = /(?:فواصل|فاصل|الفاصل|لفاصل|بلوك|blocks|block|blk|\bف)\s*(?:رقم|no\.?|#)?\s*(\d{1,2}(?:\s*(?:و|,|-|،|&|and)\s*\d{1,2})*)/g, bm;
    while ((bm = bre.exec(tNoLv))) bm[1].split(/[^\d]+/).filter(Boolean).forEach(function (x) { if (ctx.blocks.indexOf(+x) < 0) ctx.blocks.push(+x); });
    stations.forEach(function (st) { var B = blockForStation(log, st); if (B && ctx.blocks.indexOf(B.n) < 0) ctx.blocks.push(B.n); });
    if (!ctx.blocks.length) {
      var lone = tNoLv.replace(/عدد\s*\d+/, ' ').match(/(?:^|\s)(\d{1,2})(?=\s|$)/);
      if (lone && log.blocks[+lone[1]] && !/طبق/.test(t)) ctx.blocks.push(+lone[1]);
    }

    // sides / layers / positions
    if (has(t, ['بحري', 'بحرى', 'شمال', 'north', 'sea side'])) ctx.sides.push('البحرى');
    if (has(t, ['قبلي', 'قبلى', 'جنوب', 'south'])) ctx.sides.push('القبلى');
    if (has(t, ['سفلي', 'سفليه', 'تحتانيه', 'bottom', 'lower'])) ctx.layers.push('السفلية');
    if (has(t, ['علوي', 'علويه', 'فوقانيه', 'top', 'upper'])) ctx.layers.push('العلوية');
    ctx.pos = has(t, ['اسفل', 'تحت العزل', 'تحت', 'below', 'under']) ? 'اسفل' : (has(t, ['اعلي', 'فوق', 'above', 'over']) ? 'اعلى' : null);

    // operations
    var o = ctx.ops;
    o.rebar = has(t, ['حداده', 'حديد', 'تسليح', 'rebar', 'reinforcement', 'steel', 'رقه', 'mesh']);
    o.form = has(t, ['نجاره', 'شده', 'شدات', 'formwork', 'shuttering', 'form ']);
    o.pour = /(^|\s|ل|و|ب)صب(\s|$)/.test(t) || has(t, ['اذن صب', 'ازن صب', 'pour', 'casting', 'concreting']);
    o.inspect = has(t, ['معاينه', 'استلام', 'فحص', 'inspection', 'inspect']);
    o.survey = has(t, ['احداثيات', 'مساحه', 'survey', 'coordinates', 'مناسيب', 'levels']);
    o.plt = has(t, ['plt', 'تحميل', 'لوحي', 'plate load']);
    o.operate = has(t, ['تشغيل', 'operation', 'operating']);
    o.drill = has(t, ['حفر ابار', 'حفر الابار', 'drilling']);
    return ctx;
  }

  function lvl(ctx, style) { // style 'trail' => 3.607-  ; 'lead' => -2.47
    if (!ctx.level) return null;
    if (!ctx.level.neg) return ctx.level.num;
    return style === 'lead' ? '-' + ctx.level.num : ctx.level.num + '-';
  }
  function ordFor(ctx) {
    var out = [], t = ctx.t;
    ORD.forEach(function (O) {
      var hit = O.k.some(function (k) { return /^\d$/.test(k) ? new RegExp('(طبقه|layer|ط)\\s*(رقم\\s*)?' + k + '(\\s|$)').test(t) : t.indexOf(' ' + k + ' ') >= 0 || t.indexOf(' ال' + k + ' ') >= 0; });
      if (hit) out.push(O);
    });
    return out;
  }

  // Element rules. Each returns a list of {desc,item,subItem,unit}
  var RULES = [
    { id: 'wall', test: function (t) { return has(t, ['حائط', 'حوائط', 'حيطه', 'حيطان', 'جدار', 'wall']); },
      build: function (c) {
        var sides = c.sides.length ? c.sides : ['البحرى', 'القبلى'], out = [], o = c.ops, any = o.rebar || o.form || o.pour;
        if (!c.sides.length) c.warnings.push('Wall side not given (north/south), so both were added');
        sides.forEach(function (s) {
          if (o.rebar || !any) out.push({ desc: 'فحص واستلام حدادة الحائط ' + s + ' لفاصل ' + c.b, item: 'حدادة الحوائط', subItem: 'فحص واستلام' });
          if (o.form) out.push({ desc: 'فحص واستلام نجارة الحائط ' + s + ' لفاصل ' + c.b + (c.level ? '\nعلى منسوب  ' + lvl(c, 'trail') : ''), item: 'حدادة الحوائط', subItem: 'فحص واستلام' });
          if (o.pour) out.push({ desc: 'اذن صب الحائط ' + s + ' لفاصل ' + c.b + ' ', item: 'الحوائط', subItem: 'ازن صب' });
        });
        return out;
      } },
    { id: 'haunch', test: function (t) { return has(t, ['هونش', 'haunch']); },
      build: function (c) {
        var out = [];
        if (!c.ops.pour || c.ops.inspect || c.ops.form) out.push({ desc: 'فحص واستلام الهونش  على منسوب ' + (lvl(c, 'lead') || '…'), item: 'الهونش', subItem: 'فحص واستلام' });
        if (c.ops.pour) out.push({ desc: 'اذن صب خرسانة الهونش', item: 'الهونش', subItem: 'ازن صب' });
        if (!c.level && out.some(function (x) { return /منسوب/.test(x.desc); })) c.warnings.push('Add the haunch level, e.g. level -2.47');
        return out;
      } },
    { id: 'tendons', test: function (t) { return has(t, ['اوتار', 'وتر ', 'الوتر', 'tendon', 'waterstop', 'water stop']); },
      build: function (c) { return [{ desc: 'استلام معاينة الاوتار فاصل ' + c.b, item: 'الاوتار', subItem: 'معاينة' }]; } },
    { id: 'piles', test: function (t) { return has(t, ['خوازيق', 'خازوق', 'cmc', 'pile']); },
      build: function (c) {
        var list = c.piles, k = list.length || c.count || 0, l = list.length ? list.join('-') + '-' : '…';
        if (!list.length) c.warnings.push('Add the pile numbers, e.g. P24 P25 P26');
        var out = [];
        if (c.ops.survey) out.push({ desc: 'تسليم احداثيات عدد ' + k + ' خازوق CMC ارقام ( ' + l + ' )', item: 'خوازيق', subItem: 'خوازيق', unit: 'Survey' });
        if (!c.ops.survey || /مدني|civil/.test(c.t)) out.push({ desc: 'طلب فحص واستلام اعمال مدنية عدد ' + k + ' خازوق CMC ارقام ( ' + l + ' )', item: 'خوازيق', subItem: 'خوازيق', unit: 'Civil' });
        return out;
      } },
    { id: 'gfrp', test: function (t) { return has(t, ['gfrp', 'جي اف']); },
      build: function (c) {
        var o = c.ops, any = o.rebar || o.form || o.pour, out = [];
        if (o.rebar || !any) out.push({ desc: 'تسليم حدادة  GFRP  بسمك 60سم', item: 'لبشه عاديه', subItem: 'حدادة' });
        if (o.form || !any) out.push({ desc: 'تسليم نجارة  GFRP بسمك 60سم', item: 'لبشه عاديه', subItem: 'نجاره' });
        if (o.pour || !any) out.push({ desc: 'إذن صب الخرسانة العاديةGFRP بسمك 60 سم', item: 'لبشه عاديه', subItem: 'ازن صب' });
        return out;
      } },
    { id: 'insulation', test: function (t) { return has(t, ['عزل', 'جيوتكستيل', 'جيوتكستايل', 'pvc', 'geotext', 'insulation', 'waterproof']) && !has(t, ['نضافه', 'عاديه', 'فرشه', 'blinding', 'lean']); },
      build: function (c) {
        var t = c.t, g = has(t, ['جيوتكستيل', 'جيوتكستايل', 'geotext']), p = /pvc/.test(t), first = has(t, ['اولي', 'اول', 'تحت']), second = has(t, ['ثانيه', 'تانيه', 'اعلي', 'فوق']);
        var out = [], all = !g && !p;
        if (all || (g && (first || !second))) out.push({ desc: 'فرد الجيوتكستيل للطبقة الأولى تحت الـ PVC', item: 'عزل تحت اللبشة', subItem: 'فرد' });
        if (all || p) out.push({ desc: 'فرد طبقة  PVC  واختبارها', item: 'عزل تحت اللبشة', subItem: 'فرد' });
        if (all || (g && second)) out.push({ desc: 'فرد الجيوتكستيل للطبقة الثانية أعلى الـ PVC', item: 'عزل تحت اللبشة', subItem: 'فرد' });
        return out;
      } },
    { id: 'blinding', test: function (t) { return has(t, ['لبشه عاديه', 'لبشه العاديه', 'نضافه', 'فرشه', 'عاديه', 'blinding', 'lean concrete', 'plain concrete']) ; },
      build: function (c) {
        var pos = c.pos || 'اسفل', o = c.ops, any = o.form || o.pour, out = [];
        if (!c.pos) c.warnings.push('Blinding assumed below the insulation. Change it if it is above');
        if (o.form || !any) out.push({ desc: 'فحص واستلام  حدود ومناسيب نجارة وصب اللبشة العادية علي منسوب ' + (lvl(c, 'trail') || '…') + '  (فرشة النضافة ' + pos + ' العزل) بسمك 10 سم', item: 'لبشه عاديه', subItem: 'نجاره' });
        if (o.pour) out.push({ desc: 'إذن صب الخرسانة العادية حمايه ' + pos + ' العزل بسمك 10سم', item: 'لبشه عاديه', subItem: 'ازن صب' });
        if (has(c.t, ['سطح'])) out.push({ desc: 'تسليم معاينة سطح الخرسانة بعد الصب وقبل اعمال العزل', item: 'لبشه عاديه', subItem: 'معاينة' });
        return out;
      } },
    { id: 'raft', test: function (t) { return has(t, ['لبشه', 'رقه', 'raft', 'slab']); },
      build: function (c) {
        var o = c.ops, any = o.rebar || o.form || o.pour, out = [];
        if (o.rebar || !any) {
          var layers = c.layers.length ? c.layers : ['السفلية', 'العلوية'];
          if (!c.layers.length && o.rebar) c.warnings.push('Mesh not given (bottom/top), so both were added');
          layers.forEach(function (L) { out.push({ desc: 'فحص واستلام حدادة الرقة ' + L + ' للحديد فاصل ' + c.b, item: 'فحص الرقة للبشة المسلحة', subItem: 'حديد' }); });
        }
        if (o.form) out.push({ desc: 'فحص واستلام نجارة اللبشة المسلحة  فاصل ' + c.b, item: 'فحص النجارة للبشة المسلحة', subItem: 'نجارة' });
        if (o.pour) out.push({ desc: 'اذن صب اللبشة المسلحة  فاصل  ' + c.b + ' ', item: 'لبشة مسلحة', subItem: 'ازن صب' });
        return out;
      } },
    { id: 'replacement', test: function (t) { return has(t, ['احلال', 'طبقه', 'replacement', 'layer']); },
      build: function (c) {
        var ords = ordFor(c), out = [];
        if (!ords.length) { c.warnings.push('Add the replacement layer number, e.g. layer 3'); ords = [ORD[0]]; }
        var L = lvl(c, 'trail') || '…';
        ords.forEach(function (O) {
          if (c.ops.plt) out.push({ desc: 'تسليم طلب اعتماد نتائج واختبار تجربةالتحميل اللوحى( PLT) للطبقه ' + O.f.replace(/^ال/, '') + ' من الاحلال وطبقة ' + O.fx + '  احلال السن بعرض 30.20 علي منسوب ' + L, item: 'إحلال', subItem: 'طبقة ' + O.fx + ' PLT' });
          else out.push({ desc: 'تسليم  حدود ومناسيب واحداثيات الطبقة ' + O.f + ' احلال السن  علي منسوب ' + L, item: 'إحلال', subItem: 'طبقة ' + O.fx });
        });
        return out;
      } },
    { id: 'excavation', test: function (t) { return has(t, ['قاع', 'excavation', 'formation']); },
      build: function (c) {
        var out = [];
        if (c.ops.survey || !c.ops.inspect) out.push({ desc: 'تسليم  مناسيب واحداثيات وعرض  قاع حفر', item: 'قاع حفر', subItem: 'عمق' });
        if (c.ops.inspect || has(c.t, ['معاينه'])) out.push({ desc: 'تسليم معاينة قاع الحفر', item: 'قاع حفر', subItem: 'معاينة' });
        return out;
      } },
    { id: 'wells', test: function (t) { return has(t, ['ابار', 'بير', 'بئر', 'well', 'dewatering']); },
      build: function (c) {
        var B = c.B, k = c.count || '…', st = B && B.from != null ? ' من محطة ' + stationFormStr(B.from) + ' الي ' + stationFormStr(B.to) : '', out = [];
        if (!c.count) c.warnings.push('Add the number of wells, e.g. 6 wells');
        if (!c.ops.operate || c.ops.drill) out.push({ desc: 'تسليم حفر ابار عدد ' + k + ' لفاصل رقم ' + c.b + st, item: 'آبار', subItem: 'عمق' });
        if (c.ops.operate) out.push({ desc: 'محضر تشغيل ابار عدد ' + k + ' لفاصل رقم ' + c.b + st, item: 'آبار', subItem: 'تشغيل' });
        return out;
      } }
  ];

  // learned fallback: closest historical description shape
  function learnedMatches(log, text, limit) {
    var qt = tokens(text).filter(function (w) { return !/^\d+$/.test(w) && ['فاصل', 'لفاصل', 'رقم', 'عايز', 'اعمل', 'محتاج', 'في', 'من', 'الي', 'علي', 'عند', 'ل'].indexOf(w) < 0; });
    if (!qt.length) return [];
    var scored = Object.keys(log.shapes).map(function (k) {
      var S = log.shapes[k], st = tokens(S.sample.desc), hit = 0;
      qt.forEach(function (w) { if (st.some(function (x) { return x === w || (w.length > 3 && (x.indexOf(w) === 0 || w.indexOf(x) === 0) && Math.min(x.length, w.length) > 3); })) hit++; });
      var score = hit / qt.length + 0.15 * (hit / Math.max(st.length, 1)) + 0.05 * (S.last / log.rows.length);
      return { S: S, score: score, hit: hit };
    }).filter(function (x) { return x.hit > 0; }).sort(function (a, b) { return b.score - a.score; });
    return scored.slice(0, limit || 3).map(function (x) { return x.S.sample; });
  }
  function adaptSampleToBlock(desc, fromB, toB) {
    if (!fromB || fromB === toB) return desc;
    return desc.replace(new RegExp('((?:لفاصل|فاصل|الفاصل)\\s*(?:رقم)?\\s*)' + fromB + '(?!\\d)', 'g'), '$1' + toB);
  }

  // apply learned item/sub/unit from the most recent identical description shape in the log
  function learnMeta(log, d) {
    var S = log.shapes[shapeKey(d.desc)];
    if (S && S.sample) {
      d.item = S.sample.item || d.item; d.subItem = S.sample.subItem || d.subItem;
      if (!d.unit && S.sample.unit) d.unit = S.sample.unit;
      d.learned = true;
    }
    return d;
  }

  function understand(log, text, today) {
    var ctx = parseRequest(log, text);
    var rule = null; for (var i = 0; i < RULES.length; i++) if (RULES[i].test(ctx.t)) { rule = RULES[i]; break; }
    var blocks = ctx.blocks.length ? ctx.blocks : [null];
    if (!ctx.blocks.length) ctx.warnings.push('No block number found. Write it like "block 20"');
    var drafts = [];
    blocks.forEach(function (b) {
      var B = b != null ? log.blocks[b] : null;
      if (b != null && !B) ctx.warnings.push('Block ' + b + ' is not in the log');
      var c = Object.assign({}, ctx, { b: b == null ? '…' : b, B: B });
      var list = [];
      if (rule) list = rule.build(c);
      else {
        var m = learnedMatches(log, text, 1)[0];
        if (m) { list = [{ desc: adaptSampleToBlock(m.desc, blockNum(m.block), b), item: m.item, subItem: m.subItem, unit: m.unit, fromLog: true }]; }
      }
      list.forEach(function (d) {
        learnMeta(log, d);
        drafts.push({
          desc: d.desc, item: d.item || '', subItem: d.subItem || '', unit: d.unit || 'Civil', block: b, rev: 0,
          formItem: d.item || '', date: today || new Date(), fromLog: !!d.fromLog
        });
      });
    });
    var uniqW = ctx.warnings.filter(function (w, i, a) { return a.indexOf(w) === i; });
    return { drafts: drafts, warnings: uniqW, rule: rule ? rule.id : null, alternatives: learnedMatches(log, text, 4) };
  }

  // ---------- writing the log ----------
  async function appendRows(log, entries) {
    var zip = log.zip, path = log.sheetPath, xml = await zip.file(path).async('string');
    var sdEnd = xml.indexOf('</sheetData>');
    var rowRe = /<row\b[^>]*\br="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g, m, last = null;
    while ((m = rowRe.exec(xml))) { if (m.index > sdEnd) break; if (!last || +m[1] > +last[1]) last = m; }
    var lastNum = +last[1], tmpl = last[0];
    var openTag = tmpl.match(/^<row\b[^>]*?>/)[0].replace(/\/>$/, '>');
    var styles = {}; var cre = /<c\b[^>]*\br="([A-Z]+)\d+"[^>]*?\bs="(\d+)"/g, cm;
    while ((cm = cre.exec(tmpl))) styles[cm[1]] = cm[2];
    var col = log.col, maxCol = 14; Object.keys(col).forEach(function (k) { if (col[k] > maxCol) maxCol = col[k]; });
    var added = '', n = lastNum;
    entries.forEach(function (e) {
      n++;
      var vals = [];
      vals[col.ir] = { s: e.ir }; vals[col.rev] = { n: e.rev || 0 }; vals[col.sub] = { s: e.sub || 'L' }; vals[col.unit] = { s: e.unit };
      vals[col.block] = { s: e.blockLabel }; vals[col.loc] = { s: e.loc }; vals[col.from] = { s: e.from }; vals[col.to] = { s: e.to };
      vals[col.desc] = { s: e.desc }; vals[col.item] = { s: e.item }; vals[col.subItem] = { s: e.subItem };
      vals[col.date] = { n: dateToSerial(e.date) }; vals[col.appr] = null; vals[col.action] = { s: e.action || 'W' }; vals[col.status] = { s: e.status || 'WAITING' };
      var cells = '';
      for (var i = 0; i <= maxCol; i++) {
        var L = idxToCol(i), ref = L + n, st = styles[L] ? ' s="' + styles[L] + '"' : '', v = vals[i];
        if (!v || v.s === '' || v.s == null && v.n == null) { if (st) cells += '<c r="' + ref + '"' + st + ' />'; continue; }
        if (v.n != null) cells += '<c r="' + ref + '"' + st + '><v>' + v.n + '</v></c>';
        else cells += '<c r="' + ref + '"' + st + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(v.s) + '</t></is></c>';
      }
      added += openTag.replace(/\br="\d+"/, 'r="' + n + '"') + cells + '</row>';
    });
    xml = xml.slice(0, sdEnd) + added + xml.slice(sdEnd);
    xml = xml.replace(/(<dimension ref="[A-Z]+\d+:[A-Z]+)(\d+)("\s*\/>)/, function (a, p, num, s) { return p + Math.max(+num, n) + s; });
    zip.file(path, xml);
    // grow the Excel table that covers the log
    var rels = zip.file(path.replace(/([^/]+)$/, '_rels/$1.rels'));
    if (rels) {
      var map = relsMap(await rels.async('string'), path);
      for (var k in map) {
        if (!/\/table$/.test(map[k].type) || !map[k].path || !zip.file(map[k].path)) continue;
        var tx = await zip.file(map[k].path).async('string');
        tx = tx.replace(/ref="([A-Z]+\d+):([A-Z]+)(\d+)"/g, function (a, s, c2, r2) { return +r2 === lastNum ? 'ref="' + s + ':' + c2 + n + '"' : a; });
        zip.file(map[k].path, tx);
      }
    }
    return { firstRow: lastNum + 1, lastRow: n };
  }

  // rewrite every station in the log (location, from/to, description) as on the IR form: 9+140 -> 140+9
  function toFormStations(text) {
    return String(text).replace(/(^|[^\d+])(\d)\s*\+\s*(\d{3})(?![\d+])/g, function (m, pre, k, r) { return pre + r + '+' + k; });
  }
  async function normalizeStations(log) {
    var col = log.col, cols = [col.loc, col.from, col.to, col.desc].map(idxToCol);
    var xml = await log.zip.file(log.sheetPath).async('string'), changed = 0;
    var sdS = xml.indexOf('<sheetData'), sdE = xml.indexOf('</sheetData>');
    var data = xml.slice(sdS, sdE).replace(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g, function (cell, attrs, inner) {
      var ref = (attrs.match(/\br="([A-Z]+)(\d+)"/) || []);
      if (!ref[1] || cols.indexOf(ref[1]) < 0 || +ref[2] < 2 || !inner) return cell;
      var t = (attrs.match(/\bt="([^"]+)"/) || [])[1], v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1], val = null;
      if (t === 's' && v != null) val = log.ss[+v];
      else if (t === 'inlineStr') { var tt = '', r3 = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g, m3; while ((m3 = r3.exec(inner))) tt += m3[1]; val = xmlDecode(tt); }
      else if (t === 'str' && v != null) val = xmlDecode(v);
      if (val == null) return cell;
      var nv = toFormStations(val);
      if (nv === val) return cell;
      changed++;
      var keep = attrs.replace(/\s*\bt="[^"]*"/, '');
      return '<c' + keep + ' t="inlineStr"><is><t xml:space="preserve">' + xmlEsc(nv) + '</t></is></c>';
    });
    if (changed) log.zip.file(log.sheetPath, xml.slice(0, sdS) + data + xml.slice(sdE));
    return changed;
  }

  // ---------- filling the Word form ----------
  function fillFieldsXml(xml, values) {
    Object.keys(values).forEach(function (name) {
      var re = new RegExp('<w:r\\b[^>]*>(?:(?!<\\/w:r>)[\\s\\S])*?<w:fldChar w:fldCharType="begin"\\s*\\/><\\/w:r>(?:(?!fldCharType="end")[\\s\\S])*?MERGEFIELD\\s+' + name + '\\b(?:(?!fldCharType="end")[\\s\\S])*?<w:fldChar w:fldCharType="end"\\s*\\/><\\/w:r>', 'g');
      xml = xml.replace(re, function (block) {
        var tm = block.match(/<w:r\b[^>]*>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t[^>]*>«[^<]*»<\/w:t><\/w:r>/);
        var rPr = tm && tm[1] ? tm[1].replace(/<w:noProof\s*\/>/, '') : '';
        var ltrPr = rPr ? rPr.replace(/<w:rtl\s*\/>|<w:rtl\s+w:val="[^"]*"\s*\/>/g, '').replace('</w:rPr>', '<w:rtl w:val="0"/></w:rPr>') : '<w:rPr><w:rtl w:val="0"/></w:rPr>';
        var out = '';
        String(values[name] == null ? '' : values[name]).split(/\r?\n/).forEach(function (line, li) {
          if (li) out += '<w:r>' + rPr + '<w:br/></w:r>';
          // stations go in their own left-to-right run so Word shows them exactly as written (140+9)
          line.split(/(\d\+\d{3}|\d{3}\+\d)/).forEach(function (seg, si) {
            if (!seg) return;
            out += '<w:r>' + (si % 2 ? ltrPr : rPr) + '<w:t xml:space="preserve">' + xmlEsc(seg) + '</w:t></w:r>';
          });
        });
        return out || '<w:r>' + rPr + '<w:t></w:t></w:r>';
      });
    });
    // also handle simple fields if any
    xml = xml.replace(/<w:fldSimple\b[^>]*w:instr="\s*MERGEFIELD\s+(\w+)[^"]*"[^>]*>([\s\S]*?)<\/w:fldSimple>/g, function (a, name, inner) {
      if (!(name in values)) return a;
      var rPr = (inner.match(/<w:rPr>[\s\S]*?<\/w:rPr>/) || [''])[0];
      return '<w:r>' + rPr + '<w:t xml:space="preserve">' + xmlEsc(values[name]) + '</w:t></w:r>';
    });
    return xml;
  }
  function markAttempt(xml, attempt) { // attempt 1..3 → fill the matching circle after اول/ثاني/ثالث مرة
    if (!attempt) return xml;
    return xml.replace(/<w:t([^>]*)>([^<]*اول مرة[^<]*)<\/w:t>/, function (a, at, txt) {
      var i = 0; return '<w:t' + at + '>' + txt.replace(/◯/g, function (c) { i++; return i === attempt ? '●' : c; }) + '</w:t>';
    });
  }

  async function buildForm(templateBytes, irs) {
    var zip = await JSZipRef.loadAsync(templateBytes);
    var docPath = 'word/document.xml', xml = await zip.file(docPath).async('string');
    var bStart = xml.indexOf('<w:body>') + 8, sect = xml.lastIndexOf('<w:sectPr'), bodyEnd = xml.lastIndexOf('</w:body>');
    if (sect < bStart) sect = bodyEnd;
    var body = xml.slice(bStart, sect), head = xml.slice(0, bStart), tail = xml.slice(sect);
    // strip trailing empty paragraph(s) so copies don't add blank pages
    var core = body.replace(/(<w:p\b[^>]*\/>|<w:p\b[^>]*>(?:<w:pPr>[\s\S]*?<\/w:pPr>)?<\/w:p>)\s*$/, '');
    var trailing = body.slice(core.length) || '<w:p/>';
    var pageBreak = '<w:p><w:pPr><w:spacing w:before="0" w:after="0" w:line="20" w:lineRule="exact"/><w:rPr><w:sz w:val="2"/></w:rPr></w:pPr><w:r><w:rPr><w:sz w:val="2"/></w:rPr><w:br w:type="page"/></w:r></w:p>';
    var names = templateFieldNames(core);
    var copies = irs.map(function (ir) {
      var vals = {}; names.forEach(function (n) { vals[n] = fieldValue(ir, n); });
      var c = fillFieldsXml(core, vals);
      return markAttempt(c, ir.attempt);
    });
    zip.file(docPath, head + copies.join(pageBreak) + trailing + tail);
    // detach the old mail-merge data source so Word opens it without asking for the Excel file
    var sp = 'word/settings.xml';
    if (zip.file(sp)) {
      var s = await zip.file(sp).async('string');
      zip.file(sp, s.replace(/<w:mailMerge>[\s\S]*?<\/w:mailMerge>/, ''));
      var sr = 'word/_rels/settings.xml.rels';
      if (zip.file(sr)) { var r = await zip.file(sr).async('string'); zip.file(sr, r.replace(/<Relationship\b[^>]*mailMergeSource[^>]*\/>/g, '')); }
    }
    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  }

  // build full IR records from drafts (assigns serials)
  function finalize(log, drafts) {
    var nums = nextIrNumbers(log, drafts.length);
    return drafts.map(function (d, i) {
      var B = log.blocks[d.block] || null;
      return {
        n: nums[i].n, ir: nums[i].log, formIr: formIrNo(log, nums[i].n, d.rev), rev: d.rev || 0, sub: 'L', unit: d.unit || 'Civil',
        blockLabel: B ? B.label : (d.block != null ? 'Block no  ' + d.block : ''), loc: B ? B.loc : '',
        from: B && B.from != null ? stationFormStr(B.from) : '', to: B && B.to != null ? stationFormStr(B.to) : '',
        desc: d.desc, item: d.item, subItem: d.subItem, date: d.date, formItem: d.formItem || d.item,
        formLoc: d.formLoc || formLocation(B), attempt: (d.rev || 0) + 1, action: 'W', status: 'WAITING'
      };
    });
  }
  // which mail-merge fields a Word form uses
  function templateFieldNames(xml) {
    var out = [], re = /MERGEFIELD\s+"?([^\s"\\]+)/g, m;
    while ((m = re.exec(xml))) if (out.indexOf(m[1]) < 0) out.push(m[1]);
    return out;
  }
  async function inspectTemplate(bytes) {
    var zip = await JSZipRef.loadAsync(bytes);
    var f = zip.file('word/document.xml'); if (!f) throw new Error('not a Word .docx file');
    return templateFieldNames(await f.async('string'));
  }
  // map a form field name (as Word mail merge names log columns) to the IR value
  function fieldValue(ir, name) {
    var k = String(name).toLowerCase().replace(/[^a-z0-9\u0600-\u06ff]/g, '');
    var map = [
      [/^(irno|irnumber|ir|irnum|requestno)$/, ir.formIr],
      [/^(item|element|elementtype)$/, ir.formItem],
      [/^(submitteddate|date|submissiondate|irdate)$/, ir.date ? fmtDate(ir.date) : ''],
      [/^(description|desc|works|workdescription)$/, ir.desc],
      [/^(mainlocation|location|loc)$/, ir.formLoc],
      [/^(blockno|block)$/, ir.blockLabel],
      [/^(fromst|from|fromstation)$/, ir.from],
      [/^(tost|to|tostation)$/, ir.to],
      [/^(subitem)$/, ir.subItem],
      [/^(unitplantno|unit|discipline)$/, ir.unit],
      [/^(revno|rev|revision)$/, ir.rev == null ? '' : String(ir.rev)]
    ];
    for (var i = 0; i < map.length; i++) if (map[i][0].test(k)) return map[i][1] == null ? '' : map[i][1];
    return '';
  }
  function recordFromRow(log, r) {
    var n = irNum(r.ir), B = log.blocks[blockNum(r.block)];
    return { n: n, ir: r.ir, rev: r.rev, formIr: formIrNo(log, n, r.rev), desc: r.desc, formItem: r.item, item: r.item, subItem: r.subItem, unit: r.unit, blockLabel: r.block, from: r.from, to: r.to, date: r.date || new Date(), formLoc: B ? formLocation(B) : String(r.loc || '').replace(/\s+/g, ' '), attempt: (+r.rev || 0) + 1 };
  }

  var api = {
    loadLog: loadLog, normalizeStations: normalizeStations, toFormStations: toFormStations, inspectTemplate: inspectTemplate, isUSection: isUSection, understand: understand, finalize: finalize, appendRows: appendRows, buildForm: buildForm,
    recordFromRow: recordFromRow, formLocation: formLocation, norm: norm, fmtDate: fmtDate, stationStr: stationStr,
    nextIrNumbers: nextIrNumbers, formIrNo: formIrNo, irNum: irNum, blockNum: blockNum,
    saveLog: function (log) { return log.zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }); }
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.IREngine = api;
})(typeof window !== 'undefined' ? window : this);
