"use strict";

// 两个疑点的补充探测：
//   1. 作者链接点击为什么没跳到 /u/（是否弹出用户卡片）
//   2. 搜索页的结果容器到底是什么（AC-032 需要确认插件该避开哪些节点）
// 只读 + 正常点击，不改页面。

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

(async () => {
  const port = Number((process.argv.find((a) => a.startsWith("--port=")) || "").split("=")[1] || 9223);
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const base = new URL(page.url()).origin;
  const out = {};

  // ---- 1. 作者链接点击 ----
  await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  await page.locator(".topic-list-item a[href^='/u/']").first().click();
  await page.waitForTimeout(2500);
  out.authorClick = {
    urlAfterClick: page.url(),
    navigatedToUserPage: page.url().includes("/u/"),
    userCardShown: await page.evaluate(() => !!document.querySelector(".user-card, .user-card-content, #user-card")),
    popupShown: await page.evaluate(() => !!document.querySelector(".fk-d-menu, .d-popover, .user-menu")),
    bodyHasUserLink: await page.evaluate(() => !!document.querySelector("a[href^='/u/']"))
  };

  // ---- 2. 搜索页 DOM ----
  await page.goto(`${base}/search?q=linux`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4000);
  out.searchPage = await page.evaluate(() => {
    const selectors = [
      ".search-results", ".search-result", ".fps-result", ".topic-list",
      ".topic-list-item", ".search-container", "#search-results",
      ".search-title", ".search-link", "[data-topic-id]"
    ];
    const counts = {};
    for (const s of selectors) counts[s] = document.querySelectorAll(s).length;

    // 搜索结果的"类 Topic 行"长什么样
    const sample = document.querySelector(".fps-result, .search-result");
    return {
      counts,
      resultsContainerFound: !!document.querySelector(".search-results, .search-container, #search-results"),
      sampleShape: sample ? { tag: sample.tagName, cls: (sample.className || "").toString().slice(0, 100) } : null,
      sampleHasTopicId: sample ? !!sample.closest("[data-topic-id]") || !!sample.querySelector("[data-topic-id]") : null,
      // 关键：搜索结果里的链接指向哪
      firstResultLinks: [...document.querySelectorAll(".fps-result a[href^='/t/'], .search-result a[href^='/t/']")]
        .slice(0, 3).map((a) => a.getAttribute("href")),
      bodyTextHead: document.body.innerText.replace(/\s+/g, " ").slice(0, 220)
    };
  });

  // ---- 3. 插件在搜索页会不会误伤：解析器选到几行 ----
  out.searchParserDryRun = await page.evaluate(() => {
    const rows = document.querySelectorAll(".topic-list-item[data-topic-id], .latest-topic-list-item[data-topic-id]");
    return { rowsExtensionWouldTreatAsTopics: rows.length };
  });

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("失败：", error.message);
  process.exit(1);
});
