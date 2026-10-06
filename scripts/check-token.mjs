// Fails the run (so GitHub emails you) when the Instagram token no longer works or is about to expire.
// Env: IG_USER_ID, IG_ACCESS_TOKEN; optional FB_APP_ID + FB_APP_SECRET for the exact expiry date.
const HOST = process.env.IG_API_HOST || 'graph.facebook.com', V = process.env.GRAPH_VERSION ?? '';
const { IG_USER_ID: userId, IG_ACCESS_TOKEN: token, FB_APP_ID: app, FB_APP_SECRET: secret } = process.env;
const id = userId || 'me';
if (!token) { console.error('ERROR: set the IG_ACCESS_TOKEN repository secret (see README.md).'); process.exit(1); }
try {
  const r = await fetch(`https://${HOST}/${V ? `${V}/` : ''}${id}?fields=username&access_token=${encodeURIComponent(token)}`), j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  console.log(`Token works for @${j.username}.`);
  // token age: the file token-created.txt holds the date (YYYY-MM-DD) you pasted the current token; App Dashboard tokens last 60 days
  try {
    const { readFileSync } = await import('node:fs');
    const created = Date.parse(readFileSync(new URL('../token-created.txt', import.meta.url), 'utf8').trim());
    if (Number.isFinite(created)) {
      const left = 60 - Math.floor((Date.now() - created) / 86400000);
      console.log(`Token is about ${60 - left} day(s) old (${left} day(s) of its 60 left).`);
      if (left < 10) { console.error(`ERROR: the Instagram token expires in about ${Math.max(left, 0)} day(s). Create a new token, update the IG_ACCESS_TOKEN secret and the date in token-created.txt (README.md).`); process.exit(1); }
    }
  } catch { /* no date file: skip the age check */ }
  if (app && secret) {
    const d = await (await fetch(`https://${HOST}/${V ? `${V}/` : ''}debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${app}|${secret}`)}`)).json();
    const exp = d.data?.data_access_expires_at || d.data?.expires_at;
    if (exp) {
      const days = Math.floor((exp * 1000 - Date.now()) / 86400000);
      console.log(`Token expires in ${days} day(s).`);
      if (days < 10) { console.error(`ERROR: the Instagram token expires in ${days} day(s). Create a new one and update the IG_ACCESS_TOKEN secret (README.md, "Refresh the token").`); process.exit(1); }
    }
  }
} catch (e) { console.error(`ERROR: the Instagram token check failed: ${e.message}\nCreate a new token and update the IG_ACCESS_TOKEN secret (README.md).`); process.exit(1); }
