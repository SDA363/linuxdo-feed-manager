(() => {
  // 「生成快照」：把选中的楼层渲染成一张竖屏长图。
  //
  // 和 ui/previewExport.js 的关系：
  //   - 单楼截图的老路径保留（saveImage 仍是它的实现底座）；
  //   - 这里只多做了三件老路径没有的事：楼层多选、页头（Logo/标题/北京时间）、
  //     水印与二维码。
  // 复用 cleanClone / waitImages / download，避免两套清理规则漂移。
  //
  // 约束：
  //   1. html2canvas 有画布尺寸上限，所以生成前按高度自动降 scale，
  //      超过硬上限直接报错而不是产出半张白图；
  //   2. 不引 CDN：html2canvas 与 qrcodejs 都是本地 vendor。
  const META_KEY = "snapshotSettings";
  const WIDTH = 800;
  // 浏览器 canvas 高度普遍在 16384 左右，留出余量。
  const MAX_HEIGHT = 14000;
  const DEFAULTS = {
    format: "png",
    qr: true,
    watermark: true,
    theme: "auto"
  };

  let prefs = { ...DEFAULTS };
  let prefsLoaded = false;
  let activePanel = null;

  function loadPrefs() {
    if (prefsLoaded) return Promise.resolve(prefs);
    prefsLoaded = true;
    return Promise.resolve()
      .then(() => window.LDFCDB?.getMeta?.(META_KEY))
      .then((saved) => {
        if (saved && typeof saved === "object") prefs = { ...DEFAULTS, ...saved };
        return prefs;
      })
      .catch(() => prefs);
  }

  function savePrefs() {
    try {
      window.LDFCDB?.putMeta?.(META_KEY, prefs);
    } catch {
      // 存不下只影响下次默认值
    }
  }

  function toast(message) {
    window.LDFCToast?.show?.(message);
  }

  // ---------- 主题 ----------

  function parseRgb(color) {
    const match = /^rgba?\(([^)]+)\)$/i.exec(String(color || "").trim());
    if (!match) return null;
    const parts = match[1].split(",").map((value) => Number(value.trim()));
    if (parts.length < 3 || parts.some((value) => Number.isNaN(value))) return null;
    if (parts.length === 4 && parts[3] === 0) return null;
    return { r: parts[0], g: parts[1], b: parts[2] };
  }

  function luminance(rgb) {
    const channel = (value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
  }

  function readBodyColor(property) {
    try {
      return getComputedStyle(document.body)[property];
    } catch {
      return "";
    }
  }

  // mode: auto / light / dark。auto 直接跟随站点当前主题（body 的底色与字色）。
  function resolveTheme(mode) {
    const light = { bg: "#ffffff", fg: "#24292f", dark: false };
    const dark = { bg: "#12141a", fg: "#e8e8ea", dark: true };
    if (mode === "light") return light;
    if (mode === "dark") return dark;

    const bgRaw = readBodyColor("backgroundColor");
    const fgRaw = readBodyColor("color");
    const bgRgb = parseRgb(bgRaw);
    const fgRgb = parseRgb(fgRaw);
    if (!bgRgb) return light;
    return {
      bg: bgRaw,
      fg: fgRgb ? fgRaw : light.fg,
      dark: luminance(bgRgb) < 0.35
    };
  }

  // ---------- 页头 ----------

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function beijingTime() {
    const now = new Date();
    // 站点用户以中文用户为主，时间戳固定北京时间，避免跨时区读图时误解。
    const text = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false
    }).format(now);
    return `快照生成时间：${text}（北京时间）`;
  }

  function forumLogo() {
    const img =
      document.querySelector("#site-logo img") ||
      document.querySelector(".d-header .title img") ||
      document.querySelector(".ld-header-logo img");
    const src = img?.currentSrc || img?.src || "";
    return /^https?:|^\//.test(src) ? src : "";
  }

  async function inlineLogo(url) {
    if (!url) return "";
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) return "";
      const blob = await response.blob();
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => resolve("");
        reader.readAsDataURL(blob);
      });
    } catch {
      return "";
    }
  }

  // ---------- 水印 / 二维码 ----------

  function escapeText(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function fillWatermark(container, text, theme) {
    if (!text) return;
    const layer = document.createElement("div");
    layer.className = "ldfc-snap-watermark";
    const width = container.offsetWidth || WIDTH;
    const height = container.scrollHeight || container.offsetHeight || WIDTH;
    const stepX = 200;
    const stepY = 100;
    const color = theme.dark ? "#ffffff" : "#000000";
    const label = escapeText(text);
    const parts = [];
    for (let y = -stepY; y < height + stepY; y += stepY) {
      for (let x = -stepX; x < width + stepX; x += stepX) {
        parts.push(`<span style="left:${x}px;top:${y}px">${label}</span>`);
      }
    }
    layer.style.setProperty("--ldfc-wm-color", color);
    layer.innerHTML = parts.join("");
    container.appendChild(layer);
  }

  // 扩展版：vendor 是独立脚本，QRCode 挂在 window 上。
  // 油猴版：vendor 被拼进同一个 IIFE，QRCode 是闭包变量，window 上取不到。
  function qrLib() {
    if (typeof window.QRCode === "function") return window.QRCode;
    return typeof QRCode === "function" ? QRCode : null;
  }

  function addQrCode(container, url) {
    const Lib = qrLib();
    if (!Lib) return;
    const wrap = document.createElement("div");
    wrap.className = "ldfc-snap-qr";
    try {
      new Lib(wrap, {
        text: url,
        width: 96,
        height: 96,
        colorDark: "#000000",
        colorLight: "#ffffff",
        correctLevel: Lib.CorrectLevel?.M ?? 0
      });
      container.appendChild(wrap);
    } catch {
      // 二维码只是锦上添花，生成失败不影响主流程
    }
  }

  // ---------- 渲染 ----------

  async function renderOne({ number, node }, index) {
    const api = window.LDFCPreviewExport;
    const section = document.createElement("section");
    section.className = "ldfc-snap-post";

    const tag = document.createElement("div");
    tag.className = "ldfc-snap-floor";
    tag.textContent = `#${number ?? index + 1}`;
    section.appendChild(tag);

    const body = api.cleanClone(node);
    section.appendChild(body);
    return section;
  }

  async function buildCanvas({ title, url, posts, options }) {
    const api = window.LDFCPreviewExport;
    const lib = window.html2canvas;
    if (typeof lib !== "function") throw new Error("html2canvas 未加载，请刷新页面");
    if (!api?.cleanClone) throw new Error("导出模块未就绪，请刷新页面");
    if (!posts.length) throw new Error("至少选择一层");

    const theme = resolveTheme(options.theme);
    const holder = document.createElement("div");
    holder.setAttribute("data-ldfc-snapshot", "canvas");
    holder.style.cssText =
      `position:fixed;left:-10000px;top:0;width:${WIDTH}px;padding:30px;box-sizing:border-box;` +
      `background:${theme.bg};color:${theme.fg};` +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;';

    const header = document.createElement("div");
    header.className = "ldfc-snap-head";

    const logoUrl = forumLogo();
    if (logoUrl) {
      const logo = document.createElement("img");
      logo.className = "ldfc-snap-logo";
      logo.src = (await inlineLogo(logoUrl)) || logoUrl;
      header.appendChild(logo);
    }

    const titles = document.createElement("div");
    titles.className = "ldfc-snap-titles";
    const h1 = document.createElement("h1");
    h1.textContent = title;
    const time = document.createElement("div");
    time.className = "ldfc-snap-time";
    time.textContent = beijingTime();
    titles.append(h1, time);
    header.appendChild(titles);

    if (options.qr) {
      // 二维码占位在页头右侧，标题留出等宽内边距，避免压字。
      titles.style.paddingRight = "112px";
    }

    holder.appendChild(header);

    for (let index = 0; index < posts.length; index += 1) {
      holder.appendChild(await renderOne(posts[index], index));
    }

    const source = document.createElement("div");
    source.className = "ldfc-snap-source";
    source.textContent = `来源：${url}`;
    holder.appendChild(source);

    if (options.qr) addQrCode(holder, url);

    try {
      document.body.appendChild(holder);
      await api.waitImages(holder);
      if (options.watermark) {
        const username = window.LDFCIdentity?.current?.()?.username || "";
        fillWatermark(holder, username, theme);
      }

      const height = holder.scrollHeight;
      let scale = 2;
      if (height * scale > MAX_HEIGHT) scale = Math.max(1, Math.floor((MAX_HEIGHT / height) * 10) / 10);
      if (height > MAX_HEIGHT) {
        throw new Error(`内容太长（约 ${height}px），请少选几层再试`);
      }

      const canvas = await lib(holder, {
        scale,
        useCORS: true,
        backgroundColor: theme.bg,
        logging: false
      });
      return canvas;
    } finally {
      holder.remove();
    }
  }

  // ---------- 结果预览 ----------

  function showResult(canvas, filename) {
    const backdrop = document.createElement("div");
    backdrop.className = "ldfc-snap-backdrop";

    const panel = document.createElement("div");
    panel.className = "ldfc-snap-result";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "快照预览");

    const img = document.createElement("img");
    img.src = canvas.toDataURL("image/png");
    img.alt = "快照预览";

    const actions = document.createElement("div");
    actions.className = "ldfc-snap-result-actions";

    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "下载图片";
    download.addEventListener("click", () => {
      canvas.toBlob((blob) => {
        if (blob) window.LDFCPreviewExport?.download?.(blob, filename);
      }, filename.endsWith(".jpg") ? "image/jpeg" : "image/png", 0.92);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "关闭";

    const dismiss = () => {
      backdrop.classList.remove("is-open");
      setTimeout(() => backdrop.remove(), 200);
      document.removeEventListener("keydown", onKey);
    };
    const onKey = (event) => {
      if (event.key === "Escape") dismiss();
    };
    close.addEventListener("click", dismiss);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) dismiss();
    });
    document.addEventListener("keydown", onKey);

    actions.append(download, close);
    panel.append(img, actions);
    backdrop.appendChild(panel);
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));
  }

  // ---------- 面板 ----------

  // 父子同时勾选时，子楼已经跟着父楼的克隆一起进图了，
  // 留着会在长图里重复出现一遍。
  function dropContained(picked) {
    const nodes = new Set(picked.map((item) => item.node));
    return picked.filter((item) => {
      let parent = item.node.parentElement?.closest(".ldp-post, .ldfc-pv-post");
      while (parent) {
        if (nodes.has(parent)) return false;
        parent = parent.parentElement?.closest(".ldp-post, .ldfc-pv-post");
      }
      return true;
    });
  }

  function closePanel() {
    if (!activePanel) return;
    const panel = activePanel;
    activePanel = null;
    panel.backdrop.classList.remove("is-open");
    setTimeout(() => panel.backdrop.remove(), 200);
    document.removeEventListener("keydown", panel.onKey);
  }

  function buildPanel({ title, url, posts, onGenerate }) {
    const backdrop = document.createElement("div");
    backdrop.className = "ldfc-snap-backdrop";

    const panel = document.createElement("div");
    panel.className = "ldfc-snap-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "生成快照");

    const head = document.createElement("div");
    head.className = "ldfc-snap-panel-head";
    const heading = document.createElement("strong");
    heading.textContent = "生成快照";
    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "ldfc-snap-close";
    closeButton.setAttribute("aria-label", "关闭");
    closeButton.textContent = "×";
    head.append(heading, closeButton);

    const subtitle = document.createElement("p");
    subtitle.className = "ldfc-snap-subtitle";
    subtitle.textContent = title;

    // 楼层多选
    const floorBox = document.createElement("div");
    floorBox.className = "ldfc-snap-floors";
    const floorHead = document.createElement("div");
    floorHead.className = "ldfc-snap-floors-head";
    const floorLabel = document.createElement("span");
    floorLabel.textContent = `选择楼层（共 ${posts.length} 层）`;
    const allButton = document.createElement("button");
    allButton.type = "button";
    allButton.textContent = "全选";
    const noneButton = document.createElement("button");
    noneButton.type = "button";
    noneButton.textContent = "清空";
    floorHead.append(floorLabel, allButton, noneButton);

    const list = document.createElement("div");
    list.className = "ldfc-snap-floor-list";
    const boxes = [];
    posts.forEach((post, index) => {
      const item = document.createElement("label");
      item.className = "ldfc-snap-floor-item";
      // 楼中楼缩进一级，最多缩 3 级（再深就只是视觉噪声了）。
      const depth = Math.max(0, Math.min(3, Number(post.depth) || 0));
      if (depth > 0) item.style.paddingLeft = `${4 + depth * 16}px`;
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = post.number === 1;
      // 用序号而不是楼层号做索引：楼中楼的楼层号可能重复出现在不同父楼里。
      box.dataset.index = String(index);
      const text = document.createElement("span");
      const excerpt = (post.node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40);
      text.textContent = `${depth > 0 ? "↳ " : ""}#${post.number}  ${excerpt}${excerpt.length >= 40 ? "…" : ""}`;
      item.append(box, text);
      boxes.push(box);
      list.appendChild(item);
    });
    floorBox.append(floorHead, list);

    allButton.addEventListener("click", () => boxes.forEach((box) => (box.checked = true)));
    noneButton.addEventListener("click", () => boxes.forEach((box) => (box.checked = false)));

    // 选项
    const options = document.createElement("div");
    options.className = "ldfc-snap-options";

    const formatLabel = document.createElement("label");
    formatLabel.textContent = "格式";
    const formatSelect = document.createElement("select");
    for (const value of ["png", "jpeg"]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.toUpperCase();
      option.selected = prefs.format === value;
      formatSelect.appendChild(option);
    }
    formatLabel.appendChild(formatSelect);

    const qrLabel = document.createElement("label");
    const qrBox = document.createElement("input");
    qrBox.type = "checkbox";
    qrBox.checked = prefs.qr;
    qrLabel.append(qrBox, document.createTextNode("二维码"));

    const wmLabel = document.createElement("label");
    const wmBox = document.createElement("input");
    wmBox.type = "checkbox";
    wmBox.checked = prefs.watermark;
    wmLabel.append(wmBox, document.createTextNode("水印"));

    const themeLabel = document.createElement("label");
    themeLabel.textContent = "主题";
    const themeSelect = document.createElement("select");
    for (const [value, text] of [
      ["auto", "跟随站点"],
      ["light", "浅色"],
      ["dark", "深色"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      option.selected = prefs.theme === value;
      themeSelect.appendChild(option);
    }
    themeLabel.appendChild(themeSelect);

    options.append(formatLabel, qrLabel, wmLabel, themeLabel);

    const hint = document.createElement("p");
    hint.className = "ldfc-snap-hint";
    hint.textContent =
      `勾选父楼会连同它下面的楼中楼一起截图；单张上限约 ${MAX_HEIGHT}px 高。`;

    const actions = document.createElement("div");
    actions.className = "ldfc-snap-actions";
    const generate = document.createElement("button");
    generate.type = "button";
    generate.className = "ldfc-snap-generate";
    generate.textContent = "生成快照";
    actions.appendChild(generate);

    panel.append(head, subtitle, floorBox, options, hint, actions);
    backdrop.appendChild(panel);

    const onKey = (event) => {
      if (event.key === "Escape") closePanel();
    };
    closeButton.addEventListener("click", closePanel);
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closePanel();
    });
    document.addEventListener("keydown", onKey);

    generate.addEventListener("click", async () => {
      const chosen = dropContained(posts.filter((post, index) => boxes[index].checked));
      if (!chosen.length) {
        toast("至少选择一层");
        return;
      }
      prefs = {
        format: formatSelect.value,
        qr: qrBox.checked,
        watermark: wmBox.checked,
        theme: themeSelect.value
      };
      savePrefs();

      const original = generate.textContent;
      generate.disabled = true;
      generate.textContent = "⏳ 生成中…";
      try {
        await onGenerate({
          posts: chosen,
          options: prefs
        });
        closePanel();
      } catch (error) {
        toast(`生成失败：${error?.message || error}`);
      } finally {
        generate.disabled = false;
        generate.textContent = original;
      }
    });

    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add("is-open"));
    return { backdrop, onKey };
  }

  async function open({ title, url, posts }) {
    const list = (posts || []).filter((post) => post?.node);
    if (!list.length) {
      toast("还没有可截图的楼层，等内容加载完再试");
      return;
    }
    await loadPrefs();
    closePanel();

    const api = window.LDFCPreviewExport;
    const stamp = api?.fileStamp?.() || "";
    const base = api?.safeName?.(title) || "linuxdo-topic";

    activePanel = buildPanel({
      title: title || "linuxdo-topic",
      url,
      posts: list,
      onGenerate: async ({ posts: chosen, options }) => {
        const canvas = await buildCanvas({ title, url, posts: chosen, options });
        const ext = options.format === "jpeg" ? "jpg" : "png";
        showResult(canvas, `${base}-${stamp}.${ext}`);
        // 结果窗自己带下载按钮；这里只提示已完成。
        toast("快照已生成，可在预览里下载");
      }
    });
  }

  window.LDFCSnapshot = { open, qrAvailable: () => Boolean(qrLib()) };
})();
