import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyOnce, parseTime, looksLikeSpam, isQuestion } from '../scripts/reply.mjs';

// a fake Instagram with two posts and a fixed set of comments; records every reply
function fakeInstagram(comments, { failReply } = {}) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), path = u.pathname.replace(/^\/(v[\d.]+\/)?/, ''), method = init.method ?? 'GET', body = init.body ? Object.fromEntries(init.body) : {};
    calls.push({ method, path, body });
    const ok = (j) => ({ ok: true, status: 200, json: async () => j });
    if (path === 'me') return ok({ username: 'salary.costs' });
    if (path === 'me/media') return ok({ data: [{ id: 'M1' }, { id: 'M2' }] });
    if (path.endsWith('/comments')) return ok({ data: comments[path.split('/')[0]] ?? [] });
    if (path.endsWith('/replies')) return failReply ? { ok: false, status: 400, json: async () => ({ error: { message: failReply, code: 10 } }) } : ok({ id: 'R' });
    return ok({});
  };
  return { fetchFn, calls, replies: () => calls.filter((c) => c.path.endsWith('/replies')) };
}
const NOW = Date.parse('2026-10-08T12:00:00Z');
const c = (id, username, text, ts = '2026-10-08T11:30:00+0000', extra = {}) => ({ id, username, text, timestamp: ts, ...extra });
const root = (state) => { const r = mkdtempSync(join(tmpdir(), 'rp-')); if (state) writeFileSync(join(r, 'replies.json'), JSON.stringify(state)); return r; };
const STARTED = { startedAt: '2026-10-08T10:00:00.000Z', replied: {} };
const run = (r, ig, env = {}) => replyOnce({ root: r, env: { IG_ACCESS_TOKEN: 'SECRET', ...env }, now: NOW, fetchFn: ig.fetchFn, log: () => {}, sleepFn: async () => {} });

test('replies once to a new comment with one of the two templates, mentions the person, and logs it', async () => {
  const r = root(STARTED), ig = fakeInstagram({ M1: [c('c1', 'anna', 'Great post!')] });
  const res = await run(r, ig);
  assert.equal(res.replied, 1);
  assert.equal(ig.replies()[0].path, 'c1/replies');
  assert.match(ig.replies()[0].body.message, /^@anna .*(appreciate)/);
  assert.ok(JSON.parse(readFileSync(join(r, 'replies.json'), 'utf8')).replied.c1);
  const again = await run(r, ig); // second run: nothing new
  assert.equal(again.replied, 0); assert.equal(ig.replies().length, 1);
});

test('alternates between the two templates', async () => {
  const r = root(STARTED), ig = fakeInstagram({ M1: [c('c1', 'a', 'nice', '2026-10-08T11:00:00+0000'), c('c2', 'b', 'cool', '2026-10-08T11:10:00+0000')] });
  await run(r, ig);
  const [m1, m2] = ig.replies().map((x) => x.body.message);
  assert.notEqual(m1.replace('@a', ''), m2.replace('@b', ''));
});

test('first run starts the clock: old comments are never answered', async () => {
  const r = root(null), ig = fakeInstagram({ M1: [c('old', 'zed', 'old comment', '2026-10-01T09:00:00+0000')] });
  const res = await run(r, ig);
  assert.equal(res.started, true); assert.equal(ig.replies().length, 0);
  assert.equal(JSON.parse(readFileSync(join(r, 'replies.json'), 'utf8')).startedAt, new Date(NOW).toISOString());
});

test('ignores our own comments, replies to comments, links and spam; answers each person once per post', async () => {
  const r = root(STARTED), ig = fakeInstagram({ M1: [
    c('own', 'salary.costs', 'thanks everyone'), c('sub', 'bob', 'thanks', undefined, { parent_id: 'x' }),
    c('link', 'spam1', 'check this https://example.com'), c('promo', 'spam2', 'DM me for a collab'),
    c('ok1', 'carl', 'Love this'), c('ok2', 'carl', 'Love this again'),
  ], M2: [c('ok3', 'carl', 'And this one')] });
  const res = await run(r, ig);
  assert.deepEqual(ig.replies().map((x) => x.path), ['ok1/replies', 'ok3/replies']); // carl once on M1, once on M2
  assert.equal(res.replied, 2);
});

test('respects the per-run limit and leaves the rest for the next run', async () => {
  const many = Array.from({ length: 8 }, (_, i) => c(`c${i}`, `user${i}`, 'hi', `2026-10-08T11:0${i}:00+0000`));
  const r = root(STARTED), ig = fakeInstagram({ M1: many });
  const res = await run(r, ig);
  assert.equal(res.replied, 5);
  assert.equal((await run(r, ig)).replied, 3);
});

test('dry run replies to nothing and writes nothing', async () => {
  const r = root(STARTED), ig = fakeInstagram({ M1: [c('c1', 'anna', 'hi')] });
  await run(r, ig, { DRY_RUN: '1' });
  assert.equal(ig.replies().length, 0); assert.deepEqual(JSON.parse(readFileSync(join(r, 'replies.json'), 'utf8')).replied, {});
});

test('a missing comment permission fails the run with a clear message and never prints the token', async () => {
  const r = root(STARTED), ig = fakeInstagram({ M1: [c('c1', 'anna', 'hi')] }, { failReply: '(#10) Application does not have permission for this action' });
  await assert.rejects(() => run(r, ig), (e) => /manage_comments/.test(e.message) && !e.message.includes('SECRET'));
});

test('time parsing and spam check helpers', () => {
  assert.equal(parseTime('2026-10-08T12:00:00+0000'), Date.parse('2026-10-08T12:00:00Z'));
  assert.equal(looksLikeSpam('Nice post!'), false); assert.equal(looksLikeSpam('visit mysite.com'), true); assert.equal(looksLikeSpam('WhatsApp me', ['whatsapp']), true);
});

test('questions are left for a human; plain thanks and emojis are answered', async () => {
  const r = root(STARTED), ig = fakeInstagram({ M1: [c('q', 'quinn', 'How much is 60k after tax?'), c('e', 'emma', '🔥🔥'), c('t', 'tom', 'Thanks!')] });
  const res = await run(r, ig);
  assert.deepEqual(ig.replies().map((x) => x.path).sort(), ['e/replies', 't/replies']); assert.equal(res.skipped, 1);
  assert.equal(isQuestion('what?'), true); assert.equal(isQuestion('great'), false);
});
