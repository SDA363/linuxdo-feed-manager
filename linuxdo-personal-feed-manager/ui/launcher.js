(() => {
  // 阅读页（正常 Topic 页 + 第三方预览弹窗）里的三个操作按钮：
  //   ⭐ 感兴趣 / ✓ 已读 / × 不感兴趣
  //
  // 挂载点：
  //   1. Topic 页首楼 .cooked 里那一行 —— 第三方脚本会把
  //      「当前只看楼主 / 保存到本地 / 保存为图片」塞进 .save-buttons-container。
  //      有容器就并进去，和它们同一行；没有就自建一行。
  //   2. 预览弹窗 .ldp-overlay > .ldp-modal > .ldp-head-btns（× 左侧）——
  //      弹窗没有"首楼按钮行"，头部按钮区是唯一不滚动就能看到的位置。
  //
  // 按钮本体放在影子 DOM：
  //   - 第三方「保存到本地」会把整段 .cooked cloneNode 进导出的 HTML，
  //     cloneNode 不复制影子树，导出文件里不会残留我们的按钮；
  //   - 外观也不受 linux.do / 主题的 button 样式影响。
  const ACTIONS_CLASS = "ldfc-reader-actions";
  const FALLBACK_ROW_CLASS = "ldfc-topic-actions-row";
  const DOCK_CLASS = "ldfc-preview-dock";
  const INJECT_DELAY = 120;

  const ACTIONS = [
    { pool: "INTERESTED", label: "⭐ 感兴趣", dockLabel: "感兴趣", message: "已移入“感兴趣”" },
    { pool: "READ", label: "✓ 已读", dockLabel: "已读", message: "已移入“已读”" },
    { pool: "DISMISSED", label: "× 不感兴趣", dockLabel: "不感兴趣", message: "已移入“不感兴趣”" }
  ];

  // 工具排的状态与实现见下方「工具排」一节。两排工具同名但各自独立：
  // 预览窗的筛选不影响真实帖子页，反之亦然。

  // 按钮上的数字来自当前状态库，和左下角面板用的是同一份数据。
  function poolCount(pool) {
    try {
      return window.LDFCTopicState.listByPool(pool).length;
    } catch {
      return 0;
    }
  }

  // 标记之后池子数量会变；按钮在影子 DOM 里，不能靠外层 CSS 刷新，
  // 只能自己把三个按钮的计数重新写一遍。
  // 宿主自己记着"这一组按钮属于哪个 Topic"（首楼按 URL 解析，dock 读弹窗里的原贴链接）。
  function currentPoolOf(host) {
    try {
      const topicId = host.ldfcResolveTopic?.()?.topicId;
      if (!topicId) return null;
      return window.LDFCTopicState?.get?.(topicId)?.basePool ?? null;
    } catch {
      return null;
    }
  }

  function updateCounts() {
    for (const host of document.querySelectorAll(`.${ACTIONS_CLASS}, .${DOCK_CLASS}`)) {
      // 四池模型是单一归属，所以同一时刻最多只有一枚按钮点亮。
      const pool = currentPoolOf(host);
      for (const button of host.shadowRoot?.querySelectorAll("button[data-pool]") ?? []) {
        const count = button.querySelector(".ldfc-action-count");
        if (count) count.textContent = String(poolCount(button.dataset.pool));
        button.classList.toggle("is-in-pool", button.dataset.pool === pool);
      }
    }
  }

  // 首楼这一行和预览窗 dock 用同一套视觉：单色图标 + 数字，悬停才旋转展开文字。
  // 颜色一律 inherit / 中性半透明：主题在亮色与暗色之间切换时不用改代码，
  // 也不会在正文里出现三块彩色 pill 抢眼（那是旧版的样子）。
  const ACTIONS_STYLE = `
    :host {
      /* 与预览窗 dock 统一：整块占满所在行再内部居中，
         否则 inline-flex 只按内容宽度收缩，整块会贴在正文左侧。 */
      display: flex;
      flex-direction: column;
      align-items: center;
      /* 第三方容器是 flex 时（真实站点的 .save-buttons-container），
         width:100% 会被压缩成"同行第三格"，必须用 flex-basis 强制独占一行。 */
      flex: 0 0 100%;
      width: 100%;
      gap: 6px;
      color: inherit;
      font: 600 13px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .row {
      display: inline-flex;
      align-items: center;
      gap: 2px;
      padding: 4px;
      border: 1px solid rgba(127, 127, 127, 0.16);
      border-radius: 999px;
      background: rgba(127, 127, 127, 0.1);
      backdrop-filter: blur(12px) saturate(120%);
      -webkit-backdrop-filter: blur(12px) saturate(120%);
    }
    button {
      display: inline-flex;
      align-items: center;
      height: 32px;
      padding: 0 10px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: inherit;
      font: inherit;
      cursor: pointer;
      transition:
        background 220ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 220ms ease;
    }
    button:hover,
    button:focus-visible {
      background: rgba(127, 127, 127, 0.16);
      outline: none;
    }
    .ldfc-action-icon {
      display: grid;
      place-items: center;
      width: 17px;
      height: 17px;
      flex: 0 0 auto;
      opacity: 0.75;
      transition:
        transform 460ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 200ms ease;
    }
    button:hover .ldfc-action-icon,
    button:focus-visible .ldfc-action-icon {
      transform: rotate(360deg) scale(1.08);
      opacity: 1;
    }
    svg {
      width: 17px;
      height: 17px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ldfc-action-label {
      display: inline-block;
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(-6px);
      transition:
        max-width 340ms cubic-bezier(0.32, 0.72, 0, 1),
        margin-left 340ms cubic-bezier(0.32, 0.72, 0, 1),
        transform 340ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 180ms ease 40ms;
    }
    button:hover .ldfc-action-label,
    button:focus-visible .ldfc-action-label,
    button.ldfc-press .ldfc-action-label {
      max-width: 110px;
      margin-left: 6px;
      opacity: 1;
      transform: none;
    }
    .ldfc-action-count {
      min-width: 1.35em;
      margin-left: 6px;
      padding: 0.08em 0.4em;
      border-radius: 999px;
      background: rgba(127, 127, 127, 0.16);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      line-height: 1.45;
      text-align: center;
      opacity: 0.9;
    }
    /* 已在某个池子里：底部一条渐变指示条 + 图标/数字着色。
       只改颜色和一条 2.5px 线，不改宽高，点亮瞬间整排不会跳动。 */
    button { position: relative; }
    button[data-pool="INTERESTED"].is-in-pool { --ldfc-tint: #ffb454; }
    button[data-pool="READ"].is-in-pool { --ldfc-tint: #5fd0a8; }
    button[data-pool="DISMISSED"].is-in-pool { --ldfc-tint: #e0777d; }
    button.is-in-pool {
      background: rgba(127, 127, 127, 0.2);
      color: inherit;
    }
    button.is-in-pool .ldfc-action-icon { opacity: 1; color: var(--ldfc-tint); }
    button.is-in-pool .ldfc-action-count {
      color: var(--ldfc-tint);
      background: rgba(127, 127, 127, 0.12);
    }
    button.is-in-pool::after {
      content: "";
      position: absolute;
      left: 10px;
      right: 10px;
      bottom: 2px;
      height: 2.5px;
      border-radius: 2px;
      background: linear-gradient(90deg, rgba(0, 0, 0, 0), var(--ldfc-tint), rgba(0, 0, 0, 0));
      box-shadow: 0 0 8px var(--ldfc-tint);
      pointer-events: none;
    }
    /* 工具排：首楼是浅色主题，用中性半透明底，别在正文里糊一排深色块 */
    .tools {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tools button {
      display: flex;
      align-items: center;
      height: 26px;
      padding: 0 10px;
      border: 1px solid rgba(127, 127, 127, 0.18);
      border-radius: 999px;
      background: rgba(127, 127, 127, 0.1);
      color: inherit;
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      opacity: 0.85;
      white-space: nowrap;
      transition:
        background 200ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 200ms ease;
    }
    .tools button:hover,
    .tools button:focus-visible {
      background: rgba(127, 127, 127, 0.2);
      opacity: 1;
      outline: none;
    }
    .tools button[aria-pressed="true"] {
      background: rgba(127, 127, 127, 0.24);
      opacity: 1;
    }
    .tools button[disabled] {
      opacity: 0.55;
      cursor: progress;
    }
    /* 图标常显、文字默认收起；hover / 按下才展开（触摸端没有 hover，
       由 bindTouchPress 打 .ldfc-press）。和预览窗工具排同一套节奏。 */
    .ldfc-tool-icon {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      font-size: 12px;
      line-height: 1;
    }
    .ldfc-tool-label {
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(-6px);
      transition:
        max-width 300ms cubic-bezier(0.32, 0.72, 0, 1),
        margin-left 300ms cubic-bezier(0.32, 0.72, 0, 1),
        transform 300ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 160ms ease 40ms;
    }
    .tools button:hover .ldfc-tool-label,
    .tools button:focus-visible .ldfc-tool-label,
    .tools button.ldfc-press .ldfc-tool-label,
    .tools button[aria-pressed="true"] .ldfc-tool-label {
      max-width: 160px;
      margin-left: 5px;
      opacity: 1;
      transform: none;
    }
    @media (prefers-reduced-motion: reduce) {
      button, .ldfc-action-icon, .ldfc-action-label, .tools button { transition-duration: 1ms; }
    }
  `;

  // 预览窗底部的操作 dock：默认单色图标，悬停/聚焦才横向展开标签。
  // 不带池子配色，避免预览窗里出现三块彩色 pill；按钮本体仍在影子 DOM，
  // 不会被站点主题或第三方脚本的 button 样式改写。
  const DOCK_STYLE = `
    /* 纵向排列 + 居中：dock 与工具排都按内容宽度收缩，
       否则 .dock 作为块级元素会撑满整个预览窗宽度，变成一条粗横条。 */
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .dock {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3px;
      padding: 5px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(18, 18, 22, 0.72);
      box-shadow:
        0 12px 34px -12px rgba(0, 0, 0, 0.72),
        inset 0 1px 0 rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(18px) saturate(150%);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
    }
    button {
      display: flex;
      align-items: center;
      height: 42px;
      min-width: 42px;
      padding: 0 11px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: #d7d7df;
      cursor: pointer;
      transition:
        background 220ms cubic-bezier(0.32, 0.72, 0, 1),
        color 220ms cubic-bezier(0.32, 0.72, 0, 1);
    }
    button:hover,
    button:focus-visible {
      background: rgba(255, 255, 255, 0.1);
      color: #fff;
      outline: none;
    }
    .ldfc-dock-icon {
      display: grid;
      place-items: center;
      width: 20px;
      height: 20px;
      flex: 0 0 auto;
      transition: transform 460ms cubic-bezier(0.32, 0.72, 0, 1);
    }
    button:hover .ldfc-dock-icon,
    button:focus-visible .ldfc-dock-icon {
      transform: rotate(360deg) scale(1.06);
    }
    svg {
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    .ldfc-dock-label {
      display: flex;
      align-items: center;
      gap: 6px;
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(-8px);
      font-size: 13px;
      font-weight: 600;
      transition:
        max-width 340ms cubic-bezier(0.32, 0.72, 0, 1),
        margin-left 340ms cubic-bezier(0.32, 0.72, 0, 1),
        transform 340ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 180ms ease 50ms;
    }
    button:hover .ldfc-dock-label,
    button:focus-visible .ldfc-dock-label,
    button.ldfc-press .ldfc-dock-label {
      max-width: 140px;
      margin-left: 7px;
      opacity: 1;
      transform: none;
    }
    .ldfc-action-count {
      min-width: 1.4em;
      /* 计数从 label 里提出来常显：与信息流列表行的胶囊同一套观感（图标 + 数字） */
      margin-left: 7px;
      padding: 0.08em 0.42em;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      color: #b9b9c2;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      line-height: 1.45;
      text-align: center;
    }
    /* 已在某个池子里：与首楼同一套底线光效，深色玻璃下用更亮的底色 */
    button { position: relative; }
    button[data-pool="INTERESTED"].is-in-pool { --ldfc-tint: #ffb454; }
    button[data-pool="READ"].is-in-pool { --ldfc-tint: #5fd0a8; }
    button[data-pool="DISMISSED"].is-in-pool { --ldfc-tint: #e0777d; }
    button.is-in-pool {
      background: rgba(255, 255, 255, 0.14);
      color: #fff;
    }
    button.is-in-pool .ldfc-dock-icon { color: var(--ldfc-tint); }
    button.is-in-pool .ldfc-action-count { color: var(--ldfc-tint); }
    /* 站点动作排：打开原帖 / 书签 / 分享（+ 全搬档的赞、boost） */
    .ldfc-site-actions {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: center;
      gap: 6px;
      margin-top: 7px;
    }
    .ldfc-site-action {
      display: flex;
      align-items: center;
      height: 30px;
      min-width: 30px;
      padding: 0 9px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(18, 18, 22, 0.72);
      color: #d7d7df;
      line-height: 1;
      cursor: pointer;
      transition:
        background 200ms cubic-bezier(0.32, 0.72, 0, 1),
        transform 200ms cubic-bezier(0.32, 0.72, 0, 1),
        border-color 200ms ease;
    }
    .ldfc-site-glyph {
      display: grid;
      place-items: center;
      width: 16px;
      height: 16px;
      flex: 0 0 auto;
    }
    .ldfc-site-glyph svg {
      width: 16px;
      height: 16px;
      fill: currentColor;
    }
    .ldfc-site-count {
      min-width: 1.4em;
      margin-left: 5px;
      padding: 0.08em 0.42em;
      border-radius: 999px;
      background: rgba(255, 255, 255, 0.1);
      color: #b9b9c2;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      line-height: 1.45;
      text-align: center;
    }
    /* 文字默认收起：手机屏幕窄，五枚都展开会挤成两行；按住/悬停再看全名。 */
    .ldfc-site-label {
      display: flex;
      align-items: center;
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(-6px);
      font-size: 12px;
      font-weight: 600;
      transition:
        max-width 300ms cubic-bezier(0.32, 0.72, 0, 1),
        margin-left 300ms cubic-bezier(0.32, 0.72, 0, 1),
        transform 300ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 160ms ease 40ms;
    }
    .ldfc-site-action:hover .ldfc-site-label,
    .ldfc-site-action:focus-visible .ldfc-site-label,
    .ldfc-site-action.ldfc-press .ldfc-site-label {
      max-width: 120px;
      margin-left: 5px;
      opacity: 1;
      transform: none;
    }
    .ldfc-site-action:hover,
    .ldfc-site-action:focus-visible {
      background: rgba(255, 255, 255, 0.14);
      transform: translateY(-1px);
      outline: none;
    }
    .ldfc-site-action.is-on {
      border-color: rgba(255, 212, 59, 0.55);
      color: #ffd43b;
    }
    button.is-in-pool::after {
      content: "";
      position: absolute;
      left: 11px;
      right: 11px;
      bottom: 4px;
      height: 2.5px;
      border-radius: 2px;
      background: linear-gradient(90deg, rgba(0, 0, 0, 0), var(--ldfc-tint), rgba(0, 0, 0, 0));
      box-shadow: 0 0 8px var(--ldfc-tint);
      pointer-events: none;
    }
    /* 第二排工具：与 dock 同一套深色玻璃，文字同样折叠（图标常显） */
    .tools {
      display: flex;
      align-items: center;
      justify-content: center;
      flex-wrap: wrap;
      gap: 6px;
      margin-top: 7px;
    }
    .tools button {
      display: flex;
      align-items: center;
      height: 30px;
      padding: 0 12px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 999px;
      background: rgba(18, 18, 22, 0.62);
      color: #d7d7df;
      font-size: 12px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      white-space: nowrap;
      transition:
        background 200ms cubic-bezier(0.32, 0.72, 0, 1),
        color 200ms ease,
        border-color 200ms ease;
    }
    .tools button:hover,
    .tools button:focus-visible {
      background: rgba(255, 255, 255, 0.16);
      border-color: rgba(255, 255, 255, 0.24);
      color: #fff;
      outline: none;
    }
    .tools button[aria-pressed="true"] {
      background: rgba(255, 255, 255, 0.2);
      border-color: rgba(255, 255, 255, 0.3);
      color: #fff;
    }
    .tools button[disabled] {
      opacity: 0.6;
      cursor: progress;
    }
    /* 图标常显、文字默认收起；hover / 按下才展开，和 dock 同一套节奏。
       触摸端没有 hover，由 bindTouchPress 打 .ldfc-press 展开。 */
    .ldfc-tool-icon {
      display: grid;
      place-items: center;
      flex: 0 0 auto;
      font-size: 13px;
      line-height: 1;
    }
    .ldfc-tool-label {
      max-width: 0;
      margin-left: 0;
      overflow: hidden;
      white-space: nowrap;
      opacity: 0;
      transform: translateX(-6px);
      transition:
        max-width 300ms cubic-bezier(0.32, 0.72, 0, 1),
        margin-left 300ms cubic-bezier(0.32, 0.72, 0, 1),
        transform 300ms cubic-bezier(0.32, 0.72, 0, 1),
        opacity 160ms ease 40ms;
    }
    .tools button:hover .ldfc-tool-label,
    .tools button:focus-visible .ldfc-tool-label,
    .tools button.ldfc-press .ldfc-tool-label,
    .tools button[aria-pressed="true"] .ldfc-tool-label {
      max-width: 160px;
      margin-left: 6px;
      opacity: 1;
      transform: none;
    }
    /* 设置里关掉通知按钮时用 hidden 收起（.tools button 的 display:flex 会盖掉 [hidden]）。 */
    .tools button[hidden] {
      display: none;
    }
    @media (prefers-reduced-motion: reduce) {
      button, .ldfc-dock-icon, .ldfc-dock-label, .tools button { transition-duration: 1ms; }
    }
  `;

  const DOCK_ICONS = {
    INTERESTED:
      '<path d="m12 3 2.75 5.57 6.15.9-4.45 4.34 1.05 6.13L12 17l-5.5 2.94 1.05-6.13L3.1 9.47l6.15-.9L12 3Z"/>',
    READ: '<path d="m5 12.5 4.2 4 9.8-9.5"/>',
    DISMISSED: '<path d="m6 6 12 12M18 6 6 18"/>'
  };

  let observer;

  function isTopicPage() {
    return /^\/t\//.test(window.location.pathname);
  }

  // Topic 页：ID 直接来自地址栏。
  function topicFromPage() {
    const parsed = window.LDFCTopicParser.parseTopicUrl(window.location.pathname);
    if (!parsed) return null;
    return {
      topicId: parsed.topicId,
      slug: parsed.slug,
      title: document.querySelector(".fancy-title")?.textContent?.trim() || document.title
    };
  }

  // 预览弹窗：第三方脚本没有把 topicId 挂到 DOM 上，但底部「打开原贴」
  // 会写成 /t/<topicId>，这是唯一稳定可读的来源。所以点击时才读，
  // 不在注入时缓存 —— 同一个弹窗可能被复用来显示另一个 Topic。
  function topicFromModal(overlay) {
    const href = overlay?.querySelector(".ldp-f-open")?.getAttribute("href") ?? "";
    const match = href.match(/\/t\/(?:[^/]+\/)?(\d+)(?:\/|$)/);
    if (!match) return null;
    return {
      topicId: match[1],
      slug: "",
      title: overlay.querySelector(".ldp-title")?.textContent?.trim() ?? ""
    };
  }

  async function mark(pool, topic) {
    if (!topic) {
      // 弹窗还没加载完（「打开原贴」链接仍是 #）时点按钮没有目标可标，
      // 直接告诉用户，而不是静默失败。
      window.LDFCToast.show("拿不到这个主题的 ID，请等预览加载完再试");
      return false;
    }

    if (pool === "INTERESTED") {
      await window.LDFCPoolManager.markInterested(topic);
    } else if (pool === "READ") {
      await window.LDFCPoolManager.markRead(topic.topicId, {
        title: topic.title,
        slug: topic.slug
      });
    } else {
      await window.LDFCPoolManager.markDismissed(topic);
    }

    window.LDFCNavigation.render();
    window.LDFCFilter.applyRows();
    // 标记成功后立刻点亮/熄灭，不等观察器的下一拍（最多 120ms 的空窗）。
    updateCounts();
    const activePool = window.LDFCFilter.getActivePool();
    if (activePool !== "HOME") window.LDFCPoolPanel.render(activePool);

    const action = ACTIONS.find((item) => item.pool === pool);
    window.LDFCToast.show(action.message, "撤销", async () => {
      await window.LDFCPoolManager.moveHome(topic.topicId);
      window.LDFCNavigation.render();
      window.LDFCFilter.applyRows();
      updateCounts();
    });

    return true;
  }

  // 关闭第三方预览窗口。优先用脚本自己挂的 ldpClose：
  // 它会 abort 进行中的请求、停掉 tracker、移除 Esc 监听，而不只是删节点。
  //
  // 注意：ldpClose 是挂在 DOM 元素上的 expando，扩展的 content script 在
  // 隔离世界里读不到（油猴版本与脚本同一主世界才读得到）。扩展端会退回
  // 点击脚本自己的 .ldp-close 按钮，由它的 click handler 执行同一套清理。
  function closePreview(overlay) {
    if (!overlay?.isConnected) return;
    // 和 × / Esc 走同一条关闭动画：「标记后自动关窗」不该是硬切。
    if (window.LDFCPreview?.closeAnimated?.(overlay)) return;
    if (typeof overlay.ldpClose === "function") {
      overlay.ldpClose();
      return;
    }
    const closeButton = overlay.querySelector(".ldp-close");
    if (closeButton) {
      closeButton.click();
      return;
    }
    overlay.remove();
  }

  function createActions(kind, resolveTopic, afterMark) {
    const host = document.createElement("ldfc-reader-actions");
    host.className = `${ACTIONS_CLASS} ${ACTIONS_CLASS}-${kind}`;
    // 光效要知道"这组按钮属于哪条 Topic"，每次刷新时按需解析，不缓存。
    host.ldfcResolveTopic = resolveTopic;

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = ACTIONS_STYLE;
    shadow.appendChild(style);

    // 三个池子按钮装在一枚中性胶囊里，工具排放在它下面一行。
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "toolbar");
    row.setAttribute("aria-label", "标记当前主题");

    for (const action of ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.pool = action.pool;
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      bindTouchPress(button);

      const icon = document.createElement("span");
      icon.className = "ldfc-action-icon";
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DOCK_ICONS[action.pool]}</svg>`;

      const label = document.createElement("span");
      label.className = "ldfc-action-label";
      label.textContent = action.dockLabel;

      const count = document.createElement("span");
      count.className = "ldfc-action-count";
      count.textContent = String(poolCount(action.pool));

      button.append(icon, label, count);
      button.addEventListener("click", (event) => {
        // 预览弹窗里点背景会关闭弹窗，这里的点击不能冒泡上去。
        event.preventDefault();
        event.stopPropagation();
        mark(action.pool, resolveTopic())
          .then((done) => {
            // 标记成功后才关预览：拿不到 Topic ID 或写入失败时保持窗口打开。
            if (done) afterMark?.();
          })
          .catch(() => {});
      });
      row.appendChild(button);
    }

    shadow.appendChild(row);
    shadow.appendChild(createTools("topic", null, resolveTopic));
    return host;
  }

  // ---- 工具排：只看楼主 / 展开楼中楼 / 随机跳楼 / 保存 ----
  //
  // 都来自用户提供的「linux.do 小助手」脚本：
  //   只看楼主   → toggleVisibility()：预览窗按 .ldp-op，真实帖按 data-user-id
  //   展开楼中楼 → revealAllVisibleReplies()：我们只点引擎自己的「展示更多回复」
  //   随机跳楼层 → randomJump()：改成在预览窗里原地跳，不整页刷新
  //   保存       → savePostToLocal() / savePostAsImage()

  const ONLY_OP_KEY = { preview: "previewOnlyOp", topic: "topicOnlyOp" };
  const onlyOp = { preview: false, topic: false };
  let prefsLoaded = false;
  let expanding = false;

  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // 触摸端没有可靠的 :active（真机实测按下时 :active 不生效），
  // 用 pointerdown 打一个类、抬手清掉，等价于电脑端的「移入展开」。
  function bindTouchPress(button) {
    const off = () => button.classList.remove("ldfc-press");
    button.addEventListener("pointerdown", () => button.classList.add("ldfc-press"));
    for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
      button.addEventListener(type, off);
    }
  }

  // 工具排按钮：图标常显、文字默认收起，hover / 按下时展开——
  // 和 dock 的胶囊同一套节奏。触摸端没有 hover，靠 bindTouchPress 打类展开。
  function nodeButton(text, onClick, icon) {
    const button = document.createElement("button");
    button.type = "button";
    bindTouchPress(button);
    if (icon) {
      const ico = document.createElement("span");
      ico.className = "ldfc-tool-icon";
      ico.textContent = icon;
      ico.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.className = "ldfc-tool-label";
      label.textContent = text;
      button.append(ico, label);
      button.setAttribute("aria-label", text);
    } else {
      button.textContent = text;
    }
    button.addEventListener("click", (event) => {
      // 预览窗点空白会关窗；首楼行也可能被站点接管，统一拦住冒泡。
      event.preventDefault();
      event.stopPropagation();
      onClick(button);
    });
    return button;
  }

  // 工具排的文字被拆成 .ldfc-tool-label，改名要落到 span 上，
  // 不能直接写 button.textContent（那会把图标一起冲掉）。
  function setToolLabel(button, text) {
    const label = button?.querySelector?.(".ldfc-tool-label");
    if (label) label.textContent = text;
    else if (button) button.textContent = text;
  }

  function getToolLabel(button) {
    return button?.querySelector?.(".ldfc-tool-label")?.textContent ?? button?.textContent ?? "";
  }

  function previewSaveScope(overlay) {
    return {
      root: () => window.LDFCPreviewExport?.opRoot?.(overlay) ?? null,
      title: () =>
        topicFromModal(overlay)?.title ||
        overlay.querySelector(".ldp-title")?.textContent?.trim() ||
        "linuxdo-topic",
      url: () => {
        const id = topicFromModal(overlay)?.topicId;
        return id ? `${window.location.origin}/t/${id}` : window.location.href;
      }
    };
  }

  // 真实帖子页保存的是首楼 .cooked，和参考脚本的 postElement 一致。
  function topicSaveScope() {
    return {
      root: () => firstPost()?.querySelector(".cooked") ?? null,
      title: () =>
        document.querySelector(".fancy-title")?.textContent?.trim() ||
        document.title ||
        "linuxdo-topic",
      url: () => window.location.href
    };
  }

  // 快照的楼层来源。
  //   预览窗：顶层帖子和楼中楼都列出来，楼中楼带 depth 供面板缩进。
  //   顶层帖子并不全在 .ldp-topic 下：1 楼在 .ldp-topic，其余在 .ldp-comments。
  //   顺序保持 DOM 顺序（即引擎的渲染顺序），不按楼层号重排 ——
  //   楼中楼的楼层号可能远大于它所在的父楼，重排会让缩进关系看起来是错的。
  //   真实帖子页：每层一个 article#post_N。
  function previewSnapshotPosts(overlay) {
    const engine = [...overlay.querySelectorAll(".ldp-modal .ldp-post")];
    const fallback = [...overlay.querySelectorAll(".ldp-modal .ldfc-pv-post")];
    const nodes = engine.length ? engine : fallback;
    const selector = engine.length ? ".ldp-post" : ".ldfc-pv-post";
    return nodes.map((node, index) => {
      let depth = 0;
      let parent = node.parentElement?.closest(selector);
      while (parent) {
        depth += 1;
        parent = parent.parentElement?.closest(selector);
      }
      return {
        number: Number(node.dataset.postNumber) || index + 1,
        depth,
        node
      };
    });
  }

  function topicSnapshotPosts() {
    return [...document.querySelectorAll("article[id^='post_']")]
      .map((node) => ({ number: Number(node.id.slice(5)) || 0, node }))
      .filter((item) => item.number > 0)
      .sort((left, right) => left.number - right.number);
  }

  function runSave(kind, scope, button) {
    const api = window.LDFCPreviewExport;
    if (!api) {
      window.LDFCToast.show("保存功能未加载，请刷新页面再试");
      return;
    }
    const root = scope.root();
    if (!root) {
      window.LDFCToast.show("还没有可保存的主贴内容，刷新后再试");
      return;
    }
    const save = kind === "image" ? api.saveImage : api.saveHtml;
    Promise.resolve()
      .then(() => save({ title: scope.title(), url: scope.url(), root, button }))
      .catch((error) => {
        window.LDFCToast.show(`保存失败：${error?.message || error}`);
      });
  }

  // 只看楼主：引擎里每层帖子都带 .ldp-op 徽标（楼主的回帖也带）。
  // 老兜底窗没有徽标，用「第 1 楼」当判据。
  // 直接写内联 display：引擎自己的 .ldp-post 规则会盖掉 hidden 属性。
  function applyPreviewOnlyOp(overlay) {
    const posts = overlay.querySelectorAll(".ldp-modal .ldp-post, .ldp-modal .ldfc-pv-post");
    for (const post of posts) {
      const isOp =
        Boolean(post.querySelector(":scope > .ldp-post-head > .ldp-op")) ||
        (post.classList.contains("ldfc-pv-post") && post.dataset.postNumber === "1");
      const want = onlyOp.preview && !isOp ? "none" : "";
      // 值没变就不写，否则每次 MutationObserver 回调都会再触发一次 DOM 变更。
      if (post.style.display !== want) post.style.display = want;
    }
  }

  // 只看楼主：必须把评论全部拉完，否则楼主靠后的回帖永远不出现 ——
  // 隐藏非楼主楼层后列表变短，引擎的哨兵会提前离开视口、停止加载。
  const opLoadAll = new WeakMap();

  function loadAllForOnlyOp(overlay, { announce = false } = {}) {
    if (!overlay || !onlyOp.preview) return;
    if (opLoadAll.has(overlay)) return;
    const api = window.LDFCEnhancedPreview;
    if (typeof api?.loadAllComments !== "function") return;
    opLoadAll.set(overlay, "running");
    if (announce) {
      window.LDFCToast?.show?.("只看楼主：正在加载全部评论以查找楼主楼层…");
    }
    Promise.resolve(api.loadAllComments())
      .catch(() => ({ ok: false }))
      .then(() => {
        // 加载完再套一次筛选，新到楼层里属于楼主的要显示出来。
        applyPreviewOnlyOp(overlay);
      });
  }

  // 真实帖子页：拿 #post_1 的 data-user-id 比较每一层 article。
  // 认不出楼主就整段不动 —— 宁可不筛，也不要把别人的帖子全藏了。
  function applyTopicOnlyOp() {
    const articles = document.querySelectorAll("article[data-user-id]");
    if (!articles.length) return;
    const opId = document.querySelector("#post_1[data-user-id]")?.getAttribute("data-user-id");
    if (!opId) return;
    for (const article of articles) {
      const hide = onlyOp.topic && article.getAttribute("data-user-id") !== opId;
      const want = hide ? "none" : "";
      // 只隐藏 <article>，**绝不能**动它外面的 .topic-post 容器：
      // 站点会把「被隐藏的 .topic-post」当成需要重建的楼层，重建冲掉我们的样式，
      // 观察器（refresh）再套一次 → 每约 1.5s 闪一轮、只看楼主永远落不了地。
      // 隐藏 article 与参考脚本（小助手的 initOnlyOwnerView）一致；
      // 真机实测：容器高度同样塌到 0，但没有触发重建，6s 内零变化。
      if (article.style.display !== want) article.style.display = want;
    }
  }

  function setOnlyOp(kind, next) {
    onlyOp[kind] = Boolean(next);
    try {
      window.LDFCDB?.putMeta?.(ONLY_OP_KEY[kind], onlyOp[kind]);
    } catch {
      // 写不进去只影响下次打开时的默认值
    }
    if (kind === "preview") {
      for (const overlay of document.querySelectorAll(".ldp-overlay")) {
        if (onlyOp.preview) loadAllForOnlyOp(overlay, { announce: true });
        else opLoadAll.delete(overlay);
        applyPreviewOnlyOp(overlay);
      }
    } else {
      applyTopicOnlyOp();
    }
    syncTools();
  }

  function syncTools() {
    for (const host of document.querySelectorAll(`.${ACTIONS_CLASS}, .${DOCK_CLASS}`)) {
      const kind = host.classList.contains(DOCK_CLASS) ? "preview" : "topic";
      const label = onlyOp[kind] ? "当前只看楼主" : "当前查看全部";
      for (const button of host.shadowRoot?.querySelectorAll('button[data-tool="op"]') ?? []) {
        if (getToolLabel(button) !== label) setToolLabel(button, label);
        if (button.getAttribute("aria-pressed") !== String(onlyOp[kind])) {
          button.setAttribute("aria-pressed", String(onlyOp[kind]));
        }
      }
    }
  }

  // 只在第一次真正需要时读一次；读不到就保持默认「全部」。
  function loadPrefs() {
    if (prefsLoaded) return;
    prefsLoaded = true;
    Promise.all([
      Promise.resolve().then(() => window.LDFCDB?.getMeta?.("previewOnlyOp")),
      Promise.resolve().then(() => window.LDFCDB?.getMeta?.("topicOnlyOp"))
    ])
      .then(([preview, topic]) => {
        if (typeof preview === "boolean") onlyOp.preview = preview;
        if (typeof topic === "boolean") onlyOp.topic = topic;
        for (const overlay of document.querySelectorAll(".ldp-overlay")) {
          applyPreviewOnlyOp(overlay);
          loadAllForOnlyOp(overlay);
        }
        applyTopicOnlyOp();
        syncTools();
      })
      .catch(() => {});
  }

  // 展开全部楼中楼：只点引擎自己的「展示更多回复」，最多 40 次，
  // 避免异常情况下无限点。
  async function expandChildren(overlay, button) {
    if (expanding) return;
    expanding = true;
    const label = getToolLabel(button);
    button.disabled = true;
    let clicked = 0;
    try {
      while (clicked < 40) {
        const next = [...overlay.querySelectorAll(".ldp-load-more-replies")].find(
          (element) => element.offsetParent !== null && !element.disabled
        );
        if (!next) break;
        next.click();
        clicked += 1;
        setToolLabel(button, `展开中… ${clicked}`);
        await delay(180);
      }
      window.LDFCToast.show(clicked ? `已展开 ${clicked} 层楼中楼` : "没有需要展开的楼中楼");
    } finally {
      button.disabled = false;
      setToolLabel(button, label);
      expanding = false;
    }
  }

  async function jumpRandom(button) {
    const engine = window.LDFCEnhancedPreview;
    const highest = Number(engine?.highest?.() || 0);
    if (!highest || highest < 2) {
      window.LDFCToast.show("这个主题只有一楼，没有可跳的楼层");
      return;
    }
    // 1 楼是主贴，抽奖时跳过它。
    const floor = 2 + Math.floor(Math.random() * (highest - 1));
    const label = getToolLabel(button);
    button.disabled = true;
    setToolLabel(button, "跳转中…");
    try {
      const ok = await engine.jumpTo(floor);
      window.LDFCToast.show(
        ok ? `跳到第 ${floor} 楼（共 ${highest} 层）` : `第 ${floor} 楼暂时跳不过去`
      );
    } catch (error) {
      window.LDFCToast.show(`跳转失败：${error?.message || error}`);
    } finally {
      button.disabled = false;
      setToolLabel(button, label);
    }
  }

  // ---- 通知级别（只在预览窗） ----
  //
  // 写入沿用原站自己的接口：POST /t/<id>/notifications，参数 notification_level。
  // 级别：3 关注 / 2 跟踪 / 1 常规 / 0 免打扰。
  //
  // 当前档位的读取顺序：
  //   1. 页面 #data-preloaded 的 topicTrackingStates（零请求。LDFCTrackingState
  //      已经解析过；有这条记录的话题必然带 notification_level）
  //   2. 查不到时按需请求一次 /t/<id>.json，同一话题只请求一次
  // 也就是说：菜单只在真正打开时才可能多发一个请求。
  const NOTIFY_LEVELS = [
    {
      level: 3,
      title: "关注",
      icon: "bell",
      desc: "您将在此话题有新回复时收到通知，并且会显示新回复数量。"
    },
    {
      level: 2,
      title: "跟踪",
      icon: "bell",
      desc: "将显示此话题的新回复数量。您会在别人 @ 您或回复您时收到通知。"
    },
    {
      level: 1,
      title: "常规",
      icon: "bell",
      desc: "您会在别人 @ 您或回复您时收到通知。"
    },
    {
      level: 0,
      title: "免打扰",
      icon: "bell-off",
      desc: "您将不会收到有关此话题的任何通知，它也不会出现在最新话题中。"
    }
  ];
  const NOTIFY_ICONS = {
    bell:
      '<path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/>' +
      '<path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    "bell-off":
      '<path d="M13.7 21a2 2 0 0 1-3.4 0"/>' +
      '<path d="M18.6 13A5.9 5.9 0 0 0 18 8a6 6 0 0 0-9.3-5"/>' +
      '<path d="M6 8c0 7-3 9-3 9h14"/><path d="m2 2 20 20"/>'
  };

  // 悬停节奏和一级面板保持一致：短暂停留才展开，留出穿过空隙的时间。
  const NOTIFY_HOVER_OPEN_DELAY = 60;
  const NOTIFY_HOVER_CLOSE_DELAY = 220;

  let notifyMenu = null;
  let notifyOwner = null;
  let notifyTopicId = null;
  let notifyDir = 1;
  let notifyOff = null;
  let notifyHoverTimer = 0;

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  }

  function paintNotify(button, menu, level, manual) {
    // 4 和 3 在原站菜单里是同一项「关注」。
    const active = typeof level === "number" ? (level === 4 ? 3 : level) : null;
    const label = active === null ? "通知" : window.LDFCNotify?.LABELS?.[active] ?? "通知";
    setToolLabel(button, label);
    if (!menu) return;
    for (const item of menu.querySelectorAll("[data-level]")) {
      item.setAttribute("aria-checked", String(Number(item.dataset.level) === active));
    }
    // 手动接管的出口：只有接管过才显示「跟随信息池」，否则是死按钮。
    const follow = menu.querySelector("[data-follow]");
    if (follow) follow.hidden = manual == null;
  }

  // 菜单的展开 / 收起和一级面板同一套 FLIP：量出按钮和菜单的真实矩形，
  // 从按钮的位置和大小长出来，收起时按原路缩回按钮。
  function notifyFlipFrames(menu, anchor) {
    const target = menu.getBoundingClientRect();
    const source = anchor?.getBoundingClientRect?.();
    if (!source || !source.width || !target.width || !target.height) return null;

    const scaleX = Math.max(0.04, source.width / target.width);
    const scaleY = Math.max(0.04, source.height / target.height);
    const dx = source.left + source.width / 2 - (target.left + target.width / 2);
    const dy = source.top + source.height / 2 - (target.top + target.height / 2);

    return {
      from: {
        transform: `translate(${dx}px, ${dy}px) scale(${scaleX}, ${scaleY})`,
        transformOrigin: "center",
        opacity: 0.35,
        borderRadius: "999px"
      },
      to: { transform: "none", transformOrigin: "center", opacity: 1, borderRadius: "14px" }
    };
  }

  function closeNotifyMenu(animate) {
    const menu = notifyMenu;
    const anchor = notifyOwner;
    notifyMenu = null;
    notifyOwner = null;
    notifyTopicId = null;
    clearTimeout(notifyHoverTimer);
    if (notifyOff) {
      notifyOff();
      notifyOff = null;
    }
    if (!menu) return;

    const finish = () => menu.remove();
    if (!animate || prefersReducedMotion()) {
      finish();
      return;
    }
    const frames = notifyFlipFrames(menu, anchor);
    if (!frames) {
      finish();
      return;
    }
    try {
      menu
        .animate([frames.to, frames.from], {
          duration: 220,
          easing: "cubic-bezier(0.4, 0, 0.9, 1)",
          fill: "both"
        })
        .finished.then(finish, finish);
    } catch {
      finish();
    }
  }

  function placeNotifyMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    // 先量一次真实尺寸：内容行高不一致，硬编码高度会算错方向。
    const { width, height } = menu.getBoundingClientRect();
    const gap = 8;
    const left = Math.max(
      8,
      Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 8)
    );
    let top = rect.bottom + gap;
    let dir = 1;
    if (top + height > window.innerHeight - 8) {
      top = rect.top - gap - height;
      dir = -1;
    }
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(Math.max(8, top))}px`;
    menu.style.setProperty("--ldfc-menu-origin", dir > 0 ? "50% 0%" : "50% 100%");
    return dir;
  }

  async function applyNotifyLevel(button, menu, topicId, level) {
    if (menu.dataset.busy === "true") return;
    menu.dataset.busy = "true";
    menu.setAttribute("aria-busy", "true");
    try {
      // manual=true：手动优先。这条话题之后不再被池子联动覆盖。
      await window.LDFCNotify.set(topicId, level, { manual: true });
      paintNotify(button, menu, level, level);
      window.LDFCToast.show(`通知级别已改为「${window.LDFCNotify.LABELS[level]}」`);
      closeNotifyMenu(true);
    } catch (error) {
      // 失败不关菜单：让用户能原地重试，而不是重开一遍。
      window.LDFCToast.show(`修改通知级别失败：${error?.message || error}`);
    } finally {
      delete menu.dataset.busy;
      menu.removeAttribute("aria-busy");
    }
  }

  // 「跟随信息池」：解除手动接管，并按当前归属立刻应用一次映射。
  async function followPoolNotify(button, menu, topicId) {
    if (menu.dataset.busy === "true") return;
    menu.dataset.busy = "true";
    menu.setAttribute("aria-busy", "true");
    try {
      const result = await window.LDFCNotify.followPool(topicId);
      if (result?.applied) {
        const level = window.LDFCTopicState?.get?.(topicId)?.notifyLevel ?? null;
        paintNotify(button, menu, level, null);
        window.LDFCToast.show(`已跟随信息池，通知级别改为「${window.LDFCNotify.LABELS[level]}」`);
        closeNotifyMenu(true);
        return;
      }
      // 没有配映射 / 未登录 / 请求失败：只是解除接管，不改站点。
      paintNotify(button, menu, window.LDFCTopicState?.get?.(topicId)?.notifyLevel ?? null, null);
      window.LDFCToast.show("已交还给信息池联动；这个池子没有配置映射，通知暂时不变");
      closeNotifyMenu(true);
    } catch (error) {
      window.LDFCToast.show(`交还失败：${error?.message || error}`);
    } finally {
      delete menu.dataset.busy;
      menu.removeAttribute("aria-busy");
    }
  }

  function buildNotifyMenu(button, topicId) {
    const menu = document.createElement("div");
    menu.className = "ldfc-notify-menu";
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", "通知级别");

    for (const entry of NOTIFY_LEVELS) {
      const option = document.createElement("button");
      option.type = "button";
      option.dataset.level = String(entry.level);
      option.setAttribute("role", "menuitemradio");
      option.setAttribute("aria-checked", "false");

      const icon = document.createElement("span");
      icon.className = "ldfc-notify-ico";
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${NOTIFY_ICONS[entry.icon]}</svg>`;

      const copy = document.createElement("span");
      copy.className = "ldfc-notify-copy";

      const title = document.createElement("span");
      title.className = "ldfc-notify-title";
      title.textContent = entry.title;

      const desc = document.createElement("span");
      desc.className = "ldfc-notify-desc";
      desc.textContent = entry.desc;

      copy.append(title, desc);
      option.append(icon, copy);
      // 预览窗点空白会关窗：菜单内部的点击必须先截断冒泡。
      option.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyNotifyLevel(button, menu, topicId, entry.level);
      });
      menu.appendChild(option);
    }

    // 手动接管的出口：解除接管并按当前池重新应用一次映射。
    // 默认隐藏，paintNotify 发现这条话题被手动改过才显示。
    const follow = document.createElement("button");
    follow.type = "button";
    follow.dataset.follow = "true";
    follow.className = "ldfc-notify-follow";
    follow.hidden = true;
    follow.textContent = "跟随信息池（解除手动设置）";
    follow.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      followPoolNotify(button, menu, topicId);
    });
    menu.appendChild(follow);

    return menu;
  }

  async function openNotifyMenu(button, topicId) {
    if (!topicId) {
      window.LDFCToast.show("拿不到这个主题的 ID，请等预览加载完再试");
      return;
    }
    if (!window.LDFCIdentity?.current?.().loggedIn) {
      window.LDFCToast.show("登录后才能修改话题通知");
      return;
    }

    const menu = buildNotifyMenu(button, topicId);
    // 必须挂到 body：预览窗 dock 上有一条 animation（fill: both），
    // 结束后仍保留 identity 的 transform，会给 position:fixed 的后代
    // 造出新的包含块，按视口算出来的坐标会被它劫持（实测 top 变成 -140）。
    document.body.appendChild(menu);

    notifyMenu = menu;
    notifyOwner = button;
    notifyTopicId = topicId;
    notifyDir = placeNotifyMenu(menu, button);

    const record = window.LDFCTopicState?.get?.(topicId);
    const known = typeof record?.notifyLevel === "number" ? record.notifyLevel : null;
    paintNotify(button, menu, known, record?.notifyManualLevel ?? null);

    // 从按钮的位置长出来（FLIP），和一级面板同一套观感。
    const frames = notifyFlipFrames(menu, button);
    if (frames && !prefersReducedMotion()) {
      try {
        menu.animate([frames.from, frames.to], {
          duration: 320,
          easing: "cubic-bezier(0.32, 0.72, 0, 1)",
          fill: "both"
        });
      } catch {
        // 动画失败不影响可用性
      }
    }

    // 指针从按钮移到菜单上会先触发一次 button 的 mouseleave，
    // 所以菜单自己要能取消"关闭倒计时"。
    menu.addEventListener("mouseenter", () => clearTimeout(notifyHoverTimer));
    menu.addEventListener("mouseleave", () => {
      clearTimeout(notifyHoverTimer);
      notifyHoverTimer = setTimeout(() => {
        if (notifyMenu === menu) closeNotifyMenu(true);
      }, NOTIFY_HOVER_CLOSE_DELAY);
    });

    const onDoc = (event) => {
      const path = event.composedPath?.() ?? [];
      if (path.includes(menu) || path.includes(button)) return;
      closeNotifyMenu(true);
    };
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      // 先关菜单，别让这一次 Esc 顺手把预览窗也关了。
      event.preventDefault();
      event.stopPropagation();
      closeNotifyMenu(true);
    };
    const onResize = () => closeNotifyMenu(false);

    document.addEventListener("pointerdown", onDoc, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onResize);
    notifyOff = () => {
      document.removeEventListener("pointerdown", onDoc, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
    };

    // 记录里没有档位才问一次站点；有了就不打扰服务器。
    if (known === null) {
      const level = await window.LDFCNotify.resolve(topicId);
      if (notifyMenu === menu) {
        const latest = window.LDFCTopicState?.get?.(topicId);
        paintNotify(button, menu, level, latest?.notifyManualLevel ?? null);
      }
    }
  }

  function createNotifyControl(resolveTopic) {
    const button = nodeButton("通知", (target) => {
      if (notifyMenu && notifyOwner === target) {
        closeNotifyMenu(true);
        return;
      }
      closeNotifyMenu(false);
      openNotifyMenu(target, resolveTopic());
    }, "🔔");

    // 悬停展开 / 移走收起：和一级面板同一套节奏。
    button.addEventListener("mouseenter", () => {
      clearTimeout(notifyHoverTimer);
      if (notifyMenu) return;
      notifyHoverTimer = setTimeout(
        () => openNotifyMenu(button, resolveTopic()),
        NOTIFY_HOVER_OPEN_DELAY
      );
    });
    button.addEventListener("mouseleave", () => {
      clearTimeout(notifyHoverTimer);
      notifyHoverTimer = setTimeout(() => {
        if (notifyMenu) closeNotifyMenu(true);
      }, NOTIFY_HOVER_CLOSE_DELAY);
    });

    button.dataset.tool = "notify";
    button.title = "设置这个话题的通知级别";
    return button;
  }

  // 设置里切换「在预览窗 / 帖子页显示」时立刻生效，不用等下一次重建工具排。
  function applyNotifyVisibility() {
    const settings = window.LDFCNotify?.getSettings?.() ?? {};
    for (const host of document.querySelectorAll(`ldfc-preview-dock, .${ACTIONS_CLASS}`)) {
      const isPreview = host.tagName === "LDFC-PREVIEW-DOCK";
      const visible = isPreview ? settings.showInPreview !== false : settings.showInTopic !== false;
      const button = host.shadowRoot?.querySelector('button[data-tool="notify"]');
      if (button) button.hidden = !visible;
    }
  }

  function createTools(kind, overlay, resolveTopic) {
    const tools = document.createElement("div");
    tools.className = "tools";
    tools.setAttribute("role", "toolbar");
    tools.setAttribute("aria-label", "主题工具");

    const opButton = nodeButton(
      onlyOp[kind] ? "当前只看楼主" : "当前查看全部",
      () => {
        setOnlyOp(kind, !onlyOp[kind]);
      },
      "👁"
    );
    opButton.dataset.tool = "op";
    opButton.title = "只显示楼主楼层（再点恢复全部）";
    opButton.setAttribute("aria-pressed", String(onlyOp[kind]));
    tools.appendChild(opButton);

    if (kind === "preview" && overlay) {
      const expandButton = nodeButton("展开楼中楼", (button) => expandChildren(overlay, button), "🧵");
      expandButton.dataset.tool = "expand";
      expandButton.title = "点开所有「展示更多回复」";
      tools.appendChild(expandButton);

      const randomButton = nodeButton("随机跳楼", (button) => jumpRandom(button), "🎲");
      randomButton.dataset.tool = "random";
      randomButton.title = "随机跳到一层（抽奖用）";
      tools.appendChild(randomButton);
    }

    // 通知按钮：预览窗和正常帖子页各有一个独立开关。
    // resolveTopic 返回 { topicId }，这里只取 ID，UI 层不需要别的字段。
    const notifySettings = window.LDFCNotify?.getSettings?.() ?? {};
    const notifyEnabled =
      kind === "preview" ? notifySettings.showInPreview !== false : notifySettings.showInTopic !== false;
    if (resolveTopic) {
      // 始终创建，用 hidden 控制显隐：设置里切换开关时不用重建整排按钮。
      const notifyButton = createNotifyControl(() => resolveTopic()?.topicId ?? null);
      notifyButton.hidden = !notifyEnabled;
      tools.appendChild(notifyButton);
    }

    const scope = kind === "preview" && overlay ? previewSaveScope(overlay) : topicSaveScope();

    const htmlButton = nodeButton("保存到本地", (button) => runSave("html", scope, button), "💾");
    htmlButton.dataset.tool = "html";
    htmlButton.title = "把主贴保存为离线可读的 HTML";
    tools.appendChild(htmlButton);

    const snapshotButton = nodeButton("生成快照", () => {
      const api = window.LDFCSnapshot;
      if (!api?.open) {
        window.LDFCToast.show("快照功能未加载，请刷新页面再试");
        return;
      }
      const posts =
        kind === "preview" && overlay ? previewSnapshotPosts(overlay) : topicSnapshotPosts();
      api.open({ title: scope.title(), url: scope.url(), posts });
    }, "📸");
    snapshotButton.dataset.tool = "snapshot";
    snapshotButton.title = "选择楼层，生成带水印和二维码的长图";
    tools.appendChild(snapshotButton);

    return tools;
  }

  // ---- 预览窗底部的站点动作排 ----
  //
  // 默认只放「只读 / 可回滚」的三枚：打开原帖、书签、分享。
  // 设置里打开「全搬」后才追加「赞 / boost」——赞和 boost 会真的写站点
  // （给楼主发通知），默认关着，避免在预览窗里误触。
  const SITE_ACTIONS_KEY = "ldfc.previewAllSiteActions";
  let siteActionsAll = false;
  let siteActionsLoaded = false;

  async function loadSiteActionPref() {
    if (siteActionsLoaded) return siteActionsAll;
    siteActionsLoaded = true;
    try {
      siteActionsAll = Boolean(await window.LDFCDB.getMeta(SITE_ACTIONS_KEY));
    } catch {
      siteActionsAll = false;
    }
    return siteActionsAll;
  }

  function setSiteActionsAll(value) {
    siteActionsAll = Boolean(value);
    siteActionsLoaded = true;
    window.LDFCDB?.putMeta?.(SITE_ACTIONS_KEY, siteActionsAll).catch?.(() => {});
    window.dispatchEvent(new CustomEvent("ldfc:site-actions-changed"));
  }

  function topicUrl(topicId) {
    return `${location.origin}/t/${topicId}`;
  }

  // 图标直接取预览窗自己那排的 SVG（不是 emoji）：搬过去之后看起来才是同一套按钮。
  const SITE_ICONS = {
    like: {
      viewBox: "0 0 24 24",
      path: '<path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>'
    },
    reply: {
      viewBox: "0 0 1024 1024",
      path: '<path d="M1024 640q0 94.857143-72.571429 257.714286-1.714286 4-6 13.714286t-7.714286 17.142857-7.428571 12.571429q-6.857143 9.714286-16 9.714286-8.571429 0-13.428571-5.714286t-4.857143-14.285714q0-5.142857 1.428571-15.142857t1.428571-13.428571q2.857143-38.857143 2.857143-70.285714 0-57.714286-10-103.428571t-27.714286-79.142857-45.714286-57.714286-60.285714-39.714286-76-24.285714-88-12.285714-100.285714-3.428571l-128 0 0 146.285714q0 14.857143-10.857143 25.714286t-25.714286 10.857143-25.714286-10.857143l-292.571429-292.571429q-10.857143-10.857143-10.857143-25.714286t10.857143-25.714286l292.571429-292.571429q10.857143-10.857143 25.714286-10.857143t25.714286 10.857143 10.857143 25.714286l0 146.285714 128 0q407.428571 0 500 230.285714 30.285714 76.571429 30.285714 190.285714z"/>'
    },
    boost: {
      viewBox: "0 0 1024 1024",
      path: '<path d="M1010.092957 38.19946a31.779551 31.779551 0 0 0-24.399655-24.399655C921.294212 0 870.914925 0 820.715635 0c-206.397081 0-330.195331 110.398439-422.574025 255.99638H189.744557A95.998643 95.998643 0 0 0 104.005769 308.975631l-98.838602 197.597206A47.999321 47.999321 0 0 0 48.146559 575.991855h207.537065l-44.939364 44.939365a63.999095 63.999095 0 0 0 0 90.49872l101.79856 101.81856a63.999095 63.999095 0 0 0 90.51872 0L448.000905 768.309136V975.986199a47.999321 47.999321 0 0 0 69.399019 42.979392l197.397208-98.778603a95.818645 95.818645 0 0 0 52.999251-85.798787V625.571154c145.177947-92.598691 255.99638-216.796934 255.99638-422.17403 0.199997-50.399287 0.199997-100.798575-13.699806-165.197664zM767.99638 335.995249a79.998869 79.998869 0 1 1 79.998869-79.998869 79.998869 79.998869 0 0 1-79.998869 79.998869z"/>'
    },
    bookmark: {
      viewBox: "0 0 24 24",
      path: '<path d="M17 3H7c-1.1 0-1.99.9-1.99 2L5 21l7-3 7 3V5c0-1.1-.9-2-2-2z"/>'
    },
    open: {
      viewBox: "0 0 24 24",
      path: '<path d="M19 19H5V5h7V3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z"/>'
    }
  };

  // 顺序与预览窗底排完全一致：赞 / 回复 / boost / 书签 / 打开原帖。
  const SITE_ACTION_LIST = [
    { id: "like", label: "赞", icon: SITE_ICONS.like, countSelector: ".ldp-f-like-count", gated: true },
    { id: "reply", label: "回复", icon: SITE_ICONS.reply, countSelector: ".ldp-f-reply-count", gated: false },
    { id: "boost", label: "boost", icon: SITE_ICONS.boost, gated: true },
    { id: "bookmark", label: "书签", icon: SITE_ICONS.bookmark, gated: false },
    { id: "open", label: "打开原帖", icon: SITE_ICONS.open, gated: false }
  ];

  function siteActionOriginal(overlay, id) {
    return overlay?.querySelector(`.ldp-f-${id}`) || null;
  }

  function applySiteAction(button, id, topicId, overlay) {
    if (!button) return;
    if (id === "bookmark") {
      button.classList.toggle("is-on", window.LDFCSiteBookmarks?.isBookmarked?.(topicId) === true);
    } else if (id === "like") {
      // 点赞状态以原按钮的 .liked 为准：我们只是把触发器搬过来，不另存一份状态。
      button.classList.toggle("is-on", siteActionOriginal(overlay, "like")?.classList.contains("liked") === true);
    }
    const action = SITE_ACTION_LIST.find((one) => one.id === id);
    const count = button.querySelector(".ldfc-site-count");
    if (count && action?.countSelector) {
      count.textContent = overlay?.querySelector(action.countSelector)?.textContent?.trim() || "0";
    }
  }

  // 书签缓存是异步到位的：加载完成后把已经挂在预览窗上的按钮重刷一遍。
  function updateSiteActionStates() {
    for (const host of document.querySelectorAll(`.${DOCK_CLASS}`)) {
      const topicId = host.ldfcResolveTopic?.()?.topicId;
      if (!topicId) continue;
      const overlay = host.closest(".ldp-overlay");
      for (const button of host.shadowRoot?.querySelectorAll(".ldfc-site-action") ?? []) {
        applySiteAction(button, button.dataset.siteAction, topicId, overlay);
      }
    }
  }
  window.addEventListener("ldfc:site-bookmarks-changed", updateSiteActionStates);

  async function runSiteAction(id, resolveTopic, button, overlay) {
    const topicId = resolveTopic?.()?.topicId;
    if (!topicId) return;
    // 连点会并发发出两个 POST/DELETE；同一个按钮在请求结束前只认第一次。
    if (button?.dataset.busy === "1") return;
    if (button) button.dataset.busy = "1";
    try {
      if (id === "open") {
        const href = siteActionOriginal(overlay, "open")?.getAttribute("href");
        const url = href && href !== "#" ? new URL(href, location.origin).href : topicUrl(topicId);
        window.open(url, "_blank", "noopener");
        return;
      }
      if (id === "bookmark") {
        // 书签缓存可能还没加载（没开过书签面板）：先对齐真实状态，
        // 否则已收藏的主题会被当成「未收藏」再 POST 一次。
        await window.LDFCSiteBookmarks?.load?.();
        const result = await window.LDFCSiteBookmarks.toggle(topicId);
        button?.classList.toggle("is-on", result.bookmarked);
        window.LDFCToast?.show?.(result.bookmarked ? "已加入书签" : "已取消书签");
        return;
      }
      // 赞 / 回复 / boost 直接转发给预览窗原来的按钮：
      // 点赞状态、内联回复框、boost 弹层都由它自己处理，这里不重复实现。
      const original = siteActionOriginal(overlay, id);
      if (!original || original.disabled) {
        window.LDFCToast?.show?.("稍等，预览还在加载");
        return;
      }
      original.click();
      setTimeout(() => applySiteAction(button, id, topicId, overlay), 300);
    } catch (error) {
      window.LDFCToast?.show?.(`${error?.message || "操作失败"}`);
    } finally {
      if (button) delete button.dataset.busy;
    }
  }

  // 这排动作已经从预览窗底部搬过来了，底排对应的圆按钮就不再重复显示。
  // 只在挂载了这排的预览窗上生效，不影响别的第三方弹窗。
  function syncSiteActionVisibility(overlay) {
    if (!overlay) return;
    overlay.classList.add("ldfc-has-site-actions");
    overlay.classList.toggle("ldfc-all-site-actions", siteActionsAll);
  }

  function createSiteActions(resolveTopic, overlay) {
    const row = document.createElement("div");
    row.className = "ldfc-site-actions";

    const paint = () => {
      row.innerHTML = "";
      const list = SITE_ACTION_LIST.filter((action) => !action.gated || siteActionsAll);
      for (const action of list) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "ldfc-site-action";
        button.dataset.siteAction = action.id;
        button.title = action.label;
        button.setAttribute("aria-label", action.label);
        const glyph = document.createElement("span");
        glyph.className = "ldfc-site-glyph";
        glyph.setAttribute("aria-hidden", "true");
        const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", action.icon.viewBox);
        svg.setAttribute("fill", "currentColor");
        svg.innerHTML = action.icon.path;
        glyph.appendChild(svg);
        button.appendChild(glyph);
        if (action.countSelector) {
          const count = document.createElement("span");
          count.className = "ldfc-site-count";
          count.textContent = "0";
          button.appendChild(count);
        }
        const label = document.createElement("span");
        label.className = "ldfc-site-label";
        label.textContent = action.label;
        button.appendChild(label);
        // 触摸端没有 hover：按住展开文字，松手收起，和 dock 同一套手感。
        bindTouchPress(button);
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          runSiteAction(action.id, resolveTopic, button, overlay);
        });
        applySiteAction(button, action.id, resolveTopic?.()?.topicId, overlay);
        row.appendChild(button);
      }
      syncSiteActionVisibility(overlay);
      if (list.some((action) => action.id === "bookmark")) {
        // 拉一次列表（10 分钟内走缓存），点亮已收藏状态；失败不影响点击。
        window.LDFCSiteBookmarks?.load?.().catch?.(() => {});
      }
    };

    paint();
    loadSiteActionPref().then(paint);
    return row;
  }

  function createDock(overlay, resolveTopic, afterMark) {
    const host = document.createElement("ldfc-preview-dock");
    host.className = DOCK_CLASS;
    host.ldfcResolveTopic = resolveTopic;

    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = DOCK_STYLE;
    shadow.appendChild(style);

    const dock = document.createElement("div");
    dock.className = "dock";
    dock.setAttribute("role", "toolbar");
    dock.setAttribute("aria-label", "标记当前主题");

    for (const action of ACTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.pool = action.pool;
      button.title = action.label;
      button.setAttribute("aria-label", action.label);
      bindTouchPress(button);

      const icon = document.createElement("span");
      icon.className = "ldfc-dock-icon";
      icon.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${DOCK_ICONS[action.pool]}</svg>`;

      const label = document.createElement("span");
      label.className = "ldfc-dock-label";
      label.textContent = action.dockLabel;

      const count = document.createElement("span");
      count.className = "ldfc-action-count";
      count.textContent = String(poolCount(action.pool));

      // 顺序 = 图标 / 数字（常显）/ 文字（悬停或按下才展开）。
      // 信息流列表行那组一直是这个结构，两处统一后才不会一会儿有数一会儿没数。
      button.append(icon, count, label);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        mark(action.pool, resolveTopic())
          .then((done) => {
            if (done) afterMark?.();
          })
          .catch(() => {});
      });
      dock.appendChild(button);
    }

    shadow.appendChild(dock);
    shadow.appendChild(createTools("preview", overlay, resolveTopic));
    shadow.appendChild(createSiteActions(resolveTopic, overlay));
    return host;
  }

  // 设置里切换「全搬」后，已经打开的预览窗要立刻跟着变，而不是等下次打开。
  window.addEventListener("ldfc:site-actions-changed", () => {
    for (const host of document.querySelectorAll(`.${DOCK_CLASS}`)) {
      const row = host.shadowRoot?.querySelector(".ldfc-site-actions");
      if (!row) continue;
      const next = createSiteActions(host.ldfcResolveTopic, host.closest(".ldp-overlay"));
      row.replaceWith(next);
    }
  });

  function firstPost() {
    // 用 id 直接定位：观察器每 120ms 可能跑一次，长楼里遍历所有楼层太浪费。
    // 不能用 includes("post_1")：post_10 ~ post_19 也会命中。
    const post = document.querySelector(".boxed.onscreen-post#post_1");
    return post?.dataset.postId ? post : null;
  }

  function mountTopicActions() {
    if (!isTopicPage()) return;

    const post = firstPost();
    const content = post?.querySelector(".cooked");
    if (!content) return;

    let row =
      content.querySelector(":scope > .save-buttons-container") ??
      content.querySelector(`:scope > .${FALLBACK_ROW_CLASS}`);

    if (!row) {
      row = document.createElement("div");
      row.className = FALLBACK_ROW_CLASS;
      content.appendChild(row);
    }

    if (row.querySelector(`:scope > .${ACTIONS_CLASS}`)) return;
    row.appendChild(createActions("topic", topicFromPage));
  }

  // dock 的落点：主贴正下方（图一红圈位置）。
  //   引擎窗：.ldp-body > .ldp-topic（一楼）之后、.ldp-comments-header 之前；
  //   兜底窗：没有"主贴/评论"分栏，就放在正文列表上方。
  // 两个落点都在 .ldp-body 里，所以 dock 会跟着正文一起滚走 —— 和参考脚本
  // 把按钮塞进一楼 .cooked 的行为一致，不额外做吸底，避免遮住评论。
  function dockSlot(overlay) {
    const body = overlay.querySelector(".ldp-modal > .ldp-body");
    if (!body) return null;
    const commentsHeader = body.querySelector(":scope > .ldp-comments-header");
    if (commentsHeader) return { body, before: commentsHeader };
    const posts = body.querySelector(":scope > .ldfc-pv-posts");
    return { body, before: posts ?? null };
  }

  function mountModalActions() {
    for (const overlay of document.querySelectorAll(".ldp-overlay")) {
      if (overlay.querySelector(`.ldp-modal .${DOCK_CLASS}`)) continue;
      const slot = dockSlot(overlay);
      if (!slot) continue;
      const dock = createDock(overlay, () => topicFromModal(overlay), () =>
        closePreview(overlay)
      );
      slot.body.insertBefore(dock, slot.before);
      applyPreviewOnlyOp(overlay);
      // 上次退出时开着只看楼主 → 打开后直接补全评论，不用再点一次。
      loadAllForOnlyOp(overlay);
    }
  }

  function refresh() {
    mountTopicActions();
    mountModalActions();
    // 引擎是懒加载评论的、站点也会重渲染楼层列表：两边都要重新套一次筛选，
    // 否则「只看楼主」开着时新到的非楼主楼层会全部冒出来。
    if (onlyOp.preview) {
      for (const overlay of document.querySelectorAll(".ldp-overlay")) applyPreviewOnlyOp(overlay);
    }
    if (onlyOp.topic) applyTopicOnlyOp();
    updateCounts();
    updateSiteActionStates();
  }

  function observe() {
    if (observer) return;

    loadPrefs();
    // 提前读「全搬」开关：否则设置面板在打开预览窗之前恒显示关闭。
    loadSiteActionPref();

    // 归属变了就重刷光效：自动已读、同步合并、信息池面板移入都不会经过这里的
    // 观察器，靠 poolManager 派发的事件统一收口。
    document.addEventListener("ldfc:pool-change", updateCounts);

    // 两个第三方面板都是运行时插进 DOM 的，只能靠观察 body 来发现。
    // 注入本身是幂等的，重复触发只是两次 querySelector。
    observer = new MutationObserver(() => {
      clearTimeout(observer.timer);
      observer.timer = setTimeout(refresh, INJECT_DELAY);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.LDFCLauncher = {
    applyNotifyVisibility,
    observe,
    refresh,
    updateCounts,
    // 设置面板用：预览窗底部是否连「赞 / boost」也搬过来（默认只搬只读的三个）
    isAllSiteActions: () => siteActionsAll,
    setAllSiteActions: setSiteActionsAll,
    whenSiteActionsReady: () => loadSiteActionPref()
  };
})();
