"use strict";

// LDFC 真实站点交互验证流程（B / C / D / E）。
//
// 只做正常用户会做的操作：点击链接、滚动、前进后退。不修改页面内容，
// 不注入正式功能代码。唯一注入的是"路由调用记录器"，用来观察 Discourse
// 到底怎么切路由（这决定了 AC-027 的实现候选能不能成立）。
//
// 用法：node real-site-flow.js --port 9223

const fs = require("node:fs");
const path = require("node:path");

function loadPlaywright() {
  const candidates = [];
  if (process.env.PLAYWRIGHT_MODULE) candidates.push(process.env.PLAYWRIGHT_MODULE);
  const home = process.env.USERPROFILE || process.env.HOME || "C:/Users/asddn";
  const cuaRoot = path.join(home, "AppData", "Local", "OpenAI", "Codex", "runtimes", "cua_node");
  try {
    for (const version of fs.readdirSync(cuaRoot)) {
      candidates.push(path.join(cuaRoot, version, "bin", "node_modules", "playwright"));
    }
  } catch {}
  candidates.push("playwright");
  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }
  throw new Error("找不到 Playwright 模块");
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) { flags[token.slice(2)] = next; index += 1; }
      else flags[token.slice(2)] = true;
    }
  }
  return flags;
}

const out = {};
const say = (key, value) => { out[key] = value; };

// 在主世界安装路由记录器。返回是否安装成功。
async function installRouteLogger(page) {
  await page.evaluate(() => {
    window.__routeLog = [];
    window.__ldfcMarker = "installed-" + Date.now();
    const push = history.pushState;
    const replace = history.replaceState;
    history.pushState = function (...args) {
      window.__routeLog.push({ fn: "pushState", url: String(args[2] ?? "") , t: Date.now() });
      return push.apply(this, args);
    };
    history.replaceState = function (...args) {
      window.__routeLog.push({ fn: "replaceState", url: String(args[2] ?? ""), t: Date.now() });
      return replace.apply(this, args);
    };
    window.addEventListener("popstate", () => {
      window.__routeLog.push({ fn: "popstate", url: location.href, t: Date.now() });
    });
  });
}

async function routeLoggerSurvived(page) {
  return page.evaluate(() => window.__ldfcMarker ?? null);
}

async function drainRouteLog(page) {
  return page.evaluate(() => {
    const log = window.__routeLog ?? [];
    window.__routeLog = [];
    return log;
  });
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const port = Number(flags.port || 9223);
  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];

  const requestLog = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.includes(".json") || url.includes("/latest") || url.includes("/unread")) {
      requestLog.push({ at: Date.now(), method: request.method(), url: url.replace("https://linux.do", "") });
    }
  });

  const base = new URL(page.url()).origin;
  say("startUrl", page.url());

  // ---------- C: SPA 路由机制 ----------
  await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await installRouteLogger(page);
  const markBefore = await routeLoggerSurvived(page);

  // C1: 列表 → Topic（用真实点击，不是直接 goto）
  const firstTitle = page.locator(".topic-list-item a.raw-topic-link").first();
  const titleHref = await firstTitle.getAttribute("href");
  await firstTitle.click();
  await page.waitForTimeout(2500);
  const afterTopicClick = {
    url: page.url(),
    sameDocument: (await routeLoggerSurvived(page)) === markBefore,
    routeLog: await drainRouteLog(page)
  };
  say("C1_listToTopic", { titleHref, ...afterTopicClick });

  // C2: Topic → 返回列表（浏览器后退）
  await page.goBack();
  await page.waitForTimeout(2000);
  say("C2_topicBackToList", {
    url: page.url(),
    sameDocument: (await routeLoggerSurvived(page)) === markBefore,
    routeLog: await drainRouteLog(page)
  });

  // C3: 列表 → 另一个原生列表（Top），验证 SPA 内切换
  const topLink = page.locator("a[href='/top'], a[href^='/top?']").first();
  if (await topLink.count()) {
    await topLink.click();
    await page.waitForTimeout(2500);
    say("C3_latestToTop", {
      url: page.url(),
      sameDocument: (await routeLoggerSurvived(page)) === markBefore,
      routeLog: await drainRouteLog(page),
      topicRowsNow: await page.locator(".topic-list-item[data-topic-id]").count()
    });
  } else {
    say("C3_latestToTop", { skipped: "页面上找不到 Top 入口" });
  }

  // ---------- B: 进入第一个未读位置 ----------
  // 找一个"确实有未读"的 Topic：从跟踪状态里取 last_read 非空且小于 highest 的。
  const unreadTarget = await page.evaluate(() => {
    const el = document.querySelector("#data-preloaded");
    if (!el) return null;
    const deep = (v) => { if (typeof v !== "string") return v; try { return JSON.parse(v); } catch { return v; } };
    const tracking = deep(JSON.parse(el.textContent || "{}").topicTrackingStates) ?? [];
    const row = tracking.find((r) => r.last_read_post_number != null && Number(r.highest_post_number) > Number(r.last_read_post_number));
    return row ? { topicId: String(row.topic_id), last: row.last_read_post_number, highest: row.highest_post_number } : null;
  });
  say("B0_unreadTarget", unreadTarget);

  if (unreadTarget) {
    requestLog.length = 0;
    await page.goto(`${base}/t/${unreadTarget.topicId}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    const reached = await page.evaluate(() => ({
      url: location.href,
      // 第一个可见楼层号
      firstVisiblePostNumber: (() => {
        const nodes = [...document.querySelectorAll("[id^='post_']")];
        const visible = nodes.find((n) => {
          const r = n.getBoundingClientRect();
          return r.top >= -50 && r.bottom > 0;
        });
        return visible ? visible.id.replace("post_", "") : null;
      })(),
      currentPostNumber: document.querySelector("#data-preloaded")?.textContent?.match(/"current_post_number":(\d+)/)?.[1] ?? null,
      postsRendered: document.querySelectorAll("[id^='post_']").length,
      scrollY: Math.round(window.scrollY)
    }));
    say("B1_openUnreadTopic", { expectedFirstUnread: Number(unreadTarget.last) + 1, ...reached });

    // 页面上是否有"回到未读位置 / 跳到最新"之类的原生入口
    const jumpUi = await page.evaluate(() => ({
      backToFirstUnread: !!document.querySelector(".topic-timeline .back-to-first-unread, .back-to-first-unread"),
      jumpToLatest: !!document.querySelector(".topic-timeline .jump-to-latest, .jump-to-latest"),
      timelinePresent: !!document.querySelector(".topic-timeline"),
      timelineButtons: [...document.querySelectorAll(".topic-timeline button, .topic-timeline a")].slice(0, 8).map((el) => ({
        cls: (el.className || "").toString().slice(0, 50),
        title: el.getAttribute("title") || el.textContent.trim().slice(0, 24)
      }))
    }));
    say("B2_timelineUi", jumpUi);

    // B4: 关键测试 —— "带楼层号的 URL" 到底会不会落在第一个未读楼层？
    // 这是 AC-014 的核心：插件若自己拼 /t/<slug>/<id>/<last+1>，是否等价于原站行为。
    requestLog.length = 0;
    await page.goto(`${base}/t/${unreadTarget.topicId}/${Number(unreadTarget.last) + 1}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3500);
    say("B4_urlWithPostNumber", await page.evaluate(() => {
      const nodes = [...document.querySelectorAll("[id^='post_']")];
      const visible = nodes.find((n) => {
        const r = n.getBoundingClientRect();
        return r.top >= -50 && r.bottom > 0;
      });
      return {
        url: location.href,
        firstVisiblePostNumber: visible ? visible.id.replace("post_", "") : null,
        scrollY: Math.round(window.scrollY),
        postsRendered: nodes.length
      };
    }));

    // B5: 原站自己的"未读列表"里，链接本身带不带楼层号？
    // 如果带，说明原生的"跳到第一个未读"就是靠 href，插件照抄即可。
    await page.goto(`${base}/unread`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2500);
    say("B5_nativeUnreadListLinks", await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".topic-list-item")].slice(0, 6);
      return rows.map((row) => {
        const a = row.querySelector("a.raw-topic-link, a.title");
        return { topicId: row.getAttribute("data-topic-id"), href: a?.getAttribute("href") ?? null };
      });
    }));

    say("B3_requestsDuringTopicOpen", requestLog.slice(-8));
  }

  // ---------- D: 自动补位 / 无限滚动 ----------
  await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  requestLog.length = 0;
  const rowsBeforeScroll = await page.locator(".topic-list-item[data-topic-id]").count();
  const sentinel = await page.evaluate(() => ({
    present: !!document.querySelector(".load-more-sentinel"),
    top: document.querySelector(".load-more-sentinel")?.getBoundingClientRect().top ?? null,
    docHeight: document.documentElement.scrollHeight,
    viewport: window.innerHeight
  }));

  const scrollSteps = [];
  for (let index = 0; index < 3; index += 1) {
    const before = requestLog.length;
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForTimeout(3000);
    scrollSteps.push({
      step: index + 1,
      newRequests: requestLog.slice(before).map((r) => r.url),
      rows: await page.locator(".topic-list-item[data-topic-id]").count()
    });
  }
  say("D_infiniteScroll", {
    rowsBeforeScroll,
    sentinel,
    scrollSteps,
    totalRequests: requestLog.length,
    requests: requestLog.map((r) => r.url)
  });

  // ---------- E: 原站兼容（点击类） ----------
  await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const compat = {};

  // 普通点击
  await page.locator(".topic-list-item a.raw-topic-link").first().click();
  await page.waitForTimeout(2000);
  compat.plainClick = page.url().includes("/t/");
  await page.goBack();
  await page.waitForTimeout(1500);

  // Ctrl+Click（新标签页）
  const pagesBefore = context.pages().length;
  await page.keyboard.down("Control");
  await page.locator(".topic-list-item a.raw-topic-link").first().click();
  await page.keyboard.up("Control");
  await page.waitForTimeout(2500);
  compat.ctrlClickOpenedNewTab = context.pages().length > pagesBefore;
  compat.ctrlClickStayedOnList = page.url().includes("/latest");
  for (const extra of context.pages()) {
    if (extra !== page && !extra.url().startsWith("devtools://") && extra.url().includes("/t/")) {
      await extra.close();
    }
  }
  await page.waitForTimeout(800);

  // 中键点击
  const pagesBeforeMiddle = context.pages().length;
  await page.locator(".topic-list-item a.raw-topic-link").first().click({ button: "middle" });
  await page.waitForTimeout(2500);
  compat.middleClickOpenedNewTab = context.pages().length > pagesBeforeMiddle;
  compat.middleClickStayedOnList = page.url().includes("/latest");
  for (const extra of context.pages()) {
    if (extra !== page && !extra.url().startsWith("devtools://") && extra.url().includes("/t/")) {
      await extra.close();
    }
  }

  // 作者链接
  await page.waitForTimeout(800);
  const authorLink = page.locator(".topic-list-item a[href^='/u/']").first();
  if (await authorLink.count()) {
    const authorHref = await authorLink.getAttribute("href");
    await authorLink.click();
    await page.waitForTimeout(2000);
    compat.authorClickWorks = page.url().includes("/u/");
    compat.authorHref = authorHref;
    await page.goBack();
    await page.waitForTimeout(1500);
  }

  // 搜索页
  await page.goto(`${base}/search?q=test`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  compat.searchPage = {
    url: page.url(),
    resultRows: await page.locator(".topic-list-item[data-topic-id], .search-result").count(),
    htmlClasses: await page.evaluate(() => [...document.documentElement.classList])
  };

  say("E_compat", compat);

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
  return 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  console.error("流程执行失败：", error.message);
  console.log(JSON.stringify(out, null, 2));
  process.exit(1);
});
