(function createClipboardImageHelpers(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BranchlyClipboardImages = api;
})(typeof globalThis === 'object' ? globalThis : this, function clipboardImageFactory() {
  'use strict';

  const MIME_EXTENSIONS = Object.freeze({
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif'
  });

  function normalizedMime(file) {
    return String(file?.type || '').split(';', 1)[0].trim().toLowerCase();
  }

  function isImage(file) {
    return normalizedMime(file).startsWith('image/');
  }

  function isSupportedImage(file) {
    return Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, normalizedMime(file));
  }

  function fromClipboardData(clipboardData) {
    if (!clipboardData) return [];
    const itemFiles = Array.from(clipboardData.items || [])
      .filter(item => item?.kind === 'file' && String(item.type || '').toLowerCase().startsWith('image/'))
      .map(item => {
        const file = item.getAsFile?.();
        if (!file || normalizedMime(file) || typeof File !== 'function') return file;
        const mime = String(item.type || '').toLowerCase();
        return new File([file], file.name || clipboardName(0, mime), { type: mime, lastModified: file.lastModified || Date.now() });
      })
      .filter(Boolean);
    const candidates = itemFiles.length ? itemFiles : Array.from(clipboardData.files || []).filter(isImage);
    const seenObjects = new Set();
    return candidates.filter(file => {
      if (!file || seenObjects.has(file)) return false;
      seenObjects.add(file);
      return isImage(file);
    });
  }

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tagName = String(target.tagName || '').toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT') return true;
    return typeof target.closest === 'function' && Boolean(target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'));
  }

  function clipboardName(index, mime, timestamp = Date.now()) {
    const extension = MIME_EXTENSIONS[String(mime || '').toLowerCase()] || 'png';
    const date = new Date(timestamp);
    const part = value => String(value).padStart(2, '0');
    const stamp = Number.isNaN(date.getTime()) ? String(timestamp) : `${date.getFullYear()}${part(date.getMonth() + 1)}${part(date.getDate())}-${part(date.getHours())}${part(date.getMinutes())}${part(date.getSeconds())}`;
    return `剪贴板图片-${stamp}-${String(index + 1).padStart(2, '0')}.${extension}`;
  }

  function giveUsefulNames(files, timestamp = Date.now(), FileConstructor = typeof File === 'function' ? File : null) {
    return files.map((file, index) => {
      if (!FileConstructor || !isSupportedImage(file)) return file;
      const generic = !String(file.name || '').trim() || /^(image|clipboard|pasted-image)(\.[a-z0-9]+)?$/i.test(String(file.name || '').trim());
      if (!generic) return file;
      return new FileConstructor([file], clipboardName(index, normalizedMime(file), timestamp), {
        type: normalizedMime(file),
        lastModified: Number(file.lastModified) || timestamp
      });
    });
  }

  async function readSystemClipboard(clipboard = typeof navigator === 'object' ? navigator.clipboard : null, timestamp = Date.now(), FileConstructor = typeof File === 'function' ? File : null) {
    if (!clipboard || typeof clipboard.read !== 'function') {
      const error = new Error('Clipboard image reading is not supported');
      error.code = 'CLIPBOARD_READ_UNSUPPORTED';
      throw error;
    }
    const clipboardItems = await clipboard.read();
    const files = [];
    for (const item of clipboardItems) {
      const mime = Array.from(item?.types || []).map(type => String(type).toLowerCase())
        .find(type => Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, type));
      if (!mime || typeof item.getType !== 'function') continue;
      const blob = await item.getType(mime);
      if (!blob?.size) continue;
      files.push(FileConstructor
        ? new FileConstructor([blob], clipboardName(files.length, mime, timestamp), { type: mime, lastModified: timestamp })
        : blob);
    }
    return files;
  }

  return Object.freeze({ MIME_EXTENSIONS, normalizedMime, isImage, isSupportedImage, fromClipboardData, isEditableTarget, clipboardName, giveUsefulNames, readSystemClipboard });
});
