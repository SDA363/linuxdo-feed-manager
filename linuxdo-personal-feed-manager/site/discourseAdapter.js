(() => {
  let latestListPromise = null;

  function getJson(path) {
    return fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    })
      .then((response) => (response.ok ? response.json() : null))
      .catch(() => null);
  }

  function normalizeTopic(rawTopic) {
    return {
      topicId: String(rawTopic.id),
      slug: rawTopic.slug ?? "",
      title: rawTopic.title ?? rawTopic.fancy_title ?? "",
      // 只保存展示所需的最小元数据，让历史池（感兴趣 / 已读 / 不感兴趣）
      // 可以纯本地渲染，不必为了显示列表逐个向 Linux.do 请求。
      categoryId: rawTopic.category_id ?? null,
      lastPosterUsername: rawTopic.last_poster_username ?? "",
      lastReadPostNumber: rawTopic.last_read_post_number ?? null,
      highestPostNumber: rawTopic.highest_post_number ?? null,
      // 真实站点上大多数 Topic **没有**这个字段（实测 /latest 首页 28/30 为 null：
      // 只有用户互动过、存在 TopicUser 记录的 Topic 才带阅读状态）。
      // 所以这里保留 null，而不是塞一个 0 —— "0 条未读"和"不知道"必须能区分。
      unreadPosts: typeof rawTopic.unread_posts === "number" ? rawTopic.unread_posts : null,
      lastPostedAt: rawTopic.last_posted_at ?? rawTopic.bumped_at ?? null,
      excerpt: rawTopic.excerpt ?? ""
    };
  }

  function canFetchList() {
    const pathname = window.location.pathname;
    return pathname === "/" || /^\/(latest|top|new|unread)(\/|$|\?)/.test(pathname);
  }

  // 失败一律返回 null，绝不返回空数组。
  // 空数组和"请求失败"必须能区分：把失败当成空列表会导致扩展误判
  // "所有新回复都处理完了"，从而清空新回复区。
  function fetchList(path) {
    return getJson(path).then((payload) => {
      const topics = payload?.topic_list?.topics;
      if (!Array.isArray(topics)) return null;
      return topics.map(normalizeTopic);
    });
  }

  function fetchLatestList() {
    if (latestListPromise) return latestListPromise;

    latestListPromise = fetchList("/latest.json").finally(() => {
      latestListPromise = null;
    });

    return latestListPromise;
  }

  function fetchUnreadList() {
    // 未登录时原站的 /unread.json 必然返回 403，这个请求没有任何意义。
    // Guest 的新回复走本地基线的匿名兜底，本来就不依赖这个接口。
    // 放在这里而不是调用方，是为了保证任何调用路径都不会再发出这个无用请求。
    if (!window.LDFCIdentity.current().loggedIn) return Promise.resolve(null);

    return fetchList("/unread.json");
  }

  // 单个 Topic 的阅读状态，用于列表里查不到该 Topic 时的兜底确认。
  // 原站没有返回 last_read_post_number 时返回 null（例如未登录），
  // 调用方据此保持现状，不会误判为已读。
  // 未读数的取值顺序：
  //   1. **原站原生 `unread_posts`** —— 优先。这是 Discourse 自己的语义，
  //      规格要求"不要重新实现原站已有的能力"。
  //   2. 原站没给时，用 `highest_post_number - last_read_post_number` 兜底。
  //
  // 关于第 2 条：这是【实现候选】，不是新的产品逻辑。
  // 真实 linux.do 实测（`/t/<id>.json` 登录态只给 last_read_post_number 与
  // highest_post_number，**不给 unread_posts**；8/8 抽样与 /unread.json 的
  // 原生未读数完全一致）证明这个计算在当前站点上等价。
  // 一旦发现原站提供了原生字段，就应当改回用原生字段。
  function unreadFromPostNumbers(lastRead, highest) {
    if (typeof highest !== "number") return null;
    const last = typeof lastRead === "number" ? lastRead : 0;
    if (!last) return highest > 0 ? highest : 0;
    return highest > last ? highest - last : 0;
  }

  function unreadFromTopicPayload(payload) {
    if (!payload) return null;
    if (typeof payload.unread_posts === "number") return payload.unread_posts;
    return unreadFromPostNumbers(payload.last_read_post_number, payload.highest_post_number);
  }

  function fetchTopicReadState(topicId) {
    return getJson(`/t/${topicId}.json`).then((payload) => {
      if (!payload) return null;

      return {
        topicId: String(topicId),
        slug: payload.slug ?? "",
        title: payload.title ?? payload.fancy_title ?? "",
        lastReadPostNumber: payload.last_read_post_number ?? null,
        highestPostNumber: payload.highest_post_number ?? null,
        unreadPosts: unreadFromTopicPayload(payload)
      };
    });
  }

  // 复用 Discourse 自己的算法：跳到"上次阅读位置 + 1"楼。
  function topicUnreadUrl(record) {
    const slug = record.slug || "topic";
    const lastRead = Number(record.lastReadPostNumber || 0);
    const highest = Number(record.highestPostNumber || 0);
    const nextPost = highest > 0 ? Math.min(lastRead + 1, highest) : 1;
    return `/t/${slug}/${record.topicId}/${Math.max(nextPost, 1)}`;
  }

  window.LDFCDiscourseAdapter = {
    canFetchList,
    fetchLatestList,
    fetchTopicReadState,
    fetchUnreadList,
    normalizeTopic,
    topicUnreadUrl,
    unreadFromPostNumbers,
    unreadFromTopicPayload
  };
})();
