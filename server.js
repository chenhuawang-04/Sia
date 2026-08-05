const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID, timingSafeEqual } = require('node:crypto');

const PORT = Number(process.env.PORT || 4173);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'mindmap.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const TRASH_DIR = path.join(DATA_DIR, 'image-trash');
const APP_PASSWORD = 'xrune1123459';
const SESSION_TOKEN = randomUUID();
const loginAttempts = new Map();
let mapCache = null;
let mapDirty = false;
let mapRevision = 0;
let lastPersistedAt = null;
let persistInFlight = false;
let skipNextBackup = false;

const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif',
  '.ico': 'image/x-icon'
};

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Resource-Policy': 'same-origin'
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { ...securityHeaders, 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
}

function isAuthorized(req) {
  const token = parseCookies(req).branchly_session || '';
  if (token.length !== SESSION_TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(token), Buffer.from(SESSION_TOKEN));
}

function passwordMatches(value) {
  const submitted = String(value || '');
  if (submitted.length !== APP_PASSWORD.length) return false;
  return timingSafeEqual(Buffer.from(submitted), Buffer.from(APP_PASSWORD));
}

async function ensureMapLoaded() {
  if (mapCache) return mapCache;
  try {
    const primary = JSON.parse(await fs.readFile(DATA_FILE, 'utf8'));
    if (validateDocument(primary)) throw new Error('Primary map failed validation');
    mapCache = primary;
    return mapCache;
  } catch (primaryError) {
    try {
      const backup = JSON.parse(await fs.readFile(`${DATA_FILE}.bak`, 'utf8'));
      if (validateDocument(backup)) throw new Error('Backup map failed validation');
      mapCache = backup;
      mapDirty = true;
      mapRevision += 1;
      skipNextBackup = true;
      console.warn(`Recovered map from backup: ${primaryError.message}`);
      return mapCache;
    } catch {
      throw primaryError;
    }
  }
}

async function persistMap() {
  if (!mapDirty || !mapCache || persistInFlight) return false;
  persistInFlight = true;
  const revision = mapRevision;
  const snapshot = mapCache;
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${DATA_FILE}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    if (!skipNextBackup) {
      try { await fs.copyFile(DATA_FILE, `${DATA_FILE}.bak`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await fs.rename(tmp, DATA_FILE);
    skipNextBackup = false;
    if (mapRevision === revision) mapDirty = false;
    lastPersistedAt = new Date().toISOString();
    return true;
  } finally {
    persistInFlight = false;
  }
}

async function cleanupImageTrash() {
  let entries;
  try { entries = await fs.readdir(TRASH_DIR, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => {
    const file = path.join(TRASH_DIR, entry.name);
    const stat = await fs.stat(file);
    if (stat.mtimeMs < cutoff) await fs.unlink(file);
  }));
}

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 2_000_000) throw Object.assign(new Error('Payload too large'), { statusCode: 413 });
  }
  try { return JSON.parse(raw || '{}'); }
  catch { throw Object.assign(new Error('Invalid JSON'), { statusCode: 400 }); }
}

async function readBuffer(req, limit = 12_000_000) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error('Image is too large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const imageExtensions = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
  'image/gif': '.gif', 'image/avif': '.avif'
};

function hasValidImageSignature(content, mime) {
  if (mime === 'image/jpeg') return content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff;
  if (mime === 'image/png') return content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(content.subarray(0, 6).toString('ascii'));
  if (mime === 'image/webp') return content.subarray(0, 4).toString('ascii') === 'RIFF' && content.subarray(8, 12).toString('ascii') === 'WEBP';
  if (mime === 'image/avif') return content.subarray(4, 8).toString('ascii') === 'ftyp' && content.subarray(8, 32).includes(Buffer.from('avif'));
  return false;
}

function validateDocument(data) {
  if (!data || typeof data !== 'object' || typeof data.title !== 'string' || !data.root) return 'Invalid document';
  if (data.title.length > 160) return 'Title is too long';
  const ids = new Set();
  const annotationIds = new Set();
  const imageIds = new Set();
  let count = 0;
  function validateNode(node, depth) {
    count += 1;
    if (count > 5000) return 'Too many nodes';
    if (depth > 80) return 'Tree is too deep';
    if (!node || typeof node !== 'object' || typeof node.id !== 'string' || !node.id || ids.has(node.id)) return 'Invalid or duplicate node id';
    ids.add(node.id);
    if (typeof node.text !== 'string' || !node.text.trim() || node.text.length > 80) return 'Invalid node title';
    if (node.note != null && (typeof node.note !== 'string' || node.note.length > 240)) return 'Invalid node description';
    if (!Array.isArray(node.children) || node.children.length > 500) return 'Invalid children';
    if (node.images != null) {
      if (!Array.isArray(node.images) || node.images.length > 200) return 'Invalid images';
      for (const image of node.images) {
        if (!image || typeof image.id !== 'string' || !image.id || imageIds.has(image.id) || typeof image.file !== 'string' || !/^[a-f0-9-]+\.(jpg|jpeg|png|webp|gif|avif)$/i.test(image.file)) return 'Invalid image metadata';
        imageIds.add(image.id);
        if (image.url !== `/uploads/${image.file}`) return 'Invalid image URL';
        if (image.sha256 != null && (typeof image.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(image.sha256))) return 'Invalid image hash';
      }
    }
    if (node.annotations != null) {
      if (!Array.isArray(node.annotations) || node.annotations.length > 100) return 'Invalid annotations';
      for (const annotation of node.annotations) {
        if (!annotation || typeof annotation.id !== 'string' || !annotation.id || annotationIds.has(annotation.id)) return 'Invalid or duplicate annotation id';
        annotationIds.add(annotation.id);
        if (typeof annotation.text !== 'string' || !annotation.text.trim() || annotation.text.length > 1000) return 'Invalid annotation text';
      }
    }
    for (const child of node.children) {
      const error = validateNode(child, depth + 1);
      if (error) return error;
    }
    return null;
  }
  const nodeError = validateNode(data.root, 0);
  if (nodeError) return nodeError;
  if (data.relationships != null) {
    if (!Array.isArray(data.relationships) || data.relationships.length > 500) return 'Invalid relationships';
    const relationshipIds = new Set();
    const validTypes = new Set(['bidirectional', 'a-to-b', 'b-to-a', 'undirected']);
    for (const relationship of data.relationships) {
      if (!relationship || typeof relationship.id !== 'string' || !relationship.id || relationshipIds.has(relationship.id)) return 'Invalid or duplicate relationship id';
      relationshipIds.add(relationship.id);
      if (!ids.has(relationship.sourceId) || !ids.has(relationship.targetId) || relationship.sourceId === relationship.targetId) return 'Invalid relationship endpoints';
      if (!validTypes.has(relationship.type)) return 'Invalid relationship type';
      if (typeof relationship.topic !== 'string' || relationship.topic.length > 80) return 'Invalid relationship topic';
      if (relationship.description != null && (typeof relationship.description !== 'string' || relationship.description.length > 500)) return 'Invalid relationship description';
    }
  }
  return null;
}

async function api(req, res, url) {
  if (url.pathname === '/api/auth' && req.method === 'GET') {
    send(res, 200, JSON.stringify({ authenticated: isAuthorized(req) }));
    return true;
  }
  if (url.pathname === '/api/login' && req.method === 'POST') {
    const key = req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(key) || { count: 0, resetAt: now + 60_000 };
    if (now > attempt.resetAt) { attempt.count = 0; attempt.resetAt = now + 60_000; }
    if (attempt.count >= 8) {
      send(res, 429, JSON.stringify({ error: 'Too many attempts' }));
      return true;
    }
    const data = await readBody(req);
    if (!passwordMatches(data.password)) {
      attempt.count += 1; loginAttempts.set(key, attempt);
      send(res, 401, JSON.stringify({ error: 'Invalid password', remaining: Math.max(0, 8 - attempt.count) }));
      return true;
    }
    loginAttempts.delete(key);
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': `branchly_session=${encodeURIComponent(SESSION_TOKEN)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'Set-Cookie': 'branchly_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'
    });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }
  if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) && !isAuthorized(req)) {
    send(res, 401, JSON.stringify({ error: 'Authentication required' }));
    return true;
  }
  if (url.pathname === '/api/save-status' && req.method === 'GET') {
    send(res, 200, JSON.stringify({ pending: mapDirty, lastPersistedAt, intervalMs: 5000 }));
    return true;
  }
  if (url.pathname === '/api/images' && req.method === 'POST') {
    const mime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
    const extension = imageExtensions[mime];
    if (!extension) {
      send(res, 415, JSON.stringify({ error: 'Unsupported image format' }));
      return true;
    }
    const content = await readBuffer(req);
    if (!content.length) {
      send(res, 400, JSON.stringify({ error: 'Empty image' }));
      return true;
    }
    if (!hasValidImageSignature(content, mime)) {
      send(res, 415, JSON.stringify({ error: 'Image content does not match its format' }));
      return true;
    }
    const file = `${randomUUID()}${extension}`;
    const originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'image')).slice(0, 180);
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    await fs.writeFile(path.join(UPLOAD_DIR, file), content);
    send(res, 201, JSON.stringify({
      id: randomUUID(), file, name: originalName, mime, size: content.length,
      sha256: createHash('sha256').update(content).digest('hex'),
      url: `/uploads/${file}`, createdAt: new Date().toISOString()
    }));
    return true;
  }
  if (url.pathname.startsWith('/api/images/') && req.method === 'DELETE') {
    const file = path.basename(decodeURIComponent(url.pathname.slice('/api/images/'.length)));
    if (!file || file.startsWith('.')) {
      send(res, 400, JSON.stringify({ error: 'Invalid image path' }));
      return true;
    }
    await fs.mkdir(TRASH_DIR, { recursive: true });
    try { await fs.rename(path.join(UPLOAD_DIR, file), path.join(TRASH_DIR, file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    send(res, 200, JSON.stringify({ ok: true }));
    return true;
  }
  if (url.pathname !== '/api/map') return false;
  if (req.method === 'GET') {
    try {
      send(res, 200, JSON.stringify(await ensureMapLoaded()));
    } catch (error) {
      if (error.code === 'ENOENT') send(res, 404, JSON.stringify({ error: 'Map not found' }));
      else throw error;
    }
    return true;
  }
  if (req.method === 'PUT') {
    const data = await readBody(req);
    const validationError = validateDocument(data);
    if (validationError) {
      send(res, 400, JSON.stringify({ error: validationError }));
      return true;
    }
    data.updatedAt = new Date().toISOString();
    mapCache = data;
    mapDirty = true;
    mapRevision += 1;
    send(res, 202, JSON.stringify({ ok: true, queued: true, updatedAt: data.updatedAt, persistIntervalMs: 5000 }));
    return true;
  }
  send(res, 405, JSON.stringify({ error: 'Method not allowed' }));
  return true;
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (await api(req, res, url)) return;
    if (url.pathname.startsWith('/uploads/')) {
      const fileName = path.basename(decodeURIComponent(url.pathname.slice('/uploads/'.length)));
      if (!fileName || fileName.startsWith('.')) return send(res, 400, 'Invalid image path', 'text/plain; charset=utf-8');
      const file = path.join(UPLOAD_DIR, fileName);
      let content;
      try { content = await fs.readFile(file); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await fs.mkdir(UPLOAD_DIR, { recursive: true });
        await fs.rename(path.join(TRASH_DIR, fileName), file);
        content = await fs.readFile(file);
      }
      res.writeHead(200, {
        ...securityHeaders,
        'Content-Type': types[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      res.end(content);
      return;
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(PUBLIC_DIR, `.${decodeURIComponent(requested)}`);
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`)) return send(res, 403, 'Forbidden', 'text/plain');
    const content = await fs.readFile(file);
    res.writeHead(200, {
      ...securityHeaders,
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': path.extname(file) === '.html' ? 'no-store' : 'no-cache'
    });
    res.end(content);
  } catch (error) {
    if (error.code === 'ENOENT') return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    if (error.statusCode) return send(res, error.statusCode, JSON.stringify({ error: error.message }));
    console.error(error);
    send(res, 500, JSON.stringify({ error: 'Internal server error' }));
  }
}

const server = http.createServer(handler);
let persistenceTimer = null, trashCleanupTimer = null;

function start() {
  if (!server.listening) server.listen(PORT, '0.0.0.0', () => console.log(`Branchly is ready at http://localhost:${PORT}`));
  if (!persistenceTimer) {
    persistenceTimer = setInterval(() => {
      persistMap().catch(error => console.error('Periodic save failed:', error));
    }, 5000);
    persistenceTimer.unref();
  }
  if (!trashCleanupTimer) {
    trashCleanupTimer = setInterval(() => {
      cleanupImageTrash().catch(error => console.error('Image trash cleanup failed:', error));
    }, 6 * 60 * 60 * 1000);
    trashCleanupTimer.unref();
    cleanupImageTrash().catch(error => console.error('Initial image trash cleanup failed:', error));
  }
  return server;
}

async function shutdown() {
  if (persistenceTimer) clearInterval(persistenceTimer);
  if (trashCleanupTimer) clearInterval(trashCleanupTimer);
  try {
    while (mapDirty) {
      if (persistInFlight) await new Promise(resolve => setTimeout(resolve, 20));
      else await persistMap();
    }
  } catch (error) { console.error('Final save failed:', error); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 3000).unref();
}
if (require.main === module) {
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  start();
}

module.exports = { server, start, persistMap, validateDocument, hasValidImageSignature };
