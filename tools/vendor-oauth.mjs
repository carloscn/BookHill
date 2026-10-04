import { mkdir, copyFile, writeFile } from 'node:fs/promises';
const target = new URL('../src/vendor/oauth4webapi/', import.meta.url);
await mkdir(target, { recursive: true });
await copyFile(new URL('../node_modules/oauth4webapi/build/index.js', import.meta.url), new URL('index.js', target));
await copyFile(new URL('../node_modules/oauth4webapi/build/index.js.map', import.meta.url), new URL('index.js.map', target));
await copyFile(new URL('../node_modules/oauth4webapi/LICENSE.md', import.meta.url), new URL('LICENSE.md', target));
await writeFile(new URL('package.json', target), JSON.stringify({ private: true, type: 'module', version: '3.8.8' }) + '\n');
