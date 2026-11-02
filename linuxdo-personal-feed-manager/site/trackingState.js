(() => {
  // 读取页面已经加载好的 Discourse 跟踪状态（#data-preloaded 里的 topicTrackingStates）。
  //
  // 它只负责两件事，别让它兼任第三件：
  //   1. discovery     —— 哪些被跟踪的 Topic 现在有未读
  //   2. current-state —— 某个 Topic 在**当前快照**里还有没有未读
  //
  // 它**不是**权威事实来源，原因有两个（都是真实站点实测到的）：
  //   - 它是整页加载时的**快照**，SPA 内部导航不会刷新它；
  //   - 它是**有界窗口**（实测 195~210 行），覆盖不到用户的全部 Topic。
  //
  // 因此调用方必须按这个语义使用：
  //   - unread > 0  → 可以确信"还有未读"（用来省掉无谓的确认请求）
  //   - 查到 0      → 只是"快照里是 0"，不能当作"服务器此刻一定没有未读"
  //   - 查不到(null)→ 未知，必须走定向确认，**不能当成 0**
  //
  // 【实现候选】数据来源本身在规格里没有指定；这是 Phase 0 真实站点侦察
  // 找到的零请求数据源，语义已与 /unread.json 交叉验证一致（8/8 样本）。

  let cacheKey = null;
  let cache = null;

  // 真实站点上这些值是"被 JSON 编码过的字符串"，需要二次解析。
  function parseMaybeJson(value) {
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  function unreadFrom(lastRead, highest) {
    const high = Number(highest || 0);
    if (!high) return 0;
    const last = Number(lastRead || 0);
    // 从没读过 → 整帖都算未读
    if (!last) return high;
    return high > last ? high - last : 0;
  }

  function snapshot() {
    const element = document.getElementById("data-preloaded");
    const text = element ? element.textContent || "" : "";

    if (!text) {
      cacheKey = null;
      cache = null;
      return null;
    }
    // 同一份快照只解析一次
    if (text === cacheKey) return cache;

    cacheKey = text;
    try {
      const preload = JSON.parse(text);
      const rows = parseMaybeJson(preload?.topicTrackingStates);
      if (!Array.isArray(rows)) {
        cache = null;
        return null;
      }

      const map = new Map();
      for (const row of rows) {
        if (row?.topic_id === undefined || row?.topic_id === null) continue;
        const topicId = String(row.topic_id);
        map.set(topicId, {
          topicId,
          lastReadPostNumber: row.last_read_post_number ?? null,
          highestPostNumber: row.highest_post_number ?? null,
          notificationLevel: row.notification_level ?? null,
          unread: unreadFrom(row.last_read_post_number, row.highest_post_number)
        });
      }
      cache = map;
      return cache;
    } catch {
      cache = null;
      return null;
    }
  }

  // 未知返回 null（不是 0）—— 这个区别是整个完成判定正确性的关键。
  function unreadFor(topicId) {
    const row = rowFor(topicId);
    return row ? row.unread : null;
  }

  function rowFor(topicId) {
    const map = snapshot();
    if (!map) return null;
    return map.get(String(topicId)) ?? null;
  }

  function unreadTopicIds() {
    const map = snapshot();
    if (!map) return [];
    return [...map.values()].filter((row) => row.unread > 0).map((row) => row.topicId);
  }

  function windowSize() {
    const map = snapshot();
    return map ? map.size : 0;
  }

  window.LDFCTrackingState = { rowFor, snapshot, unreadFor, unreadTopicIds, windowSize };
})();
