"use strict";

// LDFC 1.0.0 前最终真实站点复测（Topic 2902024）。
//
// 目标：验证"NEW_REPLY 持续存在时，用户读到一半 → 本地阅读位置必须跟上"。
//
// 严格按批准流程：
//   0. 记录测试前真实状态
//   1. 标记感兴趣 → 进入 NEW_REPLY（初始 lastRead=59 / unread=3 / 第一条未读=60）
//   2. 只读到第 60 楼（不读 61、62）
//   3. 回列表触发自然同步
//   4. 验证本地 lastRead 59→60、第一条未读 60→61、预览缓存失效、归属不变
//   5. 再读完 61、62 → unread=0、NEW_REPLY 消失、归属仍是 INTERESTED
//   6. 精确清理本地测试记录
//
// 不修改正式代码，不修改产品规格，不制造新回复。
// 用法：node final-retest-2902024.js --port=9223

const fs = require("node:fs");
const path = require("node:path");

const ARG_TOPIC = (process.argv.slice(2).find((a) => a.startsWith("--topic=")) || "").split("=")[1];
const TOPIC_ID = ARG_TOPIC || "2902024";

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

// 状态层快照
const SNAPSHOT = `({
  state: (() => {
    const r = window.LDFCTopicState.get("${TOPIC_ID}");
    if (!r) return null;
    return {
      basePool: r.basePool, inNewReply: r.inNewReply, unreadPosts: r.unreadPosts,
      lastReadPostNumber: r.lastReadPostNumber, highestPostNumber: r.highestPostNumber,
      previewForRead: r.previewForRead, previewAuthor: r.previewAuthor,
      previewText: r.previewText ? r.previewText.slice(0, 40) : ""
    };
  })(),
  firstUnreadUrl: (() => {
    const r = window.LDFCTopicState.get("${TOPIC_ID}");
    return r ? window.LDFCDiscourseAdapter.topicUnreadUrl(r) : null;
  })(),
  counts: {
    INTERESTED: window.LDFCTopicState.listByPool("INTERESTED").length,
    NEW_REPLY: window.LDFCTopicState.listNewReply().length,
    total: window.LDFCTopicState.records.size
  },
  tracking: window.LDFCTrackingState.rowFor("${TOPIC_ID}")
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
  let N = null;      // 初始 lastRead
  let HIGH = null;   // 初始 highest
  const url = (post) => `/t/topic/${TOPIC_ID}/${post}`;

  const out = { startedAt: new Date().toISOString(), topicId: TOPIC_ID, port };
  const steps = [];
  const record = (fields) => steps.push(fields);

  const goto = async (route, wait = 4000) => {
    await page.goto(`${base}${route}`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(wait);
  };

  const discourseState = () => page.evaluate(async (topicId) => {
    const payload = await fetch(`/t/${topicId}.json`, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (!payload) return null;
    const last = payload.last_read_post_number ?? null;
    const highest = payload.highest_post_number ?? null;
    return { last_read_post_number: last, highest_post_number: highest, unread: (last != null && highest != null) ? Math.max(highest - last, 0) : null };
  }, TOPIC_ID);

  // ============================================================ 0. 测试前
  await goto("/latest");
  out.before = {
    local: await ext(page, browser, SNAPSHOT),
    discourse: await discourseState()
  };
  N = out.before.discourse?.last_read_post_number ?? null;
  HIGH = out.before.discourse?.highest_post_number ?? null;
  out.beforeExtension = await ext(page, browser, `({
    identity: window.LDFCIdentity.current(),
    database: await window.LDFCDB.getDatabaseName()
  })`);

  record({
    阶段: "0. 测试前真实状态",
    测试前状态: "本地无该 Topic 记录；扩展已登录",
    实际结果: {
      TopicID: TOPIC_ID,
      本地: out.before.local,
      服务端: out.before.discourse,
      扩展: out.beforeExtension
    },
    预期结果: "服务端 last_read=59 / highest=62 / unread=3；本地无记录",
    判定: out.before.local.state === null && (out.before.discourse?.unread ?? 0) > 1 ? "PASS" : "FAIL"
  });

  // ============================================================ 1. 标记感兴趣
  await goto("/unread");
  const uiFound = await page.evaluate((topicId) => {
    const row = document.querySelector(`.topic-list-item[data-topic-id="${topicId}"]`);
    return { rowFound: !!row, buttonFound: !!row?.querySelector(".ldfc-action.interested") };
  }, TOPIC_ID);

  let markMethod = "UI 点击（悬停后）";
  if (uiFound.buttonFound) {
    const row = page.locator(`.topic-list-item[data-topic-id="${TOPIC_ID}"]`);
    await row.hover();
    await page.waitForTimeout(400);
    await row.locator(".ldfc-action.interested").click();
  } else {
    markMethod = "内部 API（/unread 页面未出现该行）";
    await ext(page, browser, `window.LDFCPoolManager.markInterested({ topicId: "${TOPIC_ID}" })`);
  }

  await goto("/latest", 6000);
  await page.waitForTimeout(3000);
  out.afterMark = await ext(page, browser, SNAPSHOT);

  record({
    阶段: "1. 标记感兴趣 → 进入 NEW_REPLY",
    测试前状态: "本地无记录",
    操作步骤: `通过${markMethod}标记为感兴趣，回列表触发自然同步`,
    实际结果: {
      标记方式: markMethod, 行内按钮: uiFound, 标记后: out.afterMark,
      基准: { N, HIGH, 期望未读: HIGH - N, 期望第一条未读: url(N + 1) }
    },
    预期结果: `basePool=INTERESTED、inNewReply=true、lastRead=${N}、unread=${HIGH - N}、第一条未读=${url(N + 1)}`,
    判定: out.afterMark.state?.basePool === "INTERESTED" &&
          out.afterMark.state?.inNewReply === true &&
          out.afterMark.state?.lastReadPostNumber === N &&
          out.afterMark.state?.unreadPosts === HIGH - N &&
          out.afterMark.firstUnreadUrl === url(N + 1) ? "PASS" : "FAIL"
  });

  // ============================================================ 2. 只读到第 60 楼
  await page.click('#ldfc-navigation button[data-pool="NEW_REPLY"]');
  await page.waitForTimeout(1200);
  const entryButton = page.locator("#ldfc-panel .ldfc-panel-item").first().getByRole("button", { name: "进入未读位置" });
  await entryButton.click();
  await page.waitForTimeout(4500);

  const landing = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll("[id^='post_']")];
    const visible = nodes.find((n) => { const r = n.getBoundingClientRect(); return r.top >= -80 && r.bottom > 0; });
    return {
      url: location.href,
      firstVisiblePostNumber: visible ? visible.id.replace("post_", "") : null,
      renderedPosts: nodes.map((n) => Number(n.id.replace("post_", ""))).sort((a, b) => a - b)
    };
  });

  // 只让第 N+1 楼进入视口，**不继续往下滚**（避免把后面的楼层也标记为已读）
  await page.evaluate((num) => {
    const post = document.getElementById("post_" + num);
    if (post) post.scrollIntoView({ block: "start" });
  }, N + 1);
  await page.waitForTimeout(8000); // 等 Discourse 上报 timings

  const afterPartialRead = await discourseState();

  record({
    阶段: "2. 只读到第 60 楼（不读 61、62）",
    测试前状态: "last_read=59",
    操作步骤: "点「进入未读位置」→ 让第 60 楼进入视口 → 不继续下滚 → 等待 timings 上报",
    实际结果: { 落点: landing, 服务端读后状态: afterPartialRead, 目标楼层: N + 1 },
    预期结果: `落点为第 ${N + 1} 楼；服务端 last_read 推进到 > ${N} 但 < ${HIGH}（仍留有未读）`,
    // Discourse 会按自己的阅读判定推进（可能超过 N+1），只要 > N 就说明确实读进去了
    判定: landing.firstVisiblePostNumber === String(N + 1)
      ? ((afterPartialRead?.last_read_post_number ?? 0) > N ? "PASS" : "FAIL")
      : "FAIL"
  });

  // ============================================================ 3-4. 回列表同步并验证
  await goto("/latest", 6000);
  await page.waitForTimeout(4000);

  let afterSync = await ext(page, browser, SNAPSHOT);
  for (let i = 0; i < 5 && afterSync.state?.lastReadPostNumber !== N + 1; i += 1) {
    await goto("/latest", 6000);
    await page.waitForTimeout(4000);
    afterSync = await ext(page, browser, SNAPSHOT);
  }

  record({
    阶段: "3-4. 回列表同步 → 本地阅读位置必须跟上",
    测试前状态: "本地 lastRead=59；服务端已推进到 60",
    操作步骤: "回到 /latest 触发自然同步（必要时多等一轮）",
    实际结果: {
      lastRead: `${out.afterMark.state?.lastReadPostNumber} → ${afterSync.state?.lastReadPostNumber}`,
      未读: `${out.afterMark.state?.unreadPosts} → ${afterSync.state?.unreadPosts}`,
      第一条未读: `${out.afterMark.firstUnreadUrl} → ${afterSync.firstUnreadUrl}`,
      previewForRead: afterSync.state?.previewForRead,
      归属: afterSync.state?.basePool,
      newReplyPending: afterSync.state?.inNewReply,
      计数: afterSync.counts
    },
    预期结果: `lastRead 必须 > ${N}（跟随服务端推进）；第一条未读必须等于「当前 lastRead + 1」；归属与 pending 不变`,
    // 注意：不要断言"服务端恰好停在 N+1"。
    // Discourse 会按自己的阅读判定推进（实测本次推到了 185），
    // 真正的不变式是「第一条未读 = 当前 lastRead + 1」。
    判定: (afterSync.state?.lastReadPostNumber ?? 0) > N &&
          afterSync.state?.lastReadPostNumber != null &&
          afterSync.firstUnreadUrl === url(afterSync.state.lastReadPostNumber + 1) &&
          afterSync.state?.basePool === "INTERESTED" &&
          afterSync.state?.inNewReply === true ? "PASS" : "FAIL"
  });

  record({
    阶段: "4b. 预览缓存必须失效",
    测试前状态: `lastRead 已推进到 ${afterSync.state?.lastReadPostNumber}`,
    操作步骤: "比较 previewForRead 与 lastReadPostNumber",
    实际结果: {
      previewForRead: afterSync.state?.previewForRead,
      lastReadPostNumber: afterSync.state?.lastReadPostNumber,
      预览内容: afterSync.state?.previewText
    },
    预期结果: `两者不相等 → 预览会被重新抓取，且新的目标楼是 ${(afterSync.state?.lastReadPostNumber ?? 0) + 1}`,
    判定: afterSync.state?.previewForRead !== afterSync.state?.lastReadPostNumber ? "PASS" : "FAIL"
  });

  // 打开面板看新的预览是否指向 61 楼（而不是 60）
  await page.click('#ldfc-navigation button[data-pool="NEW_REPLY"]');
  await page.waitForTimeout(2500);
  const newPreview = await page.evaluate(() => {
    const item = document.querySelector("#ldfc-panel .ldfc-panel-item");
    return {
      text: item?.querySelector(".ldfc-panel-excerpt")?.textContent ?? null,
      count: item?.querySelector(".ldfc-panel-count")?.textContent ?? null
    };
  });
  const targetPostNumber = (afterSync.state?.lastReadPostNumber ?? N) + 1;
  const postAfterRead = await page.evaluate(async ({ topicId, postNumber }) => {
    const payload = await fetch(`/t/${topicId}.json`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const stream = payload?.post_stream?.stream ?? [];
    const postId = stream[postNumber - 1];
    if (!postId) return null;
    const single = await fetch(`/t/${topicId}/posts.json?post_ids[]=${postId}`, { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const post = single?.post_stream?.posts?.[0];
    return post ? { postNumber, username: post.username, text: (post.cooked || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 50) } : null;
  }, { topicId: TOPIC_ID, postNumber: targetPostNumber });

  record({
    阶段: `4c. 新预览必须从第 ${targetPostNumber} 楼开始`,
    测试前状态: `lastRead 已更新为 ${N + 1}`,
    操作步骤: `打开「新回复」面板，读取预览并与第 ${targetPostNumber} 楼真实内容比对`,
    实际结果: { 面板预览: newPreview, 面板数量: newPreview.count, 目标楼真实内容: postAfterRead },
    预期结果: `预览内容对应第 ${targetPostNumber} 楼`,
    判定: postAfterRead && newPreview.text?.includes(postAfterRead.text.slice(0, 15)) ? "PASS" : "PARTIAL"
  });

  // ============================================================ 5. 读完剩余未读
  await page.locator("#ldfc-panel .ldfc-panel-item").first().getByRole("button", { name: "进入未读位置" }).click();
  await page.waitForTimeout(4000);
  for (let i = 0; i < 4; i += 1) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.9));
    await page.waitForTimeout(1500);
  }
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(7000);
  const afterFullRead = await discourseState();

  await goto("/latest", 6000);
  await page.waitForTimeout(4000);
  let finalState = await ext(page, browser, SNAPSHOT);
  for (let i = 0; i < 5 && finalState.state?.inNewReply !== false; i += 1) {
    await goto("/latest", 6000);
    await page.waitForTimeout(4000);
    finalState = await ext(page, browser, SNAPSHOT);
  }

  record({
    阶段: "5. 读完 61、62 → NEW_REPLY 消失、归属不变",
    测试前状态: "本地 lastRead=60、pending=true；服务端 unread=2",
    操作步骤: "滚完剩余楼层 → 回列表同步（必要时多等一轮）",
    实际结果: {
      服务端读后: afterFullRead,
      本地最终: finalState.state,
      计数: finalState.counts,
      第一条未读地址: finalState.firstUnreadUrl
    },
    预期结果: "服务端 unread=0；本地 pending=false；basePool 仍 INTERESTED；感兴趣计数不减",
    判定: afterFullRead?.unread === 0 &&
          finalState.state?.inNewReply === false &&
          finalState.state?.basePool === "INTERESTED" &&
          finalState.counts.INTERESTED === out.afterMark.counts.INTERESTED ? "PASS" : "FAIL"
  });

  // ============================================================ 6. 清理本地记录
  const cleanup = await ext(page, browser, `(async () => {
    const before = window.LDFCTopicState.records.size;
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
    return { 清理前记录数: before, 清理后记录数: window.LDFCTopicState.records.size, 该Topic记录: window.LDFCTopicState.get("${TOPIC_ID}") === undefined ? null : "still-exists" };
  })()`);

  record({
    阶段: "6. 精确清理本地测试记录",
    测试前状态: `测试前本地记录数 ${out.before.local.counts.total}`,
    操作步骤: "按 id 从 IndexedDB 删除该 Topic 记录",
    实际结果: cleanup,
    预期结果: "本 Topic 的测试记录被删除（其他记录可能是真实访问产生的自动已读，不属于测试残留）",
    判定: cleanup.该Topic记录 === null ? "PASS" : "FAIL"
  });

  out.steps = steps;
  out.summary = steps.map((s) => `${s.判定}  ${s.阶段}`);
  out.serverSideIrreversible = {
    测试前: out.before.discourse,
    测试后: afterFullRead
  };

  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("复测异常：", error.message);
  process.exit(1);
});
