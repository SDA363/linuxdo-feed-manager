(() => {
  function isTopicPage() {
    return /^\/t\//.test(window.location.pathname);
  }

  function currentRoute() {
    return `${window.location.pathname}${window.location.search}`;
  }

  let lastRoute = null;
  let routeTimer;
  let syncTimer;
  let syncInFlight = false;

  async function markInterested(topic) {
    await window.LDFCPoolManager.markInterested(topic);
    collapseRow(topic.row);
    window.LDFCNavigation.render();
    window.LDFCToast.show("已移入“感兴趣”", "撤销", async () => {
      // 撤销要连通知一起退回，否则只退了一半（消息说撤销了，通知还留着）。
      const previousNotify = window.LDFCPoolManager.takeNotifyRevert(topic.topicId);
      await window.LDFCPoolManager.moveHome(topic.topicId);
      if (previousNotify !== null) await window.LDFCNotify?.revert?.(topic.topicId, previousNotify);
      window.LDFCNavigation.render();
      window.LDFCFilter.applyRows();
    });
  }

  async function markDismissed(topic) {
    await window.LDFCPoolManager.markDismissed(topic);
    collapseRow(topic.row);
    window.LDFCNavigation.render();
    window.LDFCToast.show("已移入“不感兴趣”", "撤销", async () => {
      const previousNotify = window.LDFCPoolManager.takeNotifyRevert(topic.topicId);
      await window.LDFCPoolManager.moveHome(topic.topicId);
      if (previousNotify !== null) await window.LDFCNotify?.revert?.(topic.topicId, previousNotify);
      window.LDFCNavigation.render();
      window.LDFCFilter.applyRows();
    });
  }

  // 手动标记已读：给自动判定兜底。
  // 自动已读依赖 Discourse 自己更新阅读位置（timing 上报有几秒延迟，
  // 且只重试有限次数），读完立刻返回列表时经常还没生效。
  async function markRead(topic) {
    await window.LDFCPoolManager.markRead(topic.topicId, {
      title: topic.title,
      slug: topic.slug
    });
    collapseRow(topic.row);
    window.LDFCNavigation.render();
    window.LDFCToast.show("已移入“已读”", "撤销", async () => {
      const previousNotify = window.LDFCPoolManager.takeNotifyRevert(topic.topicId);
      await window.LDFCPoolManager.moveHome(topic.topicId);
      if (previousNotify !== null) await window.LDFCNotify?.revert?.(topic.topicId, previousNotify);
      window.LDFCNavigation.render();
      window.LDFCFilter.applyRows();
    });
  }

  function collapseRow(row) {
    // 先清掉上一轮残留的内联样式，撤销后重新折叠也要从干净状态开始。
    const reset = () => {
      row.classList.remove("ldfc-collapsing");
      row.style.removeProperty("height");
      row.style.removeProperty("overflow");
      row.style.removeProperty("opacity");
      for (const cell of row.querySelectorAll(":scope > td")) {
        cell.style.removeProperty("padding-top");
        cell.style.removeProperty("padding-bottom");
        cell.style.removeProperty("font-size");
        cell.style.removeProperty("line-height");
      }
    };

    const height = row.getBoundingClientRect().height;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (!height || reduced) {
      reset();
      row.style.display = "none";
      row.classList.add("ldfc-row-hidden");
      return;
    }

    // 之前是 max-height: auto → 0 —— CSS 不能从 auto 插值，所以实际只有淡出，
    // 高度是硬切、下面几行瞬间跳上来。这里量出真实高度写成定值再收到 0。
    row.style.height = `${height}px`;
    row.style.overflow = "hidden";
    void row.offsetHeight; // 强制一次重排，否则起始高度和动画首帧会合并
    row.classList.add("ldfc-collapsing");
    row.style.height = "0px";
    row.style.opacity = "0";
    // td 的 padding / 字号不收掉的话，单元格内容会把行重新撑开。
    for (const cell of row.querySelectorAll(":scope > td")) {
      cell.style.paddingTop = "0px";
      cell.style.paddingBottom = "0px";
      cell.style.fontSize = "0px";
      cell.style.lineHeight = "0px";
    }

    setTimeout(() => {
      reset();

      // 折叠动画这 340ms 内用户可能已经点了 Toast 的「撤销」，
      // 记录又回到 HOME。这时必须让行重新显示，否则会出现
      // "状态是主信息流、行却不见了" 的残留。
      const record = window.LDFCTopicState.get(row.dataset.topicId);
      if (!record || (record.basePool === "HOME" && !record.inNewReply)) {
        window.LDFCFilter.applyRows();
        return;
      }

      row.style.display = "none";
      row.classList.add("ldfc-row-hidden");
    }, 340);
  }

  // 记录"用户真的打开过这个 Topic"。自动已读只认这里的记录，
  // 所以安装之前看过的 Topic 不会被猜成已读。
  function recordVisitFromLocation() {
    const parsed = window.LDFCTopicParser.parseTopicUrl(window.location.pathname);
    if (!parsed) return;
    window.LDFCTopicState.recordVisit(parsed.topicId).catch(() => {});
  }

  function decorateRows() {
    // 搜索结果页、话题页底部的「推荐 / 相关」也注入按钮：
    // 用户看到一条标题就能标记，不用先回到主列表。
    // 这些页面依然**不做五区过滤**（见 core/filter.js），
    // 只是多了手动标记入口 —— 过滤是自动的，标记是用户主动的。
    const feedPage = !window.LDFCTopicParser.isFilterExcluded();

    let decorated = 0;

    for (const row of window.LDFCTopicParser.listRows()) {
      const topic = window.LDFCTopicParser.extractTopic(row);
      if (!topic) continue;
      window.LDFCDesktopActions.decorateRow(topic);
      decorated += 1;
    }

    // 搜索页 / 话题页按既有规则不做五区过滤；
    // 在话题页调用 applyRows 反而会把「推荐 / 相关」整块藏掉。
    if (feedPage) window.LDFCFilter.applyRows();

    // 列表行的创建时间标签会被站点重渲染冲掉，每次装饰时补一次。
    window.LDFCListMeta?.render?.();

    // 自动补位只属于主信息流：搜索页 / 话题页没有"列表到底"这回事，
    // 在那里触发原站的"加载更多"会变成莫名其妙的翻滚。
    if (decorated && feedPage) setTimeout(() => window.LDFCAutofill.maybeFill(), 250);

    // 行是原地复用的（撤销后恢复 display），按钮层不重建，光效要单独补一遍。
    window.LDFCDesktopActions?.paintAll?.();
    window.LDFCNavigation.render();
  }

  function observeRoute() {
    // Discourse 的 pushState / replaceState 由注入到主世界的
    // site/routeObserverMain.js 转发成路由变化事件，内容脚本在这里接收。
    // 隔离世界里改写 history 拦不到主世界的调用。
    window.addEventListener("ldfc:route-change", handleRouteChange);
    window.addEventListener("popstate", handleRouteChange);
  }

  function handleRouteChange() {
    clearTimeout(routeTimer);
    routeTimer = setTimeout(() => {
      const route = currentRoute();
      // Discourse 会为了记录滚动位置频繁调用 replaceState。
      // 如果路由没变，就不要重置当前信息池，否则用户一滚动就被弹回主信息流。
      const routeChanged = route !== lastRoute;
      lastRoute = route;

      // 阅读页入口（首楼按钮行 / 预览弹窗头部）依赖当前 DOM，
      // 路由一变就先补一次；后续渲染由 launcher 自己的观察器接住。
      window.LDFCLauncher?.refresh?.();

      if (isTopicPage()) {
        recordVisitFromLocation();
        // 话题页底部有「推荐 / 相关」，同样是可标记的标题行。
        decorateRows();
        window.LDFCNavigation.render();
        return;
      }

      if (routeChanged) {
        window.LDFCFilter.setActivePool("HOME");
        window.LDFCPoolPanel.render("HOME");
      }

      decorateRows();

      if (routeChanged) syncListState(0);
    }, 200);
  }
  function observeDom() {
    const observer = new MutationObserver((mutations) => {
      const hasTopicNodes = mutations.some((mutation) =>
        [...mutation.addedNodes].some((node) =>
          node.nodeType === Node.ELEMENT_NODE &&
          (node.matches?.("[data-topic-id], .topic-list-body, .latest-topic-list") ||
            node.querySelector?.("[data-topic-id], .topic-list-body, .latest-topic-list"))
        )
      );

      if (!hasTopicNodes) return;
      clearTimeout(observer.timer);
      observer.timer = setTimeout(decorateRows, 100);
    });

    observer.observe(document.body, { childList: true, subtree: true });
  }

  // 从 Topic 返回列表时，Discourse 会原地重渲染行的内容，
  // 挂在行上的操作按钮会被一起移除；Ember 复用节点的情况下
  // MutationObserver 的 addedNodes 判据不一定成立，按钮就再也补不回来，
  // 表现为"打开过一次 Topic，回来 hover 就没有按钮了，刷新才恢复"。
  //
  // 不猜 Discourse 什么时候渲染完：鼠标真正进入某一行时按需补挂，
  // 这也是用户唯一需要按钮的时刻。decorateRow 本身是幂等的。
  function observePointer() {
    document.addEventListener(
      "pointerover",
      (event) => {
        const row = event.target?.closest?.(
          ".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id], " +
            "tr[data-topic-id], .fps-result[data-topic-id], .search-result[data-topic-id], " +
            ".more-topics__list-item[data-topic-id], .suggested-topics [data-topic-id]"
        );
        // 行内标题链接也带 data-topic-id：别把按钮层挂进 <a> 里。
        // 搜索页 / 话题页现在也能标记，所以不再按"是否过滤页面"提前返回。
        if (!row || row.tagName === "A") return;

        // 原站重渲染会重写整条 class 属性，附加的 ldFC 类名会被冲掉，
        // 按钮层却还留在行上。只看"有没有按钮层"会把这种行当成已处理，
        // 类名再也补不回来，表现为滚动加载后悬浮完全没有按钮。
        const layer = row.querySelector(".ldfc-actions");
        if (
          layer &&
          row.classList.contains("ldfc-topic-row") &&
          layer.dataset.ldfcTopic === row.dataset.topicId
        ) {
          return;
        }

        const topic = window.LDFCTopicParser.extractTopic(row);
        if (topic) window.LDFCDesktopActions.decorateRow(topic);
      },
      true
    );
  }

  // attempt 是"本轮返回列表后的第几次尝试"。
  // Discourse 通过 /topics/timings 上报阅读时长，通常要几秒才生效，
  // 所以回到列表后只查一次很容易漏判，需要有限重试。
  async function syncListState(attempt = 0) {
    clearTimeout(syncTimer);

    if (isTopicPage() || !window.LDFCDiscourseAdapter.canFetchList()) return;

    syncTimer = setTimeout(async () => {
      if (syncInFlight) return;
      syncInFlight = true;

      try {
        // 用户在本轮同步之前访问过哪些 Topic。
        // 必须在任何状态变更之前取走 —— promotePendingVisits 会把访问记录清掉。
        const visitedTopicIds = window.LDFCTopicState.pendingVisits().map((visit) => visit.topicId);

        const [latestTopics, unreadTopics] = await Promise.all([
          window.LDFCDiscourseAdapter.fetchLatestList(),
          window.LDFCDiscourseAdapter.fetchUnreadList()
        ]);

        // 两个列表都可能返回 null（未登录 / 站点防护 / 网络失败）。
        // 返回 null 时对应步骤整段跳过，绝不能当成"空列表"处理。
        if (latestTopics) await window.LDFCPoolManager.syncWithDiscourse(latestTopics);

        // 新回复分三层，用途互不混用：
        //   发现     —— /unread.json 第 0 页 + /latest.json 非 null 未读数
        //                + tracking 快照（三者都可能零额外请求）
        //   完成确认 —— 只对"新回复待处理"的 Topic 做定向确认
        await window.LDFCPoolManager.discoverNewReplies(unreadTopics, latestTopics);
        await window.LDFCPoolManager.promotePendingVisits(latestTopics);
        await window.LDFCPoolManager.confirmNewReplyCompletions(visitedTopicIds);

        window.LDFCNavigation.render();
        window.LDFCFilter.applyRows();

        const activePool = window.LDFCFilter.getActivePool();
        if (activePool !== "HOME") window.LDFCPoolPanel.render(activePool);
      } finally {
        syncInFlight = false;
      }

      if (attempt < 2 && window.LDFCTopicState.pendingVisits().length > 0) {
        setTimeout(() => syncListState(attempt + 1), 2000);
      }
    }, 500);
  }

  window.LDFCContent = { decorateRows, markDismissed, markInterested, markRead };

  // 同步（自动或手动）改完本地状态后，列表与计数不会自己重画。
  // 手动「立即同步」也必须走这里，否则用户会以为"没拉到"。
  function refreshAfterSync() {
    window.LDFCNavigation.render();
    window.LDFCFilter.applyRows();
    const activePool = window.LDFCFilter.getActivePool();
    if (activePool !== "HOME") window.LDFCPoolPanel.render(activePool);
  }

  window.LDFCRefreshAfterSync = refreshAfterSync;

  async function boot() {
    await window.LDFCTopicState.load();

    // 只做本地准备（deviceId、自动同步开关），不联网。
    try {
      await window.LDFCSyncService.init();
    } catch {
      // 同步服务不可用时不影响本地功能。
    }

    // 通知联动设置：纯本地读取，不联网。
    try {
      await window.LDFCNotify?.loadSettings?.();
    } catch {
      // 读不到就用默认值
    }

    window.LDFCNavigation.create();
    window.LDFCSwipe.start();
    window.LDFCPoolPanel.create();
    await window.LDFCPoolPanel.loadSortPreference();
    await window.LDFCSettings.create();
    window.LDFCNavigation.render();
    window.LDFCSettings.addLaunchButton();
    window.LDFCLauncher?.refresh?.();
    window.LDFCLauncher?.observe?.();
    window.LDFCPreview?.start?.();

    lastRoute = currentRoute();
    if (isTopicPage()) {
      recordVisitFromLocation();
    }
    decorateRows();

    observeDom();
    observePointer();
    observeRoute();

    // 打开站点自动拉一次；没有配置远端时立即结束。
    // 先拉后同步列表，避免两边同时改 topicState 互相覆盖。
    Promise.resolve()
      .then(() => window.LDFCSyncService.pullOnce())
      .then((result) => {
        if (!result?.changed) return;
        refreshAfterSync();
      })
      .catch(() => {})
      .finally(() => syncListState(0));
  }

  async function start() {
    try {
      await boot();
    } catch (error) {
      // 以前这里失败是完全静默的：页面没有 UI、控制台也看不到，
      // 只能靠"扩展重载后旧标签页"这类经验去猜。
      console.error("[LDFC] 初始化失败", error);
      try {
        window.LDFCToast?.show?.(`插件初始化失败：${error?.message || error}，请刷新页面`);
      } catch {
        // 提示本身失败也不影响，控制台已记录
      }
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
