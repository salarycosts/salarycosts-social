// Shows what the poster WOULD do right now (the next post, slide order, caption, the next slots). Posts nothing.
// Run: npm run dry-run
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from './publish.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await runOnce({ root, env: { DRY_RUN: '1', FORCE: '1' } }); // FORCE: pretend a slot is due so you can see the next post
