(() => {
  // LDFC 预览入口。
  //
  // 预览正文交给 vendored 的 LinuxDo 增强阅读引擎（MIT，见 vendor/）。
  // 它已经实现楼中楼、点赞、回复、书签、图片灯箱和楼层滑块；这里不再
  // 维护第二套简化正文，只负责点击接管、设置开关、打开动画和双层弹窗清理。
  //
  // 旧版自带窗口保留为引擎缺失时的兜底：
  // 这里只做「点下去立刻出窗口 + 一次 topic.json」，先把窗口画出来，
  // 内容到了再填，所以观感上跟原生跳转同速。
  //
  // 结构刻意沿用第三方脚本的 class 名（.ldp-overlay / .ldp-modal /
  // .ldp-head-btns / .ldp-f-open / .ldp-close / .ldp-title）：
  //   - ui/launcher.js 的三按钮注入、Topic ID 解析、标记后自动关窗
  //     全部不需要改；
  //   - 外观仍由下面 #ldfc-preview 作用域内的样式决定，
  //     不会被第三方脚本的 .ldp-* 规则抢走（id 选择器优先级更高）。
  //
  // 与第三方脚本同时启用时可能双重拦截，所以处理顺序是：
  //   1. 我们先关掉对方已经弹出来的窗口（点它的 .ldp-close）；
  //   2. 再打开自己的。谁先拿到 click 都不会留下两层窗口。
  const META_KEY = "previewEnabled";
  const BATCH = 20;
  // 悬停预取总开关的存储键。默认关闭：预取是纯延迟优化，
  // 用户只是划过没点开时那次请求就是白花的，所以默认花用户的钱不如让他自己开。
  const PREFETCH_META_KEY = "prefetchOnHover";
  // 悬停预取的意图延迟：太快会在鼠标扫过列表时白请求，太慢就赶不上点击。
  // 130ms 意味着"只是路过"不会触发，而"要打开的人"本来就会在标题上停一下。
  const PREFETCH_DELAY = 130;
  // 两次悬停预取之间的冷却：扫过一屏标题也不至于发出十几个请求。
  // 真正点击（pointerdown）不受冷却限制，也不会被总开关拦，不会拖慢打开。
  const PREFETCH_MIN_GAP = 1200;
  const PREFETCH_MAX = 200;

  let ready = false;
  let enabled = true;
  // 悬停预取默认关闭，需在设置面板里显式开启。
  let prefetchOnHover = false;
  // 用户是否已经动过这个开关：动过之后，晚到的 loadSetting 结果不许再覆盖他的选择。
  let prefetchTouched = false;
  let resolveReady = null;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });
  // 已经预取过的 Topic：同一个标题反复划过只请求一次。
  const prefetched = new Set();
  let hoverTimer = 0;
  let lastPrefetchAt = 0;
  // { overlay, controller, topicId, stream, cursor, lastNumber, more, postsBox }
  let current = null;
  // 打开时标题的屏幕矩形。关闭动画要按原路缩回这里。
  let lastSourceRect = null;
  let closing = false;

  function isEnabled() {
    return enabled;
  }

  async function setEnabled(next) {
    enabled = Boolean(next);
    try {
      await window.LDFCDB.putMeta(META_KEY, enabled);
    } catch {
      // 写不进去也不影响本次会话
    }
    if (!enabled) close();
  }

  async function loadSetting() {
    try {
      const saved = await window.LDFCDB.getMeta(META_KEY);
      if (typeof saved === "boolean") enabled = saved;
    } catch {
      // 读不到就用默认值
    }
    try {
      const savedPrefetch = await window.LDFCDB.getMeta(PREFETCH_META_KEY);
      if (!prefetchTouched && typeof savedPrefetch === "boolean") prefetchOnHover = savedPrefetch;
    } catch {
      // 读不到就用默认值（关闭）
    }
    ready = true;
    resolveReady?.();
  }

  function isPrefetchOnHover() {
    return prefetchOnHover;
  }

  async function setPrefetchOnHover(next) {
    prefetchTouched = true;
    prefetchOnHover = Boolean(next);
    if (!prefetchOnHover) {
      clearTimeout(hoverTimer);
      prefetched.clear();
    }
    try {
      await window.LDFCDB.putMeta(PREFETCH_META_KEY, prefetchOnHover);
    } catch {
      // 写不进去也不影响本次会话
    }
  }

  // ---- 链接识别 ----

  function topicIdFrom(anchor) {
    const dataId = anchor.getAttribute("data-topic-id");
    if (/^\d+$/.test(dataId || "")) return dataId;

    const href = anchor.getAttribute("href") || "";
    if (!/\/t\//.test(href)) return null;

    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return null;
    }
    // 站外链接、站内搜索页都不管
    if (url.origin !== window.location.origin) return null;

    const match = url.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)(?:\/|$)/);
    return match ? match[1] : null;
  }

  // 带楼层号的链接（通知、引用、「跳到回复」、搜索结果里的具体楼层）：
  // /t/slug/123/45 → 45。引擎支持按楼层打开，之前我们统一传 0，
  // 结果这类链接只会停在"第一条未读"，等于丢了原脚本的定位能力。
  function postNumberFrom(anchor) {
    const href = anchor.getAttribute("href") || "";
    if (!/\/t\//.test(href)) return 0;
    let url;
    try {
      url = new URL(href, window.location.origin);
    } catch {
      return 0;
    }
    if (url.origin !== window.location.origin) return 0;
    const match = url.pathname.match(/^\/t\/(?:[^/]+\/)?\d+\/(\d+)(?:\/|$)/);
    return match ? Number(match[1]) || 0 : 0;
  }

  function onClick(event) {
    if (!ready || !enabled) return;
    if (event.defaultPrevented) return;
    // 搜索是用户主动检索：不接管点击，保持"不干预搜索结果页"的既有规则。
    // （/t/ 页不排除：那里的相关主题链接同样值得预览。）
    if (/^\/search(\/|$)/.test(window.location.pathname)) return;
    // 中键 / 新标签页打开 / 拖拽打开都交回浏览器，只接管普通左键
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.closest(".ldp-overlay")) return;
    if (anchor.classList.contains("ldp-f-open")) return;

    const topicId = topicIdFrom(anchor);
    if (!topicId) return;

    // 抢在第三方脚本与 Discourse 自己的路由之前：点了就只走我们的预览
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    open(topicId, postNumberFrom(anchor), anchor);
  }

  // ---- 悬停预取 ----
  //
  // 「点下去才发请求」是打开慢的主因：一次 /n/-/<id>.json 往返就是用户
  // 感知到的卡顿。引擎现在给首页树加了 60 秒缓存（vendor 里 NESTED_CACHE），
  // 这里在鼠标划过标题、或按下鼠标时先把它取回来，点击时直接命中缓存。
  //
  // 代价：用户只是划过而没点开，会多一次请求。所以：
  //   1. 悬停预取默认关闭（设置面板可开，存 prefetchOnHover）；
  //   2. 要停在标题上 130ms 才算"有意图"，扫过的行不发；
  //   3. 两次预取之间冷却 1200ms，扫一屏也只发一跳；
  //   4. 同一个 Topic 只预取一次；非搜索页、非站外链接才做。
  // 点击（pointerdown）的预取不受这四条限制：那是真意图，不能拖慢打开。
  function prefetchTarget(anchor) {
    const id = topicIdFrom(anchor);
    if (!id || prefetched.has(id)) return null;
    return id;
  }

  function prefetchNow(anchor, force = false) {
    const id = prefetchTarget(anchor);
    if (!id) return;
    // 悬停路径有冷却；点击路径（force）必须发，否则会拖慢真正的打开。
    // 冷却期间不丢弃意图：用户可能一直停在这一条上，等冷却结束补发一次，
    // 否则「停在 A 上刚预取过，1.2 秒内挪到 B 并停住」会让 B 永远不被预取。
    if (!force) {
      const wait = PREFETCH_MIN_GAP - (Date.now() - lastPrefetchAt);
      if (wait > 0) {
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => {
          if (prefetchOnHover && anchor.isConnected) prefetchNow(anchor);
        }, wait);
        return;
      }
    }
    lastPrefetchAt = Date.now();
    if (prefetched.size > PREFETCH_MAX) prefetched.clear();
    prefetched.add(id);
    try {
      window.LDFCEnhancedPreview?.prefetch?.(id);
    } catch {
      // 预取失败不影响点击：真正打开时还会再取一次
    }
  }

  function candidateAnchor(event) {
    if (!enabled) return null;
    if (/^\/search(\/|$)/.test(window.location.pathname)) return null;
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor || anchor.closest(".ldp-overlay")) return null;
    if (anchor.classList.contains("ldp-f-open")) return null;
    return anchor;
  }

  function onPointerOver(event) {
    // 触摸没有「悬停意图」，等 pointerdown 再取，否则每次点开都是白请求。
    if (event.pointerType === "touch" || event.pointerType === "pen") return;
    // 悬停预取默认关闭：没开就只走 pointerdown 那条路。
    if (!prefetchOnHover) return;
    const anchor = candidateAnchor(event);
    if (!anchor || !prefetchTarget(anchor)) return;
    clearTimeout(hoverTimer);
    // 回调里再校验一次：定时器期间可能已被关闭开关、或那一行已被列表更新换掉。
    hoverTimer = setTimeout(() => {
      if (prefetchOnHover && anchor.isConnected) prefetchNow(anchor);
    }, PREFETCH_DELAY);
  }

  function onPointerOut(event) {
    const anchor = event.target?.closest?.("a[href]");
    if (!anchor) return;
    // 从标题内部的一个子节点移到另一个子节点也会触发 pointerout，
    // 只有指针真的离开这个链接才取消预取。
    const next = event.relatedTarget;
    if (next && anchor.contains(next)) return;
    clearTimeout(hoverTimer);
  }

  function onPointerDown(event) {
    if (event.button !== 0) return;
    // 先清掉挂起的悬停定时器：按在非链接上（工具栏、空白）也必须撤销意图。
    clearTimeout(hoverTimer);
    const anchor = candidateAnchor(event);
    if (!anchor) return;
    prefetchNow(anchor, true);
  }

  // ---- 关窗 ----

  function prefersReducedMotion() {
    return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;
  }

  // 关闭也要有动画：打开是「从标题长出来」，关闭就按原路缩回标题。
  // 否则进去有动画、出来硬切，观感是断的。
  // 返回 false 表示没接管（调用方自己兜底）。
  function closeAnimated(overlay) {
    if (!overlay?.isConnected || closing) return false;
    closing = true;

    const finish = () => {
      closing = false;
      // 引擎窗要走引擎自己的 close：它还要清 CURRENT_OVERLAY，
      // 直接 remove 会留下一个指向游离节点的全局引用。
      if (overlay.dataset.ldfcEngine === "true") {
        window.LDFCEnhancedPreview?.close?.();
        return;
      }
      // 注意：overlay.ldpClose 是第三方脚本 / 主世界挂在 DOM 上的 expando，
      // 隔离世界读不到它。所以这里和原逻辑一样，读不到就点关闭按钮，
      // 让它走对方自己的清理（否则会漏掉对方的事件解绑和计数）。
      if (typeof overlay.ldpClose === "function") {
        overlay.ldpClose();
        return;
      }
      const closeButton = overlay.querySelector(".ldp-close");
      if (closeButton) closeButton.click();
      else overlay.remove();
    };

    if (prefersReducedMotion()) {
      finish();
      return true;
    }

    const modal = overlay.querySelector(".ldp-modal");
    const target = modal?.getBoundingClientRect();
    if (!modal || !target?.width) {
      finish();
      return true;
    }

    const source = lastSourceRect;
    const frames =
      source && source.width
        ? [
            { transformOrigin: "0 0", transform: "none", opacity: 1, borderRadius: "12px" },
            {
              transformOrigin: "0 0",
              transform:
                `translate(${source.left - target.left}px, ${source.top - target.top}px) ` +
                `scale(${Math.max(0.04, source.width / target.width)}, ` +
                `${Math.max(0.04, source.height / target.height)})`,
              opacity: 0,
              borderRadius: "18px"
            }
          ]
        : [
            { transform: "none", opacity: 1 },
            { transform: "scale(0.94)", opacity: 0 }
          ];

    try {
      modal
        .animate(frames, {
          duration: 260,
          easing: "cubic-bezier(0.4, 0, 0.2, 1)",
          fill: "both"
        })
        .finished.then(finish, finish);
      // 遮罩和窗口一起走，避免窗口缩回去时背后还留一块暗色。
      overlay.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 220,
        easing: "ease-in",
        fill: "both"
      });
    } catch {
      finish();
    }
    return true;
  }

  function close() {
    const engineOverlay = window.LDFCEnhancedPreview?.overlay;
    if (engineOverlay && engineOverlay.isConnected && closeAnimated(engineOverlay)) return;

    window.LDFCEnhancedPreview?.close?.();
    if (!current) return;
    const { overlay, controller, onKey } = current;
    current = null;
    try {
      controller?.abort();
    } catch {
      // 已经结束的请求不用管
    }
    document.removeEventListener("keydown", onKey, true);
    overlay.remove();
  }

  // 第三方脚本的窗口（我们自己的带 id，排除掉）
  function closeForeign() {
    for (const overlay of document.querySelectorAll(".ldp-overlay")) {
      if (overlay.id === "ldfc-preview") continue;
      if (overlay.dataset.ldfcEngine === "true") continue;
      const closeButton = overlay.querySelector(".ldp-close");
      if (closeButton) closeButton.click();
      else overlay.remove();
    }
  }

  // ---- 渲染 ----

  function skeletonPost() {
    return (
      '<article class="ldfc-pv-post ldfc-pv-skeleton">' +
      '<div class="ldfc-pv-sk" style="width:38%"></div>' +
      '<div class="ldfc-pv-sk"></div>' +
      '<div class="ldfc-pv-sk" style="width:72%"></div>' +
      "</article>"
    );
  }

  function postElement(post) {
    const article = document.createElement("article");
    article.className = "ldfc-pv-post";
    article.dataset.postNumber = String(post.post_number ?? "");

    const head = document.createElement("div");
    head.className = "ldfc-pv-post-head";

    const author = document.createElement("span");
    author.className = "ldfc-pv-author";
    author.textContent = post.username || post.name || "未知用户";

    const floor = document.createElement("span");
    floor.className = "ldfc-pv-floor";
    floor.textContent = post.post_number ? `#${post.post_number}` : "";

    head.append(author, floor);

    const body = document.createElement("div");
    // cooked 是站点自己渲染好的 HTML，和原站正文同源，直接放进来
    body.className = "ldfc-pv-body cooked";
    body.innerHTML = post.cooked || "";

    article.append(head, body);
    return article;
  }

  function appendPosts(posts) {
    if (!current) return;
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      if (!post || !post.post_number) continue;
      // 已经渲染过的楼层不再重复插入（流里的 id 可能被分批取回来）
      if (current.rendered.has(post.post_number)) continue;
      current.rendered.add(post.post_number);
      current.lastNumber = Math.max(current.lastNumber, post.post_number);
      fragment.appendChild(postElement(post));
    }
    current.postsBox.appendChild(fragment);
  }

  function updateMore() {
    if (!current) return;
    const left = current.stream.length - current.cursor;
    current.more.hidden = left <= 0;
    current.more.textContent = left > 0 ? `加载更多回复（还有 ${left} 层）` : "已加载全部回复";
  }

  async function fetchTopic(topicId, signal) {
    const response = await fetch(`/t/${topicId}.json`, {
      credentials: "include",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function loadMore() {
    if (!current || current.loadingMore) return;
    const ids = current.stream.slice(current.cursor, current.cursor + BATCH);
    if (!ids.length) return;

    current.loadingMore = true;
    current.more.disabled = true;
    current.more.textContent = "加载中…";

    try {
      const query = ids.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join("&");
      const response = await fetch(`/t/${current.topicId}/posts.json?${query}`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: current.controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const posts = (data?.post_stream?.posts ?? []).slice().sort(
        (a, b) => (a.post_number || 0) - (b.post_number || 0)
      );
      appendPosts(posts);
      current.cursor += ids.length;
    } catch (error) {
      if (error?.name !== "AbortError") {
        current.more.textContent = "加载失败，点一下重试";
      }
    } finally {
      if (!current) return;
      current.loadingMore = false;
      current.more.disabled = false;
      updateMore();
    }
  }

  // 从标题位置把预览窗“拉”出来：与导航的图标→面板转场同一套 FLIP 思路。
  // 目标窗已经由引擎同步插入 DOM，测量后反向 transform 到标题框，再回落。
  function animateFromSource(overlay, sourceRect) {
    // 真实站点上动画是否跑了、为什么没跑，肉眼分不出「没做」和「被系统关掉」。
    // 这里留一条可查的证据：控制台输入 __ldfcOpenAnim 就能看到。
    const debug = (window.__ldfcOpenAnim = { skipped: null, from: null, duration: 460 });
    if (!sourceRect) {
      debug.skipped = "no-source";
      return;
    }
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // 系统「动画效果」关闭时浏览器会报 reduce，这里按无障碍规范直接显示。
      debug.skipped = "reduced-motion";
      return;
    }
    const modal = overlay.querySelector(".ldp-modal");
    if (!modal) {
      debug.skipped = "no-modal";
      return;
    }

    let target;
    try {
      target = modal.getBoundingClientRect();
    } catch {
      debug.skipped = "no-rect";
      return;
    }
    if (!target.width || !target.height) {
      debug.skipped = "zero-size";
      return;
    }

    const scaleX = Math.max(0.04, sourceRect.width / target.width);
    const scaleY = Math.max(0.04, sourceRect.height / target.height);
    const translateX = sourceRect.left - target.left;
    const translateY = sourceRect.top - target.top;

    debug.from = {
      left: Math.round(sourceRect.left),
      top: Math.round(sourceRect.top),
      width: Math.round(sourceRect.width),
      height: Math.round(sourceRect.height)
    };

    overlay.dataset.ldfcOpening = "true";
    try {
      modal.animate(
        [
          {
            transformOrigin: "0 0",
            transform: `translate(${translateX}px, ${translateY}px) scale(${scaleX}, ${scaleY})`,
            // 起始不透明度不能太低：从 0.18 起步看起来是「淡入」，不是「从标题长出来」。
            opacity: 0.92,
            borderRadius: "18px"
          },
          {
            transformOrigin: "0 0",
            transform: "none",
            opacity: 1,
            borderRadius: "12px"
          }
        ],
        {
          duration: 460,
          easing: "cubic-bezier(0.32, 0.72, 0, 1)",
          fill: "both"
        }
      );
      // 遮罩只做很轻的一层，避免抢走「窗口在长大」的注意力。
      overlay.animate([{ opacity: 0.55 }, { opacity: 1 }], {
        duration: 200,
        easing: "ease-out",
        fill: "both"
      });
    } catch {
      // Web Animations 失败时直接显示最终窗口，不影响功能
      debug.skipped = "animate-failed";
    }
    setTimeout(() => {
      delete overlay.dataset.ldfcOpening;
    }, 520);
  }

  function open(topicId, targetPostNumber = 0, anchor) {
    const engine = window.LDFCEnhancedPreview;
    if (engine?.open) {
      closeForeign();
      // 旧兜底窗如果还开着，先收掉，避免两层。
      if (current) {
        const { overlay, controller, onKey } = current;
        current = null;
        try {
          controller?.abort();
        } catch {}
        document.removeEventListener("keydown", onKey, true);
        overlay.remove();
      }

      const sourceRect = anchor?.getBoundingClientRect?.() || null;
      lastSourceRect = sourceRect;
      const opened = engine.open(topicId, Number(targetPostNumber) || 0);
      if (!opened?.overlay) return openLegacy(topicId);

      opened.overlay.dataset.ldfcEngine = "true";
      // 先把 dock 插进主贴下方再测量，转场动画量到的就是最终高度。
      window.LDFCLauncher?.refresh?.();
      animateFromSource(opened.overlay, sourceRect);
      return;
    }
    openLegacy(topicId);
  }

  function openLegacy(topicId) {
    closeForeign();
    close();

    const controller = new AbortController();
    const overlay = document.createElement("div");
    overlay.id = "ldfc-preview";
    overlay.className = "ldp-overlay";
    overlay.innerHTML = `
      <div class="ldp-modal" role="dialog" aria-modal="true" aria-label="主题预览">
        <div class="ldp-header">
          <div class="ldfc-pv-headline">
            <h2 class="ldp-title"><span class="ldfc-pv-sk ldfc-pv-sk-title"></span></h2>
            <div class="ldp-meta">正在加载主题…</div>
          </div>
          <div class="ldp-head-btns">
            <button type="button" class="ldp-close" title="关闭（Esc）" aria-label="关闭预览">×</button>
          </div>
        </div>
        <div class="ldp-body">
          <div class="ldfc-pv-posts">${skeletonPost()}${skeletonPost()}</div>
          <button type="button" class="ldfc-pv-more" hidden>加载更多回复</button>
        </div>
        <div class="ldp-footer">
          <a class="ldp-f-open" href="/t/${topicId}" target="_blank" rel="noopener">打开原贴</a>
        </div>
      </div>`;

    document.body.appendChild(overlay);

    const overlayClose = () => close();
    const onKey = (event) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close();
    };

    current = {
      overlay,
      controller,
      onKey,
      topicId,
      stream: [],
      cursor: 0,
      lastNumber: 0,
      rendered: new Set(),
      loadingMore: false,
      postsBox: overlay.querySelector(".ldfc-pv-posts"),
      more: overlay.querySelector(".ldfc-pv-more")
    };

    // 和第三方脚本同名的 expando：ui/launcher.js 标记成功后会调它，
    // 这样能连同 abort / 事件解绑一起收干净。
    overlay.ldpClose = overlayClose;

    overlay.querySelector(".ldp-close").addEventListener("click", overlayClose);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    current.more.addEventListener("click", loadMore);
    document.addEventListener("keydown", onKey, true);

    // 三按钮立即注入，不等 MutationObserver 的 120ms 去抖
    window.LDFCLauncher?.refresh?.();

    fetchTopic(topicId, controller.signal)
      .then((data) => {
        if (!current || current.overlay !== overlay) return;

        const posts = data?.post_stream?.posts ?? [];
        const stream = data?.post_stream?.stream ?? [];
        const highest = Number(data?.highest_post_number) || stream.length || posts.length;

        // cursor 指向「已经拿到的最后一层在 stream 里的下一个位置」，
        // 没拿到的楼层用 /t/<id>/posts.json 按 id 补。
        const indexById = new Map(stream.map((id, index) => [String(id), index + 1]));
        current.stream = stream;
        current.cursor = Math.min(
          stream.length,
          posts.reduce((max, post) => Math.max(max, indexById.get(String(post.id)) || 0), 0)
        );

        overlay.querySelector(".ldp-title").textContent = data?.title || `主题 ${topicId}`;
        const meta = overlay.querySelector(".ldp-meta");
        meta.textContent =
          `${highest} 层` +
          (data?.last_read_post_number ? ` · 已读到 #${data.last_read_post_number}` : " · 尚未读过");

        current.postsBox.innerHTML = "";
        appendPosts(posts.slice().sort((a, b) => (a.post_number || 0) - (b.post_number || 0)));
        if (!current.postsBox.childElementCount) {
          const empty = document.createElement("p");
          empty.className = "ldfc-pv-empty";
          empty.textContent = "这一层没有可预览的内容，点右下角「打开原贴」查看。";
          current.postsBox.appendChild(empty);
        }
        updateMore();

        const active = window.LDFCFilter?.getActivePool?.();
        if (active && active !== "HOME") window.LDFCPoolPanel?.render?.(active);
      })
      .catch((error) => {
        if (!current || current.overlay !== overlay) return;
        if (error?.name === "AbortError") return;
        current.postsBox.innerHTML =
          `<p class="ldfc-pv-error">主题内容加载失败（${error?.message || error}）。` +
          "可以点右下角「打开原贴」直接看。</p>";
        overlay.querySelector(".ldp-meta").textContent = "加载失败";
      });
  }

  function start() {
    document.addEventListener("click", onClick, true);
    document.addEventListener("pointerover", onPointerOver, { capture: true, passive: true });
    document.addEventListener("pointerout", onPointerOut, { capture: true, passive: true });
    document.addEventListener("pointerdown", onPointerDown, { capture: true, passive: true });
    loadSetting();
  }

  window.LDFCPreview = {
    close,
    closeAnimated,
    isEnabled,
    isPrefetchOnHover,
    open,
    setEnabled,
    setPrefetchOnHover,
    start,
    whenReady: () => readyPromise
  };
})();
