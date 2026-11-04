(() => {
  // linux.do 站点书签（Discourse /u/<username>/bookmarks.json）的读取与归类。
  //
  // 为什么单独一层：
  //   1. 站点书签与「信息池」是两套数据，站点侧没有文件夹概念，归类只能存在本地；
  //   2. 列表接口一次就返回标题/摘要/作者/标签/URL，不需要再补请求（省资源）；
  //   3. 预览窗的「书签」按钮也复用这里的缓存，避免每点一次都拉全量。
  //
  // 归属：meta['ldfc.siteBookmarkFolders'] = { [bookmarkId]: folderId }
  // 文件夹树本身走 LDFCFolders.for("site")，两边正交。
  const CACHE_KEY = "ldfc.siteBookmarks";
  const MAP_KEY = "ldfc.siteBookmarkFolders";
  const TTL_MS = 10 * 60 * 1000;
  const MAX_PAGES = 20;

  let cache = null; // { fetchedAt, username, items: [...] }
  let loading = null;
  let folderMap = null; // { [bookmarkId]: folderId }

  const normalize = (raw) => ({
    id: Number(raw.id),
    topicId: Number(raw.topic_id ?? raw.bookmarkable_id),
    title: raw.fancy_title || raw.title || "",
    excerpt: String(raw.excerpt || "").replace(/\s+/g, " ").trim(),
    url: raw.bookmarkable_url || `/t/topic/${raw.topic_id ?? raw.bookmarkable_id}`,
    postNumber: raw.linked_post_number ?? null,
    author: raw.user?.username || "",
    authorName: raw.user?.name || raw.user?.username || "",
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => t.name) : [],
    categoryId: raw.category_id ?? null,
    createdAt: raw.created_at || "",
    note: raw.name || ""
  });

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || "";
  }

  async function currentUsername() {
    if (cache?.username) return cache.username;
    try {
      const res = await fetch("/session/current.json", { credentials: "same-origin" });
      if (!res.ok) return null;
      const json = await res.json();
      return json.current_user?.username || null;
    } catch {
      return null;
    }
  }

  async function readFolderMap() {
    if (folderMap) return folderMap;
    try {
      const saved = await window.LDFCDB.getMeta(MAP_KEY);
      folderMap = saved && typeof saved === "object" ? { ...saved } : {};
    } catch {
      folderMap = {};
    }
    return folderMap;
  }

  async function writeFolderMap() {
    try {
      await window.LDFCDB.putMeta(MAP_KEY, folderMap || {});
    } catch {
      // 本地写失败不影响本次会话
    }
  }

  async function fetchAll(username) {
    const items = [];
    let page = 0;
    let complete = false;
    while (page < MAX_PAGES) {
      const res = await fetch(`/u/${username}/bookmarks.json?page=${page}`, {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      // 非 2xx 不能当成「书签为 0」：后面的对账会把本地分类映射整片删掉。
      if (!res.ok) throw new Error(`读取书签失败：${res.status}`);
      const json = await res.json();
      const list = json.user_bookmark_list;
      if (!list) throw new Error("书签接口返回格式异常");
      for (const raw of list.bookmarks || []) items.push(normalize(raw));
      if (!list.more_bookmarks_url) {
        complete = true;
        break;
      }
      page += 1;
    }
    // 翻到上限还没完 = 只拿到部分数据，不能拿它做删除对账。
    return { items, complete };
  }

  async function persistCache() {
    if (!cache) return;
    try {
      await window.LDFCDB.putMeta(CACHE_KEY, cache);
    } catch {
      // 缓存写失败只是下次要重新拉
    }
  }

  // 文件夹归属以 meta 映射为准：缓存可能是移动前写的，返回前统一覆盖一次。
  async function applyFolderMap() {
    if (!cache?.items) return;
    const map = await readFolderMap();
    for (const item of cache.items) item.folderId = map[String(item.id)] || null;
  }

  // 列表缓存 10 分钟：开面板不重复打服务器，手动「刷新」可强制。
  async function load({ refresh = false } = {}) {
    if (loading) return loading;
    const fresh = cache && Date.now() - cache.fetchedAt < TTL_MS;
    if (fresh && !refresh) {
      await applyFolderMap();
      return cache;
    }

    loading = (async () => {
      if (!cache) {
        try {
          const saved = await window.LDFCDB.getMeta(CACHE_KEY);
          if (saved && Array.isArray(saved.items)) cache = saved;
        } catch {
          // 读不到就当没有缓存
        }
      }
      if (cache && !refresh && Date.now() - cache.fetchedAt < TTL_MS) {
        await applyFolderMap();
        loading = null;
        return cache;
      }

      const username = await currentUsername();
      if (!username) {
        loading = null;
        return cache || { fetchedAt: 0, username: null, items: [] };
      }
      const { items, complete } = await fetchAll(username);
      const map = await readFolderMap();
      for (const item of items) item.folderId = map[String(item.id)] || null;

      // 对账：站点上已经删掉的书签，本地映射也清掉，避免越积越多
      if (complete) {
        const alive = new Set(items.map((item) => String(item.id)));
        let pruned = false;
        for (const key of Object.keys(map)) {
          if (!alive.has(key)) {
            delete map[key];
            pruned = true;
          }
        }
        if (pruned) await writeFolderMap();
      }

      cache = { fetchedAt: Date.now(), username, items };
      await persistCache();
      loading = null;
      window.dispatchEvent(new CustomEvent("ldfc:site-bookmarks-changed"));
      return cache;
    })().finally(() => {
      // 网络异常时也要把 loading 复位，否则后续所有 load() 都会拿到同一个失败 Promise。
      loading = null;
    });
    return loading;
  }

  function items() {
    return cache?.items ? cache.items.slice() : [];
  }

  function folderOf(bookmark) {
    return bookmark?.folderId || null;
  }

  async function assign(bookmarkIds, folderId) {
    const map = await readFolderMap();
    const target = folderId ? String(folderId) : null;
    for (const id of bookmarkIds) {
      if (target) map[String(id)] = target;
      else delete map[String(id)];
      const item = cache?.items?.find((entry) => String(entry.id) === String(id));
      if (item) item.folderId = target;
    }
    await writeFolderMap();
    await persistCache();
    window.dispatchEvent(new CustomEvent("ldfc:site-bookmarks-changed"));
    return bookmarkIds.length;
  }

  // 文件夹被删（含级联）时，把受影响的书签回落「未分类」，返回快照供撤销。
  async function detachFolders(folderIds) {
    const map = await readFolderMap();
    const affected = [];
    for (const [id, folderId] of Object.entries(map)) {
      if (folderIds.includes(folderId)) {
        affected.push({ bookmarkId: id, folderId });
        delete map[id];
        const item = cache?.items?.find((entry) => String(entry.id) === id);
        if (item) item.folderId = null;
      }
    }
    if (affected.length) await writeFolderMap();
    if (affected.length) await persistCache();
    return affected;
  }

  async function reattachFolders(affected) {
    const map = await readFolderMap();
    for (const entry of affected ?? []) {
      map[entry.bookmarkId] = entry.folderId;
      const item = cache?.items?.find((one) => String(one.id) === String(entry.bookmarkId));
      if (item) item.folderId = entry.folderId;
    }
    await writeFolderMap();
    await persistCache();
  }

  // 预览窗 / 书签面板里的单条切换。返回 { bookmarked: boolean }
  async function toggle(topicId) {
    const known = items().find((item) => String(item.topicId) === String(topicId));
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    const token = csrfToken();
    if (token) headers["X-CSRF-Token"] = token;

    if (known) {
      const res = await fetch(`/bookmarks/${known.id}`, {
        method: "DELETE",
        credentials: "same-origin",
        headers
      });
      if (!res.ok) throw new Error(`取消书签失败：${res.status}`);
      cache.items = cache.items.filter((item) => item.id !== known.id);
    } else {
      const res = await fetch("/bookmarks", {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({ bookmarkable_id: Number(topicId), bookmarkable_type: "Topic" })
      });
      if (!res.ok) throw new Error(`书签写入失败：${res.status}`);
      const created = await res.json().catch(() => null);
      if (created?.id) {
        cache = cache || { fetchedAt: Date.now(), username: null, items: [] };
        cache.items.unshift(
          normalize({
            id: created.id,
            topic_id: topicId,
            bookmarkable_url: `/t/topic/${topicId}`,
            created_at: new Date().toISOString()
          })
        );
        cache.fetchedAt = 0; // 让面板下次打开重新对账
      } else {
        // 创建成功但没拿到 id：不造 `tmp-` 假条目（Number('tmp-…') = NaN，
        // 之后既取消不了、也参与不了对账），下次打开面板重新拉。
        cache = null;
      }
    }
    await persistCache();
    window.dispatchEvent(new CustomEvent("ldfc:site-bookmarks-changed"));
    return { bookmarked: !known };
  }

  function isBookmarked(topicId) {
    return items().some((item) => String(item.topicId) === String(topicId));
  }

  window.LDFCSiteBookmarks = {
    CACHE_TTL: TTL_MS,
    assign,
    detachFolders,
    folderOf,
    isBookmarked,
    items,
    load,
    reattachFolders,
    toggle
  };
})();
