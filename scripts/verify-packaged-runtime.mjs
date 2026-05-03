import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { listPackage } from '@electron/asar';

const roots = process.argv.slice(2);
const searchRoots = roots.length > 0 ? roots : ['pack'];

const requiredFiles = [
  'node_modules/electron-is/package.json',
  'node_modules/deepmerge-ts/package.json',
  'node_modules/@vitalets/google-translate-api/package.json',
  'node_modules/electron-updater/package.json',
  'node_modules/node-html-parser/package.json',
  'node_modules/custom-electron-prompt/package.json',
];

const findAsars = (root) => {
  if (!existsSync(root)) {
    return [];
  }

  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (entry === 'app.asar') {
        found.push(fullPath);
      }
    }
  };

  walk(root);
  return found;
};

const asarPaths = searchRoots.flatMap((root) => findAsars(resolve(root)));

if (asarPaths.length === 0) {
  console.error(
    `No app.asar files found under: ${searchRoots.map((root) => resolve(root)).join(', ')}`,
  );
  process.exit(1);
}

for (const asarPath of asarPaths) {
  const files = new Set(
    listPackage(asarPath).map((file) => file.replace(/^\/+/, '').replaceAll('\\', '/')),
  );
  const missing = requiredFiles.filter((file) => !files.has(file));

  if (missing.length > 0) {
    console.error(`Missing packaged runtime dependencies in ${asarPath}:`);
    for (const file of missing) {
      console.error(`- ${file}`);
    }
    process.exit(1);
  }

  console.log(`Packaged runtime dependencies verified: ${asarPath}`);
}
