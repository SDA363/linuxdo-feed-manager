(() => {
  // 书签自定义文件夹（纯本地分类层）。
  //
  // 为什么不用站点书签做：站点只有「书签 + 搜索」，没有文件夹概念；
  // 用书签 name 字段硬映射会每次移动都写服务器，且站点 UI 照样不显示分组。
  // 所以这里做成本地分类：记录上挂 folderId，文件夹定义放 meta，
  // 与「感兴趣/已读/不感兴趣」的归属（basePool）正交 —— 移动文件夹不改归属。
  //
  // 层级：最多 6 层（MAX_DEPTH）。这不是技术上限（Windows 限路径长度 260、
  // Linux 限 PATH_MAX 4096 字节），是 UI 与同步冲突的可控取舍。
  const META_KEY = "ldfc.folders";
  const MAX_DEPTH = 6;

  let items = []; // [{ id, name, parentId, order }]
  let loaded = false;
  let loading = null;

  const notify = () => window.dispatchEvent(new CustomEvent("ldfc:folders-changed"));
  const uid = () => `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const norm = (value) => (value ? String(value) : null);
  const byId = (id) => items.find((folder) => folder.id === id) || null;

  function childrenOf(parentId) {
    const key = norm(parentId);
    return items
      .filter((folder) => norm(folder.parentId) === key)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  }

  function depthOf(id) {
    let depth = 0;
    let cursor = byId(id);
    while (cursor && cursor.parentId && depth < 64) {
      depth += 1;
      cursor = byId(cursor.parentId);
    }
    return depth;
  }

  // depthOf 是 0 基下标，写判据时最容易差一层（早先版本就把 6 层放成了 7 层）。
  // 判「能不能放进某一层」一律用这个，层级从 1 开始，根文件夹 = 1。
  const levelOf = (id) => (id ? depthOf(id) + 1 : 0);

  // 含自身在内的整枝后代 id（删除 / 过滤都用它）
  function subtreeIds(id) {
    const out = [];
    const stack = [id];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      for (const child of items) {
        if (norm(child.parentId) === current) stack.push(child.id);
      }
    }
    return out;
  }

  function pathOf(id) {
    const names = [];
    let cursor = byId(id);
    let guard = 0;
    while (cursor && guard < 64) {
      names.unshift(cursor.name);
      cursor = byId(cursor.parentId);
      guard += 1;
    }
    return names;
  }

  async function persist() {
    try {
      await window.LDFCDB.putMeta(META_KEY, items);
    } catch {
      // 写不进去不影响本次会话，下次打开会回退到上次成功保存的状态
    }
    notify();
  }

  async function load() {
    if (loaded) return items;
    if (loading) return loading;
    loading = (async () => {
      try {
        const saved = await window.LDFCDB.getMeta(META_KEY);
        if (Array.isArray(saved)) {
          items = saved
            .filter((folder) => folder && typeof folder.id === "string" && typeof folder.name === "string")
            .map((folder) => ({
              id: folder.id,
              name: folder.name,
              parentId: norm(folder.parentId),
              order: Number(folder.order) || 0
            }));
        }
      } catch {
        items = [];
      }
      loaded = true;
      loading = null;
      notify();
      return items;
    })();
    return loading;
  }

  function existsSibling(parentId, name, exceptId = null) {
    const key = norm(parentId);
    return items.some(
      (folder) =>
        folder.id !== exceptId &&
        norm(folder.parentId) === key &&
        folder.name.toLowerCase() === String(name).trim().toLowerCase()
    );
  }

  async function create(name, parentId = null) {
    await load();
    const label = String(name ?? "").trim();
    if (!label) return { ok: false, reason: "empty" };
    const parent = norm(parentId);
    if (parent && !byId(parent)) return { ok: false, reason: "missing-parent" };
    if (levelOf(parent) + 1 > MAX_DEPTH) return { ok: false, reason: "too-deep" };
    if (existsSibling(parent, label)) return { ok: false, reason: "duplicate" };

    const sameLevel = childrenOf(parent);
    const folder = { id: uid(), name: label, parentId: parent, order: sameLevel.length };
    items.push(folder);
    await persist();
    return { ok: true, folder };
  }

  async function rename(id, name) {
    await load();
    const folder = byId(id);
    if (!folder) return { ok: false, reason: "missing" };
    const label = String(name ?? "").trim();
    if (!label) return { ok: false, reason: "empty" };
    if (existsSibling(folder.parentId, label, folder.id)) return { ok: false, reason: "duplicate" };
    folder.name = label;
    await persist();
    return { ok: true, folder };
  }

  async function move(id, parentId) {
    await load();
    const folder = byId(id);
    if (!folder) return { ok: false, reason: "missing" };
    const parent = norm(parentId);
    if (parent === id) return { ok: false, reason: "self" };
    if (parent && subtreeIds(id).includes(parent)) return { ok: false, reason: "cycle" };
    if (levelOf(parent) + 1 + maxSubDepth(id) > MAX_DEPTH) return { ok: false, reason: "too-deep" };
    if (existsSibling(parent, folder.name, folder.id)) return { ok: false, reason: "duplicate" };
    folder.parentId = parent;
    folder.order = childrenOf(parent).length;
    await persist();
    return { ok: true, folder };
  }

  function maxSubDepth(id) {
    let deepest = 0;
    for (const childId of subtreeIds(id)) {
      if (childId === id) continue;
      deepest = Math.max(deepest, depthOf(childId) - depthOf(id));
    }
    return deepest;
  }

  // 删除 = 级联（对齐 Windows / rm -r 的直觉），但记录不删，只回落「未分类」。
  // 返回的快照用于 toast 里的「撤销」。
  async function remove(id) {
    await load();
    const target = byId(id);
    if (!target) return { ok: false, reason: "missing" };

    const removedIds = subtreeIds(id);
    const removedFolders = items.filter((folder) => removedIds.includes(folder.id)).map((folder) => ({ ...folder }));
    const affected = [];
    for (const record of window.LDFCTopicState?.records?.values?.() ?? []) {
      if (record.folderId && removedIds.includes(record.folderId)) {
        affected.push({ topicId: record.topicId, folderId: record.folderId });
      }
    }

    items = items.filter((folder) => !removedIds.includes(folder.id));
    for (const entry of affected) {
      await window.LDFCTopicState?.setFolder?.(entry.topicId, null);
    }
    await persist();
    return { ok: true, removedFolders, affected, descendantCount: removedIds.length - 1 };
  }

  async function restore(removedFolders = [], affected = []) {
    await load();
    for (const folder of removedFolders) {
      if (!byId(folder.id)) items.push({ ...folder });
    }
    for (const entry of affected) {
      await window.LDFCTopicState?.setFolder?.(entry.topicId, entry.folderId);
    }
    await persist();
  }

  async function assign(topicIds, folderId) {
    const target = norm(folderId);
    let moved = 0;
    for (const topicId of topicIds) {
      const record = await window.LDFCTopicState?.setFolder?.(topicId, target);
      if (record) moved += 1;
    }
    return moved;
  }

  function folderOf(record) {
    return norm(record?.folderId);
  }

  function matches(record, activeFolderId) {
    if (!activeFolderId) return true;
    const folderId = folderOf(record);
    if (activeFolderId === "NONE") return !folderId;
    if (!folderId) return false;
    return subtreeIds(activeFolderId).includes(folderId);
  }

  window.LDFCFolders = {
    MAX_DEPTH,
    assign,
    childrenOf,
    create,
    depthOf,
    folderOf,
    isLoaded: () => loaded,
    list: () => items.slice(),
    load,
    matches,
    move,
    pathOf,
    remove,
    rename,
    restore,
    subtreeIds
  };

  // 尽早把配置读进内存：面板第一次渲染就能画出来，不用等用户点开。
  load();
})();
