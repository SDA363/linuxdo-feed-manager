"use strict";

// LDFC（Linux.do Personal Feed Manager）插件自动验收脚本。
//
// 前提：浏览器已通过 browser.js start 启动，并且加载了待验收的插件目录。
//   node prepare-probe-ext.js && node probe-server.js
//   node browser.js start --ext "D:/桌面/codex/linuxdo插件/browser-lab/.probe-ext" --url "http://127.0.0.1:8123/"
//
// 用法：
//   node run-ldfc-acceptance.js [--url <页面地址>] [--port 9222] [--keep-state]

const fs = require("node:fs");
const path = require("node:path");

const LAB_DIR = __dirname;
const DEFAULT_URL = "http://127.0.0.1:8123/";

// 放在模块作用域，脚本中途抛错时也能把已完成/已失败的项目打印出来，
// 否则只能看到一句异常。
const results = [];
const record = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

function report() {
  const failed = results.filter((line) => line.startsWith("FAIL"));
  console.log("\n===== 验收结果 =====");
  for (const line of results) console.log(line);
  console.log(`\n汇总：${results.filter((line) => line.startsWith("PASS")).length} 项通过，${failed.length} 项失败`);
  return failed.length;
}

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
      // 试下一个
    }
  }
  throw new Error("找不到 Playwright 模块");
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const name = token.slice(2);
    if (name === "keep-state") {
      flags[name] = true;
      continue;
    }
    flags[name] = argv[index + 1];
    index += 1;
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
  const candidates = seen.filter((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!candidates.length) throw new Error("没有找到插件的隔离世界（isolated world）");
  // 插件被重复加载时页面上会有多个隔离世界，其中有些是空的。
  // 只认真正挂了 LDFC 全局的那个，否则会挑到空世界、报 "LDFCDB 未定义"。
  for (const candidate of candidates) {
    try {
      const probe = await session.send("Runtime.evaluate", {
        expression: "typeof window.LDFCDB",
        contextId: candidate.id,
        returnByValue: true
      });
      if (probe.result.value === "object") return { session, contextId: candidate.id };
    } catch {
      // 试下一个
    }
  }
  return { session, contextId: candidates[0].id };
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
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "插件世界执行失败");
  }
  return result.result.value;
}

async function waitForNavigation(page, timeout = 20000) {
  await page.waitForSelector("#ldfc-navigation", { timeout });
  // 导航可以被用户折叠成悬浮球，而且折叠状态是持久化的（可能来自上一轮）。
  // 下面的断言都按展开态写，先确保它是展开的，否则池子按钮点不到。
  await page.evaluate(() => {
    const nav = document.querySelector("#ldfc-navigation");
    if (nav?.dataset.collapsed === "true") nav.querySelector(".ldfc-nav-fab")?.click();
  });
}

// 新版导航「点面板外部自动收起」，所以每次切池子前都要先确保面板是展开的。
async function clickNavPool(page, pool) {
  await waitForNavigation(page);
  await page.click(`#ldfc-navigation button[data-pool="${pool}"]`);
}

// 轮询插件世界里的状态，直到符合预期或超时。
// 同步逻辑是异步 + 有限次重试，写死 sleep 既慢又不稳。
async function waitForValue(page, browser, expression, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await extEval(page, browser, expression);
    if (predicate(last)) return last;
    await page.waitForTimeout(300);
  }
  return last;
}

// 先尝试真实点击；若被固定定位元素遮挡，则回退到 DOM 事件派发，
// 并把使用的方式记录下来（供人工判断是否需要调整布局）。
async function robustClick(locator, note) {
  try {
    await locator.click({ timeout: 3000 });
    return `${note}：真实点击`;
  } catch {
    await locator.dispatchEvent("click");
    return `${note}：DOM 事件派发（按钮被页面上的固定元素遮挡）`;
  }
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const url = flags.url || DEFAULT_URL;
  const port = Number(flags.port || process.env.BROWSER_LAB_PORT || 9222);
  const endpoint = `http://127.0.0.1:${port}`;
  const topicUrl = (suffix) => new URL(suffix, url).href;

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!page) throw new Error("浏览器里没有页面，先用 browser.js start 打开页面");

  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const location = message.location() || {};
    const source = location.url || "";
    consoleErrors.push({
      text: message.text(),
      source,
      fromExtension: source.startsWith("chrome-extension://")
    });
  });
  page.on("pageerror", (error) => {
    consoleErrors.push({ text: error.message, source: "pageerror", fromExtension: false });
  });

  console.log("[1/20] 打开页面并清空本地数据");
  // fixture 的账号/未读开关是服务端内存状态，会跨运行残留。
  // 显式钉住初始状态，否则上一轮停在别的账号会让整轮结果对不上。
  await page.goto(topicUrl("__set?user=42&login=1&unread=1"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

  if (!flags["keep-state"]) {
    await waitForNavigation(page);
    // 除了清业务数据，还显式把向导标记成"已完成/已弹过"：
    // 验收要测的是日常使用状态，向导占位会挡住右侧按钮。
    await extEval(
      page,
      browser,
      `window.LDFCDB.clearTopics()
        .then(() => window.LDFCTopicState.clearVisits())
        .then(() => window.LDFCDB.putMeta("initialized", true))
        .then(() => window.LDFCDB.putMeta("onboardingPrompted", true))
        .then(() => window.LDFCTopicState.load())`
    );
    await page.reload({ waitUntil: "domcontentloaded" });
  }

  console.log("[2/20] 等待插件界面注入");
  await waitForNavigation(page);
  const navInfo = await page.evaluate(() => ({
    pools: [...document.querySelectorAll("#ldfc-navigation button[data-pool]")].map((button) => button.dataset.pool),
    settings: Boolean(document.querySelector("#ldfc-settings-launch")),
    rows: document.querySelectorAll(".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]").length,
    actions: document.querySelectorAll(".ldfc-action.interested").length
  }));
  record(
    navInfo.pools.length === 5 && navInfo.settings,
    `导航注入成功（五区入口 ${navInfo.pools.length} 个 + 设置按钮：${navInfo.settings}）`
  );
  record(navInfo.rows > 0, `识别到 Topic 行：${navInfo.rows} 行`);
  record(navInfo.actions === navInfo.rows, `每行都挂上操作按钮：${navInfo.actions}/${navInfo.rows}`);

  console.log("[3/20] 不猜测安装前的阅读历史");
  // 103 在列表 JSON 里带着 last_read_post_number，但从未被打开过，
  // 插件不应该为它建立任何记录。
  await page.waitForTimeout(1500);
  const untouched = await extEval(page, browser, `window.LDFCTopicState.get("103")`);
  record(
    untouched === "undefined" || untouched === null,
    `从未打开过的 Topic 103 没有被猜成已读（实际：${JSON.stringify(untouched)}）`
  );

  console.log("[4/20] 自动已读：打开 Topic 后返回列表");
  await page.goto(topicUrl("t/topic/101"), { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  const visits = await waitForValue(
    page,
    browser,
    "window.LDFCTopicState.pendingVisits().map((visit) => visit.topicId)",
    (value) => Array.isArray(value) && value.includes("101"),
    5000
  );
  record(
    Array.isArray(visits) && visits.includes("101"),
    `打开 Topic 后记录了访问（pending=${JSON.stringify(visits)}）`
  );

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  const pool101 = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("101")?.basePool`,
    (value) => value === "READ"
  );
  record(pool101 === "READ", `返回列表后自动进入已读（实际：${pool101}）`);

  console.log("[5/20] 新回复：感兴趣 + 原站未读 → 进入新回复区");
  await extEval(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "102" })`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  const newReplyFlag = await waitForValue(
    page,
    browser,
    `(() => { const r = window.LDFCTopicState.get("102"); return r ? { pool: r.basePool, inNewReply: r.inNewReply } : null; })()`,
    (value) => value && value.inNewReply === true
  );
  record(
    newReplyFlag?.inNewReply === true && newReplyFlag?.pool === "INTERESTED",
    `感兴趣 Topic 的未读进入新回复区（实际：${JSON.stringify(newReplyFlag)}）`
  );

  // AC-006：新回复是临时层，**不改变归属、不扣原池计数**。
  // 这是第 58 问纠正后的核心架构，必须单独断言 ——
  // 同一个 Topic 要同时算在「感兴趣」和「新回复」里。
  const pendingCounts = await extEval(page, browser, `({
    interested: window.LDFCTopicState.listByPool("INTERESTED").length,
    pending: window.LDFCTopicState.listNewReply().length,
    navInterested: Number(document.querySelector('#ldfc-navigation button[data-pool="INTERESTED"] span')?.textContent ?? -1),
    navNewReply: Number(document.querySelector('#ldfc-navigation button[data-pool="NEW_REPLY"] span')?.textContent ?? -1)
  })`);
  record(
    pendingCounts.interested === 1 && pendingCounts.pending === 1 &&
      pendingCounts.navInterested === 1 && pendingCounts.navNewReply === 1,
    `新回复期间原池计数不减（感兴趣=${pendingCounts.interested}、新回复=${pendingCounts.pending}、` +
      `导航 ${pendingCounts.navInterested}/${pendingCounts.navNewReply}）`
  );

  console.log("[6/20] 新回复预览 = 第一条未读回复");
  await clickNavPool(page, "NEW_REPLY");
  await page.waitForTimeout(400);
  const previewText = await waitForValue(
    page,
    browser,
    `(() => { const el = document.querySelector("#ldfc-panel .ldfc-panel-item .ldfc-panel-excerpt"); return el ? el.textContent : ""; })()`,
    (value) => typeof value === "string" && value.includes("probe-user"),
    8000
  );
  record(
    typeof previewText === "string" && previewText.includes("probe-user") && previewText.includes("第一条未读回复的内容"),
    `预览显示第一条未读回复（实际："${previewText}"）`
  );

  console.log("[7/20] 新回复读完 → 回到原池");
  await page.goto(topicUrl("__set?unread=0"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  const afterRead = await waitForValue(
    page,
    browser,
    `(() => { const r = window.LDFCTopicState.get("102"); return r ? { pool: r.basePool, inNewReply: r.inNewReply } : null; })()`,
    (value) => value && value.inNewReply === false
  );
  record(
    afterRead?.inNewReply === false && afterRead?.pool === "INTERESTED",
    `未读清空后回到原池「感兴趣」（实际：${JSON.stringify(afterRead)}）`
  );
  await page.goto(topicUrl("__set?unread=1"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);

  console.log("[8/20] 行内操作：标记感兴趣 + 隐藏 + 持久化");
  // 必须走插件隔离世界取状态：page.evaluate 在主世界跑，
  // 读不到 window.LDFCTopicState。
  const topicId = await extEval(page, browser, `(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]")];
    const home = rows.find((row) => !window.LDFCTopicState.get(row.dataset.topicId)
      && !row.classList.contains("ldfc-row-hidden"));
    return home ? home.dataset.topicId : null;
  })()`);
  if (!topicId) throw new Error("页面上没有可用的主信息流 Topic 行");

  const row = page.locator(`[data-topic-id="${topicId}"]`).first();
  await page.evaluate((id) => {
    document.querySelector(`[data-topic-id="${id}"]`)?.scrollIntoView({ block: "center" });
  }, topicId);
  await page.waitForTimeout(300);
  await row.hover();

  results.push(`INFO：${await robustClick(row.locator(".ldfc-action.interested"), "标记感兴趣")}`);
  await page.waitForTimeout(700);

  const poolAfterMark = await extEval(page, browser, `window.LDFCTopicState.get("${topicId}")?.basePool`);
  record(poolAfterMark === "INTERESTED", `Topic ${topicId} 状态变为 INTERESTED（实际：${poolAfterMark}）`);

  const rowHidden = await page.evaluate((id) => {
    const target = document.querySelector(`[data-topic-id="${id}"]`);
    return Boolean(target?.classList.contains("ldfc-row-hidden") || target?.style.display === "none");
  }, topicId);
  record(rowHidden, "标记后该行从主信息流隐藏");

  const navCount = await page.evaluate(() => {
    const span = document.querySelector('#ldfc-navigation button[data-pool="INTERESTED"] span');
    return span ? Number(span.textContent) : -1;
  });
  record(navCount >= 1, `导航计数更新：感兴趣 = ${navCount}`);

  await page.reload({ waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  const poolAfterReload = await extEval(page, browser, `window.LDFCTopicState.get("${topicId}")?.basePool`);
  record(poolAfterReload === "INTERESTED", `刷新后状态保留（实际：${poolAfterReload}）`);

  console.log("[9/20] 面板：从感兴趣移回主信息流");
  await clickNavPool(page, "INTERESTED");
  await page.waitForTimeout(400);
  const panelVisible = await page.locator("#ldfc-panel").isVisible();
  const panelItems = await page.locator("#ldfc-panel .ldfc-panel-item").count();
  record(panelVisible, "面板已打开");
  record(panelItems >= 1, `面板里能看到 ${panelItems} 条记录`);

  // 按标题定位刚标记的那一条，不依赖面板排序。
  const targetItem = page
    .locator("#ldfc-panel .ldfc-panel-item")
    .filter({ has: page.locator(`a[href="/t/topic/${topicId}"]`) })
    .first();
  results.push(`INFO：${await robustClick(targetItem.getByRole("button", { name: "移回主信息流" }), "移回主信息流")}`);
  await page.waitForTimeout(600);
  const poolAfterRestore = await extEval(page, browser, `window.LDFCTopicState.get("${topicId}")?.basePool`);
  record(poolAfterRestore === "HOME", `Topic ${topicId} 已移回主信息流（实际：${poolAfterRestore}）`);

  console.log("[10/20] 设置面板与信息池面板互斥");
  // 两者都是右侧固定定位、位置完全重合；同时可见会互相遮挡按钮。
  await waitForNavigation(page);
  await page.click("#ldfc-settings-launch");
  await page.waitForTimeout(300);
  const settingsState = await page.evaluate(() => ({
    settingsVisible: !document.querySelector("#ldfc-settings")?.hidden,
    poolVisible: !document.querySelector("#ldfc-panel")?.hidden
  }));
  record(
    settingsState.settingsVisible && !settingsState.poolVisible,
    `打开设置会收起信息池面板（settings=${settingsState.settingsVisible}, pool=${settingsState.poolVisible}）`
  );

  await clickNavPool(page, "READ");
  await page.waitForTimeout(300);
  const poolState = await page.evaluate(() => ({
    settingsVisible: !document.querySelector("#ldfc-settings")?.hidden,
    poolVisible: !document.querySelector("#ldfc-panel")?.hidden
  }));
  record(
    poolState.poolVisible && !poolState.settingsVisible,
    `切到信息池会收起设置面板（settings=${poolState.settingsVisible}, pool=${poolState.poolVisible}）`
  );

  console.log("[11/20] 搜索结果页不做五区过滤");
  // 先把 103 标成不感兴趣，再去搜索页看它有没有被隐藏。
  await extEval(page, browser, `window.LDFCPoolManager.markDismissed({ topicId: "103" })`);
  await page.goto(topicUrl("search?q=Probe"), { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.waitForTimeout(700);
  const searchState = await page.evaluate(() => {
    const row = document.querySelector('[data-topic-id="103"]');
    return {
      rowVisible:
        Boolean(row) && !row.classList.contains("ldfc-row-hidden") && row.style.display !== "none",
      actionButtons: document.querySelectorAll(".ldfc-action").length,
      target: document.querySelector(".fps-result[data-topic-id]")?.dataset.topicId ?? ""
    };
  });
  record(
    searchState.rowVisible,
    `搜索结果里已屏蔽的 Topic 仍然显示（visible=${searchState.rowVisible}）`
  );
  record(
    searchState.actionButtons >= 3,
    `搜索结果页也能直接标记（${searchState.actionButtons} 个按钮；仍然不过滤、不接管点击）`
  );

  // 搜索页从"完全不注入"放宽成"可标记但不过滤"：用户看到标题就能收进池子。
  // 按钮层平时 display:none（悬停才出现），必须先 hover 这一行。
  await page.hover(`.fps-result[data-topic-id="${searchState.target}"]`);
  await page.waitForTimeout(150);
  await page.click(`.fps-result[data-topic-id="${searchState.target}"] .ldfc-action.interested`);
  await page.waitForTimeout(400);
  const searchMarked = await extEval(
    page,
    browser,
    `window.LDFCTopicState.get("${searchState.target}")?.basePool`
  );
  record(
    searchMarked === "INTERESTED",
    `搜索结果页点按钮能写入信息池（${searchState.target} → ${searchMarked}）`
  );
  await extEval(page, browser, `window.LDFCPoolManager.moveHome("${searchState.target}")`);

  console.log("[12/20] 各池时间显示与双排序");
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await clickNavPool(page, "INTERESTED");
  await page.waitForTimeout(500);

  const timeText = await page.evaluate(
    () => document.querySelector("#ldfc-panel .ldfc-panel-time")?.textContent ?? ""
  );
  record(timeText.length > 0, `各池显示相对时间（实际："${timeText}"）`);

  const sortLabels = await page.evaluate(() =>
    [...document.querySelectorAll("#ldfc-panel .ldfc-sort-row button")].map((b) => b.textContent.trim())
  );
  record(
    sortLabels.includes("最近加入") && sortLabels.includes("最近活动"),
    `感兴趣区提供双排序（实际：${JSON.stringify(sortLabels)}）`
  );

  await page.click('#ldfc-panel .ldfc-sort-row button:has-text("最近活动")');
  await page.waitForTimeout(300);
  const savedSort = await extEval(
    page,
    browser,
    `window.LDFCDB.getMeta("sortPreferences").then((value) => value?.INTERESTED)`
  );
  record(savedSort === "activity", `排序偏好持久化（实际：${savedSort}）`);

  console.log("[13/20] 按池清理与账号命名空间");
  const databaseName = await extEval(page, browser, `window.LDFCDB.getDatabaseName()`);
  record(
    typeof databaseName === "string" && databaseName.startsWith("ldfc__"),
    `本地库按账号命名（实际：${databaseName}）`
  );

  await waitForNavigation(page);
  await page.click("#ldfc-settings-launch");
  await page.waitForTimeout(300);
  const clearLabels = await page.evaluate(() =>
    [...document.querySelectorAll("#ldfc-settings button")].map((b) => b.textContent.trim())
  );
  record(
    ["清理感兴趣", "清理已读", "清理不感兴趣", "清理全部"].every((label) =>
      clearLabels.includes(label)
    ),
    `设置里提供按池清理（实际：${JSON.stringify(clearLabels.filter((l) => l.startsWith("清理")))}）`
  );

  const dismissedAfterClear = await extEval(
    page,
    browser,
    `window.LDFCDB.deleteTopicsByPool("DISMISSED")
      .then(() => window.LDFCTopicState.load())
      .then(() => window.LDFCTopicState.listByPool("DISMISSED").length)`
  );
  record(dismissedAfterClear === 0, `按池清理生效（清理后不感兴趣剩 ${dismissedAfterClear} 条）`);

  console.log("[14/20] 账号隔离与未登录兜底");
  const firstAccountDatabase = await extEval(page, browser, `window.LDFCDB.getDatabaseName()`);
  const firstAccountPool = await extEval(page, browser, `window.LDFCTopicState.get("102")?.basePool`);
  record(
    firstAccountDatabase.endsWith("__user-42") && firstAccountPool === "INTERESTED",
    `账号 A 的状态就位（库=${firstAccountDatabase}，102=${firstAccountPool}）`
  );

  // 换成账号 B：库应该换一个，账号 A 的记录不应该出现。
  await page.goto(topicUrl("__set?user=43"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.waitForTimeout(600);

  const secondAccountDatabase = await extEval(page, browser, `window.LDFCDB.getDatabaseName()`);
  const leakedIntoSecond = await extEval(page, browser, `window.LDFCTopicState.get("102")`);
  record(
    secondAccountDatabase.endsWith("__user-43"),
    `换账号后使用独立的库（实际：${secondAccountDatabase}）`
  );
  record(
    leakedIntoSecond === "undefined" || leakedIntoSecond === null,
    `账号 A 的状态没有泄漏到账号 B（B 里 102=${JSON.stringify(leakedIntoSecond)}）`
  );

  await extEval(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "103" })`);
  const secondAccountPool = await extEval(page, browser, `window.LDFCTopicState.get("103")?.basePool`);

  await page.goto(topicUrl("__set?user=42"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.waitForTimeout(600);

  const backDatabase = await extEval(page, browser, `window.LDFCDB.getDatabaseName()`);
  const backPool = await extEval(page, browser, `window.LDFCTopicState.get("102")?.basePool`);
  const leakedBack = await extEval(page, browser, `window.LDFCTopicState.get("103")`);
  record(
    backDatabase.endsWith("__user-42") && backPool === "INTERESTED" &&
      (leakedBack === "undefined" || leakedBack === null),
    `切回账号 A 后状态完好且未被 B 污染（A 的 102=${backPool}；B 标的 103=${JSON.stringify(leakedBack)}）`
  );
  record(secondAccountPool === "INTERESTED", `账号 B 自己的状态正常（B 的 103=${secondAccountPool}）`);

  console.log("[15/20] 未登录：guest 空间 + 本地阅读基线");
  await page.goto(topicUrl("__set?login=0"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.waitForTimeout(600);

  const guestDatabase = await extEval(page, browser, `window.LDFCDB.getDatabaseName()`);
  record(guestDatabase.endsWith("__guest"), `未登录使用独立的 guest 空间（实际：${guestDatabase}）`);

  // P2-A 回归：未登录时不得请求必然 403 的 /unread.json。
  // Guest 走本地基线的匿名兜底，这个接口对它是无意义的。
  const unreadCalls = [];
  const unreadProbe = (request) => {
    if (/\/unread\.json/.test(request.url())) unreadCalls.push(request.url());
  };
  page.on("request", unreadProbe);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.waitForTimeout(2500);
  page.off("request", unreadProbe);
  record(
    unreadCalls.length === 0,
    `未登录时不请求必然 403 的 /unread.json（实际请求 ${unreadCalls.length} 次）`
  );

  // 清一次 guest 空间，让这一步可以重复跑
  await extEval(
    page,
    browser,
    `window.LDFCDB.clearTopics()
      .then(() => window.LDFCTopicState.clearVisits())
      .then(() => window.LDFCTopicState.load())`
  );

  // 未登录时原站不提供阅读位置，只能靠本地基线：打开 Topic 记下当时的最高楼层。
  await page.goto(topicUrl("t/topic/101"), { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);

  const anonymousPool = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("101")?.basePool`,
    (value) => value === "READ"
  );
  record(anonymousPool === "READ", `未登录打开 Topic 也能进入已读（实际：${anonymousPool}）`);

  const baseline = await extEval(page, browser, `window.LDFCTopicState.get("101")?.readUpToPostNumber`);
  record(baseline === 3, `未登录模式记录本地阅读基线（实际：${baseline}）`);

  // 在 guest 里标一个 Topic，再切回登录态，验证两边不串。
  await extEval(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "103" })`);

  await page.goto(topicUrl("__set?login=1&user=42"), { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await page.waitForTimeout(600);

  const finalDatabase = await extEval(page, browser, `window.LDFCDB.getDatabaseName()`);
  const guestLeak = await extEval(page, browser, `window.LDFCTopicState.get("103")`);
  record(
    finalDatabase.endsWith("__user-42") &&
      (guestLeak === "undefined" || guestLeak === null),
    `guest 状态没有污染账号空间（库=${finalDatabase}，guest 标的 103=${JSON.stringify(guestLeak)}）`
  );

  // ---------------- P0 回归：真实 Linux.do 上暴露过的问题 ----------------
  // 这些用例在修复前应当**失败** —— 那是"fixture 保真度有效"的证明。
  console.log("[16/20] P0 回归（嵌套 DOM / 跨页未读 / null 字段 / tracking / slug）");

  // 用例 1：真实站点一个 Topic 有 2 个 data-topic-id（行 + 嵌套标题链接），
  // 插件必须只把"行"当 Topic，不能把标题链接也当成一行。
  const domShape = await extEval(page, browser, `({
    allMarkers: document.querySelectorAll("[data-topic-id]").length,
    pluginRows: window.LDFCTopicParser.listRows().length,
    nestedLinks: document.querySelectorAll("a.raw-topic-link[data-topic-id]").length,
    allAreRows: window.LDFCTopicParser.listRows().every((row) => row.classList.contains("topic-list-item"))
  })`);
  record(
    domShape.pluginRows > 0 &&
      domShape.allMarkers === domShape.pluginRows * 2 &&
      domShape.nestedLinks === domShape.pluginRows &&
      domShape.allAreRows,
    `一个 Topic 两个 data-topic-id 时仍只选行（标记 ${domShape.allMarkers}、行 ${domShape.pluginRows}、嵌套链接 ${domShape.nestedLinks}）`
  );

  // 用例 4：topicTrackingStates 的值经过二次 JSON 编码，必须能正确解析。
  const tracking = await extEval(page, browser, `({
    moduleType: typeof window.LDFCTrackingState,
    windowSize: window.LDFCTrackingState?.windowSize?.() ?? null,
    unread102: window.LDFCTrackingState?.unreadFor?.("102") ?? null,
    unknownTopic: window.LDFCTrackingState?.unreadFor?.("900001") ?? null
  })`);
  record(
    tracking.moduleType === "object" &&
      tracking.windowSize > 0 &&
      tracking.unread102 === 4 &&
      tracking.unknownTopic === null,
    `能解析二次编码的 topicTrackingStates（窗口 ${tracking.windowSize}，102 未读=${tracking.unread102}，窗口外=${tracking.unknownTopic}）`
  );

  // fixture 就位检查：确认它真的复刻了真实站点形状。
  const fixtureShape = await page.evaluate(async () => {
    const get = async (target) => (await fetch(target, { credentials: "same-origin" })).json();
    const page0 = await get("/unread.json");
    const page1 = await get("/unread.json?page=1");
    const latest = await get("/latest.json");
    const ids = (payload) => (payload.topic_list?.topics ?? []).map((topic) => String(topic.id));
    const list = latest.topic_list?.topics ?? [];
    return {
      unreadPage0: ids(page0).length,
      unreadPage1: ids(page1).length,
      page0Has102: ids(page0).includes("102"),
      page1Has102: ids(page1).includes("102"),
      latestHas102: ids(latest).includes("102"),
      latestTotal: list.length,
      latestWithRead: list.filter((topic) => topic.unread_posts !== null || topic.last_read_post_number !== null).length
    };
  });
  record(
    fixtureShape.unreadPage0 === 30 && fixtureShape.unreadPage1 > 0 &&
      fixtureShape.page1Has102 && !fixtureShape.page0Has102 && !fixtureShape.latestHas102 &&
      fixtureShape.latestWithRead <= 4,
    `fixture 复刻了真实形状（未读第0页 ${fixtureShape.unreadPage0} 条 / 第1页 ${fixtureShape.unreadPage1} 条；` +
      `102 只在第1页、不在 latest；latest ${fixtureShape.latestWithRead}/${fixtureShape.latestTotal} 条带阅读字段）`
  );

  // 用例 2 + 3：跨页未读 + latest 无字段的情况下，
  // 既要能"发现新回复"，又绝不能把第 2 页的 Topic 当成"已处理完"。
  await extEval(page, browser, `window.LDFCDB.clearTopics()
    .then(() => window.LDFCTopicState.clearVisits())
    .then(() => window.LDFCTopicState.load())`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);
  await extEval(page, browser, `(async () => {
    const row = [...window.LDFCTopicParser.listRows()].find((item) => item.dataset.topicId === "102");
    await window.LDFCPoolManager.markInterested(window.LDFCTopicParser.extractTopic(row));
  })()`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await waitForNavigation(page);

  const discovered = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("102")?.inNewReply`,
    (value) => value === true
  );
  record(
    discovered === true,
    `102 不在 /latest.json 第一页也能发现新回复（inNewReply=${discovered}）`
  );

  const discoveredCount = await extEval(page, browser, `window.LDFCTopicState.get("102")?.unreadPosts`);
  record(discoveredCount === 4, `新回复数量取自可用数据源（实际：${discoveredCount}）`);

  const stillPending = await extEval(page, browser, `window.LDFCTopicState.get("102")?.inNewReply`);
  record(
    stillPending === true,
    `不在未读列表第 0 页 ≠ 已处理完（102 仍保留在新回复区：${stillPending}）`
  );

  // 用例 5：slug 是字面量 "topic"，生成的"第一个未读"地址必须与真实站点一致。
  const unreadUrl = await extEval(
    page,
    browser,
    `window.LDFCDiscourseAdapter.topicUnreadUrl(window.LDFCTopicState.get("102"))`
  );
  record(unreadUrl === "/t/topic/102/3", `"第一个未读"地址使用真实 slug（实际：${unreadUrl}）`);

  // ---------------- P1 自动补位：不得主动滚动页面 ----------------
  console.log("[17/20] P1 自动补位（只在用户自然接近底部时触发，且不得滚动页面）");

  const pageRequests = [];
  page.on("request", (request) => {
    if (/\/latest\.json\?[^"]*page=/.test(request.url())) pageRequests.push(request.url());
  });

  const reloadList = async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForNavigation(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(900);
  };

  // A. 哨兵远在视口外（用户在顶部）→ 不补位、不滚动、不发请求
  await reloadList();
  const topBefore = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    rows: document.querySelectorAll(".topic-list-item[data-topic-id]").length
  }));
  pageRequests.length = 0;
  const fillAtTop = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(1500);
  const topAfter = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    rows: document.querySelectorAll(".topic-list-item[data-topic-id]").length,
    sentinelInView: null
  }));
  record(
    fillAtTop === false &&
      topAfter.scrollY === topBefore.scrollY &&
      topAfter.rows === topBefore.rows &&
      pageRequests.length === 0,
    `哨兵不在视口时不补位也不滚动（maybeFill=${fillAtTop}，scrollY ${topBefore.scrollY}→${topAfter.scrollY}，` +
      `行数 ${topBefore.rows}→${topAfter.rows}，分页请求 ${pageRequests.length}）`
  );

  // B. 用户自己往下滚（模拟真实浏览）→ 无论是否补位，都不得改变用户的滚动位置。
  //
  // 注意：用户滚到底时原站自己会加载下一页（31→61 行），哨兵随后被推离视口，
  // 这时扩展"不补位"才是正确的。所以这里断言的是**滚动位置不被改变**这个
  // 产品要求本身，而不是"必须发一次请求"。
  await reloadList();
  for (let step = 0; step < 4; step += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(900);
  }
  const userScrollY = await page.evaluate(() => Math.round(window.scrollY));
  const scrollGates = {
    sentinelInView: await extEval(page, browser, "window.LDFCAutofill.sentinelInViewport()"),
    visibleHomeRows: await extEval(page, browser, "window.LDFCAutofill.visibleHomeRowCount()"),
    shouldLoadMore: await extEval(page, browser, "window.LDFCAutofill.shouldLoadMore()"),
    rows: await page.evaluate(() => document.querySelectorAll(".topic-list-item[data-topic-id]").length)
  };
  pageRequests.length = 0;
  const fillAfterScroll = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(1600);
  const afterScrollY = await page.evaluate(() => Math.round(window.scrollY));
  record(
    afterScrollY === userScrollY,
    `用户滚动后扩展不改变滚动位置（scrollY ${userScrollY}→${afterScrollY}；门控 ${JSON.stringify(scrollGates)}；maybeFill=${fillAfterScroll}）`
  );

  // B2. 源码级确定性保证：自动补位里不存在任何滚动调用。
  // 必须先剔除注释 —— 代码注释里恰好写着"不调用 scrollIntoView"，
  // 直接正则匹配会误判成违规。
  const autofillSource = fs.readFileSync(
    path.join(LAB_DIR, "..", "linuxdo-personal-feed-manager", "core", "autofill.js"),
    "utf8"
  );
  const autofillCode = autofillSource
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  const scrollCall = autofillCode.match(/scrollIntoView|\.scrollTo\(|\.scrollBy\(|scrollTop\s*=|\.scrollY\s*=/);
  record(
    !scrollCall,
    scrollCall
      ? `自动补位源码里出现了滚动调用：${scrollCall[0]}`
      : "自动补位源码不含任何滚动调用（无 scrollIntoView / scrollTo / scrollBy / scrollTop=）"
  );

  // C. 加载完哨兵已被推离视口 → 不得重复触发（防 DOM 更新 → observer → 再触发的循环）
  const sentinelAfterLoad = await extEval(page, browser, "window.LDFCAutofill.sentinelInViewport()");
  pageRequests.length = 0;
  const fillAgain = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(1500);
  record(
    fillAgain === false && pageRequests.length === 0,
    `不会无限重复补位（加载后 sentinelInViewport=${sentinelAfterLoad}，再次 maybeFill=${fillAgain}，新增请求 ${pageRequests.length}）`
  );

  // D. 列表本身很短（大部分被过滤掉）→ 哨兵本来就在视口内 → 可补位且不滚动
  await reloadList();
  const hiddenIds = await extEval(page, browser, `(async () => {
    const rows = [...window.LDFCTopicParser.listRows()];
    const ids = rows.map((row) => row.dataset.topicId).slice(0, Math.max(rows.length - 6, 1));
    for (const topicId of ids) await window.LDFCPoolManager.markInterested({ topicId });
    await window.LDFCFilter.applyRows();
    return ids;
  })()`);
  await page.waitForTimeout(700);
  const shortBefore = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    visibleRows: document.querySelectorAll(".topic-list-item[data-topic-id]:not(.ldfc-row-hidden)").length
  }));
  const shortSentinel = await extEval(page, browser, "window.LDFCAutofill.sentinelInViewport()");
  const shortVisible = await extEval(page, browser, "window.LDFCAutofill.visibleHomeRowCount()");
  pageRequests.length = 0;
  const fillShort = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(1500);
  const shortAfter = await page.evaluate(() => ({ scrollY: Math.round(window.scrollY) }));
  record(
    shortSentinel === true && shortVisible < 8 && fillShort === true &&
      shortAfter.scrollY === shortBefore.scrollY,
    `过滤后列表变短时可在原地补位（可见行 ${shortVisible}，sentinelInViewport=${shortSentinel}，` +
      `maybeFill=${fillShort}，scrollY ${shortBefore.scrollY}→${shortAfter.scrollY}）`
  );

  // 还原被标成感兴趣的 Topic
  await extEval(page, browser, `(async () => {
    for (const topicId of ${JSON.stringify(hiddenIds)}) await window.LDFCPoolManager.moveHome(topicId);
    return true;
  })()`);

  // ---------------- 关键覆盖补强（AC-008 / 018 / 020 / 025 / 036 / 038 / 022）----------------
  console.log("[18/20] 关键覆盖补强");

  const cleanState = async () => {
    await extEval(page, browser, `window.LDFCDB.clearTopics()
      .then(() => window.LDFCTopicState.clearVisits())
      .then(() => window.LDFCTopicState.load())`);
  };
  const reloadListForCoverage = async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForNavigation(page);
    await page.waitForTimeout(1200);
  };

  // ---- AC-008：不感兴趣永远不进入新回复 ----
  await cleanState();
  await reloadListForCoverage();
  const dismissedUnread = await extEval(page, browser, `(async () => {
    // 102 在 fixture 里是"有未读"的 Topic
    await window.LDFCPoolManager.markDismissed({ topicId: "102" }, { title: "不感兴趣测试" });
    await window.LDFCPoolManager.discoverNewReplies([
      { topicId: "102", unreadPosts: 4, lastReadPostNumber: 2, highestPostNumber: 6, lastPostedAt: "2026-09-01T00:00:00.000Z" }
    ]);
    const r = window.LDFCTopicState.get("102");
    return {
      basePool: r?.basePool,
      inNewReply: r?.inNewReply,
      在待处理列表里: window.LDFCTopicState.listNewReply().some((x) => x.topicId === "102")
    };
  })()`);
  record(
    dismissedUnread.basePool === "DISMISSED" &&
      dismissedUnread.inNewReply === false &&
      dismissedUnread.在待处理列表里 === false,
    `不感兴趣 Topic 即使有未读也不进入新回复（pool=${dismissedUnread.basePool}，inNewReply=${dismissedUnread.inNewReply}）`
  );

  // ---- AC-018 / AC-020：不感兴趣的真实 UI 路径 + Toast 撤销 ----
  await cleanState();
  await reloadListForCoverage();
  const dismissUi = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .filter((row) => row.offsetParent !== null);
    const row = rows[0];
    const button = row.querySelector(".ldfc-action.dismissed");
    return { topicId: row.dataset.topicId, hasButton: !!button };
  });
  await page.locator(`.topic-list-item[data-topic-id="${dismissUi.topicId}"]`).hover();
  await page.waitForTimeout(300);
  await page.locator(`.topic-list-item[data-topic-id="${dismissUi.topicId}"] .ldfc-action.dismissed`).click();
  await page.waitForTimeout(900);

  const afterDismiss = await extEval(page, browser, `({
    pool: window.LDFCTopicState.get("${dismissUi.topicId}")?.basePool ?? null,
    toastText: document.querySelector("#ldfc-toast-container")?.textContent ?? null,
    toastButtons: [...(document.querySelector("#ldfc-toast-container")?.querySelectorAll("button") ?? [])].map((b) => b.textContent.trim())
  })`);

  const undoButton = page.locator("#ldfc-toast-container").getByRole("button", { name: "撤销" });
  const hasUndo = (await undoButton.count()) > 0;
  if (hasUndo) {
    await undoButton.click();
    await page.waitForTimeout(900);
  }
  const afterUndo = await extEval(page, browser, `window.LDFCTopicState.get("${dismissUi.topicId}")?.basePool ?? null`);

  record(
    afterDismiss.pool === "DISMISSED" && hasUndo && afterUndo === "HOME",
    `不感兴趣的真实 UI 路径 + Toast 撤销（点击后 ${afterDismiss.pool}，Toast 文本「${afterDismiss.toastText}」，` +
      `撤销按钮 ${JSON.stringify(afterDismiss.toastButtons)}，撤销后 ${afterUndo}）`
  );

  // ---- 面板标题自愈：记录标题为空且当前列表 DOM 里没有该行时，回源 /t/<id>.json ----
  // 401 只在 latest 第 1 页出现，当前列表 DOM 里没有这一行，只能靠回源补标题。
  await cleanState();
  await reloadListForCoverage();
  await extEval(page, browser, `(async () => {
    await window.LDFCTopicState.setPool("401", "DISMISSED", { title: "", slug: "more-topic-401" });
    window.LDFCNavigation.render();
    return true;
  })()`);
  const titleBeforeFetch = await extEval(page, browser, `window.LDFCTopicState.get("401")?.title ?? null`);
  await clickNavPool(page, "DISMISSED");
  await page.waitForTimeout(1500);
  const panelTitles = await extEval(
    page,
    browser,
    `[...document.querySelectorAll(".ldfc-panel-title")].map((link) => link.textContent)`
  );
  const titleAfterFetch = await extEval(page, browser, `window.LDFCTopicState.get("401")?.title ?? null`);
  await clickNavPool(page, "HOME");
  await page.waitForTimeout(600);
  record(
    titleBeforeFetch === "" && titleAfterFetch === "More Topic 401" && panelTitles.includes("More Topic 401"),
    `不感兴趣池回源补标题（记录标题空=${JSON.stringify(titleBeforeFetch)}，回源后=${JSON.stringify(titleAfterFetch)}，` +
      `面板显示 ${JSON.stringify(panelTitles)}）`
  );

  // ---- 行内按钮：原站重渲染会重写行的 class 属性，类名被冲掉后悬浮仍须可见 ----
  await cleanState();
  await reloadListForCoverage();
  const strippedRow = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .find((candidate) => candidate.offsetParent !== null);
    row.classList.remove("ldfc-topic-row");
    // 推荐 / 相关是表格行，按钮层挂在第一个单元格里，所以用后代选择器。
    const layer = row.querySelector(".ldfc-actions");
    return {
      topicId: row.dataset.topicId,
      hasLayer: !!layer,
      displayBeforeHover: layer ? getComputedStyle(layer).display : null
    };
  });
  await page.locator(`.topic-list-item[data-topic-id="${strippedRow.topicId}"]`).hover();
  await page.waitForTimeout(400);
  const afterHover = await page.evaluate((topicId) => {
    const row = document.querySelector(`.topic-list-item[data-topic-id="${topicId}"]`);
    const layer = row.querySelector(".ldfc-actions");
    return {
      classRepaired: row.classList.contains("ldfc-topic-row"),
      display: layer ? getComputedStyle(layer).display : null
    };
  }, strippedRow.topicId);
  record(
    strippedRow.hasLayer &&
      strippedRow.displayBeforeHover === "none" &&
      afterHover.classRepaired &&
      afterHover.display === "flex",
    `类名被原站重渲染冲掉后悬浮仍显示按钮（补回类名=${afterHover.classRepaired}，` +
      `悬浮前 display=${strippedRow.displayBeforeHover}，悬浮后 display=${afterHover.display}）`
  );

  // ---- 行节点被复用到别的 Topic 时，按钮不能指向旧条目 ----
  const nodeReuse = await extEval(page, browser, `(() => {
    const row = document.querySelector(".topic-list-item[data-topic-id]");
    const original = row.dataset.topicId;
    row.dataset.topicId = "888";
    window.LDFCContent.decorateRows();
    const boundTo = [...row.querySelectorAll(".ldfc-actions")].map((layer) => layer.dataset.ldfcTopic);
    row.dataset.topicId = original;
    window.LDFCContent.decorateRows();
    const restoredTo = row.querySelector(".ldfc-actions")?.dataset.ldfcTopic ?? null;
    return { boundTo, restoredTo, original };
  })()`);
  record(
    nodeReuse.boundTo.length === 1 &&
      nodeReuse.boundTo[0] === "888" &&
      nodeReuse.restoredTo === nodeReuse.original,
    `行节点复用到别的 Topic 时按钮重新绑定（${JSON.stringify(nodeReuse)}）`
  );

  // ---- AC-018：移回主信息流必须顺带清掉新回复状态 ----
  const moveHomeClears = await extEval(page, browser, `(async () => {
    await window.LDFCPoolManager.markInterested({ topicId: "102" });
    await window.LDFCPoolManager.discoverNewReplies([
      { topicId: "102", unreadPosts: 4, lastReadPostNumber: 2, highestPostNumber: 6, lastPostedAt: "2026-09-01T00:00:00.000Z" }
    ]);
    const before = { pool: window.LDFCTopicState.get("102")?.basePool, inNewReply: window.LDFCTopicState.get("102")?.inNewReply };
    await window.LDFCPoolManager.moveHome("102");
    const after = { pool: window.LDFCTopicState.get("102")?.basePool, inNewReply: window.LDFCTopicState.get("102")?.inNewReply };
    return { before, after };
  })()`);
  record(
    moveHomeClears.before.inNewReply === true &&
      moveHomeClears.after.pool === "HOME" &&
      moveHomeClears.after.inNewReply === false,
    `移回主信息流同时清掉新回复状态（${JSON.stringify(moveHomeClears.before)} → ${JSON.stringify(moveHomeClears.after)}）`
  );

  // ---- 删除墓碑：清理必须留下"这条被删了"的状态，否则同步会把它推回来 ----
  await cleanState();
  const tombstoneEvidence = await extEval(page, browser, `(async () => {
    await window.LDFCPoolManager.markDismissed({ topicId: "107" }, { title: "墓碑测试" });
    const before = (await window.LDFCDB.getTombstones()).find((item) => item.topicId === "107")?.deletedAt ?? 0;
    const removed = await window.LDFCDB.deleteTopicsByPool("DISMISSED");
    await window.LDFCTopicState.load();
    const after = (await window.LDFCDB.getTombstones()).find((item) => item.topicId === "107")?.deletedAt ?? 0;
    return { removed, before, after, remaining: window.LDFCTopicState.listByPool("DISMISSED").length };
  })()`);
  record(
    tombstoneEvidence.removed >= 1 &&
      tombstoneEvidence.remaining === 0 &&
      tombstoneEvidence.after > tombstoneEvidence.before,
    `按池清理写入删除墓碑（删除 ${tombstoneEvidence.removed} 条，107 的 deletedAt ${tombstoneEvidence.before} → ${tombstoneEvidence.after}）`
  );

  const clearAllEvidence = await extEval(page, browser, `(async () => {
    await window.LDFCPoolManager.markInterested({ topicId: "108" }, { title: "墓碑测试2" });
    const removed = await window.LDFCDB.clearTopics();
    await window.LDFCTopicState.load();
    const tomb = (await window.LDFCDB.getTombstones()).find((item) => item.topicId === "108");
    return {
      removed,
      tomb: !!tomb,
      dbVersion: window.LDFCMigration.DB_VERSION,
      remaining: window.LDFCTopicState.records.size
    };
  })()`);
  record(
    clearAllEvidence.removed >= 1 &&
      clearAllEvidence.tomb &&
      clearAllEvidence.remaining === 0 &&
      clearAllEvidence.dbVersion === 3,
    `清理全部同样写入删除墓碑（删除 ${clearAllEvidence.removed} 条，108 有墓碑=${clearAllEvidence.tomb}，` +
      `库版本=${clearAllEvidence.dbVersion}，剩余 ${clearAllEvidence.remaining} 条）`
  );

  // ---- AC-036：JSON 导出 → 清空 → 导入 → 恢复 ----
  await cleanState();
  await extEval(page, browser, `(async () => {
    await window.LDFCPoolManager.markInterested({ topicId: "101" });
    await window.LDFCPoolManager.markDismissed({ topicId: "102" });
    await window.LDFCPoolManager.markRead("103");
    return true;
  })()`);
  await waitForNavigation(page);
  await page.click("#ldfc-settings-launch");
  await page.waitForTimeout(600);

  const exported = await extEval(page, browser, `(async () => {
    const original = URL.createObjectURL;
    let captured = null;
    URL.createObjectURL = (blob) => { captured = blob; return original.call(URL, blob); };
    try {
      const button = [...document.querySelectorAll("#ldfc-settings button")]
        .find((el) => el.textContent.includes("导出 JSON"));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 600));
      return captured ? { text: await captured.text() } : null;
    } finally {
      URL.createObjectURL = original;
    }
  })()`);

  let parsedExport = null;
  try { parsedExport = JSON.parse(exported.text); } catch { parsedExport = null; }
  const exportShapeOk =
    parsedExport?.version === 1 &&
    Array.isArray(parsedExport.topics) &&
    Array.isArray(parsedExport.tombstones) &&
    parsedExport.topics.length === 3 &&
    parsedExport.topics.every((item) => /^\d+$/.test(String(item.topicId)) && item.basePool) &&
    !("cooked" in (parsedExport.topics[0] ?? {})) &&
    !JSON.stringify(parsedExport).includes("cookie");

  record(
    exportShapeOk,
    `导出 JSON 结构与内容合规（version=${parsedExport?.version}，条数=${parsedExport?.topics?.length}，` +
      `墓碑=${parsedExport?.tombstones?.length}，` +
      `字段=${JSON.stringify(Object.keys(parsedExport?.topics?.[0] ?? {}))}）`
  );

  await cleanState();
  const clearedCount = await extEval(page, browser, `window.LDFCTopicState.records.size`);

  const imported = await extEval(page, browser, `(async () => {
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return originalClick.call(this);
      const transfer = new DataTransfer();
      transfer.items.add(new File([${JSON.stringify(exported.text)}], "backup.json", { type: "application/json" }));
      Object.defineProperty(this, "files", { value: transfer.files, configurable: true });
      this.dispatchEvent(new Event("change"));
    };
    try {
      const button = [...document.querySelectorAll("#ldfc-settings button")]
        .find((el) => el.textContent.includes("导入 JSON"));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        total: window.LDFCTopicState.records.size,
        pools: {
          101: window.LDFCTopicState.get("101")?.basePool ?? null,
          102: window.LDFCTopicState.get("102")?.basePool ?? null,
          103: window.LDFCTopicState.get("103")?.basePool ?? null
        },
        toast: document.querySelector("#ldfc-toast-container")?.textContent ?? null
      };
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }
  })()`);

  record(
    clearedCount === 0 &&
      imported.total === 3 &&
      imported.pools["101"] === "INTERESTED" &&
      imported.pools["102"] === "DISMISSED" &&
      imported.pools["103"] === "READ",
    `导出 → 清空(${clearedCount}) → 导入 → 状态恢复（${JSON.stringify(imported.pools)}，Toast「${imported.toast}」）`
  );

  // ---- 导入墓碑：新墓碑要删掉记录，旧墓碑不能删掉之后重新标记的记录 ----
  const importTombstones = await extEval(page, browser, `(async () => {
    const now = Date.now();
    const payload = {
      version: 1,
      topics: [
        { topicId: "109", basePool: "INTERESTED", inNewReply: false, createdAt: now - 5000, enteredPoolAt: now - 4000, updatedAt: now - 3000 },
        { topicId: "110", basePool: "READ", inNewReply: false, createdAt: now - 5000, enteredPoolAt: now - 4000, updatedAt: now + 1000 }
      ],
      tombstones: [
        { topicId: "109", deletedAt: now },
        { topicId: "110", deletedAt: now - 9999 }
      ]
    };

    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return originalClick.call(this);
      const transfer = new DataTransfer();
      transfer.items.add(new File([JSON.stringify(payload)], "tombstones.json", { type: "application/json" }));
      Object.defineProperty(this, "files", { value: transfer.files, configurable: true });
      this.dispatchEvent(new Event("change"));
    };
    try {
      const button = [...document.querySelectorAll("#ldfc-settings button")]
        .find((el) => el.textContent.includes("导入 JSON"));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return {
        deletedOne: window.LDFCTopicState.get("109")?.basePool ?? null,
        keptOne: window.LDFCTopicState.get("110")?.basePool ?? null,
        hasTombstone: (await window.LDFCDB.getTombstones()).some((item) => item.topicId === "109")
      };
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }
  })()`);
  record(
    importTombstones.deletedOne === null &&
      importTombstones.keptOne === "READ" &&
      importTombstones.hasTombstone,
    `导入墓碑：较新的墓碑删除记录（109=${importTombstones.deletedOne}），` +
      `较旧的墓碑不删掉之后重新标记的记录（110=${importTombstones.keptOne}，109 有墓碑=${importTombstones.hasTombstone}）`
  );

  // 本用例新增了 109/110，必须把后续用例依赖的初始状态恢复回来。
  await cleanState();
  await extEval(page, browser, `(async () => {
    await window.LDFCPoolManager.markInterested({ topicId: "101" });
    await window.LDFCPoolManager.markDismissed({ topicId: "102" });
    await window.LDFCPoolManager.markRead("103");
    return true;
  })()`);

  // 坏 JSON 不得破坏现有数据
  const badImport = await extEval(page, browser, `(async () => {
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return originalClick.call(this);
      const transfer = new DataTransfer();
      transfer.items.add(new File(["{ 这不是合法 JSON"], "broken.json", { type: "application/json" }));
      Object.defineProperty(this, "files", { value: transfer.files, configurable: true });
      this.dispatchEvent(new Event("change"));
    };
    try {
      const button = [...document.querySelectorAll("#ldfc-settings button")]
        .find((el) => el.textContent.includes("导入 JSON"));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        total: window.LDFCTopicState.records.size,
        pool101: window.LDFCTopicState.get("101")?.basePool ?? null,
        toast: document.querySelector("#ldfc-toast-container")?.textContent ?? null
      };
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }
  })()`);

  record(
    badImport.total === 3 && badImport.pool101 === "INTERESTED",
    `坏 JSON 不破坏现有数据（导入后仍是 ${badImport.total} 条，101=${badImport.pool101}，Toast「${badImport.toast}」）`
  );

  // 版本号不对的 JSON 也要被拒绝
  const wrongVersion = await extEval(page, browser, `(async () => {
    const originalClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      if (this.type !== "file") return originalClick.call(this);
      const transfer = new DataTransfer();
      transfer.items.add(new File(['{"version":99,"topics":[{"topicId":"999","basePool":"READ"}]}'], "v99.json", { type: "application/json" }));
      Object.defineProperty(this, "files", { value: transfer.files, configurable: true });
      this.dispatchEvent(new Event("change"));
    };
    try {
      const button = [...document.querySelectorAll("#ldfc-settings button")]
        .find((el) => el.textContent.includes("导入 JSON"));
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return { total: window.LDFCTopicState.records.size, 有没有写进999: window.LDFCTopicState.get("999") ? true : false };
    } finally {
      HTMLInputElement.prototype.click = originalClick;
    }
  })()`);

  record(
    wrongVersion.total === 3 && wrongVersion.有没有写进999 === false,
    `版本号不符的 JSON 被拒绝（条数仍 ${wrongVersion.total}，未写入 999=${!wrongVersion.有没有写进999}）`
  );

  // ---- AC-025：安装向导 A / B / C ----
  const showWizard = async () => {
    await extEval(page, browser, `window.LDFCDB.clearTopics()
      .then(() => window.LDFCTopicState.clearVisits())
      .then(() => window.LDFCDB.putMeta("initialized", false))
      .then(() => window.LDFCDB.putMeta("onboardingPrompted", false))
      .then(() => window.LDFCTopicState.load())`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForNavigation(page);
    await page.waitForTimeout(1200);
  };

  await showWizard();
  const wizard = await page.evaluate(() => ({
    cards: [...document.querySelectorAll("#ldfc-onboarding .ldfc-onboarding-card, #ldfc-settings .ldfc-onboarding-card")]
      .map((el) => el.textContent.trim().slice(0, 10)),
    visible: !!document.querySelector(".ldfc-onboarding-card")
  }));
  record(
    wizard.visible && wizard.cards.length === 3 &&
      wizard.cards[0].startsWith("A") && wizard.cards[1].startsWith("B") && wizard.cards[2].startsWith("C"),
    `安装向导提供 A/B/C 三个选项且 A 在首位（实际：${JSON.stringify(wizard.cards)}）`
  );

  // 选 A：从今天开始记录 → 不应产生任何记录
  await page.locator(".ldfc-onboarding-card").nth(0).click();
  await page.waitForTimeout(1200);
  const afterA = await extEval(page, browser, `({
    initialized: Boolean(await window.LDFCDB.getMeta("initialized")),
    records: window.LDFCTopicState.records.size
  })`);
  record(
    afterA.initialized === true && afterA.records === 0,
    `向导 A「从今天开始记录」不猜测任何历史（initialized=${afterA.initialized}，记录数=${afterA.records}）`
  );

  // 选 B：按原站阅读状态初始化 → 应把 /latest.json 里带阅读位置的 Topic 归入已读
  await showWizard();
  await page.locator(".ldfc-onboarding-card").nth(1).click();
  await page.waitForTimeout(2500);
  const afterB = await extEval(page, browser, `({
    initialized: Boolean(await window.LDFCDB.getMeta("initialized")),
    total: window.LDFCTopicState.records.size,
    read: window.LDFCTopicState.listByPool("READ").length,
    newReply: window.LDFCTopicState.listNewReply().length
  })`);
  record(
    afterB.initialized === true && afterB.read > 0,
    `向导 B「按原站阅读状态初始化」生效（已读 ${afterB.read} 条，新回复 ${afterB.newReply} 条，共 ${afterB.total} 条）`
  );

  // 选 C：全部视为未处理 → 等同从零开始
  await showWizard();
  await page.locator(".ldfc-onboarding-card").nth(2).click();
  await page.waitForTimeout(1200);
  const afterC = await extEval(page, browser, `({
    initialized: Boolean(await window.LDFCDB.getMeta("initialized")),
    records: window.LDFCTopicState.records.size
  })`);
  record(
    afterC.initialized === true && afterC.records === 0,
    `向导 C「全部视为未处理」等同从零开始（initialized=${afterC.initialized}，记录数=${afterC.records}）`
  );

  // ---- AC-038：Guest 状态在切换身份后不被清空 ----
  await extEval(page, browser, `window.LDFCDB.clearTopics()
    .then(() => window.LDFCTopicState.clearVisits())
    .then(() => window.LDFCTopicState.load())`);
  await page.goto(topicUrl("__set?login=0"), { waitUntil: "domcontentloaded" });
  await reloadListForCoverage();
  await extEval(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "103" })`);
  const guestMarked = await extEval(page, browser, `window.LDFCTopicState.get("103")?.basePool ?? null`);

  await page.goto(topicUrl("__set?login=1&user=42"), { waitUntil: "domcontentloaded" });
  await reloadListForCoverage();
  const inAccount = await extEval(page, browser, `({
    database: await window.LDFCDB.getDatabaseName(),
    pool103: window.LDFCTopicState.get("103")?.basePool ?? null,
    total: window.LDFCTopicState.records.size
  })`);

  await page.goto(topicUrl("__set?login=0"), { waitUntil: "domcontentloaded" });
  await reloadListForCoverage();
  const backToGuest = await extEval(page, browser, `({
    database: await window.LDFCDB.getDatabaseName(),
    pool103: window.LDFCTopicState.get("103")?.basePool ?? null
  })`);

  record(
    guestMarked === "INTERESTED" &&
      inAccount.pool103 === null &&
      String(inAccount.database).endsWith("__user-42") &&
      backToGuest.pool103 === "INTERESTED" &&
      String(backToGuest.database).endsWith("__guest"),
    `Guest 状态未被清空、也未污染账号（guest 标记=${guestMarked}；切到账号后 103=${inAccount.pool103}；` +
      `切回 guest 后 103=${backToGuest.pool103}）`
  );

  // ---- P2-观察回归：newReply 期间哪些字段会随下一轮 discovery 刷新 ----
  //
  // 必须先切回登录态：discoverNewReplies 对 guest 是早返回的（Guest 走本地基线）。
  await page.goto(topicUrl("__set?login=1&user=42&unread=1"), { waitUntil: "domcontentloaded" });
  await reloadListForCoverage();

  // 结论（实测）：
  //   - unreadPosts 会刷新；
  //   - lastReadPostNumber **不会**刷新。
  // 因此"下一轮 discovery 会覆盖过期缓存"这句话只对
  // "已离开 NEW_REPLY 后再次被发现"的场景成立（那时走 markNewReply 会全量写入），
  // 对"一直留在 NEW_REPLY"的场景**不成立**。
  const staleRefresh = await extEval(page, browser, `(async () => {
    await window.LDFCDB.clearTopics();
    await window.LDFCTopicState.load();
    await window.LDFCPoolManager.markInterested({ topicId: "102" });
    // 第一次发现：阅读位置 2，未读 4
    await window.LDFCPoolManager.discoverNewReplies([
      { topicId: "102", unreadPosts: 4, lastReadPostNumber: 2, highestPostNumber: 6, lastPostedAt: "2026-09-01T00:00:00.000Z" }
    ]);
    const first = window.LDFCTopicState.get("102");
    // 用户只读到 4：tracking 给出新的阅读位置 4，仍剩 2 条未读
    await window.LDFCPoolManager.discoverNewReplies([
      { topicId: "102", unreadPosts: 2, lastReadPostNumber: 4, highestPostNumber: 6, lastPostedAt: "2026-09-02T00:00:00.000Z" }
    ]);
    const second = window.LDFCTopicState.get("102");

    // 对照：先清除 newReply，再重新被发现 → 走 markNewReply，应当全量刷新
    await window.LDFCTopicState.clearNewReply("102");
    await window.LDFCPoolManager.discoverNewReplies([
      { topicId: "102", unreadPosts: 5, lastReadPostNumber: 9, highestPostNumber: 14, lastPostedAt: "2026-09-03T00:00:00.000Z" }
    ]);
    const third = window.LDFCTopicState.get("102");

    return {
      首次: { unread: first?.unreadPosts, lastRead: first?.lastReadPostNumber },
      留在newReply期间: {
        unread: second?.unreadPosts,
        lastRead: second?.lastReadPostNumber,
        highest: second?.highestPostNumber
      },
      留在newReply期间的第一个未读地址: window.LDFCDiscourseAdapter.topicUnreadUrl(second ?? {}),
      留在newReply期间的预览缓存是否已失效:
        second ? second.previewForRead !== second.lastReadPostNumber : null,
      清除后重新发现: { unread: third?.unreadPosts, lastRead: third?.lastReadPostNumber }
    };
  })()`);

  // 核心断言：Topic 持续留在 NEW_REPLY 期间，阅读位置也必须跟上。
  // 否则「第一条未读预览」会停在用户已经读过的楼层，违反规格
  // "预览 = 当前 last-read 位置之后的第一条未读回复"。
  record(
    staleRefresh.留在newReply期间.unread === 2 &&
      staleRefresh.留在newReply期间.lastRead === 4 &&
      staleRefresh.留在newReply期间.highest === 6 &&
      staleRefresh.留在newReply期间的第一个未读地址 === "/t/topic/102/5" &&
      staleRefresh.留在newReply期间的预览缓存是否已失效 === true,
    `NEW_REPLY 期间阅读位置必须跟随更新（lastRead ${staleRefresh.首次.lastRead} → ` +
      `${staleRefresh.留在newReply期间.lastRead}，未读 ${staleRefresh.留在newReply期间.unread}，` +
      `第一个未读 ${staleRefresh.留在newReply期间的第一个未读地址}，` +
      `预览缓存已失效=${staleRefresh.留在newReply期间的预览缓存是否已失效}）`
  );

  record(
    staleRefresh.首次.lastRead === 2 &&
      staleRefresh.清除后重新发现.lastRead === 9 &&
      staleRefresh.清除后重新发现.unread === 5,
    `离开 NEW_REPLY 后重新发现仍会全量刷新（${JSON.stringify(staleRefresh.清除后重新发现)}）`
  );

  // ---- AC-022：移动端 Swipe ----
  await extEval(page, browser, `window.LDFCDB.clearTopics()
    .then(() => window.LDFCTopicState.load())`);
  await reloadListForCoverage();

  // 触摸事件在主世界派发（DOM 事件跨世界共享，隔离世界的监听器收得到）；
  // 但状态必须用 extEval 在隔离世界读 —— page.evaluate 读不到 window.LDFCTopicState。
  //
  // 三次手势必须**逐个派发、逐个读状态**：
  // 右滑会把那一行标成感兴趣并隐藏，如果三次都读同一条记录，
  // 后面读到的其实是"右滑之后"的状态，测不出垂直滚动有没有被误判。
  const dispatchSwipe = (dx, dy) => page.evaluate(async ({ dx, dy }) => {
    const row = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .find((el) => el.offsetParent !== null);
    if (!row) return null;
    const topicId = row.dataset.topicId;
    const fire = (type, x, y) => {
      const touch = new Touch({ identifier: 1, target: row, clientX: x, clientY: y });
      row.dispatchEvent(new TouchEvent(type, {
        touches: type === "touchend" ? [] : [touch],
        changedTouches: [touch],
        bubbles: true, cancelable: true
      }));
    };
    fire("touchstart", 200, 300);
    fire("touchmove", 200 + dx, 300 + dy);
    fire("touchend", 200 + dx, 300 + dy);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    return { topicId };
  }, { dx, dy });

  const readPool = async (topicId) =>
    topicId ? extEval(page, browser, `window.LDFCTopicState.get("${topicId}")?.basePool ?? null`) : null;

  // 1) 垂直为主（dx=15，dy=200）→ 不得被当成 Swipe
  const verticalSwipe = await dispatchSwipe(15, 200);
  const verticalPool = await readPool(verticalSwipe?.topicId);

  // 2) 右滑 → 感兴趣
  const rightSwipe = await dispatchSwipe(160, 5);
  const rightPool = await readPool(rightSwipe?.topicId);

  // 3) 左滑 → 不感兴趣
  const leftSwipe = await dispatchSwipe(-160, 5);
  const leftPool = await readPool(leftSwipe?.topicId);

  record(
    verticalPool === null && rightPool === "INTERESTED" && leftPool === "DISMISSED",
    `移动端 Swipe（右滑→感兴趣 ${rightPool}；左滑→不感兴趣 ${leftPool}；` +
      `垂直滚动未被误判 ${verticalSwipe?.topicId}=${verticalPool}）`
  );

  // 恢复默认状态，避免影响后续步骤
  await extEval(page, browser, `window.LDFCDB.clearTopics()
    .then(() => window.LDFCTopicState.clearVisits())
    .then(() => window.LDFCDB.putMeta("initialized", true))
    .then(() => window.LDFCDB.putMeta("onboardingPrompted", true))
    .then(() => window.LDFCTopicState.load())`);
  await page.goto(topicUrl("__set?login=1&user=42&unread=1"), { waitUntil: "domcontentloaded" });
  await reloadListForCoverage();

  // ---------------- 发现层覆盖缺口（AC-005 发现侧）----------------
  // 真实站点实测：topic 2902024 在 /latest.json 第一页带 unread_posts=3，
  // 但既不在 tracking 快照、也不在 /unread.json 第 0 页 → 旧实现在**发现层看不到它**，
  // 一个确实有新回复、且已被标成感兴趣的 Topic 永远不会进入「新回复」。
  console.log("[19/20] 发现层覆盖（/latest.json 非 null 的 unread_posts）");

  const clean = async () => {
    await extEval(page, browser, `window.LDFCDB.clearTopics()
      .then(() => window.LDFCTopicState.clearVisits())
      .then(() => window.LDFCTopicState.load())`);
  };
  const reload = async () => {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await waitForNavigation(page);
    await page.waitForTimeout(1500);
  };
  const markAndSync = async (topicId) => {
    await clean();
    await reload();
    await extEval(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "${topicId}" })`);
    await reload();
    await page.waitForTimeout(2500);
    return extEval(page, browser, `(() => {
      const r = window.LDFCTopicState.get("${topicId}");
      return r ? { basePool: r.basePool, inNewReply: r.inNewReply, unreadPosts: r.unreadPosts, lastRead: r.lastReadPostNumber } : null;
    })()`);
  };

  // 用例 1：只有 /latest.json 能看到它 → 仍然必须发现新回复
  const onlyLatest = await markAndSync("105");
  record(
    onlyLatest?.inNewReply === true && onlyLatest?.unreadPosts === 3 && onlyLatest?.lastRead === 59,
    `只有 /latest.json 有信号时仍能发现新回复（105：inNewReply=${onlyLatest?.inNewReply}，` +
      `未读=${onlyLatest?.unreadPosts}，lastRead=${onlyLatest?.lastRead}）`
  );

  // 用例 2：unread_posts = null 不得被当成 0（104 在所有来源里都没有可靠数值）
  const nullNotZero = await markAndSync("104");
  record(
    nullNotZero?.inNewReply === false,
    `unread_posts 为 null 时不产生新回复（104：inNewReply=${nullNotZero?.inNewReply}，未读=${nullNotZero?.unreadPosts}）`
  );

  // 用例 6：tracking 里 last_read_post_number = null 的行不得被当成"整帖未读"
  const trackedNull = await markAndSync("106");
  record(
    trackedNull?.inNewReply === false,
    `tracking 的 lastRead=null 不产生新回复（106：inNewReply=${trackedNull?.inNewReply}，未读=${trackedNull?.unreadPosts}）`
  );

  // 用例 3：unread_posts = 0 不得仅凭它清除 newReplyPending
  await clean();
  await reload();
  const zeroNotClear = await extEval(page, browser, `(async () => {
    await window.LDFCPoolManager.markInterested({ topicId: "101" });
    // 101 在 /latest.json 里带 unread_posts = 0（用户互动过但已读完）
    await window.LDFCTopicState.markNewReply("101", { unreadPosts: 5, lastReadPostNumber: 3, highestPostNumber: 8 });
    const before = window.LDFCTopicState.get("101")?.inNewReply;
    // 只跑发现层，避免完成确认路径干扰这条断言
    const latest = await window.LDFCDiscourseAdapter.fetchLatestList();
    const unread = await window.LDFCDiscourseAdapter.fetchUnreadList();
    await window.LDFCPoolManager.discoverNewReplies(unread, latest);
    const after = window.LDFCTopicState.get("101")?.inNewReply;
    return { before, after };
  })()`);
  record(
    zeroNotClear.before === true && zeroNotClear.after === true,
    `unread_posts=0 不用于清除 newReplyPending（101：${zeroNotClear.before} → ${zeroNotClear.after}）`
  );

  // 用例 4 + 5：多来源重叠（201 同时在 tracking 和 /unread 第 0 页）→ 不重复、数量正确
  const overlap = await markAndSync("201");
  const overlapCount = await extEval(page, browser, `({
    listLength: window.LDFCTopicState.listNewReply().filter((r) => r.topicId === "201").length,
    total: window.LDFCTopicState.listNewReply().length
  })`);
  record(
    overlap?.inNewReply === true && overlap?.unreadPosts === 5 &&
      overlapCount.listLength === 1 && overlapCount.total === 1,
    `多来源重叠不产生重复新回复（201：未读=${overlap?.unreadPosts}，` +
      `本 Topic 条目数=${overlapCount.listLength}，待处理总数=${overlapCount.total}）`
  );

  // 收尾：清干净，避免影响后面的控制台检查
  await clean();
  await reload();

  console.log("[20/20] 控制台错误 + 截图");
  const extensionErrors = consoleErrors.filter((item) => item.fromExtension);
  const siteErrors = consoleErrors.filter((item) => !item.fromExtension);
  record(
    extensionErrors.length === 0,
    extensionErrors.length === 0
      ? `插件自身没有报错（站点自身另有 ${siteErrors.length} 条无关日志，已忽略）`
      : `插件报错 ${extensionErrors.length} 条：${extensionErrors.slice(0, 3).map((item) => item.text).join(" | ")}`
  );

  const shotPath = path.join(LAB_DIR, "acceptance-result.png");
  await page.screenshot({ path: shotPath, fullPage: false });
  results.push(`INFO：截图已保存 ${shotPath}`);

  process.exit(report() ? 1 : 0);
}

main().catch((error) => {
  console.error("验收脚本异常：", error.message);
  report();
  process.exit(1);
});
