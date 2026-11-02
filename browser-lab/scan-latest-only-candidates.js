"use strict";

// 发现层新来源（/latest.json 非 null unread_posts）的候选扫描 —— 纯只读。
//
// 要证明的命题：
//   某个 Topic 必须依赖"新增的 /latest.json 信号"才能被发现，
//   即它同时满足：
//     ① /latest.json 第一页包含它，且 unread_posts 是有效 number > 0
//     ② 不在 topicTrackingStates 里
//     ③ 不在 /unread.json 第 0 页
//
// 只读约束：
//   - 不打开任何 Topic
//   - 不改变任何已读状态
//   - 不翻页（只用 /latest.json 第 0 页 + /unread.json 第 0 页 + 页面已加载的 tracking）
//   - 不修改代码
//
// 用法：node scan-latest-only-candidates.js --port=9223

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

const SCAN = `(async () => {
  const deep = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };

  // ① /latest.json 第 0 页
  const latest = await fetch("/latest.json", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const latestTopics = latest?.topic_list?.topics ?? [];

  // ③ /unread.json 第 0 页
  const unread = await fetch("/unread.json", { credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const unreadIds = new Set(((unread?.topic_list?.topics) ?? []).map((t) => String(t.id)));

  // ② 页面已加载的 tracking 快照（零请求）
  let trackingIds = new Set();
  let trackingRows = 0;
  try {
    const el = document.getElementById("data-preloaded");
    const rows = deep(JSON.parse(el.textContent || "{}").topicTrackingStates) ?? [];
    trackingRows = rows.length;
    trackingIds = new Set(rows.map((r) => String(r.topic_id)));
  } catch { /* 没有快照就按空处理 */ }

  // 本地池状态（只读）
  const localPool = (id) => {
    try { return window.LDFCTopicState?.get?.(id)?.basePool ?? null; } catch { return null; }
  };

  const withUnreadField = latestTopics.filter((t) => typeof t.unread_posts === "number");
  const withUnreadPositive = latestTopics.filter((t) => typeof t.unread_posts === "number" && t.unread_posts > 0);

  const rows = withUnreadField.map((t) => {
    const id = String(t.id);
    return {
      topicId: id,
      title: (t.title || "").slice(0, 40),
      latestUnreadPosts: t.unread_posts,
      latestLastRead: t.last_read_post_number ?? null,
      latestHighest: t.highest_post_number ?? null,
      inTracking: trackingIds.has(id),
      inUnreadPage0: unreadIds.has(id),
      本地basePool: localPool(id)
    };
  });

  const candidates = rows.filter(
    (r) => r.latestUnreadPosts > 0 && !r.inTracking && !r.inUnreadPage0
  );

  return JSON.stringify({
    概览: {
      latest第一页条数: latestTopics.length,
      其中带数值型unread_posts的: withUnreadField.length,
      其中unread_posts大于0的: withUnreadPositive.length,
      tracking快照行数: trackingRows,
      未读第0页条数: unreadIds.size,
      本地记录数: window.LDFCTopicState ? window.LDFCTopicState.records.size : null
    },
    全部带未读数值的Topic: rows,
    可验证候选: candidates
  }, null, 1);
})()`;

(async () => {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9223);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];

  await page.goto("https://linux.do/latest", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);

  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const target = seen.find((item) => (item.origin || "").startsWith("chrome-extension://"));

  // 优先在插件隔离世界里跑（能读本地池状态）；读不到就退回主世界。
  const result = target
    ? await session.send("Runtime.evaluate", { expression: SCAN, contextId: target.id, awaitPromise: true, returnByValue: true })
    : await page.evaluate(SCAN);
  const value = target ? result.result.value : result;

  await session.detach().catch(() => {});
  console.log(value);
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("扫描失败：", error.message);
  process.exit(1);
});
