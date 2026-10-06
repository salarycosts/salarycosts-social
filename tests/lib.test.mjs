import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSlot, validateSchedule, zonedToUtc, localParts, dueSlot, slotInstants, listQueue, inspectPost, jpegSize } from '../scripts/lib.mjs';
import { jpeg, makeRoot, addPost } from './helpers.mjs';

const BER = 'Europe/Berlin';
test('slots parse: daily and weekday forms, bad ones throw', () => {
  assert.deepEqual(parseSlot('19:30'), { dow: null, h: 19, mi: 30 });
  assert.deepEqual(parseSlot('Mon 07:30'), { dow: 1, h: 7, mi: 30 });
  assert.deepEqual(parseSlot('friday 9:05'), { dow: 5, h: 9, mi: 5 });
  assert.throws(() => parseSlot('25:00')); assert.throws(() => parseSlot('noon'));
  assert.throws(() => validateSchedule({ timezone: 'Mars/Base', slots: ['12:00'] }));
  assert.throws(() => validateSchedule({ timezone: BER, slots: [] }));
});
test('time zones: Berlin winter (UTC+1) and summer (UTC+2), the daylight-saving changes, other zones', () => {
  assert.equal(new Date(zonedToUtc(2026, 1, 15, 12, 30, BER)).toISOString(), '2026-01-15T11:30:00.000Z');
  assert.equal(new Date(zonedToUtc(2026, 7, 15, 12, 30, BER)).toISOString(), '2026-07-15T10:30:00.000Z');
  assert.equal(new Date(zonedToUtc(2026, 3, 29, 19, 30, BER)).toISOString(), '2026-03-29T17:30:00.000Z'); // summer time starts 2026-03-29
  assert.equal(new Date(zonedToUtc(2026, 10, 25, 19, 30, BER)).toISOString(), '2026-10-25T18:30:00.000Z'); // and ends 2026-10-25
  assert.equal(new Date(zonedToUtc(2026, 3, 8, 12, 0, 'Asia/Karachi')).toISOString(), '2026-03-08T07:00:00.000Z');
  assert.equal(localParts(new Date('2026-10-05T23:30:00Z'), BER).dow, 2); // 01:30 Tuesday in Berlin
});
test('two daily slots: due inside the 90 minute window, used up once a post went out, nothing outside', () => {
  const sch = { timezone: BER, slots: ['12:30', '19:30'] };
  const t = (iso) => Date.parse(iso); // October: Berlin is UTC+2
  const noon = t('2026-10-06T10:30:00Z'), evening = t('2026-10-06T17:30:00Z');
  assert.equal(dueSlot(sch, noon + 10 * 60000, 0), noon);                       // 12:40 local: first slot due
  assert.equal(dueSlot(sch, noon + 10 * 60000, noon + 5 * 60000), null);       // already posted for this slot
  assert.equal(dueSlot(sch, noon + 4 * 3600000, 0), null);                      // 16:30 local: first slot too old, evening not yet
  assert.equal(dueSlot(sch, evening + 25 * 60000, noon + 60000), evening);     // 19:55: evening slot due after the lunchtime post
  assert.equal(dueSlot(sch, evening + 25 * 60000, evening + 60000), null);
});
test('weekday slots only fire on their weekday', () => {
  const sch = { timezone: BER, slots: ['Mon 19:30', 'Thu 19:30'] };
  const days = slotInstants(sch, Date.parse('2026-10-05T00:00:00Z'), Date.parse('2026-10-13T00:00:00Z')).map((x) => localParts(new Date(x), BER).dow);
  assert.deepEqual(days, [1, 4, 1]);
});
test('queue order is natural (2 before 10) and slides are ordered by number', () => {
  const root = makeRoot();
  for (const n of ['10-last', '02-second', '01-first']) addPost(root, n, { slides: 2 });
  assert.deepEqual(listQueue(join(root, 'queue')), ['01-first', '02-second', '10-last']);
  addPost(root, '03-order', { slides: 10 });
  assert.deepEqual(inspectPost(join(root, 'queue'), '03-order').slides.map((s) => s.slice(6, 8)), ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10']);
});
test('validation: good post passes; each kind of mistake is reported', () => {
  const root = makeRoot(), q = join(root, 'queue');
  addPost(root, 'good'); assert.ok(inspectPost(q, 'good').ok);
  addPost(root, 'one', { slides: 1 }); assert.match(inspectPost(q, 'one').errors.join(), /at least 2/);
  addPost(root, 'eleven', { slides: 11 }); assert.match(inspectPost(q, 'eleven').errors.join(), /allows 10/);
  addPost(root, 'nocap', { caption: null }); assert.match(inspectPost(q, 'nocap').errors.join(), /caption.txt is missing/);
  addPost(root, 'tall', { w: 1080, h: 2400 }); assert.match(inspectPost(q, 'tall').errors.join(), /aspect ratio/);
  addPost(root, 'small', { w: 200, h: 250 }); assert.match(inspectPost(q, 'small').errors.join(), /minimum 320/);
  addPost(root, 'long', { caption: 'x'.repeat(2300) }); assert.match(inspectPost(q, 'long').errors.join(), /2300 characters/);
  addPost(root, 'tags', { caption: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(' ') }); assert.match(inspectPost(q, 'tags').errors.join(), /31 hashtags/);
  const bad = addPost(root, 'notjpg', { slides: 2 }); writeFileSync(join(bad, 'slide-02.jpg'), 'not an image'); assert.match(inspectPost(q, 'notjpg').errors.join(), /not a readable JPEG/);
  const mixed = addPost(root, 'mixed', { slides: 2 }); writeFileSync(join(mixed, 'slide-02.jpg'), jpeg(1080, 1080)); assert.ok(inspectPost(q, 'mixed').warnings.some((w) => /different size/.test(w)));
  assert.deepEqual(jpegSize(jpeg(1080, 1350)), { w: 1080, h: 1350 });
});

test('six slots a day: each is due for 90 minutes after its time, a post uses up its own slot only', () => {
  const sch = { timezone: BER, slots: ['07:30', '10:30', '12:45', '15:30', '18:30', '20:30'], graceMinutes: 90 };
  const z = (hhmm) => Date.parse(`2026-10-06T${hhmm}:00Z`); // Berlin = UTC+2, so 07:30 local is 05:30Z
  assert.equal(slotInstants(sch, z('00:00'), z('23:59')).length, 6);
  assert.equal(dueSlot(sch, z('05:40'), 0), z('05:30'));               // 07:40 local: first slot is due
  assert.equal(dueSlot(sch, z('05:40'), z('05:31')), null);            // it already has its post
  assert.equal(dueSlot(sch, z('07:00'), z('05:31')), null);            // 09:00 local: first slot is 90 min old and used; second not yet
  assert.equal(dueSlot(sch, z('08:40'), z('05:31')), z('08:30'));      // 10:40 local: second slot due
  assert.equal(dueSlot(sch, z('10:20'), z('08:31')), null);            // 12:20 local: nothing due (12:45 not yet, 10:30 used)
  assert.equal(dueSlot(sch, z('11:00'), z('08:31')), z('10:45'));      // 13:00 local: third slot due
  assert.equal(dueSlot(sch, z('12:30'), z('10:46')), null);            // 14:30 local: third slot is 105 min old, too late; 15:30 not yet
});
