#!/usr/bin/env node
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

console.log('Building kitchen-plugin-concierge...\n');

if (fs.existsSync(distDir)) fs.rmSync(distDir, { recursive: true });
for (const sub of ['', 'api', 'chat', 'tabs']) {
  fs.mkdirSync(path.join(distDir, sub), { recursive: true });
}

const esbuildBin = process.platform === 'win32'
  ? `"${path.join(root, 'node_modules', '.bin', 'esbuild.cmd')}"`
  : `"${path.join(root, 'node_modules', '.bin', 'esbuild')}"`;

const externals = [
  '--external:better-sqlite3',
  '--external:drizzle-orm',
  '--external:drizzle-orm/*',
  '--external:crypto',
  '--external:path',
  '--external:fs',
  '--external:os',
  '--external:node:crypto',
].join(' ');

const entries = [
  ['src/index.ts', 'dist/index.js'],
  ['src/api/handler.ts', 'dist/api/handler.js'],
  ['src/chat/stream.ts', 'dist/chat/stream.js'],
];

for (const [from, to] of entries) {
  if (!fs.existsSync(path.join(root, from))) {
    console.log(`- skipping ${from} (not present yet)`);
    continue;
  }
  execSync(
    `${esbuildBin} ${from} --bundle --platform=node --target=node18 --format=cjs --outfile=${to} ${externals}`,
    { cwd: root, stdio: 'inherit' },
  );
  console.log(`✓ Built ${to}`);
}

const tabsDir = path.join(root, 'src/tabs');
if (fs.existsSync(tabsDir)) {
  for (const tabFile of fs.readdirSync(tabsDir).filter((f) => f.endsWith('.tsx'))) {
    const name = tabFile.replace('.tsx', '');
    execSync(
      `${esbuildBin} src/tabs/${tabFile} --bundle --platform=browser --target=es2020 --format=esm --outfile=dist/tabs/${name}.js --external:react --external:react-dom`,
      { cwd: root, stdio: 'inherit' },
    );
    console.log(`✓ Built dist/tabs/${name}.js`);
  }
}

console.log('\nBuild complete.');
