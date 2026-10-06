// Posts the next carousel from queue/ to Instagram (official Graph API) when a schedule slot is due.
// Env: IG_ACCESS_TOKEN (secret), IG_USER_ID (optional, defaults to "me") | GITHUB_REPOSITORY, BRANCH (for the public image URLs) | DRY_RUN=1, FORCE=1
// Run: node scripts/publish.mjs            (the GitHub Action does this every 30 minutes)
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateSchedule, dueSlot, nextSlots, listQueue, inspectPost } from './lib.mjs';

const HOST = process.env.IG_API_HOST || 'graph.facebook.com', VERSION = process.env.GRAPH_VERSION || 'v21.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8') || 'null') ?? fallback : fallback);
const when = (ms, tz) => new Date(ms).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });

// one Graph API call; the access token is added here and never printed
async function graph(fetchFn, path, { method = 'GET', params = {}, token }) {
  const url = new URL(`https://${HOST}/${VERSION}/${path}`), body = new URLSearchParams({ ...params, access_token: token });
  const res = method === 'GET' ? await fetchFn(`${url}?${body}`) : await fetchFn(url, { method, body });
  let json = {}; try { json = await res.json(); } catch { /* keep empty */ }
  if (!res.ok || json.error) throw new Error(`Instagram API ${path.replace(/\d{6,}/g, '<id>')} failed (${res.status}): ${json.error?.message ?? 'unknown error'}${json.error?.code ? ` [code ${json.error.code}]` : ''}`);
  return json;
}
async function waitFinished(fetchFn, id, token, { tries = 40, delay = 3000, sleepFn = sleep } = {}) {
  for (let i = 0; i < tries; i++) {
    const { status_code: s, status } = await graph(fetchFn, id, { params: { fields: 'status_code,status' }, token });
    if (s === 'FINISHED') return;
    if (s === 'ERROR' || s === 'EXPIRED') throw new Error(`Instagram could not process an image (${s}${status ? `: ${status}` : ''}).`);
    await sleepFn(delay);
  }
  throw new Error('Timed out waiting for Instagram to process the post.');
}

export async function runOnce({ root, env = process.env, now = Date.now(), fetchFn = fetch, log = console.log, sleepFn = sleep } = {}) {
  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true', force = env.FORCE === '1' || env.FORCE === 'true';
  const schedule = validateSchedule(readJson(join(root, 'schedule.json'), null));
  const postedFile = join(root, 'posted.json'), posted = readJson(postedFile, []);
  const last = posted.length ? Math.max(...posted.map((p) => Date.parse(p.postedAt))) : 0;
  const result = { posted: false, problems: [], dry };

  const queueDir = join(root, 'queue'), names = listQueue(queueDir), inspected = names.map((n) => inspectPost(queueDir, n));
  const broken = inspected.filter((x) => !x.ok).map((p) => `${p.name}: ${p.errors.join('; ')}`);
  broken.forEach((b) => log(`PROBLEM  ${b}`));
  const good = inspected.filter((x) => x.ok);
  log(`Queue: ${good.length} ready post(s)${inspected.length - good.length ? `, ${inspected.length - good.length} with problems` : ''}. Next slots: ${nextSlots(schedule, now, 3).map((t) => when(t, schedule.timezone)).join(' | ') || 'none'}.`);

  const slot = force ? now : dueSlot(schedule, now, last);
  if (slot === null) { log('No slot is due right now (or this slot already has its post). Nothing to do.'); return result; }
  const post = good[0];
  if (!post) {
    log('The queue is empty. Add post folders to queue/.');
    if (broken.length) result.problems.push(`no valid post to publish; fix: ${broken.join(' | ')}`); // only a real failure when something is broken
    return result;
  }
  result.problems.push(...broken);
  log(`${dry ? 'DRY RUN: would post' : 'Posting'} "${post.name}" for the slot ${when(slot, schedule.timezone)}:`);
  post.slides.forEach((f, i) => log(`  slide ${i + 1}: ${f}`));
  log(`  caption: ${post.caption.split('\n')[0].slice(0, 80)}${post.caption.length > 80 ? '...' : ''}`);
  post.warnings.forEach((w) => log(`  warning: ${w}`));
  if (dry) { result.would = post.name; return result; }

  const token = env.IG_ACCESS_TOKEN, igId = env.IG_USER_ID || 'me', repo = env.GITHUB_REPOSITORY, branch = env.BRANCH || 'main';
  if (!token) throw new Error('IG_ACCESS_TOKEN must be set as a repository secret (see README.md). IG_USER_ID is optional; "me" is used when it is not set.');
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set (it is set automatically inside GitHub Actions).');
  const urlOf = (f) => `https://raw.githubusercontent.com/${repo}/${branch}/queue/${encodeURIComponent(post.name)}/${encodeURIComponent(f)}`;

  const children = [];
  for (const f of post.slides) {
    const { id } = await graph(fetchFn, `${igId}/media`, { method: 'POST', params: { image_url: urlOf(f), is_carousel_item: 'true' }, token });
    children.push(id);
  }
  for (const id of children) await waitFinished(fetchFn, id, token, { sleepFn });
  const { id: container } = await graph(fetchFn, `${igId}/media`, { method: 'POST', params: { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption }, token });
  await waitFinished(fetchFn, container, token, { sleepFn });
  const { id: mediaId } = await graph(fetchFn, `${igId}/media_publish`, { method: 'POST', params: { creation_id: container }, token });

  // only after Instagram confirmed: move the folder and write the log
  mkdirSync(join(root, 'posted'), { recursive: true });
  renameSync(join(queueDir, post.name), join(root, 'posted', post.name));
  posted.push({ folder: post.name, postedAt: new Date(now).toISOString(), slot: new Date(slot).toISOString(), mediaId });
  writeFileSync(postedFile, JSON.stringify(posted, null, 2) + '\n');
  result.posted = true; result.folder = post.name; result.mediaId = mediaId;
  const left = good.length - 1;
  log(`DONE: published "${post.name}" (media ${mediaId}). ${left} post(s) left in the queue.`);
  // the ONE email you get: notify.md becomes a GitHub issue when the last post has gone out
  if (left === 0) { writeFileSync(join(root, 'notify.md'), `All posts are published: the queue is finished
The last post, "${post.name}", just went out. ${posted.length} post(s) published in total. Add new post folders to queue/ to keep going.
`); log('NOTICE: queue finished.'); }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `Published **${post.name}** (media ${mediaId}). ${left} post(s) left in the queue.
`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  runOnce({ root }).then((r) => { if (r.problems.length && !r.posted) process.exitCode = 1; }).catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
}
