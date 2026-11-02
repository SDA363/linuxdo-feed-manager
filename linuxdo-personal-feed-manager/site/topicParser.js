(() => {
  const TOPIC_URL_PATTERN = /^\/t\/([^/]+)\/(\d+)(?:\/(\d+))?/;
  // 所有"带一条 Topic 的列表行"可能长得完全不一样：
  //   主列表   .topic-list-item / .latest-topic-list-item
  //   搜索结果 .fps-result（Discourse 的搜索结果是卡片，不是表格行）
  //   推荐/相关 话题页底部，Discourse 默认是 <tr data-topic-id> 的表格
  // 统一按 data-topic-id 找，最后再补一层"任何带 ID 的容器"。
  const ROW_SELECTOR = [
    ".topic-list-item[data-topic-id]",
    ".latest-topic-list-item[data-topic-id]",
    "tr[data-topic-id]",
    ".fps-result[data-topic-id]",
    ".search-result[data-topic-id]",
    ".more-topics__list-item[data-topic-id]",
    ".suggested-topics [data-topic-id]",
    "[data-topic-id]"
  ].join(", ");

  // "真正的列表行"白名单（不含最后那条兜底选择器）。
  // 帖子页 / 搜索页自己就有一堆带 data-topic-id 的大容器（#topic、主题头部、
  // 标题外框……），兜底选择器会把它们当成一行装饰：胶囊按 top:50% 定位，
  // 结果飘到页面中部或标题旁边。这两类页面只认下面这些行。
  const KNOWN_ROW_SELECTOR = [
    ".topic-list-item",
    ".latest-topic-list-item",
    "tr[data-topic-id]",
    ".fps-result",
    ".search-result",
    ".more-topics__list-item"
  ].join(", ");

  function isKnownRow(row) {
    return row.matches(KNOWN_ROW_SELECTOR) || Boolean(row.closest?.(".suggested-topics"));
  }

  function parseTopicUrl(href) {
    try {
      const url = new URL(href, window.location.origin);
      const match = url.pathname.match(TOPIC_URL_PATTERN);
      if (!match) return null;
      return {
        slug: match[1],
        topicId: match[2],
        postNumber: match[3] ? Number(match[3]) : null
      };
    } catch {
      return null;
    }
  }

  function findTopicRow(element) {
    return element.closest(ROW_SELECTOR);
  }

  // data-topic-id 是 Discourse 核心输出，比任何主题皮肤类名都稳定。
  // id 之外的字段（标题、作者、时间、回复数、URL 里的 slug）都可能变，
  // 所以唯一标识只用 topicId。
  function extractTopic(row) {
    if (!row) return null;

    // 搜索结果没有 data-topic-id 时，从标题链接里解析。
    let topicId = row.dataset?.topicId ? String(row.dataset.topicId) : "";

    // linux.do 用的是卡片主题，标题链接不一定带 data-topic-id，
    // 也不一定是 Discourse 默认的 .raw-topic-link。按可靠性依次尝试，
    // 取第一个真正有文字的候选 —— 否则记录里的标题会是空的。
    const candidates = [
      row.querySelector("a.raw-topic-link[data-topic-id]"),
      row.querySelector("a.title[data-topic-id]"),
      row.querySelector("a[data-topic-id]"),
      row.querySelector(".topic-title a, .link-top-line a, .main-link a"),
      row.querySelector('a[href*="/t/"]'),
      // 容器兜底放最后：它的 textContent 可能混进标签、时间等文字。
      row.querySelector(".topic-title, .title")
    ];

    const titleLink = candidates.find(
      (element) => element && element.textContent && element.textContent.trim()
    );

    const parsedUrl = titleLink?.href ? parseTopicUrl(titleLink.href) : null;
    if (!topicId) topicId = parsedUrl?.topicId ?? "";
    if (!topicId) return null;

    return {
      row,
      topicId,
      slug: parsedUrl?.slug ?? "",
      title: titleLink?.textContent?.trim() ?? "",
      url: titleLink?.href ?? `/t/${parsedUrl?.slug ?? "topic"}/${topicId}`
    };
  }

  function listRows() {
    const found = [...document.querySelectorAll(ROW_SELECTOR)];
    // 内层容器（比如标题链接上的 data-topic-id）也会命中选择器，
    // 只保留最外层那一行，否则同一行会被装饰两遍。
    //
    // 搜索结果额外上浮一层到卡片：linux.do 的搜索卡片把 data-topic-id 放在
    // 标题容器上（宽度＝内容宽度），按钮层挂上去会跟着标题/摘要长度左右跑。
    // 统一挂到整宽的 .fps-result / .search-result，才能和列表页一样右对齐。
    const raised = found.map((row) => row.closest?.(".fps-result, .search-result") ?? row);
    const unique = raised.filter((row, index) => raised.indexOf(row) === index);

    return unique.filter((row) => {
      if (row === document.body || row === document.documentElement) return false;
      if (row.parentElement?.closest?.(ROW_SELECTOR)) return false;
      // 帖子页 / 搜索页：只要白名单里的列表行，不要让兜底选择器把
      // #topic 之类的页面容器变成"一行"。
      if (isFilterExcluded() && !isKnownRow(row)) return false;
      // 最后那条兜底选择器只认"真的包含一条 Topic 链接"的容器，
      // 否则页面根节点上的 data-topic-id 也会被当成一行。
      if (row.matches("[data-topic-id]") && row.matches(ROW_SELECTOR)) {
        if (!isKnownRow(row)) return Boolean(row.querySelector('a[href*="/t/"]'));
      }
      return true;
    });
  }

  // 哪些页面不做五区过滤。
  //
  // 搜索结果例外是刻意设计的：搜索是用户主动检索，此时用户已经明确
  // 要求查找内容，不应该被个人信息流过滤器偷偷干预。这让扩展始终是
  // "信息流管理器"，而不是"全站内容屏蔽器"。
  function isFilterExcluded(pathname = window.location.pathname) {
    if (/^\/t\//.test(pathname)) return true;
    if (/^\/search(\/|$)/.test(pathname)) return true;
    return false;
  }

  window.LDFCTopicParser = {
    extractTopic,
    findTopicRow,
    isFilterExcluded,
    listRows,
    parseTopicUrl
  };
})();
