(() => {
  // 历史池（已读 / 感兴趣）可能积累上千条，不能一次性全塞进 DOM。
  // 分批渲染 + 每个池独立记忆"渲染了多少条 / 滚到哪里"。
  const BATCH_SIZE = 40;
  const NEXT_BATCH_THRESHOLD_PX = 240;

  const DEFAULT_SORTS = {
    NEW_REPLY: "time",
    INTERESTED: "entered",
    READ: "entered",
    DISMISSED: "entered"
  };

  const SORT_OPTIONS = {
    NEW_REPLY: [
      { value: "time", label: "最新回复" },
      { value: "count", label: "新回复数量" }
    ],
    INTERESTED: [
      { value: "entered", label: "最近加入" },
      { value: "activity", label: "最近活动" }
    ],
    READ: [
      { value: "entered", label: "最近阅读" },
      { value: "activity", label: "最近活动" }
    ],
    DISMISSED: [
      { value: "entered", label: "最近加入" },
      { value: "activity", label: "最近活动" }
    ]
  };

  const POOL_TITLES = {
    NEW_REPLY: "💬 新回复",
    INTERESTED: "⭐ 感兴趣",
    READ: "✓ 已读",
    DISMISSED: "× 不感兴趣"
  };

  // 「移入…」的目标。HOME 也列出来：从历史池回到主信息流是最常用的一步，
  // 和下面的「移回主信息流」重复也没关系 —— 一个在快捷位、一个在展开菜单里。
  const MOVE_TARGETS = [
    { pool: "HOME", label: "🏠 主信息流", name: "主信息流" },
    { pool: "INTERESTED", label: "⭐ 感兴趣", name: "感兴趣" },
    { pool: "READ", label: "✓ 已读", name: "已读" },
    { pool: "NEW_REPLY", label: "💬 新回复", name: "新回复" },
    { pool: "DISMISSED", label: "× 不感兴趣", name: "不感兴趣" }
  ];

  let panel;
  let listEl;
  let footerEl;
  let sortPrefs = { ...DEFAULT_SORTS };
  let renderedPool = null;
  let renderedRecords = [];
  const viewState = new Map();

  // 池内多选：长按任意一条记录进入，点记录勾选，再用标题行的「移入…」批量改归属。
  // 列表页的多选（interaction/multiSelect.js）操作的是站点行，这里操作的是面板
  // 自建的行，DOM 完全不同，所以状态各自独立，互不影响。
  const selection = new Set();
  let selecting = false;
  let ignoreItemClicksUntil = 0;

  function viewFor(pool) {
    return viewState.get(pool) ?? { scrollTop: 0, count: BATCH_SIZE };
  }

  function patchView(pool, patch) {
    viewState.set(pool, { ...viewFor(pool), ...patch });
  }

  async function loadSortPreference() {
    const saved = await window.LDFCDB.getMeta("sortPreferences");
    if (saved && typeof saved === "object") {
      sortPrefs = { ...DEFAULT_SORTS, ...saved };
    }
  }

  async function saveSortPreference(pool, sort) {
    sortPrefs = { ...sortPrefs, [pool]: sort };
    await window.LDFCDB.putMeta("sortPreferences", sortPrefs);
  }

  // ---- 展示工具 ----

  function relativeTime(value) {
    if (!value) return "";
    const time = typeof value === "number" ? value : Date.parse(value);
    if (!Number.isFinite(time)) return "";

    const minute = 60000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const diff = Date.now() - time;

    if (diff < minute) return "刚刚";
    if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
    if (diff < 2 * day) return "昨天";
    if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
    return new Date(time).toLocaleDateString();
  }

  // 各池的"这个时间是什么意思"按语义取，不是一律取最后活动时间。
  function timeLabel(pool, record) {
    if (pool === "NEW_REPLY") return { prefix: "更新于", value: record.lastPostedAt };
    if (pool === "READ") return { prefix: "阅读于", value: record.enteredPoolAt };
    if (pool === "DISMISSED") return { prefix: "屏蔽于", value: record.enteredPoolAt };
    return { prefix: "关注于", value: record.enteredPoolAt };
  }

  function timeElement(pool, record) {
    const { prefix, value } = timeLabel(pool, record);
    const text = relativeTime(value);
    if (!text) return null;

    const element = document.createElement("time");
    element.className = "ldfc-panel-time";
    element.textContent = `${prefix} ${text}`;

    const timestamp = typeof value === "number" ? value : Date.parse(value);
    if (Number.isFinite(timestamp)) {
      element.title = new Date(timestamp).toLocaleString();
    }
    return element;
  }

  // 每条记录在同一次页面生命周期里最多补一次标题，
  // 避免标题永远取不到的记录在每次渲染时重复发请求。
  const titleAttempted = new Set();

  // 旧记录可能存的是空标题（当时的选择器没抓到），面板渲染时
  // 从当前列表里找一次并回写，避免一直显示 "Topic <id>"。
  function titleFor(record) {
    if (record.title) return record.title;

    const row = document.querySelector(
      `.topic-list-item[data-topic-id="${record.topicId}"], ` +
        `.latest-topic-list-item[data-topic-id="${record.topicId}"]`
    );
    const topic = row ? window.LDFCTopicParser.extractTopic(row) : null;
    if (topic?.title) {
      window.LDFCTopicState
        .updateMetadata(record.topicId, { title: topic.title, slug: topic.slug })
        .catch(() => {});
      return topic.title;
    }

    // 该 Topic 已经不在当前页面（翻页 / 不在首页），DOM 里取不到标题。
    // 向原站确认一次这条 Topic 的元数据即可，不是轮询。
    if (titleAttempted.has(record.topicId)) return "";
    titleAttempted.add(record.topicId);

    window.LDFCDiscourseAdapter
      .fetchTopicReadState(record.topicId)
      .then((state) => {
        if (!state?.title) return null;
        return window.LDFCTopicState.updateMetadata(record.topicId, {
          title: state.title,
          slug: state.slug || record.slug
        });
      })
      .then(() => render(window.LDFCFilter.getActivePool()))
      .catch(() => {});

    return "";
  }

  function itemLink(record) {
    const link = document.createElement("a");
    link.className = "ldfc-panel-title";
    link.textContent = titleFor(record) || `Topic ${record.topicId}`;
    link.href = `/t/${record.slug || "topic"}/${record.topicId}`;
    return link;
  }

  function actionButton(label, callback) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", callback);
    return button;
  }

  function previewElement(record) {
    // 优先用真正抓回来的"第一条未读回复"；抓不到时退回列表摘要，
    // 并保持诚实：摘要不等于第一条新回复，所以只作为兜底。
    const text = record.previewText || record.excerpt || "";
    if (!text) return null;

    const preview = document.createElement("p");
    preview.className = "ldfc-panel-excerpt";

    if (record.previewText && record.previewAuthor) {
      const author = document.createElement("strong");
      author.className = "ldfc-preview-author";
      author.textContent = `${record.previewAuthor}：`;
      preview.appendChild(author);
    }

    preview.appendChild(document.createTextNode(text.replace(/&[a-z#0-9]+;/gi, " ")));
    return preview;
  }

  function renderItem(record, pool) {
    const item = document.createElement("div");
    item.className = "ldfc-panel-item";
    const topicId = String(record.topicId);
    // 刻意不用 data-topic-id：content.js 的 decorateRows / 过滤会把任何
    // [data-topic-id] 当成站点列表行，面板项会因此被加上 ldfc-topic-row、
    // 按池隐藏、并多注入一套行按钮。
    item.dataset.ldfcPanelTopic = topicId;
    if (selecting) item.classList.toggle("ldfc-selected", selection.has(topicId));

    const header = document.createElement("div");
    header.className = "ldfc-panel-item-header";
    header.appendChild(itemLink(record));

    if (pool === "NEW_REPLY") {
      const count = document.createElement("span");
      count.className = "ldfc-panel-count";
      // 数量优先取记录里的值，没有就现读一次 tracking 快照。
      // 真实站点上"未读数量未知"是可能的（列表接口的字段可能是 null），
      // 这时宁可不显示数字，也不要编一个出来。
      const unread = record.unreadPosts ?? window.LDFCTrackingState?.unreadFor?.(record.topicId) ?? null;
      count.textContent = unread === null ? "💬 新回复" : `💬 新回复 ${unread}`;
      header.appendChild(count);
    }

    const meta = document.createElement("div");
    meta.className = "ldfc-panel-meta";
    const time = timeElement(pool, record);
    if (time) meta.appendChild(time);
    if (pool !== "NEW_REPLY" && record.lastPosterUsername) {
      const poster = document.createElement("span");
      poster.textContent = `最后回复：${record.lastPosterUsername}`;
      meta.appendChild(poster);
    }

    const actions = document.createElement("div");
    actions.className = "ldfc-panel-actions";

    if (pool === "NEW_REPLY") {
      actions.appendChild(actionButton("进入未读位置", () => {
        window.location.href = window.LDFCDiscourseAdapter.topicUnreadUrl(record);
      }));
    }

    actions.appendChild(actionButton("移回主信息流", async () => {
      await window.LDFCPoolManager.moveHome(record.topicId, record);
      refresh();
    }));

    // 每条记录都可以直接挪到别的池子，不用先移回主信息流再重新标记。
    // 目标用一排小胶囊就地展开（<select> 的弹层会被面板 overflow 裁掉）。
    const moveTargets = document.createElement("div");
    moveTargets.className = "ldfc-move-targets";
    moveTargets.hidden = true;
    for (const target of MOVE_TARGETS) {
      if (target.pool === pool) continue;
      const button = actionButton(target.label, async () => {
        await window.LDFCPoolManager.moveToPool(record.topicId, target.pool, record);
        refresh();
        window.LDFCToast.show(`已移入“${target.name}”`);
      });
      if (!window.LDFCPoolManager.canMoveTo(record.topicId, target.pool)) {
        button.disabled = true;
        button.title = "「新回复」只对已归入「感兴趣 / 已读」的 Topic 有效";
      }
      moveTargets.appendChild(button);
    }

    const moveToggle = actionButton("移入…", () => {
      moveTargets.hidden = !moveTargets.hidden;
      moveToggle.setAttribute("aria-expanded", String(!moveTargets.hidden));
    });
    moveToggle.setAttribute("aria-expanded", "false");
    moveToggle.title = "把这条 Topic 移到其他信息池";
    actions.appendChild(moveToggle);

    // 不感兴趣区里再给一个"× 不感兴趣"没有意义，只保留恢复入口。
    if (pool !== "DISMISSED") {
      actions.appendChild(actionButton("× 不感兴趣", async () => {
        await window.LDFCPoolManager.dismissFromAnyPool(record.topicId, record);
        refresh();
        window.LDFCToast.show("已移入“不感兴趣”", "撤销", async () => {
          await window.LDFCPoolManager.moveHome(record.topicId, record);
          refresh();
        });
      }));
    }

    item.append(header);
    if (meta.childElementCount) item.appendChild(meta);

    if (pool === "NEW_REPLY") {
      const preview = previewElement(record);
      if (preview) item.appendChild(preview);
    }

    item.appendChild(actions);
    item.appendChild(moveTargets);

    // 长按这条记录（按钮区以外）＝ 进入池内多选；单选态下点记录＝勾选。
    // 与列表页的长按入口保持一致，但两者操作的是不同的 DOM，状态互不相干。
    if (!selecting) {
      let pressTimer = 0;
      const clearPress = () => {
        clearTimeout(pressTimer);
        pressTimer = 0;
      };
      item.addEventListener("pointerdown", (event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        if (event.target.closest(".ldfc-panel-actions, .ldfc-move-targets")) return;
        clearPress();
        pressTimer = setTimeout(() => {
          pressTimer = 0;
          enterSelection(topicId, pool);
        }, 500);
      });
      item.addEventListener("pointerup", clearPress);
      item.addEventListener("pointercancel", clearPress);
      item.addEventListener("pointerleave", clearPress);
      item.addEventListener("contextmenu", (event) => {
        // 触屏长按标题链接会弹系统菜单，把多选入口挡住
        if (event.target.closest("a")) event.preventDefault();
      });
    } else {
      item.addEventListener(
        "click",
        (event) => {
          event.preventDefault();
          event.stopPropagation();
          // 长按松手时浏览器补发的这次 click 不算勾选
          if (Date.now() < ignoreItemClicksUntil) return;
          toggleSelection(topicId);
        },
        true
      );
    }
    return item;
  }

  // ---- 池内多选 ----

  function enterSelection(topicId, pool) {
    if (selecting) return;
    selecting = true;
    selection.clear();
    if (topicId) selection.add(String(topicId));
    // 长按松手时浏览器会补一次 click，别让它立刻把这一条取消掉
    ignoreItemClicksUntil = Date.now() + 400;
    panel?.classList.add("ldfc-pool-selecting");
    render(pool);
  }

  function exitSelection({ rerender = true } = {}) {
    if (!selecting) return;
    selecting = false;
    selection.clear();
    panel?.classList.remove("ldfc-pool-selecting");
    if (rerender && renderedPool) render(renderedPool);
  }

  function toggleSelection(topicId) {
    if (selection.has(topicId)) selection.delete(topicId);
    else selection.add(topicId);

    const item = listEl?.querySelector(`.ldfc-panel-item[data-ldfc-panel-topic="${topicId}"]`);
    item?.classList.toggle("ldfc-selected", selection.has(topicId));
    const countEl = panel?.querySelector(".ldfc-bulk-count");
    if (countEl) countEl.textContent = `已选 ${selection.size}`;
    const moveBtn = panel?.querySelector(".ldfc-bulk-move");
    if (moveBtn) moveBtn.disabled = selection.size === 0;
  }

  async function applySelection(target) {
    const ids = [...selection];
    let moved = 0;
    let skipped = 0;
    for (const topicId of ids) {
      // 与单条「移入…」同一条规则：新回复只接受感兴趣 / 已读，其他直接跳过
      if (!window.LDFCPoolManager.canMoveTo(topicId, target.pool)) {
        skipped += 1;
        continue;
      }
      await window.LDFCPoolManager.moveToPool(topicId, target.pool, {});
      moved += 1;
    }

    exitSelection({ rerender: false });
    refresh();
    window.LDFCToast?.show?.(
      skipped
        ? `已移入“${target.name}” ${moved} 个，跳过 ${skipped} 个（「新回复」只对感兴趣 / 已读有效）`
        : `已把 ${moved} 个移入“${target.name}”`
    );
  }

  function refresh() {
    render(window.LDFCFilter.getActivePool());
    window.LDFCNavigation.render();
    window.LDFCFilter.applyRows();
  }

  // ---- 渲染 ----

  function recordsFor(pool) {
    if (pool === "NEW_REPLY") return window.LDFCTopicState.listNewReply(sortPrefs.NEW_REPLY);
    return window.LDFCTopicState.listByPool(pool, sortPrefs[pool]);
  }

  function renderSortRow(pool) {
    const options = SORT_OPTIONS[pool];
    if (!options) return null;

    const row = document.createElement("div");
    row.className = "ldfc-sort-row";

    for (const option of options) {
      const button = actionButton(option.label, async () => {
        await saveSortPreference(pool, option.value);
        // 换排序等于重新开始看这个列表
        patchView(pool, { scrollTop: 0, count: BATCH_SIZE });
        render(pool);
      });
      button.classList.toggle("active", sortPrefs[pool] === option.value);
      row.appendChild(button);
    }

    return row;
  }

  function updateFooter() {
    if (!footerEl) return;
    const total = renderedRecords.length;
    const shown = listEl ? listEl.childElementCount : 0;
    footerEl.textContent =
      shown >= total ? `已全部加载（共 ${total} 条）` : `已显示 ${shown} / ${total} 条，向下滚动继续加载`;
  }

  function appendBatch() {
    if (!listEl || !renderedPool) return;

    const start = listEl.childElementCount;
    if (start >= renderedRecords.length) {
      updateFooter();
      return;
    }

    const end = Math.min(start + BATCH_SIZE, renderedRecords.length);
    const fragment = document.createDocumentFragment();
    for (let index = start; index < end; index += 1) {
      fragment.appendChild(renderItem(renderedRecords[index], renderedPool));
    }
    listEl.appendChild(fragment);

    patchView(renderedPool, { count: end });
    updateFooter();
  }

  function onPanelScroll() {
    if (!renderedPool) return;
    patchView(renderedPool, { scrollTop: panel.scrollTop });

    const nearBottom =
      panel.scrollTop + panel.clientHeight >= panel.scrollHeight - NEXT_BATCH_THRESHOLD_PX;
    if (nearBottom) appendBatch();
  }

  function render(pool) {
    if (!panel) return;

    // 离开当前池前先记住滚动位置，回来时恢复，而不是跳回顶部。
    if (renderedPool && renderedPool !== pool) {
      patchView(renderedPool, { scrollTop: panel.scrollTop });
    }

    // 切到别的池 / 关闭面板时结束池内多选，否则会带着旧选中跨池操作
    if (selecting && renderedPool && renderedPool !== pool) exitSelection({ rerender: false });

    if (pool === "HOME") {
      window.LDFCNavigation?.hideSheet?.(panel);
      renderedPool = null;
      return;
    }

    // 只有「从隐藏变可见」才是展开：之后点排序 / 标记重绘都是原地更新，
    // 不能每次都把面板缩回去再长一遍。
    // 正在收起时又被叫来渲染（同步刷新、点另一条记录）也算展开：
    // 否则这 360ms 里画上去的内容会跟着收起动画一起消失。
    const reopening = panel.hidden || panel.dataset.sheetState === "closing";
    panel.hidden = false;
    // 每次重新展开都回到未固定：点外面能关才是手机的默认手感。
    if (reopening) panel.dataset.pinned = "false";

    // 设置/向导面板和本面板占同一块区域，同时打开会互相遮挡，必须互斥。
    const settings = document.getElementById("ldfc-settings");
    if (settings) settings.hidden = true;

    renderedPool = pool;
    renderedRecords = recordsFor(pool);

    panel.innerHTML = "";

    // 面板占了半屏，必须自带关闭入口：只靠导航栏切回「主信息流」
    // 在窗口窄、导航被遮挡时等于没有出口。
    const header = document.createElement("div");
    header.className = "ldfc-panel-header";
    const title = document.createElement("h2");
    title.textContent = POOL_TITLES[pool] ?? pool;
    const close = document.createElement("button");
    close.type = "button";
    close.id = "ldfc-panel-close";
    close.className = "ldfc-panel-close";
    close.textContent = "×";
    close.title = "关闭面板";
    close.setAttribute("aria-label", "关闭面板");
    const closeSheet = () => {
      window.LDFCFilter.setActivePool("HOME");
      render("HOME");
      window.LDFCContent?.decorateRows?.();
      window.LDFCNavigation?.render?.();
    };
    close.addEventListener("click", closeSheet);

    // 标题行的「固定」开关：默认不固定，点面板外自动关（手机上更快）；
    // 固定后点外面不关。每次重新展开都会回到未固定，见上面的 reopening。
    const pin = document.createElement("button");
    pin.type = "button";
    pin.id = "ldfc-panel-pin";
    pin.className = "ldfc-sheet-pin";
    pin.textContent = "📌";
    pin.title = "固定面板（点外面不会关闭）";
    pin.setAttribute("aria-label", "固定面板");
    pin.setAttribute("aria-pressed", String(panel.dataset.pinned === "true"));
    pin.addEventListener("click", () => {
      const next = panel.dataset.pinned !== "true";
      panel.dataset.pinned = String(next);
      pin.setAttribute("aria-pressed", String(next));
      pin.title = next ? "已固定：点外面不会关闭" : "固定面板（点外面不会关闭）";
    });

    const tools = document.createElement("div");
    tools.className = "ldfc-sheet-tools";
    // 池内多选时，标题行换成「已选 N + 移入… + 完成」：进入入口仍是长按，
    // 不额外增加常驻按钮；批量目标沿用同一个 MOVE_TARGETS 胶囊行。
    let bulkTargets = null;
    if (selecting) {
      const bulk = document.createElement("div");
      bulk.className = "ldfc-bulk";

      const countEl = document.createElement("span");
      countEl.className = "ldfc-bulk-count";
      countEl.textContent = `已选 ${selection.size}`;

      const moveBtn = document.createElement("button");
      moveBtn.type = "button";
      moveBtn.className = "ldfc-bulk-move";
      moveBtn.textContent = "移入…";
      moveBtn.disabled = selection.size === 0;
      moveBtn.setAttribute("aria-expanded", "false");

      const done = document.createElement("button");
      done.type = "button";
      done.className = "ldfc-bulk-done";
      done.textContent = "完成";
      done.addEventListener("click", () => exitSelection());

      bulk.append(countEl, moveBtn, done);
      tools.append(bulk);

      bulkTargets = document.createElement("div");
      bulkTargets.className = "ldfc-move-targets ldfc-bulk-targets";
      bulkTargets.hidden = true;
      for (const target of MOVE_TARGETS) {
        if (target.pool === pool) continue;
        bulkTargets.appendChild(actionButton(target.label, () => applySelection(target)));
      }
      moveBtn.addEventListener("click", () => {
        bulkTargets.hidden = !bulkTargets.hidden;
        moveBtn.setAttribute("aria-expanded", String(!bulkTargets.hidden));
      });
    }
    tools.append(pin, close);
    header.append(title, tools);
    panel.appendChild(header);
    if (bulkTargets) panel.appendChild(bulkTargets);

    const sortRow = renderSortRow(pool);
    if (sortRow) panel.appendChild(sortRow);

    if (!renderedRecords.length) {
      const empty = document.createElement("p");
      empty.textContent = "这个信息池暂时是空的。";
      panel.appendChild(empty);
      if (reopening) window.LDFCNavigation?.revealSheet?.(panel);
      return;
    }

    listEl = document.createElement("div");
    listEl.className = "ldfc-panel-list";
    panel.appendChild(listEl);

    footerEl = document.createElement("p");
    footerEl.className = "ldfc-panel-footer";
    panel.appendChild(footerEl);

    // 恢复上次渲染的条数：内容高度对得上，滚动位置才恢复得回去。
    const view = viewFor(pool);
    const target = Math.max(BATCH_SIZE, Math.min(view.count, renderedRecords.length));

    while (listEl.childElementCount < target) {
      const before = listEl.childElementCount;
      appendBatch();
      if (listEl.childElementCount === before) break;
    }

    requestAnimationFrame(() => {
      panel.scrollTop = view.scrollTop;
    });

    // 新回复预览要读 Topic 详情，属于按需网络请求：只在面板打开、
    // 并且正在显示新回复时触发，抓完回填一次。
    if (pool === "NEW_REPLY") {
      window.LDFCNewReply.ensurePreviews(renderedRecords, () => {
        if (renderedPool === pool && window.LDFCFilter.getActivePool() === pool) render(pool);
      });
    }

    // 内容高度定了再展开：transform-origin 要按最终尺寸算，否则会偏。
    if (reopening) window.LDFCNavigation?.revealSheet?.(panel);
  }

  function create() {
    if (panel) return panel;

    panel = document.createElement("aside");
    panel.id = "ldfc-panel";
    panel.hidden = true;
    panel.addEventListener("scroll", onPanelScroll, { passive: true });
    document.body.appendChild(panel);
    // 未固定时点面板外部即关闭（固定按钮在标题行里）。
    window.LDFCNavigation?.bindSheetDismiss?.(panel, () => {
      window.LDFCFilter.setActivePool("HOME");
      render("HOME");
      window.LDFCContent?.decorateRows?.();
      window.LDFCNavigation?.render?.();
    });
    return panel;
  }

  document.addEventListener(
    "keydown",
    (event) => {
      if (!selecting || event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      exitSelection();
    },
    true
  );

  window.LDFCPoolPanel = { create, loadSortPreference, render };
})();
