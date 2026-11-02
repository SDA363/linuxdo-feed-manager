const { chromium } = require("C:/Users/asddn/AppData/Local/OpenAI/Codex/runtimes/cua_node/a708e72b10c27b59/bin/node_modules/playwright");

const extensionPath = "D:/桌面/codex/linuxdo插件/linuxdo-personal-feed-manager";
const proxy = process.env.LDFC_PROXY;
const debuggerUrl = process.env.LDFC_DEBUG_URL ?? "http://127.0.0.1:9222";

async function waitForNavigationReady(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector("#ldfc-navigation", { timeout: 15000 });
  await page.waitForSelector(".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]", { timeout: 20000 });
}

async function firstVisibleTopicId(page) {
  return page.evaluate(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]")];
    const state = window.LDFCTopicState;
    const visible = rows.filter((row) => {
      const record = state?.get(row.dataset.topicId);
      return !record || record.basePool === "HOME";
    });
    return visible[0]?.dataset.topicId ?? null;
  });
}

async function run() {
  const results = [];
  const networkResponses = [];

  const browser = await chromium.connectOverCDP(debuggerUrl);
  const context = browser.contexts()[0] ?? await browser.newContext();

  context.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/latest.json") || url.includes("/unread.json")) {
      networkResponses.push({ url, status: response.status() });
    }
  });

  const page = context.pages()[0] ?? await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") results.push(`Console error: ${message.text()}`);
  });

  await page.goto("https://linux.do/latest", { waitUntil: "domcontentloaded" });

  try {
    await waitForNavigationReady(page);
    results.push("PASS: 导航注入成功，能看到五区入口");
  } catch {
    results.push("FAIL: 没看到 #ldfc-navigation，可能是扩展未注入或站点 DOM 不同");
    await page.screenshot({ path: "acceptance-injection-fail.png", fullPage: true });
    console.log(results.join("\n"));
    await context.close();
    return;
  }

  const hasRows = await page.locator(".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]").count();
  results.push(hasRows ? "PASS: 找到带 data-topic-id 的 Topic 行" : "FAIL: 没找到带 data-topic-id 的 Topic 行");

  if (hasRows) {
    const firstTopicId = await firstVisibleTopicId(page);
    if (firstTopicId) {
      const row = page.locator(`[data-topic-id="${firstTopicId}"]`).first();
      await row.hover();
      await row.locator(".ldfc-action.interested").click();
      await page.waitForTimeout(500);

      const interestedCount = await page.evaluate((topicId) => {
        const record = window.LDFCTopicState.get(topicId);
        const navCount = document.querySelector('#ldfc-navigation button[data-pool="INTERESTED"] span')?.textContent;
        return { record: record?.basePool, navCount };
      }, firstTopicId);

      results.push(
        interestedCount.record === "INTERESTED"
          ? `PASS: Topic ${firstTopicId} 已标记感兴趣`
          : `FAIL: Topic ${firstTopicId} 未标记感兴趣，当前 ${interestedCount.record}`
      );

      const rowHidden = await page.evaluate((topicId) => {
        const target = document.querySelector(`[data-topic-id="${topicId}"]`);
        return target?.classList.contains("ldfc-row-hidden") || target?.style.display === "none";
      }, firstTopicId);
      results.push(rowHidden ? "PASS: 感兴趣后从主信息流隐藏" : "FAIL: 感兴趣后仍可见");

      await page.reload({ waitUntil: "domcontentloaded" });
      await waitForNavigationReady(page);

      const persisted = await page.evaluate((topicId) => window.LDFCTopicState.get(topicId)?.basePool, firstTopicId);
      results.push(persisted === "INTERESTED" ? "PASS: 刷新后状态保留" : "FAIL: 刷新后状态丢失");

      await page.locator('#ldfc-navigation button[data-pool="INTERESTED"]').click();
      await page.waitForTimeout(200);
      const panelVisible = await page.locator("#ldfc-panel").isVisible();
      results.push(panelVisible ? "PASS: 感兴趣面板可打开" : "FAIL: 感兴趣面板未打开");

      await page.locator("#ldfc-panel .ldfc-panel-item").first().locator("button", { hasText: "移回主信息流" }).click();
      await page.waitForTimeout(300);
      const restored = await page.evaluate((topicId) => window.LDFCTopicState.get(topicId)?.basePool, firstTopicId);
      results.push(restored === "HOME" ? "PASS: 可移回主信息流" : `FAIL: 未恢复 HOME，当前 ${restored}`);
    }
  }

  const latest = networkResponses.find((response) => response.url.includes("/latest.json"));
  results.push(
    latest
      ? `PASS: /latest.json 返回 ${latest.status}`
      : "WARN: 没捕获到 /latest.json 请求，可能由页面缓存或路由时机导致"
  );

  await page.screenshot({ path: "acceptance-result.png", fullPage: false });
  console.log(results.join("\n"));
  await browser.close();
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});


