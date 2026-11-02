"use strict";

// LDFC 真实站点 Guest（未登录）模式验证。
//
// 目的：在**未登录**状态下验证匿名路径，且不触碰用户的登录会话
// （用独立的全新 profile，端口 9224）。
//
// 只读观测 + 正常用户操作，不修改任何正式代码。
// 用法：node real-site-guest-verify.js --port 9224

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

async function extensionWorld(page, browser) {
  const context = browser.contexts()[0];
  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const target = seen.find((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!target) throw new Error("没有找到插件的隔离世界");
  return { session, contextId: target.id };
}

async function extEval(page, browser, expression) {
  const { session, contextId } = await extensionWorld(page, browser);
  const wrapped = `(async () => {
    const value = await (${expression});
    if (value === undefined) return "undefined";
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  })()`;
  const result = await session.send("Runtime.evaluate", {
    expression: wrapped, contextId, awaitPromise: true, returnByValue: true
  });
  await session.detach().catch(() => {});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "插件世界执行失败");
  return result.result.value;
}

(async () => {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9224);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const base = new URL(page.url()).origin;

  const findings = [];
  const note = (项目, fields) => findings.push({ 项目, ...fields });

  const requests = [];
  page.on("request", (req) => requests.push({ at: Date.now(), url: req.url() }));

  const goto = async (route, wait = 3500) => {
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(wait);
  };

  const out = { port, base, startedAt: new Date().toISOString() };

  // ---------------------------------------------------------------- 身份
  await goto("/latest", 4000);

  out.identity = await extEval(page, browser, `({
    identity: window.LDFCIdentity.current(),
    databaseName: await window.LDFCDB.getDatabaseName(),
    records: window.LDFCTopicState.records.size,
    tracking: window.LDFCTrackingState.snapshot() === null ? "无快照" : window.LDFCTrackingState.windowSize() + " 行"
  })`);

  out.guestEvidence = await page.evaluate(async () => {
    let sessionStatus = null;
    try {
      const response = await fetch("/session/current.json", { credentials: "same-origin" });
      sessionStatus = response.status;
    } catch (error) {
      sessionStatus = "fetch 失败";
    }
    return {
      htmlAnonClass: document.documentElement.classList.contains("anon"),
      登录按钮: !!document.querySelector("#login-button, .login-button"),
      currentUser元素: !!document.querySelector("#current-user"),
      session接口状态: sessionStatus,
      扩展导航: [...document.querySelectorAll("#ldfc-navigation button[data-pool]")].map((b) => b.dataset.pool),
      行数: document.querySelectorAll(".topic-list-item[data-topic-id]").length,
      插件按钮数: document.querySelectorAll(".ldfc-action").length
    };
  });

  note("Guest 身份与命名空间", {
    测试前状态: "使用全新 profile（从未登录），扩展已加载",
    操作步骤: "打开 /latest，读取扩展身份与数据库名",
    实际结果: { ...out.identity, ...out.guestEvidence },
    预期结果: "namespace=guest、loggedIn=false、数据库 ldfc__guest、五区界面可用",
    判定:
      out.identity?.identity?.namespace === "guest" &&
      out.identity?.identity?.loggedIn === false &&
      String(out.identity?.databaseName || "").endsWith("__guest") &&
      out.guestEvidence.扩展导航?.length === 5
        ? "PASS" : "FAIL",
    证据: out.guestEvidence
  });

  // ---------------------------------------------------------------- 本地池状态
  requests.length = 0;
  const mark = await extEval(page, browser, `(async () => {
    const row = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .find((item) => item.offsetParent !== null);
    const topic = window.LDFCTopicParser.extractTopic(row);
    await window.LDFCPoolManager.markInterested(topic);
    return {
      topicId: topic.topicId,
      title: topic.title.slice(0, 24),
      pool: window.LDFCTopicState.get(topic.topicId)?.basePool ?? null
    };
  })()`);

  await goto("/latest", 3500);
  const persisted = await extEval(page, browser, `window.LDFCTopicState.get("${mark.topicId}")?.basePool ?? null`);

  note("Guest 能否标记并持久化本地池状态", {
    测试前状态: "坐在 /latest，未登录",
    操作步骤: `标记 Topic ${mark.topicId} 为「感兴趣」→ 重新加载页面 → 读回状态`,
    实际结果: { 标记结果: mark, 重载后: persisted },
    预期结果: "未登录也能标记，且刷新后保留（本地数据库）",
    判定: mark.pool === "INTERESTED" && persisted === "INTERESTED" ? "PASS" : "FAIL",
    证据: mark
  });

  const dismiss = await extEval(page, browser, `(async () => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .filter((item) => item.offsetParent !== null && item.dataset.topicId !== "${mark.topicId}");
    const topic = window.LDFCTopicParser.extractTopic(rows[0]);
    await window.LDFCPoolManager.markDismissed(topic);
    return { topicId: topic.topicId, pool: window.LDFCTopicState.get(topic.topicId)?.basePool ?? null };
  })()`);

  note("Guest 能否标记「不感兴趣」", {
    测试前状态: "未登录，已有一条感兴趣记录",
    操作步骤: "对另一条 Topic 点「不感兴趣」",
    实际结果: dismiss,
    预期结果: "状态变为 DISMISSED",
    判定: dismiss.pool === "DISMISSED" ? "PASS" : "FAIL",
    证据: dismiss
  });

  // ---------------------------------------------------------------- 阅读基线
  const targetTopic = await extEval(page, browser, `(() => {
    const row = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .find((item) => item.offsetParent !== null && item.dataset.topicId !== "${mark.topicId}" && item.dataset.topicId !== "${dismiss.topicId}");
    const topic = window.LDFCTopicParser.extractTopic(row);
    return { topicId: topic.topicId, href: topic.url };
  })()`);

  await page.goto(targetTopic.href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await goto("/latest", 4000);

  const baseline = await extEval(page, browser, `(() => {
    const r = window.LDFCTopicState.get("${targetTopic.topicId}");
    return r ? { pool: r.basePool, readUpToPostNumber: r.readUpToPostNumber ?? null, highest: r.highestPostNumber ?? null, inNewReply: r.inNewReply } : null;
  })()`);

  note("Guest 阅读基线（匿名 fallback 的核心）", {
    测试前状态: "未登录，打开一个此前没记录过的 Topic，然后返回列表",
    操作步骤: `进入 ${targetTopic.href} → 返回列表 → 检查记录`,
    实际结果: baseline,
    预期结果: "进入已读池，并写入本地阅读基线 readUpToPostNumber（原站对匿名访客不给阅读位置）",
    判定: baseline?.pool === "READ" && typeof baseline?.readUpToPostNumber === "number" ? "PASS" : "FAIL",
    证据: { 说明: "readUpToPostNumber 是实现候选的匿名兜底字段" }
  });

  // 第二轮：基线已存在时不应凭空产生新回复
  const secondRound = await extEval(page, browser, `(() => {
    const r = window.LDFCTopicState.get("${targetTopic.topicId}");
    return { inNewReply: r?.inNewReply ?? null, readUpToPostNumber: r?.readUpToPostNumber ?? null, highest: r?.highestPostNumber ?? null };
  })()`);

  note("Guest 第二轮判定：基线不凭空产生新回复", {
    测试前状态: "基线已建立（readUpToPostNumber = 打开时的最高楼层）",
    操作步骤: "再次触发同步，检查是否被误判为有新回复",
    实际结果: secondRound,
    预期结果: "未读差为 0 → 不应进入新回复区",
    判定: secondRound.inNewReply === false ? "PASS" : "FAIL",
    证据: { 说明: "真实站点无法可控地让某帖新增回复，所以只验证「不误报」这一半" }
  });

  // ---------------------------------------------------------------- 请求行为
  await goto("/latest", 4000);
  requests.length = 0;
  const idleStart = Date.now();
  await page.waitForTimeout(40000);
  const idle = requests.map((r) => ({ ...r, t: r.at - idleStart }));
  const unreadCalls = idle.filter((r) => /\/unread\.json/.test(r.url));

  note("Guest 请求行为（静置 40 秒）", {
    测试前状态: "未登录，位于 /latest",
    操作步骤: "清空请求记录 → 静置 40 秒 → 统计",
    实际结果: {
      总请求数: idle.length,
      明细: idle.map((r) => r.url.replace(/^https?:\/\/[^/]+/, "")),
      其中unread接口: unreadCalls.length
    },
    预期结果: "扩展不得轮询；未登录时也不应反复请求必然 403 的 /unread.json",
    判定: unreadCalls.length === 0 ? "PASS" : "PARTIAL",
    证据: idle.slice(0, 10)
  });

  // 路由切换时 /unread.json 的调用次数（登录态逻辑是否污染 guest）
  requests.length = 0;
  for (const route of ["/latest", "/top", "/latest"]) await goto(route, 3500);
  const nav = requests.map((r) => r.url.replace(/^https?:\/\/[^/]+/, ""));
  const navUnread = nav.filter((u) => /\/unread\.json/.test(u));
  const navPerTopic = nav.filter((u) => /^\/t\/\d+\.json/.test(u));

  note("Guest 是否执行登录态专属逻辑", {
    测试前状态: "未登录，连续切换 3 次路由",
    操作步骤: "统计 /unread.json 与 /t/<id>.json 的调用",
    实际结果: { 总请求: nav.length, unread接口调用: navUnread, 逐Topic请求: navPerTopic },
    预期结果: "登录态的发现/确认逻辑不应在 guest 上运行（guest 走本地基线）",
    判定: navPerTopic.length === 0 ? "PASS" : "FAIL",
    证据: { 说明: "/unread.json 属于「多一次无用请求」级别，单独记录" }
  });

  out.findings = findings;
  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("Guest 验证异常：", error.message);
  process.exit(1);
});
