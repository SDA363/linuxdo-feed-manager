"use strict";

// P0-1 / P0-2 证据采集（只读）。
//
// 要回答的问题：
//   P0-1  topicTrackingStates 的字段语义是否与"当前未读状态"一致？
//         覆盖范围多大？与 /unread.json 是否一致？在别的路由是否也存在？
//   P0-2  /unread.json 的分页真实行为？能否用有限请求确认某个 Topic 真的 unread=0？
//         登录态下 /t/<id>.json 到不到阅读字段？
//
// 网络请求总量：约 10 次，全部是原站本来就有的 JSON 接口。
//
// 用法：node real-site-p0-evidence.js --port=9223

const fs = require("node:fs");
const path = require("node:path");

function loadPlaywright() {
  const candidates = [];
  const home = process.env.USERPROFILE || process.env.HOME || "C:/Users/asddn";
  const cuaRoot = path.join(home, "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node");
  try {
    for (const v of fs.readdirSync(cuaRoot)) candidates.push(path.join(cuaRoot, v, "bin", "node_modules", "playwright"));
  } catch {}
  candidates.push("playwright");
  for (const c of candidates) { try { return require(c); } catch {} }
  throw new Error("找不到 Playwright");
}

// 注入到页面里复用的工具（字符串形式，便于用 new Function 执行）。
const HELPERS = `
  const deep = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
  const json = async (url) => {
    try {
      const r = await fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } });
      if (!r.ok) return { __status: r.status, __ok: false };
      return await r.json();
    } catch (e) { return { __status: 0, __ok: false, __error: String(e) }; }
  };
  const trackingRows = () => {
    const el = document.querySelector("#data-preloaded");
    if (!el) return null;
    try { return deep(JSON.parse(el.textContent || "{}").topicTrackingStates) ?? null; } catch { return null; }
  };
  const unreadOf = (r) => {
    const last = Number(r.last_read_post_number || 0);
    const high = Number(r.highest_post_number || 0);
    return last > 0 && high > last ? high - last : 0;
  };
`;

const PROBES = {
  trackingVsUnread: `
    ${HELPERS}
    const tracking = trackingRows() ?? [];
    const page0 = await json("/unread.json");
    const apiTopics = page0.topic_list?.topics ?? [];
    const apiIds = new Set(apiTopics.map((t) => String(t.id)));

    const trackingUnread = tracking.filter((r) => unreadOf(r) > 0);
    const trackingIds = new Set(trackingUnread.map((r) => String(r.topic_id)));

    const inBoth = [...trackingIds].filter((id) => apiIds.has(id));
    const onlyTracking = [...trackingIds].filter((id) => !apiIds.has(id));
    const onlyApi = [...apiIds].filter((id) => !trackingIds.has(id));

    const apiById = new Map(apiTopics.map((t) => [String(t.id), t]));
    const comparisons = inBoth.slice(0, 8).map((id) => {
      const row = trackingUnread.find((r) => String(r.topic_id) === id);
      return {
        id,
        trackingUnread: unreadOf(row),
        apiUnread: apiById.get(id).unread_posts ?? null,
        trackingLast: row.last_read_post_number,
        apiLast: apiById.get(id).last_read_post_number ?? null,
        trackingHighest: row.highest_post_number,
        apiHighest: apiById.get(id).highest_post_number ?? null
      };
    });
    const bad = comparisons.filter((c) => c.trackingUnread !== c.apiUnread || c.trackingLast !== c.apiLast);

    return {
      trackingTotalRows: tracking.length,
      trackingRowsWithUnread: trackingUnread.length,
      unreadApiPage0Count: apiIds.size,
      apiMoreTopicsUrl: page0.topic_list?.more_topics_url ?? null,
      intersection: inBoth.length,
      onlyInTracking: onlyTracking.length,
      onlyInTrackingSample: onlyTracking.slice(0, 6),
      onlyInApiPage0: onlyApi.length,
      onlyInApiPage0Sample: onlyApi.slice(0, 6),
      comparisons,
      comparisonMismatches: bad.length
    };
  `,

  unreadPagination: `
    ${HELPERS}
    const p0 = await json("/unread.json");
    const p1 = await json("/unread.json?page=1");
    const p2 = await json("/unread.json?page=2");
    const ids = (p) => (p.__ok === false ? [] : (p.topic_list?.topics ?? []).map((t) => String(t.id)));
    const a = ids(p0), b = ids(p1), c = ids(p2);
    return {
      page0: { ok: p0.__ok !== false, count: a.length, perPage: p0.topic_list?.per_page ?? null, more: p0.topic_list?.more_topics_url ?? null },
      page1: { ok: p1.__ok !== false, status: p1.__status ?? null, count: b.length, more: p1.topic_list?.more_topics_url ?? null },
      page2: { ok: p2.__ok !== false, status: p2.__status ?? null, count: c.length, more: p2.topic_list?.more_topics_url ?? null },
      overlap0and1: a.filter((id) => b.includes(id)).length,
      overlap1and2: b.filter((id) => c.includes(id)).length,
      paginationWorks: a.length > 0 && b.length > 0 && a.filter((id) => b.includes(id)).length === 0
    };
  `,

  loggedInTopicDetail: `
    ${HELPERS}
    const tracking = trackingRows() ?? [];
    const targets = tracking.filter((r) => unreadOf(r) > 0).slice(0, 2).map((r) => ({
      id: String(r.topic_id), trackingUnread: unreadOf(r), trackingLast: r.last_read_post_number, trackingHighest: r.highest_post_number
    }));
    const results = [];
    for (const t of targets) {
      const p = await json("/t/" + t.id + ".json");
      results.push(p.__ok === false
        ? { ...t, ok: false, status: p.__status }
        : {
            ...t, ok: true,
            hasLastReadKey: Object.prototype.hasOwnProperty.call(p, "last_read_post_number"),
            hasUnreadKey: Object.prototype.hasOwnProperty.call(p, "unread_posts"),
            last_read_post_number: p.last_read_post_number ?? null,
            unread_posts: p.unread_posts ?? null,
            highest_post_number: p.highest_post_number ?? null,
            current_post_number: p.current_post_number ?? null,
            notification_level: p.notification_level ?? null
          });
    }
    return results;
  `,

  trackingHere: `
    ${HELPERS}
    const t = trackingRows();
    return {
      preloadedPresent: !!document.querySelector("#data-preloaded"),
      tracking: t === null ? null : { rows: t.length, rowsWithUnread: t.filter((r) => unreadOf(r) > 0).length },
      topicRowsOnPage: document.querySelectorAll(".topic-list-item[data-topic-id]").length,
      path: location.pathname
    };
  `
};

async function runProbe(page, name) {
  const source = PROBES[name];
  const fn = new Function(`return (async () => { ${source} })()`);
  return page.evaluate(fn);
}

(async () => {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9223);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const base = new URL(page.url()).origin;
  const out = {};

  await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  out.A_trackingVsUnread = await runProbe(page, "trackingVsUnread");
  out.B_unreadPagination = await runProbe(page, "unreadPagination");
  out.C_loggedInTopicDetail = await runProbe(page, "loggedInTopicDetail");

  out.D_trackingOnOtherRoutes = {};
  for (const route of ["/top", "/unread", "/c/develop", "/t/534735"]) {
    try {
      await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2200);
      out.D_trackingOnOtherRoutes[route] = await runProbe(page, "trackingHere");
    } catch (error) {
      out.D_trackingOnOtherRoutes[route] = { error: String(error).slice(0, 150) };
    }
  }

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("采集失败：", error.message);
  process.exit(1);
});
