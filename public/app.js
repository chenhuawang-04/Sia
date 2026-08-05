const $ = (selector) => document.querySelector(selector);
const els = {
  wrap: $('#canvasWrap'), scene: $('#scene'), nodes: $('#nodesLayer'), svg: $('#connections'), grid: $('#canvasGrid'),
  title: $('#titleInput'), sideTitle: $('#sideTitle'), save: $('#saveState'), context: $('#contextMenu'),
  editDialog: $('#editDialog'), editForm: $('#editForm'), nodeText: $('#nodeTextInput'), nodeNote: $('#nodeNoteInput'),
  searchPanel: $('#searchPanel'), searchInput: $('#searchInput'), empty: $('#emptyState'), zoomValue: $('#zoomValue'),
  toast: $('#toast'), miniTree: $('#miniTree'), importInput: $('#importInput'), imageInput: $('#imageInput'),
  imageDialog: $('#imageDialog'), imageGallery: $('#imageGallery'), galleryEmpty: $('#galleryEmpty'),
  previewDialog: $('#previewDialog'), previewImage: $('#previewImage'),
  annotationDialog: $('#annotationDialog'), annotationList: $('#annotationList'), annotationEmpty: $('#annotationEmpty'),
  annotationForm: $('#annotationForm'), annotationInput: $('#annotationInput'), annotationPreview: $('#annotationPreview')
};

const COLORS = ['violet', 'blue', 'teal', 'orange'];
const platform = window.BranchlyPlatform;
window.addEventListener('branchly-auth-required', () => lockApp('登录状态已失效，请重新输入密码'));
const RELATIONSHIP_TYPES = Object.freeze({
  'a-to-b': { symbol: '→', color: '#5f76cf', marker: 'blue' },
  'b-to-a': { symbol: '←', color: '#cb7c51', marker: 'orange' },
  bidirectional: { symbol: '↔', color: '#7b62d1', marker: 'violet' },
  undirected: { symbol: '—', color: '#7d7885', marker: 'gray' }
});
const RELATIONSHIP_MAX_LANES = 16;
// Nested block-view geometry: parents span the full height of their children,
// and every deeper level subdivides the column immediately to its right.
const NODE_W = 190, ROOT_W = 210, NODE_H = 72, ROOT_H = 84;
let doc = null, selectedId = null, editingId = null, searchTerm = '';
let view = { x: 220, y: 180, scale: 1 };
let renderedDepth = Infinity, saveTimer = 0, saveStatusTimer = 0, toastTimer = 0;
let history = [], future = [], dragging = null;
let suppressCanvasClickUntil = 0;
let galleryNodeId = null, uploadTargetId = null, previewImages = [], previewIndex = 0;
let annotationNodeId = null, editingAnnotationId = null;
let reparentSourceId = null;
let relationSourceId = null, relationshipDrag = null, relationLongPressTimer = 0, editingRelationshipId = null;
let relationshipDialogSourceId = null, relationshipDialogTargetId = null;
let lastLayout = null;
let relationshipsVisible = true;

const uid = () => `node-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

function defaultDoc() {
  return {
    version: 1, title: '未命名思维导图', createdAt: new Date().toISOString(),
    relationships: [],
    root: { id: uid(), text: '中心主题', note: '从这里开始梳理想法', color: 'violet', collapsed: false, images: [], annotations: [], children: [] }
  };
}

function validateClientDocument(data) {
  if (!data || typeof data !== 'object' || !data.root || typeof data.title !== 'string' || data.title.length > 160) return false;
  const ids = new Set();
  const annotationIds = new Set();
  const imageIds = new Set();
  let count = 0;
  function validate(node, depth) {
    if (++count > 5000 || depth > 80 || !node || typeof node !== 'object') return false;
    if (typeof node.id !== 'string' || !node.id || ids.has(node.id)) return false;
    ids.add(node.id);
    if (typeof node.text !== 'string' || !node.text.trim() || node.text.length > 80) return false;
    if (node.note != null && (typeof node.note !== 'string' || node.note.length > 240)) return false;
    if (!Array.isArray(node.children) || node.children.length > 500) return false;
    if (node.images != null) {
      if (!Array.isArray(node.images) || node.images.length > 200) return false;
      if (!node.images.every(image => {
        if (!image || typeof image.id !== 'string' || !image.id || imageIds.has(image.id) || typeof image.file !== 'string' || !/^[a-f0-9-]+\.(jpg|jpeg|png|webp|gif|avif)$/i.test(image.file) || image.url !== `/uploads/${image.file}`) return false;
        imageIds.add(image.id); return true;
      })) return false;
      if (!node.images.every(image => image.sha256 == null || typeof image.sha256 === 'string' && /^[a-f0-9]{64}$/.test(image.sha256))) return false;
    }
    if (node.annotations != null) {
      if (!Array.isArray(node.annotations) || node.annotations.length > 100) return false;
      if (!node.annotations.every(annotation => {
        if (!annotation || typeof annotation.id !== 'string' || !annotation.id || annotationIds.has(annotation.id)) return false;
        annotationIds.add(annotation.id);
        return typeof annotation.text === 'string' && Boolean(annotation.text.trim()) && annotation.text.length <= 1000;
      })) return false;
    }
    return node.children.every(child => validate(child, depth + 1));
  }
  if (!validate(data.root, 0)) return false;
  if (data.relationships != null) {
    if (!Array.isArray(data.relationships) || data.relationships.length > 500) return false;
    const relationshipIds = new Set();
    const validTypes = new Set(Object.keys(RELATIONSHIP_TYPES));
    if (!data.relationships.every(relationship => {
      if (!relationship || typeof relationship.id !== 'string' || !relationship.id || relationshipIds.has(relationship.id)) return false;
      relationshipIds.add(relationship.id);
      return ids.has(relationship.sourceId) && ids.has(relationship.targetId) && relationship.sourceId !== relationship.targetId && validTypes.has(relationship.type) && typeof relationship.topic === 'string' && relationship.topic.length <= 80 && (relationship.description == null || typeof relationship.description === 'string' && relationship.description.length <= 500);
    })) return false;
  }
  return true;
}

function lockApp(message = '') {
  if (reparentSourceId) cancelReparent();
  if (relationSourceId) cancelRelationSelection();
  clearTimeout(saveTimer); clearTimeout(saveStatusTimer);
  document.body.className = 'auth-locked';
  $('#authGate').inert = false;
  $('#authGate').setAttribute('aria-hidden', 'false');
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  const error = $('#loginError');
  error.textContent = message;
  error.classList.toggle('hidden', !message);
  $('#passwordInput').value = '';
  requestAnimationFrame(() => $('#passwordInput').focus());
}

function unlockApp() {
  document.body.className = 'auth-ready';
  $('#authGate').inert = true;
  $('#authGate').setAttribute('aria-hidden', 'true');
  $('#loginError').classList.add('hidden');
}

async function authenticateAndLoad() {
  try {
    if (!await platform.authStatus()) return lockApp();
    unlockApp();
    await load();
  } catch { lockApp('暂时无法连接服务器，请稍后重试'); }
}

function walk(node = doc.root, parent = null, depth = 0, list = []) {
  list.push({ node, parent, depth });
  node.children = Array.isArray(node.children) ? node.children : [];
  node.children.forEach(child => walk(child, node, depth + 1, list));
  return list;
}

function find(id) { return walk().find(item => item.node.id === id); }
function parentOf(id) { return find(id)?.parent || null; }
function childIndex(parent, id) { return parent.children.findIndex(child => child.id === id); }

async function load() {
  try {
    doc = await platform.loadMap();
    doc.relationships = Array.isArray(doc.relationships) ? doc.relationships : [];
  } catch (error) {
    if (error.message === 'Authentication required') return;
    doc = defaultDoc();
  }
  selectedId = doc.root.id;
  els.title.value = doc.title;
  els.sideTitle.textContent = doc.title;
  els.save.className = 'save-state persisted';
  els.save.querySelector('span').textContent = '已存档到本机';
  render();
  requestAnimationFrame(() => fitToView(false));
}

function snapshot() { return JSON.stringify(doc); }
function checkpoint() {
  history.push(snapshot());
  if (history.length > 80) history.shift();
  future.length = 0;
  updateHistoryButtons();
}

function restore(raw) {
  doc = JSON.parse(raw);
  if (!find(selectedId)) selectedId = doc.root.id;
  els.title.value = doc.title;
  els.sideTitle.textContent = doc.title;
  render();
  scheduleSave();
}

function undo() {
  if (!history.length) return;
  future.push(snapshot());
  restore(history.pop());
  updateHistoryButtons();
}
function redo() {
  if (!future.length) return;
  history.push(snapshot());
  restore(future.pop());
  updateHistoryButtons();
}
function updateHistoryButtons() {
  $('#undoBtn').disabled = !history.length;
  $('#redoBtn').disabled = !future.length;
}

function scheduleSave() {
  clearTimeout(saveTimer);
  els.save.className = 'save-state saving';
  els.save.querySelector('span').textContent = '保存中…';
  saveTimer = setTimeout(save, 450);
}

async function save() {
  saveTimer = 0;
  try {
    await platform.saveMap(doc);
    els.save.className = platform.isNative ? 'save-state persisted' : 'save-state saving';
    els.save.querySelector('span').textContent = platform.isNative ? '已持久化到本机' : '已同步 · 等待存档';
    clearTimeout(saveStatusTimer);
    saveStatusTimer = setTimeout(checkSaveStatus, 5200);
    if (platform.isNative) setTimeout(() => runCloudSync(false), 80);
  } catch {
    els.save.className = 'save-state error';
    els.save.querySelector('span').textContent = '保存失败';
  }
}

async function checkSaveStatus() {
  try {
    const state = await platform.saveStatus();
    if (state.pending) {
      saveStatusTimer = setTimeout(checkSaveStatus, 1200);
      return;
    }
    els.save.className = 'save-state persisted';
    els.save.querySelector('span').textContent = '已存档到本机';
  } catch (error) {
    if (error.message !== 'Authentication required') {
      els.save.className = 'save-state error';
      els.save.querySelector('span').textContent = '存档状态未知';
    }
  }
}

function semanticDepth() {
  if (view.scale < .48) return 0;
  if (view.scale < .7) return 1;
  if (view.scale < .9) return 2;
  return Infinity;
}

function visibleTree() {
  const maxDepth = searchTerm ? Infinity : semanticDepth();
  const result = [];
  function visit(node, parent, depth) {
    const item = { node, parent, depth, children: [], x: 0, y: 0, h: depth === 0 ? ROOT_H : NODE_H };
    result.push(item);
    if (!node.collapsed && depth < maxDepth) item.children = node.children.map(child => visit(child, item, depth + 1));
    return item;
  }
  return { root: visit(doc.root, null, 0), list: result, maxDepth };
}

function computeLayout(tree) {
  function measure(item) {
    item.children.forEach(measure);
    const ownMinimum = item.depth === 0 ? ROOT_H : NODE_H;
    item.h = item.children.length
      ? Math.max(ownMinimum, item.children.reduce((sum, child) => sum + child.h, 0))
      : ownMinimum;
  }
  function place(item, top = 0) {
    item.x = item.depth === 0 ? 0 : ROOT_W + (item.depth - 1) * NODE_W;
    item.y = top;
    let childTop = top;
    item.children.forEach(child => {
      place(child, childTop);
      childTop += child.h;
    });
  }
  measure(tree.root);
  place(tree.root, 0);
  const items = new Map(tree.list.map(item => [item.node.id, item]));
  const visibleRelationships = relationshipsVisible || searchTerm
    ? (doc.relationships || []).filter(relationship => items.has(relationship.sourceId) && items.has(relationship.targetId))
    : [];
  const relationshipPlans = new Map();
  const verticalGroups = new Map();
  const horizontalGroups = new Map();
  const fallbackRelationships = [];
  const widthOf = item => item.depth === 0 ? ROOT_W : NODE_W;
  const epsilon = .5;

  visibleRelationships.forEach(relationship => {
    const source = items.get(relationship.sourceId), target = items.get(relationship.targetId);
    const top = source.y <= target.y ? source : target;
    const bottom = top === source ? target : source;
    const verticallyAdjacent = source.depth === target.depth && Math.abs(top.y + top.h - bottom.y) < epsilon;
    if (verticallyAdjacent) {
      const key = `y:${Math.round(top.y + top.h)}`;
      if (!verticalGroups.has(key)) verticalGroups.set(key, { cut: top.y + top.h, relationships: [] });
      verticalGroups.get(key).relationships.push({ relationship, topId: top.node.id, bottomId: bottom.node.id });
      return;
    }
    const left = source.x <= target.x ? source : target;
    const right = left === source ? target : source;
    const overlap = Math.min(source.y + source.h, target.y + target.h) - Math.max(source.y, target.y);
    const inAdjacentColumns = Math.abs(source.depth - target.depth) === 1 && Math.abs(left.x + widthOf(left) - right.x) < epsilon;
    if (inAdjacentColumns) {
      const boundaryDepth = Math.min(source.depth, target.depth);
      const key = `x:${boundaryDepth}`;
      if (!horizontalGroups.has(key)) horizontalGroups.set(key, { boundaryDepth, relationships: [] });
      horizontalGroups.get(key).relationships.push({
        relationship, leftId: left.node.id, rightId: right.node.id,
        kind: overlap >= 38 ? 'horizontal-local' : 'horizontal-gutter'
      });
      return;
    }
    fallbackRelationships.push(relationship);
  });

  let accumulatedVerticalGap = 0;
  [...verticalGroups.values()].sort((a, b) => a.cut - b.cut).forEach(group => {
    const currentCut = group.cut + accumulatedVerticalGap;
    const pairTotals = new Map();
    group.relationships.forEach(entry => {
      const key = [entry.topId, entry.bottomId].sort().join('|');
      pairTotals.set(key, (pairTotals.get(key) || 0) + 1);
    });
    const gapHeight = 18 + Math.max(...pairTotals.values()) * 34;
    tree.list.forEach(item => {
      const bottom = item.y + item.h;
      if (item.y >= currentCut - epsilon) item.y += gapHeight;
      else if (item.y < currentCut - epsilon && bottom > currentCut + epsilon) item.h += gapHeight;
    });
    const pairIndexes = new Map();
    group.relationships.forEach(entry => {
      const pairKey = [entry.topId, entry.bottomId].sort().join('|');
      const index = pairIndexes.get(pairKey) || 0;
      pairIndexes.set(pairKey, index + 1);
      relationshipPlans.set(entry.relationship.id, {
      kind: 'vertical-local', topId: entry.topId, bottomId: entry.bottomId,
      gapTop: currentCut, gapHeight, localIndex: index, localCount: pairTotals.get(pairKey)
      });
    });
    accumulatedVerticalGap += gapHeight;
  });

  let accumulatedHorizontalGap = 0;
  [...horizontalGroups.values()].sort((a, b) => a.boundaryDepth - b.boundaryDepth).forEach(group => {
    const baseBoundary = group.boundaryDepth === 0 ? ROOT_W : ROOT_W + group.boundaryDepth * NODE_W;
    const maxDesiredLabel = Math.max(...group.relationships.map(entry => relationshipLabelWidth(entry.relationship)));
    const gapWidth = Math.max(92, Math.min(150, maxDesiredLabel + 18));
    const gapLeft = baseBoundary + accumulatedHorizontalGap;
    tree.list.forEach(item => { if (item.depth > group.boundaryDepth) item.x += gapWidth; });
    const pairTotals = new Map(), pairIndexes = new Map();
    group.relationships.forEach(entry => {
      const key = [entry.leftId, entry.rightId].sort().join('|');
      pairTotals.set(key, (pairTotals.get(key) || 0) + 1);
    });
    group.relationships.forEach(entry => {
      const pairKey = [entry.leftId, entry.rightId].sort().join('|');
      const index = pairIndexes.get(pairKey) || 0;
      pairIndexes.set(pairKey, index + 1);
      relationshipPlans.set(entry.relationship.id, {
        kind: entry.kind, leftId: entry.leftId, rightId: entry.rightId,
        gapLeft, gapWidth, localIndex: index, localCount: pairTotals.get(pairKey)
      });
    });
    accumulatedHorizontalGap += gapWidth;
  });

  const relationshipLanes = Math.min(RELATIONSHIP_MAX_LANES, Math.ceil(fallbackRelationships.length / 2));
  const relationshipMargin = fallbackRelationships.length ? 48 + relationshipLanes * 34 : 0;
  if (relationshipMargin) tree.list.forEach(item => { item.y += relationshipMargin; });
  for (const plan of relationshipPlans.values()) if (plan.kind === 'vertical-local') plan.gapTop += relationshipMargin;
  fallbackRelationships.forEach((relationship, index) => relationshipPlans.set(relationship.id, { kind: 'perimeter', fallbackIndex: index }));

  const contentWidth = Math.max(...tree.list.map(item => item.x + widthOf(item)));
  return {
    width: contentWidth,
    height: tree.root.h + relationshipMargin * 2,
    contentHeight: tree.root.h,
    topMargin: relationshipMargin,
    bottomMargin: relationshipMargin,
    relationshipLanes,
    relationshipPlans
  };
}

function relationshipLabelWidth(relationship) {
  const label = `${relationshipTypeSymbol(relationship.type)} ${relationship.topic || '未命名关系'}`;
  return Math.min(176, Math.max(66, [...label].length * 11 + 22));
}

function renderEmphasis(container, value, emptyText = '') {
  const text = String(value || '');
  container.textContent = '';
  if (!text) {
    container.textContent = emptyText;
    container.classList.toggle('empty', Boolean(emptyText));
    return;
  }
  container.classList.remove('empty');
  const pattern = /\+\+\+([\s\S]+?)\+\+\+/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) container.append(document.createTextNode(text.slice(cursor, match.index)));
    const strong = document.createElement('strong');
    strong.className = 'note-emphasis';
    strong.textContent = match[1];
    container.append(strong);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) container.append(document.createTextNode(text.slice(cursor)));
}

function makeNode(item) {
  const { node, depth, x, y } = item;
  node.images = Array.isArray(node.images) ? node.images : [];
  node.annotations = Array.isArray(node.annotations) ? node.annotations : [];
  const el = document.createElement('article');
  el.draggable = false;
  el.className = `node ${node.color || 'violet'} ${depth === 0 ? 'root' : ''} ${node.id === selectedId ? 'selected' : ''} ${node.collapsed ? 'collapsed' : ''} ${item.h >= 144 ? 'large-block' : ''} ${node.images.length ? 'has-images' : ''} ${node.annotations.length ? 'has-annotations' : ''} ${node.images.length && item.h >= 144 ? 'large-with-images' : ''}`;
  el.dataset.id = node.id;
  el.dataset.search = nodeSearchText(node);
  el.setAttribute('role', 'treeitem');
  el.setAttribute('aria-level', String(depth + 1));
  el.setAttribute('aria-selected', String(node.id === selectedId));
  if (node.children.length) el.setAttribute('aria-expanded', String(!node.collapsed));
  el.style.transform = `translate(${x}px,${y}px)`;
  el.style.height = `${item.h}px`;
  el.innerHTML = `
    <span class="node-accent"></span>
    <div class="node-content"><div class="node-title"></div>${node.note ? '<div class="node-note"></div>' : ''}</div>
    ${node.annotations.length ? `<button class="node-annotation-badge ${item.h >= 144 ? 'corner' : ''}" title="查看 ${node.annotations.length} 条标注"><span>注</span><b>${node.annotations.length}</b></button>` : ''}
    ${node.images.length ? `<button class="node-image-badge ${item.h >= 144 ? 'corner' : ''}" title="查看挂载的 ${node.images.length} 张图片"><span>▧</span><b>${node.images.length}</b></button>` : ''}
    ${node.children.length ? `<span class="child-count" title="折叠或展开">${node.collapsed ? '+' : node.children.length}</span>` : ''}
    <button class="node-add above" data-add="above" title="在上方添加同级">+</button>
    <button class="node-add below" data-add="below" title="在下方添加同级">+</button>
    <button class="node-add child" data-add="child" title="添加子节点">+</button>
    <button class="node-relation-handle" data-relation-handle title="拖到另一个块创建关系；单击后再选择目标">↝</button>`;
  el.querySelector('.node-title').textContent = node.text;
  if (node.note) renderEmphasis(el.querySelector('.node-note'), node.note);
  const term = searchTerm.trim().toLowerCase();
  if (term) {
    const hit = `${node.text} ${node.note || ''}`.toLowerCase().includes(term);
    el.classList.add(hit ? 'search-hit' : 'search-dim');
  }
  return el;
}

function nodeSearchText(node) {
  return `${node.text || ''} ${node.note || ''} ${(node.annotations || []).map(annotation => annotation.text || '').join(' ')}`.toLowerCase();
}

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgElement(name, attributes = {}) {
  const element = document.createElementNS(SVG_NS, name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, value));
  return element;
}

function relationshipTypeSymbol(type) {
  return RELATIONSHIP_TYPES[type]?.symbol || '—';
}

function relationshipColor(type) {
  return RELATIONSHIP_TYPES[type]?.color || '#7d7885';
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function routeVerticalRelationship(relationship, plan, items) {
  const source = items.get(relationship.sourceId), target = items.get(relationship.targetId);
  const top = items.get(plan.topId), bottom = items.get(plan.bottomId);
  const width = top.depth === 0 ? ROOT_W : NODE_W;
  const spread = (plan.localIndex - (plan.localCount - 1) / 2) * 13;
  const x = clamp(top.x + width / 2 + spread, top.x + 25, top.x + width - 25);
  const sy = source === top ? top.y + top.h : bottom.y;
  const ty = source === top ? bottom.y : top.y + top.h;
  const d = `M ${x} ${sy} L ${x} ${ty}`;
  const labelWidth = Math.min(width - 24, relationshipLabelWidth(relationship));
  return {
    d, hitD: d, labelWidth,
    labelX: top.x + (width - labelWidth) / 2,
    labelY: plan.gapTop + 9 + plan.localIndex * 34
  };
}

function routeHorizontalRelationship(relationship, plan, items) {
  const source = items.get(relationship.sourceId), target = items.get(relationship.targetId);
  const left = items.get(plan.leftId), right = items.get(plan.rightId);
  const leftWidth = left.depth === 0 ? ROOT_W : NODE_W;
  const leftX = left.x + leftWidth, rightX = right.x;
  const middleX = plan.gapLeft + plan.gapWidth / 2;
  const spread = (plan.localIndex - (plan.localCount - 1) / 2) * 30;
  const leftY = clamp(right.y + right.h / 2 + spread, left.y + 18, left.y + left.h - 18);
  const rightY = clamp(left.y + left.h / 2 + spread, right.y + 18, right.y + right.h - 18);
  const leftToRight = source === left;
  const sx = leftToRight ? leftX : rightX, sy = leftToRight ? leftY : rightY;
  const tx = leftToRight ? rightX : leftX, ty = leftToRight ? rightY : leftY;
  const d = `M ${sx} ${sy} C ${middleX} ${sy} ${middleX} ${ty} ${tx} ${ty}`;
  const labelWidth = Math.min(plan.gapWidth - 14, relationshipLabelWidth(relationship));
  return {
    d, hitD: d, labelWidth,
    labelX: middleX - labelWidth / 2,
    labelY: (leftY + rightY) / 2 - 14
  };
}

function routePerimeterRelationship(relationship, plan, items, bounds, pairOrdinal) {
  const source = items.get(relationship.sourceId), target = items.get(relationship.targetId);
  const sourceWidth = source.depth === 0 ? ROOT_W : NODE_W;
  const targetWidth = target.depth === 0 ? ROOT_W : NODE_W;
  const index = plan.fallbackIndex;
  const anchorOffset = ((pairOrdinal % 5) - 2) * 4;
  const sourceIsLeft = source.x < target.x || source.x === target.x && index % 2 === 0;
  const sx = sourceIsLeft ? source.x + sourceWidth - 15 + anchorOffset : source.x + 15 + anchorOffset;
  const tx = sourceIsLeft ? target.x + 15 - anchorOffset : target.x + targetWidth - 15 - anchorOffset;
  const bottom = index % 2 === 1;
  const lane = Math.floor(index / 2) % Math.max(1, bounds.relationshipLanes);
  const cycle = Math.min(4, Math.floor(index / (Math.max(1, bounds.relationshipLanes) * 2)));
  const sy = bottom ? source.y + source.h : source.y;
  const ty = bottom ? target.y + target.h : target.y;
  const trackY = bottom
    ? bounds.height - bounds.bottomMargin + 28 + lane * 34 + cycle * 4
    : bounds.topMargin - 28 - lane * 34 - cycle * 4;
  const bend = bottom ? 14 : -14;
  const d = `M ${sx} ${sy} C ${sx} ${sy + bend} ${sx} ${trackY - bend} ${sx} ${trackY} L ${tx} ${trackY} C ${tx} ${trackY + bend} ${tx} ${ty - bend} ${tx} ${ty}`;
  const labelWidth = relationshipLabelWidth(relationship);
  const labelCenterOffset = cycle ? (cycle - 2) * 38 : 0;
  return {
    d,
    hitD: `M ${sx} ${sy} L ${sx} ${trackY} L ${tx} ${trackY} L ${tx} ${ty}`,
    labelWidth,
    labelX: clamp((sx + tx) / 2 - labelWidth / 2 + labelCenterOffset, 2, bounds.width - labelWidth - 2),
    labelY: trackY - 14
  };
}

function renderRelationships(layout) {
  els.svg.innerHTML = '';
  if (!relationshipsVisible && !searchTerm) return;
  const { bounds, items } = layout;
  const relationships = (doc.relationships || []).filter(relationship => items.has(relationship.sourceId) && items.has(relationship.targetId));
  if (!relationships.length) return;
  els.svg.setAttribute('viewBox', `0 0 ${bounds.width} ${bounds.height}`);
  const defs = svgElement('defs');
  for (const [type, color] of Object.entries({ blue: '#5f76cf', orange: '#cb7c51', violet: '#7b62d1', gray: '#7d7885' })) {
    const marker = svgElement('marker', { id: `relation-arrow-${type}`, markerWidth: '9', markerHeight: '9', refX: '7.2', refY: '4.5', orient: 'auto-start-reverse', markerUnits: 'strokeWidth' });
    marker.appendChild(svgElement('path', { d: 'M1,1 L8,4.5 L1,8 Z', fill: color }));
    defs.appendChild(marker);
  }
  els.svg.appendChild(defs);
  const pairCounts = new Map();
  relationships.forEach(relationship => {
    const plan = bounds.relationshipPlans.get(relationship.id);
    if (!plan) return;
    const pairKey = [relationship.sourceId, relationship.targetId].sort().join('|');
    const pairOrdinal = pairCounts.get(pairKey) || 0;
    pairCounts.set(pairKey, pairOrdinal + 1);
    const route = plan.kind === 'vertical-local'
      ? routeVerticalRelationship(relationship, plan, items)
      : plan.kind === 'horizontal-local' || plan.kind === 'horizontal-gutter'
        ? routeHorizontalRelationship(relationship, plan, items)
        : routePerimeterRelationship(relationship, plan, items, bounds, pairOrdinal);
    const group = svgElement('g', { class: `relationship-edge relationship-${relationship.type} route-${plan.kind}`, 'data-relationship-id': relationship.id });
    group.dataset.search = `${relationship.topic || ''} ${relationship.description || ''}`.toLowerCase();
    group.appendChild(svgElement('path', { d: route.d, class: 'relationship-halo' }));
    const path = svgElement('path', { d: route.d, class: 'relationship-path', stroke: relationshipColor(relationship.type) });
    const markerId = `url(#relation-arrow-${RELATIONSHIP_TYPES[relationship.type]?.marker || 'gray'})`;
    if (relationship.type === 'a-to-b' || relationship.type === 'bidirectional') path.setAttribute('marker-end', markerId);
    if (relationship.type === 'b-to-a' || relationship.type === 'bidirectional') path.setAttribute('marker-start', markerId);
    group.appendChild(path);
    const hit = svgElement('path', { d: route.hitD, class: 'relationship-hit' });
    const highlightEndpoints = active => {
      [relationship.sourceId, relationship.targetId].forEach(id => els.nodes.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.toggle('relationship-endpoint-highlight', active));
    };
    const title = svgElement('title');
    title.textContent = `${relationship.topic || '未命名关系'}${relationship.description ? `：${relationship.description}` : ''}`;
    hit.appendChild(title);
    hit.addEventListener('click', event => { event.stopPropagation(); openRelationshipEditor(relationship.id); });
    hit.addEventListener('pointerenter', () => highlightEndpoints(true));
    hit.addEventListener('pointerleave', () => highlightEndpoints(false));
    group.appendChild(hit);
    const labelText = `${relationshipTypeSymbol(relationship.type)} ${relationship.topic || '未命名关系'}`;
    const labelWidth = route.labelWidth;
    const relationshipAriaLabel = `编辑关系：${relationship.topic || '未命名关系'}${relationship.description ? `。${relationship.description}` : ''}`;
    const label = svgElement('g', { class: 'relationship-label', transform: `translate(${route.labelX} ${route.labelY})`, tabindex: '0', role: 'button', 'aria-label': relationshipAriaLabel });
    const labelTitle = svgElement('title');
    labelTitle.textContent = `${relationship.topic || '未命名关系'}${relationship.description ? `：${relationship.description}` : ''}`;
    label.appendChild(labelTitle);
    label.appendChild(svgElement('rect', { width: labelWidth, height: '28', rx: '8' }));
    const text = svgElement('text', { x: labelWidth / 2, y: '18', 'text-anchor': 'middle' });
    const labelCharacterLimit = Math.max(4, Math.floor((labelWidth - 22) / 11));
    text.textContent = labelText.length > labelCharacterLimit ? `${labelText.slice(0, labelCharacterLimit - 1)}…` : labelText;
    label.appendChild(text);
    label.addEventListener('click', event => { event.stopPropagation(); openRelationshipEditor(relationship.id); });
    label.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openRelationshipEditor(relationship.id); } });
    label.addEventListener('pointerenter', () => highlightEndpoints(true));
    label.addEventListener('pointerleave', () => highlightEndpoints(false));
    label.addEventListener('focus', () => highlightEndpoints(true));
    label.addEventListener('blur', () => highlightEndpoints(false));
    group.appendChild(label);
    els.svg.appendChild(group);
  });
}

function render() {
  doc.relationships = Array.isArray(doc.relationships) ? doc.relationships : [];
  const previousRelationshipMargin = lastLayout?.bounds.topMargin || 0;
  const tree = visibleTree();
  const bounds = computeLayout(tree);
  if (lastLayout && previousRelationshipMargin !== bounds.topMargin) view.y += (previousRelationshipMargin - bounds.topMargin) * view.scale;
  lastLayout = { tree, bounds, items: new Map(tree.list.map(item => [item.node.id, item])) };
  els.nodes.innerHTML = '';
  els.svg.innerHTML = '';
  els.scene.style.width = `${bounds.width}px`;
  els.scene.style.height = `${bounds.height}px`;
  els.svg.setAttribute('width', bounds.width);
  els.svg.setAttribute('height', bounds.height);

  const fragment = document.createDocumentFragment();
  for (const item of tree.list) fragment.appendChild(makeNode(item));
  els.nodes.appendChild(fragment);
  renderRelationships(lastLayout);
  renderedDepth = tree.maxDepth;
  updateTransform();
  updateMiniMap(tree, bounds);
  updateHistoryButtons();
  els.empty.classList.toggle('hidden', !searchTerm || tree.list.some(({ node }) => nodeSearchText(node).includes(searchTerm.toLowerCase())));
  if (reparentSourceId) requestAnimationFrame(applyReparentTargets);
  if (relationSourceId) requestAnimationFrame(applyRelationTargets);
  if (searchTerm) applySearch();
}

function updateTransform() {
  els.scene.style.transform = `translate(${view.x}px,${view.y}px) scale(${view.scale})`;
  els.grid.style.transform = `translate(${view.x % 22}px,${view.y % 22}px) scale(${view.scale})`;
  els.zoomValue.textContent = `${Math.round(view.scale * 100)}%`;
}

function updateMiniMap(tree, bounds) {
  const sx = 122 / Math.max(bounds.width, 1), sy = 66 / Math.max(bounds.height, 1), s = Math.min(sx, sy);
  els.miniTree.innerHTML = '';
  const fragment = document.createDocumentFragment();
  tree.list.forEach(item => {
    const mini = document.createElement('i');
    mini.className = `mini-node ${item.depth === 0 ? 'root' : ''}`;
    mini.style.left = `${item.x * s}px`; mini.style.top = `${item.y * s}px`;
    mini.style.width = `${Math.max(5, (item.depth ? NODE_W : ROOT_W) * s)}px`;
    fragment.appendChild(mini);
  });
  els.miniTree.appendChild(fragment);
}

function selectNode(id, focus = true) {
  if (!find(id)) return;
  if (selectedId === id) {
    if (focus) els.wrap.focus({ preventScroll: true });
    return;
  }
  const previous = els.nodes.querySelector('.node.selected');
  previous?.classList.remove('selected');
  previous?.setAttribute('aria-selected', 'false');
  selectedId = id;
  const next = els.nodes.querySelector(`[data-id="${CSS.escape(id)}"]`);
  next?.classList.add('selected');
  next?.setAttribute('aria-selected', 'true');
  if (focus) els.wrap.focus({ preventScroll: true });
}

function newNode(color, text = '新主题') {
  return { id: uid(), text, note: '', color: color || COLORS[Math.floor(Math.random() * COLORS.length)], collapsed: false, images: [], annotations: [], children: [] };
}

function addChild(id = selectedId, edit = true) {
  const found = find(id); if (!found) return;
  checkpoint();
  found.node.collapsed = false;
  const child = newNode(found.node.color);
  found.node.children.push(child);
  selectedId = child.id;
  render(); scheduleSave();
  if (edit) openEditor(child.id, true);
}

function addSibling(position = 'below', id = selectedId, edit = true) {
  const found = find(id); if (!found) return;
  if (!found.parent) {
    addChild(id, edit);
    showToast('中心主题没有同级，已创建子节点');
    return;
  }
  checkpoint();
  const index = childIndex(found.parent, id);
  const sibling = newNode(found.node.color);
  found.parent.children.splice(index + (position === 'below' ? 1 : 0), 0, sibling);
  selectedId = sibling.id;
  render(); scheduleSave();
  if (edit) openEditor(sibling.id, true);
}

function splitVertical(id = selectedId) {
  const found = find(id); if (!found) return;
  checkpoint();
  const rightBlock = newNode(found.node.color, '新的右侧块');
  rightBlock.note = '承接原块的全部子项';
  rightBlock.children = found.node.children;
  found.node.children = [rightBlock];
  found.node.collapsed = false;
  selectedId = rightBlock.id;
  render(); scheduleSave(); openEditor(rightBlock.id, true);
}

function splitHorizontal(id = selectedId) {
  const found = find(id); if (!found) return;
  checkpoint();
  const lowerBlock = newNode(found.node.color, '新的下方块');
  lowerBlock.note = '与上方块属于同一个父块';
  if (found.parent) {
    const index = childIndex(found.parent, id);
    found.parent.children.splice(index + 1, 0, lowerBlock);
  } else {
    const oldRoot = doc.root;
    const commonParent = newNode('violet', '共同父级');
    commonParent.note = '中心块水平切分后自动创建';
    commonParent.children = [oldRoot, lowerBlock];
    doc.root = commonParent;
  }
  selectedId = lowerBlock.id;
  render(); scheduleSave(); openEditor(lowerBlock.id, true);
}

function collectSubtreeIds(node, ids = new Set()) {
  ids.add(node.id);
  (node.children || []).forEach(child => collectSubtreeIds(child, ids));
  return ids;
}

function startReparent(id = selectedId) {
  const found = find(id); if (!found) return;
  if (relationSourceId) cancelRelationSelection();
  if (!found.parent) return showToast('中心块没有外部父级，不能重新归属');
  if (reparentSourceId === id) return cancelReparent();
  if (!els.searchPanel.classList.contains('hidden')) closeSearch();
  reparentSourceId = id;
  document.body.classList.add('reparent-mode');
  document.querySelectorAll('.toolbar button:not(#reparentBtn)').forEach(button => {
    button.dataset.reparentWasDisabled = String(button.disabled);
    button.disabled = true;
  });
  els.context.classList.add('hidden');
  els.wrap.classList.add('reparenting');
  $('#reparentBanner').classList.remove('hidden');
  $('#reparentTitle').textContent = `为“${found.node.text}”选择新的父块`;
  applyReparentTargets();
  els.wrap.focus({ preventScroll: true });
}

function applyReparentTargets() {
  const source = find(reparentSourceId); if (!source) return cancelReparent();
  document.querySelectorAll('.toolbar button:not(#reparentBtn)').forEach(button => {
    if (!('reparentWasDisabled' in button.dataset)) button.dataset.reparentWasDisabled = String(button.disabled);
    button.disabled = true;
  });
  const invalidIds = collectSubtreeIds(source.node);
  if (source.parent) invalidIds.add(source.parent.id);
  els.nodes.querySelectorAll('.node').forEach(element => {
    const isSource = element.dataset.id === reparentSourceId;
    const invalid = invalidIds.has(element.dataset.id);
    element.classList.toggle('reparent-source', isSource);
    element.classList.toggle('reparent-invalid', invalid && !isSource);
    element.classList.toggle('reparent-target', !invalid);
  });
}

function cancelReparent() {
  reparentSourceId = null;
  document.body.classList.remove('reparent-mode');
  document.querySelectorAll('[data-reparent-was-disabled]').forEach(button => {
    button.disabled = button.dataset.reparentWasDisabled === 'true';
    delete button.dataset.reparentWasDisabled;
  });
  els.wrap.classList.remove('reparenting');
  $('#reparentBanner').classList.add('hidden');
  els.nodes.querySelectorAll('.reparent-source,.reparent-invalid,.reparent-target').forEach(element => element.classList.remove('reparent-source', 'reparent-invalid', 'reparent-target'));
}

function completeReparent(targetId) {
  const source = find(reparentSourceId), target = find(targetId);
  if (!source || !source.parent || !target) return cancelReparent();
  const invalidIds = collectSubtreeIds(source.node);
  invalidIds.add(source.parent.id);
  if (invalidIds.has(targetId)) {
    showToast(targetId === source.parent.id ? '这个块已经属于该父块' : '不能归属到自身或自己的后代');
    return;
  }
  if (!confirm(`将“${source.node.text}”及其全部子项重新归属到“${target.node.text}”吗？`)) return;
  checkpoint();
  const movingNode = source.node;
  source.parent.children.splice(childIndex(source.parent, movingNode.id), 1);
  target.node.children.push(movingNode);
  target.node.collapsed = false;
  selectedId = movingNode.id;
  cancelReparent();
  view.scale = Math.max(view.scale, .92);
  render(); scheduleSave();
  requestAnimationFrame(focusSelected);
  showToast('整个子树已重新归属，可使用撤销恢复');
}

function startRelationSelection(id = selectedId) {
  const found = find(id); if (!found) return;
  if (reparentSourceId) cancelReparent();
  if (relationSourceId === id && !relationshipDrag) return cancelRelationSelection();
  if (!els.searchPanel.classList.contains('hidden')) closeSearch();
  relationSourceId = id;
  document.body.classList.add('relation-mode');
  els.wrap.classList.add('selecting-relation');
  $('#relationBanner').classList.remove('hidden');
  $('#relationBannerTitle').textContent = `从“${found.node.text}”连接到…`;
  applyRelationTargets();
  els.wrap.focus({ preventScroll: true });
}

function applyRelationTargets() {
  const source = find(relationSourceId); if (!source) return cancelRelationSelection();
  document.querySelectorAll('.toolbar button:not(#addRelationBtn)').forEach(button => {
    if (!('relationWasDisabled' in button.dataset)) button.dataset.relationWasDisabled = String(button.disabled);
    button.disabled = true;
  });
  els.nodes.querySelectorAll('.node').forEach(element => {
    const isSource = element.dataset.id === relationSourceId;
    element.classList.toggle('relation-source', isSource);
    element.classList.toggle('relation-target', !isSource);
  });
}

function clearRelationTargetStyles() {
  els.nodes.querySelectorAll('.relation-source,.relation-target,.relation-hover-target').forEach(element => element.classList.remove('relation-source', 'relation-target', 'relation-hover-target'));
}

function cancelRelationSelection() {
  clearTimeout(relationLongPressTimer);
  relationLongPressTimer = 0;
  relationSourceId = null;
  document.body.classList.remove('relation-mode', 'relation-drag-mode');
  els.wrap.classList.remove('selecting-relation', 'relation-dragging');
  $('#relationBanner').classList.add('hidden');
  $('#relationDraftOverlay').classList.add('hidden');
  clearRelationTargetStyles();
  document.querySelectorAll('[data-relation-was-disabled]').forEach(button => {
    button.disabled = button.dataset.relationWasDisabled === 'true';
    delete button.dataset.relationWasDisabled;
  });
  relationshipDrag = null;
}

function chooseRelationshipTarget(targetId) {
  const sourceId = relationSourceId;
  if (!sourceId || sourceId === targetId) return showToast('关系必须连接两个不同的块');
  const source = find(sourceId), target = find(targetId);
  if (!source || !target) return cancelRelationSelection();
  cancelRelationSelection();
  openRelationshipDialog(sourceId, targetId);
}

function updateRelationshipDirectionPreview() {
  const type = document.querySelector('input[name="relationshipType"]:checked')?.value || 'a-to-b';
  $('#relationshipDirectionPreview').textContent = relationshipTypeSymbol(type);
}

function openRelationshipDialog(sourceId, targetId, relationship = null) {
  const source = find(sourceId), target = find(targetId);
  if (!source || !target || sourceId === targetId) return;
  relationshipDialogSourceId = sourceId;
  relationshipDialogTargetId = targetId;
  editingRelationshipId = relationship?.id || null;
  $('#relationshipDialogEyebrow').textContent = relationship ? '编辑关系' : '创建关系';
  $('#relationshipSourceName').textContent = source.node.text;
  $('#relationshipTargetName').textContent = target.node.text;
  $('#relationshipTopicInput').value = relationship?.topic || '';
  $('#relationshipDescriptionInput').value = relationship?.description || '';
  const type = relationship?.type || 'a-to-b';
  const radio = document.querySelector(`input[name="relationshipType"][value="${type}"]`);
  if (radio) radio.checked = true;
  $('#deleteRelationshipBtn').classList.toggle('hidden', !relationship);
  updateRelationshipDirectionPreview();
  if (!$('#relationshipDialog').open) $('#relationshipDialog').showModal();
  requestAnimationFrame(() => $('#relationshipTopicInput').focus());
}

function openRelationshipEditor(relationshipId) {
  els.nodes.querySelectorAll('.relationship-endpoint-highlight').forEach(element => element.classList.remove('relationship-endpoint-highlight'));
  const relationship = (doc.relationships || []).find(item => item.id === relationshipId); if (!relationship) return;
  openRelationshipDialog(relationship.sourceId, relationship.targetId, relationship);
}

function saveRelationship(event) {
  event.preventDefault();
  const source = find(relationshipDialogSourceId), target = find(relationshipDialogTargetId);
  if (!source || !target || source.node.id === target.node.id) return showToast('关系端点已经不存在');
  const topic = $('#relationshipTopicInput').value.trim();
  const description = $('#relationshipDescriptionInput').value.trim();
  const type = document.querySelector('input[name="relationshipType"]:checked')?.value || 'a-to-b';
  if (!editingRelationshipId && doc.relationships.length >= 500) return showToast('单个导图最多保存 500 条关系');
  checkpoint();
  if (editingRelationshipId) {
    const relationship = doc.relationships.find(item => item.id === editingRelationshipId);
    if (relationship) Object.assign(relationship, { topic, description, type, updatedAt: new Date().toISOString() });
  } else {
    const now = new Date().toISOString();
    doc.relationships.push({ id: uid(), sourceId: source.node.id, targetId: target.node.id, topic, description, type, createdAt: now, updatedAt: now });
  }
  $('#relationshipDialog').close();
  relationshipsVisible = true;
  $('#toggleRelationsBtn').classList.add('active');
  $('#toggleRelationsBtn').textContent = '◉ 关系边';
  render(); scheduleSave(); showToast(editingRelationshipId ? '关系已更新' : '关系已创建');
  editingRelationshipId = null;
}

function deleteRelationship() {
  const relationship = (doc.relationships || []).find(item => item.id === editingRelationshipId); if (!relationship) return;
  if (!confirm(`删除关系“${relationship.topic || '未命名关系'}”吗？`)) return;
  checkpoint();
  doc.relationships = doc.relationships.filter(item => item.id !== relationship.id);
  $('#relationshipDialog').close();
  editingRelationshipId = null;
  render(); scheduleSave(); showToast('关系已删除，可撤销');
}

function beginRelationshipDrag(sourceId, pointer) {
  if (!find(sourceId) || reparentSourceId) return;
  clearTimeout(relationLongPressTimer);
  relationLongPressTimer = 0;
  dragging = null;
  relationSourceId = sourceId;
  relationshipDrag = {
    pointerId: pointer.pointerId, startX: pointer.clientX, startY: pointer.clientY,
    clientX: pointer.clientX, clientY: pointer.clientY, targetId: null, moved: false
  };
  document.body.classList.add('relation-mode', 'relation-drag-mode');
  els.wrap.classList.remove('dragging');
  els.wrap.classList.add('relation-dragging');
  $('#relationBanner').classList.remove('hidden');
  $('#relationBannerTitle').textContent = `拖到另一个块，建立来自“${find(sourceId).node.text}”的关系`;
  $('#relationDraftOverlay').classList.remove('hidden');
  applyRelationTargets();
  try { els.wrap.setPointerCapture(pointer.pointerId); } catch {}
  updateRelationshipDrag(pointer);
}

function updateRelationshipDrag(pointer) {
  if (!relationshipDrag || relationshipDrag.pointerId !== pointer.pointerId) return;
  relationshipDrag.clientX = pointer.clientX;
  relationshipDrag.clientY = pointer.clientY;
  if (Math.hypot(pointer.clientX - relationshipDrag.startX, pointer.clientY - relationshipDrag.startY) > 4) relationshipDrag.moved = true;
  const element = document.elementFromPoint(pointer.clientX, pointer.clientY);
  const targetNode = element?.closest?.('.node');
  const targetId = targetNode?.dataset.id;
  relationshipDrag.targetId = targetId && targetId !== relationSourceId ? targetId : null;
  els.nodes.querySelector('.relation-hover-target')?.classList.remove('relation-hover-target');
  if (relationshipDrag.targetId) targetNode.classList.add('relation-hover-target');
  const sourceElement = els.nodes.querySelector(`[data-id="${CSS.escape(relationSourceId)}"]`);
  if (!sourceElement) return;
  const sourceRect = sourceElement.getBoundingClientRect(), wrapRect = els.wrap.getBoundingClientRect();
  const sx = sourceRect.left + sourceRect.width / 2 - wrapRect.left;
  const sy = sourceRect.top + sourceRect.height / 2 - wrapRect.top;
  const px = pointer.clientX - wrapRect.left, py = pointer.clientY - wrapRect.top;
  const curve = Math.max(40, Math.abs(px - sx) * .42);
  $('#relationDraftPath').setAttribute('d', `M ${sx} ${sy} C ${sx + curve} ${sy} ${px - curve} ${py} ${px} ${py}`);
  $('#relationDraftDot').setAttribute('cx', px);
  $('#relationDraftDot').setAttribute('cy', py);
}

function finishRelationshipDrag(cancelled = false) {
  if (!relationshipDrag) return;
  const { pointerId, targetId, moved } = relationshipDrag;
  const sourceId = relationSourceId;
  relationshipDrag = null;
  suppressCanvasClickUntil = performance.now() + 250;
  if (els.wrap.hasPointerCapture(pointerId)) els.wrap.releasePointerCapture(pointerId);
  cancelRelationSelection();
  if (!cancelled && targetId) openRelationshipDialog(sourceId, targetId);
  else if (!cancelled && !moved) startRelationSelection(sourceId);
  else if (!cancelled) showToast('未连接到目标块，已取消创建关系');
}

function wrapRoot() {
  checkpoint();
  const oldRoot = doc.root;
  doc.root = newNode('violet', '新的中心主题');
  doc.root.note = '在左侧建立的新分支';
  doc.root.children = [oldRoot];
  selectedId = doc.root.id;
  render(); scheduleSave(); openEditor(selectedId, true);
}

function deleteNode(id = selectedId) {
  const found = find(id); if (!found) return;
  if (!found.parent) { showToast('中心主题不能删除'); return; }
  checkpoint();
  const parent = found.parent;
  const removedIds = collectSubtreeIds(found.node);
  const previousRelationshipCount = (doc.relationships || []).length;
  doc.relationships = (doc.relationships || []).filter(relationship => !removedIds.has(relationship.sourceId) && !removedIds.has(relationship.targetId));
  const removedRelationships = previousRelationshipCount - doc.relationships.length;
  parent.children.splice(childIndex(parent, id), 1);
  selectedId = parent.id;
  render(); scheduleSave(); showToast(`节点已删除${removedRelationships ? `，同时移除 ${removedRelationships} 条关系` : ''}，可撤销`);
}

function changeColor(color) {
  const found = find(selectedId); if (!found) return;
  checkpoint(); found.node.color = color; render(); scheduleSave();
}

function toggleCollapse(id = selectedId) {
  const found = find(id); if (!found || !found.node.children.length) return;
  checkpoint(); found.node.collapsed = !found.node.collapsed; render(); scheduleSave();
}

function openEditor(id = selectedId, selectAll = false) {
  const found = find(id); if (!found) return;
  editingId = id;
  els.nodeText.value = found.node.text;
  els.nodeNote.value = found.node.note || '';
  updateNotePreview();
  els.editDialog.showModal();
  requestAnimationFrame(() => { els.nodeText.focus(); if (selectAll) els.nodeText.select(); });
}

function updateNotePreview() {
  renderEmphasis($('#notePreview'), els.nodeNote.value, '暂无描述');
}

function saveEdit(event) {
  event.preventDefault();
  const found = find(editingId); if (!found) return;
  const value = els.nodeText.value.trim();
  if (!value) { els.nodeText.focus(); return; }
  checkpoint(); found.node.text = value; found.node.note = els.nodeNote.value.trim();
  els.editDialog.close(); editingId = null; render(); scheduleSave();
}

function moveSibling(direction) {
  const found = find(selectedId); if (!found?.parent) return;
  const siblings = found.parent.children, index = childIndex(found.parent, selectedId);
  const next = siblings[index + direction];
  if (next) selectNode(next.id);
}

function navigateSelection(key) {
  const current = find(selectedId); if (!current) return;
  if (key === 'ArrowLeft' && current.parent) selectNode(current.parent.id);
  else if (key === 'ArrowRight' && current.node.children?.length) selectNode(current.node.children[0].id);
  else if (key === 'ArrowUp') moveSibling(-1);
  else if (key === 'ArrowDown') moveSibling(1);
}

function focusSelected(attempt = 0) {
  const el = els.nodes.querySelector(`[data-id="${CSS.escape(selectedId)}"]`);
  if (!el) {
    if (attempt >= 2) return showToast('所选块位于折叠分支中');
    let parent = parentOf(selectedId);
    while (parent) { parent.collapsed = false; parent = parentOf(parent.id); }
    view.scale = Math.max(view.scale, .92);
    render();
    return setTimeout(() => focusSelected(attempt + 1), 0);
  }
  const x = parseFloat(el.style.transform.match(/translate\(([^p]+)/)?.[1] || 0);
  const y = parseFloat(el.style.transform.match(/,([^p]+)/)?.[1] || 0);
  view.x = els.wrap.clientWidth / 2 - (x + el.offsetWidth / 2) * view.scale;
  view.y = els.wrap.clientHeight / 2 - (y + el.offsetHeight / 2) * view.scale;
  updateTransform();
}

function fitToView(animate = true) {
  const w = parseFloat(els.scene.style.width) || 600, h = parseFloat(els.scene.style.height) || 400;
  view.scale = Math.max(.38, Math.min(1.15, (els.wrap.clientWidth - 180) / w, (els.wrap.clientHeight - 150) / h));
  view.x = (els.wrap.clientWidth - w * view.scale) / 2;
  view.y = (els.wrap.clientHeight - h * view.scale) / 2;
  if (animate) els.scene.style.transition = 'transform .3s ease';
  render();
  const finalWidth = parseFloat(els.scene.style.width) || w;
  const finalHeight = parseFloat(els.scene.style.height) || h;
  view.x = (els.wrap.clientWidth - finalWidth * view.scale) / 2;
  view.y = (els.wrap.clientHeight - finalHeight * view.scale) / 2;
  updateTransform();
  setTimeout(() => els.scene.style.transition = '', 320);
}

function setZoom(next, originX = els.wrap.clientWidth / 2, originY = els.wrap.clientHeight / 2) {
  next = Math.max(.3, Math.min(2.2, next));
  const worldX = (originX - view.x) / view.scale, worldY = (originY - view.y) / view.scale;
  view.x = originX - worldX * next; view.y = originY - worldY * next;
  const oldDepth = semanticDepth(); view.scale = next;
  if (semanticDepth() !== renderedDepth || oldDepth !== semanticDepth()) render(); else updateTransform();
}

function showToast(message) {
  clearTimeout(toastTimer); els.toast.textContent = message; els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 2200);
}

function formatAnnotationDate(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) return '刚刚更新';
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function openAnnotations(id = selectedId, startCreating = false) {
  const found = find(id); if (!found) return;
  annotationNodeId = id;
  found.node.annotations = Array.isArray(found.node.annotations) ? found.node.annotations : [];
  $('#annotationDialogTitle').textContent = found.node.text;
  renderAnnotationPanel();
  hideAnnotationComposer();
  if (!els.annotationDialog.open) els.annotationDialog.showModal();
  if (startCreating) requestAnimationFrame(() => showAnnotationComposer());
}

function renderAnnotationPanel() {
  const found = find(annotationNodeId); if (!found) return;
  const annotations = found.node.annotations || [];
  $('#annotationDialogSubtitle').textContent = annotations.length ? `共 ${annotations.length} 条知识标注` : '补充解释、例子、延伸知识和易错点';
  els.annotationList.innerHTML = '';
  els.annotationEmpty.classList.toggle('hidden', annotations.length > 0);
  els.annotationList.classList.toggle('hidden', annotations.length === 0);
  const fragment = document.createDocumentFragment();
  annotations.forEach((annotation, index) => {
    const card = document.createElement('article');
    card.className = 'annotation-card';
    card.innerHTML = `<header><div><span class="annotation-index"></span><time></time></div><div class="annotation-card-actions"><button class="annotation-edit" title="编辑标注">✎</button><button class="annotation-delete" title="删除标注">⌫</button></div></header><div class="annotation-body"></div>`;
    card.querySelector('.annotation-index').textContent = `标注 ${String(index + 1).padStart(2, '0')}`;
    card.querySelector('time').textContent = formatAnnotationDate(annotation.updatedAt || annotation.createdAt);
    renderEmphasis(card.querySelector('.annotation-body'), annotation.text);
    card.querySelector('.annotation-edit').onclick = () => showAnnotationComposer(annotation.id);
    card.querySelector('.annotation-delete').onclick = () => deleteAnnotation(annotation.id);
    fragment.appendChild(card);
  });
  els.annotationList.appendChild(fragment);
}

function showAnnotationComposer(annotationId = null) {
  const found = find(annotationNodeId); if (!found) return;
  if (!annotationId && (found.node.annotations || []).length >= 100) return showToast('每个块最多保存 100 条标注');
  const annotation = annotationId ? (found.node.annotations || []).find(item => item.id === annotationId) : null;
  editingAnnotationId = annotation?.id || null;
  $('#annotationComposerTitle').textContent = annotation ? '编辑标注' : '新建标注';
  els.annotationInput.value = annotation?.text || '';
  els.annotationForm.classList.remove('hidden');
  updateAnnotationPreview();
  requestAnimationFrame(() => els.annotationInput.focus());
}

function hideAnnotationComposer() {
  editingAnnotationId = null;
  els.annotationInput.value = '';
  els.annotationForm.classList.add('hidden');
}

function updateAnnotationPreview() {
  renderEmphasis(els.annotationPreview, els.annotationInput.value, '在这里预览标注效果');
}

function saveAnnotation(event) {
  event.preventDefault();
  const found = find(annotationNodeId); if (!found) return;
  const text = els.annotationInput.value.trim();
  if (!text) { els.annotationInput.focus(); return; }
  const wasEditing = Boolean(editingAnnotationId);
  checkpoint();
  const now = new Date().toISOString();
  if (editingAnnotationId) {
    const annotation = (found.node.annotations || []).find(item => item.id === editingAnnotationId);
    if (annotation) { annotation.text = text; annotation.updatedAt = now; }
  } else {
    found.node.annotations = found.node.annotations || [];
    found.node.annotations.push({ id: uid(), text, createdAt: now, updatedAt: now });
  }
  hideAnnotationComposer();
  render(); renderAnnotationPanel(); scheduleSave();
  showToast(wasEditing ? '标注已更新' : '标注已添加');
}

function deleteAnnotation(annotationId) {
  const found = find(annotationNodeId); if (!found) return;
  const annotation = (found.node.annotations || []).find(item => item.id === annotationId); if (!annotation) return;
  if (!confirm('删除这条标注吗？删除后可以使用撤销恢复。')) return;
  checkpoint();
  found.node.annotations = found.node.annotations.filter(item => item.id !== annotationId);
  hideAnnotationComposer();
  render(); renderAnnotationPanel(); scheduleSave(); showToast('标注已删除，可撤销');
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function openGallery(id = selectedId) {
  const found = find(id); if (!found) return;
  galleryNodeId = id;
  found.node.images = Array.isArray(found.node.images) ? found.node.images : [];
  $('#imageDialogTitle').textContent = found.node.text;
  $('#imageDialogSubtitle').textContent = found.node.images.length ? `共 ${found.node.images.length} 张图片` : '集中查看与管理这个块的图片';
  els.imageGallery.innerHTML = '';
  els.galleryEmpty.classList.toggle('hidden', found.node.images.length > 0);
  els.imageGallery.classList.toggle('hidden', found.node.images.length === 0);
  found.node.images.forEach((image, index) => {
    const card = document.createElement('article');
    card.className = 'gallery-card';
    card.innerHTML = `<button class="gallery-preview" title="查看大图"><img alt=""><span>查看大图</span></button><div class="gallery-meta"><div><strong></strong><small></small></div><button class="gallery-delete" title="移除图片">⌫</button></div>`;
    card.querySelector('img').loading = 'lazy';
    card.querySelector('img').decoding = 'async';
    card.querySelector('img').src = platform.imageUrl(image);
    card.querySelector('img').alt = image.name || '节点图片';
    card.querySelector('strong').textContent = image.name || '未命名图片';
    card.querySelector('small').textContent = formatBytes(image.size);
    card.querySelector('.gallery-preview').onclick = () => openPreview(found.node.images, index);
    card.querySelector('.gallery-delete').onclick = () => removeImage(id, image.id);
    els.imageGallery.appendChild(card);
  });
  if (!els.imageDialog.open) els.imageDialog.showModal();
}

function chooseImages(id = selectedId) {
  if (!find(id)) return;
  uploadTargetId = id;
  els.imageInput.click();
}

async function uploadImages(files) {
  const targetId = uploadTargetId || galleryNodeId || selectedId;
  const found = find(targetId);
  if (!found || !files.length) return;
  const validFiles = [...files].filter(file => file.type.startsWith('image/') && file.size <= 12_000_000);
  if (!validFiles.length) return showToast('请选择不超过 12 MB 的图片文件');
  const skipped = files.length - validFiles.length;
  showToast(`正在上传 ${validFiles.length} 张图片…`);
  const results = new Array(validFiles.length);
  let cursor = 0, failures = 0;
  async function worker() {
    while (cursor < validFiles.length) {
      const index = cursor++, file = validFiles[index];
      try {
        results[index] = await platform.storeImage(file);
      } catch { failures += 1; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(platform.isNative ? 1 : 3, validFiles.length) }, worker));
  const uploaded = results.filter(Boolean);
  if (!uploaded.length) return;
  checkpoint();
  found.node.images = [...(found.node.images || []), ...uploaded];
  render(); scheduleSave();
  if (els.imageDialog.open || galleryNodeId === targetId) openGallery(targetId);
  showToast(`已挂载 ${uploaded.length} 张图片${failures + skipped ? `，${failures + skipped} 张未添加` : ''}`);
}

async function removeImage(nodeId, imageId) {
  const found = find(nodeId); if (!found) return;
  const image = (found.node.images || []).find(item => item.id === imageId); if (!image) return;
  if (!confirm(`从这个块移除“${image.name || '图片'}”吗？`)) return;
  checkpoint();
  found.node.images = found.node.images.filter(item => item.id !== imageId);
  render(); scheduleSave(); openGallery(nodeId);
  try { await platform.deleteImage(image.file); } catch {}
  showToast('图片已移除');
}

function openPreview(images, index) {
  previewImages = images; previewIndex = index;
  updatePreview();
  if (!els.previewDialog.open) els.previewDialog.showModal();
}

function updatePreview() {
  const image = previewImages[previewIndex]; if (!image) return;
  els.previewImage.src = platform.imageUrl(image); els.previewImage.alt = image.name || '图片预览';
  $('#previewName').textContent = `${previewIndex + 1} / ${previewImages.length}　${image.name || '未命名图片'}`;
  $('#previewDownload').href = platform.imageUrl(image); $('#previewDownload').download = image.name || image.file;
  $('#previewPrevious').disabled = previewImages.length < 2;
  $('#previewNext').disabled = previewImages.length < 2;
}

function stepPreview(direction) {
  if (!previewImages.length) return;
  previewIndex = (previewIndex + direction + previewImages.length) % previewImages.length;
  updatePreview();
}

function openSearch() {
  els.searchPanel.classList.remove('hidden'); els.searchInput.focus(); els.searchInput.select();
}

function applySearch() {
  const term = searchTerm.trim().toLowerCase();
  let hits = 0;
  els.nodes.querySelectorAll('.node').forEach(element => {
    const found = !term || String(element.dataset.search || '').includes(term);
    element.classList.toggle('search-hit', Boolean(term && found));
    element.classList.toggle('search-dim', Boolean(term && !found));
    if (term && found) hits += 1;
  });
  els.svg.querySelectorAll('.relationship-edge').forEach(element => {
    const found = !term || String(element.dataset.search || '').includes(term);
    element.classList.toggle('relationship-search-hit', Boolean(term && found));
    element.classList.toggle('relationship-search-dim', Boolean(term && !found));
    if (term && found) hits += 1;
  });
  els.empty.classList.toggle('hidden', !term || hits > 0);
}

function closeSearch() {
  searchTerm = ''; els.searchInput.value = ''; els.searchPanel.classList.add('hidden'); render(); els.wrap.focus();
}

async function exportJson() {
  if (platform.isNative) {
    try { const path = await platform.exportMap(doc); showToast(`已导出到 ${path}`); }
    catch (error) { showToast(`导出失败：${error.message || error}`); }
    return;
  }
  const blob = new Blob([`${JSON.stringify(doc, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = `${doc.title || 'mindmap'}.json`; a.click(); URL.revokeObjectURL(url);
  showToast('JSON 文件已导出');
}

let cloudSyncTimer = 0;
let cloudSyncInFlight = false;
async function refreshCloudDialog() {
  if (!platform.isNative) return;
  try {
    const state = await platform.cloudStatus();
    $('#cloudSignedOut').classList.toggle('hidden', state.configured);
    $('#cloudSignedIn').classList.toggle('hidden', !state.configured);
    if (state.configured) {
      $('#cloudAccount').textContent = state.account || '已登录';
      $('#cloudServer').textContent = state.endpoint || '';
      $('#cloudPending').textContent = state.pendingOperations;
      $('#cloudConflicts').textContent = state.unresolvedConflicts;
      const list = $('#cloudConflictList'); list.innerHTML = '';
      const conflicts = await platform.listConflicts();
      list.classList.toggle('hidden', !conflicts.length);
      conflicts.forEach(conflict => {
        const row = document.createElement('div'); row.className = 'cloud-conflict';
        row.innerHTML = '<div><strong></strong><small></small></div><button data-choice="local">保留本机</button><button data-choice="remote">采用云端</button>';
        row.querySelector('strong').textContent = `${conflict.localTitle} ↔ ${conflict.remoteTitle}`;
        row.querySelector('small').textContent = `远端版本 ${conflict.remoteRevision} · ${new Date(conflict.createdAt).toLocaleString()}`;
        row.querySelector('[data-choice="local"]').onclick = async () => { await platform.resolveConflict(conflict.id, false); await refreshCloudDialog(); };
        row.querySelector('[data-choice="remote"]').onclick = async () => {
          if (!confirm('采用云端副本会替换当前画布；当前内容仍保留在本地快照中。确定继续吗？')) return;
          await platform.resolveConflict(conflict.id, true); await load(); await refreshCloudDialog();
        };
        list.appendChild(row);
      });
    }
  } catch {}
}

async function runCloudSync(manual = false) {
  if (!platform.isNative || saveTimer || !doc || cloudSyncInFlight) return;
  const dialog = $('#cloudDialog');
  cloudSyncInFlight = true;
  try {
    const status = await platform.cloudStatus();
    if (!status.configured) return;
    dialog.classList.add('syncing'); $('#cloudSyncState').textContent = '同步中…';
    let outcome = await platform.syncOnce();
    if (outcome.state === 'queued') outcome = await platform.syncOnce();
    const labels = { pushed: '已上传', pulled: '已更新', queued: '等待上传', idle: '已是最新', 'conflict-preserved': '冲突已保留' };
    $('#cloudSyncState').textContent = labels[outcome.state] || '完成';
    if (outcome.changedLocalDocument) await load();
    await refreshCloudDialog();
    if (manual) showToast(labels[outcome.state] || '同步完成');
  } catch (error) {
    $('#cloudSyncState').textContent = '等待重试';
    if (manual) showToast(`同步暂不可用：${error.message || error}`);
  } finally { cloudSyncInFlight = false; dialog.classList.remove('syncing'); }
}

function startCloudSyncLoop() {
  if (!platform.isNative || cloudSyncTimer) return;
  cloudSyncTimer = setInterval(() => { if (!document.hidden) runCloudSync(false); }, 15_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) runCloudSync(false); });
  window.addEventListener('online', () => runCloudSync(false));
}

async function openStorageDialog() {
  const dialog = $('#storageDialog'), list = $('#snapshotList');
  dialog.showModal(); list.innerHTML = '';
  try {
    const [health, snapshots] = await Promise.all([platform.storageHealth(), platform.listSnapshots()]);
    $('.storage-health')?.classList.toggle('error', !health.ok);
    $('#storageHealthIcon').textContent = health.ok ? '✓' : '!';
    $('#storageHealthText').textContent = health.ok ? '本地数据库状态正常' : `数据库检查异常：${health.quickCheck}`;
    $('#storagePath').textContent = health.databasePath;
    $('#snapshotEmpty').classList.toggle('hidden', snapshots.length > 0);
    snapshots.forEach(snapshot => {
      const row = document.createElement('div'); row.className = 'snapshot-row';
      row.innerHTML = '<div><strong></strong><small></small></div><button type="button">恢复</button>';
      row.querySelector('strong').textContent = snapshot.title;
      row.querySelector('small').textContent = `版本 ${snapshot.localRevision} · ${new Date(snapshot.createdAt).toLocaleString()}`;
      row.querySelector('button').onclick = async () => {
        if (!confirm('恢复这个版本吗？当前版本会先自动建立一个新的恢复点。')) return;
        await platform.restoreSnapshot(snapshot.id); await load(); dialog.close(); showToast('已恢复所选版本');
      };
      list.appendChild(row);
    });
  } catch (error) { $('#storageHealthText').textContent = `检查失败：${error.message || error}`; $('.storage-health')?.classList.add('error'); }
}

function bind() {
  $('#loginForm').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('#loginSubmit'), error = $('#loginError');
    submit.disabled = true; submit.querySelector('span').textContent = '正在验证…';
    error.classList.add('hidden');
    try {
      const result = await platform.login($('#passwordInput').value);
      if (!result.ok) {
        error.textContent = result.status === 429 || result.retryAfterSeconds ? '尝试次数过多，请一分钟后再试' : `密码不正确${Number.isFinite(result.remaining) ? `，还可尝试 ${result.remaining} 次` : ''}`;
        error.classList.remove('hidden'); $('#passwordInput').select();
        return;
      }
      unlockApp();
      await load();
      if (platform.isNative) setTimeout(() => runCloudSync(false), 100);
    } catch {
      error.textContent = '无法连接服务器，请检查服务是否正在运行'; error.classList.remove('hidden');
    } finally {
      submit.disabled = false; submit.querySelector('span').textContent = '进入工作空间';
    }
  });
  $('#togglePassword').onclick = () => {
    const input = $('#passwordInput');
    input.type = input.type === 'password' ? 'text' : 'password'; input.focus();
  };
  $('#logoutBtn').onclick = async () => {
    try { await platform.logout(); } catch {}
    doc = null; selectedId = null; history = []; future = [];
    lockApp('已安全退出工作空间');
  };
  els.nodes.addEventListener('pointerdown', event => {
    const handle = event.target.closest('[data-relation-handle]');
    if (!handle || event.button !== 0) return;
    const node = handle.closest('.node'); if (!node) return;
    event.preventDefault(); event.stopPropagation();
    selectNode(node.dataset.id, false);
    beginRelationshipDrag(node.dataset.id, event);
  });
  els.nodes.addEventListener('click', event => {
    if (performance.now() < suppressCanvasClickUntil) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    const add = event.target.closest('[data-add]'), imageBadge = event.target.closest('.node-image-badge'), annotationBadge = event.target.closest('.node-annotation-badge'), nodeEl = event.target.closest('.node');
    if (!nodeEl) return;
    const id = nodeEl.dataset.id;
    if (reparentSourceId) {
      event.preventDefault(); event.stopPropagation(); completeReparent(id); return;
    }
    if (relationSourceId) {
      event.preventDefault(); event.stopPropagation(); chooseRelationshipTarget(id); return;
    }
    if (annotationBadge) {
      event.stopPropagation(); selectNode(id, false); openAnnotations(id);
    } else if (imageBadge) {
      event.stopPropagation(); selectNode(id, false); openGallery(id);
    } else if (add) {
      event.stopPropagation();
      if (add.dataset.add === 'child') addChild(id);
      else addSibling(add.dataset.add, id);
    } else if (event.target.closest('.child-count')) { selectNode(id, false); toggleCollapse(id); }
    else selectNode(id);
  });
  els.nodes.addEventListener('dblclick', event => {
    if (performance.now() < suppressCanvasClickUntil) return;
    if (event.target.closest('button,.child-count')) return;
    const node = event.target.closest('.node'); if (node) openEditor(node.dataset.id);
  });
  els.nodes.addEventListener('contextmenu', event => {
    const node = event.target.closest('.node'); if (!node) return;
    if (relationshipDrag || relationSourceId || reparentSourceId) { event.preventDefault(); return; }
    event.preventDefault(); selectNode(node.dataset.id, false);
    els.context.classList.remove('hidden');
    const menuWidth = els.context.offsetWidth, menuHeight = els.context.offsetHeight;
    els.context.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - menuWidth - 8))}px`;
    els.context.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - menuHeight - 8))}px`;
  });
  els.context.addEventListener('click', event => {
    const action = event.target.closest('[data-action]')?.dataset.action; if (!action) return;
    els.context.classList.add('hidden');
    ({ edit: () => openEditor(), child: () => addChild(), above: () => addSibling('above'), below: () => addSibling('below'), 'vertical-split': () => splitVertical(), 'horizontal-split': () => splitHorizontal(), reparent: () => startReparent(), 'add-relation': () => startRelationSelection(), collapse: () => toggleCollapse(), annotations: () => openAnnotations(), images: () => openGallery(), delete: () => deleteNode() })[action]?.();
  });
  document.addEventListener('pointerdown', event => { if (!event.target.closest('#contextMenu')) els.context.classList.add('hidden'); });
  els.editForm.addEventListener('submit', saveEdit);
  $('#closeEditDialog').onclick = () => els.editDialog.close();
  $('#cancelEditBtn').onclick = () => els.editDialog.close();
  els.nodeNote.addEventListener('input', updateNotePreview);
  els.editForm.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); els.editForm.requestSubmit($('#saveNodeBtn'));
    }
  });
  els.title.addEventListener('change', () => { const value = els.title.value.trim() || '未命名思维导图'; checkpoint(); doc.title = value; els.title.value = value; els.sideTitle.textContent = value; scheduleSave(); });

  $('#addChildBtn').onclick = () => addChild(); $('#addSiblingBtn').onclick = () => addSibling();
  $('#editBtn').onclick = () => openEditor(); $('#addAnnotationBtn').onclick = () => openAnnotations(selectedId, true); $('#addImageBtn').onclick = () => chooseImages(); $('#deleteBtn').onclick = () => deleteNode();
  $('#verticalSplitBtn').onclick = () => splitVertical();
  $('#horizontalSplitBtn').onclick = () => splitHorizontal();
  $('#reparentBtn').onclick = () => startReparent();
  $('#cancelReparentBtn').onclick = cancelReparent;
  $('#addRelationBtn').onclick = () => startRelationSelection();
  $('#toggleRelationsBtn').onclick = () => {
    relationshipsVisible = !relationshipsVisible;
    $('#toggleRelationsBtn').classList.toggle('active', relationshipsVisible);
    $('#toggleRelationsBtn').textContent = relationshipsVisible ? '◉ 关系边' : '○ 关系边';
    render(); showToast(relationshipsVisible ? '已显示关系边' : '已隐藏关系边');
  };
  $('#cancelRelationBtn').onclick = cancelRelationSelection;
  $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
  document.querySelectorAll('[data-color]').forEach(button => button.onclick = () => changeColor(button.dataset.color));
  $('#focusBtn').onclick = focusSelected; $('#autoLayoutBtn').onclick = () => fitToView();
  $('#fitBtn').onclick = () => fitToView(); $('#zoomIn').onclick = () => setZoom(view.scale + .12); $('#zoomOut').onclick = () => setZoom(view.scale - .12);
  $('#zoomValue').onclick = () => setZoom(1); $('#searchBtn').onclick = openSearch;
  els.searchInput.addEventListener('input', () => {
    const hadTerm = Boolean(searchTerm);
    searchTerm = els.searchInput.value.trim();
    if (hadTerm !== Boolean(searchTerm)) render(); else applySearch();
  });
  els.searchInput.addEventListener('keydown', event => {
    if (event.key !== 'Enter') return;
    const hit = els.nodes.querySelector('.node.search-hit');
    const relationshipHit = els.svg.querySelector('.relationship-edge.relationship-search-hit');
    if (!hit && !relationshipHit) return;
    event.preventDefault();
    if (!hit && relationshipHit) {
      const relationshipId = relationshipHit.dataset.relationshipId;
      searchTerm = ''; els.searchInput.value = ''; els.searchPanel.classList.add('hidden'); render();
      return requestAnimationFrame(() => openRelationshipEditor(relationshipId));
    }
    selectedId = hit.dataset.id;
    searchTerm = ''; els.searchInput.value = ''; els.searchPanel.classList.add('hidden');
    view.scale = Math.max(view.scale, .92);
    render(); requestAnimationFrame(focusSelected);
  });
  $('#helpBtn').onclick = () => $('#helpDialog').showModal();
  $('#closeHelpDialog').onclick = () => $('#helpDialog').close();
  $('#relationshipForm').addEventListener('submit', saveRelationship);
  $('#relationshipForm').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); $('#relationshipForm').requestSubmit($('#saveRelationshipBtn'));
    }
  });
  $('#closeRelationshipDialog').onclick = () => $('#relationshipDialog').close();
  $('#cancelRelationshipDialog').onclick = () => $('#relationshipDialog').close();
  $('#deleteRelationshipBtn').onclick = deleteRelationship;
  document.querySelectorAll('input[name="relationshipType"]').forEach(input => input.addEventListener('change', updateRelationshipDirectionPreview));
  $('#newAnnotationBtn').onclick = () => showAnnotationComposer();
  $('#emptyAnnotationBtn').onclick = () => showAnnotationComposer();
  $('#cancelAnnotationBtn').onclick = hideAnnotationComposer;
  $('#closeAnnotationDialog').onclick = () => els.annotationDialog.close();
  els.annotationInput.addEventListener('input', updateAnnotationPreview);
  els.annotationForm.addEventListener('submit', saveAnnotation);
  els.annotationForm.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault(); els.annotationForm.requestSubmit($('#saveAnnotationBtn'));
    } else if (event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation(); hideAnnotationComposer();
    }
  });
  $('#galleryUploadBtn').onclick = () => chooseImages(galleryNodeId);
  $('#emptyUploadBtn').onclick = () => chooseImages(galleryNodeId);
  $('#closeImageDialog').onclick = () => els.imageDialog.close();
  $('#closePreview').onclick = () => els.previewDialog.close();
  $('#previewPrevious').onclick = () => stepPreview(-1);
  $('#previewNext').onclick = () => stepPreview(1);
  els.imageInput.addEventListener('change', async () => {
    const files = [...els.imageInput.files];
    els.imageInput.value = '';
    await uploadImages(files);
    uploadTargetId = null;
  });
  $('#menuBtn').onclick = () => $('#sidebar').classList.toggle('open');
  $('#exportBtn').onclick = exportJson;
  $('#importBtn').onclick = () => els.importInput.click();
  els.importInput.addEventListener('change', async () => {
    const file = els.importInput.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      imported.title = typeof imported.title === 'string' && imported.title.trim() ? imported.title.trim() : '导入的思维导图';
      if (!validateClientDocument(imported)) throw new Error('invalid');
      checkpoint(); doc = imported; selectedId = doc.root.id;
      els.title.value = doc.title || '导入的思维导图'; els.sideTitle.textContent = els.title.value;
      render(); fitToView(); scheduleSave(); showToast('导图已成功导入');
    } catch { showToast('无法导入：JSON 导图格式不正确'); }
    els.importInput.value = '';
  });
  if (platform.isNative) {
    $('#storageBtn').classList.remove('hidden'); $('#storageBtn').onclick = openStorageDialog;
    $('#closeStorageDialog').onclick = () => $('#storageDialog').close();
    $('#storageExportBtn').onclick = exportJson;
    $('#shareBtn').textContent = '云同步';
    $('#shareBtn').onclick = async () => { await refreshCloudDialog(); $('#cloudDialog').showModal(); };
    $('#closeCloudDialog').onclick = () => $('#cloudDialog').close();
    $('#cloudLoginForm').addEventListener('submit', async event => {
      event.preventDefault(); const button = $('#cloudLoginBtn'), error = $('#cloudError');
      button.disabled = true; error.classList.add('hidden');
      try {
        await platform.cloudLogin($('#cloudEndpoint').value, $('#cloudEmail').value, $('#cloudPassword').value);
        $('#cloudPassword').value = ''; await refreshCloudDialog(); await runCloudSync(true); startCloudSyncLoop();
      } catch (failure) { error.textContent = failure.message || String(failure); error.classList.remove('hidden'); }
      finally { button.disabled = false; }
    });
    $('#cloudRegisterBtn').onclick = async () => {
      const button = $('#cloudRegisterBtn'), error = $('#cloudError'); button.disabled = true; error.classList.add('hidden');
      try {
        await platform.cloudRegister($('#cloudEndpoint').value, $('#cloudEmail').value, $('#cloudPassword').value);
        $('#cloudPassword').value = ''; await refreshCloudDialog(); await runCloudSync(true); startCloudSyncLoop();
      } catch (failure) { error.textContent = failure.message || String(failure); error.classList.remove('hidden'); }
      finally { button.disabled = false; }
    };
    $('#cloudSyncBtn').onclick = () => runCloudSync(true);
    $('#cloudLogoutBtn').onclick = async () => { await platform.cloudLogout(); await refreshCloudDialog(); };
    startCloudSyncLoop();
  } else {
    $('#shareBtn').onclick = async () => {
      try { await navigator.clipboard.writeText(location.href); showToast('导图链接已复制'); }
      catch { showToast('当前地址即为分享链接'); }
    };
  }
  $('#newMapBtn').onclick = () => {
    if (reparentSourceId) cancelReparent();
    if (relationSourceId) cancelRelationSelection();
    if (!confirm('新建导图会替换当前内容，确定继续吗？')) return;
    checkpoint(); doc = defaultDoc(); selectedId = doc.root.id; els.title.value = doc.title; els.sideTitle.textContent = doc.title; render(); fitToView(); scheduleSave(); openEditor(selectedId, true);
  };

  els.wrap.addEventListener('wheel', event => {
    event.preventDefault();
    const rect = els.wrap.getBoundingClientRect();
    setZoom(view.scale * Math.exp(-event.deltaY * .0012), event.clientX - rect.left, event.clientY - rect.top);
    if (relationshipDrag) requestAnimationFrame(() => relationshipDrag && updateRelationshipDrag(relationshipDrag));
  }, { passive: false });
  const panInteractiveSelector = 'button,input,textarea,select,a,.zoom-control,.search-panel,.reparent-banner';
  els.wrap.addEventListener('dragstart', event => event.preventDefault());
  els.wrap.addEventListener('click', event => {
    if (performance.now() < suppressCanvasClickUntil) {
      event.preventDefault(); event.stopImmediatePropagation();
    }
  }, true);
  els.wrap.addEventListener('pointerdown', event => {
    if (dragging || event.button !== 0 || event.target.closest(panInteractiveSelector)) return;
    dragging = {
      pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      originX: view.x, originY: view.y, active: false
    };
    const node = event.target.closest('.node');
    if (!relationSourceId && !reparentSourceId && node?.dataset.id === selectedId) {
      relationLongPressTimer = setTimeout(() => {
        if (dragging && !dragging.active && dragging.pointerId === event.pointerId) beginRelationshipDrag(selectedId, { pointerId: dragging.pointerId, clientX: dragging.startX, clientY: dragging.startY });
      }, 480);
    }
  });
  els.wrap.addEventListener('pointermove', event => {
    if (relationshipDrag) { event.preventDefault(); updateRelationshipDrag(event); return; }
    if (!dragging || dragging.pointerId !== event.pointerId) return;
    const dx = event.clientX - dragging.startX, dy = event.clientY - dragging.startY;
    if (!dragging.active) {
      const threshold = event.pointerType === 'touch' ? 8 : 5;
      if (Math.hypot(dx, dy) < threshold) return;
      clearTimeout(relationLongPressTimer); relationLongPressTimer = 0;
      dragging.active = true;
      els.wrap.classList.add('dragging');
      els.wrap.setPointerCapture(event.pointerId);
      window.getSelection()?.removeAllRanges();
    }
    event.preventDefault();
    view.x = dragging.originX + dx; view.y = dragging.originY + dy;
    updateTransform();
  });
  const stopDragging = event => {
    if (relationshipDrag) { finishRelationshipDrag(event?.type !== 'pointerup'); return; }
    if (!dragging || (event?.pointerId != null && dragging.pointerId !== event.pointerId)) return;
    clearTimeout(relationLongPressTimer); relationLongPressTimer = 0;
    const wasActive = dragging.active, pointerId = dragging.pointerId;
    dragging = null;
    els.wrap.classList.remove('dragging');
    if (wasActive) {
      suppressCanvasClickUntil = performance.now() + 250;
      event?.preventDefault();
    }
    if (els.wrap.hasPointerCapture(pointerId)) els.wrap.releasePointerCapture(pointerId);
  };
  els.wrap.addEventListener('pointerup', stopDragging);
  els.wrap.addEventListener('pointercancel', stopDragging);
  els.wrap.addEventListener('lostpointercapture', stopDragging);
  els.wrap.addEventListener('pointerleave', event => { if (dragging && !dragging.active) stopDragging(event); });
  window.addEventListener('blur', () => stopDragging());

  document.addEventListener('keydown', event => {
    if (relationSourceId) {
      if (event.key === 'Escape') { event.preventDefault(); relationshipDrag ? finishRelationshipDrag(true) : cancelRelationSelection(); showToast('已取消创建关系'); }
      else if (!relationshipDrag && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); navigateSelection(event.key); }
      else if (!relationshipDrag && event.key === 'Enter' && selectedId !== relationSourceId) { event.preventDefault(); chooseRelationshipTarget(selectedId); }
      return;
    }
    if (reparentSourceId) {
      if (event.key === 'Escape') { event.preventDefault(); cancelReparent(); showToast('已取消重新归属'); }
      else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); navigateSelection(event.key); }
      else if (event.key === 'Enter' && selectedId !== reparentSourceId) { event.preventDefault(); completeReparent(selectedId); }
      return;
    }
    if (els.previewDialog.open && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); return stepPreview(event.key === 'ArrowRight' ? 1 : -1);
    }
    const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName) || Boolean(document.querySelector('dialog[open]'));
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); return openSearch(); }
    if (event.key === 'Escape' && !els.searchPanel.classList.contains('hidden')) return closeSearch();
    if (typing) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); return event.shiftKey ? redo() : undo(); }
    const actions = {
      ArrowRight: () => addChild(), ArrowLeft: () => { const parent = parentOf(selectedId); parent ? selectNode(parent.id) : wrapRoot(); },
      ArrowUp: () => moveSibling(-1), ArrowDown: () => moveSibling(1), Enter: () => addSibling('below'),
      F2: () => openEditor(), Delete: () => deleteNode(), Backspace: () => deleteNode(), ' ': () => toggleCollapse()
    };
    if (actions[event.key]) { event.preventDefault(); actions[event.key](); }
  });
  window.addEventListener('resize', updateTransform);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && saveTimer && doc) { clearTimeout(saveTimer); saveTimer = 0; save(); }
  });
}

bind();
authenticateAndLoad();
