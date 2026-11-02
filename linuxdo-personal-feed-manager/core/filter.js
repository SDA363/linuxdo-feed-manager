(() => {
  let activePool = "HOME";
  // 进入池子视图时列表会被整体隐藏，容器高度会塌成 0。
  // Discourse 的无限滚动据此判定"已经滚到底"，会不停加载下一页，
  // 表现出来就是页面一直刷新。所以切走前先量下高度并钉住。
  let pinnedList = null;
  let pinnedHeight = 0;

  function listContainer() {
    const standard = document.querySelector(".topic-list, .latest-topic-list, .topic-list-body");
    if (standard) return standard;

    // linux.do 的卡片主题不一定保留 Discourse 标准容器类名，
    // 退回到所有 Topic 行共同的父节点。
    const rows = window.LDFCTopicParser.listRows();
    return rows.length ? rows[0].parentElement : null;
  }

  function pinListHeight() {
    const list = listContainer();
    if (!list) return;
    pinnedList = list;
    pinnedHeight = list.getBoundingClientRect().height;
  }

  function unpinListHeight() {
    if (pinnedList) pinnedList.style.removeProperty("min-height");
    pinnedList = null;
    pinnedHeight = 0;
  }

  function show(row) {
    row.classList.remove("ldfc-row-hidden");
    row.style.removeProperty("display");
  }

  function applyRows() {
    // 搜索页 / 帖子页**永远不做五区过滤**（用户主动检索不应被干预）。
    // 之前这里多了个 activePool === "HOME" 的前提，导致用户在搜索页点过
    // 任意池子之后，搜索结果就会按池子被藏掉 —— 表现为"搜不到池子里的帖子"。
    // 这两个页面只保留光效，不隐藏任何结果。
    const skipFiltering = window.LDFCTopicParser.isFilterExcluded();

    for (const row of window.LDFCTopicParser.listRows()) {
      if (skipFiltering) {
        show(row);
        continue;
      }

      const topicId = String(row.dataset.topicId);
      const record = window.LDFCTopicState.get(topicId);
      // 新回复是临时状态，这里的归属仍看 basePool；
      // 主信息流只显示既不在其他池、也没有待处理新回复的 Topic。
      const rowPool = record?.basePool ?? "HOME";
      const hidden = activePool !== "HOME" || rowPool !== "HOME" || Boolean(record?.inNewReply);

      if (hidden) {
        row.classList.add("ldfc-row-hidden");
        row.style.display = "none";
      } else {
        show(row);
      }
    }

    // 钉住的高度可能因为 Discourse 重渲染容器而丢失，这里补一次。
    if (activePool !== "HOME" && pinnedHeight > 0) {
      const list = listContainer();
      if (list) list.style.minHeight = `${pinnedHeight}px`;
    }
  }

  function setActivePool(pool) {
    if (pool !== "HOME" && activePool === "HOME") pinListHeight();

    activePool = pool;
    applyRows();

    if (pool === "HOME") unpinListHeight();
  }

  function getActivePool() {
    return activePool;
  }

  window.LDFCFilter = {
    applyRows,
    getActivePool,
    setActivePool
  };
})();
