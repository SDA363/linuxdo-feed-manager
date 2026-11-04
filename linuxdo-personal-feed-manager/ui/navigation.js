(() => {
  // 五区导航：一颗悬浮球 + 从球本身放大出来的面板。
  //
  // 交互：
  //   鼠标移到悬浮球     → 展开
  //   鼠标离开           → 短暂延时后收起（点过面板里的东西则保持展开）
  //   再点一次悬浮球     → 收起
  //   点面板外部 / Esc   → 收起
  //   拖动悬浮球 / 面板标题 → 位置持久化
  //
  // 位置只记录「悬浮球左上角」{ left, top }。球是唯一的位置基准，
  // 面板在收起态被压到与球完全重合，展开时从球心原位放大 —— 所以
  // 用户看到的是"图标变成面板"，不是"球旁边冒出一块面板"。
  //
  // 展开方向按球心相对视口中心决定：
  //   球在右半边 → 面板向左展开；左半边 → 向右展开
  //   球在下半边 → 面板向上展开；上半边 → 向下展开
  // 面板的 transform-origin 落在与球贴合的那个角，transform 从
  // 52/面板宽高 放大到 1；收起时反向缩回同一颗球。
  const STATE_KEY = "navUiState";
  const DRAG_THRESHOLD = 6;
  const EDGE = 8;
  const FAB_SIZE = 52;
  const CLICK_SUPPRESS_MS = 400;
  // 鼠标扫过时不该乱弹，但延迟要小到感觉不到
  const HOVER_OPEN_DELAY = 60;
  // 指针从球移进面板时，个别浏览器会先补一次 mouseleave。
  // 给一段宽限期，避免面板刚展开就被误关。
  const HOVER_CLOSE_DELAY = 220;
  // 二级面板贴着一级面板打开，间隔 / 视口留白 / 宽度上限
  const SHEET_GAP = 12;
  const SHEET_MARGIN = 12;
  const SHEET_MAX_WIDTH = 420;
  const SHEET_MIN_WIDTH = 240;
  // 触摸屏上必须留出「点面板外就关」真正点得到的地方：系统侧边手势区占了最外
  // 十几像素，二级面板又常常顶满宽度，只剩 12px 边距时手指点不到（真机实测）。
  // 这里在窄屏兜底宽度上再让出一条 56px 的可点边。
  const SHEET_TOUCH_GUTTER = 56;
  // 动画速度倍率：0.1×（慢 10 倍）~ 2×（快 2 倍），1× 为正常速度
  const ANIM_SPEED_KEY = "animSpeed";
  const SHEET_DURATION_MS = 460;
  const SHEET_CLOSE_MS = 360;
  const START_MODE_KEY = "navStartMode";

  // 一级面板的图标：线性 SVG（emoji 在不同系统上字形不一，也跟不上主题色）。
  const NAV_ICONS = {
    HOME: '<path d="M4.5 7h11.5"/><path d="M4.5 12h8.5"/><path d="M4.5 17h6.5"/><circle cx="18.6" cy="17" r="1.6"/>',
    INTERESTED:
      '<path d="M12 3.8l2.55 5.17 5.7.83-4.12 4.02.97 5.68L12 16.82 6.9 19.5l.97-5.68L3.75 9.8l5.7-.83z"/>',
    NEW_REPLY: '<path d="M20 5H4v11h5v4l5-4h6z"/>',
    READ: '<path d="M4.5 12.5l4.8 4.8L19.8 6.8"/>',
    DISMISSED: '<path d="M6 6l12 12M18 6L6 18"/>',
    BOOKMARK: '<path d="M7 4h10v16l-5-4-5 4z"/>',
    SETTINGS:
      '<circle cx="12" cy="12" r="3"/><path d="M12 3.8v2M12 18.2v2M3.8 12h2M18.2 12h2M6.2 6.2l1.4 1.4M16.4 16.4l1.4 1.4M17.8 6.2l-1.4 1.4M7.6 16.4l-1.4 1.4"/>'
  };

  const tabs = [
    { pool: "HOME", name: "主信息流" },
    { pool: "INTERESTED", name: "感兴趣" },
    { pool: "NEW_REPLY", name: "新回复" },
    { pool: "READ", name: "已读" },
    { pool: "DISMISSED", name: "不感兴趣" }
  ];

  let nav;
  let fab;
  let panel;
  let items;
  let badge;

  // 默认展开：保持 V1.0 的观感，用户第一眼就能看到五个池子。
  // 鼠标离开后才会收起成悬浮球。
  let collapsed = false;
  // 点过面板内容后保持展开，鼠标离开也不收
  let pinned = false;
  // 悬浮球左上角的屏幕坐标；null 表示还没算过，用默认左下角
  let anchor = null;
  let anchorDirty = false;
  let dragging = false;
  let suppressClickUntil = 0;
  let hoverTimer = 0;
  // 拖动途中要压住浏览器的原生拖拽（拖链接 / 拖选区）。
  // 悬浮球压在 Topic 链接上时，Chrome 会对着底下的 <a> 启动 HTML5 拖拽，
  // 并立刻发出一枚 pointercancel —— 表现为"拖一下就卡住不动了"。
  let blockNativeDrag = null;
  // 阅读页没有列表行，主信息流数量沿用上次在主信息流算出的值，
  // 不要因为"页面上没有行"就显示 0。
  let lastHomeCount = 0;
  // 动画速度倍率，见 ANIM_SPEED_KEY
  let animSpeed = 1;

  // 默认「启动时显示」：小屏 / 触摸设备只给悬浮球。
  // 一级面板在手机上会压掉大半屏内容，用户第一眼要的是入口而不是挡板；
  // 桌面照旧展开面板，V1.0 的观感不变。
  function prefersFabStart() {
    try {
      if (window.matchMedia?.("(pointer: coarse)")?.matches) return true;
    } catch {
      // matchMedia 不可用时按宽度判断
    }
    return window.innerWidth < 900;
  }

  // 启动时显示一级面板还是悬浮球，见 START_MODE_KEY
  let startMode = prefersFabStart() ? "fab" : "panel";

  function countFor(pool) {
    const state = window.LDFCTopicState;
    if (pool === "NEW_REPLY") return state.listNewReply().length;
    if (pool === "HOME") {
      const rows = document.querySelectorAll(
        ".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]"
      );
      if (!rows.length) return lastHomeCount || state.listByPool("HOME").length;
      lastHomeCount = [...rows].filter((row) => {
        const record = state.get(row.dataset.topicId);
        return !record || record.basePool === "HOME";
      }).length;
      return lastHomeCount;
    }
    return state.listByPool(pool).length;
  }

  function defaultAnchor() {
    return {
      left: 16,
      top: Math.max(EDGE, window.innerHeight - FAB_SIZE - 24)
    };
  }

  // 球永远完整留在视口里：一旦跑出屏幕，用户就再也没有入口了。
  function applyPosition() {
    if (!anchor) anchor = defaultAnchor();
    const maxLeft = Math.max(EDGE, window.innerWidth - FAB_SIZE - EDGE);
    const maxTop = Math.max(EDGE, window.innerHeight - FAB_SIZE - EDGE);
    anchor.left = Math.min(Math.max(EDGE, anchor.left), maxLeft);
    anchor.top = Math.min(Math.max(EDGE, anchor.top), maxTop);

    nav.style.left = `${anchor.left}px`;
    nav.style.top = `${anchor.top}px`;
    nav.style.right = "auto";
    nav.style.bottom = "auto";
  }

  // 面板是 nav 的子元素，坐标相对球计算。面板的布局尺寸始终是完整尺寸，
  // 收起态只靠 transform 压到 52×52；这样展开/收起不触发布局重排，
  // 动画可以全程走合成线程。
  function placePanel() {
    const iconLeft = anchor.left;
    const iconTop = anchor.top;
    const iconRight = iconLeft + FAB_SIZE;
    const iconBottom = iconTop + FAB_SIZE;
    const width = panel.offsetWidth || 196;
    const height = panel.offsetHeight || 220;

    const centerX = iconLeft + FAB_SIZE / 2;
    const centerY = iconTop + FAB_SIZE / 2;
    const expandX = centerX > window.innerWidth / 2 ? "left" : "right";
    const expandY = centerY > window.innerHeight / 2 ? "up" : "down";

    // 完整面板的某一角就是球本身：向上展开时球在面板左下/右下角，
    // 向下展开时球在左上/右上角。没有间隙，视觉上才是一个整体在长大。
    let left = expandX === "left" ? iconRight - width : iconLeft;
    let top = expandY === "up" ? iconBottom - height : iconTop;

    // 视口比面板还窄时先保证左上角可见，至少让内容能读到
    left = Math.min(Math.max(EDGE, left), Math.max(EDGE, window.innerWidth - width - EDGE));
    top = Math.min(Math.max(EDGE, top), Math.max(EDGE, window.innerHeight - height - EDGE));

    panel.style.left = `${left - iconLeft}px`;
    panel.style.top = `${top - iconTop}px`;
    // 缩放原点按"夹回视口后的实际位置"反算：压缩后整个面板就是 52×52，
    // 且左上边缘精确落在球上。面板贴边被夹回来时，原点可能落在面板外，
    // 这是合法的 —— 不能退回固定角，否则会错开半个球。
    const scaleX = FAB_SIZE / width;
    const scaleY = FAB_SIZE / height;
    panel.style.transformOrigin =
      `${(iconLeft - left) / (1 - scaleX)}px ${(iconTop - top) / (1 - scaleY)}px`;
    panel.style.setProperty("--ldfc-panel-sx", scaleX.toFixed(5));
    panel.style.setProperty("--ldfc-panel-sy", scaleY.toFixed(5));
    // 收起态视觉上要显示成球的 15px 圆角；transform 会把本地圆角
    // 一起缩放，所以本地半径要按比例反算。
    panel.style.setProperty(
      "--ldfc-panel-icon-radius",
      `${(15 / (FAB_SIZE / width)).toFixed(2)}px / ${(15 / (FAB_SIZE / height)).toFixed(2)}px`
    );

    nav.dataset.expandX = expandX;
    nav.dataset.expandY = expandY;
  }

  // 计数一变面板高度就变，方向和位置都要重新算一次。
  function layout() {
    if (!nav) return;
    fab.setAttribute("aria-expanded", String(!collapsed));
    // 展开后视觉上已经是面板，球不再参与键盘焦点。
    fab.tabIndex = collapsed ? 0 : -1;
    panel.setAttribute("aria-hidden", String(collapsed));
    // 收起态面板内容不可见，也不能被 Tab 聚焦。
    panel.inert = collapsed;
    applyPosition();
    placePanel();
  }

  function render() {
    if (!nav) return;

    for (const button of items.querySelectorAll("button[data-pool]")) {
      const pool = button.dataset.pool;
      const count = countFor(pool);
      const tab = tabs.find((item) => item.pool === pool);
      button.innerHTML =
        `<svg class="ldfc-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[pool] || ""}</svg>` +
        `<span class="ldfc-nav-name">${tab?.name || pool}</span>` +
        `<span class="ldfc-nav-count">${count}</span>`;
      button.classList.toggle("active", window.LDFCFilter.getActivePool() === pool);
    }

    const newReplies = countFor("NEW_REPLY");
    badge.textContent = newReplies > 99 ? "99+" : String(newReplies);
    badge.hidden = newReplies === 0;

    layout();
    // 阅读页的三个按钮和面板用的是同一份状态，统一在这里刷新。
    window.LDFCLauncher?.updateCounts?.();
  }

  // ---- 展开 / 收起 ----

  function open() {
    clearTimeout(hoverTimer);
    // 拖动途中不要被悬停计时器把面板弹出来，否则正在拖的坐标就乱了。
    if (dragging || !collapsed) return;
    collapsed = false;
    nav.dataset.collapsed = "false";
    layout();
    // 每次展开都重算一次计数：收起期间数据可能已经变了
    render();
  }

  function close({ keepPinned = false } = {}) {
    clearTimeout(hoverTimer);
    if (collapsed) return;
    collapsed = true;
    if (!keepPinned) pinned = false;
    nav.dataset.collapsed = "true";
    layout();

    // 只有用户真正拖动过才写盘：悬停展开/收起太频繁，不能每次都落库
    if (anchorDirty) saveState();
  }

  function toggle() {
    if (collapsed) open();
    else close();
  }

  // ---- 二级面板（信息池 / 设置）的展开 ----
  //
  // 二级面板是 body 下独立的固定定位元素，和导航面板共用一个视觉语言：
  // 从导航面板（收起时是悬浮球）所在的位置放大出来。
  // 不改变 hidden 语义（打开仍然是 hidden=false），只是把这次切换
  // 放进"先落到缩起态、下一帧再切到展开态"的两帧过渡里。
  function sheetSourceRect() {
    const panelEl = nav?.querySelector(".ldfc-nav-panel");
    const fabEl = nav?.querySelector(".ldfc-nav-fab");
    return (collapsed ? fabEl : panelEl)?.getBoundingClientRect?.() ?? null;
  }

  // 二级面板贴着一级面板打开：
  //   - 一级面板在屏幕左半边就放它右边，在右半边就放它左边；
  //   - 一级面板在上半屏时顶对齐、下半屏时底对齐（面板本身仍然很长）；
  //   - 两侧都放不下（窄窗口）就退回"盖在一级面板上"，但依然贴着它，
  //     而不是像以前那样钉死在屏幕右边缘。
  function positionSheet(sheet) {
    if (!sheet || sheet.hidden) return;
    const source = sheetSourceRect();
    if (!source || !source.width) return;

    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = SHEET_MARGIN;

    const spaceRight = vw - (source.right + SHEET_GAP) - margin;
    const spaceLeft = source.left - SHEET_GAP - margin;
    const preferRight = spaceRight >= spaceLeft;
    const available = Math.max(0, preferRight ? spaceRight : spaceLeft);
    // 细指针点哪儿都准，满宽无所谓；触摸屏要在面板外侧留一条真正点得到的边，
    // 否则「点外面自动关」等于没有（左右只剩 12px，还落在系统侧边手势区里）。
    const coarse = window.matchMedia?.("(pointer: coarse)")?.matches;
    const usableWidth = Math.max(0, vw - margin * 2 - (coarse ? SHEET_TOUCH_GUTTER : 0));

    let width = Math.min(SHEET_MAX_WIDTH, available >= SHEET_MIN_WIDTH ? available : usableWidth);
    width = Math.min(width, usableWidth);
    if (width < 1) return;

    let left = preferRight ? source.right + SHEET_GAP : source.left - SHEET_GAP - width;
    left = Math.max(margin, Math.min(left, vw - margin - width));
    // 贴着一级面板放会把面板推到右边，右侧只剩 12px —— 又没地方点「外面」了。
    // 触摸端把面板往左压，保证外侧始终留出那条可点的边。
    if (coarse) left = Math.min(left, Math.max(margin, vw - margin - SHEET_TOUCH_GUTTER - width));

    const inUpperHalf = source.top + source.height / 2 < vh / 2;
    const top = inUpperHalf ? Math.max(margin, source.top) : margin;
    const bottom = inUpperHalf ? margin : Math.max(margin, vh - source.bottom);

    sheet.style.left = `${Math.round(left)}px`;
    sheet.style.right = "auto";
    sheet.style.top = `${Math.round(top)}px`;
    sheet.style.bottom = `${Math.round(bottom)}px`;
    sheet.style.width = `${Math.round(width)}px`;
  }

  function repositionOpenSheets() {
    for (const id of ["ldfc-panel", "ldfc-settings"]) {
      const sheet = document.getElementById(id);
      if (sheet && !sheet.hidden) positionSheet(sheet);
    }
  }

  // 动画速度倍率：0.1×（慢 10 倍）~ 2×（快 2 倍）。
  // 一级面板走 CSS transition，靠 --ldfc-anim-speed 换算时长；
  // 二级面板走 Web Animations，直接按倍率算 duration。
  function setAnimSpeed(value) {
    const speed = Number(value);
    if (!Number.isFinite(speed) || speed <= 0) return;
    animSpeed = Math.min(2, Math.max(0.1, speed));
    // 挂在根元素上：一级面板（nav 子元素）和二级面板（body 子元素）都能读到。
    // 时长直接算成具体毫秒写进去，不依赖 calc() 除以变量（老浏览器不认）。
    const root = document.documentElement.style;
    const scaled = (ms) => `${Math.round(ms / animSpeed)}ms`;
    root.setProperty("--ldfc-anim-speed", String(animSpeed));
    root.setProperty("--ldfc-nav-dur", scaled(460));
    root.setProperty("--ldfc-nav-dur-fast", scaled(360));
    root.setProperty("--ldfc-nav-text-in", scaled(180));
    root.setProperty("--ldfc-nav-text-move", scaled(260));
    root.setProperty("--ldfc-nav-text-delay", scaled(100));
    root.setProperty("--ldfc-nav-text-out", scaled(90));
  }

  function getAnimSpeed() {
    return animSpeed;
  }

  function getStartMode() {
    return startMode;
  }

  // 「启动时显示」：panel = 展开的一级面板；fab = 只有悬浮球。
  // 切换后立刻生效，同时落盘给下次加载。
  function setStartMode(mode) {
    startMode = mode === "fab" ? "fab" : "panel";
    const pending = window.LDFCDB?.putMeta?.(START_MODE_KEY, startMode);
    if (pending?.catch) pending.catch(() => {});
    applyStartMode();
  }

  function applyStartMode() {
    if (!nav) return;
    collapsed = startMode === "fab";
    pinned = false;
    nav.dataset.collapsed = String(collapsed);
    layout();
  }

  function setSheetOrigin(sheet) {
    const rect = sheetSourceRect();
    if (!rect) return;
    const own = sheet.getBoundingClientRect();
    if (!own.width || !own.height) return;
    // 面板固定在右侧，而球可能在任意角落，原点经常落在面板外 —— 百分比同样合法。
    sheet.style.setProperty(
      "--ldfc-sheet-ox",
      `${(((rect.left + rect.width / 2 - own.left) / own.width) * 100).toFixed(2)}%`
    );
    sheet.style.setProperty(
      "--ldfc-sheet-oy",
      `${(((rect.top + rect.height / 2 - own.top) / own.height) * 100).toFixed(2)}%`
    );
  }

  // 二级面板的缩放起点 / 终点：按"源"（展开时是一级面板，收起时是球）
  // 的尺寸算，而不是写死一个 0.62。这样面板是从球本身长出来、
  // 又原路缩回同一个球，中途不会先变成一块大矩形再淡掉。
  function scaleToSource(rect) {
    const source = sheetSourceRect();
    if (!source || !rect?.width || !rect?.height) return { x: 0.2, y: 0.2 };
    return {
      x: Math.min(1, source.width / rect.width),
      y: Math.min(1, source.height / rect.height)
    };
  }

  function revealSheet(sheet) {
    if (!sheet) return;
    // 可能正在收起动画里，先把收起流程彻底断掉，否则会被它收回去。
    clearTimeout(sheet._ldfcSheetTimer);
    sheet._ldfcSheetTimer = 0;
    sheet._ldfcSheetAnim?.cancel?.();
    sheet._ldfcSheetAnim = null;
    sheet.style.pointerEvents = "";
    sheet.hidden = false;
    // 先摆位置再算缩放原点：原点要相对面板最终落点算。
    positionSheet(sheet);
    setSheetOrigin(sheet);
    sheet.dataset.sheetState = "open";
    // 是否播放由调用方决定：信息池只在「隐藏 → 可见」时调本函数，
    // 排序 / 标记的原地重绘不会走到这里。

    // 这里不用 CSS transition：元素刚由 display:none 变成可见，
    // 浏览器会把这些样式变化合并进同一帧，transition 根本不触发
    // （真实站点上表现就是"面板直接在右边出现"）。
    // 改用 Web Animations，时序可控，也不受 display 切换影响。
    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sheet._ldfcSheetAnim?.cancel?.();
    sheet._ldfcSheetAnim = null;
    if (reduceMotion || typeof sheet.animate !== "function") return;

    const from = scaleToSource(sheet.getBoundingClientRect());
    const animation = sheet.animate(
      [
        { transform: `scale(${from.x}, ${from.y})`, opacity: 0 },
        { transform: "scale(1)", opacity: 1 }
      ],
      {
        duration: Math.round(SHEET_DURATION_MS / animSpeed),
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
        fill: "both"
      }
    );
    sheet._ldfcSheetAnim = animation;
    animation.finished
      .then(() => {
        if (sheet._ldfcSheetAnim === animation) {
          animation.cancel();
          sheet._ldfcSheetAnim = null;
        }
      })
      .catch(() => {});
  }

  function hideSheet(sheet) {
    if (!sheet || sheet.hidden) return;
    clearTimeout(sheet._ldfcSheetTimer);
    sheet._ldfcSheetTimer = 0;
    sheet._ldfcSheetAnim?.cancel?.();
    sheet._ldfcSheetAnim = null;

    const reduceMotion =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rect = sheet.getBoundingClientRect();
    if (reduceMotion || typeof sheet.animate !== "function" || !rect.width) {
      finishHideSheet(sheet);
      return;
    }

    // 收起也要有动画：朝球的方向缩回去，而不是"啪"一下消失。
    // 收的过程中面板还没 hidden，必须同时关掉点击，否则它会挡住下面的页面。
    sheet.dataset.sheetState = "closing";
    sheet.style.pointerEvents = "none";
    // 原点按"现在球在哪"重算：面板打开后球可能被拖过位置。
    setSheetOrigin(sheet);
    const to = scaleToSource(rect);
    const duration = Math.round(SHEET_CLOSE_MS / animSpeed);
    const animation = sheet.animate(
      [
        { transform: "scale(1)", opacity: 1 },
        { transform: `scale(${to.x}, ${to.y})`, opacity: 0 }
      ],
      {
        duration,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
        fill: "both"
      }
    );
    sheet._ldfcSheetAnim = animation;

    const done = () => {
      // 只要期间没有"更新的收起动画"接管，就必须落地。
      // 这里不能用 `_ldfcSheetAnim !== animation` 直接 return：
      // 一旦句柄被别处清成 null，收尾就永远不会执行，面板会卡在
      // hidden=false —— 真实站点上的表现就是"每次点都只播收起动画，关不掉"。
      if (sheet._ldfcSheetAnim && sheet._ldfcSheetAnim !== animation) return;
      sheet._ldfcSheetAnim = null;
      animation.cancel();
      finishHideSheet(sheet);
    };
    animation.finished.then(done).catch(() => {});
    // 标签页在后台时 WAAPI 可能不推进，兜底确保最终收起来
    sheet._ldfcSheetTimer = setTimeout(done, duration + 150);
  }

  function finishHideSheet(sheet) {
    clearTimeout(sheet._ldfcSheetTimer);
    sheet._ldfcSheetTimer = 0;
    sheet.dataset.sheetState = "";
    sheet.style.pointerEvents = "";
    sheet.hidden = true;
  }

  // 二级面板"是否算开着"。收起动画期间（hidden 还是 false、state=closing）
  // 必须算作已关闭，否则 toggle 会把它当成"还开着"，再点一次又播一遍收起动画，
  // 表现为"点开→点收→之后每次点都只收不放"。
  function isSheetOpen(sheet) {
    return Boolean(sheet && !sheet.hidden && sheet.dataset.sheetState !== "closing");
  }

  // ---- 位置持久化 ----

  async function loadState() {
    try {
      const saved = await window.LDFCDB.getMeta(STATE_KEY);
      if (!saved) return;
      if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        anchor = { left: saved.left, top: saved.top };
      } else if (Number.isFinite(saved.right) && Number.isFinite(saved.top)) {
        // 旧版本存的是「面板右上角」，等价于球的右边缘：换算成球左上角，
        // 升级后位置不会跳。
        anchor = { left: saved.right - FAB_SIZE, top: saved.top };
      }
    } catch {
      // 读不到就用默认位置，不影响功能
    }
    try {
      const speed = await window.LDFCDB.getMeta(ANIM_SPEED_KEY);
      if (Number.isFinite(speed)) setAnimSpeed(speed);
    } catch {
      // 读不到就用 1×
    }
    try {
      const mode = await window.LDFCDB.getMeta(START_MODE_KEY);
      if (mode === "fab" || mode === "panel") startMode = mode;
    } catch {
      // 读不到就默认展开面板
    }
  }

  function saveState() {
    const payload = anchor ? { left: anchor.left, top: anchor.top } : {};
    window.LDFCDB.putMeta(STATE_KEY, payload).catch(() => {});
  }

  // ---- 拖动 ----

  function onPointerDown(event) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    // 按下就取消悬停计时：拖动时面板不能自己弹出来。
    clearTimeout(hoverTimer);

    // 从面板里的按钮按下去是"点击"，不是拖动；其余位置都可以拖。
    // 悬浮球本身在任何状态下都是拖动把手：位移超过阈值才算拖，
    // 拖完的那次 click 会被下面的 suppressClickUntil 吃掉，不会误开合。
    const interactive = event.target.closest?.("button, a, input, select, textarea");
    if (interactive && !event.target.closest?.(".ldfc-nav-fab")) return;

    applyPosition();
    const startX = event.clientX;
    const startY = event.clientY;
    const originLeft = anchor.left;
    const originTop = anchor.top;
    let moved = false;

    const onMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;

      moved = true;
      dragging = true;
      nav.classList.add("ldfc-dragging");

      const maxLeft = Math.max(EDGE, window.innerWidth - FAB_SIZE - EDGE);
      const maxTop = Math.max(EDGE, window.innerHeight - FAB_SIZE - EDGE);
      anchor = {
        left: Math.min(Math.max(EDGE, originLeft + dx), maxLeft),
        top: Math.min(Math.max(EDGE, originTop + dy), maxTop)
      };
      applyPosition();
      // 球一移动，面板该往哪边展开可能就变了
      placePanel();
      moveEvent.preventDefault();
    };

    const onUp = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      stopBlockingNativeDrag();
      if (!moved) return;

      dragging = false;
      nav.classList.remove("ldfc-dragging");
      anchorDirty = true;
      saveState();
      // 球换了位置，已经打开的二级面板跟着挪，别把它落在原地
      repositionOpenSheets();
      // 拖完浏览器还会补发一次 click，别让它顺带把面板开合一次
      suppressClickUntil = Date.now() + CLICK_SUPPRESS_MS;
    };

    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    startBlockingNativeDrag();
  }

  function startBlockingNativeDrag() {
    if (blockNativeDrag) return;
    blockNativeDrag = (event) => event.preventDefault();
    document.addEventListener("dragstart", blockNativeDrag, true);
    document.addEventListener("selectstart", blockNativeDrag, true);
  }

  function stopBlockingNativeDrag() {
    if (!blockNativeDrag) return;
    document.removeEventListener("dragstart", blockNativeDrag, true);
    document.removeEventListener("selectstart", blockNativeDrag, true);
    blockNativeDrag = null;
  }

  function onClickCapture(event) {
    if (Date.now() >= suppressClickUntil) return;
    event.preventDefault();
    event.stopPropagation();
  }

  // ---- 构建 ----

  function build() {
    nav = document.createElement("nav");
    nav.id = "ldfc-navigation";
    nav.dataset.collapsed = "false";
    nav.dataset.expandX = "right";
    nav.dataset.expandY = "up";

    fab = document.createElement("button");
    fab.type = "button";
    fab.className = "ldfc-nav-fab";
    fab.title = "LDFC 信息池（移上来展开，点一下开合）";
    fab.setAttribute("aria-label", "展开或收起 LDFC 信息池面板");
    fab.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    });

    // 用内联 SVG 而不是 emoji：emoji 的字形由系统字体决定，
    // Windows / Android 出来的形状完全不一样，撑不起"苹果风"的观感。
    //
    // 图形是用户从 5 版候选里选的「③ 信息流三行」：
    // 三条长度递减的横线 + 右侧一个圆点，读作"一列标题，其中一条有新内容"。
    // 圆点必须走内联 style：CSS 的 `.ldfc-nav-fab-glyph { fill: none }`
    // 会盖掉 SVG 的 presentation attribute。
    const glyph = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    glyph.setAttribute("class", "ldfc-nav-fab-glyph");
    glyph.setAttribute("viewBox", "0 0 24 24");
    glyph.setAttribute("aria-hidden", "true");
    glyph.innerHTML =
      '<path d="M4.6 7.2h11.6"/>' +
      '<path d="M4.6 12h8.4"/>' +
      '<path d="M4.6 16.8h6.4"/>' +
      '<circle cx="18.6" cy="16.8" r="1.7" style="fill:currentColor;stroke:none"/>';

    badge = document.createElement("span");
    badge.className = "ldfc-nav-badge";
    badge.hidden = true;

    fab.append(glyph, badge);

    panel = document.createElement("div");
    panel.className = "ldfc-nav-panel";

    const head = document.createElement("div");
    head.className = "ldfc-nav-head";

    const title = document.createElement("span");
    title.className = "ldfc-nav-title";
    title.textContent = "LDFC 信息池";
    title.title = "按住这里可以拖动面板";

    head.append(title);

    items = document.createElement("div");
    items.className = "ldfc-nav-items";

    for (const tab of tabs) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.pool = tab.pool;
      button.addEventListener("click", () => {
        // 多选模式里不再用导航池子做批量移入：入口统一成「按住胶囊拖到池子上」。
        // 这里只拦一下，避免多选途中把列表视图切走。
        if (window.LDFCMultiSelect?.isActive?.()) {
          window.LDFCToast?.show?.("按住任意一枚悬浮按钮，拖到池子上松开即可移入");
          return;
        }
        // 再点一次当前池子 = 收起面板。
        // 设置按钮本来就是 toggle（点开 / 点收），信息池以前只能换池子、
        // 不能原路收起，用户得先切到设置才有 ×，这里统一成同一种逻辑。
        const sheet = document.getElementById("ldfc-panel");
        const samePool =
          window.LDFCFilter.getActivePool() === tab.pool &&
          sheet &&
          !sheet.hidden &&
          sheet.dataset.sheetState !== "closing";
        if (samePool) {
          window.LDFCFilter.setActivePool("HOME");
          window.LDFCPoolPanel.render("HOME");
          window.LDFCContent?.decorateRows?.();
          render();
          return;
        }
        window.LDFCFilter.setActivePool(tab.pool);
        window.LDFCPoolPanel.render(tab.pool);
        // Discourse 在切换列表视图时会重渲染 Topic 行，挂在行上的
        // 操作按钮会一起被冲掉。这里重新扫一遍把按钮补回去，
        // 否则用户从池子切回来会发现悬停没有任何按钮。
        window.LDFCContent?.decorateRows?.();
        render();
      });
      items.appendChild(button);
    }

    panel.append(head, items);
    nav.append(fab, panel);

    // 悬停展开 / 离开收起。点过面板内容就钉住，不再自动收。
    nav.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer);
      if (!collapsed) return;
      hoverTimer = setTimeout(open, HOVER_OPEN_DELAY);
    });

    nav.addEventListener("mouseleave", () => {
      clearTimeout(hoverTimer);
      if (dragging || pinned) return;
      // 球和面板之间有 8px 空隙，鼠标穿过去会先触发一次 mouseleave，
      // 所以不能立刻收，留一点时间让指针进入面板。
      hoverTimer = setTimeout(() => {
        if (!dragging && !pinned) close();
      }, HOVER_CLOSE_DELAY);
    });

    panel.addEventListener("click", (event) => {
      if (event.target.closest?.("button")) pinned = true;
    });

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (collapsed) return;
        // 书签文件夹菜单挂在 body 下（要躲开面板 transform 造的包含块），
        // 点它不算"点面板外面"，否则刚开出来的菜单会把整个面板一起关掉。
        if (event.target instanceof Element && event.target.closest(".ldfc-folder-menu")) return;
        if (nav.contains(event.target)) return;
        pinned = false;
        close();
      },
      true
    );

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || collapsed) return;
      pinned = false;
      close();
    });

    // 窗口变小时把球夹回视口内，并重算展开方向。
    window.addEventListener("resize", () => {
      if (nav) layout();
      repositionOpenSheets();
    });

    nav.addEventListener("pointerdown", onPointerDown);
    nav.addEventListener("click", onClickCapture, true);

    document.body.appendChild(nav);

    // 「启动时显示面板 / 悬浮球」存在 IndexedDB 里，读回来之前先不画：
    // 默认是展开面板，如果用户选的是"只有球"，会先闪一整块面板再收回。
    // 库读不出来或卡住时，也不能让入口永远不出现，留一个兜底。
    nav.style.visibility = "hidden";
    const revealNav = () => {
      if (nav) nav.style.visibility = "";
    };
    const revealFallback = setTimeout(revealNav, 1200);
    loadState()
      .then(() => {
        if (!nav) return;
        applyStartMode();
      })
      .catch(() => {})
      .finally(() => {
        clearTimeout(revealFallback);
        revealNav();
      });

    // 首帧先摆一次，别等 IndexedDB（异步）回来才出现在屏幕上
    applyPosition();
    placePanel();
    setAnimSpeed(animSpeed);
  }

  function create() {
    if (nav) return nav;
    build();
    return nav;
  }

  function appendItem(element) {
    create();
    // 后加进来的入口（书签 / 设置）也走同一套图标 + 文字结构，
    // 否则一级面板底部会突然多出两行没有图标的文字。
    const icon = element.dataset.navIcon;
    if (icon && NAV_ICONS[icon]) {
      const name = element.textContent;
      element.innerHTML =
        `<svg class="ldfc-nav-icon" viewBox="0 0 24 24" aria-hidden="true">${NAV_ICONS[icon]}</svg>` +
        `<span class="ldfc-nav-name">${name}</span>` +
        "<span class=\"ldfc-nav-count\" hidden></span>";
    }
    items.appendChild(element);
  }

  // 二级面板（设置 / 信息池）的「点外面就关」。
  //
  // 手机上这些面板占大半屏、内容又长，关闭按钮在标题行顶部；用户滚到
  // 底部后得一路滑回顶部才能关。标题行吸顶（CSS）解决了"找不到按钮"，
  // 这里再补一条更符合手持习惯的出口：命中面板外部就直接关。
  //
  // 面板标题行的「固定」按钮会把 dataset.pinned 置为 "true"，此时不自动关。
  // 外部那一下要吃掉，否则关面板的同一次点击会顺手把列表行标记掉。
  function bindSheetDismiss(sheet, close) {
    if (!sheet || sheet.dataset.ldfcDismiss === "1") return;
    sheet.dataset.ldfcDismiss = "1";

    document.addEventListener(
      "pointerdown",
      (event) => {
        if (sheet.hidden) return;
        if (sheet.dataset.pinned === "true") return;
        const target = event.target;
        if (!(target instanceof Node)) return;
        if (sheet.contains(target)) return;
        if (nav && nav.contains(target)) return;
        // 同上：文件夹菜单是面板延伸出来的一层，点它不该关面板。
        if (target instanceof Element && target.closest(".ldfc-folder-menu")) return;
        close();
        event.preventDefault();
        event.stopPropagation();
      },
      true
    );
  }

  window.LDFCNavigation = {
    appendItem,
    bindSheetDismiss,
    close,
    create,
    finishHideSheet,
    getAnimSpeed,
    getStartMode,
    hideSheet,
    isCollapsed: () => collapsed,
    isSheetOpen,
    open,
    positionSheet,
    render,
    repositionOpenSheets,
    revealSheet,
    setAnimSpeed,
    setStartMode,
    toggle
  };
})();
