(() => {
  // 列表行悬停按钮 / 首楼按钮 / 预览窗 dock 是同一套动作，视觉必须一致：
  // 单色图标 + 悬停旋转 + 横向展开文字，颜色一律 inherit（亮/暗主题都不用改）。
  // 图标路径与 ui/launcher.js 的 DOCK_ICONS 相同；只有三个短路径，
  // 抽公共模块要动 manifest 加载顺序，收益不抵风险，这里保留重复并注明出处。
  const ICONS = {
    INTERESTED:
      '<path d="m12 3 2.75 5.57 6.15.9-4.45 4.34 1.05 6.13L12 17l-5.5 2.94 1.05-6.13L3.1 9.47l6.15-.9L12 3Z"/>',
    READ: '<path d="m5 12.5 4.2 4 9.8-9.5"/>',
    DISMISSED: '<path d="m6 6 12 12M18 6 6 18"/>'
  };

  function actionButton(className, pool, label) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ldfc-action ${className}`;
    // 光效与多选都按池子取按钮，用属性比拆 class 稳（站点重渲染会改 class）。
    button.dataset.pool = pool;
    button.title = label;
    button.setAttribute("aria-label", label);

    const icon = document.createElement("span");
    icon.className = "ldfc-action-icon";
    icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[pool]}</svg>`;

    const text = document.createElement("span");
    text.className = "ldfc-action-text";
    text.textContent = label;

    button.append(icon, text);
    return button;
  }

  // 「这条已经在哪个池」——只在按钮上画一条底线 + 图标着色，
  // 判定只看 basePool，多个池同时点亮是不可能的（四池模型单一归属）。
  function paintLayer(layer) {
    const topicId = layer.dataset.ldfcTopic ?? layer.closest("[data-topic-id]")?.dataset.topicId;
    let pool = null;
    try {
      pool = topicId ? window.LDFCTopicState?.get?.(topicId)?.basePool ?? null : null;
    } catch {
      pool = null;
    }
    for (const button of layer.querySelectorAll("button[data-pool]")) {
      button.classList.toggle("is-in-pool", button.dataset.pool === pool);
    }
  }

  function paintAll() {
    for (const layer of document.querySelectorAll(".ldfc-actions")) paintLayer(layer);
  }

  function createActionLayer(topic) {
    const layer = document.createElement("div");
    layer.className = "ldfc-actions";

    const interested = actionButton("interested", "INTERESTED", "感兴趣");
    const read = actionButton("read", "READ", "已读");
    const dismissed = actionButton("dismissed", "DISMISSED", "不感兴趣");

    interested.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.LDFCContent.markInterested(topic);
    });

    read.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.LDFCContent.markRead(topic);
    });

    dismissed.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      window.LDFCContent.markDismissed(topic);
    });

    layer.append(interested, read, dismissed);
    // 长按这组按钮 = 进入多选（见 interaction/multiSelect.js）。
    // 入口复用已有的按钮组，不额外加"多选"按钮。
    window.LDFCMultiSelect?.bindLongPress?.(layer);
    return layer;
  }

  function decorateRow(topic) {
    const row = topic.row;
    // 推荐 / 相关是表格行，按钮层塞进第一个单元格才不会被表格布局吃掉。
    const host = row.tagName === "TR" ? row.querySelector("td, th") ?? row : row;
    // 按钮层是 absolute 定位（right: 12px），宿主必须是定位上下文。
    // 真实站点的搜索卡片 / 推荐列表类名无法穷举，光靠 CSS 选择器会漏，
    // 漏掉时按钮会相对页面根节点定位，位置随标题长度乱跑。
    // 用内联样式兜底，只在 static 时才写，不覆盖站点自己的定位。
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    const existing = row.querySelector(".ldfc-actions");

    if (existing) {
      // 原站重渲染会重写 class 属性，把 ldFC 的类名冲掉；按钮层却还在。
      // 只判断"有按钮层"会把这种行当成已处理，类名再也补不回来。
      row.classList.add("ldfc-topic-row");

      // 同一行节点被复用到别的 Topic 时，旧按钮点下去会标错条目，必须重建。
      // 注意：不能用 data-topic-id 记，那会让按钮层本身变成"一条 Topic 行"。
      if (existing.dataset.ldfcTopic === topic.topicId) {
        paintLayer(existing);
        return;
      }
      existing.remove();
    }

    row.classList.add("ldfc-topic-row");
    const layer = createActionLayer(topic);
    layer.dataset.ldfcTopic = String(topic.topicId);
    host.appendChild(layer);
    paintLayer(layer);
  }

  window.LDFCDesktopActions = {
    decorateRow,
    paintAll
  };

  // ---- 触摸端：滚动停下就把那一行的文字展开一次 ----
  //
  // 桌面的「移入展开」在触摸端没有对应物：手指滑过整屏时是"推杆"，
  // 不是"瞄准器"，滑动中展开的永远是路过的行。所以只在手停下来之后
  // 做一次命中测试，展开 1.6s；按下按钮另有 CSS :active 兜底。
  // 滚动期间只清状态、不做 DOM 查询，避免掉帧。
  const PEEK_SETTLE_MS = 280;
  const PEEK_HOLD_MS = 1600;
  let peekEl = null;
  let peekTimer = 0;
  let peekClearTimer = 0;
  let lastPoint = null;

  function removePeek() {
    if (!peekEl) return;
    peekEl.classList.remove("ldfc-row-peek");
    peekEl = null;
  }

  function clearPeek() {
    clearTimeout(peekTimer);
    clearTimeout(peekClearTimer);
    peekTimer = 0;
    peekClearTimer = 0;
    removePeek();
  }

  function armPeek() {
    if (!lastPoint) return;
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      peekTimer = 0;
      removePeek();
      const hit = document.elementFromPoint(lastPoint.x, lastPoint.y);
      // 手指落点通常在标题上，按钮组贴在行右侧 —— 先回到整行，再取行内的按钮组。
      const row = hit?.closest?.("[data-topic-id], .ldfc-topic-row");
      const layer = row?.querySelector?.(".ldfc-actions") ?? hit?.closest?.(".ldfc-actions") ?? null;
      if (!layer) return;
      peekEl = layer;
      layer.classList.add("ldfc-row-peek");
      peekClearTimer = setTimeout(removePeek, PEEK_HOLD_MS);
    }, PEEK_SETTLE_MS);
  }

  // 细指针环境不需要这套；viewport 一变（旋转/缩放）也重新判断。
  function initPeek() {
    if (!window.matchMedia?.("(pointer: coarse)")?.matches) return;
    const track = (event) => {
      const touch = event.touches?.[0];
      if (touch) lastPoint = { x: touch.clientX, y: touch.clientY };
    };
    window.addEventListener(
      "touchstart",
      (event) => {
        track(event);
        clearPeek();
      },
      { passive: true }
    );
    window.addEventListener("touchmove", track, { passive: true });
    window.addEventListener(
      "scroll",
      () => {
        clearPeek();
        armPeek();
      },
      { passive: true }
    );
  }

  initPeek();

  // 触摸端按下哪一枚就展开哪一枚的文字，抬手收起。
  // 本来用 CSS :active，但真机实测触摸按下时 :active 不会落到 .ldfc-actions 上
  //（点着胶囊查 :active 链，只到所在 TD 就断了），所以改成指针事件打类。
  // 只展开被按的那一枚：整组展开会让胶囊变宽、把按钮挪到手指外。
  let pressedButton = null;
  function releasePress() {
    if (!pressedButton) return;
    pressedButton.classList.remove("ldfc-press");
    pressedButton = null;
  }
  document.addEventListener(
    "pointerdown",
    (event) => {
      const button = event.target?.closest?.(".ldfc-action");
      if (!button) return;
      releasePress();
      pressedButton = button;
      button.classList.add("ldfc-press");
    },
    true
  );
  document.addEventListener("pointerup", releasePress, true);
  document.addEventListener("pointercancel", releasePress, true);

  // 归属变化（标记 / 撤销 / 同步合并 / 自动已读）后统一重绘光效。
  document.addEventListener("ldfc:pool-change", paintAll);
})();
