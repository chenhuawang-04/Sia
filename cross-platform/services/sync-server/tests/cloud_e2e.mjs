import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

const endpoint = process.env.BRANCHLY_E2E_ENDPOINT || "http://127.0.0.1:18080";

async function request(path, { token, body, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) {
  const response = await fetch(`${endpoint}${path}`, {
    method,
    headers: {
      ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = text;
  if (text && response.headers.get("content-type")?.includes("application/json")) payload = JSON.parse(text);
  return { response, payload };
}

async function expectStatus(path, options, expected) {
  const result = await request(path, options);
  assert.equal(result.response.status, expected, `${options?.method || "GET"} ${path}: ${JSON.stringify(result.payload)}`);
  return result.payload;
}

async function waitUntilReady() {
  let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const result = await request("/health/ready");
      if (result.response.status === 200 && result.payload === "ready") return;
      lastError = new Error(`readiness returned ${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError || new Error("sync service did not become ready");
}

await waitUntilReady();
assert.equal((await expectStatus("/health/live", {}, 200)), "ok");

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
const aliceEmail = `alice-${suffix}@example.test`;
const bobEmail = `bob-${suffix}@example.test`;
const password = "correct horse battery staple";

const aliceInitial = await expectStatus("/v1/auth/register", { body: { email: aliceEmail, password } }, 200);
assert.equal(typeof aliceInitial.accessToken, "string");
assert.equal(typeof aliceInitial.refreshToken, "string");
await expectStatus("/v1/auth/register", { body: { email: aliceEmail, password } }, 409);
await expectStatus("/v1/auth/login", { body: { email: aliceEmail, password: "definitely-wrong" } }, 401);

const aliceLogin = await expectStatus("/v1/auth/login", { body: { email: aliceEmail.toUpperCase(), password } }, 200);
const aliceRotated = await expectStatus("/v1/auth/refresh", { body: { refreshToken: aliceLogin.refreshToken } }, 200);
await expectStatus("/v1/auth/refresh", { body: { refreshToken: aliceLogin.refreshToken } }, 401);

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const hash = createHash("sha256").update(png).digest("hex");
await expectStatus(`/v1/assets/${"0".repeat(64)}`, {
  method: "PUT",
  token: aliceRotated.accessToken,
  headers: { "content-type": "image/png" },
  body: png,
}, 400);
await expectStatus(`/v1/assets/${hash}`, {
  method: "PUT",
  token: aliceRotated.accessToken,
  headers: { "content-type": "image/png" },
  body: png,
}, 201);
const downloaded = await request(`/v1/assets/${hash}`, { token: aliceRotated.accessToken });
assert.equal(downloaded.response.status, 200);
assert.equal(downloaded.response.headers.get("content-type"), "image/png");
assert.deepEqual(new Uint8Array(await (await fetch(`${endpoint}/v1/assets/${hash}`, {
  headers: { authorization: `Bearer ${aliceRotated.accessToken}` },
})).arrayBuffer()), png);

const bob = await expectStatus("/v1/auth/register", { body: { email: bobEmail, password } }, 200);
await expectStatus(`/v1/assets/${hash}`, { token: bob.accessToken }, 404);
await expectStatus("/v1/documents/main", { token: bob.accessToken }, 404);

const document = {
  version: 1,
  title: "端到端同步测试",
  relationships: [],
  root: {
    id: "root",
    text: "云同步",
    note: "+++重点+++",
    color: "violet",
    collapsed: false,
    annotations: [{ id: "annotation-1", text: "补充知识" }],
    images: [{
      id: "image-1",
      file: `${hash}.png`,
      name: "proof.png",
      mime: "image/png",
      size: png.byteLength,
      sha256: hash,
      url: `/uploads/${hash}.png`,
    }],
    children: [{ id: "child", text: "子块", note: "", color: "teal", collapsed: false, images: [], annotations: [], children: [] }],
  },
};

const operationOne = randomUUID();
const envelope = {
  operationId: operationOne,
  documentId: "main",
  deviceId: randomUUID(),
  baseRevision: 0,
  document,
  assetHashes: [hash],
};
const applied = await expectStatus("/v1/documents/main", { method: "PUT", token: aliceRotated.accessToken, body: envelope }, 200);
assert.equal(applied.status, "applied");
assert.equal(applied.revision, 1);

const idempotent = await expectStatus("/v1/documents/main", { method: "PUT", token: aliceRotated.accessToken, body: envelope }, 200);
assert.equal(idempotent.status, "alreadyApplied");
assert.equal(idempotent.revision, 1);

const pulled = await expectStatus("/v1/documents/main", { token: aliceRotated.accessToken }, 200);
assert.equal(pulled.revision, 1);
assert.equal(pulled.document.title, document.title);
assert.deepEqual(pulled.assetHashes, [hash]);

const conflictingDocument = structuredClone(document);
conflictingDocument.title = "离线设备的旧基线编辑";
const conflict = await expectStatus("/v1/documents/main", {
  method: "PUT",
  token: aliceRotated.accessToken,
  body: { ...envelope, operationId: randomUUID(), deviceId: randomUUID(), document: conflictingDocument },
}, 200);
assert.equal(conflict.status, "conflict");
assert.equal(conflict.remote.revision, 1);
assert.equal(conflict.remote.document.title, document.title);

const updatedDocument = structuredClone(document);
updatedDocument.title = "第二版";
const updated = await expectStatus("/v1/documents/main", {
  method: "PUT",
  token: aliceRotated.accessToken,
  body: { ...envelope, operationId: randomUUID(), deviceId: randomUUID(), baseRevision: 1, document: updatedDocument },
}, 200);
assert.equal(updated.status, "applied");
assert.equal(updated.revision, 2);
await expectStatus("/v1/documents/main", { token: bob.accessToken }, 404);

await expectStatus("/v1/auth/logout", { body: { refreshToken: aliceRotated.refreshToken } }, 204);
await expectStatus("/v1/auth/refresh", { body: { refreshToken: aliceRotated.refreshToken } }, 401);

console.log("cloud sync end-to-end scenario passed");
