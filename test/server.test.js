const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateDocument, hasValidImageSignature, server } = require('../server');

const currentDocument = () => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'mindmap.json'), 'utf8'));

test.after(() => { if (server.listening) server.close(); });

test('current persisted document passes server validation without opening a port', () => {
  assert.equal(server.listening, false);
  assert.equal(validateDocument(currentDocument()), null);
});

test('dangling relationship endpoints are rejected', () => {
  const document = currentDocument();
  document.relationships.push({ id: 'invalid-edge', sourceId: document.root.id, targetId: 'missing', type: 'a-to-b', topic: '', description: '' });
  assert.equal(validateDocument(document), 'Invalid relationship endpoints');
});

test('optional lowercase SHA-256 image metadata is accepted and malformed hashes are rejected', () => {
  const document = currentDocument();
  let image;
  (function visit(node) { image ||= node.images?.[0]; node.children?.forEach(visit); })(document.root);
  if (!image) return;
  image.sha256 = 'a'.repeat(64);
  assert.equal(validateDocument(document), null);
  image.sha256 = '../not-a-hash';
  assert.equal(validateDocument(document), 'Invalid image hash');
});

test('image MIME claims require matching binary signatures', () => {
  assert.equal(hasValidImageSignature(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'image/png'), true);
  assert.equal(hasValidImageSignature(Buffer.from('not a png'), 'image/png'), false);
  assert.equal(hasValidImageSignature(Buffer.from('GIF89a'), 'image/gif'), true);
});
