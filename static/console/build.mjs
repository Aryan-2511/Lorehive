// Bundles the console Custom UI into static/console/build (referenced by manifest.yml).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
const here = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
mkdirSync(`${here}build`, { recursive: true });
await build({ entryPoints: [`${here}src/console.ts`], bundle: true, minify: true, outfile: `${here}build/console.js`, target: 'es2020' });
copyFileSync(`${here}src/index.html`, `${here}build/index.html`);
copyFileSync(`${here}src/console.css`, `${here}build/console.css`);
console.log('console built');
