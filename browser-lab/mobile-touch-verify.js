"use strict";

// LDFC Mobile Phase 0 —— 触摸手势定向验证（只读 + 自清理）
//
// 修正上一版的两个方法错误：
//   1. 垂直手势与横向滑动手势必须用**不同的行**，否则读到的是"右滑之后"的状态，
//      区分不出垂直有没有被误触发；
//   2. 每次手势后**单独读一次状态**，不能在同一个 evaluate 里连着做完再读。
//
// 清理用**按 id 删除**（不是 moveHome —— 那只是改归属，会留下残留记录）。
//
// 用法：node mobile-touch-verify.js --port=9223

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
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9223);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const session = await context.newCDPSession(page);

  const out = {};
  let extSession = null;

  try {
    await session.send("Emulation.setDeviceMetricsOverride", {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true
    });
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });

    await page.goto("https://linux.do/latest?mobile_view=1", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(7000);

    const guard = await page.evaluate(() => ({
      title: document.title,
      challenged: /请稍候|just a moment/i.test(document.title)
    }));
    if (guard.challenged) throw new Error("站点防护拦截，验证无效");

    extSession = await context.newCDPSession(page);
    const seen = [];
    extSession.on("Runtime.executionContextCreated", (e) => seen.push(e.context));
    await extSession.send("Runtime.enable");
    await new Promise((r) => setTimeout(r, 300));
    const extCtx = seen.find((c) => (c.origin || "").startsWith("chrome-extension://"));

    const extEval = async (expr) => {
      const wrapped = `(async () => { const v = await (${expr}); return JSON.stringify(v === undefined ? "undefined" : v); })()`;
      const r = await extSession.send("Runtime.evaluate", {
        expression: wrapped, contextId: extCtx.id, awaitPromise: true, returnByValue: true
      });
      if (r.exceptionDetails) return { __error: String(r.exceptionDetails.exception?.description).slice(0, 150) };
      return JSON.parse(r.result.value);
    };

    out.before = {
      records: await extEval(`window.LDFCTopicState.records.size`),
      rows: await extEval(`window.LDFCTopicParser.listRows().length`)
    };

    // 取前 3 条"可见且当前无本地记录"的行，分别给三种手势用
    const picked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
        .filter((r) => r.offsetParent !== null);
      return rows.slice(0, 3).map((r) => ({
        id: r.dataset.topicId,
        title: (r.querySelector("a.title, a.raw-topic-link")?.textContent || "").trim().slice(0, 26)
      }));
    });
    out.pickedRows = picked;
    if (picked.length < 3) throw new Error("可见行不足 3 条，无法做三手势分离验证");

    const fire = (topicId, type, x, y) => page.evaluate(({ topicId, type, x, y }) => {
      const row = document.querySelector(`.topic-list-item[data-topic-id="${topicId}"]`);
      const t = new Touch({ identifier: 1, target: row, clientX: x, clientY: y });
      row.dispatchEvent(new TouchEvent(type, {
        touches: type === "touchend" ? [] : [t],
        changedTouches: [t], bubbles: true, cancelable: true
      }));
    }, { topicId, type, x, y });

    const poolOf = (id) => extEval(`window.LDFCTopicState.get("${id}")?.basePool ?? null`);
    const scrollY = () => page.evaluate(() => Math.round(window.scrollY));

    // ---- 手势 1：垂直为主（dx=14, dy=220）→ 必须不产生任何记录 ----
    const vId = picked[0].id;
    out.vertical = { topicId: vId, scrollBefore: await scrollY() };
    await fire(vId, "touchstart", 200, 300);
    await fire(vId, "touchmove", 214, 460);
    await fire(vId, "touchend", 214, 520);
    await page.waitForTimeout(1000);
    out.vertical.poolAfter = await poolOf(vId);
    out.vertical.scrollAfter = await scrollY();

    // ---- 手势 2：右滑（dx=+180, dy=5）→ INTERESTED ----
    const rId = picked[1].id;
    out.right = { topicId: rId, poolBefore: await poolOf(rId), scrollBefore: await scrollY() };
    await fire(rId, "touchstart", 60, 400);
    await fire(rId, "touchmove", 180, 403);
    await fire(rId, "touchend", 240, 405);
    await page.waitForTimeout(1200);
    out.right.poolAfter = await poolOf(rId);
    out.right.scrollAfter = await scrollY();

    // ---- 手势 3：左滑（dx=-180, dy=5）→ DISMISSED ----
    const lId = picked[2].id;
    out.left = { topicId: lId, poolBefore: await poolOf(lId), scrollBefore: await scrollY() };
    await fire(lId, "touchstart", 300, 500);
    await fire(lId, "touchmove", 180, 503);
    await fire(lId, "touchend", 120, 505);
    await page.waitForTimeout(1200);
    out.left.poolAfter = await poolOf(lId);
    out.left.scrollAfter = await scrollY();

    // ---- 手势 4：阈值以下（dx=40，未达 72px）→ 不应触发 ----
    const sId = await page.evaluate(() => {
      const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
        .filter((r) => r.offsetParent !== null);
      return rows[3]?.dataset.topicId ?? null;
    });
    if (sId) {
      out.belowThreshold = { topicId: sId };
      await fire(sId, "touchstart", 100, 600);
      await fire(sId, "touchmove", 130, 602);
      await fire(sId, "touchend", 140, 603);
      await page.waitForTimeout(1000);
      out.belowThreshold.poolAfter = await poolOf(sId);
    }

    // ---- 清理：按 id 删除本次测试创建的记录（含我上一轮遗留的 847468）----
    const cleanupIds = [vId, rId, lId, sId, "847468"].filter(Boolean);
    out.cleanup = await extEval(`(async () => {
      const ids = ${JSON.stringify(cleanupIds)};
      const dbName = await window.LDFCDB.getDatabaseName();
      const db = await new Promise((res, rej) => {
        const q = indexedDB.open(dbName);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      const existed = [];
      await new Promise((res, rej) => {
        const tx = db.transaction("topics", "readwrite");
        const st = tx.objectStore("topics");
        for (const id of ids) { if (window.LDFCTopicState.get(id)) existed.push(id); st.delete(id); }
        tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
      });
      db.close();
      await window.LDFCTopicState.load();
      await window.LDFCFilter.applyRows();
      return { deleted: existed, totalAfter: window.LDFCTopicState.records.size };
    })()`);
  } finally {
    await session.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
    await session.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await session.detach().catch(() => {});
  }

  out.verdict = {
    垂直滑动未误触发: out.vertical?.poolAfter === null ? "PASS" : "FAIL",
    右滑进入感兴趣: out.right?.poolAfter === "INTERESTED" ? "PASS" : "FAIL",
    左滑进入不感兴趣: out.left?.poolAfter === "DISMISSED" ? "PASS" : "FAIL",
    阈值以下不触发: out.belowThreshold ? (out.belowThreshold.poolAfter === null ? "PASS" : "FAIL") : "NOT TESTED",
    手势未改变滚动位置:
      out.vertical?.scrollBefore === out.vertical?.scrollAfter &&
      out.right?.scrollBefore === out.right?.scrollAfter &&
      out.left?.scrollBefore === out.left?.scrollAfter ? "PASS" : "FAIL"
  };

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("验证失败：", error.message);
  process.exit(1);
});
