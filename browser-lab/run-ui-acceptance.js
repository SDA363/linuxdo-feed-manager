"use strict";

// LDFC 阅读器 UI 验收：
//   1. 左下角五区导航可折叠成悬浮球、可拖动、状态持久化；
//   2. 正常 Topic 页与第三方预览弹窗里都有插件入口按钮。
//
// 这两个入口挂在第三方脚本生成的 DOM 上（.save-buttons-container /
// .ldp-overlay），真实站点上无法稳定复现，所以这里按它们已知的结构
// 现场造 DOM，验证「观察器能发现并注入」，而不是伪造第三方脚本。
//
// 前提：
//   node probe-server.js
//   node browser.js start --ext "D:/桌面/codex/linuxdo插件/browser-lab/.probe-ext" --url "http://127.0.0.1:8123/"
//
// 用法：node run-ui-acceptance.js [--url <页面地址>] [--port 9222]

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_URL = "http://127.0.0.1:8123/";

const results = [];
const record = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

function report() {
  const failed = results.filter((line) => line.startsWith("FAIL"));
  console.log("\n===== UI 验收结果 =====");
  for (const line of results) console.log(line);
  console.log(`\n汇总：${results.filter((line) => line.startsWith("PASS")).length} 项通过，${failed.length} 项失败`);
  return failed.length;
}

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

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    flags[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return flags;
}

async function extensionWorld(page, browser) {
  const context = browser.contexts()[0];
  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));
  const candidates = seen.filter((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!candidates.length) throw new Error("没有找到插件的隔离世界（isolated world）");
  // 插件被重复加载时会有多个隔离世界，挑真正挂了 LDFC 全局的那个。
  for (const candidate of candidates) {
    try {
      const probe = await session.send("Runtime.evaluate", {
        expression: "typeof window.LDFCDB",
        contextId: candidate.id,
        returnByValue: true
      });
      if (probe.result.value === "object") return { session, contextId: candidate.id };
    } catch {
      // 试下一个
    }
  }
  return { session, contextId: candidates[0].id };
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

// 轮询插件世界里的状态，直到符合预期或超时。
// 标记动作是异步写 IndexedDB 的，写死 sleep 既慢又不稳。
async function waitForValue(page, browser, expression, predicate, timeout = 8000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await extEval(page, browser, expression);
    if (predicate(last)) return last;
    await page.waitForTimeout(250);
  }
  return last;
}

const navState = (page) =>
  page.evaluate(() => {
    const nav = document.querySelector("#ldfc-navigation");
    if (!nav) return null;
    const rect = nav.getBoundingClientRect();
    const fab = nav.querySelector(".ldfc-nav-fab");
    const panel = nav.querySelector(".ldfc-nav-panel");
    const fabStyle = fab ? getComputedStyle(fab) : null;
    const panelStyle = panel ? getComputedStyle(panel) : null;
    const box = (element) => {
      if (!element) return null;
      const value = element.getBoundingClientRect();
      return {
        left: value.left,
        top: value.top,
        right: value.right,
        bottom: value.bottom,
        width: value.width,
        height: value.height
      };
    };
    return {
      collapsed: nav.dataset.collapsed,
      expandX: nav.dataset.expandX,
      expandY: nav.dataset.expandY,
      left: rect.left,
      top: rect.top,
      right: rect.right,
      width: rect.width,
      height: rect.height,
      fabRect: box(fab),
      panelRect: box(panel),
      fabVisible: Boolean(fabStyle && fabStyle.visibility !== "hidden" && Number(fabStyle.opacity) > 0.5),
      panelVisible: Boolean(
        panelStyle && panelStyle.visibility !== "hidden" && Number(panelStyle.opacity) > 0.5
      ),
      panelTransition: panelStyle?.transitionDuration || "",
      pools: nav.querySelectorAll(".ldfc-nav-items button[data-pool]").length,
      settings: Boolean(nav.querySelector("#ldfc-settings-launch"))
    };
  });

async function waitNav(page, collapsed, timeout = 5000) {
  await page.waitForFunction(
    (next) => document.querySelector("#ldfc-navigation")?.dataset.collapsed === String(next),
    collapsed,
    { timeout }
  );
  // 面板收起后视觉宽度就是球宽（52），展开后是完整面板宽（196）。
  // 等尺寸真正到位，避免动画中途取样误判。
  await page
    .waitForFunction(
      (next) => {
        const panel = document.querySelector("#ldfc-navigation .ldfc-nav-panel");
        if (!panel) return false;
        const width = panel.getBoundingClientRect().width;
        const nav = document.querySelector("#ldfc-navigation");
        const navWidth = nav?.getBoundingClientRect().width || 52;
        return next ? Math.abs(width - navWidth) <= 0.75 : width >= 190;
      },
      collapsed,
      { timeout: 4000 }
    )
    .catch(() => {});
  // 球在收起结束时淡回、展开开始时淡出，也等到位。
  await page
    .waitForFunction(
      (next) => {
        const fab = document.querySelector("#ldfc-navigation .ldfc-nav-fab");
        if (!fab) return false;
        const opacity = Number(getComputedStyle(fab).opacity);
        return next ? opacity > 0.95 : opacity < 0.05;
      },
      collapsed,
      { timeout: 2000 }
    )
    .catch(() => {});
}

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const url = flags.url || DEFAULT_URL;
  const port = Number(flags.port || process.env.BROWSER_LAB_PORT || 9222);

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const page = context.pages()[0];
  if (!page) throw new Error("浏览器里没有页面，先用 browser.js start 打开页面");

  const extensionErrors = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const source = message.location()?.url || "";
    if (source.startsWith("chrome-extension://")) extensionErrors.push(message.text());
  });

  console.log("[1/13] 打开页面并复位导航 UI 状态");
  await page.goto(new URL("/__set?user=42&login=1&unread=1", url).href, { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });

  // 位置是持久化的，上一轮（或人工操作）会残留，先清掉锚点回到默认左下角。
  await extEval(page, browser, `window.LDFCDB.putMeta("navUiState", {})`);
  // 启动形态也复位：上一轮若停在「悬浮球」档，会让"默认展开"断言假失败。
  await extEval(page, browser, `window.LDFCDB.putMeta("navStartMode", "panel")`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  await page.waitForTimeout(300);

  console.log("[2/13] 默认形态：从球展开的完整面板");
  const initial = await navState(page);
  record(
    initial.collapsed === "false" &&
      initial.pools === 5 &&
      initial.settings &&
      initial.panelVisible &&
      initial.panelRect.width >= 190 &&
      !initial.fabVisible,
    `默认展开（五区 ${initial.pools} 个 + 设置：${initial.settings}，` +
      `面板 ${Math.round(initial.panelRect.width)}×${Math.round(initial.panelRect.height)}，` +
      `球已让位：${!initial.fabVisible}）`
  );

  // 位置断言一律用 nav 的布局盒：悬浮球 hover / 展开时带 scale，
  // 视觉盒会缩 1~3px，不能拿来当"球有没有跳位"的基准。
  const iconBox = (state) => ({
    left: state.left,
    top: state.top,
    right: state.right,
    bottom: state.top + state.height
  });

  console.log("[3/13] 收起：面板缩回 52×52 并和球重合，球原地不动");
  const expandedBefore = await navState(page);
  await page.keyboard.press("Escape");
  await waitNav(page, true);
  const collapsed = await navState(page);
  record(
    collapsed.collapsed === "true" &&
      collapsed.panelRect.width <= 54 &&
      collapsed.panelRect.height <= 54 &&
      collapsed.fabVisible,
    `收起后只剩悬浮球（面板 ${Math.round(collapsed.panelRect.width)}×` +
      `${Math.round(collapsed.panelRect.height)}，球可见：${collapsed.fabVisible}）`
  );
  record(
    Math.abs(collapsed.panelRect.left - collapsed.left) <= 1 &&
      Math.abs(collapsed.panelRect.top - collapsed.top) <= 1,
    `收起态面板与球完全重合（Δx=${Math.round(collapsed.panelRect.left - collapsed.left)}，` +
      `Δy=${Math.round(collapsed.panelRect.top - collapsed.top)}）`
  );
  record(
    Math.abs(iconBox(collapsed).left - iconBox(expandedBefore).left) <= 1 &&
      Math.abs(iconBox(collapsed).top - iconBox(expandedBefore).top) <= 1,
    `收起时球不跳位（Δx=${Math.round(iconBox(collapsed).left - iconBox(expandedBefore).left)}，` +
      `Δy=${Math.round(iconBox(collapsed).top - iconBox(expandedBefore).top)}）`
  );

  console.log("[4/13] 再点一次原地展开，球仍然不动");
  await page.click(".ldfc-nav-fab");
  await waitNav(page, false);
  const reopened = await navState(page);
  record(
    reopened.collapsed === "false" &&
      reopened.panelRect.width >= 190 &&
      Math.abs(iconBox(reopened).left - iconBox(expandedBefore).left) <= 1 &&
      Math.abs(iconBox(reopened).top - iconBox(expandedBefore).top) <= 1,
    `原地连点两轮球不漂移（Δx=${Math.round(iconBox(reopened).left - iconBox(expandedBefore).left)}，` +
      `Δy=${Math.round(iconBox(reopened).top - iconBox(expandedBefore).top)}）`
  );
  record(
    /0\.4[0-9]*s/.test(reopened.panelTransition),
    `图标→面板使用连续放大过渡（transition-duration=${reopened.panelTransition}）`
  );

  console.log("[5/13] 球在四个角时自动选择展开方向");
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));

  async function dragFabBy(dx, dy) {
    const state = await navState(page);
    const fromX = state.left + state.width / 2;
    const fromY = state.top + state.height / 2;
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(fromX + dx, fromY + dy, { steps: 10 });
    await page.mouse.up();
    // 拖完有 400ms 的点击抑制窗口，等过去再继续操作
    await page.waitForTimeout(520);
  }

  async function moveFabTo(targetLeft, targetTop) {
    const current = await navState(page);
    if (current.collapsed === "false") {
      await page.keyboard.press("Escape");
      await waitNav(page, true);
    }
    const state = await navState(page);
    await dragFabBy(targetLeft - state.left, targetTop - state.top);
    return navState(page);
  }

  const corners = [
    { name: "右下", left: viewport.width - 60, top: viewport.height - 60, x: "left", y: "up" },
    { name: "左下", left: 8, top: viewport.height - 60, x: "right", y: "up" },
    { name: "右上", left: viewport.width - 60, top: 8, x: "left", y: "down" },
    { name: "左上", left: 8, top: 8, x: "right", y: "down" }
  ];

  for (const corner of corners) {
    const moved = await moveFabTo(corner.left, corner.top);
    // 收起态拖到角上后，再把鼠标移开、移回球心展开。
    await page.mouse.move(5, 5);
    await waitNav(page, true);
    await page.mouse.move(moved.left + moved.width / 2, moved.top + moved.height / 2);
    await waitNav(page, false);
    const opened = await navState(page);
    const panel = opened.panelRect;
    const inside =
      panel.left >= -0.5 &&
      panel.top >= -0.5 &&
      panel.right <= viewport.width + 0.5 &&
      panel.bottom <= viewport.height + 0.5;
    const growsToward =
      (corner.x === "left" ? panel.right >= opened.right - 1 : panel.left <= opened.left + 1) &&
      (corner.y === "up"
        ? panel.bottom >= opened.top + opened.height - 1
        : panel.top <= opened.top + 1);
    record(
      opened.expandX === corner.x && opened.expandY === corner.y,
      `${corner.name}角：自动向 ${opened.expandX}/${opened.expandY} 展开（期望 ${corner.x}/${corner.y}）`
    );
    record(
      growsToward && inside,
      `${corner.name}角：面板从球的位置朝 ${corner.x}/${corner.y} 长出来且不出视口`
    );
  }

  console.log("[6/13] 悬停展开 / 离开收起");
  await page.mouse.move(5, 5);
  await waitNav(page, true, 3000);
  const hoverBox = await navState(page);
  await page.mouse.move(hoverBox.left + hoverBox.width / 2, hoverBox.top + hoverBox.height / 2);
  await waitNav(page, false, 3000);
  record((await navState(page)).panelVisible, "鼠标移到悬浮球上自动展开");
  await page.mouse.move(5, 5);
  await waitNav(page, true, 3000);
  record((await navState(page)).collapsed === "true", "鼠标离开面板后自动收起");

  console.log("[7/13] 点过面板内容保持展开，点外部收起");
  const hoverBox2 = await navState(page);
  await page.mouse.move(hoverBox2.left + hoverBox2.width / 2, hoverBox2.top + hoverBox2.height / 2);
  await waitNav(page, false, 3000);
  await page.click('#ldfc-navigation button[data-pool="HOME"]');
  await page.mouse.move(5, 5);
  await page.waitForTimeout(500);
  record((await navState(page)).collapsed === "false", "点过面板里的按钮后，鼠标移开仍保持展开");
  await page.evaluate(() => {
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await waitNav(page, true);
  record((await navState(page)).collapsed === "true", "点击面板外部后自动收起");

  const hoverBox3 = await navState(page);
  await page.mouse.move(hoverBox3.left + hoverBox3.width / 2, hoverBox3.top + hoverBox3.height / 2);
  await waitNav(page, false, 3000);
  await page.keyboard.press("Escape");
  await waitNav(page, true);
  await page.waitForTimeout(400);
  record((await navState(page)).collapsed === "true", "按 Esc 收起后不会因鼠标停留自动弹回");

  console.log("[8/13] 悬浮球上的新回复徽标");
  const badge = await page.evaluate(() => {
    const nav = document.querySelector("#ldfc-navigation");
    const count = Number(
      nav.querySelector('.ldfc-nav-items button[data-pool="NEW_REPLY"] span')?.textContent ?? -1
    );
    const element = nav.querySelector(".ldfc-nav-badge");
    return { count, hidden: element.hidden, text: element.textContent };
  });
  record(
    badge.count >= 0 && badge.hidden === (badge.count === 0) && (badge.count === 0 || badge.text === String(badge.count)),
    `徽标与新回复计数一致（计数 ${badge.count}，徽标 "${badge.text}"，hidden=${badge.hidden}）`
  );

  console.log("[9/13] 拖动悬浮球 + 位置持久化");
  const before = await navState(page);
  await page.mouse.move(before.left + before.width / 2, before.top + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.left + before.width / 2 + 160, before.top + before.height / 2 + 120, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  const dragged = await navState(page);
  const movedX = dragged.left - before.left;
  const movedY = dragged.top - before.top;
  record(
    Math.abs(movedX - 160) <= 4 && Math.abs(movedY - 120) <= 4,
    `拖动生效（Δx=${Math.round(movedX)}, Δy=${Math.round(movedY)}）`
  );
  record(
    dragged.collapsed === before.collapsed,
    `拖动不会误切换折叠状态（${before.collapsed} → ${dragged.collapsed}）`
  );
  record(
    dragged.left >= 0 &&
      dragged.top >= 0 &&
      dragged.right <= viewport.width &&
      dragged.top + dragged.height <= viewport.height,
    "拖动后仍完整留在视口内"
  );

  const savedAnchor = await extEval(page, browser, `window.LDFCDB.getMeta("navUiState")`);
  record(
    Number.isFinite(savedAnchor?.left) && Number.isFinite(savedAnchor?.top),
    `位置按「球左上角」持久化（left=${Math.round(savedAnchor?.left)}，top=${Math.round(savedAnchor?.top)}）`
  );

  await page.waitForTimeout(300);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  await page.waitForTimeout(500);
  const restored = await navState(page);
  record(
    restored.collapsed === "false" &&
      Math.abs(restored.left - dragged.left) <= 2 &&
      Math.abs(restored.top - dragged.top) <= 2,
    `刷新后位置恢复、默认展开（left=${Math.round(restored.left)}, top=${Math.round(restored.top)}）`
  );

  console.log("[9b] 信息池面板：再点一次收起 + 移入其他池 + 长按多选");
  const poolTab = '#ldfc-navigation .ldfc-nav-items button[data-pool="INTERESTED"]';
  await page.evaluate((selector) => document.querySelector(selector)?.click(), poolTab);
  await page.waitForTimeout(600);
  const panelOpened = await page.evaluate(() => {
    const el = document.querySelector("#ldfc-panel");
    return { hidden: el?.hidden, state: el?.dataset.sheetState ?? "" };
  });
  await page.evaluate((selector) => document.querySelector(selector)?.click(), poolTab);
  await page.waitForTimeout(700);
  const panelToggledShut = await page.evaluate(() => {
    const el = document.querySelector("#ldfc-panel");
    return { hidden: el?.hidden, state: el?.dataset.sheetState ?? "" };
  });
  record(
    panelOpened.hidden === false &&
      panelOpened.state === "open" &&
      panelToggledShut.hidden === true &&
      panelToggledShut.state === "",
    `再点一次当前池子就收起（open → ${panelToggledShut.state || "hidden"}，和设置按钮同一套 toggle）`
  );

  // 池内「移入…」：目标里不含当前池，新回复只有感兴趣 / 已读可用
  const panelRows = await extEval(
    page,
    browser,
    `(async () => {
      const ids = window.LDFCTopicParser.listRows().map((row) => row.dataset.topicId);
      const pick = ids.slice(-2);
      for (const id of pick) await window.LDFCPoolManager.markInterested({ topicId: id, title: "移入测试 " + id });
      window.LDFCFilter.setActivePool("INTERESTED");
      window.LDFCPoolPanel.render("INTERESTED");
      await new Promise((resolve) => setTimeout(resolve, 600));
      return pick;
    })()`
  );
  const moveMenu = await page.evaluate(() => {
    const item = document.querySelector("#ldfc-panel .ldfc-panel-item");
    const toggle = [...(item?.querySelectorAll("button") ?? [])].find((b) => b.textContent.includes("移入"));
    toggle?.click();
    const targets = item?.querySelector(".ldfc-move-targets");
    return {
      opened: Boolean(toggle) && targets?.hidden === false,
      labels: targets ? [...targets.querySelectorAll("button")].map((b) => b.textContent.trim()) : [],
      disabled: targets ? [...targets.querySelectorAll("button:disabled")].map((b) => b.textContent.trim()) : []
    };
  });
  record(
    moveMenu.opened &&
      moveMenu.labels.length === 4 &&
      !moveMenu.labels.some((label) => label.includes("⭐ 感兴趣")) &&
      moveMenu.labels.some((label) => label.includes("新回复")) &&
      moveMenu.disabled.length === 0,
    `池内「移入…」列出其他池子（opened=${moveMenu.opened}，${JSON.stringify(moveMenu.labels)}，` +
      `disabled=${JSON.stringify(moveMenu.disabled)}）`
  );

  const movedToRead = await page.evaluate(() => {
    const item = document.querySelector("#ldfc-panel .ldfc-panel-item");
    const target = [...(item?.querySelectorAll(".ldfc-move-targets button") ?? [])].find((b) =>
      b.textContent.includes("已读")
    );
    target?.click();
    return Boolean(target);
  });
  await page.waitForTimeout(500);
  const movedPools = await extEval(
    page,
    browser,
    `[${panelRows.map((id) => `window.LDFCTopicState.get("${id}")?.basePool`).join(",")}]`
  );
  record(
    movedToRead && Array.isArray(movedPools) && movedPools.filter((pool) => pool === "READ").length === 1,
    `池内可以直接改归属，不用先移回主信息流（${JSON.stringify(movedPools)}）`
  );

  // 池内多选：长按面板里的记录 → 勾选两条 → 批量移入
  await extEval(
    page,
    browser,
    `(async () => {
       // 自清理：DISMISSED 是跨轮持久化的，先把这个池腾空，断言才能锁定"正好这两条"
       for (const record of window.LDFCTopicState.listByPool("DISMISSED")) {
         if (!${JSON.stringify(panelRows)}.includes(record.topicId)) {
           await window.LDFCPoolManager.moveToPool(record.topicId, "HOME", {});
         }
       }
       for (const id of ${JSON.stringify(panelRows)}) await window.LDFCPoolManager.moveToPool(id, "DISMISSED", {});
       window.LDFCFilter.setActivePool("DISMISSED");
       window.LDFCPoolPanel.render("DISMISSED");
       return 1;
     })()`
  );
  await page.waitForTimeout(500);
  const poolItemCount = await page.evaluate(() => {
    const items = [...document.querySelectorAll("#ldfc-panel .ldfc-panel-item")];
    items[0]?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })
    );
    return items.length;
  });
  await page.waitForTimeout(700);
  const poolEntered = await page.evaluate(() => ({
    selecting: document.getElementById("ldfc-panel")?.classList.contains("ldfc-pool-selecting") ?? false,
    count: document.querySelector("#ldfc-panel .ldfc-bulk-count")?.textContent ?? ""
  }));
  record(
    poolItemCount === 2 && poolEntered.selecting && poolEntered.count === "已选 1",
    `池内长按记录进入多选（${poolItemCount} 条，${poolEntered.count}）`
  );

  // enterSelection 后 400ms 内的点击会被忽略（防长按松手补发的 click）
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const items = [...document.querySelectorAll("#ldfc-panel .ldfc-panel-item")];
    items[1]?.click();
  });
  await page.waitForTimeout(200);
  const poolPicked = await page.evaluate(() => ({
    count: document.querySelector("#ldfc-panel .ldfc-bulk-count")?.textContent ?? "",
    rows: document.querySelectorAll("#ldfc-panel .ldfc-panel-item.ldfc-selected").length,
    actionsHidden: [...document.querySelectorAll("#ldfc-panel .ldfc-panel-actions")].every(
      (element) => getComputedStyle(element).display === "none"
    )
  }));
  record(
    poolPicked.rows === 2 &&
      poolPicked.count === "已选 2" &&
      poolPicked.actionsHidden,
    `池内多选勾选两条并隐藏单条按钮（${poolPicked.count}，${poolPicked.rows} 行高亮，按钮隐藏=${poolPicked.actionsHidden}）`
  );

  await page.evaluate(() => document.querySelector("#ldfc-panel .ldfc-bulk-move")?.click());
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const target = [...document.querySelectorAll("#ldfc-panel .ldfc-bulk-targets button")].find(
      (button) => button.textContent.includes("已读")
    );
    target?.click();
  });
  await page.waitForTimeout(900);
  const poolBatchPools = await extEval(
    page,
    browser,
    `[${panelRows.map((id) => `window.LDFCTopicState.get("${id}")?.basePool`).join(",")}]`
  );
  const poolBatchExited = await page.evaluate(
    () => !document.getElementById("ldfc-panel")?.classList.contains("ldfc-pool-selecting")
  );
  record(
    Array.isArray(poolBatchPools) &&
      poolBatchPools.length === 2 &&
      poolBatchPools.every((pool) => pool === "READ") &&
      poolBatchExited,
    `池内多选批量移入已读（${JSON.stringify(poolBatchPools)}，已退出=${poolBatchExited}）`
  );
  await extEval(
    page,
    browser,
    `(async () => {
       for (const id of ${JSON.stringify(panelRows)}) await window.LDFCPoolManager.moveHome(id);
       window.LDFCFilter.setActivePool("HOME");
       return 1;
     })()`
  );
  await page.waitForTimeout(300);

  // 长按行按钮 → 抖动 → 多选 → 点导航池子批量移入
  await page.evaluate(() => document.querySelector("#ldfc-panel-close")?.click());
  await page.waitForTimeout(700);
  await extEval(
    page,
    browser,
    `(async () => { for (const id of ${JSON.stringify(panelRows)}) await window.LDFCPoolManager.moveHome(id); return 1; })()`
  );
  await page.waitForTimeout(300);

  // 「点导航池子不该改池子」断言的前提是这两行都在主信息流。
  // 它们可能被前面的标记用例动过（实测出现过第二行本来就是 READ），
  // 和上面 panelRows 一样先复位，别让前置状态冒充回归。
  await extEval(
    page,
    browser,
    `(async () => {
      const ids = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
        .slice(0, 2)
        .map((row) => row.dataset.topicId);
      for (const id of ids) {
        try { await window.LDFCPoolManager.moveHome(id); } catch {}
      }
      return ids;
    })()`
  );
  await page.waitForTimeout(300);

  const multiIds = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")].slice(0, 2);
    rows[0]?.querySelector(".ldfc-actions")?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })
    );
    return rows.map((row) => row.dataset.topicId);
  });
  await page.waitForTimeout(700);
  const longPressed = await page.evaluate(() => ({
    selecting: document.documentElement.classList.contains("ldfc-selecting")
  }));
  record(
    longPressed.selecting,
    `长按行按钮进入多选（html.ldfc-selecting=${longPressed.selecting}）`
  );

  // enter() 后 400ms 内的点击会被忽略（防长按松手那次 click 误选）
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")].slice(0, 2);
    for (const row of rows) row.querySelector(".ldfc-action.interested")?.click();
  });
  await page.waitForTimeout(200);
  const selectedState = await page.evaluate(() => ({
    badge: document.querySelector("#ldfc-navigation .ldfc-select-count")?.textContent ?? "",
    rows: document.querySelectorAll(".ldfc-selected").length
  }));
  record(
    selectedState.rows === 2 && selectedState.badge === "已选 2",
    `多选时点按钮 = 勾选而不是标记（${selectedState.badge}，${selectedState.rows} 行高亮）`
  );

  // 多选里点标题必须照常打开帖子：拦截只发生在胶囊内部。
  const titleClick = await page.evaluate(() => {
    const link = document.querySelector(".topic-list-item a.title");
    if (!link) return { missing: true };
    let blockedByExtension = false;
    const probe = (event) => {
      blockedByExtension = event.defaultPrevented;
      // 自己吞掉，避免真的跳走
      event.preventDefault();
    };
    link.addEventListener("click", probe, { once: true });
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    return { missing: false, blockedByExtension };
  });
  record(
    !titleClick.missing && titleClick.blockedByExtension === false,
    `多选时点标题不被拦截（拦截=${titleClick.blockedByExtension}）`
  );

  // 多选态点导航池子：不再批量移入，只提示
  await page.evaluate(() =>
    document.querySelector('#ldfc-navigation .ldfc-nav-items button[data-pool="READ"]')?.click()
  );
  await page.waitForTimeout(600);
  const navClickPools = await extEval(
    page,
    browser,
    `[${multiIds.map((id) => `window.LDFCTopicState.get("${id}")?.basePool`).join(",")}]`
  );
  const stillSelecting = await page.evaluate(() =>
    document.documentElement.classList.contains("ldfc-selecting")
  );
  record(
    Array.isArray(navClickPools) && navClickPools.every((pool) => pool === "HOME") && stillSelecting,
    `多选态点导航池子不再批量移入（${JSON.stringify(navClickPools)}，仍多选=${stillSelecting}）`
  );

  // 拖拽投放：按住任意一枚胶囊 → 移到「已读」格 → 松手。
  // 用合成的 PointerEvent（和"长按进入多选"同一套做法），
  // Playwright 的 mouse 输入在 headless 下不一定派发 pointer 事件。
  await page.evaluate(() => {
    const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
    const rect = layer.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      pointerType: "mouse",
      button: 0,
      pointerId: 7,
      isPrimary: true,
      buttons: 1
    };
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    layer.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: cx, clientY: cy }));
    // 超过 6px 才算"移动"，否则会被当成长按
    layer.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: cx, clientY: cy - 24 }));
  });
  await page.waitForTimeout(120);

  const dropPanelState = await page.evaluate(() => {
    const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
    const panel = document.querySelector(".ldfc-drop");
    // 只数投放格子：面板里还有锚点和牵引线两个装饰节点
    const items = [...(panel?.querySelectorAll(".ldfc-drop-item") ?? [])];
    const readItem = items.find((item) => item.dataset.pool === "READ");
    const dx = Number.parseFloat(readItem?.style.getPropertyValue("--dx") ?? "0");
    const dy = Number.parseFloat(readItem?.style.getPropertyValue("--dy") ?? "0");
    const panelCenter = {
      x: Number.parseFloat(panel?.style.left ?? "0"),
      y: Number.parseFloat(panel?.style.top ?? "0")
    };
    // 把胶囊中心挪到「已读」格
    layer.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        cancelable: true,
        view: window,
        pointerType: "mouse",
        button: 0,
        pointerId: 7,
        isPrimary: true,
        buttons: 1,
        clientX: panelCenter.x + dx,
        clientY: panelCenter.y + dy
      })
    );
    return {
      count: items.length,
      open: Boolean(panel?.classList.contains("ldfc-drop-open")),
      pools: items.map((item) => item.dataset.pool),
      following: Boolean(document.querySelector(".ldfc-actions.ldfc-dragging")),
      hot: document.querySelector(".ldfc-drop-item.ldfc-hot")?.dataset.pool ?? ""
    };
  });
  record(
    dropPanelState.count === 5 && dropPanelState.open && dropPanelState.following,
    `按住拖动时胶囊跟手并展开五个池子（${dropPanelState.pools.join(" / ")}）`
  );

  const hotPool = dropPanelState.hot;
  await page.evaluate(() => {
    const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
    layer.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        cancelable: true,
        view: window,
        pointerType: "mouse",
        button: 0,
        pointerId: 7,
        isPrimary: true
      })
    );
  });
  await page.waitForTimeout(900);

  const dropResult = await extEval(
    page,
    browser,
    `[${multiIds.map((id) => `window.LDFCTopicState.get("${id}")?.basePool`).join(",")}]`
  );
  const dropExited = await page.evaluate(
    () => !document.documentElement.classList.contains("ldfc-selecting")
  );
  record(
    hotPool === "READ" &&
      Array.isArray(dropResult) &&
      dropResult.length === 2 &&
      dropResult.every((pool) => pool === "READ") &&
      dropExited,
    `拖到「已读」格松手批量移入（悬停=${hotPool}，${JSON.stringify(dropResult)}，已退出=${dropExited}）`
  );

  // 双击同一枚胶囊（同一位置）= 退出多选
  await page.evaluate(() => {
    const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
    layer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })
    );
  });
  await page.waitForTimeout(1100);
  const doubleExit = await page.evaluate(() => {
    const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
    const button = layer?.querySelector("button");
    if (!button) return { missing: true };
    const fire = () =>
      button.dispatchEvent(
        new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: 40,
          clientY: 40
        })
      );
    fire();
    fire();
    return {
      missing: false,
      selecting: document.documentElement.classList.contains("ldfc-selecting"),
      selected: document.querySelectorAll(".ldfc-selected").length,
      badge: document.querySelector("#ldfc-navigation .ldfc-select-count")?.textContent ?? ""
    };
  });
  record(
    !doubleExit.missing &&
      doubleExit.selecting === false &&
      doubleExit.selected === 0 &&
      doubleExit.badge === "",
    `双击同一枚胶囊退出多选（仍在多选=${doubleExit.selecting}，已选=${doubleExit.selected}）`
  );

  // 顶部行：半圆向上放不下时要整圈翻到下面，否则格子会跑出视口。
  // 用 scrollIntoView 把首行贴到视口顶部来制造这个条件。
  const flipState = await page.evaluate(async () => {
    const row = document.querySelector(".topic-list-item[data-topic-id]");
    if (!row) return { missing: true };
    row.scrollIntoView({ block: "start" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const layer = row.querySelector(".ldfc-actions");
    if (!layer) return { missing: true };
    // 合成 hover 不会触发 :hover，这里临时显形只为量到真实尺寸
    const previousDisplay = layer.style.display;
    layer.style.display = "inline-flex";
    const rect = layer.getBoundingClientRect();
    const base = {
      bubbles: true,
      cancelable: true,
      view: window,
      pointerType: "mouse",
      button: 0,
      pointerId: 11,
      isPrimary: true,
      buttons: 1
    };
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    layer.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: cx, clientY: cy }));
    layer.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: cx + 10, clientY: cy + 10 }));
    const panel = document.querySelector(".ldfc-drop");
    const dys = [...(panel?.querySelectorAll(".ldfc-drop-item") ?? [])].map(
      (item) => Number.parseFloat(item.style.getPropertyValue("--dy")) || 0
    );
    const result = {
      missing: false,
      centerY: Math.round(cy),
      flipped: Boolean(panel?.classList.contains("ldfc-drop-flipped")),
      allDown: dys.length === 5 && dys.every((dy) => dy > 0)
    };
    layer.dispatchEvent(new PointerEvent("pointercancel", { ...base, clientX: cx, clientY: cy }));
    layer.style.display = previousDisplay;
    window.scrollTo(0, 0);
    return result;
  });
  await page.waitForTimeout(400);
  record(
    !flipState.missing && flipState.flipped && flipState.allDown,
    `顶部行放不下时整圈翻到下面（centerY=${flipState.centerY}，flipped=${flipState.flipped}，全部向下=${flipState.allDown}）`
  );

  await extEval(
    page,
    browser,
    `(async () => { for (const id of ${JSON.stringify(multiIds)}) await window.LDFCPoolManager.moveHome(id); return 1; })()`
  );
  await extEval(page, browser, `window.LDFCFilter.setActivePool("HOME")`);
  await page.waitForTimeout(300);

  console.log("[10/13] Topic 页：三个操作按钮");
  await page.goto(new URL("/t/topic/101", url).href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  await page.evaluate(() => {
    const outlet = document.querySelector("#main-outlet") || document.body;
    // 真实站点首楼是 article[data-user-id]；「只看楼主」要靠它和 #post_1 比较。
    outlet.insertAdjacentHTML(
      "afterbegin",
      `<article class="boxed onscreen-post" id="post_1" data-post-id="1" data-user-id="11">
         <div class="topic-body"><div class="contents">
           <div class="cooked"><p>首楼内容</p></div>
         </div></div>
       </article>
       <div class="topic-post"><article data-post-number="2" data-user-id="22">
         <div class="topic-body"><div class="contents">
           <div class="cooked"><p>二楼内容</p></div>
         </div></div>
       </article></div>`
    );
  });

  let topicToolbar = null;
  try {
    await page.waitForFunction(
      () => document.querySelectorAll("#post_1 .cooked .ldfc-reader-actions-topic").length === 1,
      { timeout: 5000 }
    );
    topicToolbar = await page.evaluate(() => {
      const root = document.querySelector(".ldfc-reader-actions-topic")?.shadowRoot;
      if (!root) return null;
      return {
        pools: [...root.querySelectorAll("button[data-pool]")].length,
        tools: [...root.querySelectorAll("button[data-tool]")].map((button) =>
          button.textContent.trim()
        )
      };
    });
  } catch {
    topicToolbar = null;
  }
  record(
    topicToolbar?.pools === 3 &&
      topicToolbar?.tools.length === 4 &&
      topicToolbar.tools.some((label) => label.includes("全部") || label.includes("楼主")) &&
      topicToolbar.tools.some((label) => label.includes("通知")) &&
      topicToolbar.tools.some((label) => label.includes("保存到本地")) &&
      topicToolbar.tools.some((label) => label.includes("生成快照")),
    `首楼：3 个池子按钮 + 4 个工具按钮（${topicToolbar?.tools?.join(" / ") ?? "无"}）`
  );
  record(
    await page.evaluate(() => Boolean(document.querySelector("#post_1 .cooked > .ldfc-topic-actions-row"))),
    "没有第三方按钮容器时自建一行，位置在首楼内容末尾"
  );

  console.log("[11/13] 与「保存到本地」同一行 + 标记 + 计数刷新");
  await page.evaluate(() => {
    const cooked = document.querySelector("#post_1 .cooked");
    cooked.querySelector(".ldfc-topic-actions-row")?.remove();
    const container = document.createElement("div");
    container.className = "save-buttons-container";
    container.style.display = "flex";
    container.style.gap = "10px";
    container.innerHTML =
      '<button class="save-to-local-btn">💾 保存到本地</button>' +
      '<button class="save-to-image-btn">🖼️ 保存为图片</button>';
    cooked.appendChild(container);
  });
  let inSameRow = false;
  try {
    await page.waitForFunction(
      () =>
        document.querySelectorAll(
          "#post_1 .cooked > .save-buttons-container > .ldfc-reader-actions-topic"
        ).length === 1,
      { timeout: 5000 }
    );
    inSameRow = true;
  } catch {
    inSameRow = false;
  }
  record(inSameRow, "三个按钮与「保存到本地 / 生成快照」同一行");
  await page.waitForTimeout(600);
  record(
    (await page.evaluate(() => document.querySelectorAll(".ldfc-reader-actions-topic").length)) === 1,
    "观察器反复触发也不会重复注入"
  );

  // 首楼按钮组与预览窗 dock 要同一种水平对齐（居中），否则两种窗口里位置会跳。
  const topicCentered = await page.evaluate(() => {
    const cooked = document.querySelector("#post_1 .cooked");
    const host = cooked?.querySelector(".ldfc-reader-actions-topic");
    const row = host?.shadowRoot?.querySelector(".row");
    if (!cooked || !row) return null;
    const style = getComputedStyle(cooked);
    const base = cooked.getBoundingClientRect();
    const left = base.left + cooked.clientLeft + parseFloat(style.paddingLeft || 0);
    const right = left + cooked.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
    const centerOf = (element) => {
      const rect = element.getBoundingClientRect();
      return (rect.left + rect.right) / 2;
    };
    const tools = host.shadowRoot.querySelector(".tools");
    return {
      target: (left + right) / 2,
      row: centerOf(row),
      tools: tools ? centerOf(tools) : null
    };
  });
  record(
    topicCentered &&
      Math.abs(topicCentered.row - topicCentered.target) <= 2 &&
      (topicCentered.tools === null || Math.abs(topicCentered.tools - topicCentered.target) <= 2),
    `首楼按钮组与工具排水平居中（胶囊 ${Math.round(topicCentered?.row)} / 工具 ${Math.round(
      topicCentered?.tools ?? NaN
    )} / 正文中心 ${Math.round(topicCentered?.target)}）`
  );
  const clone = await page.evaluate(() => {
    const cooked = document.querySelector("#post_1 .cooked");
    const copy = cooked.cloneNode(true);
    const inCopy = copy.querySelector(".ldfc-reader-actions-topic");
    return {
      liveHasShadow: Boolean(document.querySelector(".ldfc-reader-actions-topic")?.shadowRoot),
      // 「保存到本地」就是 clone 这段内容导出 HTML，影子树不会被复制，
      // 所以导出文件里这个按钮是空元素（不可见），不会污染保存结果。
      clonedHasShadow: Boolean(inCopy?.shadowRoot),
      clonedText: inCopy?.textContent ?? ""
    };
  });
  record(
    clone.liveHasShadow && !clone.clonedHasShadow && clone.clonedText === "",
    `按钮本体在影子树里：克隆到导出 HTML 时不带内容（克隆文本 "${clone.clonedText}"）`
  );

  // 真实帖子页的「只看楼主」：拿 #post_1 的 data-user-id 比较每层 article。
  // 直接读被隐藏的那层 .topic-post，因为内联 display 写在它身上。
  const topicOnlyOp = () =>
    page.evaluate(() => {
      const other = document.querySelector(".topic-post > article[data-user-id]");
      return {
        op: getComputedStyle(document.querySelector("#post_1")).display,
        other: other ? getComputedStyle(other.closest(".topic-post")).display : "missing",
        label: document
          .querySelector(".ldfc-reader-actions-topic")
          ?.shadowRoot?.querySelector('button[data-tool="op"]')?.textContent
      };
    });
  const clickTopicTool = (tool) =>
    page.evaluate((name) => {
      document
        .querySelector(".ldfc-reader-actions-topic")
        .shadowRoot.querySelector(`button[data-tool="${name}"]`)
        .click();
    }, tool);

  const topicOnlyBefore = await topicOnlyOp();
  await clickTopicTool("op");
  await page.waitForTimeout(200);
  const topicOnlyOn = await topicOnlyOp();
  await clickTopicTool("op");
  await page.waitForTimeout(200);
  const topicOnlyOff = await topicOnlyOp();
  record(
    topicOnlyBefore.other !== "none" &&
      topicOnlyOn.other === "none" &&
      topicOnlyOn.op !== "none" &&
      topicOnlyOff.other !== "none" &&
      topicOnlyOn.label.includes("只看楼主"),
    `真实帖子页「只看楼主」切换（非楼主 ${topicOnlyBefore.other} → ${topicOnlyOn.other} → ${topicOnlyOff.other}）`
  );

  // 真实帖子页保存：和预览窗共用 cleanClone + inlineImages。
  await extEval(
    page,
    browser,
    `(() => {
      window.__ldfcTopicSaved = [];
      const originalCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        try {
          blob.text()
            .then((text) => window.__ldfcTopicSaved.push({ type: blob.type, size: blob.size, head: text }))
            .catch(() => {});
        } catch {}
        return originalCreate(blob);
      };
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          window.__ldfcTopicSaved.push({ download: this.download });
          return;
        }
        return originalClick.call(this);
      };
    })()`
  );
  await clickTopicTool("html");
  await page.waitForTimeout(1200);
  const topicSaved = (await extEval(page, browser, "window.__ldfcTopicSaved")) || [];
  const topicHtml = topicSaved.find((item) => String(item.type || "").includes("text/html"));
  record(
    Boolean(topicHtml) &&
      String(topicHtml.head || "").includes("首楼内容") &&
      !String(topicHtml.head || "").includes("ldfc-reader-actions") &&
      !String(topicHtml.head || "").includes("save-buttons-container"),
    `真实帖子页「保存到本地」产出干净 HTML（${topicHtml?.size ?? 0} 字节）`
  );

  const clickReader = (pool) =>
    page.evaluate((value) => {
      document
        .querySelector(".ldfc-reader-actions-topic")
        .shadowRoot.querySelector(`button[data-pool="${value}"]`)
        .click();
    }, pool);

  // 让 101 从 HOME 开始，保证点「感兴趣」时计数一定 +1
  await extEval(
    page,
    browser,
    `(async () => {
      await window.LDFCTopicState.setPool("101", "HOME");
      window.LDFCNavigation.render();
      return true;
    })()`
  );
  await page.waitForTimeout(200);

  const readCounts = () =>
    page.evaluate(() => {
      const host = document.querySelector(".ldfc-reader-actions-topic");
      const buttons = [...(host?.shadowRoot?.querySelectorAll("button[data-pool]") ?? [])];
      return Object.fromEntries(
        buttons.map((button) => [
          button.dataset.pool,
          {
            label: button.querySelector(".ldfc-action-label")?.textContent ?? "",
            hasIcon: Boolean(button.querySelector(".ldfc-action-icon svg")),
            count: Number(button.querySelector(".ldfc-action-count")?.textContent ?? -1)
          }
        ])
      );
    });

  const poolCounts = () =>
    extEval(
      page,
      browser,
      `({
        INTERESTED: window.LDFCTopicState.listByPool("INTERESTED").length,
        READ: window.LDFCTopicState.listByPool("READ").length,
        DISMISSED: window.LDFCTopicState.listByPool("DISMISSED").length
      })`
    );

  const countsBefore = await readCounts();
  const poolsBefore = await poolCounts();
  record(
    ["INTERESTED", "READ", "DISMISSED"].every((pool) => countsBefore[pool]?.count === poolsBefore[pool]) &&
      ["感兴趣", "已读", "不感兴趣"].every((label, index) =>
        countsBefore[["INTERESTED", "READ", "DISMISSED"][index]]?.label === label
      ),
    `三个按钮显示当前池子数量（${JSON.stringify(
      Object.fromEntries(Object.entries(countsBefore).map(([pool, value]) => [pool, value.count]))
    )}）`
  );

  // 和预览窗 dock 同一套视觉：默认只有图标 + 数字，悬停才旋转展开文字。
  record(
    ["INTERESTED", "READ", "DISMISSED"].every((pool) => countsBefore[pool]?.hasIcon),
    "首楼三个按钮是单色图标（不再是彩色 pill 文字）"
  );
  const readerIconState = () =>
    page.evaluate(() => {
      const button = document
        .querySelector(".ldfc-reader-actions-topic")
        .shadowRoot.querySelector('button[data-pool="INTERESTED"]');
      const icon = button.querySelector(".ldfc-action-icon");
      const label = button.querySelector(".ldfc-action-label");
      return {
        iconTransform: getComputedStyle(icon).transform,
        labelOpacity: Number(getComputedStyle(label).opacity),
        width: Math.round(button.getBoundingClientRect().width)
      };
    });
  const readerRest = await readerIconState();
  // 导航面板固定悬浮，fixture 里正好压住首楼按钮行；这里只测按钮自身的悬停，
  // 先把导航藏起来（不是产品行为，测试专用）。
  await page.evaluate(() => {
    const nav = document.querySelector("#ldfc-navigation");
    if (nav) nav.style.display = "none";
  });
  await page.hover('.ldfc-reader-actions-topic button[data-pool="INTERESTED"]');
  await page.waitForTimeout(560);
  const readerHover = await readerIconState();
  await page.mouse.move(2, 2);
  await page.waitForTimeout(560);
  await page.evaluate(() => {
    const nav = document.querySelector("#ldfc-navigation");
    if (nav) nav.style.display = "";
  });
  record(
    readerRest.labelOpacity === 0 &&
      readerRest.iconTransform === "none" &&
      readerHover.labelOpacity > 0.95 &&
      readerHover.iconTransform !== "none" &&
      readerHover.width > readerRest.width,
    `首楼按钮悬停时图标旋转并横向展开文字（${readerRest.width}px → ${readerHover.width}px）`
  );

  await clickReader("INTERESTED");
  const afterInterested = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("101")`,
    (value) => value?.basePool === "INTERESTED"
  );
  record(afterInterested?.basePool === "INTERESTED", `点「感兴趣」写入 INTERESTED（实际 ${afterInterested?.basePool}）`);

  await page.waitForTimeout(200);
  const countsAfterInterested = await readCounts();
  record(
    countsAfterInterested.INTERESTED?.count === poolsBefore.INTERESTED + 1,
    `标记后按钮数字自动刷新（${poolsBefore.INTERESTED} → ${countsAfterInterested.INTERESTED?.count}）`
  );

  await clickReader("READ");
  const afterRead = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("101")`,
    (value) => value?.basePool === "READ"
  );
  record(afterRead?.basePool === "READ", `点「已读」写入 READ（实际 ${afterRead?.basePool}）`);

  await clickReader("DISMISSED");
  const afterDismissed = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("101")`,
    (value) => value?.basePool === "DISMISSED"
  );
  record(
    afterDismissed?.basePool === "DISMISSED",
    `点「不感兴趣」写入 DISMISSED（实际 ${afterDismissed?.basePool}）`
  );

  // 「已经在哪个池」必须一眼看出来：点亮的是同一枚按钮，所以断言"只有一枚亮"。
  const glowLit = () =>
    page.evaluate(() => {
      const host = document.querySelector(".ldfc-reader-actions-topic");
      return [...(host?.shadowRoot?.querySelectorAll("button[data-pool]") ?? [])]
        .filter((button) => button.classList.contains("is-in-pool"))
        .map((button) => button.dataset.pool);
    });
  const glowDismissed = await glowLit();
  record(
    glowDismissed.length === 1 && glowDismissed[0] === "DISMISSED",
    `首楼按钮点亮「已在池里」（${JSON.stringify(glowDismissed)}）`
  );

  await extEval(
    page,
    browser,
    `(async () => {
       await window.LDFCPoolManager.moveToPool("101", "READ", {});
       await new Promise((resolve) => setTimeout(resolve, 200));
       return 1;
     })()`
  );
  const glowRead = await glowLit();
  record(
    glowRead.length === 1 && glowRead[0] === "READ",
    `换池后只亮新的那一枚（${JSON.stringify(glowRead)}）`
  );
  // 复位：后面弹窗那段要求 101 仍是 DISMISSED（"没有误标到页面上的 Topic"）。
  await extEval(
    page,
    browser,
    `(async () => {
       await window.LDFCPoolManager.moveToPool("101", "DISMISSED", {});
       await new Promise((resolve) => setTimeout(resolve, 150));
       return 1;
     })()`
  );

  console.log("[11b] 二级面板从导航面板位置放大展开");
  // 必须逐帧采样：只看最终态的话，"根本没有动画、直接在右边出现"也会 PASS。
  const sheetAnim = await extEval(
    page,
    browser,
    `(async () => {
      const el = document.querySelector("#ldfc-panel");
      window.LDFCPoolPanel.render("HOME");
      // 收起现在有 360ms 动画，要等它真的落地再做下一次展开采样
      await new Promise((resolve) => setTimeout(resolve, 620));
      const before = { hidden: el.hidden, state: el.dataset.sheetState ?? "" };
      const samples = [];
      window.LDFCPoolPanel.render("INTERESTED");
      const t0 = performance.now();
      // 8 帧 ≈ 408ms，覆盖不到 460ms 的展开动画，末帧会停在 0.99 以下；
      // 12 帧 ≈ 612ms 才能采到真正的终态。采样不够会误报，不是动画的问题。
      for (let i = 0; i < 12; i += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const style = getComputedStyle(el);
        const scale =
          style.transform === "none" ? 1 : new DOMMatrixReadOnly(style.transform).a;
        samples.push({
          t: Math.round(performance.now() - t0),
          scale: Number(scale.toFixed(3)),
          opacity: Number(Number(style.opacity).toFixed(3))
        });
        await new Promise((resolve) => setTimeout(resolve, 35));
      }
      return {
        before,
        samples,
        hidden: el.hidden,
        state: el.dataset.sheetState ?? "",
        origin: getComputedStyle(el).transformOrigin,
        source: (() => {
          const nav = document.querySelector("#ldfc-navigation");
          const fab = nav?.dataset.collapsed === "true";
          const anchor = nav?.querySelector(fab ? ".ldfc-nav-fab" : ".ldfc-nav-panel");
          const rect = anchor?.getBoundingClientRect();
          return rect
            ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
            : null;
        })(),
        sheet: (() => {
          const rect = el.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        })()
      };
    })()`
  );
  await page.waitForTimeout(300);
  const sheetOpen = await page.evaluate(() => {
    const el = document.querySelector("#ldfc-panel");
    const style = getComputedStyle(el);
    return {
      hidden: el.hidden,
      state: el.dataset.sheetState ?? "",
      opacity: Number(style.opacity)
    };
  });
  const minScale = Math.min(...sheetAnim.samples.map((item) => item.scale));
  const maxScale = Math.max(...sheetAnim.samples.map((item) => item.scale));
  record(
    sheetAnim.before.hidden === true &&
      minScale < 0.95 &&
      maxScale >= 0.99 &&
      sheetAnim.origin !== "50% 50%" &&
      sheetAnim.hidden === false &&
      sheetAnim.state === "open",
    `信息池面板从球的位置逐帧放大（scale ${minScale} → ${maxScale}，origin=${sheetAnim.origin}）`
  );
  record(
    sheetOpen.hidden === false && sheetOpen.state === "open" && sheetOpen.opacity === 1,
    `放大结束后停在终态（state=${sheetOpen.state}，opacity=${sheetOpen.opacity}）`
  );

  // 位置：二级面板要贴着一级面板打开，不是钉在屏幕右缘
  const sheetGap =
    sheetAnim.source && sheetAnim.sheet
      ? Math.min(
          Math.abs(sheetAnim.sheet.left - (sheetAnim.source.right + 12)),
          Math.abs(sheetAnim.sheet.right - (sheetAnim.source.left - 12))
        )
      : Number.NaN;
  record(
    Number.isFinite(sheetGap) && sheetGap <= 2.5,
    `二级面板贴着一级面板打开（间距 ${Number.isFinite(sheetGap) ? sheetGap.toFixed(1) : "?"}px，` +
      `面板 left=${Math.round(sheetAnim.sheet?.left ?? -1)}，一级 right=${Math.round(sheetAnim.source?.right ?? -1)}）`
  );

  // 动画速度倍率要真的改到时长上（0.5× → 460ms / 0.5 = 920ms）
  const speedCheck = await extEval(
    page,
    browser,
    `(async () => {
      const el = document.querySelector("#ldfc-panel");
      window.LDFCNavigation.setAnimSpeed(0.5);
      window.LDFCPoolPanel.render("HOME");
      await new Promise((resolve) => setTimeout(resolve, 150));
      window.LDFCPoolPanel.render("INTERESTED");
      const anim = el.getAnimations()[0];
      const out = {
        duration: anim?.effect?.getTiming?.().duration ?? null,
        navDur: getComputedStyle(document.documentElement).getPropertyValue("--ldfc-nav-dur").trim(),
        speed: window.LDFCNavigation.getAnimSpeed()
      };
      window.LDFCNavigation.setAnimSpeed(1);
      window.LDFCPoolPanel.render("HOME");
      await new Promise((resolve) => setTimeout(resolve, 120));
      return out;
    })()`
  );
  record(
    speedCheck.duration === 920 && speedCheck.navDur === "920ms",
    `动画速度 0.5× 时二级面板时长 460 → ${speedCheck.duration}ms（一级面板 ${speedCheck.navDur}）`
  );

  console.log("[11c] 每个信息池面板都自带关闭按钮");
  const poolHeaders = await extEval(
    page,
    browser,
    `(async () => {
      const out = {};
      for (const pool of ["INTERESTED", "NEW_REPLY", "READ", "DISMISSED"]) {
        window.LDFCPoolPanel.render(pool);
        await new Promise((resolve) => setTimeout(resolve, 80));
        const header = document.querySelector("#ldfc-panel .ldfc-panel-header");
        const close = document.querySelector("#ldfc-panel-close");
        out[pool] = {
          header: Boolean(header),
          close: Boolean(close),
          label: close?.getAttribute("aria-label") ?? "",
          title: header?.querySelector("h2")?.textContent ?? "",
          visible: Boolean(close) && close.getBoundingClientRect().width > 0
        };
      }
      return out;
    })()`
  );
  record(
    ["INTERESTED", "NEW_REPLY", "READ", "DISMISSED"].every(
      (pool) =>
        poolHeaders[pool]?.header &&
        poolHeaders[pool]?.close &&
        poolHeaders[pool]?.visible &&
        poolHeaders[pool]?.label === "关闭面板"
    ),
    `四个信息池面板都自带关闭按钮（${Object.values(poolHeaders)
      .map((item) => item.title)
      .join(" / ")}）`
  );

  console.log("[11d] 点 × 关闭：朝球缩回，不是瞬间消失");
  const poolClose = await extEval(
    page,
    browser,
    `(async () => {
      window.LDFCPoolPanel.render("INTERESTED");
      await new Promise((resolve) => setTimeout(resolve, 500));
      const el = document.querySelector("#ldfc-panel");
      const nav = document.querySelector("#ldfc-navigation");
      const anchor =
        nav.dataset.collapsed === "true"
          ? nav.querySelector(".ldfc-nav-fab")
          : nav.querySelector(".ldfc-nav-panel");
      const source = anchor.getBoundingClientRect();
      const rect = el.getBoundingClientRect();
      document.querySelector("#ldfc-panel-close").click();
      const animation = el.getAnimations()[0];
      const frames = animation?.effect?.getKeyframes?.() ?? [];
      return {
        activePool: window.LDFCFilter.getActivePool(),
        state: el.dataset.sheetState ?? "",
        hidden: el.hidden,
        pointerEvents: getComputedStyle(el).pointerEvents,
        duration: animation?.effect?.getTiming?.().duration ?? null,
        from: frames[0]?.transform ?? "",
        to: frames[1]?.transform ?? "",
        expectSx: source.width / rect.width,
        expectSy: source.height / rect.height
      };
    })()`
  );
  const closeScale = (value) => {
    const match = /scale\(\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/.exec(value || "");
    if (!match) return null;
    return { x: Number(match[1]), y: Number(match[2] ?? match[1]) };
  };
  const closeTo = closeScale(poolClose.to);
  record(
    poolClose.activePool === "HOME" &&
      poolClose.state === "closing" &&
      poolClose.hidden === false &&
      poolClose.pointerEvents === "none" &&
      poolClose.duration === 360 &&
      closeTo &&
      Math.abs(closeTo.x - poolClose.expectSx) <= 0.02 &&
      Math.abs(closeTo.y - poolClose.expectSy) <= 0.02,
    `关闭按钮先回主信息流，再用 360ms 缩回球（scale → ${closeTo?.x?.toFixed(2)}×${closeTo?.y?.toFixed(2)}，` +
      `源 ${poolClose.expectSx.toFixed(2)}×${poolClose.expectSy.toFixed(2)}，过程中不拦点击）`
  );
  await page.waitForTimeout(700);
  const sheetClosed = await page.evaluate(() => {
    const el = document.querySelector("#ldfc-panel");
    return { hidden: el.hidden, state: el.dataset.sheetState ?? "" };
  });
  record(
    sheetClosed.hidden && sheetClosed.state === "",
    `收起动画结束才真的隐藏（hidden=${sheetClosed.hidden}，state="${sheetClosed.state}"）`
  );

  console.log("[12/13] 预览弹窗：主贴下方 dock + 工具排");
  await page.evaluate(() => {
    const overlay = document.createElement("div");
    overlay.className = "ldp-overlay";
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;";
    overlay.innerHTML = `<div class="ldp-modal">
        <div class="ldp-header">
          <div style="flex:1"><h2 class="ldp-title">预览中的主题</h2></div>
          <div class="ldp-head-btns"><button class="ldp-close" title="关闭">×</button></div>
        </div>
        <div class="ldp-body" style="max-height:60vh;overflow:auto">
          <div class="ldp-topic">
            <div class="ldp-post" data-post-number="1">
              <div class="ldp-post-head"><span class="ldp-op">OP</span></div>
              <div class="ldp-content"><p>楼主正文</p></div>
            </div>
          </div>
          <div class="ldp-comments-header">评论<span class="ldp-comments-count"></span></div>
          <div class="ldp-comments">
            <div class="ldp-post" data-post-number="2">
              <div class="ldp-post-head"><span class="ldp-author">二楼</span></div>
              <div class="ldp-content"><p>二楼正文</p></div>
            </div>
          </div>
        </div>
        <div class="ldp-footer"><a class="ldp-fbtn ldp-f-open" href="/t/123" target="_blank">打开原贴</a></div>
      </div>`;
    window.__ldfcOverlayClicks = 0;
    window.__ldfcOverlayAnyClicks = 0;
    window.__ldfcModalClosed = 0;
    // 复刻第三方脚本的真实关闭方式：overlay.ldpClose 会做完整清理。
    overlay.ldpClose = () => {
      window.__ldfcModalClosed += 1;
      overlay.remove();
    };
    window.__ldfcCloseButtonClicks = 0;
    overlay.querySelector(".ldp-close").addEventListener("click", () => {
      window.__ldfcCloseButtonClicks += 1;
      overlay.ldpClose();
    });
    overlay.addEventListener("click", (event) => {
      window.__ldfcOverlayAnyClicks += 1;
      // 真实脚本只把「点在遮罩空白处」当成关闭；点在按钮上不算。
      if (event.target === overlay) window.__ldfcOverlayClicks += 1;
    });
    document.body.appendChild(overlay);
  });

  // dock 在 shadow root 里，样式隔离；这里只读计算值，不碰内部结构。
  const dockState = () =>
    page.evaluate(() => {
      const overlay = document.querySelector(".ldp-overlay");
      const body = overlay?.querySelector(".ldp-modal > .ldp-body");
      const host = body?.querySelector(":scope > .ldfc-preview-dock");
      const buttons = host?.shadowRoot
        ? [...host.shadowRoot.querySelectorAll("button[data-pool]")]
        : [];
      const tools = host?.shadowRoot
        ? [...host.shadowRoot.querySelectorAll("button[data-tool]")]
        : [];
      const topic = body?.querySelector(":scope > .ldp-topic");
      const header = body?.querySelector(":scope > .ldp-comments-header");
      const hostRect = host?.getBoundingClientRect();
      const topicRect = topic?.getBoundingClientRect();
      const headerRect = header?.getBoundingClientRect();
      return {
        injected: Boolean(host),
        inBody: Boolean(host && body && host.parentElement === body),
        afterTopic: Boolean(hostRect && topicRect && hostRect.top >= topicRect.bottom - 1),
        beforeComments: Boolean(!headerRect || (hostRect && hostRect.top <= headerRect.top + 1)),
        toolLabels: tools.map((button) => button.textContent.trim()),
        items: buttons.map((button) => {
          const style = getComputedStyle(button);
          const label = button.querySelector(".ldfc-dock-label");
          const icon = button.querySelector(".ldfc-dock-icon");
          return {
            pool: button.dataset.pool,
            width: Math.round(button.getBoundingClientRect().width),
            background: style.backgroundColor,
            labelOpacity: Number(label ? getComputedStyle(label).opacity : 0),
            iconTransform: icon ? getComputedStyle(icon).transform : ""
          };
        })
      };
    });

  await page
    .waitForFunction(
      () => Boolean(document.querySelector(".ldp-overlay .ldp-body > .ldfc-preview-dock")),
      null,
      { timeout: 5000 }
    )
    .catch(() => {});
  // 光效按真实归属点亮，跨轮残留的池状态会让"默认态"看着已经亮了。
  // 断言前先把这条 Topic 归位到主信息流。
  await extEval(
    page,
    browser,
    `(async () => {
       await window.LDFCPoolManager.moveToPool("123", "HOME", {});
       await new Promise((resolve) => setTimeout(resolve, 150));
       return 1;
     })()`
  );
  // 熄灭是一次 220ms 的背景过渡，量"默认态"前要等它落地。
  await page.waitForTimeout(360);
  const dock = await dockState();
  record(
    dock.injected && dock.inBody && dock.items.length === 3,
    `预览弹窗主贴下方注入 dock 三个图标（实际 ${dock.items.length} 个）`
  );
  record(
    dock.afterTopic && dock.beforeComments,
    `dock 落在主贴之后、评论标题之前（主贴后：${dock.afterTopic}，评论前：${dock.beforeComments}）`
  );
  record(
    dock.toolLabels.length === 6 &&
      dock.toolLabels.some((label) => label.includes("查看全部") || label.includes("只看楼主")) &&
      dock.toolLabels.some((label) => label.includes("展开楼中楼")) &&
      dock.toolLabels.some((label) => label.includes("随机跳楼")) &&
      dock.toolLabels.some((label) => label.includes("通知")) &&
      dock.toolLabels.some((label) => label.includes("保存到本地")) &&
      dock.toolLabels.some((label) => label.includes("生成快照")),
    `工具排六个按钮（${dock.toolLabels.join(" / ")}）`
  );
  record(
    dock.items.every((item) => item.background === "rgba(0, 0, 0, 0)" && item.labelOpacity === 0),
    `默认只露出无底色图标（${dock.items
      .map((item) => `${item.pool}:${item.width}px/${item.background}/op${item.labelOpacity}`)
      .join(" / ")}）`
  );

  await page.hover('ldfc-preview-dock button[data-pool="INTERESTED"]');
  await page.waitForTimeout(560);
  const hoveredDock = await dockState();
  const hoveredItem = hoveredDock.items[0] || {};
  record(
    hoveredItem.labelOpacity > 0.95 && hoveredItem.width > 100 && hoveredItem.iconTransform !== "none",
    `悬停后图标旋转并横向展开标签（宽 ${hoveredItem.width}px，标签不透明度 ${hoveredItem.labelOpacity}）`
  );
  await page.mouse.move(2, 2);
  await page.waitForTimeout(560);
  const restedDock = await dockState();
  record(
    (restedDock.items[0]?.labelOpacity ?? 1) === 0 && (restedDock.items[0]?.width ?? 999) < 60,
    `移开鼠标后收回图标（宽 ${restedDock.items[0]?.width}px）`
  );

  // 预览窗「通知」：四档菜单必须挂在 body 下（dock 的入场动画带 fill: both，
  // 会留下 identity transform，fixed 后代留在影子树里会被当成包含块劫持坐标），
  // 点外部要播消失动画再移除。
  await page.evaluate(() => {
    const dock = document.querySelector(".ldfc-preview-dock");
    dock?.shadowRoot?.querySelector('button[data-tool="notify"]')?.click();
  });
  await page.waitForTimeout(500);
  const notifyMenu = await page.evaluate(() => {
    const menu = document.querySelector(".ldfc-notify-menu");
    if (!menu) return { open: false };
    const rect = menu.getBoundingClientRect();
    return {
      open: true,
      inBody: menu.parentElement === document.body,
      inViewport: rect.top >= 0 && rect.bottom <= innerHeight + 1,
      levels: [...menu.querySelectorAll("[data-level]")].map((item) => item.dataset.level)
    };
  });
  record(
    notifyMenu.open &&
      notifyMenu.inBody &&
      notifyMenu.inViewport &&
      notifyMenu.levels.join(",") === "3,2,1,0",
    `预览窗「通知」四档菜单（${notifyMenu.levels?.join("/") ?? "未打开"}，挂 body：${notifyMenu.inBody}，视口内：${notifyMenu.inViewport}）`
  );

  const notifyClose = await page.evaluate(async () => {
    const menu = document.querySelector(".ldfc-notify-menu");
    if (!menu) return { before: false };
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    const animations = menu.getAnimations().length;
    await new Promise((resolve) => setTimeout(resolve, 320));
    return { before: true, animations, removed: !document.querySelector(".ldfc-notify-menu") };
  });
  record(
    notifyClose.before && notifyClose.animations > 0 && notifyClose.removed,
    `通知菜单消失动画（动画 ${notifyClose.animations} 个，320ms 后已移除：${notifyClose.removed}）`
  );

  // 「只看楼主」：隐藏非楼主楼层，再点一次恢复。判据是内联 display，
  // 因为引擎自己的 .ldp-post 规则会盖掉 hidden 属性。
  const onlyOpState = () =>
    page.evaluate(() => {
      const overlay = document.querySelector(".ldp-overlay");
      const posts = [...overlay.querySelectorAll(".ldp-modal .ldp-post")];
      return {
        total: posts.length,
        visible: posts.filter((post) => post.style.display !== "none").length,
        label: overlay
          .querySelector(".ldfc-preview-dock")
          ?.shadowRoot?.querySelector('button[data-tool="op"]')?.textContent
      };
    });
  const onlyOpBefore = await onlyOpState();
  await page.click('ldfc-preview-dock button[data-tool="op"]');
  await page.waitForTimeout(200);
  const onlyOpOn = await onlyOpState();
  await page.click('ldfc-preview-dock button[data-tool="op"]');
  await page.waitForTimeout(200);
  const onlyOpOff = await onlyOpState();
  record(
    onlyOpBefore.visible === onlyOpBefore.total &&
      onlyOpOn.visible === 1 &&
      onlyOpOn.label.includes("只看楼主") &&
      onlyOpOff.visible === onlyOpOff.total &&
      onlyOpOff.label.includes("查看全部"),
    `「只看楼主」切换（${onlyOpBefore.visible}/${onlyOpBefore.total} → ${onlyOpOn.visible}/${onlyOpOn.total} → ${onlyOpOff.visible}/${onlyOpOff.total}）`
  );

  const stacking = await page.evaluate(() => {
    const nav = document.querySelector("#ldfc-navigation");
    const overlay = document.querySelector(".ldp-overlay");
    return {
      nav: Number(getComputedStyle(nav).zIndex),
      overlay: Number(getComputedStyle(overlay).zIndex)
    };
  });
  record(
    stacking.nav > stacking.overlay,
    `导航 z-index ${stacking.nav} > 弹窗 ${stacking.overlay}`
  );

  await page.evaluate(() => {
    document
      .querySelector(".ldp-overlay .ldp-body > .ldfc-preview-dock")
      .shadowRoot.querySelector('button[data-pool="READ"]')
      .click();
  });
  await page.waitForTimeout(200);
  const overlayClicks = await page.evaluate(() => ({
    background: window.__ldfcOverlayClicks,
    any: window.__ldfcOverlayAnyClicks,
    closeButton: window.__ldfcCloseButtonClicks
  }));
  record(
    overlayClicks.background === 0,
    `点击 dock 按钮没有被当成「点背景关闭」（背景点击 ${overlayClicks.background} 次，` +
      `到达弹窗 ${overlayClicks.any} 次）`
  );

  // 关闭动画 260ms：刚点完窗口还在是正常的，等它缩回标题再判断。
  await page.waitForTimeout(420);
  const closed = await page.evaluate(() => ({
    count: window.__ldfcModalClosed,
    present: Boolean(document.querySelector(".ldp-overlay"))
  }));
  record(
    closed.count === 1 && !closed.present,
    `标记成功后自动关闭预览窗口（ldpClose 调用 ${closed.count} 次，弹窗仍在：${closed.present}）`
  );

  const modalTopic = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("123")`,
    (value) => value?.basePool === "READ"
  );
  record(
    modalTopic?.basePool === "READ",
    `弹窗 dock 里点「已读」标的是弹窗内的 Topic 123（实际 ${modalTopic?.basePool}）`
  );
  record(
    (await extEval(page, browser, `window.LDFCTopicState.get("101").basePool`)) === "DISMISSED",
    "弹窗操作没有误标到页面上打开的那个 Topic"
  );

  console.log("[13/13] 点标题由增强阅读引擎出窗：转场、正文、dock、关闭");
  // 夹具里 101~106 才是有楼层的 Topic。上一轮可能把它们全收进了别的池子，
  // 列表里就只剩没有正文的 Fresh 行，预览根本打不开。先把 102 钉回主信息流，
  // 让这一步的前置条件与历史状态无关。
  await extEval(page, browser, `window.LDFCTopicState.setPool("102", "HOME")`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  await page.waitForTimeout(400);

  // 上一轮可能把开关关掉了
  await extEval(page, browser, `window.LDFCPreview.setEnabled(true)`);
  await page.waitForTimeout(150);

  // 列表创建时间：来自行上的 data-created-at，按年龄分三档着色。
  await page
    .waitForFunction(() => document.querySelectorAll(".ldfc-topic-created").length > 0, null, {
      timeout: 5000
    })
    .catch(() => {});
  const createdLabels = await page.evaluate(() => {
    const read = (id) => {
      const row = document.querySelector(`tr.topic-list-item[data-topic-id="${id}"]`);
      const node = row?.querySelector(".ldfc-topic-created");
      return node ? { text: node.textContent.trim(), cls: node.className } : null;
    };
    return { fresh: read("101"), old: read("102"), ancient: read("103") };
  });
  record(
    Boolean(createdLabels.fresh?.cls.includes("is-fresh")) &&
      Boolean(createdLabels.old?.cls.includes("is-old")) &&
      Boolean(createdLabels.ancient?.cls.includes("is-ancient")) &&
      /^\d{2}-\d{2} \d{2}:\d{2}$/.test(createdLabels.fresh?.text || ""),
    `列表显示主题创建时间并按新旧着色（${createdLabels.fresh?.text} / ${createdLabels.old?.text} / ${createdLabels.ancient?.text}）`
  );

  const target = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("tr.topic-list-item[data-topic-id]")];
    // 优先用 101：夹具里它有 2 楼，能同时验到「楼主楼」和「评论楼」。
    const row =
      rows.find((item) => item.dataset.topicId === "101" && item.offsetParent !== null) ||
      rows.find((item) => item.offsetParent !== null);
    const link = row?.querySelector("a.title");
    return link ? { id: row.dataset.topicId, title: link.textContent.trim() } : null;
  });
  record(Boolean(target), `找到可预览的行（Topic ${target?.id ?? "无"}）`);

  // 列表行按钮同样要点亮；改归属走事件，所以不必等观察器的下一拍。
  const rowGlow = await extEval(
    page,
    browser,
    `(async () => {
       const row = [...document.querySelectorAll("tr.topic-list-item")].find(
         (item) => item.offsetParent !== null
       );
       const layer = row?.querySelector(".ldfc-actions");
       if (!layer) return null;
       const id = layer.dataset.ldfcTopic;
       const lit = () =>
         [...layer.querySelectorAll("button[data-pool]")]
           .filter((button) => button.classList.contains("is-in-pool"))
           .map((button) => button.dataset.pool);
       await window.LDFCPoolManager.markInterested({ topicId: id, title: "光效测试", slug: "" });
       await new Promise((resolve) => setTimeout(resolve, 150));
       const on = lit();
       await window.LDFCPoolManager.moveHome(id);
       await new Promise((resolve) => setTimeout(resolve, 150));
       return { id, on, off: lit() };
     })()`
  );
  record(
    rowGlow?.on?.length === 1 && rowGlow.on[0] === "INTERESTED" && rowGlow.off.length === 0,
    `列表行按钮点亮 / 熄灭光效（${JSON.stringify(rowGlow?.on)} → ${JSON.stringify(rowGlow?.off)}）`
  );

  // 预取验证用的请求记录：内容脚本里的 fetch 和页面共用同一个 target，
  // page.on("request") 一样能看到。
  const nestedRequests = [];
  page.on("request", (request) => {
    if (/\/n\/-\/\d+\.json/.test(request.url())) nestedRequests.push(request.url());
  });

  // 列表行悬停按钮与首楼/dock 同一套视觉：默认图标，悬停旋转并横向展开文字。
  const rowButtonState = (id) =>
    page.evaluate((topicId) => {
      const button = document.querySelector(
        `tr.topic-list-item[data-topic-id="${topicId}"] .ldfc-action.interested`
      );
      if (!button) return null;
      const icon = button.querySelector(".ldfc-action-icon");
      const text = button.querySelector(".ldfc-action-text");
      return {
        hasIcon: Boolean(icon?.querySelector("svg")),
        iconTransform: icon ? getComputedStyle(icon).transform : "",
        textOpacity: Number(text ? getComputedStyle(text).opacity : -1),
        width: Math.round(button.getBoundingClientRect().width)
      };
    }, id);
  let rowRest = null;
  let rowHover = null;
  if (target?.id) {
    // 悬停行要落在左侧空白处：fixture 行很窄，落在中间会正好压在右侧按钮上，
    // 那样量到的「默认态」其实已经是展开态。
    await page.hover(`tr.topic-list-item[data-topic-id="${target.id}"]`, {
      position: { x: 20, y: 8 }
    });
    await page.waitForTimeout(300);
    rowRest = await rowButtonState(target.id);
    await page.hover(`tr.topic-list-item[data-topic-id="${target.id}"] .ldfc-action.interested`);
    await page.waitForTimeout(560);
    rowHover = await rowButtonState(target.id);
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
  }
  record(
    rowRest?.hasIcon &&
      rowRest.textOpacity === 0 &&
      rowHover?.textOpacity > 0.95 &&
      rowHover.iconTransform !== "none" &&
      rowHover.width > rowRest.width,
    `列表行按钮也是图标 + 悬停展开（${rowRest?.width}px → ${rowHover?.width}px）`
  );

  // fixture 的行很窄，悬停出现的三个操作按钮会压住标题；先把它们藏起来，
  // 只验证「点标题会不会开预览」。悬停按钮本身在 [11] 已经验过。
  await page.evaluate(() => {
    document.querySelectorAll(".ldfc-actions").forEach((element) => {
      element.style.display = "none";
    });
  });

  // 悬停预取：鼠标停在标题上 90ms 后就应该把嵌套树取回来，
  // 这样点开时命中缓存，省掉一次往返 —— 这是「不是秒开」的主要来源。
  await page.hover(`tr.topic-list-item[data-topic-id="${target.id}"] a.title`);
  await page.waitForTimeout(700);
  const prefetchHits = nestedRequests.filter((url) => url.includes(`/n/-/${target.id}.json`));
  record(
    prefetchHits.length >= 1,
    `悬停标题后预取嵌套树（/n/-/${target.id}.json ${prefetchHits.length} 次）`
  );
  const nestedBeforeClick = nestedRequests.length;

  // 动画跑在插件的隔离世界里，所以钩子必须装在同一个 JS 上下文里；
  // 装到页面主世界是看不到的。动画 460ms 就结束，只能靠钩子记，不能事后取样。
  await extEval(
    page,
    browser,
    `(() => {
    window.__ldfcAnims = [];
    const original = Element.prototype.animate;
    Element.prototype.animate = function (keyframes, options) {
      window.__ldfcAnims.push({
        tag: this.className,
        duration: options?.duration ?? null,
        firstFrame: keyframes?.[0]?.transform ?? ""
      });
      return original.call(this, keyframes, options);
    };
  })()`
  );

  const started = Date.now();
  await page.click(`tr.topic-list-item[data-topic-id="${target.id}"] a.title`, {
    position: { x: 6, y: 6 }
  });
  const openedAt = Date.now() - started;

  const shell = await page
    .waitForFunction(() => Boolean(document.querySelector('.ldp-overlay[data-ldfc-engine="true"]')), null, {
      timeout: 5000
    })
    .then(async () => {
      const info = await page.evaluate(() => {
        const overlay = document.querySelector('.ldp-overlay[data-ldfc-engine="true"]');
        return {
          modal: Boolean(overlay.querySelector(".ldp-modal")),
          legacy: Boolean(document.querySelector("#ldfc-preview"))
        };
      });
      info.anims = (await extEval(page, browser, `window.__ldfcAnims`)) || [];
      return info;
    })
    .catch(() => ({ modal: false, legacy: true, anims: [] }));
  record(
    shell.modal && !shell.legacy,
    `点标题后由增强阅读引擎出窗（${openedAt}ms，没有落回旧版窗口）`
  );
  const flip = shell.anims.find((item) => item.duration === 460) || null;
  // FLIP 的签名：首帧是「缩小 + 平移到标题框」，而不是从透明淡入。
  const flipGrows = Boolean(
    flip && /translate\(/.test(flip.firstFrame) && /scale\(0?\.\d+/.test(flip.firstFrame)
  );
  const openAnim = await extEval(page, browser, `window.__ldfcOpenAnim ?? null`);
  record(
    flipGrows && shell.anims.some((item) => item.duration === 200) && openAnim?.skipped === null,
    `预览窗从标题位置展开（动画 ${shell.anims.map((item) => item.duration).join("/") || "无"}ms，` +
      `首帧 ${flip?.firstFrame || "无"}，起点 ${JSON.stringify(openAnim?.from)}）`
  );

  // 骨架屏和真楼层共用 .ldp-post 之前的占位，等真楼层出现再断言内容
  await page
    .waitForFunction(
      () => Boolean(document.querySelector('.ldp-overlay[data-ldfc-engine="true"] .ldp-topic .ldp-post')),
      null,
      { timeout: 8000 }
    )
    .catch(() => {});
  const loaded = await page.evaluate(() => {
    const overlay = document.querySelector('.ldp-overlay[data-ldfc-engine="true"]');
    const open = overlay?.querySelector(".ldp-f-open");
    let openPath = "";
    try {
      openPath = new URL(open.href, location.origin).pathname;
    } catch {
      openPath = "";
    }
    return {
      title: overlay?.querySelector(".ldp-title")?.textContent?.trim() || "",
      meta: overlay?.querySelector(".ldp-meta")?.textContent?.trim() || "",
      topicPosts: overlay?.querySelectorAll(".ldp-topic .ldp-post").length ?? 0,
      comments: overlay?.querySelectorAll(".ldp-comments .ldp-post").length ?? 0,
      footerHidden: overlay?.querySelector(".ldp-footer")?.hidden ?? true,
      footerButtons: overlay?.querySelectorAll(".ldp-footer .ldp-fbtn").length ?? 0,
      openPath
    };
  });
  record(
    loaded.title === target.title &&
      loaded.topicPosts >= 1 &&
      loaded.comments >= 1 &&
      loaded.footerHidden === false &&
      loaded.footerButtons === 5 &&
      loaded.openPath === `/t/${target.id}`,
    `引擎正文完整（「${loaded.title}」/ meta「${loaded.meta}」/ 楼主楼 ${loaded.topicPosts} / ` +
      `评论 ${loaded.comments} / 底部 ${loaded.footerButtons} 个按钮 / 原贴 ${loaded.openPath}）`
  );
  record(
    nestedRequests.length === nestedBeforeClick,
    `点开时命中预取缓存，没有再发嵌套树请求（点击前 ${nestedBeforeClick} 次，点击后 ${nestedRequests.length} 次）`
  );

  const previewDock = await page.evaluate(() => {
    const overlay = document.querySelector('.ldp-overlay[data-ldfc-engine="true"]');
    const body = overlay?.querySelector(".ldp-modal > .ldp-body");
    const host = body?.querySelector(":scope > .ldfc-preview-dock");
    const topic = body?.querySelector(":scope > .ldp-topic");
    const header = body?.querySelector(":scope > .ldp-comments-header");
    const hostRect = host?.getBoundingClientRect();
    const topicRect = topic?.getBoundingClientRect();
    const headerRect = header?.getBoundingClientRect();
    return {
      present: Boolean(host),
      inBody: Boolean(host && body && host.parentElement === body),
      afterTopic: Boolean(hostRect && topicRect && hostRect.top >= topicRect.bottom - 1),
      beforeComments: Boolean(headerRect && hostRect && hostRect.bottom <= headerRect.top + 1),
      buttons: host?.shadowRoot?.querySelectorAll("button[data-pool]").length ?? 0,
      tools: host?.shadowRoot?.querySelectorAll("button[data-tool]").length ?? 0
    };
  });
  record(
    previewDock.present &&
      previewDock.inBody &&
      previewDock.afterTopic &&
      previewDock.beforeComments &&
      previewDock.buttons === 3 &&
      previewDock.tools === 6,
    `引擎预览窗 dock 在主贴下方（图标 ${previewDock.buttons} 个 / 工具 ${previewDock.tools} 个 / ` +
      `主贴后 ${previewDock.afterTopic} / 评论前 ${previewDock.beforeComments}）`
  );

  const dockCentered = await page.evaluate(() => {
    const host = document.querySelector(".ldp-overlay .ldfc-preview-dock");
    const dock = host?.shadowRoot?.querySelector(".dock");
    const body = document.querySelector(".ldp-overlay .ldp-modal > .ldp-body");
    if (!dock || !body) return null;
    const style = getComputedStyle(body);
    const base = body.getBoundingClientRect();
    const left = base.left + body.clientLeft + parseFloat(style.paddingLeft || 0);
    const right = left + body.clientWidth - parseFloat(style.paddingLeft || 0) - parseFloat(style.paddingRight || 0);
    const rect = dock.getBoundingClientRect();
    return { target: (left + right) / 2, dock: (rect.left + rect.right) / 2 };
  });
  record(
    dockCentered && Math.abs(dockCentered.dock - dockCentered.target) <= 2,
    `预览窗 dock 水平居中（dock ${Math.round(dockCentered?.dock)} / 正文中心 ${Math.round(
      dockCentered?.target
    )}）`
  );

  // 保存按钮：拦 createObjectURL / a.click 取回 Blob 内容做断言。
  // 真实落盘（浏览器下载目录）属于浏览器行为，不在自动化里断言。
  await extEval(
    page,
    browser,
    `(() => {
      window.__ldfcSaved = [];
      const originalCreate = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => {
        try {
          blob.text().then((text) =>
            window.__ldfcSaved.push({ type: blob.type, size: blob.size, head: text.slice(0, 400) })
          ).catch(() => {});
        } catch {}
        return originalCreate(blob);
      };
      const originalClick = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download) {
          window.__ldfcSaved.push({ download: this.download });
          return;
        }
        return originalClick.call(this);
      };
    })()`
  );
  await page.click('ldfc-preview-dock button[data-tool="html"]');
  await page.waitForTimeout(900);
  await page.click('ldfc-preview-dock button[data-tool="snapshot"]');
  await page.waitForTimeout(600);
  await page.click(".ldfc-snap-panel .ldfc-snap-generate");
  await page.waitForTimeout(3000);
  await page.click(".ldfc-snap-result-actions button");
  await page.waitForTimeout(1200);
  const saved = (await extEval(page, browser, `window.__ldfcSaved`)) || [];
  const savedHtml = saved.find((item) => String(item.type || "").includes("text/html"));
  const savedPng = saved.find((item) => item.type === "image/png");
  record(
    Boolean(savedHtml) &&
      /\.html$/.test(saved.find((item) => /\.html$/.test(item.download || ""))?.download || "") &&
      String(savedHtml?.head || "").includes(target.title),
    `「保存到本地」产出 HTML（${savedHtml?.size ?? 0} 字节，标题${String(savedHtml?.head || "").includes(target.title) ? "已写入" : "缺失"}）`
  );
  record(
    Boolean(savedPng) && (savedPng?.size ?? 0) > 1000,
    `「生成快照」产出 PNG（${savedPng?.size ?? 0} 字节）`
  );

  await page.evaluate(() => {
    document
      .querySelector(".ldp-overlay .ldp-body > .ldfc-preview-dock")
      .shadowRoot.querySelector('button[data-pool="READ"]')
      .click();
  });
  await page.waitForTimeout(500);
  const closedAfterMark = await page.evaluate(
    () => !document.querySelector('.ldp-overlay[data-ldfc-engine="true"]')
  );
  const marked = await waitForValue(
    page,
    browser,
    `window.LDFCTopicState.get("${target.id}")`,
    (value) => value?.basePool === "READ"
  );
  record(
    closedAfterMark && marked?.basePool === "READ",
    `引擎预览里点「已读」后自动关窗并写入（pool=${marked?.basePool}）`
  );

  await extEval(page, browser, `window.LDFCPreview.open("${target.id}")`);
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  record(
    await page.evaluate(() => !document.querySelector(".ldp-overlay")),
    "Esc 关闭预览窗口"
  );

  await extEval(page, browser, `window.LDFCPreview.open("${target.id}")`);
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    document.querySelector(".ldp-overlay").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await page.waitForTimeout(250);
  record(
    await page.evaluate(() => !document.querySelector(".ldp-overlay")),
    "点遮罩关闭预览窗口"
  );

  // ---- 按楼层跳转：点带楼层号的链接，预览应定位到那一楼 ----
  // 直接证据是引擎发出了 ?post_number=3，并且渲染的窗口包含 4 楼
  // （默认窗口只有 1、2 楼）。内容很短时 .ldp-body 滚不动，
  // 所以不用 scrollTop 判定。
  const floorRequests = [];
  const onFloorRequest = (request) => {
    if (/\/t\/102\.json\?[^#]*post_number=3(?:&|$)/.test(request.url())) {
      floorRequests.push(request.url());
    }
  };
  page.on("request", onFloorRequest);
  await page.evaluate(() => {
    const link = document.querySelector('tr.topic-list-item[data-topic-id="102"] a.title');
    if (!link) return;
    link.setAttribute("href", "/t/topic/102/3");
    link.click();
  });
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector('.ldp-overlay[data-ldfc-engine="true"] .ldp-post[data-post-number="3"]')
        ),
      null,
      { timeout: 10000 }
    )
    .catch(() => {});
  await page.waitForTimeout(600);
  const floorJump = await page.evaluate(() => {
    const overlay = document.querySelector('.ldp-overlay[data-ldfc-engine="true"]');
    const target = overlay?.querySelector('.ldp-post[data-post-number="3"]');
    return {
      hasTarget: Boolean(target),
      flashed: Boolean(target?.classList.contains("ldp-flash")),
      overlays: document.querySelectorAll(".ldp-overlay").length,
      floors: [...(overlay?.querySelectorAll(".ldp-post[data-post-number]") ?? [])].map(
        (node) => node.dataset.postNumber
      )
    };
  });
  page.off("request", onFloorRequest);
  record(
    floorJump.hasTarget && floorRequests.length >= 1 && floorJump.floors.includes("4"),
    `带楼层号的链接定位到第 3 楼（post_number 请求 ${floorRequests.length} 次，已渲染 ${floorJump.floors.join(",")}，高亮=${floorJump.flashed}）`
  );

  // 快照面板：楼层列表要覆盖预览里已渲染的顶层帖子，默认只勾 1 楼。
  await page.evaluate(() => {
    document
      .querySelector(".ldp-overlay .ldfc-preview-dock")
      ?.shadowRoot?.querySelector('button[data-tool="snapshot"]')
      ?.click();
  });
  await page.waitForTimeout(400);
  const snapPanel = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".ldfc-snap-floor-item input")];
    return {
      floors: items.length,
      checked: items.filter((item) => item.checked).length,
      first: items[0]?.closest("label")?.textContent?.trim().slice(0, 3) ?? ""
    };
  });
  record(
    snapPanel.floors >= 3 && snapPanel.checked === 1 && snapPanel.first.startsWith("#1"),
    `快照面板列出 ${snapPanel.floors} 层并默认只选 1 楼（已选 ${snapPanel.checked}）`
  );
  await page.evaluate(() => document.querySelector(".ldfc-snap-close")?.click());
  await page.waitForTimeout(250);

  // ---- 随机跳楼：只验证提示与楼层变化都落在合法范围内 ----
  const highest = Number(await extEval(page, browser, "window.LDFCEnhancedPreview.highest()"));
  await page.evaluate(() => {
    document
      .querySelector(".ldp-overlay .ldfc-preview-dock")
      ?.shadowRoot?.querySelector('button[data-tool="random"]')
      ?.click();
  });
  await page.waitForTimeout(1500);
  const randomJump = await page.evaluate(() => {
    const overlay = document.querySelector(".ldp-overlay");
    return {
      toast: document.querySelector(".ldfc-toast")?.textContent?.trim() || "",
      floors: [...(overlay?.querySelectorAll(".ldp-post[data-post-number]") ?? [])].map((node) =>
        Number(node.dataset.postNumber)
      )
    };
  });
  record(
    highest > 1 &&
      /跳到第 \d+ 楼/.test(randomJump.toast) &&
      randomJump.floors.every((floor) => floor >= 1 && floor <= highest),
    `随机跳楼（共 ${highest} 层，提示「${randomJump.toast}」，已渲染 ${randomJump.floors.join(",")}）`
  );

  // ---- 展开全部楼中楼：107 的嵌套树只带 1 条直接回复，剩 2 条要点开 ----
  await extEval(page, browser, "window.LDFCPreview.close()");
  await page.waitForTimeout(300);
  await extEval(page, browser, 'window.LDFCPreview.open("907")');
  await page
    .waitForFunction(
      () => Boolean(document.querySelector(".ldp-overlay .ldp-load-more-replies")),
      null,
      { timeout: 10000 }
    )
    .catch(() => {});
  const beforeExpand = await page.evaluate(() => {
    const overlay = document.querySelector(".ldp-overlay");
    const button = overlay?.querySelector(".ldp-load-more-replies");
    return {
      hasButton: Boolean(button),
      buttonText: button?.textContent?.trim() || "",
      posts: [...(overlay?.querySelectorAll(".ldp-post[data-post-number]") ?? [])].map((node) =>
        Number(node.dataset.postNumber)
      )
    };
  });
  await page.evaluate(() => {
    document
      .querySelector(".ldp-overlay .ldfc-preview-dock")
      ?.shadowRoot?.querySelector('button[data-tool="expand"]')
      ?.click();
  });
  await page.waitForTimeout(2500);
  const afterExpand = await page.evaluate(() => {
    const overlay = document.querySelector(".ldp-overlay");
    return {
      posts: [...(overlay?.querySelectorAll(".ldp-post[data-post-number]") ?? [])].map((node) =>
        Number(node.dataset.postNumber)
      ),
      remainingVisible: [...(overlay?.querySelectorAll(".ldp-load-more-replies") ?? [])].some(
        (button) => button.offsetParent !== null
      ),
      toast: document.querySelector(".ldfc-toast")?.textContent?.trim() || ""
    };
  });
  record(
    beforeExpand.hasButton &&
      beforeExpand.posts.includes(3) &&
      !beforeExpand.posts.includes(5) &&
      afterExpand.posts.includes(3) &&
      afterExpand.posts.includes(4) &&
      afterExpand.posts.includes(5) &&
      !afterExpand.remainingVisible,
    `「展开楼中楼」加载剩余回复（${beforeExpand.posts.join(",")} → ${afterExpand.posts.join(",")}，按钮「${beforeExpand.buttonText}」）`
  );
  await extEval(page, browser, "window.LDFCPreview.close()");
  await page.waitForTimeout(300);

  // 引擎缺失时旧自带窗口仍是兜底：临时摘掉引擎全局，确认还能出窗并带 dock。
  // （旧窗口的分页按钮改由这里覆盖，避免删掉原本的「加载更多」回归。）
  const fallback = await extEval(
    page,
    browser,
    `(async () => {
      const saved = window.LDFCEnhancedPreview;
      delete window.LDFCEnhancedPreview;
      window.LDFCPreview.open("102");
      await new Promise((resolve) => setTimeout(resolve, 900));
      const overlay = document.querySelector("#ldfc-preview");
      const info = {
        present: Boolean(overlay),
        dock: Boolean(overlay?.querySelector(".ldp-body > .ldfc-preview-dock")),
        posts: overlay?.querySelectorAll(".ldfc-pv-post:not(.ldfc-pv-skeleton)").length ?? 0,
        moreVisible: overlay ? !overlay.querySelector(".ldfc-pv-more")?.hidden : false
      };
      window.LDFCPreview.close();
      window.LDFCEnhancedPreview = saved;
      return info;
    })()`
  );
  record(
    fallback?.present && fallback.dock && fallback.posts >= 2 && fallback.moreVisible,
    `引擎不可用时旧窗口仍兜底出窗（楼层 ${fallback?.posts}，还有更多：${fallback?.moreVisible}）`
  );
  await page.waitForTimeout(200);

  // 合成 click 也会执行"链接跳转"这个默认动作，所以挂一个兜底监听：
  // 它在我们（document 捕获）之后执行，读到的 defaultPrevented 就是插件的决定。
  const probeClick = (selector, init) =>
    page.evaluate(
      ({ selector: target, init: options }) => {
        const link = document.querySelector(target);
        if (!link) return { missing: true };
        let pluginPrevented = null;
        const guard = (event) => {
          pluginPrevented = event.defaultPrevented;
          event.preventDefault();
        };
        link.addEventListener("click", guard);
        const event = new MouseEvent("click", options);
        link.dispatchEvent(event);
        link.removeEventListener("click", guard);
        return {
          missing: false,
          pluginPrevented,
          overlay: Boolean(document.querySelector(".ldp-overlay"))
        };
      },
      { selector, init }
    );

  const ctrlClick = await probeClick("tr.topic-list-item a.title", {
    bubbles: true,
    cancelable: true,
    ctrlKey: true,
    button: 0
  });
  record(
    !ctrlClick.missing && ctrlClick.pluginPrevented === false && !ctrlClick.overlay,
    "Ctrl+点击不被接管（留给浏览器开新标签页）"
  );

  await extEval(page, browser, `window.LDFCPreview.setEnabled(false)`);
  const disabled = await probeClick("tr.topic-list-item a.title", {
    bubbles: true,
    cancelable: true,
    button: 0
  });
  record(
    !disabled.missing && disabled.pluginPrevented === false && !disabled.overlay,
    "关闭开关后不再拦截点击（交回原站）"
  );

  await extEval(page, browser, `window.LDFCPreview.setEnabled(true)`);
  await page.waitForTimeout(150);

  // 设置面板里的开关：默认开启，改动能落盘
  await extEval(page, browser, `window.LDFCNavigation.open()`);
  await page.waitForTimeout(150);
  await page.evaluate(() => document.querySelector("#ldfc-settings-launch")?.click());
  await page.waitForTimeout(250);
  // 全新 profile 第一次打开设置会先出「首次安装」选择卡，点第一张才进正式设置。
  // 不处理的话，冷启动跑这一整段都会因为找不到控件而失败。
  await page.evaluate(() => document.querySelector(".ldfc-onboarding-card")?.click());
  await page.waitForTimeout(200);
  const toggle = await page.evaluate(() => {
    const input = document.querySelector("#ldfc-preview-toggle");
    return { present: Boolean(input), checked: input?.checked ?? null };
  });
  record(toggle.present && toggle.checked === true, `设置面板有预览开关且默认开启（${toggle.checked}）`);

  // 自动已读的独立通知档位：默认「不修改」，改动能落盘。
  const autoReadBefore = await extEval(
    page,
    browser,
    `window.LDFCNotify.getSettings().autoReadLevel`
  );
  const autoReadSelect = await page.evaluate(() => {
    const select = document.querySelector("#ldfc-notify-auto-read");
    return {
      present: Boolean(select),
      value: select?.value ?? null,
      options: select ? [...select.options].map((option) => option.value) : []
    };
  });
  record(
    autoReadSelect.present &&
      autoReadSelect.value === (autoReadBefore == null ? "" : String(autoReadBefore)) &&
      autoReadSelect.options.join(",") === ",3,2,1,0",
    `设置面板有「自动已读时」通知档位（${autoReadSelect.options.join("/")}，当前 ${autoReadSelect.value || "不修改"}）`
  );

  await page.evaluate(() => {
    const select = document.querySelector("#ldfc-notify-auto-read");
    if (!select) return;
    select.value = "0";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const savedAutoRead = await waitForValue(
    page,
    browser,
    `(async () => {
      const value = await window.LDFCDB.getMeta("notifyLinkage");
      return value?.autoReadLevel ?? null;
    })()`,
    (value) => value === 0
  );
  record(savedAutoRead === 0, `自动已读档位写入本地（autoReadLevel=${savedAutoRead}）`);

  await page.evaluate(() => {
    const select = document.querySelector("#ldfc-notify-auto-read");
    if (!select) return;
    select.value = "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForValue(
    page,
    browser,
    `(async () => {
      const value = await window.LDFCDB.getMeta("notifyLinkage");
      return value?.autoReadLevel ?? null;
    })()`,
    (value) => value === null
  );

  // 自动已读真的走独立映射：读到底 → 只发一次通知 POST，不产生手动标记。
  const autoReadFlow = await extEval(
    page,
    browser,
    `(async () => {
      const topicId = "990001";
      const oldFetch = window.fetch;
      const oldIdentity = window.LDFCIdentity.current;
      const oldSettings = window.LDFCNotify.getSettings();
      const calls = [];
      const meta = document.createElement("meta");
      meta.name = "csrf-token";
      meta.content = "acceptance-csrf";
      document.head.appendChild(meta);
      window.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), body: init.body || "" });
        return { ok: true, status: 200, json: async () => ({}) };
      };
      window.LDFCIdentity.current = () => ({
        loggedIn: true,
        username: "acceptance",
        namespace: "user-42"
      });
      try {
        await window.LDFCDB.deleteTopic(topicId);
        await window.LDFCTopicState.load();
        await window.LDFCTopicState.setPool(topicId, "HOME", { title: "自动已读验收" });
        await window.LDFCTopicState.setNotifyLevel(topicId, 3, false);
        await window.LDFCTopicState.recordVisit(topicId);
        await window.LDFCNotify.setSettings({ linkPools: true, autoReadLevel: 0 });
        const changed = await window.LDFCPoolManager.promotePendingVisits([
          { topicId, lastReadPostNumber: 5, highestPostNumber: 5, unreadPosts: 0 }
        ]);
        const record = window.LDFCTopicState.get(topicId);
        return {
          changed: Array.isArray(changed) ? changed.length : 0,
          basePool: record?.basePool ?? null,
          notifyLevel: record?.notifyLevel ?? null,
          manual: record?.notifyManualLevel ?? null,
          calls
        };
      } finally {
        window.fetch = oldFetch;
        window.LDFCIdentity.current = oldIdentity;
        await window.LDFCDB.deleteTopic(topicId);
        await window.LDFCTopicState.clearVisit(topicId);
        await window.LDFCTopicState.load();
        await window.LDFCNotify.setSettings({
          autoReadLevel: oldSettings.autoReadLevel,
          linkPools: oldSettings.linkPools
        });
        meta.remove();
      }
    })()`
  );
  record(
    autoReadFlow.changed === 1 &&
      autoReadFlow.basePool === "READ" &&
      autoReadFlow.notifyLevel === 0 &&
      autoReadFlow.manual === null &&
      autoReadFlow.calls.some((call) => call.body === "notification_level=0"),
    `自动已读按独立档位改通知（pool=${autoReadFlow.basePool}，level=${autoReadFlow.notifyLevel}，manual=${autoReadFlow.manual}，请求=${autoReadFlow.calls.length}）`
  );

  // 云同步的「?」说明：默认收起，点开是坚果云分步说明，再点收起。
  await page.waitForSelector("#ldfc-sync-help-toggle", { timeout: 5000 }).catch(() => {});
  const syncHelp = await page.evaluate(() => {
    const button = document.querySelector("#ldfc-sync-help-toggle");
    const help = document.querySelector("#ldfc-sync-help");
    return {
      button: Boolean(button),
      hidden: help?.hidden ?? null,
      steps: help?.querySelectorAll(".ldfc-sync-help-step").length ?? 0
    };
  });
  if (syncHelp.button) await page.click("#ldfc-sync-help-toggle");
  const syncHelpOpen = await page.evaluate(() => ({
    hidden: document.querySelector("#ldfc-sync-help")?.hidden,
    expanded: document.querySelector("#ldfc-sync-help-toggle")?.getAttribute("aria-expanded")
  }));
  if (syncHelp.button) await page.click("#ldfc-sync-help-toggle");
  const syncHelpClosed = await page.evaluate(
    () => document.querySelector("#ldfc-sync-help")?.hidden
  );
  record(
    syncHelp.button &&
      syncHelp.hidden === true &&
      syncHelp.steps === 6 &&
      syncHelpOpen.hidden === false &&
      syncHelpOpen.expanded === "true" &&
      syncHelpClosed === true,
    `云同步「?」展开坚果云绑定说明（${syncHelp.steps} 步：默认收起 → 展开 → 收起）`
  );

  // 地址填错要当场提示，不能等用户点「保存配置」才弹 toast。
  const inlineValidation = await page.evaluate(() => {
    const input = document.querySelector("#ldfc-sync-url");
    const error = document.querySelector("#ldfc-sync-url-error");
    if (!input || !error) return { missing: true };
    const wrap = input.closest(".ldfc-sync-field");
    const setValue = (value) => {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const snap = () => ({
      text: error.textContent,
      hidden: error.hidden,
      invalid: input.getAttribute("aria-invalid"),
      wrapper: wrap?.dataset.invalid ?? ""
    });
    setValue("dsfg");
    const bad = snap();
    setValue("https://dav.jianguoyun.com/dav/linuxdo/");
    const good = snap();
    setValue("");
    return { bad, good };
  });
  record(
    inlineValidation.bad?.hidden === false &&
      inlineValidation.bad?.invalid === "true" &&
      inlineValidation.bad?.wrapper === "true" &&
      /http/i.test(inlineValidation.bad?.text ?? ""),
    `地址乱码时输入框下方即时提示（"${inlineValidation.bad?.text ?? ""}"）`
  );
  record(
    inlineValidation.good?.hidden === true &&
      inlineValidation.good?.invalid === null &&
      inlineValidation.good?.wrapper === "",
    "地址改正确后即时提示自动消失"
  );

  // 动画速度滑杆：0.1×（慢 10 倍）~ 2×（快 2 倍），默认 1×
  const animSlider = await page.evaluate(async () => {
    const input = document.querySelector("#ldfc-anim-speed");
    const output = document.querySelector("#ldfc-anim-speed-value");
    if (!input) return { missing: true };
    const attrs = {
      min: input.min,
      max: input.max,
      step: input.step,
      value: input.value
    };
    input.value = "0.5";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 60));
    return {
      attrs,
      label: output?.textContent ?? "",
      root: getComputedStyle(document.documentElement)
        .getPropertyValue("--ldfc-anim-speed")
        .trim()
    };
  });
  record(
    animSlider.attrs?.min === "0.1" &&
      animSlider.attrs?.max === "2" &&
      animSlider.attrs?.step === "0.1" &&
      animSlider.attrs?.value === "1",
    `设置面板有动画速度滑杆（${animSlider.attrs?.min}× ~ ${animSlider.attrs?.max}×，默认 ${animSlider.attrs?.value}×）`
  );
  const savedSpeed = await waitForValue(
    page,
    browser,
    `window.LDFCDB.getMeta("animSpeed")`,
    (value) => value === 0.5
  );
  record(
    savedSpeed === 0.5 && animSlider.label === "0.5×" && Number(animSlider.root) === 0.5,
    `动画速度改动即时生效并落盘（${animSlider.label}，meta=${savedSpeed}）`
  );
  await page.evaluate(() => {
    const input = document.querySelector("#ldfc-anim-speed");
    if (!input) return;
    input.value = "1";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(100);

  // 启动形态：展开的一级面板 / 只有悬浮球（默认仍是一级面板）
  const startModeSwitch = await extEval(
    page,
    browser,
    `(async () => {
      // 前面点设置时鼠标移出了导航，可能已经收起；先展开再采样"默认形态"
      window.LDFCNavigation.open();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const seg = document.querySelector("#ldfc-start-mode");
      const buttons = seg ? [...seg.querySelectorAll("button")] : [];
      const fabButton = buttons.find((item) => item.dataset.mode === "fab");
      const panelButton = buttons.find((item) => item.dataset.mode === "panel");
      if (!fabButton || !panelButton) return { missing: true };
      const nav = () => document.querySelector("#ldfc-navigation");
      const initial = {
        pressed: panelButton.getAttribute("aria-pressed"),
        mode: window.LDFCNavigation.getStartMode(),
        collapsed: nav().dataset.collapsed
      };
      fabButton.click();
      const afterFab = {
        mode: window.LDFCNavigation.getStartMode(),
        meta: await window.LDFCDB.getMeta("navStartMode"),
        collapsed: nav().dataset.collapsed,
        pressed: fabButton.getAttribute("aria-pressed")
      };
      panelButton.click();
      const afterPanel = {
        mode: window.LDFCNavigation.getStartMode(),
        meta: await window.LDFCDB.getMeta("navStartMode"),
        collapsed: nav().dataset.collapsed,
        pressed: panelButton.getAttribute("aria-pressed")
      };
      return {
        options: buttons.map((item) => item.textContent.trim()),
        initial,
        afterFab,
        afterPanel
      };
    })()`
  );
  record(
    JSON.stringify(startModeSwitch.options ?? []) === JSON.stringify(["一级面板", "悬浮球"]) &&
      startModeSwitch.initial?.mode === "panel" &&
      startModeSwitch.initial?.collapsed === "false" &&
      startModeSwitch.initial?.pressed === "true",
    `设置里有「启动时显示」二选一，默认一级面板（${JSON.stringify(startModeSwitch.options ?? [])}）`
  );
  record(
    startModeSwitch.afterFab?.mode === "fab" &&
      startModeSwitch.afterFab?.meta === "fab" &&
      startModeSwitch.afterFab?.collapsed === "true" &&
      startModeSwitch.afterFab?.pressed === "true" &&
      startModeSwitch.afterPanel?.mode === "panel" &&
      startModeSwitch.afterPanel?.meta === "panel" &&
      startModeSwitch.afterPanel?.collapsed === "false",
    `切换「悬浮球 / 一级面板」立即生效并落盘（fab→${startModeSwitch.afterFab?.meta}，panel→${startModeSwitch.afterPanel?.meta}）`
  );

  await page.evaluate(() => {
    const input = document.querySelector("#ldfc-preview-toggle");
    input.checked = false;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const savedToggle = await waitForValue(
    page,
    browser,
    `window.LDFCDB.getMeta("previewEnabled")`,
    (value) => value === false
  );
  record(savedToggle === false, `关掉开关后写入本地（previewEnabled=${savedToggle}）`);

  await page.evaluate(() => {
    const input = document.querySelector("#ldfc-preview-toggle");
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(200);

  // 设置面板的 × 也要有收起动画：一下消失会让人以为点错了。
  const settingsClose = await page.evaluate(() => {
    const el = document.querySelector("#ldfc-settings");
    const button = document.querySelector("#ldfc-settings-close");
    if (!el || !button) return { missing: true };
    button.click();
    const animation = el.getAnimations()[0];
    const frames = animation?.effect?.getKeyframes?.() ?? [];
    return {
      state: el.dataset.sheetState ?? "",
      hidden: el.hidden,
      duration: animation?.effect?.getTiming?.().duration ?? null,
      to: frames[1]?.transform ?? ""
    };
  });
  await page.waitForTimeout(700);
  const settingsClosed = await page.evaluate(() => {
    const el = document.querySelector("#ldfc-settings");
    return { hidden: el.hidden, state: el.dataset.sheetState ?? "" };
  });
  record(
    !settingsClose.missing &&
      settingsClose.state === "closing" &&
      settingsClose.hidden === false &&
      settingsClose.duration === 360 &&
      /scale\(/.test(settingsClose.to) &&
      settingsClosed.hidden &&
      settingsClosed.state === "",
    `设置面板关闭同样走 360ms 收回动画（${settingsClose.to || "无动画"} → hidden=${settingsClosed.hidden}）`
  );

  // 「点开 → 点收 → 之后再点」不能退化成"每次只播收起动画"。
  const settingsCycle = [];
  for (let round = 1; round <= 2; round += 1) {
    await page.evaluate(() => document.getElementById("ldfc-settings-launch")?.click());
    await page.waitForTimeout(650);
    settingsCycle.push(
      await page.evaluate(() => {
        const panel = document.getElementById("ldfc-settings");
        return { hidden: panel.hidden, state: panel.dataset.sheetState ?? "" };
      })
    );
    await page.evaluate(() => document.getElementById("ldfc-settings-close")?.click());
    await page.waitForTimeout(650);
    settingsCycle.push(
      await page.evaluate(() => {
        const panel = document.getElementById("ldfc-settings");
        return { hidden: panel.hidden, state: panel.dataset.sheetState ?? "" };
      })
    );
  }
  record(
    settingsCycle.every((item, index) =>
      index % 2 === 0
        ? item.hidden === false && item.state === "open"
        : item.hidden === true && item.state === ""
    ),
    `设置面板连续两轮开合都按操作逻辑走（${JSON.stringify(settingsCycle)}）`
  );

  // 收起动画进行中再点：应该重新展开，不能卡在 closing / 再叠一层收起。
  await page.evaluate(() => document.getElementById("ldfc-settings-launch")?.click());
  await page.waitForTimeout(600);
  await page.evaluate(() => document.getElementById("ldfc-settings-close")?.click());
  await page.waitForTimeout(120);
  const midClose = await page.evaluate(() => {
    const panel = document.getElementById("ldfc-settings");
    return { hidden: panel.hidden, state: panel.dataset.sheetState ?? "" };
  });
  await page.evaluate(() => document.getElementById("ldfc-settings-launch")?.click());
  await page.waitForTimeout(700);
  const settingsReopened = await page.evaluate(() => {
    const panel = document.getElementById("ldfc-settings");
    return { hidden: panel.hidden, state: panel.dataset.sheetState ?? "" };
  });
  record(
    midClose.state === "closing" &&
      settingsReopened.hidden === false &&
      settingsReopened.state === "open",
    `收起动画中途再点改为重新展开（${midClose.state || "无"} → ${settingsReopened.state || "无"}）`
  );
  // 收尾：关掉设置，别影响后面的预览用例
  await page.evaluate(() => document.getElementById("ldfc-settings-close")?.click());
  await page.waitForTimeout(700);

  // 启动形态要真的在下次加载时生效，而不是只在设置里改个值。
  await extEval(page, browser, `window.LDFCNavigation.setStartMode("fab")`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  await page.waitForTimeout(300);
  const startPersistFab = await page.evaluate(() => ({
    collapsed: document.querySelector("#ldfc-navigation")?.dataset.collapsed ?? "",
    panelHidden:
      document.querySelector("#ldfc-navigation .ldfc-nav-panel")?.getAttribute("aria-hidden") ?? ""
  }));
  record(
    startPersistFab.collapsed === "true" && startPersistFab.panelHidden === "true",
    `选「悬浮球」后刷新只剩球（collapsed=${startPersistFab.collapsed}）`
  );

  await extEval(page, browser, `window.LDFCNavigation.setStartMode("panel")`);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  await page.waitForTimeout(300);
  const startPersistPanel = await page.evaluate(
    () => document.querySelector("#ldfc-navigation")?.dataset.collapsed ?? ""
  );
  record(
    startPersistPanel === "false",
    `切回「一级面板」后刷新恢复展开（collapsed=${startPersistPanel}）`
  );

  // 搜索页是"用户主动检索"，按既有规则不接管
  await page.goto(new URL("/search?q=Probe", url).href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  const searchClick = await probeClick('.fps-result a[href*="/t/"]', {
    bubbles: true,
    cancelable: true,
    button: 0
  });
  record(
    searchClick.missing || (searchClick.pluginPrevented === false && !searchClick.overlay),
    "搜索结果页不接管点击（保持原站行为）"
  );

  // 搜索卡片的 data-topic-id 常在内层标题容器上（宽度=内容），
  // 按钮层必须挂到整宽卡片并统一右对齐，不能随标题长度左右跑。
  const searchAlign = await extEval(
    page,
    browser,
    `(async () => {
       const host = document.querySelector("#main-outlet") || document.body;
       document.getElementById("ldfc-search-align-fixture")?.remove();
       const wrap = document.createElement("div");
       wrap.id = "ldfc-search-align-fixture";
       wrap.innerHTML = [
         '<div class="fps-result">',
         '  <div class="fps-topic" data-topic-id="901" style="display:inline-block"><a href="/t/topic/901">短标题</a></div>',
         '  <p class="blurb">短摘要</p>',
         '</div>',
         '<div class="fps-result">',
         '  <div class="fps-topic" data-topic-id="902" style="display:inline-block"><a href="/t/topic/902">这是一个非常非常非常长的搜索标题，用来验证按钮不会跟着文字长度左右移动</a></div>',
         '  <p class="blurb">另一段更长的摘要，把卡片撑得更高</p>',
         '</div>'
       ].join("");
       host.appendChild(wrap);
       window.LDFCContent.decorateRows();
       await new Promise((resolve) => setTimeout(resolve, 200));
       const rows = [...wrap.querySelectorAll(".fps-result")].map((card) => {
         const layer = card.querySelector(".ldfc-actions");
         // 按钮默认 display:none（悬停才显示），不手动显示就量不到尺寸
         if (layer) layer.style.display = "inline-flex";
         const cardRect = card.getBoundingClientRect();
         const layerRect = layer ? layer.getBoundingClientRect() : null;
         return {
           cardRight: Math.round(cardRect.right),
           cardWidth: Math.round(cardRect.width),
           layerRight: layerRect ? Math.round(layerRect.right) : null,
           innerRight: Math.round(card.querySelector(".fps-topic").getBoundingClientRect().right),
           layerHost: layer?.parentElement?.className ?? ""
         };
       });
       wrap.remove();
       return rows;
     })()`
  );
  record(
    Array.isArray(searchAlign) &&
      searchAlign.length === 2 &&
      searchAlign.every((row) => row.layerRight !== null) &&
      searchAlign.every((row) => row.layerHost.includes("fps-result")) &&
      Math.abs(searchAlign[0].layerRight - searchAlign[1].layerRight) <= 1 &&
      searchAlign.every((row) => Math.abs(row.cardRight - row.layerRight - 12) <= 1),
    `搜索卡片按钮统一挂在行尾右对齐（${JSON.stringify(searchAlign)}）`
  );

  // 搜索是用户主动检索：**任何**当前池下都不能把结果藏掉，只允许亮光效。
  // 曾经多了一个 activePool === "HOME" 的前提，用户在搜索页点过池子之后
  // 搜索结果就按池子被过滤，"池子里的帖子搜不到"。
  const searchPoolState = await extEval(
    page,
    browser,
    `(async () => {
       const host = document.querySelector("#main-outlet") || document.body;
       document.getElementById("ldfc-search-pool-fixture")?.remove();
       const wrap = document.createElement("div");
       wrap.id = "ldfc-search-pool-fixture";
       wrap.innerHTML = [
         '<div class="fps-result"><div class="fps-topic" data-topic-id="911"><a href="/t/topic/911">池内标题</a></div></div>',
         '<div class="fps-result"><div class="fps-topic" data-topic-id="912"><a href="/t/topic/912">主信息流标题</a></div></div>'
       ].join("");
       host.appendChild(wrap);
       await window.LDFCPoolManager.markDismissed({ topicId: "911", title: "池内标题" });
       window.LDFCFilter.setActivePool("DISMISSED");
       window.LDFCContent.decorateRows();
       await new Promise((resolve) => setTimeout(resolve, 300));
       const cards = [...wrap.querySelectorAll(".fps-result")].map((card) => ({
         topicId: card.querySelector(".fps-topic")?.dataset.topicId ?? "",
         hidden: card.classList.contains("ldfc-row-hidden") || getComputedStyle(card).display === "none",
         lit: Boolean(card.querySelector(".ldfc-action.is-in-pool"))
       }));
       wrap.remove();
       window.LDFCFilter.setActivePool("HOME");
       await window.LDFCPoolManager.moveHome("911");
       return cards;
     })()`
  );
  record(
    Array.isArray(searchPoolState) &&
      searchPoolState.length === 2 &&
      searchPoolState.every((card) => card.hidden === false) &&
      searchPoolState.find((card) => card.topicId === "911")?.lit === true &&
      searchPoolState.find((card) => card.topicId === "912")?.lit === false,
    `搜索页不过滤任何池子、只亮光效（${JSON.stringify(searchPoolState)}）`
  );

  // 帖子页的 #topic 容器也带 data-topic-id：它绝不能被当成"一行"装饰，
  // 否则按钮组按 top:50% 定位，会飘到页面中部 / 标题旁边。
  await page.goto(new URL("/t/topic/101", url).href, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#ldfc-navigation", { timeout: 20000 });
  // 注意：这些全局都挂在**隔离世界**，必须走 extEval，page.evaluate 看不到。
  const topicShellState = await extEval(
    page,
    browser,
    `(async () => {
       document.getElementById("ldfc-topic-shell-fixture")?.remove();
       const shell = document.createElement("div");
       shell.id = "topic";
       shell.setAttribute("data-topic-id", "888");
       shell.innerHTML =
         '<div class="topic-title"><a href="/t/topic/888">帖子页标题</a></div>' +
         '<div style="height:600px"></div>';
       (document.querySelector("#main-outlet") || document.body).appendChild(shell);
       window.LDFCContent.decorateRows();
       await new Promise((resolve) => setTimeout(resolve, 250));
       const result = {
         shellButtons: shell.querySelectorAll(".ldfc-actions").length,
         shellDecorated: shell.classList.contains("ldfc-topic-row")
       };
       shell.remove();
       return result;
     })()`
  );
  record(
    topicShellState.shellButtons === 0 && topicShellState.shellDecorated === false,
    `帖子页容器不会被当成列表行（#topic 内按钮数=${topicShellState.shellButtons}）`
  );

  console.log("[收尾] 清理测试 DOM 与状态");
  await page.evaluate(() => {
    document.querySelector(".ldp-overlay")?.remove();
    document.querySelector("#post_1")?.remove();
  });
  // 预览测试会真的写一条 READ 记录：还回主信息流，避免污染下一轮的计数
  if (target?.id) {
    await extEval(page, browser, `window.LDFCPoolManager.moveHome("${target.id}")`);
    await extEval(page, browser, `window.LDFCNavigation.render()`);
  }
  await extEval(page, browser, `window.LDFCPreview.setEnabled(true)`);
  await extEval(page, browser, `window.LDFCDB.putMeta("navUiState", {})`);
  record(extensionErrors.length === 0, `插件自身没有报错${extensionErrors.length ? "：" + extensionErrors.slice(0, 3).join(" | ") : ""}`);

  process.exit(report() ? 1 : 0);
}

main().catch((error) => {
  console.error("UI 验收脚本异常：", error.message);
  report();
  process.exit(1);
});
