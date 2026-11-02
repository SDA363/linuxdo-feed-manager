(() => {
  const MAX_LOADS_PER_ROUTE = 2;
  const MINIMUM_INTERVAL_MS = 3000;
  // 视口内 + 视口下方一屏内，至少要有这么多条主信息流 Topic，
  // 不够才去触发原站加载更多。
  const TARGET_VISIBLE_ROWS = 8;
  // 哨兵进入视口下方这么近就算"用户已经自然接近底部"。
  const SENTINEL_VISIBLE_MARGIN_PX = 120;
  // 派发后这段时间内不再派发，避免 DOM 更新 → observer → 再次派发的循环。
  const DISPATCH_COOLDOWN_MS = 600;

  let routeKey = "";
  let loadCount = 0;
  let lastLoadAt = 0;
  let dispatchPending = false;

  function currentRouteKey() {
    return `${window.location.pathname}${window.location.search}`;
  }

  function resetIfRouteChanged() {
    const key = currentRouteKey();
    if (key !== routeKey) {
      routeKey = key;
      loadCount = 0;
      lastLoadAt = 0;
    }
  }

  // 只数"用户真正看得到"的主信息流行，而不是数 DOM 里加载了多少行。
  // Discourse 一页默认 30 条，如果按 DOM 计数，阈值永远达不到，
  // 补位就永远不会触发。
  function visibleHomeRowCount() {
    const bottomLimit = window.innerHeight * 2;

    return window.LDFCTopicParser.listRows().filter((row) => {
      const record = window.LDFCTopicState.get(row.dataset.topicId);
      if (record && (record.basePool !== "HOME" || record.inNewReply)) return false;

      const rect = row.getBoundingClientRect();
      // display:none 的行 rect 全是 0，会被这里排除。
      return rect.bottom > 0 && rect.top < bottomLimit;
    }).length;
  }

  function sentinel() {
    return document.querySelector(".load-more-sentinel");
  }

  // 哨兵是否已经进入视口（含下方一点余量）。
  //
  // 这就是"用户已经自然接近列表底部"的判据：
  //   - 用户在长列表中部 → 哨兵在视口外很远 → 不补位（不打断阅读）
  //   - 用户自己滚到底 → 哨兵进视口 → 可以补位
  //   - 过滤后内容本来就短、没得滚 → 哨兵本来就在视口内 → 可以补位
  function sentinelInViewport() {
    const element = sentinel();
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    // display:none 时 rect 全为 0，这里要显式排除，否则会被误判成"在视口内"。
    if (rect.width === 0 && rect.height === 0 && rect.top === 0) return false;
    return rect.top <= window.innerHeight + SENTINEL_VISIBLE_MARGIN_PX;
  }

  function shouldLoadMore() {
    resetIfRouteChanged();

    if (loadCount >= MAX_LOADS_PER_ROUTE) return false;
    if (Date.now() - lastLoadAt < MINIMUM_INTERVAL_MS) return false;
    if (visibleHomeRowCount() >= TARGET_VISIBLE_ROWS) return false;
    // 用户还在列表中部一律不补位。
    if (!sentinelInViewport()) return false;

    return true;
  }

  // 驱动 Discourse 原生的无限滚动。
  //
  // **只派发一次 scroll 事件**，绝不滚动页面：
  // 不调用 scrollIntoView，不动 window.scrollY / scrollTop。
  // 用户的阅读位置必须原样不动 —— 这是已决策的产品行为。
  function triggerNativeLoadMore() {
    const element = sentinel();
    if (!element) return false;
    if (dispatchPending) return false;
    if (element.dataset.ldfcAutofill === "true") return false;

    element.dataset.ldfcAutofill = "true";
    dispatchPending = true;

    window.dispatchEvent(new Event("scroll"));

    setTimeout(() => {
      dispatchPending = false;
      delete element.dataset.ldfcAutofill;
    }, DISPATCH_COOLDOWN_MS);

    loadCount += 1;
    lastLoadAt = Date.now();
    return true;
  }

  function maybeFill() {
    if (window.LDFCFilter.getActivePool() !== "HOME") return false;
    if (!shouldLoadMore()) return false;
    return triggerNativeLoadMore();
  }

  window.LDFCAutofill = { maybeFill, sentinelInViewport, shouldLoadMore, visibleHomeRowCount };
})();
