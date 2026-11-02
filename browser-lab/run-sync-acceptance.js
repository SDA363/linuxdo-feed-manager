"use strict";

// WebDAV 同步端到端验收（组 4）。
//
// 链路：
//   真实 content script（扩展隔离世界，IndexedDB）
//     → chrome.runtime.sendMessage
//     → background service worker（拥有 host 权限）
//     → 真实 HTTP → mock WebDAV（故意不发 CORS 头）
//
// 设备 B 用页面内独立的 storage 模拟（同一个 namespace），
// 目的是验证"另一台设备拉取 / 合并 / 再写回"的真实 HTTP 往返，
// 而不是再起第二份浏览器 profile。
//
// 前提：
//   node prepare-probe-ext.js && node probe-server.js
//   node browser.js start --ext ".../.probe-ext" --url "http://127.0.0.1:8123/"
// 用法：
//   node run-sync-acceptance.js

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const vm = require("node:vm");
const { startMockWebDAV } = require("./mock-webdav");

const DEFAULT_URL = "http://127.0.0.1:8123/";
// UI 里填目录，扩展会自动拼 ld <账号>.json。
const WEBDAV_BASE = "http://127.0.0.1:8124/dav/";
const WEBDAV_FILE = `${WEBDAV_BASE}ldfc-user-42.json`;
const WEBDAV_USER = "tester";
const WEBDAV_PASSWORD = "secret";

const results = [];
const record = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

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

async function extensionWorld(page, browser) {
  const context = browser.contexts()[0];
  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const target = seen.find((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!target) throw new Error("没有找到插件的隔离世界");
  return { session, contextId: target.id };
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

// 落盘文件现在是 schema 4 的 gzip 二进制，断言前要用插件自己的
// parseRemoteFile 归一化，保证验收与真实读路径完全一致。
const MODEL_FILE = path.resolve(__dirname, "..", "linuxdo-personal-feed-manager", "storage", "syncModel.js");
const modelSandbox = {
  window: {},
  console,
  btoa,
  atob,
  Blob,
  Response,
  TextEncoder,
  TextDecoder,
  CompressionStream,
  DecompressionStream
};
vm.createContext(modelSandbox);
vm.runInContext(fs.readFileSync(MODEL_FILE, "utf8"), modelSandbox, { filename: MODEL_FILE });
const syncModel = modelSandbox.window.LDFCSyncModel;

async function readRemoteDoc(mock) {
  const bytes = mock.state.bytes();
  if (!bytes || !bytes.length) return null;
  try {
    return await syncModel.parseRemoteFile(bytes);
  } catch {
    return null;
  }
}

async function waitForMock(mock, predicate, timeout = 18000) {
  const deadline = Date.now() + timeout;
  let doc = null;
  while (Date.now() < deadline) {
    doc = await readRemoteDoc(mock);
    if (doc && predicate(doc)) return doc;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return doc;
}

async function clickAction(page, topicId, actionClass) {
  const row = page.locator(`[data-topic-id="${topicId}"]`).first();
  await row.hover();
  const button = row.locator(`.ldfc-actions button.${actionClass}`);
  try {
    await button.click({ timeout: 3000 });
  } catch {
    // 按钮可能因为原站 hover 样式未生效而不可见，直接触发点击事件。
    await button.evaluate((element) => element.click());
  }
}

// 当前 CDP 会话里 page.click 的合成鼠标事件没有落到页面上（fill 正常），
// 但元素自身的 click() 能触发真实监听器。不把环境问题混进产品断言，
// 这里统一用 DOM click；真实指针路径由 76 项验收覆盖。
async function jsClick(page, selector) {
  await page.$eval(selector, (element) => element.click());
}

function report() {
  const failed = results.filter((line) => line.startsWith("FAIL"));
  console.log("\n===== WebDAV 同步验收结果 =====");
  for (const line of results) console.log(line);
  console.log(`\n汇总：${results.filter((line) => line.startsWith("PASS")).length} 项通过，${failed.length} 项失败`);
  return failed.length;
}

async function main() {
  const mock = await startMockWebDAV({
    port: 8124,
    username: WEBDAV_USER,
    password: WEBDAV_PASSWORD
  });

  let browser;
  try {
    const { chromium } = loadPlaywright();
    browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    const context = browser.contexts()[0];
    const page = context.pages()[0];
    if (!page) throw new Error("浏览器里没有页面，先用 browser.js start 打开页面");

    page.on("pageerror", (error) => console.log(`[pageerror] ${error.message}`));

    console.log("[1/12] 固定账号并清空本地状态");
    await page.goto(new URL("__set?user=42&login=1&unread=0", DEFAULT_URL).href, {
      waitUntil: "domcontentloaded"
    });
    await page.goto(DEFAULT_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });

    const setup = await extEval(
      page,
      browser,
      `(async () => {
        await window.LDFCDB.clearTopics();
        await window.LDFCDB.clearTombstones();
        await window.LDFCTopicState.clearVisits();
        await window.LDFCDB.putMeta("initialized", true);
        await window.LDFCDB.putMeta("onboardingPrompted", true);
        await window.LDFCTopicState.load();

        await window.LDFCSyncService.init();

        return {
          deviceId: await window.LDFCSyncService.getDeviceId(),
          autoSync: window.LDFCSyncService.getConfig().autoSync
        };
      })()`
    );
    record(Boolean(setup.deviceId), `同步服务已初始化（deviceId=${setup.deviceId}）`);
    record(setup.autoSync === true, "自动同步默认开启");

    // settings.js 在页面加载时缓存了 initialized 状态；写完 meta 必须重载，
    // 否则打开设置仍会停在首次安装向导。
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });

    console.log("[2/12] 通过设置面板保存 WebDAV 配置");
    await jsClick(page, "#ldfc-settings-launch");
    await page.waitForSelector("#ldfc-sync-url", { timeout: 8000 });
    await page.fill("#ldfc-sync-url", WEBDAV_BASE);
    await page.fill("#ldfc-sync-username", WEBDAV_USER);
    await page.fill("#ldfc-sync-password", WEBDAV_PASSWORD);
    await jsClick(page, "#ldfc-sync-save");
    await page.waitForTimeout(400);

    const saved = await extEval(
      page,
      browser,
      `(() => {
        const config = window.LDFCSyncService.getConfig();
        return {
          backend: config.backend,
          url: config.webdav?.url,
          username: config.webdav?.username,
          hasPassword: Boolean(config.webdav?.password)
        };
      })()`
    );
    record(
      saved.backend === "webdav" &&
        saved.url === WEBDAV_BASE &&
        saved.username === WEBDAV_USER &&
        saved.hasPassword === true,
      `设置面板保存配置成功（${JSON.stringify(saved)}）`
    );

    const statusText = await page.textContent("#ldfc-sync-status");
    record(/已配置|空闲|已同步/.test(statusText || ""), `同步状态可见（${statusText}）`);

    const fileLabel = ((await page.textContent("#ldfc-sync-file")) || "").trim();
    record(
      fileLabel.includes("ldfc-user-42.json"),
      `面板显示实际同步文件名（${fileLabel}）`
    );

    // 用户最容易踩的坑：把坚果云的网页/分享链接当成 WebDAV 地址。
    // # 后面的部分浏览器不会发给服务器，最终只会在同步时报"不是合法 JSON"。
    await page.fill("#ldfc-sync-url", "https://www.jianguoyun.com/#/sandbox/1/2/%2F/");
    await jsClick(page, "#ldfc-sync-save");
    await page.waitForTimeout(300);
    const badToast = ((await page.textContent("#ldfc-toast-container")) || "").trim();
    record(
      /dav\.jianguoyun\.com/.test(badToast),
      `网页链接被拦下并提示正确地址（${badToast}）`
    );

    await page.fill("#ldfc-sync-url", WEBDAV_BASE);
    await jsClick(page, "#ldfc-sync-save");
    await page.waitForTimeout(300);

    await page.waitForFunction(
      () => document.querySelector("#ldfc-sync-permission")?.textContent.includes("已授权"),
      null,
      { timeout: 5000 }
    );
    record(true, "设置面板显示域名已授权");

    console.log("[3/12] 测试连接");
    await jsClick(page, "#ldfc-sync-test");
    await page.waitForFunction(
      () => document.querySelector("#ldfc-toast-container")?.textContent.includes("连接成功"),
      null,
      { timeout: 8000 }
    );
    record(true, "「测试连接」返回成功");

    console.log("[4/12] 后台可打开独立授权页");
    const [permissionPage] = await Promise.all([
      context.waitForEvent("page", { timeout: 8000 }),
      jsClick(page, "#ldfc-sync-authorize")
    ]);
    await permissionPage
      .waitForURL((url) => url.href.includes("permissions.html"), { timeout: 8000 })
      .catch(() => {});
    await permissionPage.waitForLoadState("domcontentloaded").catch(() => {});
    const permissionUrl = decodeURIComponent(permissionPage.url());
    record(
      permissionUrl.includes("permissions.html") && permissionUrl.includes("http://127.0.0.1/*"),
      `授权页地址正确（${permissionPage.url()}）`
    );
    await permissionPage.close();

    await jsClick(page, "#ldfc-settings .ldfc-settings-close");
    await page.waitForTimeout(200);

    console.log("[5/12] 探测 content script 直连是否会被 CORS 拦截");
    const direct = await page.evaluate(async (url) => {
      try {
        await fetch(url);
        return "ok";
      } catch {
        return "blocked";
      }
    }, WEBDAV_BASE);
    record(direct === "blocked", `content script 直连被 CORS 拦截（实际：${direct}）`);

    console.log("[6/12] 设备 A：通过真实 UI 标记感兴趣");
    await clickAction(page, "101", "interested");

    const aRecord = await extEval(
      page,
      browser,
      `(() => {
        const record = window.LDFCTopicState.get("101");
        return record
          ? { basePool: record.basePool, title: record.title, deviceId: record.deviceId }
          : null;
      })()`
    );
    record(aRecord?.basePool === "INTERESTED", `A 本地已标记（${JSON.stringify(aRecord)}）`);
    record(
      aRecord?.deviceId === setup.deviceId,
      `记录写入当前 deviceId（记录=${aRecord?.deviceId}）`
    );

    console.log("[7/12] 等待标记后的 debounce 推送（最多 18s）");
    // schema 3 是 gzip + base64 封装，先解回 schema 2 的语义文档；
    // schema 2 用短键 + 设备字典 + 单字母池代号（h/s/r/x），断言层还原成池名。
    // 这样换编码方式时不用把断言全部重写。
    const POOL_ALIASES = { h: "HOME", s: "INTERESTED", r: "READ", x: "DISMISSED" };
    const unwrapEnvelope = (doc) => {
      if (!doc || Number(doc.schema) !== 3) return doc;
      if (doc.encoding !== "gzip+base64" || typeof doc.payload !== "string") {
        throw new Error(`无法识别远端编码：${doc.encoding}`);
      }
      return JSON.parse(zlib.gunzipSync(Buffer.from(doc.payload, "base64")).toString("utf8"));
    };
    const decodeDoc = (doc) => {
      const plain = unwrapEnvelope(doc);
      return {
        ...plain,
        topics: (plain?.topics ?? []).map((row) => ({
          topicId: String(row.i ?? row.topicId ?? ""),
          basePool: POOL_ALIASES[row.p] ?? row.p ?? row.basePool,
          title: row.t ?? row.title,
          deviceId:
            row.d === undefined ? (plain.devices?.[0] ?? "") : (plain.devices?.[Number(row.d)] ?? "")
        }))
      };
    };
    const pushedRaw = await waitForMock(mock, (doc) => decodeDoc(doc).topics.some((item) => item.topicId === "101"));
    const pushedDoc = decodeDoc(pushedRaw);
    record(Boolean(pushedDoc), "10s 防抖后自动推送到 WebDAV");
    const pushedBytes = mock.state.bytes();
    record(
      pushedBytes?.[0] === 0x1f && pushedBytes?.[1] === 0x8b && pushedRaw?.schema === 2,
      `落盘是 gzip 二进制、解压后是 schema 2 语义文档（magic=${pushedBytes?.[0]?.toString(16)}，schema=${pushedRaw?.schema}）`
    );
    record(pushedDoc?.namespace === "user-42", `远端文档 namespace=user-42（实际 ${pushedDoc?.namespace}）`);

    const pushedTopic = pushedDoc?.topics?.find((item) => item.topicId === "101");
    record(pushedTopic?.basePool === "INTERESTED", `远端记录归属 INTERESTED（实际 ${pushedTopic?.basePool}）`);
    record(Boolean(pushedTopic?.title), `远端记录带标题（实际 ${pushedTopic?.title}）`);

    const puts = mock.state.requests.filter((request) => request.method === "PUT");
    record(puts[0]?.ifNoneMatch === "*", "首次创建使用 If-None-Match: *");
    record(
      mock.state.requests.some((request) => request.method === "GET"),
      "后台确实发起了真实 HTTP GET"
    );

    console.log("[8/12] 模拟设备 B：独立 storage 拉取并合并");
    const bSetup = await extEval(
      page,
      browser,
      `(async () => {
        const topics = new Map();
        const tombstones = new Map();
        const meta = new Map();

        window.__ldfcB = {
          topics: topics,
          tombstones: tombstones,
          meta: meta,
          async getAllTopics() { return Array.from(topics.values()); },
          async getTombstones() { return Array.from(tombstones.values()); },
          async putTopic(record) { topics.set(String(record.topicId), record); },
          async deleteTopic(topicId) { topics.delete(String(topicId)); },
          async putTombstone(item) { tombstones.set(String(item.topicId), item); },
          async deleteTombstone(topicId) { tombstones.delete(String(topicId)); },
          async getMeta(key) { return meta.has(key) ? meta.get(key) : null; },
          async putMeta(key, value) { meta.set(key, value); }
        };

        window.__ldfcBService = window.LDFCSyncService.createSyncService({
          storage: window.__ldfcB,
          model: window.LDFCSyncModel,
          getNamespace: async () => "user-42",
          randomId: () => "device-b",
          transport: window.LDFCWebDAV.createTransport({
            url: "${WEBDAV_FILE}",
            username: "${WEBDAV_USER}",
            password: "${WEBDAV_PASSWORD}"
          })
        });

        const pull = await window.__ldfcBService.pull();
        return {
          pull: pull,
          deviceId: await window.__ldfcBService.getDeviceId(),
          records: Array.from(topics.values()).map((item) => ({
            topicId: item.topicId,
            basePool: item.basePool,
            title: item.title
          }))
        };
      })()`
    );
    record(bSetup.pull?.ok === true, "B 设备 pull 成功");
    record(bSetup.deviceId === "device-b", `B 设备有自己的 deviceId（${bSetup.deviceId}）`);
    const bTopic = bSetup.records.find((item) => item.topicId === "101");
    record(bTopic?.basePool === "INTERESTED", `B 设备合并到 A 的归属（${JSON.stringify(bTopic)}）`);

    console.log("[9/12] B 设备修改后写回，A 设备拉取合并");
    const bWrite = await extEval(
      page,
      browser,
      `(async () => {
        const record = window.__ldfcB.topics.get("101");
        const next = Object.assign({}, record, {
          basePool: "DISMISSED",
          updatedAt: Date.now() + 5000,
          deviceId: "device-b"
        });
        window.__ldfcB.topics.set("101", next);
        const result = await window.__ldfcBService.push();
        return { result: result, updatedAt: next.updatedAt };
      })()`
    );
    record(bWrite.result?.ok === true, "B 设备 push 成功");

    const aPull = await extEval(
      page,
      browser,
      `(async () => {
        const result = await window.LDFCSyncService.pull();
        const record = window.LDFCTopicState.get("101");
        return {
          result: result,
          record: record
            ? { basePool: record.basePool, deviceId: record.deviceId, updatedAt: record.updatedAt }
            : null
        };
      })()`
    );
    record(aPull.result?.ok === true && aPull.result?.changed === true, "A 设备 pull 检测到远端变化");
    record(aPull.record?.basePool === "DISMISSED", `A 设备合并后归属 DISMISSED（${aPull.record?.basePool}）`);
    record(aPull.record?.deviceId === "device-b", `A 设备记录带 B 的 deviceId（${aPull.record?.deviceId}）`);
    record(
      aPull.record?.updatedAt === bWrite.updatedAt,
      `A 设备保留较新的 updatedAt（${aPull.record?.updatedAt}）`
    );

    const putsAfter = mock.state.requests.filter((request) => request.method === "PUT");
    record(
      putsAfter.length >= 2 && putsAfter[1].ifMatch !== null,
      `后续写入使用 If-Match（${putsAfter[1]?.ifMatch}）`
    );

    console.log("[9b/12] 通知手动接管标记跨设备同步");
    const manualPush = await extEval(
      page,
      browser,
      `(async () => {
        window.LDFCSyncService.cancelScheduledPush();
        await window.LDFCTopicState.setNotifyLevel("101", 1, true);
        const result = await window.LDFCSyncService.push();
        const record = window.LDFCTopicState.get("101");
        return {
          result: result,
          record: record
            ? {
                notifyManualLevel: record.notifyManualLevel,
                notifyManualAt: record.notifyManualAt
              }
            : null
        };
      })()`
    );
    record(
      manualPush.result?.ok === true &&
        manualPush.record?.notifyManualLevel === 1 &&
        typeof manualPush.record?.notifyManualAt === "number",
      `A 设备写入手动接管标记并推送（${JSON.stringify(manualPush.record)}）`
    );

    const remoteManual = await readRemoteDoc(mock);
    const remoteManualDoc = remoteManual
      ? syncModel.fromRemoteDoc(remoteManual, "user-42")
      : null;
    const remoteManualTopic = remoteManualDoc?.topics?.find((item) => item.topicId === "101");
    record(
      remoteManualTopic?.notifyManualLevel === 1 &&
        typeof remoteManualTopic?.notifyManualAt === "number",
      `远端文件带手动接管标记（${JSON.stringify(remoteManualTopic)}）`
    );

    const bManual = await extEval(
      page,
      browser,
      `(async () => {
        const result = await window.__ldfcBService.pull();
        const record = window.__ldfcB.topics.get("101");
        return {
          result: result,
          record: record
            ? {
                notifyManualLevel: record.notifyManualLevel,
                notifyManualAt: record.notifyManualAt
              }
            : null
        };
      })()`
    );
    record(
      bManual.result?.ok === true &&
        bManual.record?.notifyManualLevel === 1 &&
        typeof bManual.record?.notifyManualAt === "number",
      `B 设备 pull 后拿到手动接管标记（${JSON.stringify(bManual.record)}）`
    );

    const bClear = await extEval(
      page,
      browser,
      `(async () => {
        const record = window.__ldfcB.topics.get("101");
        const next = Object.assign({}, record, {
          notifyManualLevel: null,
          notifyManualAt: Date.now() + 10000
        });
        window.__ldfcB.topics.set("101", next);
        const result = await window.__ldfcBService.push();
        return {
          result: result,
          notifyManualAt: next.notifyManualAt
        };
      })()`
    );
    record(bClear.result?.ok === true, "B 设备推送「跟随信息池」清除标记");

    const aCleared = await extEval(
      page,
      browser,
      `(async () => {
        const result = await window.LDFCSyncService.pull();
        const record = window.LDFCTopicState.get("101");
        return {
          result: result,
          record: record
            ? {
                notifyManualLevel: record.notifyManualLevel,
                notifyManualAt: record.notifyManualAt
              }
            : null
        };
      })()`
    );
    record(
      aCleared.result?.ok === true &&
        (aCleared.record?.notifyManualLevel === null ||
          aCleared.record?.notifyManualLevel === undefined) &&
        aCleared.record?.notifyManualAt === bClear.notifyManualAt,
      `A 设备 pull 后清除标记也同步（${JSON.stringify(aCleared.record)}）`
    );

    console.log("[10/12] 冲突与认证失败");
    const conflict = await extEval(
      page,
      browser,
      `(async () => {
        const transport = window.LDFCWebDAV.createTransport({
          url: "${WEBDAV_FILE}",
          username: "${WEBDAV_USER}",
          password: "${WEBDAV_PASSWORD}"
        });
        try {
          await transport.write(new Uint8Array([1, 2, 3]), '"stale"');
          return { threw: false };
        } catch (error) {
          return { threw: true, conflict: Boolean(error.conflict), status: error.status };
        }
      })()`
    );
    record(conflict.threw && conflict.conflict && conflict.status === 412, "过期 ETag 写入被识别为冲突（412）");

    const auth = await extEval(
      page,
      browser,
      `(async () => {
        const transport = window.LDFCWebDAV.createTransport({
          url: "${WEBDAV_FILE}",
          username: "${WEBDAV_USER}",
          password: "wrong-password"
        });
        try {
          await transport.read();
          return { threw: false };
        } catch (error) {
          return { threw: true, reason: error.reason, status: error.status };
        }
      })()`
    );
    record(auth.threw && auth.reason === "auth" && auth.status === 401, "错误密码被识别为认证失败（401）");

    mock.state.setDoc(null);
    const empty = await extEval(
      page,
      browser,
      `(async () => {
        const result = await window.LDFCSyncService.pull();
        return { ok: result.ok, empty: result.empty };
      })()`
    );
    record(empty.ok === true && empty.empty === true, "远端文件不存在时 pull 视为空，不报错");

    console.log("[11/12] 手动「立即同步」必须立刻重绘界面");
    const interestedLabel = '#ldfc-navigation button[data-pool="INTERESTED"]';
    const navBefore = ((await page.textContent(interestedLabel)) || "").trim();

    const remoteAdd = await extEval(
      page,
      browser,
      `(async () => {
        const now = Date.now();
        for (const [topicId, title] of [["104", "Remote Only Topic A"], ["105", "Remote Only Topic B"]]) {
          window.__ldfcB.topics.set(topicId, {
            topicId,
            basePool: "INTERESTED",
            inNewReply: false,
            title,
            createdAt: now,
            enteredPoolAt: now,
            updatedAt: now + 60000,
            deviceId: "device-b"
          });
        }
        const result = await window.__ldfcBService.push();
        return { ok: result.ok };
      })()`
    );
    record(remoteAdd.ok === true, "远端新增两条只存在于 B 设备的记录（104 / 105）");

    await jsClick(page, "#ldfc-settings-launch");
    await page.waitForSelector("#ldfc-sync-now", { timeout: 8000 });
    await jsClick(page, "#ldfc-sync-now");
    await page
      .waitForFunction(
        () => document.querySelector("#ldfc-toast-container")?.textContent.includes("同步完成"),
        null,
        { timeout: 10000 }
      )
      .catch(() => {});
    await page.waitForTimeout(300);

    const merged = await extEval(
      page,
      browser,
      `(() => {
        const ids = ["104", "105"];
        const found = ids.map((id) => window.LDFCTopicState.get(id)).filter(Boolean);
        return {
          count: found.length,
          pools: found.map((record) => record.basePool),
          interested: window.LDFCTopicState.listByPool("INTERESTED").length
        };
      })()`
    );
    record(
      merged?.count === 2 && merged.pools.every((pool) => pool === "INTERESTED"),
      `立即同步把远端记录合并进本地（${JSON.stringify(merged)}）`
    );

    const navAfter = ((await page.textContent(interestedLabel)) || "").trim();
    record(
      navAfter !== navBefore && navAfter.endsWith(String(merged?.interested)),
      `立即同步后导航计数立刻更新（"${navBefore}" → "${navAfter}"，状态里是 ${merged?.interested}）`
    );
    await jsClick(page, "#ldfc-settings .ldfc-settings-close");

    console.log("[12/12] 清除本地凭据");
    await jsClick(page, "#ldfc-settings-launch");
    await page.waitForSelector("#ldfc-sync-clear", { timeout: 8000 });

    // window.confirm 是在插件隔离世界里调用的；主世界覆盖无效，
    // 而且当前 CDP 会话捕获不到该对话框，因此直接在隔离世界里替换。
    const stubConfirm = (value) =>
      extEval(
        page,
        browser,
        `(() => {
          window.confirm = () => ${value};
          return true;
        })()`
      );

    await stubConfirm(false);
    await jsClick(page, "#ldfc-sync-clear");
    await page.waitForTimeout(300);
    const kept = await extEval(
      page,
      browser,
      `(() => {
        const config = window.LDFCSyncService.getConfig();
        return { backend: config.backend, hasPassword: Boolean(config.webdav?.password) };
      })()`
    );
    record(
      kept.backend === "webdav" && kept.hasPassword === true,
      `取消确认时不清除凭据（${JSON.stringify(kept)}）`
    );

    await stubConfirm(true);
    await jsClick(page, "#ldfc-sync-clear");
    await page.waitForTimeout(500);

    const cleared = await extEval(
      page,
      browser,
      `(() => {
        const config = window.LDFCSyncService.getConfig();
        return {
          backend: config.backend,
          webdav: config.webdav ?? null,
          hasTransport: window.LDFCSyncService.getStatus().hasTransport
        };
      })()`
    );
    record(
      cleared.backend === "none" && cleared.webdav === null && cleared.hasTransport === false,
      `清除凭据后不再保留配置（${JSON.stringify(cleared)}）`
    );

    const clearedUrl = await page.inputValue("#ldfc-sync-url");
    const clearedPassword = await page.inputValue("#ldfc-sync-password");
    record(clearedUrl === "" && clearedPassword === "", "清除后地址与密码输入框已清空");
    await jsClick(page, "#ldfc-settings .ldfc-settings-close");

    // 清理：清主题 + 墓碑，避免污染下一轮验收。
    await extEval(
      page,
      browser,
      `(async () => {
        await window.LDFCDB.clearTopics();
        await window.LDFCDB.clearTombstones();
        await window.LDFCTopicState.clearVisits();
        await window.LDFCTopicState.load();
        return true;
      })()`
    );
  } finally {
    await mock.close();
  }

  return report();
}

main()
  .then((failed) => process.exit(failed === 0 ? 0 : 1))
  .catch((error) => {
    console.error("同步验收异常：", error);
    report();
    process.exit(1);
  });
