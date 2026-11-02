(() => {
  // 话题「通知级别」的唯一入口。
  //
  // 这是**站点侧状态**（Discourse 的 TopicUser.notification_level），
  // 不是本插件自己的归属数据：
  //   - 写入会真的改变你在 linux.do 的邮件 / 推送通知设置；
  //   - 当前档位缓存只存本地；只有「用户手动接管过这条」的标记
  //     （notifyManualLevel + notifyManualAt）进云同步。
  //   - 标记用独立时间戳合并，不参与 updatedAt 的池子排序 / LWW。
  //
  // 三条规则（用户拍板）：
  //   1. 手动优先：用户在这条帖子上手动选过，池子联动就不再覆盖它；
  //   2. 撤销回滚：撤销移池要顺带把通知改回操作前的档位；
  //   3. 自动已读不触发联动，只有用户主动移池才算。
  const META_KEY = "notifyLinkage";

  const LABELS = { 0: "免打扰", 1: "常规", 2: "跟踪", 3: "关注", 4: "关注" };
  // 4 = watching_first_post（只关注首楼），原站菜单里同样显示成「关注」。
  const LEVELS = [3, 2, 1, 0];

  const DEFAULT_SETTINGS = {
    showInPreview: true,
    showInTopic: true,
    linkPools: true,
    // 自动已读（读到底后自动进入「已读」）要不要顺手改通知。
    // null = 不修改，保持用户原站设置；默认关闭，避免自动动作过于侵入。
    autoReadLevel: null,
    // null = 不修改。默认值由用户指定：感兴趣→关注、已读→跟踪、不感兴趣→免打扰。
    map: { INTERESTED: 3, READ: 2, DISMISSED: 0 }
  };

  let settings = clone(DEFAULT_SETTINGS);
  const listeners = new Set();
  // 本会话里已经问过站点的话题，避免重复请求（失败也记账，不反复重试）。
  const probed = new Set();

  function clone(value) {
    return { ...value, map: { ...value.map } };
  }

  function emit() {
    for (const listener of listeners) {
      try {
        listener(settings);
      } catch {
        // 单个订阅者出错不影响其他人
      }
    }
  }

  // ---- 设置 ----

  async function loadSettings() {
    try {
      const saved = await window.LDFCDB.getMeta(META_KEY);
      if (saved && typeof saved === "object") {
        settings = {
          showInPreview: saved.showInPreview !== false,
          showInTopic: saved.showInTopic !== false,
          linkPools: saved.linkPools !== false,
          autoReadLevel:
            typeof saved.autoReadLevel === "number" ? saved.autoReadLevel : null,
          map: { ...DEFAULT_SETTINGS.map, ...(saved.map || {}) }
        };
      }
    } catch {
      // 读不到就用默认值
    }
    return settings;
  }

  async function setSettings(patch) {
    settings = {
      ...settings,
      ...patch,
      map: { ...settings.map, ...(patch.map || {}) }
    };
    try {
      await window.LDFCDB.putMeta(META_KEY, settings);
    } catch {
      // 写不进去不影响本次会话
    }
    emit();
    return settings;
  }

  function getSettings() {
    return clone(settings);
  }

  function onChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---- 站点读写 ----

  function currentUser() {
    return window.LDFCIdentity?.current?.() ?? { loggedIn: false };
  }

  function csrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.getAttribute("content") ?? "";
  }

  async function fetchLevel(topicId) {
    try {
      const response = await fetch(`/t/${topicId}.json`, {
        credentials: "include",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) return null;
      const data = await response.json();
      const level = data?.notification_level ?? data?.details?.notification_level;
      if (typeof level !== "number") return null;
      await window.LDFCTopicState?.setNotifyLevel?.(topicId, level, false);
      return level;
    } catch {
      return null;
    }
  }

  async function postLevel(topicId, level) {
    // Discourse 自己的 ajax 会带 CSRF；裸 fetch 必须手动补，否则会被拒。
    const token = csrfToken();
    if (!token) throw new Error("没有拿到站点的 CSRF 令牌，请刷新页面重试");

    const response = await fetch(`/t/${topicId}/notifications`, {
      method: "POST",
      credentials: "include",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-Token": token
      },
      body: `notification_level=${encodeURIComponent(String(level))}`
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  // 读当前档位：本地记录 → 页面快照（零请求）→ 按需请求一次。
  async function resolve(topicId) {
    const key = String(topicId);
    const record = window.LDFCTopicState?.get?.(key);
    if (record && typeof record.notifyLevel === "number") return record.notifyLevel;

    const snapshot = window.LDFCTrackingState?.rowFor?.(key)?.notificationLevel;
    if (typeof snapshot === "number") {
      probed.add(key);
      await window.LDFCTopicState?.setNotifyLevel?.(key, snapshot, false);
      return snapshot;
    }

    if (probed.has(key)) return null;
    probed.add(key);
    return fetchLevel(key);
  }

  // 写档位。manual 默认 true：调用方不特别说明，就当成用户手动改的。
  async function set(topicId, level, options = {}) {
    const manual = options.manual !== false;
    const key = String(topicId);
    await postLevel(key, level);
    probed.add(key);
    await window.LDFCTopicState?.setNotifyLevel?.(key, level, manual);
    // 手动接管标记要尽快进同步；自动联动不改标记，不需要额外推送。
    if (manual) window.LDFCSyncService?.schedulePush?.();
    return level;
  }

  // ---- 池子联动 ----

  // 返回 { applied, previous, reason }。
  // previous 是操作前的档位（可能 null = 不知道），撤销时用它回滚。
  async function applyPoolMapping(topicId, pool) {
    if (!settings.linkPools) return { applied: false, reason: "linkage-off" };

    const target = settings.map?.[pool];
    if (typeof target !== "number") return { applied: false, reason: "no-map" };

    const record = window.LDFCTopicState?.get?.(topicId);
    if (!record) return { applied: false, reason: "no-record" };

    // 手动优先：用户自己选过这条，池子不许覆盖。
    if (record.notifyManualLevel != null) return { applied: false, reason: "manual" };

    // 别拿一个必然失败的结果去打扰移池流程：未登录时不写。
    if (!currentUser().loggedIn) return { applied: false, reason: "guest" };

    const previous = typeof record.notifyLevel === "number" ? record.notifyLevel : null;
    try {
      await set(topicId, target, { manual: false });
      return { applied: true, previous };
    } catch (error) {
      // 移池本身已经成功，通知失败不该让整个操作报错。
      console.warn("[LDFC] 通知联动失败", error);
      return { applied: false, reason: "error", previous, error };
    }
  }

  // 自动已读的独立映射。它和用户主动移池分开配置：
  //   - 仍受 linkPools 总开关控制；
  //   - 默认 autoReadLevel = null（不修改）；
  //   - 手动接管优先，用户自己设过就不再覆盖。
  async function applyAutoRead(topicId) {
    if (!settings.linkPools) return { applied: false, reason: "linkage-off" };

    const target = settings.autoReadLevel;
    if (typeof target !== "number") return { applied: false, reason: "no-map" };

    const record = window.LDFCTopicState?.get?.(topicId);
    if (!record) return { applied: false, reason: "no-record" };
    if (record.notifyManualLevel != null) return { applied: false, reason: "manual" };
    if (!currentUser().loggedIn) return { applied: false, reason: "guest" };
    if (record.notifyLevel === target) return { applied: false, reason: "same" };

    const previous = typeof record.notifyLevel === "number" ? record.notifyLevel : null;
    try {
      await set(topicId, target, { manual: false });
      return { applied: true, previous };
    } catch (error) {
      console.warn("[LDFC] 自动已读通知联动失败", error);
      return { applied: false, reason: "error", previous, error };
    }
  }

  // 撤销移池时把通知改回去。previous 未知就什么也不做。
  async function revert(topicId, previous) {
    if (typeof previous !== "number") return false;
    try {
      await set(topicId, previous, { manual: false });
      return true;
    } catch (error) {
      console.warn("[LDFC] 通知回滚失败", error);
      return false;
    }
  }

  // 「跟随信息池」：解除手动接管，并按当前归属立刻应用一次映射。
  async function followPool(topicId) {
    await window.LDFCTopicState?.clearNotifyManual?.(topicId);
    window.LDFCSyncService?.schedulePush?.();
    const pool = window.LDFCTopicState?.get?.(topicId)?.basePool;
    if (!pool) return { applied: false, reason: "no-record" };
    return applyPoolMapping(topicId, pool);
  }

  window.LDFCNotify = {
    DEFAULT_SETTINGS,
    LABELS,
    LEVELS,
    applyAutoRead,
    applyPoolMapping,
    followPool,
    getSettings,
    loadSettings,
    onChange,
    resolve,
    revert,
    set,
    setSettings
  };
})();
