(() => {
  const POOL_NAMES = ["HOME", "INTERESTED", "READ", "DISMISSED"];

  const CLEAR_TARGETS = [
    { pool: "INTERESTED", label: "感兴趣" },
    { pool: "READ", label: "已读" },
    { pool: "DISMISSED", label: "不感兴趣" }
  ];

  let panel;
  let initialized = false;
  let onboardingPrompted = false;

  function button(label, onClick) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = label;
    element.addEventListener("click", onClick);
    return element;
  }

  // 面板占了右半屏，必须自带关闭入口：
  // 只靠左下角导航栏的 ⚙ 再点一次，一旦导航栏被遮挡或窗口很窄就完全卡死。
  function closeButton() {
    const element = button("×", () => toggle());
    element.id = "ldfc-settings-close";
    element.className = "ldfc-settings-close";
    element.title = "关闭设置";
    element.setAttribute("aria-label", "关闭设置");
    return element;
  }

  // 标题行的「固定」开关。默认不固定：点面板外部就关，手机上一伸手就能退出；
  // 按下固定后点外面不关，方便一边看列表一边对照设置。
  // 每次重新打开都会回到未固定（见 toggle）。
  function pinButton() {
    const element = button("", () => {
      const sheet = document.getElementById("ldfc-settings");
      const pinned = sheet?.dataset.pinned === "true";
      if (sheet) sheet.dataset.pinned = String(!pinned);
      element.setAttribute("aria-pressed", String(!pinned));
      element.title = pinned ? "固定面板（点外面不会关闭）" : "已固定：点外面不会关闭";
    });
    element.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 3.5h7"/><path d="M9.8 3.5v6.1L7 14.2h10l-2.8-4.6V3.5"/><path d="M12 14.2V21"/></svg>';
    element.id = "ldfc-settings-pin";
    element.className = "ldfc-sheet-pin";
    element.title = "固定面板（点外面不会关闭）";
    element.setAttribute("aria-label", "固定面板");
    element.setAttribute("aria-pressed", "false");
    return element;
  }

  function panelHeader(text) {
    const header = document.createElement("div");
    header.className = "ldfc-settings-header";
    const title = document.createElement("h2");
    title.textContent = text;
    const tools = document.createElement("div");
    tools.className = "ldfc-sheet-tools";
    tools.append(pinButton(), closeButton());
    header.append(title, tools);
    return header;
  }

  function exportButton() {
    return button("导出 JSON", async () => {
      const records = await window.LDFCDB.getAllTopics();
      const tombstones = await window.LDFCDB.getTombstones();
      const payload = {
        version: 1,
        exportedAt: new Date().toISOString(),
        // 导出内容只含归属状态和时间戳，不含帖子正文、Cookie、Token。
        topics: records.map((record) => ({
          topicId: record.topicId,
          basePool: record.basePool,
          inNewReply: record.inNewReply,
          createdAt: record.createdAt,
          enteredPoolAt: record.enteredPoolAt,
          updatedAt: record.updatedAt
        })),
        // 删除墓碑：少了它，换一台机器导入后"已经清理掉的记录"会复活。
        tombstones: tombstones.map((item) => ({
          topicId: item.topicId,
          deletedAt: item.deletedAt
        }))
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = `ldfc-backup-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }

  function importButton() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.hidden = true;

    input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;

      try {
        const payload = JSON.parse(await file.text());
        if (payload?.version !== 1 || !Array.isArray(payload.topics)) {
          throw new Error("invalid");
        }

        let imported = 0;

        for (const item of payload.topics) {
          const topicId = String(item.topicId ?? "");
          // 逐条校验：格式不对就跳过这一条，绝不让坏数据破坏现有状态。
          if (!/^\d+$/.test(topicId) || !POOL_NAMES.includes(item.basePool)) continue;

          await window.LDFCTopicState.setPool(topicId, item.basePool, {
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            enteredPoolAt: item.enteredPoolAt,
            inNewReply: Boolean(item.inNewReply)
          });
          imported += 1;
        }

        // 墓碑必须按"删除时间 vs 记录时间"比较：导入一份旧备份时，
        // 不能把之后重新标记过的 Topic 又删掉。所以这一轮必须放在 topics 之后。
        let tombstoned = 0;
        let stateChanged = false;

        for (const item of payload.tombstones ?? []) {
          const topicId = String(item?.topicId ?? "");
          const deletedAt = Number(item?.deletedAt);
          if (!/^\d+$/.test(topicId) || !Number.isFinite(deletedAt)) continue;

          const existing = window.LDFCTopicState.get(topicId);
          if (existing && (existing.updatedAt || 0) > deletedAt) continue;

          await window.LDFCDB.putTombstone({ topicId, deletedAt });
          if (existing) {
            await window.LDFCDB.deleteTopic(topicId);
            stateChanged = true;
          }
          tombstoned += 1;
        }

        if (stateChanged) await window.LDFCTopicState.load();
        window.LDFCSyncService?.schedulePush?.();

        window.LDFCToast.show(
          tombstoned ? `导入完成：${imported} 条（墓碑 ${tombstoned} 条）` : `导入完成：${imported} 条`
        );
        window.LDFCNavigation.render();
        window.LDFCFilter.applyRows();
      } catch {
        window.LDFCToast.show("导入失败：JSON 格式不正确");
      } finally {
        input.value = "";
      }
    });

    return button("导入 JSON", () => input.click());
  }

  // 按池清理：只删本地记录，不动 Linux.do 上的任何内容。
  function poolClearButton(target) {
    return button(`清理${target.label}`, async () => {
      const count = window.LDFCTopicState.listByPool(target.pool).length;
      if (!count) {
        window.LDFCToast.show(`「${target.label}」里没有本地记录`);
        return;
      }

      const confirmed = window.confirm(
        `确定清理「${target.label}」中的 ${count} 条本地记录？\n\n` +
          "这不会删除 Linux.do 上的任何帖子，清理的只是扩展自己的本地数据库。\n" +
          "清理后，这些 Topic 下次出现在列表时会被重新视为「主信息流」的未处理内容。"
      );
      if (!confirmed) return;

      const removed = await window.LDFCDB.deleteTopicsByPool(target.pool);
      await window.LDFCTopicState.load();
      window.LDFCSyncService?.schedulePush?.();
      window.LDFCNavigation.render();
      window.LDFCFilter.applyRows();
      window.LDFCPoolPanel.render(window.LDFCFilter.getActivePool());
      window.LDFCToast.show(`已清理 ${removed} 条本地记录`);
    });
  }

  function clearAllButton() {
    return button("清理全部", async () => {
      const total = (await window.LDFCDB.getAllTopics()).length;
      if (!total) {
        window.LDFCToast.show("本地没有记录可清理");
        return;
      }

      const confirmed = window.confirm(
        `确定清理全部 ${total} 条本地记录？此操作不可撤销。\n\n` +
          "这不会删除 Linux.do 上的任何帖子。"
      );
      if (!confirmed) return;

      await window.LDFCDB.clearTopics();
      await window.LDFCTopicState.clearVisits();
      await window.LDFCTopicState.load();
      window.LDFCSyncService?.schedulePush?.();
      window.LDFCNavigation.render();
      window.LDFCFilter.applyRows();
      window.LDFCPoolPanel.render(window.LDFCFilter.getActivePool());
      window.LDFCToast.show("本地数据已清空");
    });
  }

  // 向导 B：用 Linux.do 当前的阅读状态初始化。
  // 这是用户显式选择的，和默认的 A 不同 —— A 绝不猜测任何历史。
  async function initializeFromDiscourse() {
    const [latestTopics, unreadTopics] = await Promise.all([
      window.LDFCDiscourseAdapter.fetchLatestList(),
      window.LDFCDiscourseAdapter.fetchUnreadList()
    ]);

    if (!latestTopics) {
      window.LDFCToast.show("读不到 Linux.do 阅读状态，请先登录再试");
      return false;
    }

    const readTopics = latestTopics.filter(
      (topic) => topic.lastReadPostNumber !== null && topic.lastReadPostNumber !== undefined
    );

    if (!readTopics.length) {
      window.LDFCToast.show("当前列表没有已读记录，可能未识别到账号；已按“从今天开始记录”处理");
      return false;
    }

    for (const topic of readTopics) {
      await window.LDFCTopicState.setPool(topic.topicId, "READ", topic);
    }

    // 原站未读列表里的 Topic 归入「已读 + 待处理新回复」，和后续同步口径一致。
    if (unreadTopics) {
      for (const topic of unreadTopics) {
        await window.LDFCTopicState.setPool(topic.topicId, "READ", topic);
        await window.LDFCTopicState.markNewReply(topic.topicId, topic);
      }
    }

    window.LDFCSyncService?.schedulePush?.();
    window.LDFCToast.show(`已按原站阅读状态初始化 ${readTopics.length} 条`);
    return true;
  }

  function renderOnboarding() {
    const description = document.createElement("p");
    description.textContent = "选择插件开始记录的方式：";

    const choices = [
      {
        value: "A",
        label: "A｜从今天开始记录（推荐）",
        description: "安装前打开过的历史主题不会被猜测，安装后打开 Topic 才会记入已读。"
      },
      {
        value: "B",
        label: "B｜按 Linux.do 当前阅读状态初始化",
        description: "读取原站已有的已读 / 未读状态，一次性建立初始信息池。需要已登录。"
      },
      {
        value: "C",
        label: "C｜当前 Topic 全部视为未处理",
        description: "不做任何标记，所有已加载主题都留在主信息流，等同从零开始。"
      }
    ];

    const list = document.createElement("div");
    list.className = "ldfc-onboarding-list";

    for (const choice of choices) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "ldfc-onboarding-card";
      card.innerHTML = `<strong>${choice.label}</strong><span>${choice.description}</span>`;

      card.addEventListener("click", async () => {
        if (choice.value === "B") {
          const ok = await initializeFromDiscourse();
          if (!ok) return;
        }

        await window.LDFCDB.putMeta("initialized", true);
        await window.LDFCDB.putMeta("installMode", choice.value);
        initialized = true;
        render();
        window.LDFCNavigation.render();
        window.LDFCFilter.applyRows();
      });

      list.appendChild(card);
    }

    panel.innerHTML = "";
    panel.append(panelHeader("首次安装"), description, list);
  }

  const NOTIFY_POOL_LABEL = { INTERESTED: "感兴趣", READ: "已读", DISMISSED: "不感兴趣" };
  const NOTIFY_MAP_OPTIONS = [
    ["", "不修改"],
    ["3", "关注"],
    ["2", "跟踪"],
    ["1", "常规"],
    ["0", "免打扰"]
  ];

  function notifyToggleRow(id, labelText, checked, onChange) {
    const label = document.createElement("label");
    label.className = "ldfc-preview-toggle";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.checked = Boolean(checked);
    input.addEventListener("change", () => onChange(input.checked));
    const text = document.createElement("span");
    text.textContent = labelText;
    label.append(input, text);
    return label;
  }

  function notifyMappingRow(pool, value) {
    const row = document.createElement("label");
    row.className = "ldfc-notify-map";

    const name = document.createElement("span");
    name.textContent = NOTIFY_POOL_LABEL[pool];

    const select = document.createElement("select");
    select.id = `ldfc-notify-map-${pool.toLowerCase()}`;
    for (const [level, label] of NOTIFY_MAP_OPTIONS) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = typeof value === "number" ? String(value) : "";
    select.addEventListener("change", () => {
      const next = select.value === "" ? null : Number(select.value);
      window.LDFCNotify?.setSettings?.({ map: { [pool]: next } });
    });

    row.append(name, select);
    return row;
  }

  // 自动已读的独立档位：默认「不修改」，避免读一篇就顺手改站点通知。
  function notifyAutoReadRow(value) {
    const row = document.createElement("label");
    row.className = "ldfc-notify-map";

    const name = document.createElement("span");
    name.textContent = "自动已读时";

    const select = document.createElement("select");
    select.id = "ldfc-notify-auto-read";
    for (const [level, label] of NOTIFY_MAP_OPTIONS) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = typeof value === "number" ? String(value) : "";
    select.addEventListener("change", () => {
      const next = select.value === "" ? null : Number(select.value);
      window.LDFCNotify?.setSettings?.({ autoReadLevel: next });
    });

    row.append(name, select);
    return row;
  }

  function renderSettings() {
    panel.innerHTML = "";

    const identity = window.LDFCIdentity.current();
    const account = document.createElement("p");
    account.className = "ldfc-account";
    account.textContent = identity.loggedIn
      ? `当前账号：${identity.username || identity.namespace}。本地数据按账号独立保存，切换账号不会互相污染。`
      : "当前未登录：数据保存在独立的 guest 空间。登录后会使用该账号自己的空间，登录前的记录不受影响，也不会被清空。";

    const importExport = document.createElement("div");
    importExport.className = "ldfc-settings-actions";
    importExport.append(exportButton(), importButton());

    const clearTitle = document.createElement("h3");
    clearTitle.textContent = "本地数据清理";

    const clearActions = document.createElement("div");
    clearActions.className = "ldfc-settings-actions";
    for (const target of CLEAR_TARGETS) clearActions.appendChild(poolClearButton(target));
    clearActions.appendChild(clearAllButton());

    const syncHost = document.createElement("div");
    syncHost.id = "ldfc-sync-settings";

    // 阅读体验：预览窗口由插件自己做，还是交回原站 / 第三方脚本。
    const readTitle = document.createElement("h3");
    readTitle.textContent = "阅读体验";

    const previewToggle = document.createElement("label");
    previewToggle.className = "ldfc-preview-toggle";
    const previewInput = document.createElement("input");
    previewInput.type = "checkbox";
    previewInput.id = "ldfc-preview-toggle";
    previewInput.checked = Boolean(window.LDFCPreview?.isEnabled?.());
    previewInput.addEventListener("change", () => {
      window.LDFCPreview?.setEnabled?.(previewInput.checked);
    });
    const previewText = document.createElement("span");
    previewText.textContent =
      "点击主题标题时使用 LDFC 自带预览窗口（打开更快）。关闭后按原站方式打开；" +
      "如果装了第三方预览脚本，则由它接管。";
    previewToggle.append(previewInput, previewText);

    // 悬停预取：默认关闭。开启后鼠标在标题上停 130ms 才提前取一次，
    // 扫过列表不会触发；真正点击的预取不受这个开关影响。
    const prefetchToggle = notifyToggleRow(
      "ldfc-prefetch-toggle",
      "悬停标题时预取预览内容（默认关闭）。开启后鼠标在标题上停留约 0.13 秒、" +
        "且距上次预取超过 1.2 秒才会请求一次，扫过列表不触发；点击时的预取始终保留。",
      Boolean(window.LDFCPreview?.isPrefetchOnHover?.()),
      (checked) => window.LDFCPreview?.setPrefetchOnHover?.(checked)
    );
    // 开关的真值由 preview.js 异步读 IndexedDB 得到；面板可能先渲染，
    // 就绪后回填一次，避免"库里是开的、界面显示没开"。
    window.LDFCPreview?.whenReady?.()
      .then(() => {
        const input = prefetchToggle.querySelector("input");
        if (input) input.checked = Boolean(window.LDFCPreview?.isPrefetchOnHover?.());
      })
      .catch(() => {});

    // 预览窗底部的站点动作：二态开关，没有只搬一部分的中间档。
    const siteActionToggle = notifyToggleRow(
      "ldfc-site-actions-all",
      "预览窗动作全搬（默认关闭）。开启后底部的「赞 / 回复 / boost / 书签 / 打开原帖」"
        + "五枚整条隐藏，全部改到工具排下面；关闭则保持原样、上面那排不显示。"
        + "注意：赞 / boost 会真的写站点并给对方发通知。",
      Boolean(window.LDFCLauncher?.isAllSiteActions?.()),
      (checked) => window.LDFCLauncher?.setAllSiteActions?.(checked)
    );
    // 偏好是异步从 IndexedDB 读的，面板先渲染时回填一次，避免显示与实际相反。
    window.LDFCLauncher?.whenSiteActionsReady?.()
      ?.then?.(() => {
        const input = siteActionToggle.querySelector("input");
        if (input) input.checked = Boolean(window.LDFCLauncher?.isAllSiteActions?.());
      })
      ?.catch?.(() => {});

    // 动画速度：0.1×（慢 10 倍）~ 2×（快 2 倍），1× 是正常速度。
    // 主要给"想看清动画怎么走"的场景用，平时保持 1× 即可。
    const speedRow = document.createElement("label");
    speedRow.className = "ldfc-anim-speed";
    const speedTitle = document.createElement("span");
    speedTitle.className = "ldfc-anim-speed-title";
    speedTitle.textContent = "动画速度";
    const speedInput = document.createElement("input");
    speedInput.type = "range";
    speedInput.id = "ldfc-anim-speed";
    speedInput.min = "0.1";
    speedInput.max = "2";
    speedInput.step = "0.1";
    speedInput.value = String(window.LDFCNavigation?.getAnimSpeed?.() ?? 1);
    const speedValue = document.createElement("output");
    speedValue.id = "ldfc-anim-speed-value";
    speedValue.textContent = `${Number(speedInput.value).toFixed(1)}×`;
    speedInput.addEventListener("input", () => {
      const value = Number(speedInput.value);
      speedValue.textContent = `${value.toFixed(1)}×`;
      window.LDFCNavigation?.setAnimSpeed?.(value);
      const pending = window.LDFCDB?.putMeta?.("animSpeed", value);
      if (pending?.catch) pending.catch(() => {});
    });
    speedRow.append(speedTitle, speedInput, speedValue);

    const speedHint = document.createElement("p");
    speedHint.className = "ldfc-sync-note";
    speedHint.textContent =
      "0.1× = 慢 10 倍（方便看清展开动画），2.0× = 快 2 倍；1.0× 为正常速度。";

    // 启动形态：每次都从展开的面板开始，还是只留一颗悬浮球。
    // 老用户习惯直接看到五个池子，新用户可能更想要一颗干净的球。
    const startRow = document.createElement("div");
    startRow.className = "ldfc-start-mode";
    const startTitle = document.createElement("span");
    startTitle.textContent = "启动时显示";
    const startSeg = document.createElement("div");
    startSeg.id = "ldfc-start-mode";
    startSeg.className = "ldfc-seg";
    const startButtons = [];
    for (const [mode, label] of [
      ["panel", "一级面板"],
      ["fab", "悬浮球"]
    ]) {
      const option = button(label, () => {
        window.LDFCNavigation?.setStartMode?.(mode);
        for (const item of startButtons) {
          item.element.setAttribute("aria-pressed", String(item.mode === mode));
        }
      });
      option.dataset.mode = mode;
      option.setAttribute("aria-pressed", String((window.LDFCNavigation?.getStartMode?.() ?? "panel") === mode));
      startButtons.push({ element: option, mode });
      startSeg.appendChild(option);
    }
    startRow.append(startTitle, startSeg);

    // ---- 通知级别 ----
    // 这里的每一项都会真实写站点的 TopicUser 记录，所以文案要说清楚。
    const notifyTitle = document.createElement("h3");
    notifyTitle.textContent = "通知级别";

    const notifySettings = window.LDFCNotify?.getSettings?.() ?? {
      showInPreview: true,
      showInTopic: true,
      linkPools: true,
      autoReadLevel: null,
      map: {}
    };

    const notifyNote = document.createElement("p");
    notifyNote.className = "ldfc-sync-note";
    notifyNote.textContent =
      "以下设置会真实写入 Linux.do 的话题通知（影响站点的邮件 / 推送）。" +
      "某条话题只要你手动改过，就不再被信息池联动覆盖。" +
      "「自动已读时」默认不修改；开启后每篇自动进入已读的帖子会发一次通知设置请求。";

    const notifyShowPreview = notifyToggleRow(
      "ldfc-notify-show-preview",
      "在预览窗显示「通知」按钮",
      notifySettings.showInPreview,
      (checked) => {
        window.LDFCNotify?.setSettings?.({ showInPreview: checked });
        window.LDFCLauncher?.applyNotifyVisibility?.();
      }
    );

    const notifyShowTopic = notifyToggleRow(
      "ldfc-notify-show-topic",
      "在帖子页显示「通知」按钮",
      notifySettings.showInTopic,
      (checked) => {
        window.LDFCNotify?.setSettings?.({ showInTopic: checked });
        window.LDFCLauncher?.applyNotifyVisibility?.();
      }
    );

    const notifyLink = notifyToggleRow(
      "ldfc-notify-link",
      "移入信息池时自动修改通知级别",
      notifySettings.linkPools,
      (checked) => window.LDFCNotify?.setSettings?.({ linkPools: checked })
    );

    const notifyAutoRead = notifyAutoReadRow(notifySettings.autoReadLevel);

    const notifyMapBox = document.createElement("div");
    notifyMapBox.id = "ldfc-notify-map";
    notifyMapBox.className = "ldfc-notify-map-box";
    for (const pool of ["INTERESTED", "READ", "DISMISSED"]) {
      notifyMapBox.appendChild(notifyMappingRow(pool, notifySettings.map?.[pool]));
    }

    // ---- 外观：5 套默认主题 + 明暗三档 ----
    const themeTitle = document.createElement("h3");
    themeTitle.textContent = "外观";

    const themePicker = document.createElement("div");
    themePicker.className = "ldfc-theme-picker";
    const themeButtons = [];
    for (const theme of window.LDFCTheme?.THEMES ?? []) {
      const item = button(theme.name, () => {
        window.LDFCTheme?.setTheme?.(theme.id);
        syncAppearance();
      });
      item.className = "ldfc-theme-swatch";
      item.dataset.theme = theme.id;
      item.style.setProperty("--sw-color", theme.acc);
      item.title = `默认主题：${theme.name}`;
      item.setAttribute("aria-label", `默认主题：${theme.name}`);
      item.insertAdjacentHTML("afterbegin", "<i></i>");
      themeButtons.push(item);
      themePicker.appendChild(item);
    }

    const schemeRow = document.createElement("div");
    schemeRow.className = "ldfc-scheme-row";
    const schemeButtons = [];
    for (const [mode, label] of [["auto", "跟随系统"], ["light", "浅色"], ["dark", "深色"]]) {
      const item = button(label, () => {
        window.LDFCTheme?.setScheme?.(mode);
        syncAppearance();
      });
      item.dataset.scheme = mode;
      schemeButtons.push(item);
      schemeRow.appendChild(item);
    }

    const themeHint = document.createElement("p");
    themeHint.className = "ldfc-theme-hint";
    themeHint.textContent =
      "默认主题只影响插件自己的悬浮球、面板与按钮；深浅色默认跟随系统（与站点同步），也可以固定为浅色 / 深色。";

    function syncAppearance() {
      const theme = window.LDFCTheme?.id ?? "a";
      const scheme = window.LDFCTheme?.schemeMode ?? "auto";
      for (const item of themeButtons) {
        item.setAttribute("aria-pressed", String(item.dataset.theme === theme));
      }
      for (const item of schemeButtons) {
        item.setAttribute("aria-pressed", String(item.dataset.scheme === scheme));
      }
    }
    syncAppearance();

    const privacy = document.createElement("p");
    privacy.className = "ldfc-privacy";
    privacy.textContent =
      "默认情况下所有状态仅保存在浏览器本地，没有云数据库、第三方 API、Analytics 或 Telemetry。只有你主动配置 WebDAV 后，才会把归属与元数据写入你自己的网盘。清理本地数据不会删除网盘上的同步文件。";

    panel.append(
      panelHeader("设置与数据"),
      themeTitle,
      themePicker,
      schemeRow,
      themeHint,
      account,
      importExport,
      clearTitle,
      clearActions,
      syncHost,
      readTitle,
      previewToggle,
      prefetchToggle,
      siteActionToggle,
      speedRow,
      speedHint,
      startRow,
      notifyTitle,
      notifyNote,
      notifyShowPreview,
      notifyShowTopic,
      notifyLink,
      notifyAutoRead,
      notifyMapBox,
      privacy
    );

    if (window.LDFCSyncSettings) {
      window.LDFCSyncSettings.mount(syncHost).catch((error) => {
        syncHost.textContent = `云同步设置加载失败：${error.message}`;
      });
    }
  }

  async function isInitialized() {
    initialized = Boolean(await window.LDFCDB.getMeta("initialized"));
    onboardingPrompted = Boolean(await window.LDFCDB.getMeta("onboardingPrompted"));
    return initialized;
  }

  function render() {
    if (!panel) return;
    if (!initialized) {
      renderOnboarding();
    } else {
      renderSettings();
    }
  }

  function toggle() {
    if (!panel) return;
    // 收起动画期间也按"已关闭"算：这时再点应该重新展开，
    // 否则会一遍遍重播收起动画（用户实测到的"无限重复收起"）。
    const opening = window.LDFCNavigation?.isSheetOpen
      ? !window.LDFCNavigation.isSheetOpen(panel)
      : panel.hidden;

    if (opening) {
      panel.hidden = false;
      // 每次打开都回到"未固定"：用户点开设置通常是临时看一眼，
      // 而不是希望它一直压着列表。
      panel.dataset.pinned = "false";
      panel.querySelector(".ldfc-sheet-pin")?.setAttribute("aria-pressed", "false");
      // 本面板和「信息池面板」位置重合，必须互斥；
      // 同时把列表切回主信息流，否则会留下"列表被过滤光 + 面板又被收起"的空屏。
      const poolPanel = document.getElementById("ldfc-panel");
      if (poolPanel) {
        // 两个面板占同一块区域：这里是"换面板"不是"用户关面板"，
        // 直接落地比播 360ms 收起动画好 —— 否则两块面板会叠在一起收缩。
        if (window.LDFCNavigation?.finishHideSheet) {
          window.LDFCNavigation.finishHideSheet(poolPanel);
        } else if (window.LDFCNavigation?.hideSheet) {
          window.LDFCNavigation.hideSheet(poolPanel);
        } else {
          poolPanel.hidden = true;
        }
      }
      window.LDFCFilter.setActivePool("HOME");
      render();
      // 内容渲染完再展开：transform-origin 要按最终高度算，否则会偏。
      window.LDFCNavigation?.revealSheet?.(panel);
    } else if (window.LDFCNavigation?.hideSheet) {
      window.LDFCNavigation.hideSheet(panel);
    } else {
      panel.hidden = true;
    }
  }

  async function create() {
    if (panel) return panel;

    panel = document.createElement("aside");
    panel.id = "ldfc-settings";
    panel.hidden = true;
    document.body.appendChild(panel);

    // 未固定时点面板外部即关闭（固定按钮在标题行里）。
    window.LDFCNavigation?.bindSheetDismiss?.(panel, () => toggle());

    // Esc 也能收起，符合面板类浮层的一般预期。
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && panel && !panel.hidden) toggle();
    });

    await isInitialized();

    // 打开站点时先把已保存的 WebDAV 配置恢复成 transport，
    // 这样 content.js 随后的 pullOnce 才能带上远端。
    try {
      await window.LDFCSyncSettings?.init?.();
    } catch {
      // 云同步不可用不影响本地功能。
    }

    return panel;
  }

  function addLaunchButton() {
    const element = button("设置", toggle);
    element.dataset.navIcon = "SETTINGS";
    element.id = "ldfc-settings-launch";
    // 必须挂进导航的条目容器：折叠成悬浮球时整块条目区会隐藏，
    // 直接挂 nav 根节点会让设置按钮留在悬浮球外面。
    window.LDFCNavigation.appendItem(element);

    // 向导只在首次安装时自动弹出一次。没选之前它会挡住右侧内容，
    // 每次刷新都弹会很烦；之后用 ⚙ 设置随时可以再打开。
    if (!initialized && !onboardingPrompted) {
      onboardingPrompted = true;
      window.LDFCDB.putMeta("onboardingPrompted", true).catch(() => {});
      setTimeout(toggle, 600);
    }
  }

  window.LDFCSettings = { addLaunchButton, create, render };
})();
