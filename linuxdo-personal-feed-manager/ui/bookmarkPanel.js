(() => {
  // 站点书签面板：列表 + 自定义文件夹 + 一键打开。
  //
  // 与信息池面板的关系：数据源、文件夹树都是分开的两套（folders.js 的 site 树），
  // 只有交互与视觉复用（文件夹胶囊、长按菜单、toast 撤销）。
  //
  // 资源：列表来自 /u/<user>/bookmarks.json 的分页结果，缓存 10 分钟；
  // 打开面板不会每次都打服务器，只有「刷新」或缓存过期才重新拉。
  const PANEL_ID = "ldfc-bm-panel";
  const BATCH = 40;

  let panel = null;
  let activeFolder = null; // null=全部 / "NONE"=未分类 / 其余为文件夹 id
  let query = "";
  let rendered = 0;

  const site = () => window.LDFCFolders?.for?.("site");

  function show(text, actionLabel, action) {
    window.LDFCToast?.show?.(text, actionLabel, action);
  }

  function ensurePanel() {
    if (panel) return panel;
    panel = document.createElement("aside");
    panel.id = PANEL_ID;
    panel.hidden = true;
    document.body.appendChild(panel);
    window.LDFCNavigation?.bindSheetDismiss?.(panel, () => {
      panel.hidden = true;
    });
    window.addEventListener("ldfc:folders-changed", (event) => {
      if (event.detail?.ns !== "site") return;
      if (!panel || panel.hidden) return;
      render();
    });
    window.addEventListener("ldfc:site-bookmarks-changed", () => {
      if (!panel || panel.hidden) return;
      render();
    });
    return panel;
  }

  async function open() {
    ensurePanel();
    panel.hidden = false;
    // 与信息池/设置面板占同一块区域，同时开会互相遮挡。
    const pool = document.getElementById("ldfc-panel");
    if (pool) pool.hidden = true;
    const settings = document.getElementById("ldfc-settings");
    if (settings) settings.hidden = true;
    await site()?.load?.();
    // 先把缓存画出来，再按需刷新，避免空白等网络
    render();
    try {
      const cache = await window.LDFCSiteBookmarks.load();
      if (cache && cache.username === null) {
        show("读取书签失败：可能未登录");
      }
    } catch (error) {
      show(`读取书签失败：${error.message}`);
    }
    render();
  }

  function matches(item) {
    if (!site()?.matches?.(item, activeFolder)) return false;
    if (!query) return true;
    const hay = `${item.title} ${item.excerpt} ${item.author} ${item.tags.join(" ")}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  }

  function folderLabel(folderId) {
    const path = site()?.pathOf?.(folderId) ?? [];
    return path[path.length - 1] || "未分类";
  }

  function folderChip(label, { active = false, title = "", onClick, onMenu } = {}) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "ldfc-folder-chip";
    if (active) chip.classList.add("active");
    chip.textContent = label;
    if (title) chip.title = title;
    if (onClick) chip.addEventListener("click", onClick);
    if (onMenu) {
      chip.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        onMenu(chip);
      });
      let timer = 0;
      const clear = () => {
        if (timer) clearTimeout(timer);
        timer = 0;
      };
      chip.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch" && event.pointerType !== "pen") return;
        clear();
        timer = setTimeout(() => {
          timer = 0;
          onMenu(chip);
        }, 550);
      });
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
        chip.addEventListener(type, clear);
      }
    }
    return chip;
  }

  function renderFolderBar() {
    const bar = document.createElement("div");
    bar.className = "ldfc-folder-bar";
    const select = (value) => {
      activeFolder = value;
      rendered = 0;
      render();
    };

    bar.appendChild(folderChip("全部", { active: !activeFolder, onClick: () => select(null) }));
    bar.appendChild(folderChip("未分类", { active: activeFolder === "NONE", onClick: () => select("NONE") }));

    const walk = (parentId, depth) => {
      for (const folder of site()?.childrenOf?.(parentId) ?? []) {
        bar.appendChild(
          folderChip(`${depth ? "· ".repeat(depth) : ""}${folder.name}`, {
            active: activeFolder === folder.id,
            title: site()?.pathOf?.(folder.id).join(" / ") || folder.name,
            onClick: () => select(folder.id),
            onMenu: (anchor) => {
              window.LDFCFolderMenu?.open?.({
                api: site(),
                anchor,
                folderId: folder.id,
                hooks: {
                  detach: (removedIds) => window.LDFCSiteBookmarks.detachFolders(removedIds),
                  reattach: (affected) => window.LDFCSiteBookmarks.reattachFolders(affected),
                  onChange: () => {
                    if (activeFolder && !site().list().some((one) => one.id === activeFolder)) {
                      activeFolder = null;
                    }
                    render();
                  }
                }
              });
            }
          })
        );
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);

    const add = folderChip("＋", { title: "新建文件夹（长按已有文件夹可建子文件夹）" });
    add.classList.add("ldfc-folder-add");
    add.addEventListener("click", async () => {
      const name = window.prompt("文件夹名称");
      if (name === null) return;
      const result = await site().create(name, null);
      if (!result.ok) {
        show(result.reason === "duplicate" ? "同一层已有同名文件夹" : "名称不能为空");
      }
      render();
    });
    bar.appendChild(add);
    return bar;
  }

  // 「打开全部」的落点选择。扩展端可以开新窗口，油猴（手机 TM）只有当前窗口；
  // 只有一条时直接开，不为一次点击多加一层菜单。
  function openAllMenu(anchor, list) {
    if (list.length === 1) {
      openAll(list, false);
      return;
    }
    const menu = document.createElement("div");
    menu.className = "ldfc-folder-menu";
    const add = (label, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", () => {
        menu.remove();
        handler();
      });
      menu.appendChild(button);
    };
    add(`当前窗口 · ${list.length} 个`, () => openAll(list, false));
    if (window.LDFCOpenTabs?.supportsNewWindow?.()) {
      add(`新窗口 · ${list.length} 个`, () => openAll(list, true));
    }
    document.body.appendChild(menu);
    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 190))}px`;
    menu.style.top = `${rect.bottom + 6}px`;
    const close = (event) => {
      if (menu.contains(event.target)) return;
      menu.remove();
      document.removeEventListener("click", close, true);
    };
    // 本次点击还在冒泡，等它走完再挂监听，否则菜单刚开就被自己关掉。
    setTimeout(() => document.addEventListener("click", close, true), 0);
  }

  async function openAll(list, newWindow = false) {
    // 手机端一次开几十个标签页会把浏览器拖死，超过 5 个先确认。
    if (list.length > 5 && !window.confirm(`将打开 ${list.length} 个标签页，确定吗？`)) return;
    const urls = list.map((item) => new URL(item.url, location.origin).href);
    const result = await window.LDFCOpenTabs.open(urls, { newWindow });
    if (!result.ok) {
      show("没能打开链接");
      return;
    }
    if (result.opened < result.total) {
      show(`打开了 ${result.opened} 个，另有 ${result.total - result.opened} 个被浏览器拦截`);
    } else {
      show(`已打开 ${result.opened} 个标签页`);
    }
  }

  function items() {
    return window.LDFCSiteBookmarks.items();
  }

  function renderItem(item) {
    const row = document.createElement("div");
    row.className = "ldfc-bm-item";

    const link = document.createElement("a");
    link.className = "ldfc-bm-title";
    link.href = item.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = item.title || `#${item.topicId}`;
    row.appendChild(link);

    const meta = document.createElement("div");
    meta.className = "ldfc-bm-meta";
    const bits = [];
    if (item.author) bits.push(item.author);
    if (item.createdAt) bits.push(new Date(item.createdAt).toLocaleDateString());
    bits.push(item.folderId ? folderLabel(item.folderId) : "未分类");
    meta.textContent = bits.join(" · ");
    row.appendChild(meta);

    const tools = document.createElement("div");
    tools.className = "ldfc-bm-tools";

    const move = document.createElement("button");
    move.type = "button";
    move.className = "ldfc-bm-btn";
    move.textContent = "移入…";
    const picker = document.createElement("div");
    picker.className = "ldfc-bm-picker";
    picker.hidden = true;
    const choose = (folderId) => {
      window.LDFCSiteBookmarks.assign([item.id], folderId).then(() => {
        show(folderId ? `已移到「${folderLabel(folderId)}」` : "已移到「未分类」");
        render();
      });
    };
    picker.appendChild(folderChip("未分类", { onClick: () => choose(null) }));
    const walk = (parentId, depth) => {
      for (const folder of site()?.childrenOf?.(parentId) ?? []) {
        picker.appendChild(
          folderChip(`${depth ? "· ".repeat(depth) : ""}${folder.name}`, {
            onClick: () => choose(folder.id)
          })
        );
        walk(folder.id, depth + 1);
      }
    };
    walk(null, 0);
    move.addEventListener("click", () => {
      picker.hidden = !picker.hidden;
    });

    const unbookmark = document.createElement("button");
    unbookmark.type = "button";
    unbookmark.className = "ldfc-bm-btn";
    unbookmark.textContent = "取消书签";
    unbookmark.addEventListener("click", async () => {
      try {
        await window.LDFCSiteBookmarks.toggle(item.topicId);
        show("已取消书签");
        render();
      } catch (error) {
        show(`取消失败：${error.message}`);
      }
    });

    tools.append(move, unbookmark);
    row.append(tools, picker);
    return row;
  }

  function render() {
    const host = ensurePanel();
    // render() 会重建整个面板；搜索框如果在输入，必须把焦点和光标位置带过去，
    // 否则每敲一个字符就丢焦点，只能输入第一个字。
    const previousSearch = host.querySelector(".ldfc-bm-search");
    const searchHadFocus = previousSearch === document.activeElement;
    const caret = searchHadFocus ? previousSearch.selectionStart : null;
    host.innerHTML = "";

    const header = document.createElement("div");
    header.className = "ldfc-panel-header";
    const title = document.createElement("h2");
    title.textContent = `书签${activeFolder && activeFolder !== "NONE" ? ` / ${folderLabel(activeFolder)}` : ""}`;
    const tools = document.createElement("div");
    tools.className = "ldfc-panel-tools";

    const reload = document.createElement("button");
    reload.type = "button";
    reload.className = "ldfc-bm-btn";
    reload.textContent = "刷新";
    reload.addEventListener("click", async () => {
      reload.disabled = true;
      try {
        await window.LDFCSiteBookmarks.load({ refresh: true });
      } catch (error) {
        show(`刷新失败：${error.message}`);
      } finally {
        reload.disabled = false;
      }
      render();
    });

    const openAllBtn = document.createElement("button");
    openAllBtn.type = "button";
    openAllBtn.className = "ldfc-bm-btn ldfc-bm-open-all";
    openAllBtn.textContent = "打开全部";
    openAllBtn.title = "把当前筛选里的书签一次性打开";
    openAllBtn.addEventListener("click", () => {
      const list = items().filter(matches);
      if (!list.length) {
        show("这个文件夹里还没有书签");
        return;
      }
      openAllMenu(openAllBtn, list);
    });

    const close = document.createElement("button");
    close.type = "button";
    close.className = "ldfc-panel-close";
    close.textContent = "×";
    close.addEventListener("click", () => {
      host.hidden = true;
    });

    tools.append(reload, openAllBtn, close);
    header.append(title, tools);
    host.appendChild(header);

    const search = document.createElement("input");
    search.className = "ldfc-bm-search";
    search.type = "search";
    search.placeholder = "搜索标题 / 作者 / 标签";
    search.value = query;
    search.addEventListener("input", () => {
      query = search.value.trim();
      rendered = 0;
      render();
    });
    host.appendChild(search);
    if (searchHadFocus) {
      search.focus();
      search.setSelectionRange(caret, caret);
    }
    host.appendChild(renderFolderBar());

    const list = items().filter(matches);
    const listEl = document.createElement("div");
    listEl.className = "ldfc-bm-list";

    if (!list.length) {
      const empty = document.createElement("p");
      empty.className = "ldfc-bm-empty";
      empty.textContent = query
        ? "没有匹配的书签"
        : activeFolder
          ? "这个文件夹里还没有书签"
          : "还没有站点书签";
      listEl.appendChild(empty);
    } else {
      const showCount = Math.max(BATCH, rendered);
      for (const item of list.slice(0, showCount)) listEl.appendChild(renderItem(item));
      rendered = showCount;
      if (list.length > showCount) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "ldfc-bm-more";
        more.textContent = `再显示 ${Math.min(BATCH, list.length - showCount)} 条（共 ${list.length} 条）`;
        more.addEventListener("click", () => {
          rendered = showCount + BATCH;
          render();
        });
        listEl.appendChild(more);
      }
    }
    host.appendChild(listEl);
  }

  // 一级面板入口：排在「设置」前面，点一次开、再点一次收。
  function addLaunchButton() {
    if (!window.LDFCNavigation?.appendItem || document.getElementById("ldfc-bookmarks-launch")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "ldfc-bookmarks-launch";
    button.textContent = "🔖 书签";
    button.title = "站点书签：自定义文件夹 + 一键打开";
    button.addEventListener("click", () => {
      if (panel && !panel.hidden) {
        panel.hidden = true;
        return;
      }
      open();
    });
    window.LDFCNavigation.appendItem(button);
  }

  window.LDFCBookmarkPanel = {
    addLaunchButton,
    close: () => {
      if (panel) panel.hidden = true;
    },
    open,
    render
  };
})();
