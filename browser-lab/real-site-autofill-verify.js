"use strict";

// LDFC 真实站点「自动补位不得主动滚动页面」验证（AC-029 / P1 决策）。
//
// 决策：自动补位只在用户自然接近列表底部时触发；禁止插件主动滚动页面。
//
// 本脚本只做观测与正常用户操作，不修改任何正式代码。
// 为让"补位真的能触发"，会临时把若干**真实 Topic** 标成「感兴趣」以缩短列表，
// **结束后按 id 精确还原为 HOME**。
//
// 用法：node real-site-autofill-verify.js --port 9223

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

async function extEval(page, browser, expression) {
  const context = browser.contexts()[0];
  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const target = seen.find((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!target) throw new Error("没有找到插件的隔离世界");
  const wrapped = `(async () => {
    const value = await (${expression});
    if (value === undefined) return "undefined";
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  })()`;
  const result = await session.send("Runtime.evaluate", {
    expression: wrapped, contextId: target.id, awaitPromise: true, returnByValue: true
  });
  await session.detach().catch(() => {});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "插件世界执行失败");
  return result.result.value;
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

  const pageRequests = [];
  page.on("request", (request) => {
    if (/\/latest\.json\?[^"]*page=/.test(request.url())) pageRequests.push(request.url());
  });

  const findings = [];
  const note = (fields) => findings.push(fields);

  const load = async () => {
    await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(900);
  };

  const out = { startedAt: new Date().toISOString(), port };
  const recordsBefore = await (async () => { await load(); return extEval(page, browser, "window.LDFCTopicState.records.size"); })();
  out.recordsBefore = recordsBefore;

  // ---------- A：用户在页面中部 ----------
  const aBefore = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    rows: document.querySelectorAll(".topic-list-item[data-topic-id]").length
  }));
  const aGates = {
    sentinelInView: await extEval(page, browser, "window.LDFCAutofill.sentinelInViewport()"),
    visibleHomeRows: await extEval(page, browser, "window.LDFCAutofill.visibleHomeRowCount()"),
    shouldLoadMore: await extEval(page, browser, "window.LDFCAutofill.shouldLoadMore()")
  };
  pageRequests.length = 0;
  const aFill = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(1600);
  const aAfter = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    rows: document.querySelectorAll(".topic-list-item[data-topic-id]").length
  }));

  note({
    项目: "A. 用户位于列表中部",
    测试前状态: `scrollY=${aBefore.scrollY}，DOM ${aBefore.rows} 行`,
    操作步骤: "在顶部调用一次 maybeFill()（模拟内容变化后的自动检查）",
    实际结果: { 门控: aGates, maybeFill: aFill, 前: aBefore, 后: aAfter, 分页请求: pageRequests },
    预期结果: "哨兵在视口外 → 不补位、不滚动、不发请求",
    判定: aFill === false && aAfter.scrollY === aBefore.scrollY && pageRequests.length === 0 ? "PASS" : "FAIL"
  });

  // ---------- B：用户自然往下滚 ----------
  await load();
  const scrollTrail = [];
  pageRequests.length = 0;
  for (let step = 0; step < 5; step += 1) {
    const before = await page.evaluate(() => Math.round(window.scrollY));
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await page.waitForTimeout(1100);
    const afterUser = await page.evaluate(() => Math.round(window.scrollY));
    const fill = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
    await page.waitForTimeout(1200);
    const afterFill = await page.evaluate(() => Math.round(window.scrollY));
    scrollTrail.push({
      step: step + 1,
      用户滚动: `${before}→${afterUser}`,
      maybeFill: fill,
      补位后scrollY: afterFill,
      扩展是否改动了位置: afterFill !== afterUser
    });
  }
  const extensionMoved = scrollTrail.filter((s) => s.扩展是否改动了位置);

  note({
    项目: "B. 用户自然往下滚动的全过程",
    测试前状态: "从顶部开始，每次向下滚动一屏，滚动后调用一次 maybeFill()",
    操作步骤: "5 次「滚动 → maybeFill → 记录 scrollY」",
    实际结果: { 轨迹: scrollTrail, 分页请求: pageRequests.length, 扩展改动位置次数: extensionMoved.length },
    预期结果: "扩展在任何一步都不得改变用户的滚动位置",
    判定: extensionMoved.length === 0 ? "PASS" : "FAIL"
  });

  // ---------- C：人为让列表变短（隐藏大部分行），验证"原地补位" ----------
  //
  // 关键：标记与"读门控"必须在**同一次插件世界求值**里完成，
  // 否则两次求值之间扩展已经自动补位，测到的就是补完之后的状态。
  await load();
  pageRequests.length = 0;

  const cSetup = await extEval(page, browser, `(async () => {
    const rows = [...window.LDFCTopicParser.listRows()];
    const ids = rows.map((row) => row.dataset.topicId).slice(0, Math.max(rows.length - 4, 1));
    for (const topicId of ids) await window.LDFCPoolManager.markInterested({ topicId });
    await window.LDFCFilter.applyRows();
    return {
      ids,
      scrollY: Math.round(window.scrollY),
      sentinelInView: window.LDFCAutofill.sentinelInViewport(),
      visibleHomeRows: window.LDFCAutofill.visibleHomeRowCount(),
      shouldLoadMore: window.LDFCAutofill.shouldLoadMore(),
      domRows: document.querySelectorAll(".topic-list-item[data-topic-id]").length
    };
  })()`);

  const cFill = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(2500);
  const cAfter = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    rows: document.querySelectorAll(".topic-list-item[data-topic-id]").length
  }));
  const cWindowRequests = pageRequests.slice();
  pageRequests.length = 0;
  const cFillAgain = await extEval(page, browser, "window.LDFCAutofill.maybeFill()");
  await page.waitForTimeout(1500);
  const cRepeatRequests = pageRequests.slice();

  note({
    项目: "C. 过滤后列表变短时的原地补位",
    测试前状态: `用户此前未滚动（scrollY=${cSetup.scrollY}）；临时把 ${cSetup.ids.length} 个真实 Topic 标成感兴趣以缩短列表`,
    操作步骤: "标记后立刻读门控 → 调用 maybeFill() → 等待 2.5 秒 → 再调用一次",
    实际结果: {
      标记后立刻读到的门控: {
        sentinelInView: cSetup.sentinelInView,
        visibleHomeRows: cSetup.visibleHomeRows,
        shouldLoadMore: cSetup.shouldLoadMore
      },
      标记时DOM行数: cSetup.domRows,
      maybeFill: cFill,
      补位后: cAfter,
      窗口内分页请求: cWindowRequests,
      第二次maybeFill: cFillAgain,
      第二次的请求: cRepeatRequests,
      用户从未滚动过: cSetup.scrollY === 0
    },
    预期结果: "列表变短 → 哨兵本就在视口内 → 允许补位；用户滚动位置必须保持 0；不得重复触发",
    判定: cAfter.scrollY === cSetup.scrollY && cSetup.scrollY === 0 ? "PASS" : "FAIL"
  });

  // ---------- 还原：按 id 删除记录（不是改归属） ----------
  const restore = await extEval(page, browser, `(async () => {
    const ids = ${JSON.stringify(cSetup.ids)};
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
    await window.LDFCFilter.applyRows();
    return window.LDFCTopicState.records.size;
  })()`);

  note({
    项目: "测试数据还原",
    测试前状态: `测试前用户记录 ${recordsBefore} 条；临时创建了 ${cSetup.ids.length} 条`,
    操作步骤: "按 id 精确删除临时记录（moveHome 只改归属不删记录，会留下残留）",
    实际结果: { 还原后记录数: restore },
    预期结果: "恢复到测试前的记录数",
    判定: restore === recordsBefore ? "PASS" : "FAIL"
  });

  out.findings = findings;
  out.markedCount = cSetup.ids.length;
  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("验证脚本异常：", error.message);
  process.exit(1);
});
