// Replies to new comments on the account's posts with one of two friendly templates (reply-config.json).
// Env: IG_ACCESS_TOKEN (secret; needs the instagram_business_manage_comments permission) | DRY_RUN=1 shows what it would do and writes nothing.
// Run: node scripts/reply.mjs            (the "reply to comments" GitHub Action does this every 30 minutes)
// State: replies.json = { startedAt, replied: { <commentId>: { at, user, media } } }. Comments older than startedAt are never answered.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { graph } from './publish.mjs';

const readJson = (f, fallback) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8') || 'null') ?? fallback : fallback);
// "2026-10-08T12:00:00+0000" -> ms (Instagram writes the offset without a colon)
export const parseTime = (s) => Date.parse(String(s).replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
// Comments we never answer: links, contact offers, promotion. They are left alone (not hidden, not deleted).
export const looksLikeSpam = (text, words = []) => {
  const t = String(text).toLowerCase();
  if (/https?:|www\.|\.(com|net|org|io|co|me|ly|xyz|shop|site|online)\b|t\.me|wa\.me|bit\.ly/.test(t)) return true;
  return words.some((w) => t.includes(w.toLowerCase()));
};
// A question is left for a human to answer (a thank-you template would look off)
export const isQuestion = (text) => /[?？؟]/.test(String(text));
const DEFAULTS = {
  templates: [
    '@{user} Thank you for commenting! 🙏 We really appreciate your interest 💜',
    '@{user} Thanks for stopping by! 😊 We appreciate the support ✨',
  ],
  maxPerRun: 5, maxPerDay: 40,
  spamWords: ['dm me', 'dm us', 'whatsapp', 'promo', 'promote', 'collab', 'feature your', 'send me', 'follow me', 'check my', 'earn $', 'giveaway', 'free followers', 'crypto', 'forex', 'binary', 'loan'],
};

export async function replyOnce({ root, env = process.env, now = Date.now(), fetchFn = fetch, log = console.log, sleepFn } = {}) {
  const cfg = { ...DEFAULTS, ...readJson(join(root, 'reply-config.json'), {}) };
  const dry = env.DRY_RUN === '1' || env.DRY_RUN === 'true', token = env.IG_ACCESS_TOKEN;
  if (!token) throw new Error('IG_ACCESS_TOKEN must be set as a repository secret (see README.md).');
  const stateFile = join(root, 'replies.json'), fresh = !existsSync(stateFile);
  const state = readJson(stateFile, { startedAt: new Date(now).toISOString(), replied: {} });
  const since = Date.parse(state.startedAt), result = { replied: 0, skipped: 0, failed: 0, started: fresh };
  const g = (path, params, method = 'GET') => graph(fetchFn, path, { method, params, token, ...(sleepFn ? { sleepFn } : {}) });

  const { username: me } = await g('me', { fields: 'username' });
  const media = (await g('me/media', { fields: 'id,timestamp', limit: '30' })).data ?? [];
  const dayAgo = now - 86400000, doneToday = Object.values(state.replied).filter((r) => Date.parse(r.at) > dayAgo).length;
  let budget = Math.min(cfg.maxPerRun, cfg.maxPerDay - doneToday);
  if (fresh) log(`First run: only comments written after ${state.startedAt} will be answered.`);

  const todo = [];
  for (const m of media) {
    const list = (await g(`${m.id}/comments`, { fields: 'id,text,username,timestamp,parent_id', limit: '50' })).data ?? [];
    for (const c of list) {
      if (state.replied[c.id]) continue;
      if (c.parent_id || c.username === me) continue; // replies and our own comments
      if (!(parseTime(c.timestamp) > since)) continue; // older than the start of the bot
      if (isQuestion(c.text ?? '')) { result.skipped++; log(`SKIP (question, answer it yourself) ${c.username}: ${String(c.text).slice(0, 60)}`); continue; }
      if (looksLikeSpam(c.text ?? '', cfg.spamWords)) { result.skipped++; log(`SKIP (spam-like) ${c.username}: ${String(c.text).slice(0, 60)}`); continue; }
      if (Object.values(state.replied).some((r) => r.media === m.id && r.user === c.username) || todo.some((t) => t.media === m.id && t.user === c.username)) { result.skipped++; continue; } // once per person per post
      todo.push({ id: c.id, user: c.username, media: m.id, time: parseTime(c.timestamp) });
    }
  }
  todo.sort((a, b) => a.time - b.time);
  log(`${todo.length} comment(s) to answer, budget ${Math.max(budget, 0)} this run (${doneToday} answered in the last 24 hours).`);

  for (const c of todo) {
    if (budget <= 0) { log('Limit reached; the rest waits for the next run.'); break; }
    const n = Object.keys(state.replied).length, message = cfg.templates[n % cfg.templates.length].replaceAll('{user}', c.user);
    if (dry) { log(`DRY RUN: would reply to ${c.user}: ${message}`); budget--; continue; }
    try {
      await g(`${c.id}/replies`, { message }, 'POST');
      state.replied[c.id] = { at: new Date(now).toISOString(), user: c.user, media: c.media };
      result.replied++; budget--; log(`Replied to ${c.user}.`);
    } catch (e) {
      result.failed++; log(`FAILED reply to ${c.user}: ${e.message}`);
      if (/permission|\(#10\)|\(#200\)|code (10|200)\b/i.test(e.message)) throw new Error(`${e.message}\nThe token needs the instagram_business_manage_comments permission: create a new token that includes it and update the IG_ACCESS_TOKEN secret.`);
    }
  }
  if (!dry) writeFileSync(stateFile, JSON.stringify(state, null, 2) + '\n');
  log(`DONE: ${result.replied} replied, ${result.skipped} skipped, ${result.failed} failed.`);
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  replyOnce({ root }).then((r) => { if (r.failed && !r.replied) process.exitCode = 1; }).catch((e) => { console.error(`ERROR: ${e.message}`); process.exitCode = 1; });
}
