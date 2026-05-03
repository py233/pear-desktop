import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { extractFile, listPackage } from '@electron/asar';

const roots = process.argv.slice(2);
const searchRoots = roots.length > 0 ? roots : ['pack'];

const requiredFiles = [
  'package.json',
  'node_modules/@jellybrick/mpris-service/package.json',
  'node_modules/electron-is/package.json',
  'node_modules/deepmerge-ts/package.json',
  'node_modules/@vitalets/google-translate-api/package.json',
  'node_modules/electron-updater/package.json',
  'node_modules/electron-localshortcut/package.json',
  'node_modules/electron-is-accelerator/package.json',
  'node_modules/node-html-parser/package.json',
  'node_modules/custom-electron-prompt/package.json',
];

const ignoredPackageNames = new Set([
  // Type-only packages can declare runtime-looking dependencies that are not
  // required by the packaged Electron app.
  '@types/node',
]);

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

const getPackageNameFromPath = (packageJsonPath) => {
  const parts = packageJsonPath.split('/');
  const nodeModulesIndex = parts.lastIndexOf('node_modules');
  if (nodeModulesIndex === -1 || parts.at(-1) !== 'package.json') {
    return null;
  }

  const first = parts[nodeModulesIndex + 1];
  if (!first) {
    return null;
  }

  return first.startsWith('@') ? `${first}/${parts[nodeModulesIndex + 2]}` : first;
};

const getDependencyPackageJsonPath = (fromPackageJsonPath, dependencyName, files) => {
  let currentDir = dirname(fromPackageJsonPath);

  while (currentDir && currentDir !== '.') {
    const candidate = `${currentDir}/node_modules/${dependencyName}/package.json`;
    if (files.has(candidate)) {
      return candidate;
    }

    const parent = dirname(currentDir);
    if (parent === currentDir) {
      break;
    }
    currentDir = parent;
  }

  const rootCandidate = `node_modules/${dependencyName}/package.json`;
  return files.has(rootCandidate) ? rootCandidate : null;
};

const readPackageJson = (asarPath, packageJsonPath) => {
  try {
    return JSON.parse(extractFile(asarPath, packageJsonPath).toString('utf8'));
  } catch {
    return null;
  }
};

const getRuntimeDependencies = (packageJson) => [
  ...Object.keys(packageJson?.dependencies ?? {}),
];

const collectMissingRuntimeDependencies = (asarPath, files) => {
  const rootPackageJson = readPackageJson(asarPath, 'package.json');
  const missingDependencies = [];
  const seenPackageJsonPaths = new Set();

  const visit = (packageJsonPath) => {
    if (seenPackageJsonPaths.has(packageJsonPath)) {
      return;
    }
    seenPackageJsonPaths.add(packageJsonPath);

    const packageJson = readPackageJson(asarPath, packageJsonPath);
    const packageName = packageJson?.name ?? getPackageNameFromPath(packageJsonPath);

    if (packageName && ignoredPackageNames.has(packageName)) {
      return;
    }

    for (const dependencyName of getRuntimeDependencies(packageJson)) {
      const dependencyPackageJsonPath = getDependencyPackageJsonPath(
        packageJsonPath,
        dependencyName,
        files,
      );

      if (!dependencyPackageJsonPath) {
        missingDependencies.push(`${packageName ?? packageJsonPath} -> ${dependencyName}`);
        continue;
      }

      visit(dependencyPackageJsonPath);
    }
  };

  for (const dependencyName of getRuntimeDependencies(rootPackageJson)) {
    const packageJsonPath = getDependencyPackageJsonPath('package.json', dependencyName, files);

    if (!packageJsonPath) {
      missingDependencies.push(`${rootPackageJson?.name ?? 'app'} -> ${dependencyName}`);
      continue;
    }

    visit(packageJsonPath);
  }

  return missingDependencies;
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
    const nodeModuleFiles = [...files].filter((file) => file.startsWith('node_modules/'));

    console.error(`Missing packaged runtime dependencies in ${asarPath}:`);
    for (const file of missing) {
      console.error(`- ${file}`);
    }
    console.error(`app.asar contains ${nodeModuleFiles.length} node_modules entries.`);
    process.exit(1);
  }

  const missingDependencies = collectMissingRuntimeDependencies(asarPath, files);

  if (missingDependencies.length > 0) {
    console.error(`Missing packaged transitive dependencies in ${asarPath}:`);
    for (const dependency of missingDependencies.slice(0, 100)) {
      console.error(`- ${dependency}`);
    }
    if (missingDependencies.length > 100) {
      console.error(`...and ${missingDependencies.length - 100} more`);
    }
    process.exit(1);
  }

  console.log(`Packaged runtime dependencies verified: ${asarPath}`);
}
