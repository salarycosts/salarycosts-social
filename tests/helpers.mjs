import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// smallest possible valid-looking JPEG header with a given size (enough for the size check; not a viewable picture)
export const jpeg = (w, h) => { const b = Buffer.alloc(30); b.set([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8]); b.writeUInt16BE(h, 7); b.writeUInt16BE(w, 9); b.set([3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1], 11); b.set([0xff, 0xd9], 28); return b; };
export const makeRoot = (schedule = { timezone: 'Europe/Berlin', slots: ['12:30', '19:30'] }) => { const r = mkdtempSync(join(tmpdir(), 'sq-')); mkdirSync(join(r, 'queue')); writeFileSync(join(r, 'schedule.json'), JSON.stringify(schedule)); writeFileSync(join(r, 'posted.json'), '[]'); return r; };
export const addPost = (root, name, { slides = 3, w = 1080, h = 1350, caption = 'Hello #tag' } = {}) => { const d = join(root, 'queue', name); mkdirSync(d); for (let i = 1; i <= slides; i++) writeFileSync(join(d, `slide-${String(i).padStart(2, '0')}.jpg`), jpeg(w, h)); if (caption !== null) writeFileSync(join(d, 'caption.txt'), caption); return d; };
