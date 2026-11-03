(() => {
  // 多选 + 拖拽投放。入口永远是行尾那枚「悬浮按钮」（三个池子按钮的胶囊），
  // 不新增任何按钮：
  //
  //   按住不动 ~500ms      → 抖一下 → 进入多选
  //   多选里点胶囊         → 勾选 / 取消这一条（点标题照常打开帖子）
  //   多选里双击同一胶囊   → 退出多选
  //   按住并移动胶囊       → 拖拽投放：胶囊跟手，五个池子在它周围展开，
  //                          松手落在某一格 = 移入该池，胶囊随后弹回原位
  //
  // 未多选时拖拽投放的是这枚胶囊所属的那条 Topic：列表页只有鼠标所在行才有
  // 胶囊，帖子页则对应当前主贴，不会串到别的行上。
  const LONG_PRESS_MS = 500;
  // 长按结束 / 拖拽结束松手时浏览器会补一次 click，别让它立刻标记录入。
  const IGNORE_CLICK_MS = 400;
  // 超过这个位移就不再算「按住不动」，改为拖拽投放。
  const DRAG_START_PX = 6;
  // 触摸端「按住再拖」：按住超过这个时间后，移动一律算拖拽（拦掉翻页）。
  const HOLD_TO_DRAG_MS = 180;
  const DOUBLE_CLICK_MS = 320;
  const DOUBLE_CLICK_PX = 6;

  const POOL_NAMES = {
    HOME: "主信息流",
    INTERESTED: "感兴趣",
    NEW_REPLY: "新回复",
    READ: "已读",
    DISMISSED: "不感兴趣"
  };

  // 半圆扇形：胶囊在圆心，五个池子沿上半圈 155°→25° 展开。
  // 半径要按胶囊实际宽度自适应，否则两侧格子会压在胶囊身上（胶囊约 130px 宽）。
  const DROP_RADIUS_MIN = 132;
  const DROP_RADIUS_GAP = 64;
  // 角度不铺满 180°：贴着水平线的那两格离胶囊太近，视觉上会糊成一团。
  const DROP_ARC_START = (155 * Math.PI) / 180;
  const DROP_ARC_END = (25 * Math.PI) / 180;
  const DROP_HIT_RADIUS = 32;
  const DROP_ICONS = {
    HOME: '<path d="M12 3.1 20.1 7.4 12 11.7 3.9 7.4 12 3.1Z"/><path d="m4.5 11.9 7.5 3.9 7.5-3.9"/>',
    INTERESTED: '<path d="M12 3.6l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8Z"/>',
    NEW_REPLY: '<path d="M4.6 6.3h14.8v9.1H11l-4.4 3.3v-3.3H4.6z"/>',
    READ: '<path d="M5 12.8l4.3 4.3L19 7.3"/>',
    DISMISSED: '<path d="M7 7l10 10M17 7L7 17"/>'
  };
  const DROP_ORDER = ["HOME", "INTERESTED", "NEW_REPLY", "READ", "DISMISSED"];

  const selected = new Map();
  let active = false;
  let ignoreClicksUntil = 0;

  let press = null; // { layer, pointerId, x, y, moved, timer }
  let drag = null; // { layer, pointerId, origin, startX, startY, targets, hot }
  let dropPanel = null;
  let lastClick = { layer: null, at: 0, x: 0, y: 0 };

  function isActive() {
    return active;
  }

  function count() {
    return selected.size;
  }

  function isDragging() {
    return Boolean(drag);
  }

  function layerOf(target) {
    return target?.closest?.(".ldfc-actions") ?? null;
  }

  function rowOf(layer) {
    return layer?.closest?.("[data-topic-id]") ?? null;
  }

  function topicOf(layer) {
    const row = rowOf(layer);
    const topic = row ? window.LDFCTopicParser?.extractTopic?.(row) : null;
    const topicId = String(
      topic?.topicId || layer?.dataset.ldfcTopic || row?.dataset.topicId || ""
    );
    if (!topicId) return null;
    return { topicId, title: topic?.title ?? "", slug: topic?.slug ?? "" };
  }

  function syncBadge() {
    const nav = document.getElementById("ldfc-navigation");
    if (!nav) return;
    let badge = nav.querySelector(".ldfc-select-count");
    if (!active || !selected.size) {
      badge?.remove();
      return;
    }
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ldfc-select-count";
      nav.appendChild(badge);
    }
    badge.textContent = `已选 ${selected.size}`;
  }

  function enter() {
    if (active) return;
    active = true;
    ignoreClicksUntil = Date.now() + IGNORE_CLICK_MS;
    document.documentElement.classList.add("ldfc-selecting");
    // 抖一下 = 「已经进入多选，按钮现在改用途了」，比弹提示更快被感知
    for (const layer of document.querySelectorAll(".ldfc-actions")) {
      layer.classList.remove("ldfc-shake");
      void layer.offsetWidth;
      layer.classList.add("ldfc-shake");
      setTimeout(() => layer.classList.remove("ldfc-shake"), 460);
    }
    window.LDFCToast?.show?.(
      "已进入多选：点各行的悬浮按钮选择，点标题仍可正常打开；按住任意一枚拖到池子上即可移入",
      "退出",
      exit
    );
    syncBadge();
  }

  function exit() {
    if (!active) return;
    active = false;
    selected.clear();
    lastClick = { layer: null, at: 0, x: 0, y: 0 };
    document.documentElement.classList.remove("ldfc-selecting");
    for (const row of document.querySelectorAll(".ldfc-selected")) {
      row.classList.remove("ldfc-selected");
    }
    syncBadge();
  }

  function toggle(layer) {
    const row = rowOf(layer);
    const topic = topicOf(layer);
    if (!row || !topic) return;

    if (selected.has(topic.topicId)) {
      selected.delete(topic.topicId);
      row.classList.remove("ldfc-selected");
    } else {
      selected.set(topic.topicId, { ...topic, row });
      row.classList.add("ldfc-selected");
    }
    syncBadge();
  }

  // ---- 拖拽投放 ----

  function buildDropPanel(flipped, radius) {
    const panel = document.createElement("div");
    panel.className = "ldfc-drop";
    if (flipped) panel.classList.add("ldfc-drop-flipped");
    panel.setAttribute("aria-hidden", "true");
    panel.style.setProperty("--r", `${Math.round(radius)}px`);
    DROP_ORDER.forEach((pool, index) => {
      const step = (DROP_ARC_START - DROP_ARC_END) / (DROP_ORDER.length - 1);
      const angle = DROP_ARC_START - step * index;
      const item = document.createElement("div");
      item.className = "ldfc-drop-item";
      item.dataset.pool = pool;
      item.title = POOL_NAMES[pool];
      item.style.setProperty("--dx", `${Math.round(Math.cos(angle) * radius)}px`);
      // 上方空间不够时整圈翻到下面，否则格子会跑出视口。
      const dy = Math.sin(angle) * radius * (flipped ? 1 : -1);
      item.style.setProperty("--dy", `${Math.round(dy)}px`);
      item.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DROP_ICONS[pool]}</svg>`;
      panel.appendChild(item);
    });

    // 锚点 + 牵引线：胶囊跟手走，扇形却钉在原地，没有这两样东西
    // 画面读起来就是"一堆格子旁边飘着一个胶囊"，看不出是从圆心拖出去的。
    const anchor = document.createElement("div");
    anchor.className = "ldfc-drop-anchor";
    panel.appendChild(anchor);
    const link = document.createElement("div");
    link.className = "ldfc-drop-link";
    panel.appendChild(link);

    return panel;
  }

  function placeDropPanel(centerX, centerY) {
    if (!dropPanel) return;
    dropPanel.style.left = `${Math.round(centerX)}px`;
    dropPanel.style.top = `${Math.round(centerY)}px`;
  }

  // 判定看的是**胶囊中心**：面板固定在按下处展开，用户把胶囊拖进某一格。
  // 不能用指针坐标 —— 胶囊跟手，指针永远落在圆心，外圈格子就永远够不到。
  function hitTest(capsuleX, capsuleY) {
    let hit = null;
    for (const item of dropPanel?.querySelectorAll(".ldfc-drop-item") ?? []) {
      const dx = Number.parseFloat(item.style.getPropertyValue("--dx")) || 0;
      const dy = Number.parseFloat(item.style.getPropertyValue("--dy")) || 0;
      const distance = Math.hypot(
        capsuleX - (drag.panelCenter.x + dx),
        capsuleY - (drag.panelCenter.y + dy)
      );
      if (distance <= DROP_HIT_RADIUS) hit = item.dataset.pool;
    }
    return hit;
  }

  function syncDropHighlight() {
    for (const item of dropPanel?.querySelectorAll(".ldfc-drop-item") ?? []) {
      const usable = window.LDFCPoolManager?.canMoveTo?.(
        drag?.targets?.[0]?.topicId ?? "",
        item.dataset.pool
      );
      // 「新回复」只接受已归入感兴趣 / 已读的条目：不可用时置灰但保留格子，
      // 否则用户会以为少了一格。
      item.classList.toggle("ldfc-disabled", usable === false);
      item.classList.toggle("ldfc-hot", drag?.hot === item.dataset.pool);
    }
  }

  function collectTargets(layer) {
    if (active && selected.size) {
      return [...selected.values()].map((entry) => ({
        topicId: entry.topicId,
        title: entry.title,
        slug: entry.slug
      }));
    }
    const topic = topicOf(layer);
    return topic ? [topic] : [];
  }

  function beginDrag() {
    const layer = press.layer;
    const rect = layer.getBoundingClientRect();
    const targets = collectTargets(layer);
    if (!targets.length) return false;

    drag = {
      layer,
      pointerId: press.pointerId,
      origin: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      // 面板固定在按下那一刻的位置展开，不跟着胶囊跑。
      panelCenter: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 },
      startX: press.x,
      startY: press.y,
      targets,
      hot: null
    };

    layer.classList.add("ldfc-dragging");
    layer.style.left = `${Math.round(rect.left)}px`;
    layer.style.top = `${Math.round(rect.top)}px`;

    const centerY = rect.top + rect.height / 2;
    // 顶部放不下就把半圆翻到下面（列表第一条经常贴着导航栏）。
    const radius = Math.max(DROP_RADIUS_MIN, rect.width / 2 + DROP_RADIUS_GAP);
    const flipped = centerY - radius - 28 < 0;
    dropPanel = buildDropPanel(flipped, radius);
    document.body.appendChild(dropPanel);
    placeDropPanel(drag.panelCenter.x, drag.panelCenter.y);
    syncDropHighlight();
    requestAnimationFrame(() => dropPanel?.classList.add("ldfc-drop-open"));
    return true;
  }

  function moveDrag(event) {
    if (!drag) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    const left = drag.origin.left + dx;
    const top = drag.origin.top + dy;
    drag.layer.style.left = `${Math.round(left)}px`;
    drag.layer.style.top = `${Math.round(top)}px`;

    const centerX = left + drag.origin.width / 2;
    const centerY = top + drag.origin.height / 2;
    syncLink(centerX, centerY);

    const hot = hitTest(centerX, centerY);
    if (hot !== drag.hot) {
      drag.hot = hot;
      syncDropHighlight();
    }
  }

  function syncLink(capsuleX, capsuleY) {
    const link = dropPanel?.querySelector(".ldfc-drop-link");
    if (!link) return;
    const dx = capsuleX - drag.panelCenter.x;
    const dy = capsuleY - drag.panelCenter.y;
    link.style.setProperty("--len", `${Math.round(Math.hypot(dx, dy))}px`);
    link.style.setProperty("--ang", `${Math.atan2(dy, dx)}rad`);
  }

  function snapBack() {
    const layer = drag?.layer;
    const origin = drag?.origin;
    if (!layer || !origin) return;
    layer.classList.add("ldfc-snap-back");
    requestAnimationFrame(() => {
      layer.style.left = `${Math.round(origin.left)}px`;
      layer.style.top = `${Math.round(origin.top)}px`;
    });
    setTimeout(() => {
      layer.classList.remove("ldfc-dragging", "ldfc-snap-back");
      layer.style.position = "";
      layer.style.left = "";
      layer.style.top = "";
      layer.style.zIndex = "";
    }, 300);
  }

  async function applyDrop(pool, targets) {
    let moved = 0;
    let skipped = 0;

    for (const target of targets) {
      if (!window.LDFCPoolManager.canMoveTo(target.topicId, pool)) {
        skipped += 1;
        continue;
      }
      await window.LDFCPoolManager.moveToPool(target.topicId, pool, {
        title: target.title,
        slug: target.slug
      });
      moved += 1;
    }

    const name = POOL_NAMES[pool] ?? pool;
    if (moved) {
      window.LDFCToast?.show?.(moved > 1 ? `已把 ${moved} 个标题移入“${name}”` : `已移入“${name}”`);
    } else if (skipped) {
      window.LDFCToast?.show?.(`「${name}」只对已归入感兴趣 / 已读的主题有效`);
    }

    if (active) exit();
    window.LDFCNavigation?.render?.();
    window.LDFCFilter?.applyRows?.();
    window.LDFCContent?.decorateRows?.();
  }

  function endDrag() {
    if (!drag) return;
    const pool = drag.hot;
    const targets = drag.targets;
    dropPanel?.remove();
    dropPanel = null;
    snapBack();
    drag = null;
    ignoreClicksUntil = Date.now() + IGNORE_CLICK_MS;

    if (pool && targets.length) applyDrop(pool, targets).catch(() => {});
  }

  // ---- 指针事件 ----

  function clearPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = null;
  }

  function bindLongPress(layer) {
    if (layer.dataset.ldfcLongPress === "1") return;
    layer.dataset.ldfcLongPress = "1";

    layer.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      if (drag) return;
      clearPress();
      press = {
        layer,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        moved: false,
        timer: 0
      };
      // 这里**不能**捕获指针：一旦捕获，后续 click 的目标会变成整枚胶囊，
      // 里面三个按钮的点击就收不到了（普通标记随之失效）。
      // 只在真正进入拖拽时再捕获。
      press.timer = setTimeout(() => {
        if (!press || press.moved) return;
        press.timer = 0;
        enter();
      }, LONG_PRESS_MS);
    });

    layer.addEventListener("pointermove", (event) => {
      if (drag) {
        if (event.pointerId === drag.pointerId) moveDrag(event);
        return;
      }
      if (!press || event.pointerId !== press.pointerId) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.moved && Math.hypot(dx, dy) > DRAG_START_PX) {
        press.moved = true;
        clearTimeout(press.timer);
        press.timer = 0;
        try {
          layer.setPointerCapture(event.pointerId);
        } catch {
          // 不支持指针捕获时，靠 layer 上的 move 事件也能拖
        }
        if (!beginDrag()) return;
      }
      if (drag) moveDrag(event);
    });

    layer.addEventListener("pointerup", () => {
      if (drag) endDrag();
      clearPress();
    });
    layer.addEventListener("pointercancel", () => {
      if (drag) {
        dropPanel?.remove();
        dropPanel = null;
        snapBack();
        drag = null;
      }
      clearPress();
    });
    layer.addEventListener("contextmenu", (event) => {
      // 手机上长按会弹系统菜单，把多选 / 拖拽的入口挡住
      if (!active) event.preventDefault();
    });

    // 触摸端：按住 180ms 再移动 = 拖到池子；快速滑过 = 正常翻页。
    // 浏览器在第一次 touchmove 时就决定要不要滚屏，一旦滚起来立刻发
    // pointercancel，拖拽刚建立就被掐断（真机复现：pointercancel=1，页面跟着滚）。
    // 非被动的 touchmove 在「按住够久」之后拦掉滚动，快速滑动仍然放行。
    let holdReady = false;
    let holdTimer = 0;
    const clearHold = () => {
      clearTimeout(holdTimer);
      holdTimer = 0;
      holdReady = false;
    };
    layer.addEventListener(
      "touchstart",
      () => {
        clearHold();
        holdTimer = setTimeout(() => {
          holdReady = true;
        }, HOLD_TO_DRAG_MS);
      },
      { passive: true }
    );
    layer.addEventListener("touchmove", (event) => {
      if (holdReady) event.preventDefault();
    });
    layer.addEventListener("touchend", clearHold, { passive: true });
    layer.addEventListener("touchcancel", clearHold, { passive: true });
  }

  // ---- 点击：多选里 = 勾选；同一枚双击 = 退出多选 ----

  document.addEventListener(
    "click",
    (event) => {
      if (!active) return;
      const layer = layerOf(event.target);
      if (!layer) return;
      event.preventDefault();
      event.stopPropagation();
      if (Date.now() < ignoreClicksUntil) return;

      const now = Date.now();
      const isDouble =
        lastClick.layer === layer &&
        now - lastClick.at < DOUBLE_CLICK_MS &&
        Math.hypot(event.clientX - lastClick.x, event.clientY - lastClick.y) < DOUBLE_CLICK_PX;

      if (isDouble) {
        lastClick = { layer: null, at: 0, x: 0, y: 0 };
        exit();
        return;
      }

      lastClick = { layer, at: now, x: event.clientX, y: event.clientY };
      toggle(layer);
    },
    true
  );

  document.addEventListener(
    "keydown",
    (event) => {
      if (!active || event.key !== "Escape") return;
      // 不要让 Esc 顺带把一级面板也收了
      event.preventDefault();
      event.stopPropagation();
      exit();
    },
    true
  );

  // 点页面空白处也退出多选（点在胶囊 / 导航 / 面板 / 预览窗 / 帖子链接上不算）。
  // 帖子标题要放行：多选进行中点标题是"预览一下这条"，不是"结束多选"——
  // 以前这里一律 exit()，导致预览窗一开选中集合就没了（桌面端反馈）。
  document.addEventListener(
    "pointerdown",
    (event) => {
      if (!active) return;
      if (
        event.target?.closest?.(
          ".ldfc-actions, #ldfc-navigation, #ldfc-panel, #ldfc-settings, .ldp-overlay, a[href*='/t/']"
        )
      ) {
        return;
      }
      exit();
    },
    true
  );

  // 换页 / 换池子后行都不在了，选中集合必须清掉，否则会带着旧 ID 批量操作。
  window.addEventListener("ldfc:route-change", exit);
  window.addEventListener("popstate", exit);

  window.LDFCMultiSelect = {
    bindLongPress,
    count,
    enter,
    exit,
    isActive,
    isDragging,
    toggle
  };
})();
