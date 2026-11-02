(() => {
  const POOLS = {
    HOME: "HOME",
    INTERESTED: "INTERESTED",
    READ: "READ",
    DISMISSED: "DISMISSED"
  };

  // 访问记录（visits）的存活时间：超过这个时间还没被确认已读就丢弃，
  // 避免数据库无限增长。
  const VISIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

  // 同一条访问记录最多向原站确认几次；超过就放弃（例如原站永远不返回
  // 阅读位置），避免每次路由变化都发请求。
  const VISIT_MAX_CHECKS = 3;

  // 一个"新回复待处理"的 Topic 最多被定向确认几次。
  // 与 VISIT_MAX_CHECKS 同样的思路：确认是有成本的请求，必须封顶，
  // 否则一条永远确认不成功的记录会每次同步都发一次请求。
  const CONFIRM_MAX_ATTEMPTS = 3;

  const ACTIVITY_SORT = "activity";

  function byActivity(left, right) {
    return (right.lastPostedAt || "").localeCompare(left.lastPostedAt || "");
  }

  const topicState = {
    records: new Map(),
    visits: new Map(),
    // 由 syncService 初始化时注入；写进记录用于同步时的确定性 tie-break。
    deviceId: "",

    setDeviceId(value) {
      this.deviceId = String(value ?? "");
    },

    async load() {
      const [records, visits] = await Promise.all([
        window.LDFCDB.getAllTopics(),
        window.LDFCDB.getVisits()
      ]);

      this.records = new Map(records.map((record) => [record.topicId, record]));

      const now = Date.now();
      this.visits = new Map();

      for (const visit of visits) {
        if (now - (visit.visitedAt || 0) > VISIT_TTL_MS) {
          window.LDFCDB.deleteVisit(visit.topicId).catch(() => {});
          continue;
        }
        this.visits.set(visit.topicId, visit);
      }

      return this.records;
    },

    get(topicId) {
      return this.records.get(String(topicId));
    },

    async updateMetadata(topicId, metadata = {}) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing) return null;

      const record = { ...existing, ...metadata, topicId: key, updatedAt: Date.now() };

      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    // 只写新回复预览，不碰 updatedAt：否则抓一次预览就会把 Topic
    // 顶到所在信息池的最前面，顺序会乱跳。
    async setPreview(topicId, preview = {}) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing) return null;

      const record = {
        ...existing,
        previewForRead: preview.previewForRead ?? existing.previewForRead ?? null,
        previewAuthor: preview.previewAuthor || existing.previewAuthor || "",
        previewText: preview.previewText || existing.previewText || ""
      };

      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    // 匿名（未登录）兜底：本地记录"读到第几楼"。
    // 登录用户不用它 —— 阅读位置一律以 Discourse 为准。
    async setReadSnapshot(topicId, postNumber) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing) return null;

      const record = { ...existing, readUpToPostNumber: postNumber };
      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    async setPool(topicId, basePool, metadata = {}) {
      const key = String(topicId);
      const now = Date.now();
      const existing = this.records.get(key);
      const poolChanged = !existing || existing.basePool !== basePool;

      const record = {
        topicId: key,
        basePool,
        // 用户主动操作统一表示"不再处于新回复暂态"；
        // 只有导入时才会显式传 inNewReply 还原。
        //
        // 注意：新回复是临时状态，不是归属。进入新回复不改变 basePool，
        // 处理完也不需要"搬回去"——它本来就没搬走。
        inNewReply: metadata.inNewReply ?? false,
        // 归属变化即重置定向确认计数
        confirmAttempts: 0,
        enteredPoolAt: metadata.enteredPoolAt ?? (poolChanged ? now : existing?.enteredPoolAt ?? now),
        createdAt: metadata.createdAt ?? existing?.createdAt ?? now,
        updatedAt: metadata.updatedAt ?? now,
        title: metadata.title ?? existing?.title ?? "",
        slug: metadata.slug ?? existing?.slug ?? "",
        excerpt: metadata.excerpt ?? existing?.excerpt ?? "",
        categoryId: metadata.categoryId ?? existing?.categoryId ?? null,
        lastPosterUsername: metadata.lastPosterUsername ?? existing?.lastPosterUsername ?? "",
        lastReadPostNumber: metadata.lastReadPostNumber ?? existing?.lastReadPostNumber ?? null,
        highestPostNumber: metadata.highestPostNumber ?? existing?.highestPostNumber ?? null,
        unreadPosts: metadata.unreadPosts ?? existing?.unreadPosts ?? 0,
        lastPostedAt: metadata.lastPostedAt ?? existing?.lastPostedAt ?? null,
        readUpToPostNumber: metadata.readUpToPostNumber ?? existing?.readUpToPostNumber ?? null,
        previewForRead: existing?.previewForRead ?? null,
        previewAuthor: existing?.previewAuthor ?? "",
        previewText: existing?.previewText ?? "",
        // 站点侧的通知级别缓存（3 关注 / 2 跟踪 / 1 常规 / 0 免打扰）。
        // 当前档位只存本地；真正跨设备的是下面的「手动接管标记」。
        notifyLevel: existing?.notifyLevel ?? null,
        // 非 null 表示"用户手动改过这条"，池子联动从此不再覆盖它。
        notifyManualLevel: existing?.notifyManualLevel ?? null,
        // 手动接管的独立时间戳：只用于同步合并，不参与 updatedAt 的池子排序。
        notifyManualAt: existing?.notifyManualAt ?? null,
        deviceId: existing?.deviceId || this.deviceId || ""
      };

      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    async markNewReply(topicId, metadata = {}) {
      const key = String(topicId);
      const existing = this.records.get(key);
      // 只有「感兴趣」和「已读」会产生新回复提醒；
      // 主信息流本来就是待处理池，不感兴趣则永久安静。
      if (!existing || existing.basePool === POOLS.HOME || existing.basePool === POOLS.DISMISSED) {
        return existing;
      }

      const record = {
        ...existing,
        ...metadata,
        inNewReply: true,
        // 进入新回复区时重置确认计数
        confirmAttempts: 0,
        updatedAt: Date.now()
      };

      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    async clearNewReply(topicId) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing?.inNewReply) return existing;

      const record = {
        ...existing,
        inNewReply: false,
        confirmAttempts: 0,
        updatedAt: Date.now()
      };

      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    // 归属池的列表。默认按"进入该池的时间"倒序，可切换为"最近活动"。
    listByPool(basePool, sort = "entered") {
      const records = [...this.records.values()].filter((record) => record.basePool === basePool);

      if (sort === ACTIVITY_SORT) return records.sort(byActivity);

      return records.sort(
        (left, right) => (right.enteredPoolAt || right.updatedAt || 0) - (left.enteredPoolAt || left.updatedAt || 0)
      );
    },

    listNewReply(sort = "time") {
      const records = [...this.records.values()].filter((record) => record.inNewReply);

      if (sort === "count") {
        return records.sort((left, right) => (right.unreadPosts || 0) - (left.unreadPosts || 0));
      }

      return records.sort(byActivity);
    },

    // ---- 访问记录 ----

    async recordVisit(topicId) {
      const key = String(topicId);
      if (!/^\d+$/.test(key)) return null;

      const record = { topicId: key, visitedAt: Date.now(), checks: 0 };
      this.visits.set(key, record);
      await window.LDFCDB.putVisit(record);
      return record;
    },

    getVisit(topicId) {
      return this.visits.get(String(topicId));
    },

    pendingVisits() {
      return [...this.visits.values()];
    },

    async bumpVisitCheck(topicId) {
      const key = String(topicId);
      const visit = this.visits.get(key);
      if (!visit) return null;

      const record = { ...visit, checks: (visit.checks || 0) + 1 };
      this.visits.set(key, record);
      await window.LDFCDB.putVisit(record);
      return record;
    },

    async bumpConfirmAttempt(topicId) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing) return null;

      const record = { ...existing, confirmAttempts: (existing.confirmAttempts || 0) + 1 };
      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    // 通知级别是站点侧状态；当前档位只存本地。
    // manual=true 表示这是用户手动选的：池子联动从此不再覆盖这条记录，
    // 并把「接管标记」写进云同步。
    // 刻意不动 updatedAt —— 换个通知档位不该被云同步当成"内容更新"。
    async setNotifyLevel(topicId, level, manual = false) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing) return null;

      const value = typeof level === "number" ? level : null;
      const now = Date.now();
      const record = {
        ...existing,
        notifyLevel: value,
        notifyManualLevel: manual ? value : existing.notifyManualLevel ?? null,
        notifyManualAt: manual ? now : existing.notifyManualAt ?? null
      };
      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    async clearNotifyManual(topicId) {
      const key = String(topicId);
      const existing = this.records.get(key);
      if (!existing || existing.notifyManualLevel == null) return existing ?? null;

      const record = { ...existing, notifyManualLevel: null, notifyManualAt: Date.now() };
      this.records.set(key, record);
      await window.LDFCDB.putTopic(record);
      return record;
    },

    async clearVisit(topicId) {
      const key = String(topicId);
      this.visits.delete(key);
      await window.LDFCDB.deleteVisit(key);
    },

    async clearVisits() {
      this.visits = new Map();
      await window.LDFCDB.clearVisits();
    },

    ACTIVITY_SORT,
    CONFIRM_MAX_ATTEMPTS,
    VISIT_MAX_CHECKS
  };

  window.LDFCTopicState = topicState;
})();
