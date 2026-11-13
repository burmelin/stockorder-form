/* Clock in / out: reads the Timecards report exported from Loyverse Back Office
   (Employees → Timecards → Export) and turns the saved timecards into a report per day.
   Loyverse's API has no timecards, so the owner uploads the export (weekly is enough).
   Pure functions (no page access): the same code runs in the browser and in node tests.

   The reader doesn't rely on exact column names: it finds the header row and picks the
   employee, store, clock-in and clock-out columns by what they're called. Dates can be
   2026-11-12, 12/11/2026, 11/12/2026, 12.11.2026, "Nov 12, 2026" or "12 Nov 2026", with a
   Buddhist year (2569) too; times 24-hour or AM/PM. Day/month order is worked out from the
   whole file (a 13 or more in either place settles it); if nothing settles it, day first,
   as in Thailand.

   A "day" runs 05:00 to 05:00, so a Nana clock-out after midnight belongs to the evening. */
(function (root) {
  const SHOP_HOURS = { 'Bicasso 1': ['10:00', '21:30'], 'Bicasso 2': ['10:00', '21:30'], Nana: ['13:00', '24:00'] };
  const DAY_START_HOUR = 5;
  const GRACE_MIN = 10;   // up to 10 minutes after opening / before closing counts as on time
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = (n) => String(n).padStart(2, '0');

  // ---- CSV ----
  function parseCsv(text) {
    text = String(text || '').replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0] || '';
    const counts = [',', ';', '\t'].map((d) => [d, firstLine.split(d).length]);
    const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') quoted = false;
        else cell += c;
      } else if (c === '"') quoted = true;
      else if (c === delim) { row.push(cell); cell = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.map((r) => r.map((x) => x.trim())).filter((r) => r.some((x) => x));
  }

  // ---- dates and times ----
  const TIME_RE = /(\d{1,2})[:.](\d{2})(?:[:.]\d{2})?\s*([ap])?\.?\s*m?\.?(?![\d])/i;
  function readTime(s) {
    const m = String(s || '').match(TIME_RE);
    if (!m) return null;
    let h = +m[1];
    const min = +m[2];
    if (m[3]) { const pm = /p/i.test(m[3]); if (h === 12) h = pm ? 12 : 0; else if (pm) h += 12; }
    if (h > 24 || min > 59) return null;
    return { h: h === 24 ? 0 : h, m: min, plusDay: h === 24 };
  }
  const fixYear = (y) => { y = +y; if (y < 100) y += 2000; if (y > 2400) y -= 543; return y; };
  // Numeric dates whose order is unclear: returns [a, b] for the order check, else null
  function numericParts(s) {
    const m = String(s || '').match(/(^|[^\d])(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?!\d)/);
    return m ? [+m[2], +m[3], m[4]] : null;
  }
  function readDate(s, dayFirst) {
    s = String(s || '');
    let m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return iso(fixYear(m[1]), +m[2], +m[3]);
    const n = numericParts(s);
    if (n) return dayFirst ? iso(fixYear(n[2]), n[1], n[0]) : iso(fixYear(n[2]), n[0], n[1]);
    m = s.match(/([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})/);
    if (m && MONTHS.includes(m[1].slice(0, 3).toLowerCase())) return iso(fixYear(m[3]), MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1, +m[2]);
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})/);
    if (m && MONTHS.includes(m[2].slice(0, 3).toLowerCase())) return iso(fixYear(m[3]), MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1, +m[1]);
    return null;
  }
  function iso(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    return `${y}-${pad(mo)}-${pad(d)}`;
  }
  function addDays(isoDate, n) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
  }
  // "YYYY-MM-DD HH:MM" from a date cell and a time cell (either may hold both)
  function stamp(dateCell, timeCell, dayFirst) {
    const date = readDate(dateCell, dayFirst) || readDate(timeCell, dayFirst);
    // the time: from the time cell, or what's left of the date cell after its date
    const t = readTime(timeCell && timeCell !== dateCell ? timeCell : String(dateCell || '').replace(/\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}/, ''));
    if (!date || !t) return '';
    return `${t.plusDay ? addDays(date, 1) : date} ${pad(t.h)}:${pad(t.m)}`;
  }
  const minutesOf = (st) => { const [d, t] = st.split(' '); const [h, m] = t.split(':').map(Number); return Date.UTC(...d.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) / 60000 + h * 60 + m; };
  function businessDay(st) {
    const [d, t] = st.split(' ');
    return +t.slice(0, 2) < DAY_START_HOUR ? addDays(d, -1) : d;
  }

  // ---- the export ----
  const COLS = {
    employee: /employee|staff|name|พนักงาน/i,
    store: /store|shop|location|ร้าน|สาขา/i,
    inDate: /(clock|time|punch)?.?in.*date|date.*(clock|time|punch)?.?in\b|^date$|^day$/i,
    inTime: /clock.?in|time.?in|^in$|punch.?in|start/i,
    outDate: /(clock|time|punch)?.?out.*date|date.*(clock|time|punch)?.?out\b/i,
    outTime: /clock.?out|time.?out|^out$|punch.?out|end/i,
  };
  function findColumns(header) {
    const used = new Set();
    const pick = (re, skip) => {
      const i = header.findIndex((h, n) => !used.has(n) && re.test(h) && !(skip && skip.test(h)));
      if (i >= 0) used.add(i);
      return i;
    };
    // dates before times, so "Clock in date" isn't taken as the clock-in time
    const inDate = pick(COLS.inDate, /out/i);
    const outDate = pick(COLS.outDate);
    const inTime = pick(COLS.inTime, /date|out/i);
    const outTime = pick(COLS.outTime, /date/i);
    const employee = pick(COLS.employee, /store|shop/i);
    const store = pick(COLS.store);
    return { employee, store, inDate, inTime, outDate, outTime };
  }

  // -> { cards: [{ employee, store, inAt, outAt }], from, to, skipped, dayFirst, error? }
  function parseTimecards(text) {
    const rows = parseCsv(text);
    const h = rows.findIndex((r) => r.some((c) => COLS.employee.test(c)) && r.some((c) => /in/i.test(c)) && r.some((c) => /out/i.test(c)));
    if (h < 0) return { cards: [], skipped: 0, error: 'This doesn\'t look like the Loyverse Timecards export: no row with Employee, Clock in and Clock out.' };
    const col = findColumns(rows[h]);
    if (col.employee < 0 || col.inTime < 0) return { cards: [], skipped: 0, error: 'Could not find the Employee and Clock in columns.' };
    const body = rows.slice(h + 1);
    const cell = (r, i) => (i >= 0 ? r[i] || '' : '');

    // day/month order, from every numeric date in the file
    let dayFirst = null;
    for (const r of body) {
      for (const i of [col.inDate, col.inTime, col.outDate, col.outTime]) {
        const n = numericParts(cell(r, i));
        if (!n) continue;
        if (n[0] > 12) dayFirst = true;
        else if (n[1] > 12) dayFirst = false;
      }
      if (dayFirst !== null) break;
    }
    if (dayFirst === null) dayFirst = true;

    const cards = [];
    let skipped = 0, noClockIn = 0;
    for (const r of body) {
      const employee = cell(r, col.employee);
      if (!employee || /^total/i.test(employee)) { skipped++; continue; }
      const inAt = stamp(cell(r, col.inDate) || cell(r, col.inTime), cell(r, col.inTime), dayFirst);
      if (!inAt) { skipped++; if (/missing/i.test(cell(r, col.inTime))) noClockIn++; continue; }
      let outAt = '';
      const outTimeCell = cell(r, col.outTime);
      if (outTimeCell && readTime(outTimeCell)) {
        outAt = stamp(cell(r, col.outDate) || outTimeCell, outTimeCell, dayFirst);
        // no date of its own: same day as clock-in, or the next day if earlier than clock-in
        if (!outAt || (!readDate(cell(r, col.outDate), dayFirst) && !readDate(outTimeCell, dayFirst))) {
          const t = readTime(outTimeCell);
          outAt = `${inAt.slice(0, 10)} ${pad(t.h)}:${pad(t.m)}`;
          if (t.plusDay || minutesOf(outAt) < minutesOf(inAt)) outAt = `${addDays(inAt.slice(0, 10), 1)} ${pad(t.h)}:${pad(t.m)}`;
        }
      }
      cards.push({ employee, store: cell(r, col.store), inAt, outAt });
    }
    const days = cards.map((c) => businessDay(c.inAt)).sort();
    return { cards, from: days[0] || '', to: days[days.length - 1] || '', skipped, noClockIn, dayFirst };
  }

  // ---- the report ----
  // cards: [{ day, employee, shop, inAt, outAt }] as saved -> days and per-person totals
  function build(cards, from, to) {
    const toMin = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const dayMin = (st) => { const h = +st.slice(11, 13), m = +st.slice(14, 16); return (h < DAY_START_HOUR ? h + 24 : h) * 60 + m; };
    const show = (st, day) => (st ? st.slice(11, 16) + (st.slice(0, 10) !== day ? ' (next day)' : '') : '');
    const byDay = new Map();
    const people = new Map();
    for (const c of cards) {
      const day = c.day || businessDay(c.inAt);
      if ((from && day < from) || (to && day > to)) continue;
      const hours = SHOP_HOURS[c.shop];
      const line = { employee: c.employee, shop: c.shop, in: show(c.inAt, day), out: show(c.outAt, day), hours: null, late: 0, early: 0, at: c.inAt };
      if (hours) {
        const late = dayMin(c.inAt) - toMin(hours[0]);
        if (late > GRACE_MIN) line.late = late;
      }
      if (c.outAt) {
        line.hours = Math.round(((minutesOf(c.outAt) - minutesOf(c.inAt)) / 60) * 100) / 100;
        if (hours && businessDay(c.outAt) === day) {
          const early = toMin(hours[1]) - dayMin(c.outAt);
          if (early > GRACE_MIN) line.early = early;
        }
      }
      if (!byDay.has(day)) byDay.set(day, []);
      byDay.get(day).push(line);
      const p = people.get(c.employee) || { employee: c.employee, days: new Set(), hours: 0, late: 0, early: 0, open: 0 };
      p.days.add(day); p.hours += line.hours || 0; if (line.late) p.late++; if (line.early) p.early++; if (!c.outAt) p.open++;
      people.set(c.employee, p);
    }
    const days = [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([date, lines]) => ({
      date,
      lines: lines.sort((a, b) => (a.shop < b.shop ? -1 : a.shop > b.shop ? 1 : a.at < b.at ? -1 : 1)).map(({ at, ...x }) => x),
    }));
    const totals = [...people.values()].sort((a, b) => a.employee.localeCompare(b.employee))
      .map((p) => ({ employee: p.employee, days: p.days.size, hours: Math.round(p.hours * 100) / 100, late: p.late, early: p.early, open: p.open }));
    return { from, to, days, totals };
  }

  const api = { SHOP_HOURS, parseCsv, parseTimecards, businessDay, build };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Timecards = api;
})(typeof window !== 'undefined' ? window : globalThis);
