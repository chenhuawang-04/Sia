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

test('clipboard image paste is wired through the shared Web, Windows, and Android frontend', () => {
  const html = read('public/index.html');
  const platform = read('public/platform.js');
  const app = read('public/app.js');
  const clipboardIndex = html.indexOf('<script src="clipboard-images.js"></script>');
  const platformIndex = html.indexOf('<script src="platform.js"></script>');
  const appIndex = html.indexOf('<script src="app.js"></script>');
  assert.ok(clipboardIndex >= 0 && clipboardIndex < platformIndex && platformIndex < appIndex, 'clipboard adapter must load before platform and app');
  assert.equal((platform.match(/clipboardImageFiles: imageFilesFromClipboard/g) || []).length, 2, 'Web and native adapters must expose paste event images');
  assert.equal((platform.match(/readClipboardImageFiles,/g) || []).length, 2, 'Web and native adapters must expose explicit clipboard reads');
  assert.match(app, /document\.addEventListener\('paste', pasteClipboardImages\)/);
  assert.match(app, /uploadImages\(namedFiles, targetId, 'clipboard'\)/);
});

test('native workspace, Tauri bundle, tooling manifest, and lockfile versions stay aligned', () => {
  const workspace = read('cross-platform/Cargo.toml');
  const version = workspace.match(/\[workspace\.package\][\s\S]*?version = "([^"]+)"/)?.[1];
  const tauri = JSON.parse(read('cross-platform/apps/client/src-tauri/tauri.conf.json'));
  const tooling = JSON.parse(read('cross-platform/apps/client/package.json'));
  const lock = read('cross-platform/Cargo.lock');
  assert.equal(version, '2.1.0');
  assert.equal(tauri.version, version);
  assert.equal(tooling.version, version);
  for (const crate of ['branchly-client', 'branchly-core', 'branchly-sync-server']) {
    assert.match(lock, new RegExp(`name = "${crate}"\\nversion = "${version.replaceAll('.', '\\.') }"`));
  }
});
