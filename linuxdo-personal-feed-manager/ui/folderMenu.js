(() => {
  // 文件夹胶囊的长按/右键菜单（新建子文件夹 / 重命名 / 删除 + 撤销）。
  // 信息池面板与站点书签面板共用这一份：两边只是背后的树不同，
  // 交互、文案、确认框、撤销提示必须一模一样，否则用户要点两套肌肉记忆。
  //
  // 菜单必须挂 document.body：面板自身带 transform，会成为 position:fixed
  // 的包含块，挂在面板里算出来的坐标会被面板的位移再叠一次。
  let menuEl = null;
  let offClick = null;
  let openedAt = 0;

  function close() {
    menuEl?.remove();
    menuEl = null;
    if (offClick) {
      document.removeEventListener("click", offClick, true);
      offClick = null;
    }
  }

  function errorText(reason, maxDepth) {
    switch (reason) {
      case "empty":
        return "名称不能为空";
      case "duplicate":
        return "同一层已有同名文件夹";
      case "too-deep":
        return `最多 ${maxDepth ?? 6} 层`;
      case "cycle":
        return "不能把文件夹移到它自己的子树里";
      default:
        return "操作失败";
    }
  }

  // api: LDFCFolders.for("pool"|"site") 这样的一组绑定函数
  // hooks: { detach(removedIds), reattach(affected), onChange() }
  function open({ api, anchor, folderId, hooks = {} }) {
    close();
    const menu = document.createElement("div");
    menu.className = "ldfc-folder-menu";

    const item = (label, handler) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.addEventListener("click", async () => {
        close();
        await handler();
      });
      menu.appendChild(button);
    };

    item("新建子文件夹", async () => {
      const name = window.prompt("子文件夹名称");
      if (name === null) return;
      const result = await api.create(name, folderId);
      if (!result.ok) window.LDFCToast?.show?.(errorText(result.reason, api.MAX_DEPTH));
      hooks.onChange?.();
    });

    item("重命名", async () => {
      const path = api.pathOf(folderId);
      const name = window.prompt("新的名称", path[path.length - 1] || "");
      if (name === null) return;
      const result = await api.rename(folderId, name);
      if (!result.ok) window.LDFCToast?.show?.(errorText(result.reason, api.MAX_DEPTH));
      hooks.onChange?.();
    });

    item("删除", async () => {
      const names = api.pathOf(folderId);
      const subtree = api.subtreeIds(folderId);
      const detail =
        `确定删除「${names.join(" / ")}」？\n\n` +
        (subtree.length > 1 ? `会同时删除其下 ${subtree.length - 1} 个子文件夹。\n` : "") +
        "里面的条目会回到「未分类」，不会被删除。";
      if (!window.confirm(detail)) return;
      const result = await api.remove(folderId, hooks.detach);
      if (!result.ok) return;
      window.LDFCToast?.show?.(
        `已删除文件夹「${names[names.length - 1]}」`,
        "撤销",
        async () => {
          await api.restore(result.removedFolders, result.affected, hooks.reattach);
          hooks.onChange?.();
        }
      );
      hooks.onChange?.();
    });

    document.body.appendChild(menu);

    const rect = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 180))}px`;
    menu.style.top = `${rect.bottom + 6}px`;

    openedAt = Date.now();
    offClick = (event) => {
      if (menu.contains(event.target)) return;
      // 长按松手时浏览器补发的 click 会立刻把刚开出来的菜单关掉，这里放行 300ms
      if (Date.now() - openedAt < 300) return;
      close();
    };
    document.addEventListener("click", offClick, true);

    menuEl = menu;
    return menu;
  }

  window.LDFCFolderMenu = { close, open };
})();
