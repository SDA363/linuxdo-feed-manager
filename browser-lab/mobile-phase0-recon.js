"use strict";

// LDFC Mobile Phase 0 —— 真实站点移动端仿真侦察（只读）。
//
// 方法：用 CDP 的移动仿真（窄视口 + 触摸 + Android UA）在**真实 linux.do** 上跑，
// 观察在移动条件下：
//   1. Discourse 是否给出不同的 DOM
//   2. 扩展的解析器/导航/面板是否还能工作
//   3. 触摸事件能不能驱动已有的 swipe.js
//   4. hover-only 的按钮在触摸端是否真的不可达
//
// 诚实声明：这是**桌面 Chrome 的移动仿真**，不是真实移动浏览器。
// 它能验证 DOM / 触摸 / 布局，但**不能**验证"移动浏览器能否加载扩展"。
//
// 不修改任何正式代码。用法：node mobile-phase0-recon.js --port=9223

const fs = require("node:fs");
const path = require("node:path");

const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

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
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9223);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const session = await context.newCDPSession(page);

  const out = { startedAt: new Date().toISOString(), port };

  try {
    // ---------- 打开移动仿真 ----------
    // 注意：**不覆盖 User-Agent**。
    // 第一次尝试覆盖成 Android UA 时，会话 cookie 是桌面 UA 签发的，
    // UA 与 cookie 不一致直接触发 Cloudflare 人机验证（页面标题变成"请稍候…"），
    // 结果什么都没侦察到。改用 Discourse 自己的 `?mobile_view=1` 强制移动模板。
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    await page.goto("https://linux.do/latest?mobile_view=1", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(7000);

    // 先确认没被站点防护拦下，否则后面的结论全部无效
    out.pageGuard = await page.evaluate(() => ({
      title: document.title,
      challenged: /请稍候|just a moment|checking your browser/i.test(document.title) ||
        !!document.querySelector("#challenge-form, #cf-challenge-running"),
      bodyLen: document.body ? document.body.innerText.length : 0
    }));
    if (out.pageGuard.challenged) {
      throw new Error(`站点防护拦截，侦察无效（标题：${out.pageGuard.title}）`);
    }

    out.viewport = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      hasTouch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
      maxTouchPoints: navigator.maxTouchPoints,
      ua: navigator.userAgent.slice(0, 80)
    }));

    // ---------- 1. Discourse 在移动条件下的 DOM ----------
    out.discourseDom = await page.evaluate(() => {
      const count = (sel) => document.querySelectorAll(sel).length;
      return {
        htmlClasses: [...document.documentElement.classList],
        bodyClasses: [...document.body.classList].slice(0, 12),
        mobileViewElement: !!document.querySelector(".mobile-view"),
        topicListItem: count(".topic-list-item"),
        topicListItemWithId: count(".topic-list-item[data-topic-id]"),
        latestTopicListItem: count(".latest-topic-list-item"),
        anyDataTopicId: count("[data-topic-id]"),
        loadMoreSentinel: count(".load-more-sentinel"),
        // 移动端是否用了完全不同的模板
        firstRowTag: document.querySelector(".topic-list-item")?.tagName ?? null,
        firstRowClasses: [...(document.querySelector(".topic-list-item")?.classList ?? [])].slice(0, 6),
        titleLinkClass: document.querySelector(".topic-list-item a.title, .topic-list-item a.raw-topic-link")?.className ?? null
      };
    });

    // ---------- 2. 扩展在移动条件下是否可用 ----------
    const extSession = await context.newCDPSession(page);
    const seen = [];
    extSession.on("Runtime.executionContextCreated", (e) => seen.push(e.context));
    await extSession.send("Runtime.enable");
    await new Promise((r) => setTimeout(r, 300));
    const extCtx = seen.find((c) => (c.origin || "").startsWith("chrome-extension://"));

    const extEval = async (expr) => {
      if (!extCtx) return null;
      const wrapped = `(async () => { const v = await (${expr}); return JSON.stringify(v === undefined ? "undefined" : v); })()`;
      const r = await extSession.send("Runtime.evaluate", {
        expression: wrapped, contextId: extCtx.id, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description).slice(0, 120) };
      return JSON.parse(r.result.value);
    };

    out.extension = {
      isolatedWorldFound: !!extCtx,
      parserRows: await extEval(`window.LDFCTopicParser.listRows().length`),
      mobileRowFinder: await extEval(`(() => {
        const row = window.LDFCTopicParser.listRows()[0];
        if (!row) return null;
        const found = window.LDFCTopicParser.findTopicRow(row.querySelector("a.title, a.raw-topic-link") || row);
        return { foundSameRow: found === row };
      })()`),
      identity: await extEval(`window.LDFCIdentity.current()`),
      navPools: await extEval(`[...document.querySelectorAll("#ldfc-navigation button[data-pool]")].map((b) => b.dataset.pool)`),
      actionButtons: await extEval(`document.querySelectorAll(".ldfc-action").length`)
    };

    // ---------- 3. 布局：扩展的固定定位元素在窄屏下的表现 ----------
    out.layout = await page.evaluate(() => {
      const rect = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          left: Math.round(r.left), top: Math.round(r.top),
          right: Math.round(r.right), bottom: Math.round(r.bottom),
          w: Math.round(r.width), h: Math.round(r.height),
          offscreenRight: r.right > window.innerWidth + 1,
          offscreenLeft: r.left < -1
        };
      };
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        navigation: rect("#ldfc-navigation"),
        settingsLaunch: rect("#ldfc-settings-launch"),
        // 五区导航按钮在窄屏下会不会换行/溢出
        navButtonCount: document.querySelectorAll("#ldfc-navigation button[data-pool]").length,
        navScrollWidth: document.querySelector("#ldfc-navigation")?.scrollWidth ?? null,
        navClientWidth: document.querySelector("#ldfc-navigation")?.clientWidth ?? null
      };
    });

    // ---------- 4. hover-only 按钮在触摸端是否可达 ----------
    out.hoverButtons = await page.evaluate(() => {
      const actions = document.querySelector(".ldfc-actions");
      if (!actions) return { found: false };
      const cs = getComputedStyle(actions);
      const row = actions.closest(".topic-list-item");
      const rowRect = row?.getBoundingClientRect();
      const actRect = actions.getBoundingClientRect();
      return {
        found: true,
        style: { opacity: cs.opacity, visibility: cs.visibility, display: cs.display, pointerEvents: cs.pointerEvents },
        actionsRect: { w: Math.round(actRect.width), h: Math.round(actRect.height) },
        rowRect: rowRect ? { w: Math.round(rowRect.width), h: Math.round(rowRect.height) } : null,
        // 关键：不用 hover 时按钮可见吗？
        visibleWithoutHover: cs.visibility !== "hidden" && cs.opacity !== "0" && actRect.width > 0
      };
    });

    // ---------- 5. 触摸事件能否驱动已有的 swipe.js ----------
    out.touchSwipe = await page.evaluate(async () => {
      const fire = (target, type, x, y) => {
        const t = new Touch({ identifier: 1, target, clientX: x, clientY: y });
        target.dispatchEvent(new TouchEvent(type, {
          touches: type === "touchend" ? [] : [t],
          changedTouches: [t], bubbles: true, cancelable: true
        }));
      };
      const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")];
      const pick = () => rows.find((r) => r.offsetParent !== null);
      const results = {};

      // 垂直滑动：不得被当成 swipe
      const vRow = pick();
      const vId = vRow?.dataset.topicId;
      if (vRow) {
        fire(vRow, "touchstart", 200, 300);
        fire(vRow, "touchmove", 214, 460);
        fire(vRow, "touchend", 214, 520);
        await new Promise((r) => setTimeout(r, 600));
        results.verticalId = vId;
      }

      // 横向滑动：右滑
      const hRow = pick();
      const hId = hRow?.dataset.topicId;
      if (hRow) {
        fire(hRow, "touchstart", 80, 400);
        fire(hRow, "touchmove", 220, 405);
        fire(hRow, "touchend", 260, 408);
        await new Promise((r) => setTimeout(r, 900));
        results.rightSwipeId = hId;
      }
      results.touchEventsSupported = typeof TouchEvent === "function";
      return results;
    });

    // 读回状态（隔离世界）
    out.touchSwipeState = {
      verticalTopicPool: await extEval(`window.LDFCTopicState.get("${out.touchSwipe.verticalId}")?.basePool ?? null`),
      rightSwipeTopicPool: await extEval(`window.LDFCTopicState.get("${out.touchSwipe.rightSwipeId}")?.basePool ?? null`)
    };

    // 清理这次触摸测试造成的记录
    out.touchCleanup = await extEval(`(async () => {
      const ids = ["${out.touchSwipe.verticalId}", "${out.touchSwipe.rightSwipeId}"].filter(Boolean);
      const before = window.LDFCTopicState.records.size;
      for (const id of ids) {
        const r = window.LDFCTopicState.get(id);
        if (r) await window.LDFCPoolManager.moveHome(id);
      }
      await window.LDFCFilter.applyRows();
      return { before, after: window.LDFCTopicState.records.size, movedIds: ids };
    })()`);
  } finally {
    // ---------- 关闭仿真，恢复桌面 ----------
    await session.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await session.detach().catch(() => {});
  }

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("侦察失败：", error.message);
  process.exit(1);
});
