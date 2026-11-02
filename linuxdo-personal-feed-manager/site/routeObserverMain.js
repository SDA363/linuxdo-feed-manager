(() => {
  // 运行在主世界（MAIN world）的小脚本，唯一职责是监听 Discourse 的
  // SPA 路由变化，然后通知扩展的内容脚本。
  //
  // 为什么必须放主世界：内容脚本运行在隔离世界，两个世界对同一个 DOM
  // 对象有各自独立的 JS 包装。在隔离世界里改写 history.pushState 只会
  // 影响隔离世界自己，Discourse（主世界）调用 pushState 根本不会命中，
  // 路由监听会完全失效。
  if (window.__ldfcRouteObserverInstalled) return;
  window.__ldfcRouteObserverInstalled = true;

  function fire() {
    // 主世界派发的事件，隔离世界的监听器同样能收到。
    window.dispatchEvent(new CustomEvent("ldfc:route-change"));
  }

  for (const name of ["pushState", "replaceState"]) {
    const original = history[name];
    if (typeof original !== "function") continue;

    history[name] = function (...args) {
      const result = original.apply(this, args);
      fire();
      return result;
    };
  }

  window.addEventListener("popstate", fire);
})();
