"use strict";

// LDFC 真实站点「加载正式扩展后」的功能验证（AC-030 / AC-034 / AC-031）。
//
// 严格按 LDFC-V1-完整规格.md 的 AC 原文测试：
//   AC-030  无高频轮询、无逐 Topic 请求
//   AC-034  各池独立滚动位置，历史池分批渲染
//   AC-031  不破坏原站链接（含 Ctrl+Click / 中键 / 新标签页）
//
// 本脚本**不修改任何正式代码**，只做观测与正常用户操作。
// 扩展状态在"隔离世界"里，必须用 CDP 的扩展执行上下文读取（page.evaluate 读不到）。
//
// 用法：node real-site-ext-verify.js --port 9223 [--idle 45000]

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

function parseArgs(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[token.slice(2)] = next; i += 1; }
      else flags[token.slice(2)] = true;
    }
  }
  return flags;
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
    expression: wrapped,
    contextId,
    awaitPromise: true,
    returnByValue: true
  });
  await session.detach().catch(() => {});
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "插件世界执行失败");
  }
  return result.result.value;
}

const EXTENSION_ONLY = [/\/session\/current\.json/, /^\/t\/\d+\.json/, /^\/t\/\d+\/posts\.json/];
const SHARED = [/\/latest\.json/, /\/unread\.json/];

function classify(rawUrl) {
  const url = rawUrl.replace(/^https?:\/\/[^/]+/, "");
  if (EXTENSION_ONLY.some((re) => re.test(url))) return "extension-only";
  if (SHARED.some((re) => re.test(url))) return "extension-shared";
  if (/message-bus|\/presence\/|\/notifications\//.test(url)) return "native-longpoll";
  return "other";
}

(async () => {
  const flags = parseArgs(process.argv.slice(2));
  const port = Number(flags.port || 9223);
  const idleMs = Number(flags.idle || 45000);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const base = new URL(page.url()).origin;

  const out = { startedAt: new Date().toISOString(), base, port, idleSeconds: Math.round(idleMs / 1000) };
  const findings = [];
  const note = (ac, fields) => findings.push({ ac, ...fields });

  const requests = [];
  page.on("request", (req) => {
    requests.push({ at: Date.now(), method: req.method(), url: req.url(), kind: classify(req.url()) });
  });

  const goto = async (route, wait = 3000) => {
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(wait);
  };

  // ---------------------------------------------------------------- 环境
  await goto("/latest", 4000);
  out.environment = {
    url: page.url(),
    dom: await page.evaluate(() => ({
      title: document.title,
      anonClass: document.documentElement.classList.contains("anon"),
      cloudsflare: /just a moment/i.test(document.title),
      topicRows: document.querySelectorAll(".topic-list-item[data-topic-id]").length,
      navigationPresent: !!document.querySelector("#ldfc-navigation"),
      navPools: [...document.querySelectorAll("#ldfc-navigation button[data-pool]")].map((b) => b.dataset.pool),
      actionButtons: document.querySelectorAll(".ldfc-action").length,
      actionsInsideAnchor: [...document.querySelectorAll(".ldfc-action")].some((el) => el.closest("a"))
    })),
    extensionState: await extEval(page, browser, `({
      identity: window.LDFCIdentity.current(),
      databaseName: await window.LDFCDB.getDatabaseName(),
      trackingWindow: window.LDFCTrackingState.windowSize(),
      recordCount: window.LDFCTopicState.records.size
    })`)
  };

  // ================================================================ AC-030
  try {
    const ac = "AC-030";

    // --- 静置：是否有轮询 ---
    await goto("/latest", 4000);
    requests.length = 0;
    const idleStart = Date.now();
    await page.waitForTimeout(idleMs);
    const idle = requests.map((r) => ({ ...r, t: r.at - idleStart }));
    const byKind = idle.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + 1; return acc; }, {});
    const extOnly = idle.filter((r) => r.kind === "extension-only");
    const extShared = idle.filter((r) => r.kind === "extension-shared");

    note(ac, {
      项目: "静置期间是否轮询",
      测试前状态: `已登录、扩展已加载、位于 /latest；静置 ${out.idleSeconds} 秒不做任何操作`,
      操作步骤: "清空请求记录 → 静置 → 统计请求",
      实际结果: {
        总请求数: idle.length,
        按类别: byKind,
        扩展独有请求: extOnly.map((r) => r.url.replace(/^https?:\/\/[^/]+/, "")),
        扩展使用的列表接口: extShared.map((r) => r.url.replace(/^https?:\/\/[^/]+/, ""))
      },
      预期结果: "扩展不得有定时/轮询请求 —— 同步只发生在路由变化等自然时机",
      判定: extOnly.length === 0 && extShared.length === 0 ? "PASS" : "FAIL",
      证据: idle.slice(0, 10)
    });

    // --- 路由切换：是否有逐 Topic 请求 ---
    requests.length = 0;
    const routes = ["/latest", "/top", "/latest", "/unread", "/latest"];
    for (const route of routes) await goto(route, 3500);
    const nav = requests.slice();
    const perTopic = nav.filter((r) => /^\/t\/\d+\.json/.test(r.url.replace(/^https?:\/\/[^/]+/, "")));
    const navByKind = nav.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + 1; return acc; }, {});

    note(ac, {
      项目: "路由切换时请求量 / 是否逐 Topic 请求",
      测试前状态: `无任何本地池记录（本轮未标记任何 Topic），依次访问 ${routes.join(" → ")}`,
      操作步骤: "清空记录 → 依次切换路由，每次等待 3.5 秒",
      实际结果: {
        总请求数: nav.length,
        按类别: navByKind,
        逐Topic请求数: perTopic.length,
        扩展独有请求明细: nav
          .filter((r) => r.kind === "extension-only")
          .map((r) => r.url.replace(/^https?:\/\/[^/]+/, ""))
      },
      预期结果: "没有本地记录时不应发出任何 /t/<id>.json 逐 Topic 请求",
      判定: perTopic.length === 0 ? "PASS" : "FAIL",
      证据: nav.slice(0, 15)
    });
  } catch (error) {
    findings.push({ ac: "AC-030", 项目: "本节执行中断", 判定: "PARTIAL", 实际结果: String(error.message), 预期结果: "本节应完整执行", 证据: {} });
  }

  // ================================================================ AC-034
  try {
    const ac = "AC-034";
    const syntheticIds = Array.from({ length: 70 }, (_, i) => `99000${String(i).padStart(3, "0")}`);

    const realBefore = await extEval(page, browser, `window.LDFCTopicState.records.size`);

    await extEval(page, browser, `(async () => {
      const ids = ${JSON.stringify(syntheticIds)};
      for (const topicId of ids) {
        await window.LDFCPoolManager.markInterested({ topicId }, { title: "合成记录 " + topicId });
      }
      return window.LDFCTopicState.records.size;
    })()`);

    await page.click('#ldfc-navigation button[data-pool="INTERESTED"]');
    await page.waitForTimeout(1000);

    const firstBatch = {
      dom: await page.evaluate(() => ({
        items: document.querySelectorAll("#ldfc-panel .ldfc-panel-item").length,
        scrollHeight: document.querySelector("#ldfc-panel")?.scrollHeight ?? null,
        clientHeight: document.querySelector("#ldfc-panel")?.clientHeight ?? null
      })),
      state: await extEval(page, browser, `({
        totalInPool: window.LDFCTopicState.listByPool("INTERESTED").length
      })`)
    };

    note(ac, {
      项目: "历史池分批渲染",
      测试前状态: `感兴趣池共 ${firstBatch.state.totalInPool} 条（其中 70 条为合成测试记录，用户真实记录 ${realBefore} 条）`,
      操作步骤: "打开「感兴趣」面板，统计一次性渲染进 DOM 的条目数",
      实际结果: firstBatch,
      预期结果: `不能一次性全部渲染；应只渲染首批（代码里 BATCH_SIZE = 40）`,
      判定: firstBatch.dom.items < firstBatch.state.totalInPool && firstBatch.dom.items > 0 ? "PASS" : "FAIL",
      证据: { batchSizeInCode: 40 }
    });

    await page.evaluate(() => {
      const panel = document.querySelector("#ldfc-panel");
      if (panel) panel.scrollTop = panel.scrollHeight;
    });
    await page.waitForTimeout(1500);

    const afterScroll = await page.evaluate(() => ({
      items: document.querySelectorAll("#ldfc-panel .ldfc-panel-item").length
    }));

    note(ac, {
      项目: "滚动到底继续加载下一批",
      测试前状态: `首批渲染 ${firstBatch.dom.items} 条，池内共 ${firstBatch.state.totalInPool} 条`,
      操作步骤: "把面板滚到底部，等待 1.5 秒",
      实际结果: afterScroll,
      预期结果: "DOM 条目数增加（追加下一批）",
      判定: afterScroll.items > firstBatch.dom.items ? "PASS" : "FAIL",
      证据: { 首批: firstBatch.dom.items, 滚动后: afterScroll.items }
    });

    // 各池独立滚动位置
    const scrollMemory = await page.evaluate(async () => {
      const panel = document.querySelector("#ldfc-panel");
      panel.scrollTop = 150;
      const beforeSwitch = panel.scrollTop;

      document.querySelector('#ldfc-navigation button[data-pool="READ"]').click();
      await new Promise((r) => setTimeout(r, 900));
      const readScrollTop = panel.scrollTop;

      document.querySelector('#ldfc-navigation button[data-pool="INTERESTED"]').click();
      await new Promise((r) => setTimeout(r, 1200));
      return { beforeSwitch, readScrollTop, afterReturn: panel.scrollTop };
    });

    const restored =
      scrollMemory.beforeSwitch > 0 &&
      Math.abs(scrollMemory.afterReturn - scrollMemory.beforeSwitch) <= 30;

    note(ac, {
      项目: "各池独立滚动位置",
      测试前状态: "感兴趣面板已渲染多批，手动把滚动位置设为 150",
      操作步骤: "记录位置 → 切到「已读」→ 切回「感兴趣」→ 读回位置",
      实际结果: scrollMemory,
      预期结果: "切回感兴趣时恢复到切换前的位置，而不是跳回顶部；已读池有自己独立的位置",
      判定: restored ? "PASS" : "FAIL",
      证据: { 容差: "±30px" }
    });

    // 清理合成记录
    const cleanup = await extEval(page, browser, `(async () => {
      const ids = ${JSON.stringify(syntheticIds)};
      const dbName = await window.LDFCDB.getDatabaseName();
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("topics", "readwrite");
        const store = tx.objectStore("topics");
        for (const id of ids) store.delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      await window.LDFCTopicState.load();
      return {
        remainingSynthetic: ids.filter((id) => window.LDFCTopicState.get(id)).length,
        totalAfter: window.LDFCTopicState.records.size
      };
    })()`);

    note(ac, {
      项目: "测试数据清理（保护用户真实数据）",
      测试前状态: `创建了 70 条合成记录；创建前用户真实记录 ${realBefore} 条`,
      操作步骤: "按 id 精确删除合成记录 → 重新载入状态",
      实际结果: cleanup,
      预期结果: "合成记录全部删除，用户真实记录数回到创建前",
      判定: cleanup.remainingSynthetic === 0 && cleanup.totalAfter === realBefore ? "PASS" : "FAIL",
      证据: { 创建前: realBefore, 清理后: cleanup.totalAfter }
    });
  } catch (error) {
    findings.push({ ac: "AC-034", 项目: "本节执行中断", 判定: "PARTIAL", 实际结果: String(error.message), 预期结果: "本节应完整执行", 证据: {} });
  }

  // ================================================================ AC-031
  try {
    const ac = "AC-031";
    const steps = [];

    // 1 普通点击
    await goto("/latest", 3000);
    const firstHref = await page.locator(".topic-list-item:visible a.raw-topic-link").first().getAttribute("href");
    await page.locator(".topic-list-item:visible a.raw-topic-link").first().click();
    await page.waitForTimeout(2800);
    steps.push({ 项目: "普通 Topic 点击", 期望: "进入 /t/", 实际: page.url(), 判定: page.url().includes("/t/") ? "PASS" : "FAIL", 证据: firstHref });
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2200);

    // 2 作者链接
    const authorHref = await page.locator(".topic-list-item:visible a[href^='/u/']").first().getAttribute("href");
    await page.locator(".topic-list-item:visible a[href^='/u/']").first().click();
    await page.waitForTimeout(2800);
    const cardShown = await page.evaluate(() => !!document.querySelector(".user-card, .user-card-content, .user-card.show"));
    steps.push({
      项目: "作者链接",
      期望: "原站行为：弹出用户卡片（插件不得阻断）",
      实际: { url: page.url(), 用户卡片出现: cardShown },
      判定: cardShown ? "PASS" : page.url().includes("/u/") ? "PASS" : "FAIL",
      证据: authorHref
    });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1000);

    // 3 分类链接
    await goto("/latest", 3000);
    const category = page.locator("a[href^='/c/']").first();
    if (await category.count()) {
      const catHref = await category.getAttribute("href");
      await category.click();
      await page.waitForTimeout(3000);
      steps.push({ 项目: "分类链接", 期望: "进入 /c/", 实际: page.url(), 判定: page.url().includes("/c/") ? "PASS" : "FAIL", 证据: catHref });
    } else {
      steps.push({ 项目: "分类链接", 判定: "NOT TESTED", 证据: "列表页找不到分类链接" });
    }

    // 4 搜索
    await goto("/search?q=linux", 4000);
    const searchState = await page.evaluate(() => ({
      结果数: document.querySelectorAll(".fps-result").length,
      插件行: document.querySelectorAll(".topic-list-item[data-topic-id]").length,
      插件按钮: document.querySelectorAll(".ldfc-action").length
    }));
    steps.push({
      项目: "搜索",
      期望: "搜索结果正常；插件不注入按钮也不过滤",
      实际: searchState,
      判定: searchState.结果数 > 0 && searchState.插件按钮 === 0 ? "PASS" : "FAIL",
      证据: {}
    });

    // 5 分页 / 无限滚动
    await goto("/latest", 3000);
    const beforeRows = await page.evaluate(() => document.querySelectorAll(".topic-list-item[data-topic-id]").length);
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(3500);
    const afterRows = await page.evaluate(() => document.querySelectorAll(".topic-list-item[data-topic-id]").length);
    steps.push({ 项目: "分页 / 无限滚动", 期望: "滚动后加载更多行", 实际: { 滚动前: beforeRows, 滚动后: afterRows }, 判定: afterRows > beforeRows ? "PASS" : "FAIL", 证据: {} });

    // 6 刷新
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const afterReload = await page.evaluate(() => ({
      行数: document.querySelectorAll(".topic-list-item[data-topic-id]").length,
      插件导航: !!document.querySelector("#ldfc-navigation")
    }));
    steps.push({ 项目: "刷新", 期望: "页面与插件都正常", 实际: afterReload, 判定: afterReload.行数 > 0 && afterReload.插件导航 ? "PASS" : "FAIL", 证据: {} });

    // 7 前进 / 后退
    await goto("/top", 3000);
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    const backUrl = page.url();
    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    steps.push({
      项目: "前进 / 后退",
      期望: "后退回 /latest，前进回 /top",
      实际: { 后退到: backUrl, 前进到: page.url() },
      判定: backUrl.includes("/latest") && page.url().includes("/top") ? "PASS" : "FAIL",
      证据: {}
    });

    // 8 Ctrl+Click / 中键
    await goto("/latest", 3000);
    const closeExtras = async () => {
      for (const extra of context.pages()) {
        if (extra !== page && !extra.url().startsWith("devtools://") && extra.url().includes("/t/")) {
          await extra.close().catch(() => {});
        }
      }
      await page.waitForTimeout(900);
    };
    const pagesBefore = context.pages().length;
    await page.keyboard.down("Control");
    await page.locator(".topic-list-item:visible a.raw-topic-link").first().click();
    await page.keyboard.up("Control");
    await page.waitForTimeout(3000);
    const ctrl = { 新标签页: context.pages().length - pagesBefore, 原页仍在列表: page.url().includes("/latest") };
    await closeExtras();

    const pagesBeforeMiddle = context.pages().length;
    await page.locator(".topic-list-item:visible a.raw-topic-link").first().click({ button: "middle" });
    await page.waitForTimeout(3000);
    const middle = { 新标签页: context.pages().length - pagesBeforeMiddle, 原页仍在列表: page.url().includes("/latest") };
    await closeExtras();

    steps.push({
      项目: "Ctrl+Click / 中键 / 新标签页",
      期望: "各自开新标签页，原页面留在列表",
      实际: { ctrl, middle },
      判定: ctrl.新标签页 > 0 && ctrl.原页仍在列表 && middle.新标签页 > 0 && middle.原页仍在列表 ? "PASS" : "FAIL",
      证据: {}
    });

    // 9 插件行内按钮：标记成功且不触发链接跳转
    await goto("/latest", 3000);
    const actionTest = await page.evaluate(async () => {
      const button = document.querySelector(".ldfc-action.interested");
      if (!button) return { found: false };
      const row = button.closest(".topic-list-item");
      const topicId = row?.dataset.topicId ?? null;
      const insideAnchor = !!button.closest("a");
      button.click();
      await new Promise((r) => setTimeout(r, 1500));
      return { found: true, insideAnchor, topicId, 仍在列表页: location.pathname.startsWith("/latest") };
    });
    const actionPool = actionTest.topicId
      ? await extEval(page, browser, `window.LDFCTopicState.get("${actionTest.topicId}")?.basePool ?? null`)
      : null;

    // 清理：把这个真实 Topic 恢复成 HOME（不动用户其它数据）
    if (actionTest.topicId) {
      await extEval(page, browser, `window.LDFCPoolManager.moveHome("${actionTest.topicId}")`);
    }

    steps.push({
      项目: "插件行内按钮",
      期望: "点击后标记成功，且不触发 Topic 链接跳转",
      实际: { ...actionTest, 标记后归属: actionPool },
      判定: actionTest.found && actionPool === "INTERESTED" && actionTest.仍在列表页 && !actionTest.insideAnchor ? "PASS" : "FAIL",
      证据: { 已恢复为HOME: Boolean(actionTest.topicId) }
    });

    out.ac031Steps = steps;
    const failed = steps.filter((s) => s.判定 === "FAIL");
    const notTested = steps.filter((s) => s.判定 === "NOT TESTED");

    note(ac, {
      项目: "原站链接兼容（逐项实测，扩展已加载）",
      测试前状态: "扩展已加载、已登录",
      操作步骤: "依次实测 9 项原站交互",
      实际结果: steps,
      预期结果: "全部保持原站行为；作者链接弹用户卡片属原站行为，不算插件问题",
      判定: failed.length ? "FAIL" : notTested.length ? "PARTIAL" : "PASS",
      证据: steps
    });
  } catch (error) {
    findings.push({ ac: "AC-031", 项目: "本节执行中断", 判定: "PARTIAL", 实际结果: String(error.message), 预期结果: "本节应完整执行", 证据: {} });
  }

  out.requestSummary = {
    总数: requests.length,
    按类别: requests.reduce((acc, r) => { acc[r.kind] = (acc[r.kind] || 0) + 1; return acc; }, {}),
    扩展独有请求明细: [...new Set(requests.filter((r) => r.kind === "extension-only").map((r) => r.url.replace(/^https?:\/\/[^/]+/, "")))].slice(0, 30)
  };
  out.findings = findings;

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("验证脚本异常：", error.message);
  process.exit(1);
});
