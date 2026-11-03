(() => {
  // 预览窗的「保存到本地 / 保存为图片」。
  //
  // 行为对齐用户提供的「linux.do 小助手」脚本：保存的是**主贴（1 楼）**，
  // 不是整个预览列表。原因有两个：
  //   1. 参考脚本挂在 .cooked 上，本来就是存一楼；
  //   2. 几百楼的帖子整段丢给 html2canvas，会超出画布尺寸上限并卡死页面。
  //
  // html2canvas 走本地 vendor（MIT，v1.4.1），不引 CDN：
  // Chrome 扩展不允许远程代码，油猴版也不该为截图多依赖一个外网。
  const IMAGE_WAIT_MS = 3000;

  // 只清掉纯操作性的节点；正文里的 boost 列表等内容保留。
  const NOISE_SELECTORS = [
    ".ldp-actions",
    ".ldp-boost-input-wrap",
    ".ldp-sub-loading",
    ".ldp-loadmask",
    ".ldfc-preview-dock",
    "ldfc-preview-dock",
    // 真实帖子页保存时，首楼 .cooked 里会带着我们自己的按钮行
    ".ldfc-reader-actions",
    "ldfc-reader-actions",
    ".ldfc-topic-actions-row",
    // 第三方「小助手」的按钮容器（如果也装了）
    ".save-buttons-container",
    // 真实帖子页：站点自带的楼层操作区 / 点赞 / 引用条，截图里都是噪声
    ".post-actions",
    ".post-menu-area",
    ".topic-post > .topic-avatar",
    ".who-liked",
    ".post-notice",
    ".ldfc-snap-backdrop"
  ];

  function escapeHtml(text) {
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function fileStamp() {
    const now = new Date();
    return (
      `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
      `-${pad(now.getHours())}${pad(now.getMinutes())}`
    );
  }

  function safeName(title) {
    const cleaned = String(title || "linuxdo-topic")
      .replace(/[\\/:*?"<>|]/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 80);
    return cleaned || "linuxdo-topic";
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // 立刻 revoke 在部分浏览器上会打断下载，留一段时间。
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // 预览窗里的主贴正文节点：引擎是 .ldp-topic > .ldp-post > .ldp-content，
  // 兜底窗是 .ldfc-pv-post > .ldfc-pv-body。
  function opRoot(overlay) {
    const op =
      overlay?.querySelector(".ldp-topic > .ldp-post") ??
      overlay?.querySelector(".ldfc-pv-post");
    return op?.querySelector(".ldp-content") ?? op?.querySelector(".ldfc-pv-body") ?? null;
  }

  function cleanClone(node) {
    const clone = node.cloneNode(true);
    for (const selector of NOISE_SELECTORS) {
      clone.querySelectorAll(selector).forEach((element) => element.remove());
    }
    // 离屏容器里的图片不会被懒加载触发，必须改回 eager 才能等到 onload。
    clone.querySelectorAll("img").forEach((img) => {
      img.loading = "eager";
      img.decoding = "sync";
    });
    return clone;
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("读取图片失败"));
      reader.readAsDataURL(blob);
    });
  }

  // 导出的 HTML 要在断网时也能看，所以图片全部内联成 base64。
  async function inlineImages(root) {
    const images = [...root.querySelectorAll("img")];
    await Promise.all(
      images.map(async (img) => {
        const src = img.getAttribute("src") || "";
        if (!src || src.startsWith("data:")) return;
        try {
          const response = await fetch(src, { credentials: "include" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          img.setAttribute("src", await blobToDataUrl(await response.blob()));
        } catch {
          img.removeAttribute("src");
          img.setAttribute("alt", "[图片保存失败]");
        }
      })
    );
  }

  function waitImages(root) {
    const images = [...root.querySelectorAll("img")];
    return Promise.all(
      images.map(
        (img) =>
          new Promise((resolve) => {
            if (img.complete && img.naturalWidth > 0) return resolve();
            const timer = setTimeout(resolve, IMAGE_WAIT_MS);
            const done = () => {
              clearTimeout(timer);
              resolve();
            };
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
          })
      )
    );
  }

  function setBusy(button, text) {
    if (!button) return () => {};
    const original = button.textContent;
    button.textContent = text;
    button.disabled = true;
    return () => {
      button.textContent = original;
      button.disabled = false;
    };
  }

  async function saveHtml({ title, url, root, button }) {
    if (!root) throw new Error("还没有拿到主贴内容，等预览加载完再试");

    const restore = setBusy(button, "⏳ 保存中…");
    try {
      const clone = cleanClone(root);
      await inlineImages(clone);

      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; padding: 24px; background: #fff; color: #222;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  .post-content { max-width: 800px; margin: 0 auto; font-size: 16px; line-height: 1.8; }
  h1 { font-size: 24px; line-height: 1.4; margin: 0 0 20px; padding-bottom: 15px; border-bottom: 2px solid #e0e0e0; }
  img { max-width: 100%; height: auto; }
  pre { overflow: auto; }
  .ldp-boost-input-wrap, .ldp-actions { display: none; }
  .ldfc-source { margin-top: 24px; padding-top: 12px; border-top: 1px solid #e0e0e0;
    font-size: 12px; color: #999; text-align: right; }
</style>
</head>
<body>
  <div class="post-content">
    <h1>${escapeHtml(title)}</h1>
    ${clone.innerHTML}
    <div class="ldfc-source">来源：${escapeHtml(url)}</div>
  </div>
</body>
</html>`;

      download(new Blob([html], { type: "text/html;charset=utf-8" }), `${safeName(title)}.html`);
      window.LDFCToast?.show?.(`已保存 ${safeName(title)}.html`);
      return true;
    } finally {
      restore();
    }
  }

  async function saveImage({ title, url, root, button }) {
    if (!root) throw new Error("还没有拿到主贴内容，等预览加载完再试");

    const lib = window.html2canvas;
    if (typeof lib !== "function") throw new Error("html2canvas 未加载，请刷新页面");

    const restore = setBusy(button, "⏳ 生成图片中…");
    const holder = document.createElement("div");
    holder.setAttribute("data-ldfc-export", "image");
    holder.style.cssText =
      "position:fixed;left:-10000px;top:0;width:800px;padding:30px;background:#fff;color:#222;" +
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;';

    const heading = document.createElement("h1");
    heading.textContent = title;
    heading.style.cssText =
      "margin:0 0 20px;padding-bottom:15px;border-bottom:2px solid #e0e0e0;" +
      "font-size:24px;color:#333;word-wrap:break-word;";

    const body = cleanClone(root);
    body.style.cssText = "font-size:16px;line-height:1.8;color:#333;";

    const source = document.createElement("div");
    source.textContent = `来源：${url}`;
    source.style.cssText =
      "margin-top:20px;padding-top:15px;border-top:1px solid #e0e0e0;" +
      "font-size:12px;color:#999;text-align:right;";

    holder.append(heading, body, source);

    try {
      document.body.appendChild(holder);
      await waitImages(holder);
      const canvas = await lib(holder, {
        scale: 2,
        useCORS: true,
        backgroundColor: "#ffffff",
        logging: false
      });
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("生成 PNG 失败");
      download(blob, `${safeName(title)}.png`);
      window.LDFCToast?.show?.(`已保存 ${safeName(title)}.png`);
      return true;
    } finally {
      holder.remove();
      restore();
    }
  }

  window.LDFCPreviewExport = {
    saveHtml,
    saveImage,
    opRoot,
    // 供「生成快照」复用：同一套清理/等图/下载逻辑，避免两份实现漂移。
    cleanClone,
    waitImages,
    download,
    safeName,
    fileStamp
  };
})();
