"use strict";

// LDFC 真实新回复闭环验证（Topic 2899328）。
//
// 验证链路：
//   标记感兴趣 → 离开主信息流 → 发现 newReplyPending → 原池计数不减
//   → 数量正确 → 第一条未读预览对应第 58 楼 → 进入未读位置 → 跳到 58 楼
//   → 阅读至未读结束 → Discourse unread=0 → NEW_REPLY 立即消失
//   → 归属仍是 INTERESTED
//
// 关键：每一步都同时记录 **UI 层** 与 **状态层** 证据，
// 用来验证「NEW_REPLY 是临时层，不是第五个归属池」。
//
// 不修改正式代码，不修改产品规格，不制造新回复。
// 用法：node real-site-newreply-loop.js --port 9223

const fs = require("node:fs");
const path = require("node:path");

const TOPIC_ID = "2899328";

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

async function raw(page, browser, expression) {
  const context = browser.contexts()[0];
  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const target = seen.find((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!target) throw new Error("没有找到插件的隔离世界");
  const result = await session.send("Runtime.evaluate", {
    expression, contextId: target.id, awaitPromise: true, returnByValue: true
  });
  await session.detach().catch(() => {});
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || "插件世界执行失败");
  return result.result.value;
}

const ext = (page, browser, expression) =>
  raw(page, browser, `(async () => { const v = await (${expression}); return JSON.stringify(v === undefined ? "undefined" : v); })()`)
    .then((value) => (value === undefined ? undefined : JSON.parse(value)));

// 统一的"状态层 + UI 层"快照
const SNAPSHOT = (topicId) => `({
  state: (() => {
    const r = window.LDFCTopicState.get("${topicId}");
    return r ? {
      basePool: r.basePool, inNewReply: r.inNewReply, unreadPosts: r.unreadPosts,
      lastReadPostNumber: r.lastReadPostNumber, highestPostNumber: r.highestPostNumber,
      lastPostedAt: r.lastPostedAt, enteredPoolAt: r.enteredPoolAt,
      previewAuthor: r.previewAuthor, previewText: r.previewText, previewForRead: r.previewForRead
    } : null;
  })(),
  counts: {
    INTERESTED: window.LDFCTopicState.listByPool("INTERESTED").length,
    READ: window.LDFCTopicState.listByPool("READ").length,
    NEW_REPLY: window.LDFCTopicState.listNewReply().length,
    totalRecords: window.LDFCTopicState.records.size
  },
  nav: {
    INTERESTED: Number(document.querySelector('#ldfc-navigation button[data-pool="INTERESTED"] span')?.textContent ?? -1),
    NEW_REPLY: Number(document.querySelector('#ldfc-navigation button[data-pool="NEW_REPLY"] span')?.textContent ?? -1)
  },
  tracking: window.LDFCTrackingState.rowFor("${topicId}")
})`;

(async () => {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9223);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const base = new URL(page.url()).origin;

  const evidence = {};
  const steps = [];
  const record = (fields) => steps.push(fields);

  const goto = async (route, wait = 3500) => {
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(wait);
  };

  // ================================================================ 0. 测试前状态
  await goto("/latest", 4000);

  evidence.before = await ext(page, browser, SNAPSHOT(TOPIC_ID));

  // 原站在测试前的真实阅读状态（独立来源，不依赖扩展）
  evidence.beforeDiscourse = await page.evaluate(async (topicId) => {
    const payload = await fetch(`/t/${topicId}.json`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    return payload
      ? {
          last_read_post_number: payload.last_read_post_number ?? null,
          highest_post_number: payload.highest_post_number ?? null,
          streamLength: payload.post_stream?.stream?.length ?? null
        }
      : null;
  }, TOPIC_ID);

  // 记录第 58 楼与第 60 楼各自的内容，供后面比对预览
  evidence.posts = await page.evaluate(async (topicId) => {
    const payload = await fetch(`/t/${topicId}.json`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!payload) return null;
    const stream = payload.post_stream?.stream ?? [];
    const read = async (postNumber) => {
      const postId = stream[postNumber - 1];
      if (!postId) return null;
      const single = await fetch(`/t/${topicId}/posts.json?post_ids[]=${postId}`, { credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const post = single?.post_stream?.posts?.[0];
      return post
        ? { postNumber, username: post.username, text: (post.cooked || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 60) }
        : null;
    };
    return { post58: await read(58), post60: await read(60) };
  }, TOPIC_ID);

  record({
    阶段: "0. 测试前",
    测试前状态: `本地无该 Topic 记录：${evidence.before.state === null}；原站 last_read=${
      evidence.beforeDiscourse?.last_read_post_number
    } / highest=${evidence.beforeDiscourse?.highest_post_number}`,
    状态层: evidence.before.state,
    计数: evidence.before.counts,
    导航: evidence.before.nav,
    tracking: evidence.before.tracking,
    原站阅读状态: evidence.beforeDiscourse,
    第58楼: evidence.posts?.post58,
    第60楼: evidence.posts?.post60
  });

  // ================================================================ 1-2. 标记感兴趣
  // 优先走真实 UI：到 /unread 找到该 Topic 的行，点行内「感兴趣」按钮。
  await goto("/unread", 4000);
  const uiMark = await page.evaluate((topicId) => {
    const row = document.querySelector(`.topic-list-item[data-topic-id="${topicId}"]`);
    const button = row?.querySelector(".ldfc-action.interested");
    return { rowFound: !!row, buttonFound: !!button, rowHidden: row?.classList.contains("ldfc-row-hidden") ?? null };
  }, TOPIC_ID);
  evidence.uiMark = uiMark;

  let markMethod = "UI 点击（悬停后）";
  let markError = null;
  if (uiMark.buttonFound) {
    try {
      // 规格要求：桌面端默认不显示按钮，鼠标悬停 Topic 才显示。
      // 所以必须先 hover，点了才会真的可见。
      const row = page.locator(`.topic-list-item[data-topic-id="${TOPIC_ID}"]`);
      await row.hover();
      await page.waitForTimeout(400);
      await row.locator(".ldfc-action.interested").click({ timeout: 10000 });
    } catch (error) {
      markError = String(error.message).slice(0, 160);
      markMethod = "内部 API（UI 点击失败，见 evidence.markError）";
      await ext(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "${TOPIC_ID}" })`);
    }
  } else {
    markMethod = "内部 API（/unread 页面上找不到该行）";
    await ext(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "${TOPIC_ID}" })`);
  }
  evidence.markError = markError;
  evidence.markMethod = markMethod;
  await page.waitForTimeout(1500);
  evidence.afterMarkImmediate = await ext(page, browser, SNAPSHOT(TOPIC_ID));

  // 触发一次同步（回到列表页会让扩展在自然时机同步）
  await goto("/latest", 5000);
  await page.waitForTimeout(3000);
  evidence.afterDiscover = await ext(page, browser, SNAPSHOT(TOPIC_ID));

  record({
    阶段: "1-3. 标记感兴趣 → 发现 newReplyPending",
    测试前状态: "本地无记录，原站 last_read=57 / highest=60（未读 3）",
    操作步骤: `通过${markMethod}标记为感兴趣，然后回到 /latest 触发自然同步`,
    实际结果: {
      行内按钮: uiMark,
      标记后立刻: evidence.afterMarkImmediate.state,
      同步后发现: evidence.afterDiscover.state
    },
    预期结果: "basePool=INTERESTED，inNewReply 变为 true，unreadPosts=3",
    判定:
      evidence.afterDiscover.state?.basePool === "INTERESTED" &&
      evidence.afterDiscover.state?.inNewReply === true &&
      evidence.afterDiscover.state?.unreadPosts === 3
        ? "PASS" : "FAIL"
  });

  // ================================================================ 4-5. 计数
  const beforeCounts = evidence.before.counts;
  const afterCounts = evidence.afterDiscover.counts;
  record({
    阶段: "4-5. 原池计数不减 + 新回复计数 +1",
    测试前状态: `感兴趣=${beforeCounts.INTERESTED}，新回复=${beforeCounts.NEW_REPLY}`,
    操作步骤: "对比标记并发现新回复前后的计数",
    实际结果: {
      前: beforeCounts,
      后: afterCounts,
      导航前: evidence.before.nav,
      导航后: evidence.afterDiscover.nav
    },
    预期结果: "感兴趣计数不减少（Topic 仍属于感兴趣），新回复计数 +1",
    判定:
      afterCounts.INTERESTED === beforeCounts.INTERESTED + 1 &&
      afterCounts.NEW_REPLY === beforeCounts.NEW_REPLY + 1
        ? "PASS" : "FAIL"
  });

  // ================================================================ 6-7. 数量与时间
  record({
    阶段: "6-7. 新回复数量与最新回复时间",
    测试前状态: "已发现 newReplyPending",
    操作步骤: "读取记录里的 unreadPosts 与 lastPostedAt，并与原站 highest-last 交叉验证",
    实际结果: {
      unreadPosts: evidence.afterDiscover.state?.unreadPosts,
      lastPostedAt: evidence.afterDiscover.state?.lastPostedAt,
      原站: evidence.beforeDiscourse,
      推算未读: (evidence.beforeDiscourse?.highest_post_number ?? 0) - (evidence.beforeDiscourse?.last_read_post_number ?? 0)
    },
    预期结果: "数量 = 3，且与 60-57 一致",
    判定: evidence.afterDiscover.state?.unreadPosts === 3 ? "PASS" : "FAIL"
  });

  // ================================================================ 8. 预览必须是第 58 楼
  // 预览是懒加载的，打开新回复面板才会抓。
  await page.click('#ldfc-navigation button[data-pool="NEW_REPLY"]');
  await page.waitForTimeout(1500);

  let preview = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    preview = await page.evaluate(() => {
      const item = document.querySelector("#ldfc-panel .ldfc-panel-item");
      if (!item) return null;
      return {
        text: item.querySelector(".ldfc-panel-excerpt")?.textContent ?? null,
        count: item.querySelector(".ldfc-panel-count")?.textContent ?? null,
        meta: item.querySelector(".ldfc-panel-meta")?.textContent ?? null,
        link: item.querySelector("a")?.getAttribute("href") ?? null
      };
    });
    if (preview?.text) break;
    await page.waitForTimeout(1000);
  }
  const previewState = await ext(page, browser, SNAPSHOT(TOPIC_ID));
  evidence.preview = { ui: preview, state: previewState.state };

  const p58 = evidence.posts?.post58;
  const p60 = evidence.posts?.post60;
  const previewText = preview?.text ?? "";
  const matchesPost58 = p58 ? previewText.includes(p58.text.slice(0, 18)) : false;
  const matchesPost60 = p60 ? previewText.includes(p60.text.slice(0, 18)) : false;

  record({
    阶段: "8. 第一条未读回复预览 = 第 58 楼",
    测试前状态: "已发现 newReplyPending，打开「新回复」面板触发预览抓取",
    操作步骤: "读取面板上的预览文本，与第 58 楼 / 第 60 楼的真实内容比对",
    实际结果: {
      面板预览: preview?.text,
      面板数量: preview?.count,
      面板时间: preview?.meta,
      第58楼内容: p58,
      第60楼内容: p60,
      与58楼匹配: matchesPost58,
      与60楼匹配: matchesPost60,
      记录里的previewForRead: previewState.state?.previewForRead
    },
    预期结果: "预览对应第 58 楼（上次阅读 57 的下一楼），而不是最新的第 60 楼",
    判定: matchesPost58 && !matchesPost60 ? "PASS" : matchesPost58 ? "PARTIAL" : "FAIL"
  });

  // ================================================================ 9-10. 进入未读位置
  evidence.panelEntryLink = await page.evaluate(() => {
    const item = document.querySelector("#ldfc-panel .ldfc-panel-item");
    const buttons = [...(item?.querySelectorAll("button, a") ?? [])].map((el) => ({
      tag: el.tagName, text: el.textContent.trim().slice(0, 16), href: el.getAttribute("href")
    }));
    return buttons;
  });

  const entryButton = page.locator("#ldfc-panel .ldfc-panel-item").first().getByRole("button", { name: "进入未读位置" });
  const entryHref = await page.evaluate(() => {
    const item = document.querySelector("#ldfc-panel .ldfc-panel-item");
    return item?.querySelector("a")?.getAttribute("href") ?? null;
  });
  await entryButton.click();
  await page.waitForTimeout(4000);
  await page.waitForTimeout(1500);

  const landing = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[id^='post_']")];
    const visible = nodes.find((n) => {
      const r = n.getBoundingClientRect();
      return r.top >= -80 && r.bottom > 0;
    });
    return {
      url: location.href,
      firstVisiblePostNumber: visible ? visible.id.replace("post_", "") : null,
      renderedPosts: nodes.map((n) => n.id.replace("post_", "")).slice(0, 12),
      scrollY: Math.round(window.scrollY)
    };
  });

  record({
    阶段: "9-10. 进入未读位置（应落在第 58 楼）",
    测试前状态: "记录里 lastReadPostNumber=57",
    操作步骤: "点击「进入未读位置」，观察实际 URL 与落点楼层",
    实际结果: { 入口链接: entryHref, 面板上的控件: evidence.panelEntryLink, 落点: landing },
    预期结果: "URL 为 /t/topic/2899328/58，且第一个可见楼层为 58",
    判定: landing.firstVisiblePostNumber === "58" ? "PASS" : "PARTIAL"
  });

  // ================================================================ 11-12. 阅读至结束 + unread=0
  for (let step = 0; step < 5; step += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await page.waitForTimeout(1800);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(6000);

  // 回到列表页触发同步（Discourse 通过 timings 上报，需要时间）
  await goto("/latest", 5000);
  await page.waitForTimeout(3000);

  const afterReading = await ext(page, browser, SNAPSHOT(TOPIC_ID));
  const discourseAfter = await page.evaluate(async (topicId) => {
    const row = (await fetch("/unread.json", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null));
    const inUnread = (row?.topic_list?.topics ?? []).some((t) => String(t.id) === topicId);
    return { 仍在未读列表: inUnread };
  }, TOPIC_ID);

  // 完成确认需要一次自然同步，可能要多等一轮
  let finalState = afterReading;
  for (let attempt = 0; attempt < 4 && finalState.state?.inNewReply !== false; attempt += 1) {
    await goto("/latest", 5000);
    await page.waitForTimeout(4000);
    finalState = await ext(page, browser, SNAPSHOT(TOPIC_ID));
  }

  evidence.afterReading = { state: finalState.state, counts: finalState.counts, nav: finalState.nav };

  record({
    阶段: "11-13. 阅读至结束 → unread=0 → NEW_REPLY 消失",
    测试前状态: "已跳到第 58 楼，local 记录 inNewReply=true",
    操作步骤: "滚动读完剩余楼层 → 回到列表页触发自然同步 → 等待完成确认",
    实际结果: {
      读完后同步: afterReading.state,
      Discourse未读列表: discourseAfter,
      最终: finalState.state,
      最终计数: finalState.counts,
      最终导航: finalState.nav
    },
    预期结果: "inNewReply 变为 false；local 记录仍在（归属不变）",
    判定: finalState.state?.inNewReply === false ? "PASS" : "FAIL"
  });

  // ================================================================ 14-15. 归属与计数
  record({
    阶段: "14-15. 归属仍是 INTERESTED + 计数恢复",
    测试前状态: `测试前感兴趣=${beforeCounts.INTERESTED}`,
    操作步骤: "读取最终的 basePool 与计数",
    实际结果: {
      basePool: finalState.state?.basePool,
      inNewReply: finalState.state?.inNewReply,
      感兴趣计数: finalState.counts.INTERESTED,
      新回复计数: finalState.counts.NEW_REPLY,
      导航: finalState.nav
    },
    预期结果: "basePool 始终是 INTERESTED，新回复计数归零，感兴趣计数不因处理新回复而减少",
    判定:
      finalState.state?.basePool === "INTERESTED" && finalState.counts.NEW_REPLY === beforeCounts.NEW_REPLY
        ? "PASS" : "FAIL"
  });

  // ================================================================ 还原本地状态
  const restore = await ext(page, browser, `(async () => {
    const dbName = await window.LDFCDB.getDatabaseName();
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("topics", "readwrite");
      tx.objectStore("topics").delete("${TOPIC_ID}");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    await window.LDFCTopicState.load();
    await window.LDFCFilter.applyRows();
    return {
      remainingRecord: window.LDFCTopicState.get("${TOPIC_ID}") === undefined ? null : "still-exists",
      totalRecords: window.LDFCTopicState.records.size
    };
  })()`);

  record({
    阶段: "还原本地状态",
    测试前状态: `测试前该 Topic 无本地记录；本次测试新建了 1 条`,
    操作步骤: "按 id 从 IndexedDB 删除该记录，重新载入状态",
    实际结果: { 还原后: restore, 测试前总记录数: beforeCounts.totalRecords },
    预期结果: "该 Topic 回到无记录状态（即重新视为未处理），总记录数与测试前一致",
    判定: restore.remainingRecord === null && restore.totalRecords === beforeCounts.totalRecords ? "PASS" : "FAIL"
  });

  const out = {
    startedAt: new Date().toISOString(),
    topicId: TOPIC_ID,
    evidence,
    steps,
    summary: steps.map((s) => `${s.判定}  ${s.阶段}`)
  };

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("闭环验证异常：", error.message);
  process.exit(1);
});
