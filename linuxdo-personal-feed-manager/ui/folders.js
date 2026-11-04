(() => {
  // 书签文件夹（纯本地分类层），**两棵独立的树**：
  //   pool —— 信息池里的主题（记录上挂 folderId）
  //   site —— linux.do 站点书签（书签 id 映射上挂 folderId）
  //
  // 为什么两棵：信息池与站点书签各用一套分类，互不影响；
  // 共用一棵的话，删一个文件夹会同时动两边的数据，心智上也不对。
  //
  // 为什么不用站点书签本身做分组：站点只有「书签 + 搜索」，没有文件夹概念；
  // 用书签 name 字段硬映射会每次移动都写服务器，且站点 UI 照样不显示分组。
  // 所以这里做成本地分类，与「感兴趣/已读/不感兴趣」的归属（basePool）正交。
  //
  // 层级：最多 6 层（MAX_DEPTH）。这不是技术上限（Windows 限路径长度 260、
  // Linux 限 PATH_MAX 4096 字节），是 UI 与同步冲突的可控取舍。
  const MAX_DEPTH = 6;

  const TREES = {
    pool: { key: "ldfc.folders", items: [], loaded: false, loading: null },
    site: { key: "ldfc.siteFolders", items: [], loaded: false, loading: null }
  };

  const resolveTree = (ns) => TREES[ns] || TREES.pool;
  const notify = (ns) =>
    window.dispatchEvent(new CustomEvent("ldfc:folders-changed", { detail: { ns } }));
  const uid = () => `f_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const norm = (value) => (value ? String(value) : null);
  const byId = (tree, id) => tree.items.find((folder) => folder.id === id) || null;

  function childrenOf(tree, parentId) {
    const key = norm(parentId);
    return tree.items
      .filter((folder) => norm(folder.parentId) === key)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
  }

  function depthOf(tree, id) {
    let depth = 0;
    let cursor = byId(tree, id);
    while (cursor && cursor.parentId && depth < 64) {
      depth += 1;
      cursor = byId(tree, cursor.parentId);
    }
    return depth;
  }

  // depthOf 是 0 基下标，写判据时最容易差一层（早先版本就把 6 层放成了 7 层）。
  // 判「能不能放进某一层」一律用这个，层级从 1 开始，根文件夹 = 1。
  const levelOf = (tree, id) => (id ? depthOf(tree, id) + 1 : 0);

  // 含自身在内的整枝后代 id（删除 / 过滤都用它）
  function subtreeIds(tree, id) {
    const out = [];
    const stack = [id];
    const seen = new Set();
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      out.push(current);
      for (const child of tree.items) {
        if (norm(child.parentId) === current) stack.push(child.id);
      }
    }
    return out;
  }

  function pathOf(tree, id) {
    const names = [];
    let cursor = byId(tree, id);
    let guard = 0;
    while (cursor && guard < 64) {
      names.unshift(cursor.name);
      cursor = byId(tree, cursor.parentId);
      guard += 1;
    }
    return names;
  }

  async function persist(tree, ns) {
    try {
      await window.LDFCDB.putMeta(tree.key, tree.items);
    } catch {
      // 写不进去不影响本次会话，下次打开会回退到上次成功保存的状态
    }
    notify(ns);
  }

  async function loadTree(tree, ns) {
    if (tree.loaded) return tree.items;
    if (tree.loading) return tree.loading;
    tree.loading = (async () => {
      try {
        const saved = await window.LDFCDB.getMeta(tree.key);
        if (Array.isArray(saved)) {
          tree.items = saved
            .filter((folder) => folder && typeof folder.id === "string" && typeof folder.name === "string")
            .map((folder) => ({
              id: folder.id,
              name: folder.name,
              parentId: norm(folder.parentId),
              order: Number(folder.order) || 0
            }));
        }
      } catch {
        tree.items = [];
      }
      tree.loaded = true;
      tree.loading = null;
      notify(ns);
      return tree.items;
    })();
    return tree.loading;
  }

  function existsSibling(tree, parentId, name, exceptId = null) {
    const key = norm(parentId);
    return tree.items.some(
      (folder) =>
        folder.id !== exceptId &&
        norm(folder.parentId) === key &&
        folder.name.toLowerCase() === String(name).trim().toLowerCase()
    );
  }

  function maxSubDepth(tree, id) {
    let deepest = 0;
    for (const childId of subtreeIds(tree, id)) {
      if (childId === id) continue;
      deepest = Math.max(deepest, depthOf(tree, childId) - depthOf(tree, id));
    }
    return deepest;
  }

  function makeApi(ns) {
    const tree = resolveTree(ns);

    // 信息池树自己知道归属存在哪（topics.folderId），所以默认就会回落/恢复；
    // 站点书签树的映射在 LDFCSiteBookmarks 里，由调用方传回调进来。
    const defaultDetach =
      ns === "pool"
        ? async (removedIds) => {
            const affected = [];
            for (const record of window.LDFCTopicState?.records?.values?.() ?? []) {
              if (record.folderId && removedIds.includes(record.folderId)) {
                affected.push({ topicId: record.topicId, folderId: record.folderId });
              }
            }
            for (const entry of affected) {
              await window.LDFCTopicState?.setFolder?.(entry.topicId, null);
            }
            return affected;
          }
        : null;
    const defaultReattach =
      ns === "pool"
        ? async (affected) => {
            for (const entry of affected ?? []) {
              await window.LDFCTopicState?.setFolder?.(entry.topicId, entry.folderId);
            }
          }
        : null;

    async function create(name, parentId = null) {
      await loadTree(tree, ns);
      const label = String(name ?? "").trim();
      if (!label) return { ok: false, reason: "empty" };
      const parent = norm(parentId);
      if (parent && !byId(tree, parent)) return { ok: false, reason: "missing-parent" };
      if (levelOf(tree, parent) + 1 > MAX_DEPTH) return { ok: false, reason: "too-deep" };
      if (existsSibling(tree, parent, label)) return { ok: false, reason: "duplicate" };

      const sameLevel = childrenOf(tree, parent);
      const folder = { id: uid(), name: label, parentId: parent, order: sameLevel.length };
      tree.items.push(folder);
      await persist(tree, ns);
      return { ok: true, folder };
    }

    async function rename(id, name) {
      await loadTree(tree, ns);
      const folder = byId(tree, id);
      if (!folder) return { ok: false, reason: "missing" };
      const label = String(name ?? "").trim();
      if (!label) return { ok: false, reason: "empty" };
      if (existsSibling(tree, folder.parentId, label, folder.id)) return { ok: false, reason: "duplicate" };
      folder.name = label;
      await persist(tree, ns);
      return { ok: true, folder };
    }

    async function move(id, parentId) {
      await loadTree(tree, ns);
      const folder = byId(tree, id);
      if (!folder) return { ok: false, reason: "missing" };
      const parent = norm(parentId);
      if (parent === id) return { ok: false, reason: "self" };
      if (parent && subtreeIds(tree, id).includes(parent)) return { ok: false, reason: "cycle" };
      if (levelOf(tree, parent) + 1 + maxSubDepth(tree, id) > MAX_DEPTH) return { ok: false, reason: "too-deep" };
      if (existsSibling(tree, parent, folder.name, folder.id)) return { ok: false, reason: "duplicate" };
      folder.parentId = parent;
      folder.order = childrenOf(tree, parent).length;
      await persist(tree, ns);
      return { ok: true, folder };
    }

    // 删除 = 级联（对齐 Windows / rm -r 的直觉），但记录不删，只回落「未分类」。
    // 返回的快照用于 toast 里的「撤销」。
    async function remove(id, onDetach = defaultDetach) {
      await loadTree(tree, ns);
      const target = byId(tree, id);
      if (!target) return { ok: false, reason: "missing" };

      const removedIds = subtreeIds(tree, id);
      const removedFolders = tree.items
        .filter((folder) => removedIds.includes(folder.id))
        .map((folder) => ({ ...folder }));

      tree.items = tree.items.filter((folder) => !removedIds.includes(folder.id));
      // 受影响记录由调用方处理：pool 树走 LDFCTopicState，站点书签树走它自己的映射表。
      const affected = (await onDetach?.(removedIds)) || [];
      await persist(tree, ns);
      return { ok: true, removedFolders, affected, descendantCount: removedIds.length - 1 };
    }

    async function restore(removedFolders = [], affected = [], onReattach = defaultReattach) {
      await loadTree(tree, ns);
      for (const folder of removedFolders) {
        if (!byId(tree, folder.id)) tree.items.push({ ...folder });
      }
      await onReattach?.(affected);
      await persist(tree, ns);
    }

    async function assign(topicIds, folderId) {
      if (ns === "site") {
        // 站点书签的归属在 LDFCSiteBookmarks 的映射里，不能写信息池记录。
        throw new Error("site 树没有 assign，请用 LDFCSiteBookmarks.assign");
      }
      const target = norm(folderId);
      let moved = 0;
      for (const topicId of topicIds) {
        const record = await window.LDFCTopicState?.setFolder?.(topicId, target);
        if (record) moved += 1;
      }
      return moved;
    }

    // activeFolderId: null=全部 / "NONE"=未分类 / 否则为文件夹 id（含其子树）
    function matches(record, activeFolderId) {
      if (!activeFolderId) return true;
      const folderId = norm(record?.folderId);
      if (activeFolderId === "NONE") return !folderId;
      if (!folderId) return false;
      return subtreeIds(tree, activeFolderId).includes(folderId);
    }

    return {
      MAX_DEPTH,
      ns,
      assign,
      childrenOf: (parentId) => childrenOf(tree, parentId),
      create,
      depthOf: (id) => depthOf(tree, id),
      folderOf: (record) => norm(record?.folderId),
      isLoaded: () => tree.loaded,
      list: () => tree.items.slice(),
      load: () => loadTree(tree, ns),
      matches,
      move,
      pathOf: (id) => pathOf(tree, id),
      remove,
      rename,
      restore,
      subtreeIds: (id) => subtreeIds(tree, id)
    };
  }

  const poolApi = makeApi("pool");
  window.LDFCFolders = {
    MAX_DEPTH,
    ...poolApi,
    // 默认 API 就是信息池树（poolPanel 等旧调用点不用改）；
    // 站点书签用 LDFCFolders.for("site")。
    for: (ns) => makeApi(ns === "site" ? "site" : "pool")
  };

  // 尽早把配置读进内存：面板第一次渲染就能画出来，不用等用户点开。
  poolApi.load();
})();
