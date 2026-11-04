// 外观主题：5 套主色 + 跟随系统 / 固定浅色 / 固定深色。
//
// 只改 documentElement 上的 data 属性，具体颜色全部在 content.css 的
// 令牌里；本文件不碰页面自身的 class / style，避免影响站点原生主题。
//
// 深浅色跟随的是**系统**（prefers-color-scheme），不是站点：linux.do
// 自己也是跟随系统切换的，两者天然一致；用户仍可强制浅色 / 深色。
(function () {
  const THEMES = [
    { id: "a", name: "青瓷", acc: "#38c6b4", acc2: "#1e9086" },
    { id: "b", name: "湖蓝", acc: "#4f9dff", acc2: "#2a6ad0" },
    { id: "c", name: "琥珀", acc: "#eaa33c", acc2: "#a86a19" },
    { id: "d", name: "青柠", acc: "#5fd08c", acc2: "#26995c" },
    { id: "e", name: "珊瑚", acc: "#ff8173", acc2: "#cf4436" }
  ];
  const SCHEMES = ["auto", "light", "dark"];
  const THEME_KEY = "ldfc.uiTheme";
  const SCHEME_KEY = "ldfc.uiScheme";

  const root = document.documentElement;
  const media = window.matchMedia?.("(prefers-color-scheme: dark)");
  let themeId = "a";
  let schemeMode = "auto";
  let lastResolved = "";

  const validTheme = (id) => THEMES.some((item) => item.id === id);
  const validScheme = (mode) => SCHEMES.includes(mode);
  const systemScheme = () => (media?.matches ? "dark" : "light");

  function apply() {
    const resolved = schemeMode === "auto" ? systemScheme() : schemeMode;
    root.dataset.ldfcTheme = themeId;
    root.dataset.ldfcScheme = resolved;
    root.dataset.ldfcSchemeMode = schemeMode;
    lastResolved = resolved;
  }

  function cache() {
    try {
      localStorage.setItem(THEME_KEY, themeId);
      localStorage.setItem(SCHEME_KEY, schemeMode);
    } catch {
      /* 隐私模式可能禁用 localStorage，忽略即可 */
    }
  }

  function announce() {
    window.dispatchEvent(new CustomEvent("ldfc:theme-changed", {
      detail: { theme: themeId, scheme: schemeMode, resolved: lastResolved }
    }));
  }

  function setTheme(id, persist = true) {
    if (!validTheme(id)) return;
    themeId = id;
    cache();
    apply();
    if (persist) {
      window.LDFCDB?.putMeta?.(THEME_KEY, id).catch?.(() => {});
      announce();
    }
  }

  function setScheme(mode, persist = true) {
    if (!validScheme(mode)) return;
    schemeMode = mode;
    cache();
    apply();
    if (persist) {
      window.LDFCDB?.putMeta?.(SCHEME_KEY, mode).catch?.(() => {});
      announce();
    }
  }

  // 首屏先吃 localStorage，避免刷新时先闪一帧默认主题。
  try {
    const cachedTheme = localStorage.getItem(THEME_KEY);
    const cachedScheme = localStorage.getItem(SCHEME_KEY);
    if (validTheme(cachedTheme)) themeId = cachedTheme;
    if (validScheme(cachedScheme)) schemeMode = cachedScheme;
  } catch {
    /* ignore */
  }
  apply();

  // 系统深浅色变化：只有「跟随系统」时才跟着切。
  media?.addEventListener?.("change", () => {
    if (schemeMode === "auto") apply();
  });

  // IndexedDB 是持久化的真源（换设备/清缓存后仍以库里的为准）。
  const ready = (async () => {
    try {
      const [storedTheme, storedScheme] = await Promise.all([
        window.LDFCDB?.getMeta?.(THEME_KEY),
        window.LDFCDB?.getMeta?.(SCHEME_KEY)
      ]);
      let changed = false;
      if (validTheme(storedTheme) && storedTheme !== themeId) {
        themeId = storedTheme;
        changed = true;
      }
      if (validScheme(storedScheme) && storedScheme !== schemeMode) {
        schemeMode = storedScheme;
        changed = true;
      }
      if (changed) {
        cache();
        apply();
        announce();
      }
    } catch {
      /* 库没准备好就沿用 localStorage / 默认值 */
    }
  })();

  window.LDFCTheme = {
    THEMES,
    SCHEMES,
    get id() { return themeId; },
    get schemeMode() { return schemeMode; },
    get resolved() { return lastResolved; },
    setTheme,
    setScheme,
    apply,
    ready
  };
})();
