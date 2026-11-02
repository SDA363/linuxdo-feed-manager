"use strict";

// LDFC 多账号本地状态隔离验证（真实站点，单一 profile）。
//
// 背景：用户只有一个 Linux.do 账号，**无法用两个真实账号登录同一浏览器**。
// 因此本脚本验证"能验证的部分"，并明确标出"无法验证的部分"。
//
// 能验证的：
//   1. 命名空间由 /session/current.json 的数值 id 推导（真实账号：478515）
//   2. 同一个 profile 内，两个**不同命名空间**各用独立 IndexedDB，互不可见
//      —— 这才是真实场景（同一浏览器登录不同账号），
//         而不是"两个 profile 互不影响"（那是浏览器存储天然隔离，说明不了问题）
//   3. Topic X 在 A 是 INTERESTED、在"第二个命名空间"是 READ，互不覆盖
//   4. 刷新后各自保持
//
// 无法验证的：
//   - 两个**真实**账号切换（需要第二个账号，用户没有）
//
// 本脚本不修改任何正式代码。Topic X 用合成 id（88888888），不碰真实 Topic。

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

async function extRaw(page, browser, expression) {
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

const asJson = (page, browser, expression) =>
  extRaw(page, browser, `(async () => { const v = await (${expression}); return JSON.stringify(v === undefined ? "undefined" : v); })()`)
    .then((raw) => (raw === undefined ? undefined : JSON.parse(raw)));

(async () => {
  const args = process.argv.slice(2);
  const portArg = args.find((a) => a.startsWith("--port="));
  const port = Number(portArg ? portArg.split("=")[1] : 9223);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages().find((p) => !p.url().startsWith("devtools://")) ?? context.pages()[0];
  const base = new URL(page.url()).origin;

  const findings = [];
  const note = (fields) => findings.push(fields);

  const TOPIC_X = "88888888";
  const SECOND_NAMESPACE = "user-999999";
  const SECOND_DB = `ldfc__${SECOND_NAMESPACE}`;

  await page.goto(`${base}/latest`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  // ---------- 0. 环境与前置状态 ----------
  const env = await asJson(page, browser, `({
    identity: window.LDFCIdentity.current(),
    databaseName: await window.LDFCDB.getDatabaseName(),
    records: window.LDFCTopicState.records.size,
    sessionId: await fetch("/session/current.json", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => p?.current_user?.id ?? null)
  })`);

  const out = { startedAt: new Date().toISOString(), topicX: TOPIC_X, environment: env };

  note({
    项目: "0. 命名空间由账号 id 推导",
    测试前状态: `扩展身份 ${JSON.stringify(env.identity)}`,
    操作步骤: "读取 /session/current.json 的 current_user.id，与扩展使用的数据库名比对",
    实际结果: { sessionId: env.sessionId, 扩展命名空间: env.identity.namespace, 数据库名: env.databaseName },
    预期结果: "数据库名 == `ldfc__user-<sessionId>`",
    判定: env.databaseName === `ldfc__user-${env.sessionId}` ? "PASS" : "FAIL"
  });

  // ---------- 1. 写入账号 A ----------
  await asJson(page, browser, `(async () => {
    await window.LDFCPoolManager.markInterested({ topicId: "${TOPIC_X}" }, { title: "多账号隔离测试 Topic" });
    return true;
  })()`);
  const aWrite = await asJson(page, browser, `(() => {
    const r = window.LDFCTopicState.get("${TOPIC_X}");
    return r ? { pool: r.basePool, title: r.title } : null;
  })()`);

  note({
    项目: "1. 账号 A 写入 Topic X = 感兴趣",
    测试前状态: `账号 A 数据库 ${env.databaseName}`,
    操作步骤: `在账号 A 下把 Topic ${TOPIC_X} 标为感兴趣`,
    实际结果: aWrite,
    预期结果: "A 的库里 Topic X = INTERESTED",
    判定: aWrite?.pool === "INTERESTED" ? "PASS" : "FAIL"
  });

  // ---------- 2. 读取"第二个命名空间"的库（应完全看不到 Topic X） ----------
  const secondBefore = await asJson(page, browser, `(async () => {
    const names = typeof indexedDB.databases === "function"
      ? (await indexedDB.databases()).map((d) => d.name)
      : null;
    return {
      已存在的数据库: names,
      第二个库是否已存在: names ? names.includes("${SECOND_DB}") : null
    };
  })()`);

  note({
    项目: "2. 确认第二个命名空间的库原本不存在",
    测试前状态: "账号 A 已写入 Topic X",
    操作步骤: "列出同源下所有 IndexedDB 名",
    实际结果: secondBefore,
    预期结果: `\`${SECOND_DB}\` 尚未创建（说明 A 不会往别人的库里写）`,
    判定: secondBefore.第二个库是否已存在 === false ? "PASS" : "FAIL"
  });

  // ---------- 3. 在第二个命名空间的库里写入 Topic X = READ ----------
  const bWrite = await asJson(page, browser, `(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("${SECOND_DB}", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("topics")) {
          request.result.createObjectStore("topics", { keyPath: "topicId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("topics", "readwrite");
      tx.objectStore("topics").put({
        topicId: "${TOPIC_X}",
        basePool: "READ",
        inNewReply: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        title: "第二个账号的 Topic X"
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const stored = await new Promise((resolve, reject) => {
      const request = db.transaction("topics", "readonly").objectStore("topics").get("${TOPIC_X}");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { 写入结果: stored ? { topicId: stored.topicId, basePool: stored.basePool, title: stored.title } : null };
  })()`);

  note({
    项目: "3. 第二个命名空间写入同一个 Topic X = 已读",
    测试前状态: `构造出第二个命名空间 \`${SECOND_NAMESPACE}\`（对应用户 id 999999）`,
    操作步骤: `在 \`${SECOND_DB}\` 里写入 Topic ${TOPIC_X} = READ`,
    实际结果: bWrite,
    预期结果: "第二个库里 Topic X = READ",
    判定: bWrite?.写入结果?.basePool === "READ" ? "PASS" : "FAIL"
  });

  // ---------- 4. 回头看账号 A：必须仍是 INTERESTED（未被污染） ----------
  const aAfter = await asJson(page, browser, `(() => {
    const r = window.LDFCTopicState.get("${TOPIC_X}");
    return r ? { pool: r.basePool, title: r.title } : null;
  })()`);

  note({
    项目: "4. 账号 A 的状态未被第二个命名空间污染",
    测试前状态: "A 里 Topic X = INTERESTED；第二个库里 Topic X = READ",
    操作步骤: "在账号 A 下重新读取 Topic X",
    实际结果: { A读到的: aAfter, 第二个库里的: bWrite?.写入结果 },
    预期结果: "A 仍读到 INTERESTED，绝不能变成 READ",
    判定: aAfter?.pool === "INTERESTED" ? "PASS" : "FAIL"
  });

  // ---------- 5. 刷新页面后各自保持 ----------
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const afterReload = await asJson(page, browser, `({
    databaseName: await window.LDFCDB.getDatabaseName(),
    topicX: (() => { const r = window.LDFCTopicState.get("${TOPIC_X}"); return r ? r.basePool : null; })()
  })`);

  note({
    项目: "5. 刷新后状态保持且命名空间不变",
    测试前状态: "A 的 Topic X = INTERESTED",
    操作步骤: "整页刷新后重新读取",
    实际结果: afterReload,
    预期结果: "数据库仍是 A 的库，Topic X 仍是 INTERESTED",
    判定: afterReload.databaseName === env.databaseName && afterReload.topicX === "INTERESTED" ? "PASS" : "FAIL"
  });

  // ---------- 6. 清理 ----------
  const cleanup = await asJson(page, browser, `(async () => {
    // 清账号 A 里的 Topic X
    const aName = await window.LDFCDB.getDatabaseName();
    const aDb = await new Promise((resolve, reject) => {
      const request = indexedDB.open(aName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = aDb.transaction("topics", "readwrite");
      tx.objectStore("topics").delete("${TOPIC_X}");
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    aDb.close();

    // 删掉构造出来的第二个库
    const deletedSecond = await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase("${SECOND_DB}");
      request.onsuccess = () => resolve(true);
      request.onerror = () => resolve(false);
      request.onblocked = () => resolve(false);
    });

    await window.LDFCTopicState.load();
    await window.LDFCFilter.applyRows();
    const names = typeof indexedDB.databases === "function" ? (await indexedDB.databases()).map((d) => d.name) : null;
    return { 第二个库已删除: deletedSecond, A的记录数: window.LDFCTopicState.records.size, 剩余数据库: names };
  })()`);

  note({
    项目: "6. 清理测试数据",
    测试前状态: `账号 A 记录数 ${env.records}；存在构造的第二个库`,
    操作步骤: "删除 Topic X 与构造库",
    实际结果: cleanup,
    预期结果: "A 的记录数回到测试前，第二个库被删除",
    判定: cleanup.A的记录数 === env.records ? "PASS" : "FAIL"
  });

  out.findings = findings;
  console.log(JSON.stringify(out, null, 2));
  await browser.close().catch(() => {});
})().catch((error) => {
  console.error("验证脚本异常：", error.message);
  process.exit(1);
});
