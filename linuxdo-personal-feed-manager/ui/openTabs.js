(() => {
  // 「一键打开文件夹里的全部链接」。三端三种通道，按能力降级：
  //   1. 扩展：走 background 的 tabs/windows API —— 逐个 create，不受弹窗拦截，
  //      还能指定开在新窗口（chrome.windows.create）；
  //   2. 油猴（含手机 TM）：GM_openInTab —— 同样不受弹窗拦截，只能开在标签栏；
  //   3. 兜底：window.open —— 第一个之后大概率被浏览器拦，返回值里如实报告。
  //
  // 只放行 linux.do 的链接：这个入口是给签到/批量打开帖子用的，
  // 不该变成"打开任意网页"的通道（后台那边也做了同样的校验）。
  const ALLOWED = /^https:\/\/linux\.do\//;

  function viaExtension(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response || null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function hasExtensionRuntime() {
    try {
      // 油猴页面也可能暴露一个空的 chrome 对象；有 runtime.id 才是真扩展上下文。
      return typeof chrome !== "undefined" && !!chrome?.runtime?.id && !!chrome.runtime.sendMessage;
    } catch {
      return false;
    }
  }

  async function open(urls, { newWindow = false } = {}) {
    const list = [...new Set((urls || []).filter((url) => typeof url === "string" && ALLOWED.test(url)))];
    if (!list.length) return { ok: false, opened: 0, total: 0, mode: "none" };

    if (hasExtensionRuntime()) {
      const response = await viaExtension({ type: "ldfc:open-tabs", urls: list, newWindow });
      if (response && response.ok) return response;
    }

    if (typeof GM_openInTab === "function") {
      let opened = 0;
      for (const url of list) {
        try {
          GM_openInTab(url, { active: false, insert: true, setParent: true });
          opened += 1;
        } catch {
          // 单个失败不中断
        }
      }
      return { ok: opened > 0, opened, total: list.length, mode: "userscript" };
    }

    let opened = 0;
    for (const url of list) {
      try {
        // 不能传 "noopener"：带这个特性时 window.open 规范上返回 null，
        // 会把已经打开的标签页误报成「被拦截」。打开后再断开 opener。
        const win = window.open(url, "_blank");
        if (win) {
          win.opener = null;
          opened += 1;
        }
      } catch {
        // 被拦截
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    return { ok: opened > 0, opened, total: list.length, mode: "window.open" };
  }

  window.LDFCOpenTabs = {
    open,
    // 只有扩展端能指定「开在新窗口」；油猴的 GM_openInTab 只能进当前窗口。
    supportsNewWindow: hasExtensionRuntime
  };
})();
