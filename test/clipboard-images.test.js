const test = require('node:test');
const assert = require('node:assert/strict');
const clipboard = require('../public/clipboard-images');

const file = (name, type, size = 128, lastModified = 1) => ({ name, type, size, lastModified });

test('clipboard extraction accepts image file items and ignores text items', () => {
  const png = file('image.png', 'image/png');
  const result = clipboard.fromClipboardData({
    items: [
      { kind: 'string', type: 'text/plain', getAsFile: () => null },
      { kind: 'file', type: 'image/png', getAsFile: () => png }
    ],
    files: []
  });
  assert.deepEqual(result, [png]);
});

test('clipboard extraction uses the item MIME when a WebView file omits it', () => {
  const previousFile = global.File;
  class MockFile {
    constructor(parts, name, options) {
      this.parts = parts; this.name = name; this.type = options.type; this.lastModified = options.lastModified;
      this.size = parts[0].size;
    }
  }
  global.File = MockFile;
  try {
    const raw = file('', '', 64);
    const [result] = clipboard.fromClipboardData({
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => raw }], files: []
    });
    assert.equal(result.type, 'image/png');
    assert.equal(result.size, 64);
  } finally {
    if (previousFile === undefined) delete global.File; else global.File = previousFile;
  }
});

test('clipboard extraction falls back to files and removes duplicate image records', () => {
  const png = file('shot.png', 'image/png');
  const text = file('notes.txt', 'text/plain');
  assert.deepEqual(clipboard.fromClipboardData({ items: [], files: [png, png, text] }), [png]);
});

test('distinct clipboard images with identical metadata are both preserved', () => {
  const first = file('image.png', 'image/png');
  const second = file('image.png', 'image/png');
  assert.deepEqual(clipboard.fromClipboardData({ items: [], files: [first, second] }), [first, second]);
});

test('supported clipboard formats match the server and native image stores', () => {
  for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']) {
    assert.equal(clipboard.isSupportedImage(file('x', mime)), true, mime);
  }
  assert.equal(clipboard.isSupportedImage(file('vector.svg', 'image/svg+xml')), false);
  assert.equal(clipboard.isSupportedImage(file('bitmap.bmp', 'image/bmp')), false);
});

test('editable fields retain normal text and image paste behavior', () => {
  assert.equal(clipboard.isEditableTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(clipboard.isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(clipboard.isEditableTarget({ tagName: 'ARTICLE', closest: () => null }), false);
});

test('generic clipboard image names become stable human-readable names', () => {
  class MockFile {
    constructor(parts, name, options) {
      this.parts = parts; this.name = name; this.type = options.type; this.lastModified = options.lastModified;
      this.size = parts[0].size;
    }
  }
  const timestamp = new Date(2026, 7, 5, 9, 8, 7).getTime();
  const [named] = clipboard.giveUsefulNames([file('image.png', 'IMAGE/PNG', 42)], timestamp, MockFile);
  assert.equal(named.name, '剪贴板图片-20260805-090807-01.png');
  assert.equal(named.type, 'image/png');
  assert.equal(named.size, 42);
});

test('explicit clipboard reads choose one supported bitmap representation per clipboard item', async () => {
  class MockFile {
    constructor(parts, name, options) {
      this.parts = parts; this.name = name; this.type = options.type; this.lastModified = options.lastModified;
      this.size = parts[0].size;
    }
  }
  const reads = [];
  const clipboardApi = {
    async read() {
      return [
        { types: ['text/plain', 'image/png'], async getType(type) { reads.push(type); return { size: 77, type }; } },
        { types: ['image/svg+xml'], async getType() { throw new Error('must not read unsupported image'); } }
      ];
    }
  };
  const files = await clipboard.readSystemClipboard(clipboardApi, 1234, MockFile);
  assert.deepEqual(reads, ['image/png']);
  assert.equal(files.length, 1);
  assert.equal(files[0].type, 'image/png');
  assert.equal(files[0].size, 77);
});

test('explicit clipboard reads report unsupported environments without prompting', async () => {
  await assert.rejects(() => clipboard.readSystemClipboard(null), error => error.code === 'CLIPBOARD_READ_UNSUPPORTED');
});
