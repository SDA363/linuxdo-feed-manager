(() => {
  const state = () => window.LDFCTopicState;
  const identity = () => window.LDFCIdentity.current();
  const tracking = () => window.LDFCTrackingState;

  // 每次同步最多做几次"定向确认"，避免请求量随历史池规模增长。
  const MAX_CONFIRMS_PER_SYNC = 3;

  const METADATA_KEYS = [
    "title",
    "slug",
    "excerpt",
    "categoryId",
    "lastPosterUsername",
    "lastReadPostNumber",
    "highestPostNumber",
    "unreadPosts",
    "lastPostedAt"
  ];

  function metadataDiffers(existing, topic) {
    return METADATA_KEYS.some((key) => (existing[key] ?? null) !== (topic[key] ?? null));
  }

  // 用户主动改变归属后安排一次延迟推送。
  // 同步服务没初始化 / 没配置远端 / 关掉自动同步时，这个调用是空操作。
  function notifyChanged(record) {
    window.LDFCSyncService?.schedulePush?.();
    // 归属变化 → 通知所有按钮刷新「已在池里」光效。
    // 走事件而不是互相调用：launcher / desktopActions / 信息池面板互不依赖，
    // 自动已读、同步合并这些不经过 UI 的路径也能点亮。
    try {
      document.dispatchEvent(new CustomEvent("ldfc:pool-change"));
    } catch {
      // 事件派发失败不影响状态写入
    }
    return record;
  }

  // ------------------------------------------------------------------
  // 通知联动（用户主动移池 → 按设置改站点通知级别）
  //
  // 顺序刻意是「本地先刷新、网络后补」：列表不该被一次 HTTP 往返卡住。
  // previous 记在内存里，供撤销把这一次自动改的值退回去。
  // 手动改过的话题由 LDFCNotify 自己拦掉（手动优先），这里不重复判断。
  // ------------------------------------------------------------------
  const lastAutoNotify = new Map();

  async function linkNotify(topicId, pool) {
    const result = await window.LDFCNotify?.applyPoolMapping?.(topicId, pool);
    const key = String(topicId);
    if (result?.applied && typeof result.previous === "number") {
      lastAutoNotify.set(key, result.previous);
    } else {
      lastAutoNotify.delete(key);
    }
    return result ?? null;
  }

  // 自动已读使用单独的映射，和用户主动点「已读」分开配置。
  async function linkAutoReadNotify(topicId) {
    const result = await window.LDFCNotify?.applyAutoRead?.(topicId);
    const key = String(topicId);
    if (result?.applied && typeof result.previous === "number") {
      lastAutoNotify.set(key, result.previous);
    } else {
      lastAutoNotify.delete(key);
    }
    return result ?? null;
  }

  // 取走并清掉"这一次自动改之前的档位"。null = 没改过 / 不知道原值。
  function takeNotifyRevert(topicId) {
    const key = String(topicId);
    const previous = lastAutoNotify.get(key);
    lastAutoNotify.delete(key);
    return typeof previous === "number" ? previous : null;
  }

  async function markInterested(topic, metadata = {}) {
    // 必须把列表行里已经解析出的标题 / slug 一起写进记录。
    // 否则从主信息流直接标记的 Topic 从没经过 /latest.json 同步，
    // 面板里只能显示 "Topic <id>" 这种裸数字。
    const record = await state().setPool(topic.topicId, "INTERESTED", {
      title: topic.title,
      slug: topic.slug,
      ...metadata
    });
    notifyChanged(record);
    await linkNotify(topic.topicId, "INTERESTED");
    return record;
  }

  async function markRead(topicId, metadata = {}) {
    const record = await state().setPool(topicId, "READ", metadata);
    notifyChanged(record);
    await linkNotify(topicId, "READ");
    return record;
  }

  // 读到底后的自动已读：归属写入后按独立映射改通知。
  // 不调用 notifyChanged()，保持原先自动已读不额外刷新 / 不额外推送的行为。
  async function autoRead(topicId, metadata = {}) {
    const record = await state().setPool(topicId, "READ", metadata);
    await linkAutoReadNotify(topicId);
    return record;
  }

  async function markDismissed(topic, metadata = {}) {
    const record = await state().setPool(topic.topicId, "DISMISSED", {
      title: topic.title,
      slug: topic.slug,
      ...metadata
    });
    notifyChanged(record);
    await linkNotify(topic.topicId, "DISMISSED");
    return record;
  }

  async function moveHome(topicId, metadata = {}) {
    // 状态重置：清掉当前个人归属，同时清掉新回复待处理标记，
    // 不能留下"主信息流 + 有新回复"这种残留。
    return notifyChanged(await state().setPool(topicId, "HOME", metadata));
  }

  async function dismissFromAnyPool(topicId, metadata = {}) {
    const record = await state().setPool(topicId, "DISMISSED", metadata);
    notifyChanged(record);
    await linkNotify(topicId, "DISMISSED");
    return record;
  }

  // 「任意池 → 任意池」。信息池面板的「移入…」和列表多选都走这一条，
  // 保证两个入口是同一套语义，不会一个能移、一个不能。
  //
  // NEW_REPLY 不是第五种归属，而是挂在「感兴趣 / 已读」上的暂态：
  // 主信息流本来就是待处理池，不感兴趣则是"永久安静"，
  // 两者都不该出现"已忽略却提醒新回复"的矛盾，所以这里直接拒绝。
  // 调用方负责把不可用的目标置灰，这里只是最后一道闸。
  async function moveToPool(topicId, pool, metadata = {}) {
    if (pool === "NEW_REPLY") {
      const current = state().get(topicId);
      if (!current || (current.basePool !== "INTERESTED" && current.basePool !== "READ")) {
        return null;
      }
      return notifyChanged(await state().markNewReply(topicId, metadata));
    }
    const record = await state().setPool(topicId, pool, metadata);
    notifyChanged(record);
    // 回主信息流不触发联动：HOME 没有映射，撤销也不该去改站点通知。
    if (pool !== "HOME") await linkNotify(topicId, pool);
    return record;
  }

  function canMoveTo(topicId, pool) {
    if (pool !== "NEW_REPLY") return true;
    const current = state().get(topicId);
    return Boolean(current && (current.basePool === "INTERESTED" || current.basePool === "READ"));
  }

  // ------------------------------------------------------------------
  // 第 1 层：元数据同步（+ 匿名的本地兜底判定）
  //
  // 登录态下这里**不做任何新回复判定**：真实站点实测 /latest.json 首页
  // 28/30 的 Topic 没有 unread_posts（只有存在 TopicUser 记录的才有），
  // 用它判定等于功能失效。新回复改由 discoverNewReplies 负责。
  // ------------------------------------------------------------------
  async function syncWithDiscourse(topics) {
    if (!topics) return [];

    const anonymous = !identity().loggedIn;
    const changed = [];

    for (const topic of topics) {
      const existing = state().get(topic.topicId);
      if (!existing) continue;

      if (metadataDiffers(existing, topic)) {
        await state().updateMetadata(topic.topicId, topic);
      }

      // 主信息流是待处理池，本来就不参与新回复；
      // 不感兴趣永久安静，更不会进新回复。
      if (existing.basePool === "DISMISSED" || existing.basePool === "HOME") continue;

      // 登录态不再在这里判定，交给 discoverNewReplies / confirmNewReplyCompletions。
      if (!anonymous) continue;

      // 匿名兜底【实现候选】：原站对未登录访客不返回 unread_posts，
      // 也没有 /unread.json，只能拿"当前最高楼层"和本地记录比较。
      // 第一次见到该 Topic 时先建立基线，本轮不判定 ——
      // 否则会把它被标记之前就存在的回复也算成"新回复"。
      if ((existing.readUpToPostNumber ?? null) === null) {
        await state().setReadSnapshot(topic.topicId, topic.highestPostNumber ?? null);
        continue;
      }

      const pending = hasUnreadByLocalSnapshot(existing, topic);

      if (pending && !existing.inNewReply) {
        const record = await state().markNewReply(topic.topicId, topic);
        if (record) changed.push(record);
      } else if (!pending && existing.inNewReply) {
        const record = await state().clearNewReply(topic.topicId);
        if (record) changed.push(record);
      }
    }

    return changed;
  }

  // 匿名兜底判定【实现候选】：原站对未登录访客不返回 unread_posts，
  // 只能拿"当前最高楼层"和"本地记录的读到楼层"比较。
  // 没记录过读到哪儿的 Topic 一律不判断，不猜。
  function hasUnreadByLocalSnapshot(record, topic) {
    const seen = record.readUpToPostNumber;
    if (seen === null || seen === undefined) return false;
    const highest = topic.highestPostNumber;
    if (!highest) return false;
    return highest > seen;
  }

  // 发现信号的选择顺序。
  //
  // 三个来源**职责分离**，不合并成一个"统一真相"：
  //   1. `/unread.json` 第 0 页 —— 原站直接说"我有未读"，最权威
  //   2. `/latest.json` 的 `unread_posts` —— 只认**非 null 的数值**。
  //      这个字段只有用户互动过（存在 TopicUser 记录）的 Topic 才带，
  //      而我们要检测的「感兴趣 / 已读」正好就是那一批。
  //      `null` 表示"原站这次没给"，**绝不能当成 0**。
  //      （真实站点实测：2902024 在第一页带 unread_posts=3，
  //        但既不在 tracking 也不在 /unread 第 0 页，只能靠这一路发现。）
  //   3. tracking 快照 —— 零请求，但语义更宽：
  //      它的 `last_read_post_number` 为 null 时**不能**推成"整帖未读"，
  //      否则会给从没读过的 Topic 凭空造出一条新回复。
  //      所以这一路要求 lastRead 非空。
  //
  // 这一层**只标记、绝不清除**：任何一路的 `unread = 0` 都不是"已处理完"的证据，
  // 完成确认仍然只走 confirmNewReplyCompletions 的定向请求。
  function pickDiscoverySignal(live, latest, tracked) {
    if (live && typeof live.unreadPosts === "number" && live.unreadPosts > 0) {
      return {
        unreadPosts: live.unreadPosts,
        lastReadPostNumber: live.lastReadPostNumber,
        highestPostNumber: live.highestPostNumber,
        lastPostedAt: live.lastPostedAt
      };
    }

    if (latest && typeof latest.unreadPosts === "number" && latest.unreadPosts > 0) {
      return {
        unreadPosts: latest.unreadPosts,
        lastReadPostNumber: latest.lastReadPostNumber,
        highestPostNumber: latest.highestPostNumber,
        lastPostedAt: latest.lastPostedAt
      };
    }

    if (tracked && tracked.unread > 0 && tracked.lastReadPostNumber !== null) {
      return {
        unreadPosts: tracked.unread,
        lastReadPostNumber: tracked.lastReadPostNumber,
        highestPostNumber: tracked.highestPostNumber
      };
    }

    return null;
  }

  // ------------------------------------------------------------------
  // 第 2 层：发现（discovery）
  //
  // 目的：找出"本地已归入感兴趣 / 已读、且现在有新回复"的 Topic。
  //
  // 数据源：`/unread.json` 第 0 页 + `/latest.json` 非 null 的未读数
  //         + tracking 快照（后两者都可能零额外请求）
  //
  // 这一层**只标记，绝不清除**：
  // "某个来源里没有它 / 它显示 0"都不是"它已经处理完了"的证据。
  // ------------------------------------------------------------------
  async function discoverNewReplies(unreadTopics, latestTopics) {
    if (!identity().loggedIn) return false;

    const liveById = new Map((unreadTopics ?? []).map((topic) => [topic.topicId, topic]));
    const latestById = new Map((latestTopics ?? []).map((topic) => [topic.topicId, topic]));
    let changed = false;

    for (const record of [...state().records.values()]) {
      // 只有「感兴趣」和「已读」会进入新回复区；
      // 主信息流是待处理池，不感兴趣永久安静。
      if (record.basePool !== "INTERESTED" && record.basePool !== "READ") continue;

      const signal = pickDiscoverySignal(
        liveById.get(record.topicId),
        latestById.get(record.topicId),
        tracking().rowFor(record.topicId)
      );

      if (!signal) continue;

      if (!record.inNewReply) {
        await state().markNewReply(record.topicId, signal);
        changed = true;
        continue;
      }

      // Topic 已经在「新回复」里，但用户可能又读了一部分 ——
      // 阅读位置必须跟着走，否则「第一条未读预览」会停在用户已经读过的楼层。
      //
      // 写法上的两个约束：
      //   - 只在数据源给出**可靠数值**时才覆盖，绝不用 null 抹掉已知信息；
      //   - 阅读位置**只增不减**：快照可能是旧的，不能把缓存往后退。
      const patch = {};
      if (typeof signal.unreadPosts === "number" && signal.unreadPosts !== record.unreadPosts) {
        patch.unreadPosts = signal.unreadPosts;
      }
      if (
        typeof signal.lastReadPostNumber === "number" &&
        signal.lastReadPostNumber > (record.lastReadPostNumber ?? 0)
      ) {
        patch.lastReadPostNumber = signal.lastReadPostNumber;
      }
      if (
        typeof signal.highestPostNumber === "number" &&
        signal.highestPostNumber > (record.highestPostNumber ?? 0)
      ) {
        patch.highestPostNumber = signal.highestPostNumber;
      }

      if (Object.keys(patch).length) {
        // 阅读位置一变，newReply.js 的预览缓存（previewForRead）自然失效，
        // 下一轮会按新的位置重新抓"第一条未读"。
        await state().updateMetadata(record.topicId, patch);
        changed = true;
      }
    }

    return changed;
  }

  // ------------------------------------------------------------------
  // 第 3 层：完成确认（completion）
  //
  // 目的：确认某个"新回复待处理"的 Topic 现在是否**真的** unread = 0。
  //
  // 规则：
  //   - 快照明确还有未读，且用户不是刚读过它 → 保持，不发请求
  //   - 其余情况（快照说 0 / 快照查不到 / 用户刚读过它）→ 定向请求确认
  //   - 受限：每次同步最多 MAX_CONFIRMS_PER_SYNC 次，
  //           每个 Topic 最多 CONFIRM_MAX_ATTEMPTS 次
  //   - **绝不**用"不在 /unread.json 第 0 页"当作清除依据（分页不是已读信号）
  //
  // priorityTopicIds：用户刚刚访问过的 Topic（通常是刚读完新回复）。
  // 这些必须真的去确认一次，不能因为快照还显示未读就把它永远留在新回复区。
  // ------------------------------------------------------------------
  async function confirmNewReplyCompletions(priorityTopicIds = []) {
    if (!identity().loggedIn) return false;

    const priority = new Set((priorityTopicIds ?? []).map(String));
    const pending = [...state().records.values()].filter((record) => record.inNewReply);
    if (!pending.length) return false;

    // 用户刚读过的排到前面，优先消耗确认预算
    pending.sort(
      (left, right) => (priority.has(right.topicId) ? 1 : 0) - (priority.has(left.topicId) ? 1 : 0)
    );

    let budget = MAX_CONFIRMS_PER_SYNC;
    let changed = false;

    for (const record of pending) {
      const justRead = priority.has(record.topicId);
      const trackedUnread = tracking().unreadFor(record.topicId);

      // 快照明确还有未读，而且用户不是刚读过 → 不必浪费一次请求
      if (!justRead && trackedUnread !== null && trackedUnread > 0) continue;

      if ((record.confirmAttempts || 0) >= state().CONFIRM_MAX_ATTEMPTS) continue;
      if (budget <= 0) break;
      budget -= 1;

      await state().bumpConfirmAttempt(record.topicId);
      const read = await window.LDFCDiscourseAdapter.fetchTopicReadState(record.topicId);
      if (!read) continue;

      if (read.unreadPosts === 0) {
        await state().clearNewReply(record.topicId);
        changed = true;
      } else if (typeof read.unreadPosts === "number") {
        await state().updateMetadata(record.topicId, {
          unreadPosts: read.unreadPosts,
          lastReadPostNumber: read.lastReadPostNumber,
          highestPostNumber: read.highestPostNumber
        });
      }
    }

    return changed;
  }

  // ------------------------------------------------------------------
  // 自动已读的唯一入口
  //
  // 判定条件（两个都要满足）：
  //   1. 安装之后用户真正打开过这个 Topic（存在访问记录）；
  //   2. Linux.do / Discourse 自己确认了阅读位置。
  //
  // 只看条件 2 会把安装前的历史全部猜成已读，违反"从今天开始记录"。
  // 只看条件 1 则等于自建一套阅读判定，违反"复用原站机制"。
  // ------------------------------------------------------------------
  async function promotePendingVisits(latestTopics) {
    const pending = state().pendingVisits();
    if (!pending.length) return [];

    const anonymous = !identity().loggedIn;
    const latestById = new Map((latestTopics ?? []).map((topic) => [topic.topicId, topic]));
    const changed = [];

    for (const visit of pending) {
      const existing = state().get(visit.topicId);

      // 用户明确不想再看到它：访问记录直接作废。
      if (existing?.basePool === "DISMISSED") {
        await state().clearVisit(visit.topicId);
        continue;
      }

      const fromLatest = latestById.get(visit.topicId);

      // 匿名兜底【实现候选】：原站不给匿名访客持久的用户级阅读位置，
      // 退化为"打开即视为已读 + 记下当时的最高楼层作为基线"。
      // 这个模式能力更弱，具体算法待 Phase 0 验证。
      if (anonymous) {
        const read = fromLatest ?? (await window.LDFCDiscourseAdapter.fetchTopicReadState(visit.topicId));
        const highest = read?.highestPostNumber ?? null;

        if (highest) {
          changed.push(
            await autoRead(visit.topicId, {
              ...read,
              readUpToPostNumber: highest,
              // 匿名模式把"再次打开"当作本轮新回复已处理
              inNewReply: false,
              enteredPoolAt: Date.now()
            })
          );
        } else if ((visit.checks || 0) < state().VISIT_MAX_CHECKS) {
          await state().bumpVisitCheck(visit.topicId);
        }

        await state().clearVisit(visit.topicId);
        continue;
      }

      // 用户手动放进「感兴趣」等其他池时尊重他的选择，不改成已读，
      // 只结束访问跟踪。但「已读」里再打开一次，就是一次新的阅读，
      // 需要把"阅读于"时间推到现在，否则"最近阅读"排序失真。
      if (existing && existing.basePool !== "HOME") {
        if (existing.basePool === "READ") {
          await state().updateMetadata(visit.topicId, { enteredPoolAt: Date.now() });
        }
        await state().clearVisit(visit.topicId);
        continue;
      }

      if (fromLatest && fromLatest.lastReadPostNumber !== null) {
        changed.push(
          await autoRead(visit.topicId, { ...fromLatest, enteredPoolAt: Date.now() })
        );
        await state().clearVisit(visit.topicId);
        continue;
      }

      // Topic 不在当前列表里（例如用户是从第 3 页点进去的），
      // 直接问原站这一个 Topic 的阅读状态。有限次数，避免反复请求。
      if ((visit.checks || 0) >= state().VISIT_MAX_CHECKS) {
        await state().clearVisit(visit.topicId);
        continue;
      }

      await state().bumpVisitCheck(visit.topicId);
      const read = await window.LDFCDiscourseAdapter.fetchTopicReadState(visit.topicId);
      if (read && read.lastReadPostNumber !== null) {
        changed.push(
          await autoRead(visit.topicId, { ...read, enteredPoolAt: Date.now() })
        );
        await state().clearVisit(visit.topicId);
      }
    }

    return changed;
  }

  window.LDFCPoolManager = {
    canMoveTo,
    confirmNewReplyCompletions,
    discoverNewReplies,
    dismissFromAnyPool,
    markDismissed,
    markInterested,
    markRead,
    moveHome,
    moveToPool,
    promotePendingVisits,
    syncWithDiscourse,
    takeNotifyRevert
  };
})();
