(function createBranchlyPlatform(global) {
  'use strict';
  const tauri = global.__TAURI__;
  const native = Boolean(tauri?.core?.invoke);

  function authenticationError() {
    const error = new Error('Authentication required');
    error.code = 'AUTHENTICATION_REQUIRED';
    global.dispatchEvent(new CustomEvent('branchly-auth-required'));
    return error;
  }

  function normalizeNativeError(error) {
    if (String(error).includes('AUTHENTICATION_REQUIRED')) return authenticationError();
    return error instanceof Error ? error : new Error(String(error));
  }

  async function invoke(command, args) {
    try { return await tauri.core.invoke(command, args); }
    catch (error) { throw normalizeNativeError(error); }
  }

  async function invokeRaw(command, payload) {
    try { return await tauri.core.invoke(command, payload); }
    catch (error) { throw normalizeNativeError(error); }
  }

  async function webRequest(url, options) {
    const response = await fetch(url, options);
    if (response.status === 401) throw authenticationError();
    if (!response.ok) {
      let detail = {};
      try { detail = await response.json(); } catch {}
      const error = new Error(detail.error || `Request failed (${response.status})`);
      error.status = response.status; error.detail = detail;
      throw error;
    }
    return response;
  }

  function collectImages(document) {
    const images = [];
    (function visit(node) {
      images.push(...(Array.isArray(node.images) ? node.images : []));
      (node.children || []).forEach(visit);
    })(document.root);
    return images;
  }

  async function hydrateNativeImages(document) {
    const images = collectImages(document);
    const files = [...new Set(images.map(image => image.file).filter(Boolean))];
    if (!files.length) return document;
    const paths = await invoke('resolve_image_paths', { files });
    images.forEach(image => { if (paths[image.file]) image._nativePath = paths[image.file]; });
    return document;
  }

  const web = {
    isNative: false,
    async authStatus() { return (await (await fetch('/api/auth')).json()).authenticated; },
    async login(password) {
      const response = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
      const result = await response.json();
      return { ok: response.ok, status: response.status, remaining: result.remaining };
    },
    async logout() { await fetch('/api/logout', { method: 'POST' }); },
    async loadMap() { return (await webRequest('/api/map')).json(); },
    async saveMap(document) { return (await webRequest('/api/map', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(document) })).json(); },
    async saveStatus() { return (await webRequest('/api/save-status')).json(); },
    async storeImage(file) {
      return (await webRequest('/api/images', { method: 'POST', headers: { 'Content-Type': file.type, 'X-File-Name': encodeURIComponent(file.name) }, body: file })).json();
    },
    async deleteImage(file) { await webRequest(`/api/images/${encodeURIComponent(file)}`, { method: 'DELETE' }); },
    imageUrl(image) { return image.url; },
    async hydrateDocument(document) { return document; }
  };

  const nativePlatform = {
    isNative: true,
    authStatus: () => invoke('auth_status'),
    login: password => invoke('login', { password }),
    logout: () => invoke('logout'),
    async loadMap() { return hydrateNativeImages(await invoke('load_map')); },
    saveMap: document => invoke('save_map', { document }),
    saveStatus: () => invoke('save_status'),
    async storeImage(file) {
      const header = new TextEncoder().encode(JSON.stringify({ name: file.name, mime: file.type }));
      const bytes = new Uint8Array(await file.arrayBuffer());
      const payload = new Uint8Array(4 + header.length + bytes.length);
      new DataView(payload.buffer).setUint32(0, header.length, false);
      payload.set(header, 4); payload.set(bytes, 4 + header.length);
      const image = await invokeRaw('store_image_raw', payload);
      const paths = await invoke('resolve_image_paths', { files: [image.file] });
      image._nativePath = paths[image.file];
      return image;
    },
    deleteImage: file => invoke('delete_image', { file }),
    imageUrl(image) { return image._nativePath ? tauri.core.convertFileSrc(image._nativePath) : image.url; },
    hydrateDocument: hydrateNativeImages,
    cloudLogin: (endpoint, email, password) => invoke('cloud_login', { endpoint, email, password }),
    cloudRegister: (endpoint, email, password) => invoke('cloud_register', { endpoint, email, password }),
    cloudLogout: () => invoke('cloud_logout'),
    cloudStatus: () => invoke('cloud_status'),
    syncOnce: () => invoke('sync_once'),
    listConflicts: () => invoke('list_conflicts'),
    resolveConflict: (id, useRemote) => invoke('resolve_conflict', { id, useRemote }),
    exportMap: document => invoke('export_map', { document }),
    storageHealth: () => invoke('storage_health'),
    listSnapshots: () => invoke('list_snapshots'),
    restoreSnapshot: id => invoke('restore_snapshot', { id })
  };

  global.BranchlyPlatform = native ? nativePlatform : web;
})(window);
