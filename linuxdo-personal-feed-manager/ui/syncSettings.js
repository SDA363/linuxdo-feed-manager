(() => {
  // 设置面板里的「云同步（WebDAV）」区块。
  //
  // 职责边界：
  //   - 这里只收集地址 / 账号 / 密码，写进本地 meta；
  //   - 真正发请求的是 background + syncService；
  //   - 域名授权走独立扩展页（content script 没有 chrome.permissions）。
  const ORIGIN_PATTERN = /^https?:\/\/[^/]+\/\*$/;

  let mounted = null;
  let focusBound = false;
  // 面板里"填了但还没保存"的草稿：只放内存。关掉面板再打开不会丢，
  // 但不会写进数据库（避免半截配置被当成"已配置"）。
  let draft = null;

  const service = () => window.LDFCSyncService;
  const namespace = () => window.LDFCIdentity.current().namespace;

  function toast(message) {
    window.LDFCToast?.show?.(message);
  }

  function send(message) {
    return new Promise((resolve, reject) => {
      const runtime = typeof chrome !== "undefined" ? chrome.runtime : null;
      if (!runtime?.id) {
        reject(new Error("当前环境没有扩展后台，无法配置云同步"));
        return;
      }

      runtime.sendMessage(message, (response) => {
        const lastError = runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "后台通信失败"));
          return;
        }
        resolve(response);
      });
    });
  }

  // 油猴脚本里没有扩展后台，跨域请求发不出去；这时不展示一套用不了的表单。
  function hasBackground() {
    return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
  }

  function sanitizeNamespace(value) {
    return String(value || "guest").replace(/[^A-Za-z0-9._-]/g, "_");
  }

  // 用户填目录（坚果云推荐）→ 自动补按账号区分的文件名；
  // 已经填了完整 .json 地址 → 原样使用（高级用法）。
  function resolveFileUrl(baseUrl, accountNamespace) {
    const raw = String(baseUrl ?? "").trim();
    if (!raw) return "";
    if (/\.json(?:[?#].*)?$/i.test(raw)) return raw;
    const withSlash = raw.endsWith("/") ? raw : `${raw}/`;
    return `${withSlash}ldfc-${sanitizeNamespace(accountNamespace)}.json`;
  }

  // 用户很容易把坚果云的"网页 / 分享链接"当成 WebDAV 地址：
  // # 后面的部分浏览器根本不会发给服务器，最后只会在同步时看到
  // "远端文件不是合法 JSON"。这里提前拦下来。
  function assertWebdavAddress(raw) {
    let host = "";
    try {
      host = new URL(raw).hostname.toLowerCase();
    } catch {
      throw new Error("地址格式不正确");
    }

    // 先判服务商：坚果云用户填错时，直接告诉他正确地址更省事。
    if (/(^|\.)jianguoyun\.com$/.test(host) && host !== "dav.jianguoyun.com") {
      throw new Error("坚果云 WebDAV 地址应为 https://dav.jianguoyun.com/dav/");
    }

    if (raw.includes("#")) {
      throw new Error("请填 WebDAV 地址，不要填带 # 的网页或分享链接");
    }
  }

  function originPatternFor(url) {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("只支持 http / https 地址");
    }
    // Chrome 的权限匹配模式不含端口，填端口反而会让 contains() 判定失败。
    return `${parsed.protocol}//${parsed.hostname}/*`;
  }

  async function checkPermission(fileUrl) {
    if (!fileUrl) return false;
    const pattern = originPatternFor(fileUrl);
    if (!ORIGIN_PATTERN.test(pattern)) return false;
    const response = await send({ type: "ldfc:check-permission", origins: [pattern] });
    return Boolean(response?.granted);
  }

  async function openPermissionPage(fileUrl) {
    const pattern = originPatternFor(fileUrl);
    const response = await send({ type: "ldfc:open-permission-page", origin: pattern });
    if (!response?.ok) throw new Error(response?.error || "无法打开授权页");
    return pattern;
  }

  function buildTransport(webdav, accountNamespace) {
    if (!webdav?.url) return null;
    return window.LDFCWebDAV.createTransport({
      url: resolveFileUrl(webdav.url, accountNamespace),
      username: webdav.username ?? "",
      password: webdav.password ?? ""
    });
  }

  // 用已保存的配置恢复 transport；打开站点时的 pullOnce 依赖它。
  function applyStoredTransport() {
    const config = service().getConfig();
    if (config?.backend !== "webdav" || !config?.webdav?.url) {
      service().configureTransport(null);
      return config;
    }

    try {
      service().configureTransport(buildTransport(config.webdav, namespace()));
    } catch {
      service().configureTransport(null);
    }
    return config;
  }

  async function init() {
    await service().init();
    return applyStoredTransport();
  }

  function field(id, labelText, type, placeholder, value) {
    const wrapper = document.createElement("div");
    wrapper.className = "ldfc-sync-field";

    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = labelText;

    const input = document.createElement("input");
    input.id = id;
    input.type = type;
    input.placeholder = placeholder;
    input.value = value ?? "";
    input.autocomplete = type === "password" ? "off" : "username";

    wrapper.append(label, input);
    return { wrapper, input };
  }

  function actionButton(id, label, handler) {
    const element = document.createElement("button");
    element.type = "button";
    element.id = id;
    element.textContent = label;
    element.addEventListener("click", handler);
    return element;
  }

  function reasonText(result) {
    const failure = [result?.push, result?.pull].find((item) => item && item.ok === false);
    if (!failure) return "未知原因";
    if (failure.reason === "permission") return "尚未授权访问该域名";
    if (failure.reason === "auth") return "账号或应用密码不正确";
    if (failure.reason === "network") return "网络不可达，或地址填写有误";
    if (failure.reason === "no-transport") return "还没有保存 WebDAV 配置";
    return failure.error || failure.reason || "同步失败";
  }

  async function mount(container) {
    if (!container) return;
    container.innerHTML = "";

    if (!hasBackground()) {
      const unavailable = document.createElement("section");
      unavailable.className = "ldfc-sync-section";
      const unavailableTitle = document.createElement("h3");
      unavailableTitle.textContent = "云同步（WebDAV）";
      const unavailableNote = document.createElement("p");
      unavailableNote.className = "ldfc-sync-note";
      unavailableNote.textContent =
        "当前环境（油猴脚本）没有扩展后台，无法跨域访问 WebDAV，云同步仅在浏览器扩展版可用。本地数据与手动 JSON 导出/导入不受影响。";
      unavailable.append(unavailableTitle, unavailableNote);
      container.appendChild(unavailable);
      mounted = unavailable;
      return;
    }

    const section = document.createElement("section");
    section.className = "ldfc-sync-section";

    const title = document.createElement("h3");
    title.textContent = "云同步（WebDAV）";

    // 问号按钮：展开「怎么绑坚果云」的分步说明。
    // 新手最容易错的两处是「填了浏览器地址栏的链接」和「填了登录密码」，
    // 所以这两条单独强调。
    const titleRow = document.createElement("div");
    titleRow.className = "ldfc-sync-title-row";

    const helpButton = document.createElement("button");
    helpButton.type = "button";
    helpButton.id = "ldfc-sync-help-toggle";
    helpButton.className = "ldfc-sync-help-btn";
    helpButton.textContent = "?";
    helpButton.title = "坚果云绑定说明";
    helpButton.setAttribute("aria-expanded", "false");
    helpButton.setAttribute("aria-controls", "ldfc-sync-help");
    titleRow.append(title, helpButton);

    const help = document.createElement("div");
    help.id = "ldfc-sync-help";
    help.className = "ldfc-sync-help";
    help.hidden = true;

    const HELP_STEPS = [
      [
        "1. 注册坚果云",
        "打开 jianguoyun.com 注册并登录。免费账户就够用，本插件只会写入一个几百 KB 的 JSON。"
      ],
      [
        "2. 建一个同步目录",
        "在「我的文件」里新建一个文件夹，例如 linuxdo。这个目录只放本插件的同步文件，便于单独备份或清理。"
      ],
      [
        "3. 填 WebDAV 地址（填目录）",
        "格式是 https://dav.jianguoyun.com/dav/<目录名>/，例如 https://dav.jianguoyun.com/dav/linuxdo/。注意域名是 dav.jianguoyun.com —— 不要直接复制浏览器地址栏里 www.jianguoyun.com/#/... 那种链接。"
      ],
      [
        "4. 账号填登录邮箱",
        "就是注册坚果云时用的邮箱。"
      ],
      [
        "5. 应用密码 ≠ 登录密码",
        "在坚果云网页版或客户端里找「账户设置 → 安全选项 → 应用密码 / 第三方应用」，添加一个应用后复制生成的密码。它通常只显示一次，关掉就看不到了。"
      ],
      [
        "6. 授权 → 测试 → 保存",
        "填完点「授权访问此域名」→「测试连接」→「保存配置」。另一台设备填同一份配置，打开站点就会自动拉取并合并。"
      ]
    ];

    for (const [heading, text] of HELP_STEPS) {
      const step = document.createElement("div");
      step.className = "ldfc-sync-help-step";
      const stepTitle = document.createElement("strong");
      stepTitle.textContent = heading;
      const stepText = document.createElement("span");
      stepText.textContent = text;
      step.append(stepTitle, stepText);
      help.appendChild(step);
    }

    const helpNote = document.createElement("p");
    helpNote.className = "ldfc-sync-note";
    helpNote.textContent =
      "同步文件按 Linux.do 账号区分（ldfc-<账号>.json）：两台设备必须登录同一个 Linux.do 账号，状态才会合并到同一份文件。";
    help.appendChild(helpNote);

    helpButton.addEventListener("click", () => {
      help.hidden = !help.hidden;
      helpButton.setAttribute("aria-expanded", String(!help.hidden));
    });

    const description = document.createElement("p");
    description.className = "ldfc-sync-note";
    description.textContent =
      "启用后，归属状态、标题与时间戳会写入你自己的网盘；帖子正文预览不同步。不使用云同步时，一切仍只保存在本地。";

    const autoLabel = document.createElement("label");
    autoLabel.className = "ldfc-sync-check";
    const autoInput = document.createElement("input");
    autoInput.type = "checkbox";
    autoInput.id = "ldfc-sync-auto";
    autoLabel.append(autoInput, document.createTextNode(" 开启自动同步（打开站点拉取一次；标记后 10 秒推送）"));

    const urlField = field(
      "ldfc-sync-url",
      "WebDAV 地址（坚果云填目录）",
      "url",
      "https://dav.jianguoyun.com/dav/",
      ""
    );

    // 地址错误就在输入框下面直接说，不要等用户点了「保存配置」才弹 toast。
    const urlError = document.createElement("p");
    urlError.className = "ldfc-sync-field-error";
    urlError.id = "ldfc-sync-url-error";
    urlError.hidden = true;
    urlField.wrapper.append(urlError);

    function validateUrlField({ showEmpty = false } = {}) {
      const raw = urlField.input.value.trim();
      let message = "";
      if (!raw) {
        if (showEmpty) message = "请填写 WebDAV 地址";
      } else if (!/^https?:\/\//i.test(raw)) {
        message = "地址必须以 http:// 或 https:// 开头";
      } else {
        try {
          assertWebdavAddress(raw);
        } catch (error) {
          message = error.message;
        }
      }

      urlError.textContent = message;
      urlError.hidden = !message;
      urlField.wrapper.dataset.invalid = message ? "true" : "";
      if (message) urlField.input.setAttribute("aria-invalid", "true");
      else urlField.input.removeAttribute("aria-invalid");
      return !message;
    }

    urlField.input.addEventListener("input", () => validateUrlField());
    urlField.input.addEventListener("blur", () => validateUrlField({ showEmpty: true }));

    const userField = field("ldfc-sync-username", "账号", "text", "坚果云登录邮箱", "");
    const passwordField = field("ldfc-sync-password", "应用密码", "password", "不是登录密码", "");

    // 让用户一眼看到"这次到底读写的哪个文件"，两台设备对不上时不用去网盘猜。
    const fileLabel = document.createElement("p");
    fileLabel.className = "ldfc-sync-note";
    fileLabel.id = "ldfc-sync-file";
    fileLabel.textContent = "同步文件：等待填写地址";

    const accountHint = document.createElement("p");
    accountHint.className = "ldfc-sync-note";
    accountHint.id = "ldfc-sync-account-hint";
    accountHint.textContent = "账号通常是完整邮箱（例如 you@example.com）；服务商不用邮箱登录时忽略此提示。";

    const hint = document.createElement("p");
    hint.className = "ldfc-sync-note";
    hint.textContent =
      "填目录时会自动生成按账号区分的文件名（ldfc-<账号>.json）。凭据仅保存在本地 IndexedDB（明文），请勿在公用电脑使用。";

    const status = document.createElement("p");
    status.className = "ldfc-sync-status";
    status.id = "ldfc-sync-status";
    status.textContent = "状态：等待配置";

    const last = document.createElement("p");
    last.className = "ldfc-sync-status";
    last.id = "ldfc-sync-last";
    last.textContent = "上次同步：尚未同步";

    const permission = document.createElement("p");
    permission.className = "ldfc-sync-status";
    permission.id = "ldfc-sync-permission";
    permission.textContent = "域名权限：等待填写地址";

    const actions = document.createElement("div");
    actions.className = "ldfc-settings-actions";

    async function saveConfig({ silent = false } = {}) {
      const base = urlField.input.value.trim();
      if (!validateUrlField({ showEmpty: true })) {
        urlField.input.focus();
        throw new Error(urlError.textContent || "请检查 WebDAV 地址");
      }

      const username = userField.input.value.trim();
      if (!username) throw new Error("请填写账号");

      // 应用密码是从网页/客户端复制来的，容易带尾部空格或换行。
      const password = passwordField.input.value.trim();

      await service().updateConfig({
        backend: "webdav",
        webdav: {
          url: base,
          username,
          password
        }
      });
      draft = null;
      applyStoredTransport();

      if (!silent) toast("云同步配置已保存");
      await refresh();
      return resolveFileUrl(base, namespace());
    }

    function rememberDraft() {
      draft = {
        url: urlField.input.value,
        username: userField.input.value,
        password: passwordField.input.value
      };
    }

    function updateFileLabel() {
      const fileUrl = resolveFileUrl(urlField.input.value, namespace());
      fileLabel.textContent = fileUrl
        ? `同步文件：${fileUrl.split("/").pop() || fileUrl}`
        : "同步文件：等待填写地址";
    }

    function updateAccountHint() {
      const value = userField.input.value.trim();
      accountHint.hidden = !value || value.includes("@");
    }

    async function refresh() {
      if (!mounted) return;

      const config = service().getConfig();
      autoInput.checked = config.autoSync !== false;

      const state = service().getStatus();
      last.textContent = state.lastSyncAt
        ? `上次同步：${new Date(state.lastSyncAt).toLocaleString()}`
        : "上次同步：尚未同步";

      let text = "状态：空闲";
      if (state.state === "syncing") text = "状态：同步中…";
      else if (state.lastError) text = `状态：失败 — ${state.lastError}`;
      else if (state.lastSyncAt) text = "状态：已同步";
      else if (config.backend === "webdav") text = "状态：已配置，尚未同步";

      if (state.stats) {
        text += `（新增 ${state.stats.added}，更新 ${state.stats.updated}，删除 ${state.stats.removed}）`;
      }
      status.textContent = text;

      const fileUrl = resolveFileUrl(urlField.input.value, namespace());
      updateFileLabel();
      if (!fileUrl) {
        permission.textContent = "域名权限：等待填写地址";
        return;
      }

      try {
        const granted = await checkPermission(fileUrl);
        permission.textContent = granted ? "域名权限：已授权" : "域名权限：未授权";
      } catch {
        permission.textContent = "域名权限：无法检查";
      }
    }

    actions.append(
      actionButton("ldfc-sync-save", "保存配置", async () => {
        try {
          await saveConfig();
        } catch (error) {
          toast(error.message);
        }
      }),
      actionButton("ldfc-sync-test", "测试连接", async () => {
        try {
          const fileUrl = await saveConfig({ silent: true });
          if (!(await checkPermission(fileUrl))) {
            toast("请先点「授权访问此域名」");
            return;
          }

          const transport = window.LDFCWebDAV.createTransport({
            url: fileUrl,
            username: userField.input.value.trim(),
            password: passwordField.input.value.trim()
          });
          const result = await transport.test();
          const name = fileUrl.split("/").pop() || fileUrl;
          toast(
            result.exists
              ? `连接成功，远端已有同步文件（${name}）`
              : `连接成功，远端还没有文件（${name}）`
          );
        } catch (error) {
          toast(`连接失败：${error.message}`);
        }
        await refresh();
      }),
      actionButton("ldfc-sync-now", "立即同步", async () => {
        try {
          const fileUrl = await saveConfig({ silent: true });
          if (!(await checkPermission(fileUrl))) {
            toast("请先点「授权访问此域名」");
            return;
          }

          const result = await service().syncNow();
          // 同步会改本地内存状态，但列表/计数不会自己重画；
          // 不刷新的话用户会以为"没拉到"。
          window.LDFCRefreshAfterSync?.();
          if (result.ok) {
            const stats = result.push?.stats ?? result.pull?.stats ?? { added: 0, updated: 0, removed: 0 };
            toast(`同步完成：新增 ${stats.added}，更新 ${stats.updated}，删除 ${stats.removed}`);
          } else {
            toast(`同步失败：${reasonText(result)}`);
          }
        } catch (error) {
          toast(`同步失败：${error.message}`);
        }
        await refresh();
      }),
      actionButton("ldfc-sync-authorize", "授权访问此域名", async () => {
        try {
          await saveConfig({ silent: true });
          const fileUrl = resolveFileUrl(urlField.input.value, namespace());
          if (!fileUrl) throw new Error("请先填写 WebDAV 地址");
          await openPermissionPage(fileUrl);
          toast("已打开授权页，请在新标签页点「允许访问」");
        } catch (error) {
          toast(error.message);
        }
        await refresh();
      }),
      actionButton("ldfc-sync-clear", "清除本地凭据", async () => {
        const confirmed = window.confirm(
          "确定清除本地保存的 WebDAV 地址与凭据？\n\n远端同步文件不会被删除。"
        );
        if (!confirmed) return;

        try {
          service().cancelScheduledPush();
          await service().updateConfig({ backend: "none", webdav: null });
          service().configureTransport(null);
          draft = null;
          urlField.input.value = "";
          userField.input.value = "";
          passwordField.input.value = "";
          toast("已清除本地保存的 WebDAV 凭据");
        } catch (error) {
          toast(`清除失败：${error.message}`);
        }
        await refresh();
      })
    );

    autoInput.addEventListener("change", async () => {
      try {
        await service().setAutoSync(autoInput.checked);
        toast(autoInput.checked ? "已开启自动同步" : "已关闭自动同步");
      } catch (error) {
        toast(`设置失败：${error.message}`);
      }
      await refresh();
    });

    section.append(
      titleRow,
      description,
      help,
      autoLabel,
      urlField.wrapper,
      fileLabel,
      userField.wrapper,
      accountHint,
      passwordField.wrapper,
      hint,
      actions,
      status,
      last,
      permission
    );
    container.appendChild(section);
    mounted = section;

    let config = { autoSync: true };
    try {
      config = await init();
    } catch (error) {
      status.textContent = `云同步不可用：${error.message}`;
    }

    // 草稿优先：用户填了但没点按钮，关掉面板再打开时不至于"被清空"。
    const webdav = draft ?? config?.webdav ?? {};
    urlField.input.value = webdav.url ?? "";
    userField.input.value = webdav.username ?? "";
    passwordField.input.value = webdav.password ?? "";
    autoInput.checked = config?.autoSync !== false;
    updateFileLabel();
    updateAccountHint();

    for (const input of [urlField.input, userField.input, passwordField.input]) {
      input.addEventListener("input", () => {
        rememberDraft();
        updateFileLabel();
        updateAccountHint();
      });
    }

    if (!focusBound) {
      focusBound = true;
      // 授权页是新标签；用户切回来时自动刷新权限状态。
      window.addEventListener("focus", () => {
        if (mounted?.isConnected) refresh().catch(() => {});
      });
    }

    await refresh().catch(() => {});
  }

  window.LDFCSyncSettings = {
    assertWebdavAddress,
    init,
    mount,
    originPatternFor,
    resolveFileUrl
  };
})();
