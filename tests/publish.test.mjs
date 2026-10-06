import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runOnce } from '../scripts/publish.mjs';
import { makeRoot, addPost } from './helpers.mjs';

// a fake Instagram: records every call and answers like the real API
function fakeInstagram({ failOn } = {}) {
  const calls = []; let n = 0;
  const fetchFn = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? Object.fromEntries(init.body) : Object.fromEntries(u.searchParams), path = u.pathname.replace(/^\/v[\d.]+\//, '');
    calls.push({ method: init.method ?? 'GET', path, body });
    if (failOn && path.includes(failOn)) return { ok: false, status: 400, json: async () => ({ error: { message: 'boom', code: 100 } }) };
    if (path.endsWith('/media_publish')) return { ok: true, status: 200, json: async () => ({ id: 'MEDIA1' }) };
    if (path.endsWith('/media')) return { ok: true, status: 200, json: async () => ({ id: `C${++n}` }) };
    return { ok: true, status: 200, json: async () => ({ status_code: 'FINISHED' }) };
  };
  return { fetchFn, calls };
}
const ENV = { IG_USER_ID: '123456789', IG_ACCESS_TOKEN: 'SECRET_TOKEN_VALUE', GITHUB_REPOSITORY: 'me/salarycosts-social', BRANCH: 'main' };
const NOON = Date.parse('2026-10-06T10:35:00Z'); // 12:35 Berlin, first slot
const EVENING = Date.parse('2026-10-06T17:40:00Z'); // 19:40 Berlin, second slot
const logs = []; const log = (m) => logs.push(m);
const go = (root, now, ig, env = ENV) => runOnce({ root, env, now, fetchFn: ig.fetchFn, log, sleepFn: async () => {} });

test('posts the first folder as a carousel in slide order, then moves it and logs it', async () => {
  const root = makeRoot(); addPost(root, '02-second', { slides: 2 }); addPost(root, '01-first', { slides: 3, caption: 'Caption text #a' });
  const ig = fakeInstagram(), r = await go(root, NOON, ig);
  assert.equal(r.posted, true); assert.equal(r.folder, '01-first');
  const kids = ig.calls.filter((c) => c.body.is_carousel_item === 'true');
  assert.deepEqual(kids.map((c) => c.body.image_url.split('/').slice(-1)[0]), ['slide-01.jpg', 'slide-02.jpg', 'slide-03.jpg']);
  assert.ok(kids[0].body.image_url.startsWith('https://raw.githubusercontent.com/me/salarycosts-social/main/queue/01-first/'));
  const carousel = ig.calls.find((c) => c.body.media_type === 'CAROUSEL');
  assert.equal(carousel.body.children, 'C1,C2,C3'); assert.equal(carousel.body.caption, 'Caption text #a');
  assert.ok(ig.calls.at(-1).path.endsWith('/media_publish'));
  assert.ok(!existsSync(join(root, 'queue', '01-first')) && existsSync(join(root, 'posted', '01-first', 'slide-01.jpg')));
  const logged = JSON.parse(readFileSync(join(root, 'posted.json'), 'utf8')); assert.equal(logged[0].folder, '01-first'); assert.equal(logged[0].mediaId, 'MEDIA1');
  assert.ok(!JSON.stringify(logs).includes('SECRET_TOKEN_VALUE'), 'the token must never be logged');
  assert.ok(!existsSync(join(root, 'notify.md')), 'no email after an ordinary post');
});
test('the same slot never posts twice; the evening slot posts the next folder', async () => {
  const root = makeRoot(); addPost(root, '01-a'); addPost(root, '02-b'); addPost(root, '03-c');
  const ig = fakeInstagram();
  assert.equal((await go(root, NOON, ig)).folder, '01-a');
  assert.equal((await go(root, NOON + 30 * 60000, ig)).posted, false);   // next 30-minute run, same slot
  assert.equal((await go(root, EVENING, ig)).folder, '02-b');
});
test('a broken folder is skipped, reported, and the next valid one still posts', async () => {
  const root = makeRoot(); addPost(root, '01-broken', { caption: null }); addPost(root, '02-ok');
  const r = await go(root, NOON, fakeInstagram());
  assert.equal(r.folder, '02-ok'); assert.match(r.problems.join(), /01-broken/); assert.ok(existsSync(join(root, 'queue', '01-broken')));
});
test('an API failure leaves the folder in the queue and the log untouched (nothing lost, nothing double-posted)', async () => {
  const root = makeRoot(); addPost(root, '01-a');
  await assert.rejects(() => go(root, NOON, fakeInstagram({ failOn: 'media_publish' })), /boom/);
  assert.ok(existsSync(join(root, 'queue', '01-a'))); assert.equal(JSON.parse(readFileSync(join(root, 'posted.json'), 'utf8')).length, 0);
});
test('dry run and "no slot due" make no API calls', async () => {
  const root = makeRoot(); addPost(root, '01-a'); const ig = fakeInstagram();
  assert.equal((await go(root, NOON, ig, { ...ENV, DRY_RUN: '1' })).would, '01-a');
  assert.equal((await go(root, Date.parse('2026-10-06T14:30:00Z'), ig)).posted, false); // 16:30 Berlin, no slot due
  assert.equal(ig.calls.length, 0);
});
test('exactly ONE notice: only when the last post has gone out; an empty queue afterwards is silent (no repeated emails)', async () => {
  const root = makeRoot(); addPost(root, '01-a'); addPost(root, '02-b'); const ig = fakeInstagram();
  await go(root, NOON, ig); assert.ok(!existsSync(join(root, 'notify.md')));
  await go(root, EVENING, ig); assert.match(readFileSync(join(root, 'notify.md'), 'utf8'), /queue is finished/);
  const next = await go(root, Date.parse('2026-10-07T10:35:00Z'), ig);   // next day, queue empty
  assert.equal(next.posted, false); assert.deepEqual(next.problems, []);  // exit code stays 0, so GitHub sends nothing
});
test('missing secrets fail with a clear message', async () => {
  const root = makeRoot(); addPost(root, '01-a');
  await assert.rejects(() => go(root, NOON, fakeInstagram(), {}), /IG_ACCESS_TOKEN and IG_USER_ID/);
});
