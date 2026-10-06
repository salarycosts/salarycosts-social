// Fails the run (so GitHub emails you) when the Instagram token no longer works or is about to expire.
// Env: IG_USER_ID, IG_ACCESS_TOKEN; optional FB_APP_ID + FB_APP_SECRET for the exact expiry date.
const HOST = process.env.IG_API_HOST || 'graph.facebook.com', V = process.env.GRAPH_VERSION || 'v21.0';
const { IG_USER_ID: id, IG_ACCESS_TOKEN: token, FB_APP_ID: app, FB_APP_SECRET: secret } = process.env;
if (!id || !token) { console.error('ERROR: set the IG_USER_ID and IG_ACCESS_TOKEN repository secrets (see README.md).'); process.exit(1); }
try {
  const r = await fetch(`https://${HOST}/${V}/${id}?fields=username&access_token=${encodeURIComponent(token)}`), j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error?.message ?? `HTTP ${r.status}`);
  console.log(`Token works for @${j.username}.`);
  if (app && secret) {
    const d = await (await fetch(`https://${HOST}/${V}/debug_token?input_token=${encodeURIComponent(token)}&access_token=${encodeURIComponent(`${app}|${secret}`)}`)).json();
    const exp = d.data?.data_access_expires_at || d.data?.expires_at;
    if (exp) {
      const days = Math.floor((exp * 1000 - Date.now()) / 86400000);
      console.log(`Token expires in ${days} day(s).`);
      if (days < 10) { console.error(`ERROR: the Instagram token expires in ${days} day(s). Create a new one and update the IG_ACCESS_TOKEN secret (README.md, "Refresh the token").`); process.exit(1); }
    }
  }
} catch (e) { console.error(`ERROR: the Instagram token check failed: ${e.message}\nCreate a new token and update the IG_ACCESS_TOKEN secret (README.md).`); process.exit(1); }
