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

  // ---- 触摸端：模拟桌面的「移入展开胶囊」 ----
  //
  // 桌面靠 :hover，触摸端没有悬停。这里把「手指位置」当成鼠标位置：
  //   1) 手指按下 / 滑动经过哪一行 → 那一行的胶囊立刻显形（.ldfc-row-active）
  //   2) 滚动或抬手后停稳 280ms → 追加 .ldfc-row-peek，把文字也展开 1.6s
  //   3) 命中测试用 rAF 节流，滚动期间不做同步 DOM 遍历
  // CSS 侧默认 opacity:0 + pointer-events:none，避免「透明但能点」的陷阱。
  const PEEK_SETTLE_MS = 280;
  const PEEK_HOLD_MS = 1600;
  let activeLayer = null;
  let lastPoint = null;
  let followRaf = 0;
  let peekTimer = 0;
  let peekClearTimer = 0;

  function removePeek() {
    clearTimeout(peekTimer);
    peekTimer = 0;
    clearTimeout(peekClearTimer);
    peekClearTimer = 0;
    activeLayer?.classList.remove("ldfc-row-peek");
  }

  function layerAt(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) return null;
    const inside = hit.closest?.(".ldfc-actions");
    if (inside) return inside;
    // 手指落点通常在标题上，按钮组贴在行右侧 —— 往上找到「只含一枚按钮组」的祖先。
    // 不能用 hit.closest('[data-topic-id]')：站点把 data-topic-id 也挂在标题 <a> 上，
    // 会当场命中链接本身（里面没有按钮组），真机上表现为「怎么按都不展开」。
    let el = hit;
    let best = null;
    while (el && el !== document.body) {
      const layers = el.querySelectorAll?.(".ldfc-actions");
      if (!layers) break;
      if (layers.length === 1) best = layers[0];
      else if (layers.length > 1) break;
      el = el.parentElement;
    }
    return best;
  }

  function setActive(layer) {
    if (layer === activeLayer) return;
    activeLayer?.classList.remove("ldfc-row-active", "ldfc-row-peek");
    activeLayer = layer;
    activeLayer?.classList.add("ldfc-row-active");
    clearTimeout(peekClearTimer);
    peekClearTimer = 0;
  }

  function follow() {
    if (followRaf) return;
    followRaf = requestAnimationFrame(() => {
      followRaf = 0;
      if (!lastPoint) return;
      setActive(layerAt(lastPoint.x, lastPoint.y));
    });
  }

  function armPeek() {
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => {
      peekTimer = 0;
      if (!activeLayer) return;
      activeLayer.classList.add("ldfc-row-peek");
      clearTimeout(peekClearTimer);
      peekClearTimer = setTimeout(() => {
        peekClearTimer = 0;
        activeLayer?.classList.remove("ldfc-row-peek");
      }, PEEK_HOLD_MS);
    }, PEEK_SETTLE_MS);
  }

  // 细指针环境不需要这套；viewport 一变（旋转/缩放）也重新判断。
  function initPeek() {
    if (!window.matchMedia?.("(pointer: coarse)")?.matches) return;
    const track = (event) => {
      const touch = event.touches?.[0] ?? event.changedTouches?.[0];
      if (touch) lastPoint = { x: touch.clientX, y: touch.clientY };
    };
    window.addEventListener(
      "touchstart",
      (event) => {
        track(event);
        removePeek();
        if (lastPoint) setActive(layerAt(lastPoint.x, lastPoint.y));
      },
      { passive: true }
    );
    window.addEventListener(
      "touchmove",
      (event) => {
        track(event);
        removePeek();
        follow();
      },
      { passive: true }
    );
    window.addEventListener("touchend", armPeek, { passive: true });
    window.addEventListener(
      "scroll",
      () => {
        follow();
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
