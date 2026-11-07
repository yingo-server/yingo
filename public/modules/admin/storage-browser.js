// Storage VFS 文件浏览器壳（§6.11 / D29）：管理面板「数据与清理」分区的独立组件。
// 六区树形浏览 / 条目 value 预览 + 完整 meta 展示 / 删除 / JSON 导入导出。
// 全部读写只走 ctx.bus.emit('storage:*') 或受限 ctx.vfs 句柄，绝不接触原生存储 API。
// 本文件只提供组件工厂，不实现 VFS 本身、不实现真实导入导出算法（由 StorageService 承担）。

export const STORAGE_ZONES = ['/system', '/shared', '/module', '/plugin', '/cache', '/tmp'];

export function createStorageBrowser(ctx) {
  const COMPONENT_ID = 'admin/storage-browser';
  const subscriptions = [];
  let selectedPath = null;
  let importPayload = null;
  let entriesByZone = new Map();
  let destroyed = false;

  let rootNode = null;
  let treeNode = null;
  let detailNode = null;
  let metaNode = null;
  let valueNode = null;
  let selectedNode = null;
  let deleteBtn = null;
  let renameBtn = null;
  let prefixInput = null;
  let originInput = null;
  let usageNode = null;
  let exportArea = null;
  let importPreview = null;
  let confirmImportBtn = null;
  let fileInput = null;

  function report(code, message, err, extra) {
    const detail = { code, module: COMPONENT_ID, ...(extra || {}) };
    if (err) {
      detail.message = err && err.message ? err.message : String(err);
      detail.stack = err && err.stack ? err.stack : null;
    }
    ctx.notify('error', message, detail);
  }

  function isPromise(value) {
    return !!value && typeof value.then === 'function';
  }

  async function emit(command, payload) {
    const result = ctx.bus.emit(command, payload);
    return isPromise(result) ? await result : result;
  }

  async function on(command, handler) {
    const result = ctx.bus.on(command, handler);
    if (isPromise(result)) await result;
    subscriptions.push({ command, handler });
  }

  function makeEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function normalizeEntries(result) {
    let raw = result;
    if (raw && !Array.isArray(raw)) {
      raw = raw.entries || raw.items || raw.files || raw.list || raw.paths || null;
    }
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        if (typeof item === 'string') return { path: item };
        if (item && item.path) return item;
        if (item && item.key) return { path: item.key, meta: item.meta, value: item.value };
        return null;
      })
      .filter((entry) => entry && typeof entry.path === 'string' && entry.path.startsWith('/'))
      .map((entry) => ({ ...entry, path: String(entry.path).split('?')[0] }));
  }

  // storage:list 为唯一主路径；命令未注册或返回空时退回受限 VFS 句柄（仍不绕过权限）。
  async function listPrefix(prefix, recursive = true) {
    try {
      const result = await emit('storage:list', { prefix, recursive });
      const entries = normalizeEntries(result);
      if (entries.length || result != null) return entries;
    } catch (err) {
      report('E_VFS_BACKEND', `列举 ${prefix} 失败`, err, { prefix });
    }
    try {
      if (ctx.vfs && typeof ctx.vfs.list === 'function') {
        return normalizeEntries(await ctx.vfs.list(prefix));
      }
    } catch (err) {
      report('E_VFS_BACKEND', `VFS 句柄列举 ${prefix} 失败`, err, { prefix });
    }
    return [];
  }

  async function readEntry(path) {
    try {
      return await emit('storage:get', { path, fallback: null });
    } catch (err) {
      report('E_VFS_BACKEND', `读取 ${path} 失败`, err, { path });
    }
    try {
      if (ctx.vfs && typeof ctx.vfs.read === 'function') return await ctx.vfs.read(path);
    } catch (err) {
      report('E_VFS_BACKEND', `VFS 句柄读取 ${path} 失败`, err, { path });
    }
    return null;
  }

  async function statEntry(path) {
    try {
      return await emit('storage:stat', { path });
    } catch (err) {
      report('E_VFS_BACKEND', `读取 ${path} 的 meta 失败`, err, { path });
    }
    try {
      if (ctx.vfs && typeof ctx.vfs.stat === 'function') return await ctx.vfs.stat(path);
    } catch (err) {
      report('E_VFS_BACKEND', `VFS 句柄读取 ${path} 的 meta 失败`, err, { path });
    }
    return null;
  }

  function buildTree(entries, zone) {
    const root = { dirs: new Map(), files: [] };
    for (const entry of entries) {
      if (!entry.path.startsWith(zone)) continue;
      const rest = entry.path.slice(zone.length).replace(/^\//, '');
      if (!rest) continue;
      const parts = rest.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const name = parts[i];
        if (!node.dirs.has(name)) node.dirs.set(name, { dirs: new Map(), files: [] });
        node = node.dirs.get(name);
      }
      node.files.push({ ...entry, name: parts[parts.length - 1] });
    }
    return root;
  }

  function renderDir(node, zone, parentPath, container) {
    for (const [name, dir] of node.dirs) {
      const dirPath = `${parentPath}/${name}`;
      const details = makeEl('details', 'y-admin-storage-browser-dir');
      const summary = makeEl('summary', '', `${name}/`);
      details.append(summary);
      const list = makeEl('ul', 'y-admin-storage-browser-dir-list');
      renderDir(dir, zone, dirPath, list);
      details.append(list);
      const dirItem = makeEl('li', 'y-admin-storage-browser-dir-item');
      dirItem.append(details);
      container.append(dirItem);
    }
    for (const file of node.files) {
      const btn = makeEl('button', 'y-admin-storage-browser-entry', file.name);
      btn.type = 'button';
      btn.dataset.entryPath = file.path;
      if (file.path === selectedPath) btn.setAttribute('aria-current', 'true');
      if (file.path.startsWith('/system')) btn.dataset.readonly = 'true';
      const fileItem = makeEl('li', 'y-admin-storage-browser-file-item');
      fileItem.append(btn);
      container.append(fileItem);
    }
  }

  function renderTree() {
    if (!treeNode) return;
    treeNode.replaceChildren();
    const prefixFilter = prefixInput ? prefixInput.value.trim() : '';
    const originFilter = originInput ? originInput.value.trim().toLowerCase() : '';

    for (const zone of STORAGE_ZONES) {
      let entries = entriesByZone.get(zone) || [];
      if (prefixFilter) entries = entries.filter((entry) => entry.path.includes(prefixFilter));
      if (originFilter) {
        entries = entries.filter((entry) => {
          const origin = entry.meta && entry.meta.origin ? String(entry.meta.origin) : '';
          return origin.toLowerCase().includes(originFilter);
        });
      }
      const zoneBox = makeEl('details', 'y-admin-storage-browser-zone');
      zoneBox.dataset.zone = zone;
      zoneBox.open = zone === '/shared' || zone === '/system';
      const summary = makeEl('summary', '', `${zone} （${entries.length} 项）`);
      if (zone === '/system') summary.append(makeEl('span', 'y-admin-storage-browser-readonly-tag', ' · 框架保留 / 只读'));
      zoneBox.append(summary);
      const list = makeEl('ul', 'y-admin-storage-browser-zone-list');
      renderDir(buildTree(entries, zone), zone, zone, list);
      if (!entries.length) list.append(makeEl('li', 'y-admin-storage-browser-empty', '（空 / 暂无可读条目）'));
      zoneBox.append(list);
      treeNode.append(zoneBox);
    }
  }

  function renderMeta(meta) {
    if (!metaNode) return;
    metaNode.replaceChildren();
    metaNode.append(makeEl('h5', '', '条目 meta（完整字段）'));
    if (!meta || typeof meta !== 'object') {
      metaNode.append(makeEl('p', 'y-admin-storage-browser-empty', '无 meta（StorageService 未返回）'));
      return;
    }
    const table = makeEl('table', 'y-admin-storage-browser-meta-table');
    const fields = ['version', 'schema', 'ttl', 'size', 'origin', 'contentType', 'createdAt', 'updatedAt', 'backend'];
    for (const key of fields) {
      const row = makeEl('tr');
      row.append(makeEl('th', '', key));
      const value = meta[key] == null ? '—' : typeof meta[key] === 'object' ? JSON.stringify(meta[key]) : String(meta[key]);
      row.append(makeEl('td', '', value));
      table.append(row);
    }
    metaNode.append(table);
  }

  async function select(path) {
    try {
      selectedPath = path;
      const readonly = path.startsWith('/system');
      selectedNode.textContent = path;
      deleteBtn.disabled = readonly;
      deleteBtn.title = readonly ? '/system/* 只读，框架保留' : '删除该条目';
      if (renameBtn) renameBtn.disabled = !/^\/(module|plugin)\//.test(path);
      metaNode.replaceChildren(makeEl('p', '', '读取中…'));
      valueNode.textContent = '读取中…';
      renderTree();
      const [value, meta] = await Promise.all([readEntry(path), statEntry(path)]);
      if (destroyed || selectedPath !== path) return;
      renderMeta(meta);
      try {
        valueNode.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2) || '（空值）';
      } catch (err) {
        valueNode.textContent = '（value 无法序列化为预览）';
        report('E_VFS_SCHEMA', 'value 预览序列化失败', err, { path });
      }
    } catch (err) {
      report('E_INTERNAL', '选中条目失败', err, { path });
    }
  }

  function clearSelection() {
    selectedPath = null;
    selectedNode.textContent = '未选择条目';
    deleteBtn.disabled = true;
    if (renameBtn) renameBtn.disabled = true;
    metaNode.replaceChildren(makeEl('p', 'y-admin-storage-browser-empty', '点选左侧条目查看 meta 与 value 预览'));
    valueNode.textContent = '—';
  }

  async function refresh() {
    if (destroyed) return;
    try {
      const pairs = await Promise.all(STORAGE_ZONES.map(async (zone) => [zone, await listPrefix(zone, true)]));
      entriesByZone = new Map(pairs);
      renderTree();
    } catch (err) {
      report('E_VFS_BACKEND', '刷新 VFS 文件树失败', err);
    }
    try {
      const usage = await emit('storage:usage', {});
      usageNode.textContent = usage ? `占用概览：${typeof usage === 'string' ? usage : JSON.stringify(usage)}` : '占用概览：StorageService 未返回';
    } catch (err) {
      usageNode.textContent = '占用概览不可用';
      report('E_VFS_BACKEND', '读取存储占用概览失败', err);
    }
  }

  async function removeSelected() {
    if (!selectedPath) return;
    try {
      if (selectedPath.startsWith('/system')) {
        ctx.notify('error', '禁止删除 /system/* 框架保留区', { code: 'E_VFS_PERMISSION', module: COMPONENT_ID, path: selectedPath });
        return;
      }
      let ok = false;
      try {
        await emit('storage:del', { path: selectedPath });
        ok = true;
      } catch (err) {
        report('E_VFS_BACKEND', `删除 ${selectedPath} 的总线命令失败`, err, { path: selectedPath });
      }
      if (!ok && ctx.vfs && typeof ctx.vfs.remove === 'function') {
        try {
          await ctx.vfs.remove(selectedPath);
        } catch (err) {
          report('E_VFS_PERMISSION', `VFS 句柄删除 ${selectedPath} 失败`, err, { path: selectedPath });
          return;
        }
      }
      clearSelection();
      await refresh();
    } catch (err) {
      report('E_INTERNAL', '删除条目失败', err, { path: selectedPath });
    }
  }

  /** 重命名：仅允许 /module|plugin/<id>/ 私有区，通过读+写+删实现（VFS 无 rename 命令） */
  async function renameSelected() {
    if (!selectedPath) return;
    const parts = selectedPath.split('/');
    const zone = parts[1];
    if (zone !== 'module' && zone !== 'plugin') {
      ctx.notify('error', '仅私有区（/module、/plugin）可重命名', { code: 'E_VFS_PERMISSION', module: COMPONENT_ID, path: selectedPath });
      return;
    }
    const next = prompt('新路径（相对当前私有区，或完整 VFS 路径）：', selectedPath);
    if (!next) return;
    const target = next.startsWith('/') ? next : `/${zone}/${parts[2]}/${next.replace(/^\/+/, '')}`;
    if (target === selectedPath) return;
    if (!/^\/(module|plugin)\/[a-z0-9-]+\/[a-z0-9./-]+$/.test(target) || target.split('/')[2] !== parts[2]) {
      ctx.notify('error', '目标路径必须属于同一私有区且符合 kebab-case', { code: 'E_VFS_PATH', module: COMPONENT_ID, target });
      return;
    }
    try {
      const value = await emit('storage:get', { path: selectedPath });
      if (value === undefined) { ctx.notify('error', '源条目不存在', { code: 'E_NOT_FOUND', module: COMPONENT_ID }); return; }
      const meta = await emit('storage:stat', { path: selectedPath });
      await emit('storage:set', { path: target, value, schema: meta?.schema || 'any@1', ttl: meta?.ttl });
      await emit('storage:del', { path: selectedPath });
      clearSelection();
      await refresh();
      ctx.notify('info', `已重命名为 ${target}`, { module: COMPONENT_ID });
    } catch (err) { report('E_VFS_BACKEND', '重命名失败', err, { path: selectedPath, target }); }
  }

  /** 上传图片：读为 data URL 存入 /cache/images/<slug>（纯本地，不上传远端） */
  async function uploadImage() {
    const input = document.querySelector('.y-admin-storage-browser-detail-actions input[type="file"]');
    if (!input) return;
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      try {
        const dataUrl = await new Promise((res, rej) => {
          const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej;
          r.readAsDataURL(file);
        });
        const slug = file.name.replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'upload';
        const path = `/cache/images/${slug}-${Date.now().toString(36)}.json`;
        await emit('storage:set', {
          path, value: { name: file.name, mime: file.type, size: file.size, data: dataUrl },
          schema: 'blob-wrapper@1', ttl: 30 * 86400,
        });
        await refresh();
        ctx.notify('info', `已存入 ${path}`, { module: COMPONENT_ID });
      } catch (err) { report('E_VFS_EXPORT', '图片上传失败', err); }
      finally { input.value = ''; }
    };
    input.click();
  }

  async function exportJson() {
    try {
      // §6.10：导出包不含 /system/*；真实打包与校验由 StorageService 完成。
      const prefixes = STORAGE_ZONES.filter((zone) => zone !== '/system');
      let result = null;
      try {
        result = await emit('storage:export', { prefixes });
      } catch (err) {
        report('E_VFS_EXPORT', 'storage:export 命令失败', err, { prefixes });
      }
      if (result == null) {
        try {
          // §5 命令表中的 admin 级别名，作为兼容回退。
          result = await emit('data:export', { scope: 'shared', prefixes });
        } catch (err) {
          report('E_VFS_EXPORT', 'data:export 兼容命令失败', err, { prefixes });
        }
      }
      exportArea.value = result == null ? '（导出结果：StorageService 未返回结果；确认已排除 /system/* 与凭据字段）' : typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      report('E_VFS_EXPORT', 'JSON 导出失败', err);
    }
  }

  async function importJson(text) {
    try {
      const payload = JSON.parse(text);
      // 基础校验：格式与 entries 结构；schemaVersion / migrate 由 StorageService 执行。
      if (!payload || payload.format !== 'yingo-vfs@1' || !Array.isArray(payload.entries)) {
        ctx.notify('error', '导入包格式不符（需 format: yingo-vfs@1 与 entries[]）', { code: 'E_VFS_EXPORT', module: COMPONENT_ID });
        return;
      }
      importPayload = payload;
      confirmImportBtn.disabled = true;
      let preview = null;
      try {
        // 冲突可预览：先 dryRun，不落盘。
        preview = await emit('storage:import', { payload, dryRun: true });
      } catch (err) {
        report('E_VFS_EXPORT', '导入冲突预览失败', err);
      }
      if (preview == null) {
        try {
          preview = await emit('data:import', { payload, dryRun: true });
        } catch (err) {
          report('E_VFS_EXPORT', 'data:import 兼容命令失败', err);
        }
      }
      importPreview.textContent = preview == null ? '（冲突预览：StorageService 未返回结果）' : typeof preview === 'string' ? preview : JSON.stringify(preview, null, 2);
      confirmImportBtn.disabled = false;
    } catch (err) {
      report('E_VFS_EXPORT', 'JSON 解析 / 导入预览失败', err);
      importPayload = null;
      confirmImportBtn.disabled = true;
    }
  }

  async function confirmImport() {
    if (!importPayload) return;
    try {
      try {
        await emit('storage:import', { payload: importPayload, dryRun: false });
      } catch (err) {
        report('E_VFS_EXPORT', '导入落盘命令失败', err);
        try {
          await emit('data:import', { payload: importPayload, dryRun: false });
        } catch (err2) {
          report('E_VFS_EXPORT', 'data:import 兼容命令失败', err2);
        }
      }
      importPayload = null;
      confirmImportBtn.disabled = true;
      importPreview.textContent = '（已提交导入命令；实际写入、迁移与冲突处理由 StorageService 负责）';
      await refresh();
    } catch (err) {
      report('E_INTERNAL', '确认导入失败', err);
    }
  }

  function buildUi() {
    rootNode = makeEl('section', 'y-admin-storage-browser');
    rootNode.dataset.component = 'storage-browser';
    rootNode.append(makeEl('h3', 'y-admin-storage-browser-title', 'Storage VFS 文件浏览器（壳）'));

    const toolbar = makeEl('div', 'y-admin-storage-browser-toolbar');
    prefixInput = makeEl('input');
    prefixInput.type = 'search';
    prefixInput.placeholder = '按路径前缀过滤';
    prefixInput.addEventListener('input', () => {
      try {
        renderTree();
      } catch (err) {
        report('E_INTERNAL', '路径过滤失败', err);
      }
    });
    originInput = makeEl('input');
    originInput.type = 'search';
    originInput.placeholder = '按 origin 过滤';
    originInput.addEventListener('input', () => {
      try {
        renderTree();
      } catch (err) {
        report('E_INTERNAL', 'origin 过滤失败', err);
      }
    });
    const refreshBtn = makeEl('button', '', '刷新');
    refreshBtn.type = 'button';
    refreshBtn.addEventListener('click', () => {
      void refresh();
    });
    toolbar.append(prefixInput, originInput, refreshBtn);
    rootNode.append(toolbar);

    const body = makeEl('div', 'y-admin-storage-browser-body');
    treeNode = makeEl('div', 'y-admin-storage-browser-tree');
    treeNode.addEventListener('click', (event) => {
      try {
        const target = event.target && event.target.closest ? event.target.closest('button[data-entry-path]') : null;
        if (target) void select(target.dataset.entryPath);
      } catch (err) {
        report('E_INTERNAL', '选择条目失败', err);
      }
    });

    detailNode = makeEl('div', 'y-admin-storage-browser-detail');
    selectedNode = makeEl('p', 'y-admin-storage-browser-selected', '未选择条目');
    metaNode = makeEl('div', 'y-admin-storage-browser-meta');
    valueNode = makeEl('pre', 'y-admin-storage-browser-value', '—');
    const detailActions = makeEl('div', 'y-admin-storage-browser-detail-actions');
    deleteBtn = makeEl('button', '', '删除条目');
    deleteBtn.type = 'button';
    deleteBtn.disabled = true;
    deleteBtn.addEventListener('click', () => {
      void removeSelected();
    });
    renameBtn = makeEl('button', '', '重命名（限私有区）');
    renameBtn.type = 'button';
    renameBtn.disabled = true;
    renameBtn.addEventListener('click', () => { void renameSelected(); });
    const uploadBtn = makeEl('button', '', '上传图片到 /cache/images');
    uploadBtn.type = 'button';
    uploadBtn.addEventListener('click', () => { void uploadImage(); });
    const hiddenFile = makeEl('input');
    hiddenFile.type = 'file'; hiddenFile.accept = 'image/*'; hiddenFile.hidden = true;
    detailActions.append(deleteBtn, renameBtn, uploadBtn, hiddenFile);
    uploadBtn._fileInput = hiddenFile;
    detailNode.append(selectedNode, metaNode, makeEl('h5', '', 'value 预览'), valueNode, detailActions);
    body.append(treeNode, detailNode);
    rootNode.append(body);

    usageNode = makeEl('p', 'y-admin-storage-browser-usage', '占用概览：加载中');
    rootNode.append(usageNode);

    const actions = makeEl('div', 'y-admin-storage-browser-actions');
    const clearBtn = makeEl('button', '', '清理 /cache');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      void (async () => {
        try {
          await emit('storage:clear', { prefix: '/cache', scope: 'cache' });
          await refresh();
        } catch (err) {
          report('E_VFS_BACKEND', '清缓存失败', err, { prefix: '/cache' });
        }
      })();
    });
    const gcBtn = makeEl('button', '', '一键 GC');
    gcBtn.type = 'button';
    gcBtn.addEventListener('click', () => {
      void (async () => {
        try {
          await emit('storage:gc', { scope: 'cache' });
          await refresh();
        } catch (err) {
          report('E_VFS_BACKEND', '手动 GC 失败', err);
        }
      })();
    });
    actions.append(clearBtn, gcBtn);
    rootNode.append(actions);

    // JSON 导入导出（§6.10 / D30）。
    const backup = makeEl('div', 'y-admin-storage-browser-backup');
    backup.append(makeEl('h4', '', 'JSON 导入导出'));
    const exportRow = makeEl('div');
    const exportBtn = makeEl('button', '', '导出 JSON');
    exportBtn.type = 'button';
    exportBtn.addEventListener('click', () => {
      void exportJson();
    });
    const downloadBtn = makeEl('button', '', '下载 .json');
    downloadBtn.type = 'button';
    downloadBtn.disabled = true;
    exportArea = makeEl('textarea', 'y-admin-storage-browser-export');
    exportArea.readOnly = true;
    exportArea.rows = 4;
    exportArea.placeholder = '导出包预览（不含 /system/* 与凭据字段）';
    exportRow.append(exportBtn, downloadBtn);
    backup.append(exportRow, exportArea);

    const importRow = makeEl('div');
    fileInput = makeEl('input');
    fileInput.type = 'file';
    fileInput.accept = '.json,application/json';
    fileInput.addEventListener('change', () => {
      void (async () => {
        try {
          const file = fileInput.files && fileInput.files[0];
          if (!file) return;
          await importJson(await file.text());
        } catch (err) {
          report('E_VFS_EXPORT', '读取导入文件失败', err);
        }
      })();
    });
    confirmImportBtn = makeEl('button', '', '确认导入');
    confirmImportBtn.type = 'button';
    confirmImportBtn.disabled = true;
    confirmImportBtn.addEventListener('click', () => {
      void confirmImport();
    });
    importRow.append(fileInput, confirmImportBtn);
    importPreview = makeEl('pre', 'y-admin-storage-browser-import-preview', '（冲突预览：先 dryRun，确认后才提交）');
    backup.append(importRow, importPreview);
    rootNode.append(backup);

    clearSelection();
  }

  buildUi();

  // 失效广播到达后自动刷新文件树，保证可视化与 VFS 一致。
  void on('storage:invalidate', (payload) => {
    try {
      if (destroyed) return;
      void refresh();
    } catch (err) {
      report('E_SCHEMA', '处理 storage:invalidate 失败', err, { payload });
    }
  }).catch((err) => report('E_SCHEMA', '订阅 storage:invalidate 失败', err));

  void refresh();

  return {
    el: rootNode,
    refresh,
    destroy() {
      try {
        destroyed = true;
        for (const { command, handler } of subscriptions) {
          try {
            ctx.bus.off(command, handler);
          } catch (err) {
            report('E_MODULE_INIT', `取消订阅 ${command} 失败`, err);
          }
        }
        subscriptions.length = 0;
        if (rootNode && rootNode.parentNode) rootNode.parentNode.removeChild(rootNode);
      } catch (err) {
        report('E_MODULE_INIT', '文件浏览器销毁失败', err);
      } finally {
        entriesByZone = new Map();
        importPayload = null;
        rootNode = null;
        treeNode = null;
        detailNode = null;
        metaNode = null;
        valueNode = null;
        selectedNode = null;
        deleteBtn = null;
        prefixInput = null;
        originInput = null;
        usageNode = null;
        exportArea = null;
        importPreview = null;
        confirmImportBtn = null;
        fileInput = null;
      }
    }
  };
}
