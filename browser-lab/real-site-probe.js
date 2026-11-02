"use strict";

// LDFC 真实站点 Phase 0 只读探针。
//
// 用途：在真实 linux.do 上收集事实，**不做任何写操作**（不点击、不导航、不改 DOM）。
// 网络请求只读取原站本来就有的 JSON 接口，且每个探针只发少量请求。
//
// 用法：
//   node real-site-probe.js --port 9223 <探针名> [<探针名> ...]
//   node real-site-probe.js --port 9223 list
//
// 设计约束（来自用户授权边界）：
//   - 只读，不发高频请求，不逐 Topic 扫描，不做后台轮询；
//   - 不修改正式功能代码，本文件是临时诊断探针。

const fs = require("node:fs");
const path = require("node:path");

const LAB_DIR = __dirname;

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const home = process.env.USERPROFILE || process.env.HOME || "C:/Users/asddn";
  const cuaRoot = path.join(home, "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node");
  try {
    for (const version of fs.readdirSync(cuaRoot)) {
      candidates.push(path.join(cuaRoot, version, "bin", "node_modules", "playwright"));
    }
  } catch {
    // 忽略
  }
  candidates.push("playwright");
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // 下一个
    }
  }
  throw new Error("找不到 Playwright 模块");
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) {
        flags[key] = next;
        index += 1;
      } else {
        flags[key] = true;
      }
    } else {
      flags._.push(token);
    }
  }
  return flags;
}

// 在页面主世界执行的公共工具，注入到每个探针里复用。
const HELPERS = `
  const q = (sel) => document.querySelector(sel);
  const qa = (sel) => [...document.querySelectorAll(sel)];
  const cls = (el) => el ? [...el.classList] : null;
  const json = async (url) => {
    try {
      const r = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!r.ok) return { __status: r.status, __ok: false };
      return await r.json();
    } catch (error) {
      return { __status: 0, __ok: false, __error: String(error) };
    }
  };
`;

const PROBES = {
  // 环境与落地页身份：判断是真论坛、Cloudflare 挑战页，还是等待页。
  env: `
    ${HELPERS}
    return {
      href: location.href,
      title: document.title,
      readyState: document.readyState,
      bodyTextLength: document.body ? document.body.innerText.length : 0,
      bodyHead: document.body ? document.body.innerText.slice(0, 200) : "",
      markers: {
        cloudflare: !!q("#challenge-form, #cf-challenge-running, .cf-browser-verification, [data-translate=checking_browser], #cf-wrapper"),
        cloudflareTitle: /just a moment|attention required|checking your browser/i.test(document.title),
        topicList: !!q(".topic-list, .topic-list-body, [data-topic-id]"),
        loginForm: !!q("#login-button, .login-button, form#login-form"),
        currentUserHeader: !!q("#current-user a[href*='/u/']")
      },
      topicRowCount: qa("[data-topic-id]").length
    };
  `,

  // Discourse 前端环境：确认是不是真 SPA、有哪些可用的全局对象与预加载数据。
  discourseEnv: `
    ${HELPERS}
    const preloaded = q("#data-preloaded");
    let preloadKeys = null;
    try {
      preloadKeys = preloaded ? Object.keys(JSON.parse(preloaded.dataset.preloadData || "{}")) : null;
    } catch (error) {
      preloadKeys = "解析失败: " + String(error);
    }
    return {
      globals: {
        requirejs: typeof window.requirejs,
        Discourse: typeof window.Discourse,
        Ember: typeof window.Ember,
        jQuery: typeof window.jQuery,
        __ldfcRouteObserverInstalled: typeof window.__ldfcRouteObserverInstalled
      },
      meta: {
        generator: q("meta[name=generator]")?.content ?? null,
        discourseTheme: q("meta[name=discourse_theme_id]")?.content ?? null,
        csrfPresent: !!q("meta[name=csrf-token]")
      },
      preloaded: {
        elementPresent: !!preloaded,
        dataAttrPresent: !!(preloaded && preloaded.dataset.preloadData),
        keys: preloadKeys
      },
      router: {
        hasDiscourseRouter: !!(window.requirejs && window.requirejs.entries && Object.keys(window.requirejs.entries).some((k) => k.includes("discourse/router")))
      }
    };
  `,

  // 账号身份：确认 /session/current.json 可用性，以及 DOM 兜底是否可行。
  identity: `
    ${HELPERS}
    const session = await json("/session/current.json");
    const headerLink = q("#current-user a[href*='/u/']");
    const meta = q("meta[name=discourse_current_user]");
    return {
      sessionEndpoint: session.__ok === false
        ? { ok: false, status: session.__status }
        : {
            ok: true,
            hasCurrentUser: !!session.current_user,
            keys: session.current_user ? Object.keys(session.current_user).slice(0, 20) : null,
            id: session.current_user?.id ?? null,
            username: session.current_user?.username ?? null
          },
      headerFallback: {
        elementPresent: !!headerLink,
        href: headerLink?.getAttribute("href") ?? null
      },
      metaFallback: meta ? meta.content : null
    };
  `,

  // Topic 列表真实 DOM：稳定 ID 从哪来、行结构长什么样。
  topicDom: `
    ${HELPERS}
    const rows = qa("[data-topic-id]").slice(0, 3);
    const listSelectors = [
      ".topic-list", ".topic-list-body", ".topic-list-item",
      ".latest-topic-list", ".latest-topic-list-item", "tr.topic-list-item"
    ];
    const found = {};
    for (const sel of listSelectors) found[sel] = qa(sel).length;

    return {
      listSelectors: found,
      rowCount: qa("[data-topic-id]").length,
      rows: rows.map((row) => {
        const titleLink = row.querySelector("a.title, .title a, a.raw-topic-link, a[href*='/t/']");
        const href = titleLink?.getAttribute("href") ?? null;
        const idFromHref = href ? (href.match(/\\/t\\/(?:[^/]+\\/)?(\\d+)/) || [])[1] ?? null : null;
        return {
          tag: row.tagName,
          classes: cls(row),
          dataTopicId: row.getAttribute("data-topic-id"),
          idFromHref,
          idsMatch: row.getAttribute("data-topic-id") === idFromHref,
          href,
          titleText: titleLink ? titleLink.textContent.trim().slice(0, 40) : null,
          hasUnreadClass: [...row.classList].some((c) => /unread|visited|read/.test(c)),
          childSummary: [...row.children].slice(0, 8).map((c) => c.tagName + "." + (c.className || "").toString().split(" ")[0])
        };
      })
    };
  `,

  // 列表数据来源：/latest.json 与 /unread.json 是否存在、字段是否可用。
  listApis: `
    ${HELPERS}
    const latest = await json("/latest.json");
    const unread = await json("/unread.json");
    const summarize = (payload) => {
      if (payload.__ok === false) return { ok: false, status: payload.__status };
      const topics = payload.topic_list?.topics ?? [];
      const first = topics[0] ?? null;
      return {
        ok: true,
        topicCount: topics.length,
        hasMore: payload.topic_list?.more_topics_url ?? null,
        perPage: payload.topic_list?.per_page ?? null,
        firstTopicFields: first ? Object.keys(first).sort() : null,
        readingStateFields: first
          ? {
              last_read_post_number: first.last_read_post_number ?? null,
              highest_post_number: first.highest_post_number ?? null,
              unread_posts: first.unread_posts ?? null,
              new_posts: first.new_posts ?? null,
              notification_level: first.notification_level ?? null,
              bookmarked: first.bookmarked ?? null,
              last_poster_username: first.last_poster_username ?? null,
              category_id: first.category_id ?? null,
              excerpt: first.excerpt ? first.excerpt.slice(0, 40) : null
            }
          : null
      };
    };
    return { latest: summarize(latest), unread: summarize(unread) };
  `,

  // Topic 详情接口：是否含阅读状态字段（决定"列表查不到时的兜底"能否成立）。
  topicDetail: `
    ${HELPERS}
    const row = q("[data-topic-id]");
    const topicId = row?.getAttribute("data-topic-id");
    if (!topicId) return { error: "页面上没有 Topic 行" };
    const payload = await json("/t/" + topicId + ".json");
    if (payload.__ok === false) return { topicId, ok: false, status: payload.__status };
    return {
      topicId,
      ok: true,
      topLevelKeys: Object.keys(payload).sort(),
      readingState: {
        last_read_post_number: payload.last_read_post_number ?? null,
        highest_post_number: payload.highest_post_number ?? null,
        unread_posts: payload.unread_posts ?? null,
        hasPostStream: !!payload.post_stream,
        streamLength: payload.post_stream?.stream?.length ?? null,
        postsWindowLength: payload.post_stream?.posts?.length ?? null
      },
      detailsKeys: payload.details ? Object.keys(payload.details).sort() : null
    };
  `,

  // [data-topic-id] 元素普查：确认哪些才是"列表行"。
  // 本地 fixture 里一个 Topic 只有一个 data-topic-id，真实站点未必。
  topicIdElements: `
    ${HELPERS}
    const all = qa("[data-topic-id]");
    const shape = (el) => el.tagName + "." + (el.className || "").toString().trim().split(/\\s+/).slice(0, 3).join(".");
    const counts = new Map();
    for (const el of all) {
      const key = shape(el);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const sample = all.slice(0, 4).map((el) => ({
      shape: shape(el),
      topicId: el.getAttribute("data-topic-id"),
      parentShape: el.parentElement ? shape(el.parentElement) : null,
      isTopicListItem: el.classList.contains("topic-list-item"),
      nestedInsideAnotherTopicId: !!el.parentElement?.closest("[data-topic-id]"),
      ownTopicIdOnAncestor: el.parentElement?.closest("[data-topic-id]")?.getAttribute("data-topic-id") ?? null
    }));
    return {
      totalDataTopicId: all.length,
      distinctShapes: [...counts.entries()].map(([shape, count]) => ({ shape, count })),
      distinctTopicIds: new Set(all.map((el) => el.getAttribute("data-topic-id"))).size,
      sample
    };
  `,

  // 把插件自己的解析器注入页面空跑一遍（只读，不改 DOM）。
  // 这是"扩展在这套真实 DOM 上到底会选中什么"的最直接证据 ——
  // 比人肉读选择器可靠，也避免把 fixture 的形状当成真实站点的形状。
  parserDryRun: `
    __INJECT_PARSER__
    const rows = window.LDFCTopicParser.listRows();
    const topics = rows.map((row) => window.LDFCTopicParser.extractTopic(row)).filter(Boolean);
    const first = rows[0];
    return {
      listRowsCount: rows.length,
      extractedCount: topics.length,
      distinctTopicIds: new Set(topics.map((t) => t.topicId)).size,
      rowsAreTopicListItems: rows.every((r) => r.classList.contains("topic-list-item")),
      nestedTopicIdElementsIgnored: document.querySelectorAll("[data-topic-id]").length - rows.length,
      firstRow: first ? {
        tag: first.tagName,
        classes: [...first.classList],
        datasetTopicId: first.dataset.topicId,
        buttonsInjectedYet: !!first.querySelector(".ldfc-actions"),
        titleLinkFound: !!first.querySelector("a.raw-topic-link, a.title"),
        titleLinkInsideRow: !!first.querySelector("a.raw-topic-link[data-topic-id], a.title[data-topic-id]")
      } : null,
      firstTopic: topics[0] ? {
        topicId: topics[0].topicId,
        slug: topics[0].slug,
        title: topics[0].title.slice(0, 40),
        rowTag: topics[0].row?.tagName,
        rowIsLink: topics[0].row?.tagName === "A"
      } : null,
      idSourcesAgree: topics.length > 0 && topics.every((t) => t.topicId === t.row?.dataset.topicId)
    };
  `,

  // 头部账号元素：验证身份兜底选择器在真实站点是否成立。
  headerIdentity: `
    ${HELPERS}
    const candidates = [
      "#current-user",
      "#current-user a",
      ".current-user",
      "header .user-menu",
      "li.user-menu",
      "[id*=current-user]"
    ];
    const found = {};
    for (const sel of candidates) {
      const el = q(sel);
      found[sel] = el
        ? { tag: el.tagName, id: el.id, cls: (el.className || "").toString().slice(0, 80) }
        : null;
    }
    // 找所有指向 /u/ 的链接，看看账号入口长什么样
    const userLinks = qa("a[href^='/u/']").slice(0, 6).map((a) => ({
      text: a.textContent.trim().slice(0, 20),
      href: a.getAttribute("href"),
      cls: (a.className || "").toString().slice(0, 60),
      closestId: a.closest("[id]")?.id ?? null
    }));
    return {
      candidateSelectors: found,
      userLinkCount: qa("a[href^='/u/']").length,
      userLinks,
      htmlClasses: [...document.documentElement.classList]
    };
  `,

  // #current-user 内部结构：定位"当前账号"的可靠 DOM 入口。
  currentUserDetail: `
    ${HELPERS}
    const el = q("#current-user");
    if (!el) return { present: false };
    const links = [...el.querySelectorAll("a")].map((a) => ({
      href: a.getAttribute("href"),
      cls: (a.className || "").toString().slice(0, 60),
      text: a.textContent.trim().slice(0, 20),
      hasAvatar: !!a.querySelector("img")
    }));
    return {
      present: true,
      outerHtmlStart: el.outerHTML.slice(0, 400),
      links,
      dataAttributes: Object.fromEntries([...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => [a.name, a.value])),
      // 备选：头像图的 alt/title 是否含用户名
      avatarImg: (() => {
        const img = el.querySelector("img");
        return img ? { alt: img.alt, title: img.title, src: img.src.slice(0, 80) } : null;
      })()
    };
  `,

  // Discourse 预加载数据：登录态下是否含 currentUser（比 DOM 抓取可靠得多）。
  preloadData: `
    ${HELPERS}
    const el = q("#data-preloaded");
    const attrs = el ? Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 120)])) : null;
    let parsed = null;
    let parseError = null;
    if (el) {
      try {
        parsed = JSON.parse(el.textContent || "{}");
      } catch (error) {
        parseError = String(error);
      }
    }
    const currentUser = parsed?.currentUser ?? null;
    return {
      elementPresent: !!el,
      attributes: attrs,
      textLength: el ? (el.textContent || "").length : 0,
      parseError,
      topLevelKeys: parsed ? Object.keys(parsed).slice(0, 40) : null,
      hasCurrentUser: !!currentUser,
      currentUserSummary: currentUser
        ? { id: currentUser.id ?? null, username: currentUser.username ?? null, keys: Object.keys(currentUser).slice(0, 15) }
        : null
    };
  `,

  // 预加载数据里真正有用的两块：currentUser 与 topicTrackingStates。
  // 后者若可用，新回复检测就能直接读页面已有数据，不必额外请求。
  preloadUseful: `
    ${HELPERS}
    const parsed = JSON.parse(q("#data-preloaded").textContent || "{}");
    // Discourse 的预加载值可能是"被 JSON 编码过的字符串"，需要二次解析。
    const deep = (value) => {
      if (typeof value !== "string") return value;
      try { return JSON.parse(value); } catch { return value; }
    };
    const cu = deep(parsed.currentUser);
    const tts = deep(parsed.topicTrackingStates);
    const meta = deep(parsed.topicTrackingStateMeta);

    const describe = (value) => {
      if (value === null || value === undefined) return { type: String(value) };
      if (Array.isArray(value)) {
        return {
          type: "array",
          length: value.length,
          item0Keys: value[0] && typeof value[0] === "object" ? Object.keys(value[0]).slice(0, 25) : null,
          item1: value[1] === undefined ? null : value[1],
          item0Sample: value[0] && typeof value[0] === "object"
            ? Object.fromEntries(Object.entries(value[0]).slice(0, 12).map(([k, v]) => [k, typeof v === "object" ? "[object]" : String(v).slice(0, 30)]))
            : null
        };
      }
      if (typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 25) };
      return { type: typeof value, value: String(value).slice(0, 60) };
    };

    let trackingSample = null;
    if (Array.isArray(tts)) {
      const withUnread = tts.filter((row) => Number(row.unread_posts ?? row.new_posts ?? 0) > 0);
      trackingSample = {
        totalRows: tts.length,
        rowKeys: tts[0] && typeof tts[0] === "object" ? Object.keys(tts[0]) : null,
        rowsWithUnread: withUnread.length,
        firstThree: tts.slice(0, 3),
        firstThreeWithUnread: withUnread.slice(0, 3)
      };
    } else if (tts && typeof tts === "object") {
      trackingSample = { type: "object", keys: Object.keys(tts).slice(0, 10) };
    }

    return {
      currentUser: cu && typeof cu === "object"
        ? { id: cu.id ?? null, username: cu.username ?? null, name: cu.name ?? null, keys: Object.keys(cu).slice(0, 20) }
        : describe(cu),
      topicTrackingStates: describe(tts),
      trackingSample,
      topicTrackingStateMeta: meta,
      topicListFirstTopic: (() => {
        const t = deep(parsed.topic_list)?.topics?.[0];
        return t ? {
          id: t.id,
          unread_posts: t.unread_posts ?? null,
          last_read_post_number: t.last_read_post_number ?? null,
          highest_post_number: t.highest_post_number ?? null
        } : null;
      })()
    };
  `,

  // 关键验证：页面已加载的 topicTrackingStates 能否替代 /unread.json 的额外请求？
  trackingVsApi: `
    ${HELPERS}
    const deep = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
    const parsed = JSON.parse(q("#data-preloaded").textContent || "{}");
    const tracking = deep(parsed.topicTrackingStates) ?? [];
    const trackingById = new Map(tracking.map((row) => [String(row.topic_id), row]));

    const latest = await json("/latest.json");
    const apiTopics = latest.__ok === false ? [] : (latest.topic_list?.topics ?? []);

    // 页面 DOM 上实际显示的 Topic
    const domIds = qa(".topic-list-item[data-topic-id]").map((r) => r.getAttribute("data-topic-id"));
    const covered = domIds.filter((id) => trackingById.has(id));

    // 只对"跟踪状态里 last_read 非空"的行取样比较，避免大量 null 干扰
    const comparable = apiTopics.filter((t) => trackingById.has(String(t.id)) && trackingById.get(String(t.id)).last_read_post_number != null);
    const unreadFromTracking = (row) => {
      const last = Number(row.last_read_post_number || 0);
      const high = Number(row.highest_post_number || 0);
      return last > 0 && high > last ? high - last : 0;
    };
    const mismatches = comparable.filter((t) => {
      const row = trackingById.get(String(t.id));
      return unreadFromTracking(row) !== Number(t.unread_posts || 0);
    });

    return {
      trackingRows: tracking.length,
      domTopicCount: domIds.length,
      domCoveredByTracking: covered.length,
      domUncovered: domIds.filter((id) => !trackingById.has(id)),
      apiTopicCount: apiTopics.length,
      apiCoveredByTracking: apiTopics.filter((t) => trackingById.has(String(t.id))).length,
      comparedRows: comparable.length,
      unreadMismatchCount: mismatches.length,
      firstMismatches: mismatches.slice(0, 4).map((t) => ({
        id: t.id,
        apiUnread: t.unread_posts,
        trackingUnread: unreadFromTracking(trackingById.get(String(t.id))),
        last: trackingById.get(String(t.id)).last_read_post_number,
        highest: trackingById.get(String(t.id)).highest_post_number
      })),
      // 顺便确认登录后 /latest.json 的字段
      loggedInListFields: apiTopics[0] ? {
        unread_posts: apiTopics[0].unread_posts ?? null,
        last_read_post_number: apiTopics[0].last_read_post_number ?? null,
        highest_post_number: apiTopics[0].highest_post_number ?? null,
        notification_level: apiTopics[0].notification_level ?? null
      } : null
    };
  `,

  // 关键：登录后 /latest.json 到底有多少 Topic 带未读状态？
  // 当前实现的 syncWithDiscourse 完全依赖 unread_posts，若普遍为 null 就等于失效。
  unreadDistribution: `
    ${HELPERS}
    const deep = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
    const latest = await json("/latest.json");
    const unreadList = await json("/unread.json");
    const topics = latest.__ok === false ? [] : (latest.topic_list?.topics ?? []);

    const tally = (pick) => {
      const out = {};
      for (const t of topics) {
        const key = t[pick] === null || t[pick] === undefined ? "null/缺失" : String(t[pick]);
        out[key] = (out[key] || 0) + 1;
      }
      return out;
    };

    const withUnread = topics.filter((t) => Number(t.unread_posts || 0) > 0);
    const withReadPosition = topics.filter((t) => t.last_read_post_number !== null && t.last_read_post_number !== undefined);

    return {
      latestOk: latest.__ok !== false,
      topicCount: topics.length,
      unreadPostsDistribution: tally("unread_posts"),
      lastReadDistribution: tally("last_read_post_number"),
      notificationLevelDistribution: tally("notification_level"),
      withUnreadCount: withUnread.length,
      withReadPositionCount: withReadPosition.length,
      samples: topics.slice(0, 8).map((t) => ({
        id: t.id,
        unread: t.unread_posts ?? null,
        last: t.last_read_post_number ?? null,
        highest: t.highest_post_number ?? null,
        level: t.notification_level ?? null,
        pinned: !!t.pinned
      })),
      unreadEndpoint: unreadList.__ok === false
        ? { ok: false, status: unreadList.__status }
        : {
            ok: true,
            count: unreadList.topic_list?.topics?.length ?? 0,
            perPage: unreadList.topic_list?.per_page ?? null,
            moreUrl: unreadList.topic_list?.more_topics_url ?? null,
            ids: (unreadList.topic_list?.topics ?? []).slice(0, 10).map((t) => ({ id: t.id, unread: t.unread_posts, last: t.last_read_post_number }))
          }
    };
  `,

  // topicTrackingStates 里"真正能算出未读"的行有多少？这是新回复检测的候选数据源。
  trackingUsability: `
    ${HELPERS}
    const deep = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
    const tracking = deep(JSON.parse(q("#data-preloaded").textContent || "{}").topicTrackingStates) ?? [];
    const unreadOf = (r) => {
      const last = Number(r.last_read_post_number || 0);
      const high = Number(r.highest_post_number || 0);
      return last > 0 && high > last ? high - last : 0;
    };
    const unreadList = await json("/unread.json");

    const withRead = tracking.filter((r) => r.last_read_post_number != null);
    const unreadRows = tracking.filter((r) => unreadOf(r) > 0);

    return {
      totalTrackingRows: tracking.length,
      rowsWithReadPosition: withRead.length,
      rowsWithUnread: unreadRows.length,
      unreadSamples: unreadRows.slice(0, 6).map((r) => ({
        id: r.topic_id,
        last: r.last_read_post_number,
        highest: r.highest_post_number,
        unread: unreadOf(r),
        level: r.notification_level
      })),
      readPositionSamples: withRead.slice(0, 4).map((r) => ({
        id: r.topic_id,
        last: r.last_read_post_number,
        highest: r.highest_post_number,
        level: r.notification_level
      })),
      trackingHasUnreadPostsField: tracking[0] ? Object.prototype.hasOwnProperty.call(tracking[0], "unread_posts") : null,
      trackingKeyNames: tracking[0] ? Object.keys(tracking[0]) : null,
      unreadEndpoint: unreadList.__ok === false
        ? { ok: false, status: unreadList.__status }
        : {
            ok: true,
            count: unreadList.topic_list?.topics?.length ?? 0,
            perPage: unreadList.topic_list?.per_page ?? null,
            moreUrl: unreadList.topic_list?.more_topics_url ?? null,
            firstIds: (unreadList.topic_list?.topics ?? []).slice(0, 8).map((t) => t.id)
          }
    };
  `,

  // 分页 / 无限滚动：页面用了哪种机制。
  pagination: `
    ${HELPERS}
    return {
      loadMoreSentinel: !!q(".load-more-sentinel"),
      loadMoreSentinelHtml: q(".load-more-sentinel")?.outerHTML?.slice(0, 200) ?? null,
      infiniteScroll: !!q(".discourse-infinite-scroll"),
      paginationLinks: qa(".pagination a, nav.pagination a").slice(0, 5).map((a) => a.getAttribute("href")),
      scrollContainer: (() => {
        const candidates = [document.scrollingElement, q("#main-outlet"), q(".contents"), q("body")];
        return candidates.map((el) => el ? { tag: el.tagName, id: el.id, cls: cls(el)?.slice(0, 3), scrollHeight: el.scrollHeight, clientHeight: el.clientHeight } : null);
      })()
    };
  `,

  // 未读状态在 DOM 上的呈现方式（判断"滚过不算已读"能否用 DOM 判断）。
  unreadMarkers: `
    ${HELPERS}
    const rows = qa("[data-topic-id]").slice(0, 6);
    return rows.map((row) => ({
      topicId: row.getAttribute("data-topic-id"),
      rowClasses: cls(row),
      titleClasses: cls(row.querySelector("a.title, .title a")),
      hasUnreadBadge: !!row.querySelector(".badge-notification.unread-posts, .unread-posts"),
      unreadBadgeText: row.querySelector(".badge-notification.unread-posts, .unread-posts")?.textContent?.trim() ?? null
    }));
  `
};

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const port = Number(flags.port || 9223);
  const names = flags._.length ? flags._ : ["list"];

  if (names.includes("list")) {
    console.log("可用探针：\n  " + Object.keys(PROBES).join("\n  "));
    if (flags._.length === 0) return 0;
  }

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];

  const output = { page: page.url(), probes: {} };

  for (const name of names) {
    if (name === "list") continue;
    let source = PROBES[name];
    if (!source) {
      output.probes[name] = { error: "未知探针" };
      continue;
    }
    // 需要注入插件源码的探针：读文件后内联，避免在两处维护同一份逻辑。
    if (source.includes("__INJECT_PARSER__")) {
      const parserPath = path.join(LAB_DIR, "..", "linuxdo-personal-feed-manager", "site", "topicParser.js");
      source = source.replace("__INJECT_PARSER__", fs.readFileSync(parserPath, "utf8"));
    }
    try {
      // 探针源码里用了顶层 await，必须包成 async 函数再交给 Playwright。
      const fn = new Function(`return (async () => { ${source} })()`);
      output.probes[name] = await page.evaluate(fn);
    } catch (error) {
      output.probes[name] = { error: String(error).slice(0, 300) };
    }
  }

  console.log(JSON.stringify(output, null, 2));
  await browser.close().catch(() => {});
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error("探针执行失败：", error.message);
  process.exit(1);
});
