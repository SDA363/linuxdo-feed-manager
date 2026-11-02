(() => {
  // 「新回复」预览：显示"用户上次阅读位置之后的第一条回复"。
  //
  // 规格明确要求预览的是第一条新回复，而不是最新一条。列表 JSON 里的
  // excerpt 是 Topic 摘要，拿不到这个语义，所以必须按需读一次 Topic 详情。
  //
  // 护栏（遵守规格第 9 条"不能给 Linux.do 增加明显额外压力"）：
  //   - 只在「新回复」面板真正打开、并且要显示这条 Topic 时才抓；
  //   - 每次最多抓前 10 条；
  //   - 两次请求间隔至少 1.2 秒，串行执行；
  //   - 结果写进本地数据库，同一条回复只抓一次；
  //   - 抓失败也记账，不在同一次会话里反复重试。
  const MAX_PREVIEWS_PER_RENDER = 10;
  const MIN_INTERVAL_MS = 1200;

  const attempted = new Set();
  const queue = [];
  let pumping = false;
  let lastFetchAt = 0;
  let notify = null;

  function keyOf(record) {
    return `${record.topicId}:${record.lastReadPostNumber}`;
  }

  function isStale(record) {
    if (!record.inNewReply) return false;
    if (record.lastReadPostNumber === null || record.lastReadPostNumber === undefined) return false;
    if (record.previewForRead === record.lastReadPostNumber) return false;
    return !attempted.has(keyOf(record));
  }

  function stripHtml(html) {
    // 用游离（未插入文档）的节点解析：游离节点的 innerHTML 不会执行脚本。
    // 内容本身是 Discourse 服务端清洗过的 cooked HTML。
    const holder = document.createElement("div");
    holder.innerHTML = html || "";
    const text = (holder.textContent || "").replace(/\s+/g, " ").trim();
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }

  async function getJson(path) {
    return fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }

  async function fetchFirstUnread(record) {
    const lastRead = Number(record.lastReadPostNumber);
    const targetPostNumber = lastRead + 1;

    const payload = await getJson(`/t/${record.topicId}.json`);
    if (!payload) return null;

    let post = (payload.post_stream?.posts ?? []).find(
      (item) => item.post_number === targetPostNumber
    );

    if (!post) {
      // 详情接口默认只返回一段楼层窗口，目标楼层可能不在里面。
      // post_stream.stream 是全部楼层的 post id 顺序数组，
      // 下标 lastRead 正好对应 post_number = lastRead + 1。
      const targetPostId = payload.post_stream?.stream?.[lastRead];
      if (targetPostId) {
        const single = await getJson(`/t/${record.topicId}/posts.json?post_ids[]=${targetPostId}`);
        post = single?.post_stream?.posts?.[0];
      }
    }

    if (!post) return null;

    const text = stripHtml(post.cooked);
    if (!text) return null;

    return {
      author: post.username || post.name || "",
      text
    };
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function pump() {
    if (pumping) return;
    pumping = true;

    try {
      while (queue.length) {
        const record = queue.shift();
        const key = keyOf(record);
        if (attempted.has(key)) continue;
        attempted.add(key);

        const wait = MIN_INTERVAL_MS - (Date.now() - lastFetchAt);
        if (wait > 0) await sleep(wait);
        lastFetchAt = Date.now();

        const preview = await fetchFirstUnread(record);

        await window.LDFCTopicState.setPreview(record.topicId, {
          previewForRead: record.lastReadPostNumber,
          previewAuthor: preview?.author ?? "",
          previewText: preview?.text ?? ""
        });

        if (notify) notify();
      }
    } finally {
      pumping = false;
    }
  }

  function ensurePreviews(records, onUpdated) {
    if (onUpdated) notify = onUpdated;

    for (const record of records.slice(0, MAX_PREVIEWS_PER_RENDER)) {
      if (!isStale(record)) continue;
      if (queue.some((item) => item.topicId === record.topicId)) continue;
      queue.push(record);
    }

    pump();
  }

  window.LDFCNewReply = { ensurePreviews };
})();
