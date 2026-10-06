// Pure helpers for the Instagram auto-poster: schedule slots, queue listing and folder validation. No network here.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const MAX_SLIDES = 10, MAX_CAPTION = 2200, MAX_HASHTAGS = 30;

// ---- time zones (no dependencies: Intl does the work) ---------------------------------------------------------------
export function localParts(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' }).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, dow: DAYS.indexOf(p.weekday.toLowerCase()) };
}
const tzOffsetMs = (date, tz) => { const p = localParts(date, tz); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0) - Math.floor(date.getTime() / 60000) * 60000; };
// instant (ms, UTC) at which the wall clock in `tz` reads y-mo-d h:mi
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let t = guess - tzOffsetMs(new Date(guess), tz);
  t = guess - tzOffsetMs(new Date(t), tz); // second pass handles daylight-saving edges
  return t;
}

// ---- schedule ---------------------------------------------------------------------------------------------------------
// slot strings: "18:00" (every day) or "Mon 18:00" (that weekday only)
export function parseSlot(str) {
  const m = /^(?:(sun|mon|tue|wed|thu|fri|sat)[a-z]*\s+)?(\d{1,2}):(\d{2})$/i.exec(String(str).trim());
  if (!m) throw new Error(`Bad slot "${str}". Use "18:00" or "Mon 18:00".`);
  const h = +m[2], mi = +m[3];
  if (h > 23 || mi > 59) throw new Error(`Bad time in slot "${str}".`);
  return { dow: m[1] ? DAYS.indexOf(m[1].toLowerCase()) : null, h, mi };
}
export function validateSchedule(s) {
  if (!s || typeof s.timezone !== 'string' || !Array.isArray(s.slots) || !s.slots.length) throw new Error('schedule.json needs "timezone" and a non-empty "slots" list.');
  new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); // throws on an unknown timezone
  s.slots.forEach(parseSlot);
  return s;
}
// every slot instant (ms) in [fromMs, toMs]
export function slotInstants(schedule, fromMs, toMs) {
  const slots = schedule.slots.map(parseSlot), out = [];
  for (let day = fromMs - 86400000; day <= toMs + 86400000; day += 86400000) {
    const lp = localParts(new Date(day), schedule.timezone);
    for (const s of slots) {
      if (s.dow !== null && s.dow !== lp.dow) continue;
      const t = zonedToUtc(lp.y, lp.mo, lp.d, s.h, s.mi, schedule.timezone);
      if (t >= fromMs && t <= toMs) out.push(t);
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}
// the slot that is due now: a slot in the last `graceMs` that has not been used by a post yet
export function dueSlot(schedule, nowMs, lastPostedMs = 0, graceMs = 3 * 3600000) {
  const slots = slotInstants(schedule, nowMs - graceMs, nowMs);
  const s = slots[slots.length - 1];
  return s !== undefined && lastPostedMs < s ? s : null;
}
export const nextSlots = (schedule, nowMs, count = 5) => slotInstants(schedule, nowMs, nowMs + 21 * 86400000).slice(0, count);

// ---- queue ----------------------------------------------------------------------------------------------------------------
const natural = (a, b) => a.localeCompare(b, 'en', { numeric: true });
export const listQueue = (dir) => (existsSync(dir) ? readdirSync(dir).filter((n) => statSync(join(dir, n)).isDirectory()).sort(natural) : []);

// width/height of a JPEG from its header (no image library needed)
export function jpegSize(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xff) { i++; continue; }
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    i += 2 + buf.readUInt16BE(i + 2);
  }
  return null;
}

// Look inside one post folder. slides are ordered by the number in their file name (slide-1, slide-02, slide-10 ...).
export function inspectPost(dir, name) {
  const errors = [], warnings = [], full = join(dir, name);
  const files = readdirSync(full);
  const slides = files.filter((f) => /\.jpe?g$/i.test(f)).sort(natural);
  const others = files.filter((f) => !/\.jpe?g$/i.test(f) && f !== 'caption.txt');
  if (others.length) warnings.push(`ignored files: ${others.join(', ')}`);
  if (slides.length < 2) errors.push(`needs at least 2 slides (found ${slides.length})`);
  if (slides.length > MAX_SLIDES) errors.push(`has ${slides.length} slides, Instagram allows ${MAX_SLIDES}`);
  const nums = slides.map((f) => +(/(\d+)/.exec(f)?.[1] ?? NaN));
  if (nums.some(Number.isNaN)) errors.push('every slide file name needs a number (slide-01.jpg, slide-02.jpg ...)');
  else if (new Set(nums).size !== nums.length) errors.push('two slides share the same number');
  else if (nums.some((n, i) => i && n < nums[i - 1])) errors.push('slide numbers are not in order');
  let size0 = null;
  for (const f of slides) {
    const sz = jpegSize(readFileSync(join(full, f)));
    if (!sz) { errors.push(`${f} is not a readable JPEG`); continue; }
    if (sz.w < 320) errors.push(`${f} is only ${sz.w}px wide (minimum 320)`);
    const ratio = sz.w / sz.h;
    if (ratio < 0.8 || ratio > 1.91) errors.push(`${f} has aspect ratio ${ratio.toFixed(2)} (Instagram needs 0.80 to 1.91)`);
    if (!size0) size0 = sz; else if (sz.w !== size0.w || sz.h !== size0.h) warnings.push(`${f} has a different size than slide 1 (${sz.w}x${sz.h} vs ${size0.w}x${size0.h})`);
  }
  let caption = '';
  if (!existsSync(join(full, 'caption.txt'))) errors.push('caption.txt is missing');
  else {
    caption = readFileSync(join(full, 'caption.txt'), 'utf8').replace(/\r\n/g, '\n').trim();
    if (!caption) errors.push('caption.txt is empty');
    if ([...caption].length > MAX_CAPTION) errors.push(`caption has ${[...caption].length} characters (max ${MAX_CAPTION})`);
    const tags = (caption.match(/#\w+/g) || []).length;
    if (tags > MAX_HASHTAGS) errors.push(`caption has ${tags} hashtags (max ${MAX_HASHTAGS})`);
  }
  return { name, slides, caption, errors, warnings, ok: !errors.length };
}
