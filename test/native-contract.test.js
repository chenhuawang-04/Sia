const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('every native platform command is registered by the Tauri invoke handler', () => {
  const platform = read('public/platform.js');
  const lib = read('cross-platform/apps/client/src-tauri/src/lib.rs');
  const invoked = new Set([
    ...[...platform.matchAll(/invoke\('([a-z_]+)'/g)].map(match => match[1]),
    ...[...platform.matchAll(/invokeRaw\('([a-z_]+)'/g)].map(match => match[1]),
  ]);
  const registered = new Set([...lib.matchAll(/commands::([a-z_]+)/g)].map(match => match[1]));
  assert.deepEqual([...invoked].filter(command => !registered.has(command)), []);
});

test('all fixed app ID selectors exist exactly once in the HTML shell', () => {
  const app = read('public/app.js');
  const html = read('public/index.html');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML contains duplicate IDs');
  const selected = new Set([...app.matchAll(/\$\('#([A-Za-z][\w-]*)'\)/g)].map(match => match[1]));
  assert.deepEqual([...selected].filter(id => !ids.includes(id)), []);
});

test('Tauri frontend and seed resource paths resolve inside this checkout', () => {
  const configPath = path.join(root, 'cross-platform/apps/client/src-tauri/tauri.conf.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const directory = path.dirname(configPath);
  assert.equal(path.resolve(directory, config.build.frontendDist), path.join(root, 'public'));
  for (const resource of Object.keys(config.bundle.resources)) {
    assert.equal(fs.existsSync(path.resolve(directory, resource)), true, `missing resource ${resource}`);
  }
});

test('cross-platform workspace declares all implementation crates', () => {
  const manifest = read('cross-platform/Cargo.toml');
  for (const member of ['crates/branchly-core', 'apps/client/src-tauri', 'services/sync-server']) {
    assert.match(manifest, new RegExp(`"${member.replaceAll('/', '\\/')}"`));
    assert.equal(fs.existsSync(path.join(root, 'cross-platform', member, 'Cargo.toml')), true);
  }
});
