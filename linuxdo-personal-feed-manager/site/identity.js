(() => {
  // 识别当前 Linux.do 账号，用于给每个账号分配独立的本地状态空间。
  //
  // 三种情况：
  //   user-<id>         已登录，拿到稳定的数值 user id（首选）
  //   user-<username>   已登录，但只拿得到用户名（降级：改名会被当成新账号）
  //   guest             未登录
  //
  // 为什么优先用数值 id 而不是用户名：用户名可以改，改完状态就"丢了"。
  //
  // 每个整页加载只解析一次，SPA 内部跳转不重复请求。
  const GUEST_NAMESPACE = "guest";

  const state = {
    namespace: GUEST_NAMESPACE,
    username: "",
    loggedIn: false,
    source: "guest"
  };

  let promise = null;

  async function probeSession() {
    try {
      const response = await fetch("/session/current.json", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload?.current_user ?? null;
    } catch {
      // 站点防护返回 HTML、网络失败、未登录 404 都会走到这里
      return null;
    }
  }

  function probeHeader() {
    // 兜底：Discourse 核心头部会渲染 #current-user，不依赖站点主题。
    const link = document.querySelector("#current-user a[href*='/u/']");
    const match = link?.getAttribute("href")?.match(/\/u\/([^/?#]+)/);
    return match ? { username: decodeURIComponent(match[1]) } : null;
  }

  function resolve() {
    if (promise) return promise;

    promise = (async () => {
      // /session/current.json 偶尔会因为站点防护 / 网络抖动失败。
      // 这时如果直接退回"用户名"命名空间，就会和 user-<id> 变成两个空间，
      // 用户看到的是数据"凭空消失"。所以先重试一次，再降级。
      let sessionUser = await probeSession();
      // 只有"页头看起来已登录"时才值得重试：未登录用户重试纯属浪费。
      if (!sessionUser?.id && probeHeader()) {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const retried = await probeSession();
        if (retried?.id) sessionUser = retried;
      }

      const user = sessionUser ?? probeHeader();

      if (user?.id) {
        state.namespace = `user-${user.id}`;
        state.username = user.username ?? "";
        state.loggedIn = true;
        state.source = "session";
      } else if (user?.username) {
        state.namespace = `user-${user.username}`;
        state.username = user.username;
        state.loggedIn = true;
        state.source = "header";
      } else {
        // 未登录。用独立的 guest 空间，而不是和任何账号共用 ——
        // 共用会让两个身份的状态互相覆盖。
        state.namespace = GUEST_NAMESPACE;
        state.username = "";
        state.loggedIn = false;
        state.source = "guest";
      }

      return { ...state };
    })();

    return promise;
  }

  function current() {
    return { ...state };
  }

  window.LDFCIdentity = { GUEST_NAMESPACE, current, resolve };
})();
