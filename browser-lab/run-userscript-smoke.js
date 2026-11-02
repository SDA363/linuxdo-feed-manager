"use strict";

// 油猴脚本模式的冒烟验收（V1.1 阶段 1 的最小切片）。
//
// 和 run-ldfc-acceptance.js 的区别：油猴脚本跑在页面主世界（没有隔离世界），
// 所以这里所有断言都直接用 page.evaluate，不需要 CDP 的
// Extensions.loadUnpacked / ext-world eval。
//
// 云同步有两条后端：扩展后台 / GM_xmlhttpRequest。前者的验收在
// run-sync-acceptance.js；这里补后者 —— 用页面主世界的桩函数模拟
// @grant GM_xmlhttpRequest，只验证"判据 + UI 分支 + 请求真的发出去"。
// 真实 Tampermonkey 沙箱与真实坚果云不在此环境内（报告里必须标 NOT TESTED）。
//
// 前提：
//   node probe-server.js
//   node browser.js start --url "http://127.0.0.1:8123/"      # 不加载扩展
//
// 用法：node run-userscript-smoke.js [--url <页面地址>] [--port 9222]

const fs = require("node:fs");
const path = require("node:path");

const LAB_DIR = __dirname;
const USERSCRIPT = path.join(LAB_DIR, "..", "dist", "ldfc.user.js");
const DEFAULT_URL = "http://127.0.0.1:8123/";

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

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--url") flags.url = argv[(index += 1)];
    else if (token === "--port") flags.port = Number(argv[(index += 1)]);
  }
  return flags;
}

(async () => {
  if (!fs.existsSync(USERSCRIPT)) {
    throw new Error(`还没有生成油猴脚本：${USERSCRIPT}（先跑 node build-userscript.js）`);
  }

  const flags = parseArgs(process.argv.slice(2));
  const url = flags.url || DEFAULT_URL;
  const port = flags.port || 9222;

  const { chromium } = loadPlaywright();
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  // 必须用独立 context：addInitScript 会常驻 context，
  // 若复用扩展所在的 context，脚本会被注入到扩展页面上，
  // 同时污染后续验收（双重注入）。
  const context = await browser.newContext();
  const page = await context.newPage();

  // 油猴脚本的 @run-at document-start 对应 addInitScript：
  // 每次导航前注入，刷新后行为一致。
  await context.addInitScript({ path: USERSCRIPT });

  // fixture 的账号/登录/未读是服务端内存状态，必须显式钉住，否则上一轮残留会串。
  await page.goto(new URL("/__set?user=42&login=1&unread=1", url).href, { waitUntil: "domcontentloaded" });
  await page.goto(url, { waitUntil: "domcontentloaded" });

  await page.waitForSelector("#ldfc-navigation", { timeout: 15000 });
  await page.waitForTimeout(1200);

  // 清空上一轮本地数据（fixture 专用 profile，不涉及真实站点）。
  await page.evaluate(async () => {
    await window.LDFCDB.clearTopics();
    await window.LDFCTopicState.clearVisits();
    await window.LDFCTopicState.load();
    window.LDFCContent.decorateRows();
  });
  await page.waitForTimeout(400);

  const injected = await page.evaluate(() => ({
    pools: [...document.querySelectorAll("#ldfc-navigation button[data-pool]")].map((b) => b.dataset.pool),
    hasSettings: !!document.querySelector("#ldfc-settings-launch"),
    hasStyle: !!document.querySelector("#ldfc-styles")
  }));
  record(
    injected.pools.length === 5 && injected.hasSettings && injected.hasStyle,
    `油猴脚本注入成功（五区入口 ${injected.pools.length} 个：${injected.pools.join("/")}；设置按钮=${injected.hasSettings}；样式=${injected.hasStyle}）`
  );

  const decorated = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")];
    return {
      rows: rows.length,
      withActions: rows.filter((row) => row.querySelector(".ldfc-actions")).length
    };
  });
  record(
    decorated.rows > 0 && decorated.withActions === decorated.rows,
    `每行都挂上操作按钮：${decorated.withActions}/${decorated.rows}`
  );

  const targetId = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".topic-list-item[data-topic-id]")].find(
      (candidate) => candidate.offsetParent !== null
    );
    return row?.dataset.topicId ?? null;
  });
  record(!!targetId, `找到可操作的行（topicId=${targetId}）`);

  if (targetId) {
    await page.locator(`.topic-list-item[data-topic-id="${targetId}"]`).hover();
    await page.waitForTimeout(250);
    await page.locator(`.topic-list-item[data-topic-id="${targetId}"] .ldfc-action.interested`).click();
    await page.waitForTimeout(900);

    const marked = await page.evaluate((id) => {
      const row = document.querySelector(`.topic-list-item[data-topic-id="${id}"]`);
      return {
        pool: window.LDFCTopicState.get(id)?.basePool ?? null,
        hidden: row ? getComputedStyle(row).display === "none" : true
      };
    }, targetId);
    record(
      marked.pool === "INTERESTED" && marked.hidden,
      `点「感兴趣」后进入感兴趣池且行被隐藏（pool=${marked.pool}，hidden=${marked.hidden}）`
    );

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#ldfc-navigation", { timeout: 15000 });
    await page.waitForTimeout(1200);

    const afterReload = await page.evaluate((id) => {
      const row = document.querySelector(`.topic-list-item[data-topic-id="${id}"]`);
      return {
        pool: window.LDFCTopicState.get(id)?.basePool ?? null,
        hidden: row ? getComputedStyle(row).display === "none" : true
      };
    }, targetId);
    record(
      afterReload.pool === "INTERESTED" && afterReload.hidden,
      `刷新后状态保留（pool=${afterReload.pool}，hidden=${afterReload.hidden}）`
    );
  }

  // 长按多选也必须能在油猴版用：手机端 Tampermonkey 是主要分发形态。
  const multiIds = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".topic-list-item[data-topic-id]")]
      .filter((row) => row.offsetParent !== null)
      .slice(0, 2);
    rows[0]?.querySelector(".ldfc-actions")?.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse", button: 0 })
    );
    return rows.map((row) => row.dataset.topicId);
  });
  await page.waitForTimeout(700);
  const multiEntered = await page.evaluate(() =>
    document.documentElement.classList.contains("ldfc-selecting")
  );
  record(
    multiEntered,
    `油猴版长按按钮组进入多选（可用行 ${multiIds.length} 个：${JSON.stringify(multiIds)}）`
  );

  if (multiEntered) {
    // enter() 后 400ms 内的点击会被忽略（防长按松手那次 click 误选）
    await page.waitForTimeout(600);
    await page.evaluate((ids) => {
      for (const id of ids) {
        document.querySelector(`.topic-list-item[data-topic-id="${id}"] .ldfc-actions`)?.click();
      }
    }, multiIds);
    await page.waitForTimeout(200);
    const picked = await page.evaluate(() => ({
      badge: document.querySelector("#ldfc-navigation .ldfc-select-count")?.textContent ?? "",
      rows: document.querySelectorAll(".ldfc-selected").length
    }));
    await page.evaluate(() =>
      document.querySelector('#ldfc-navigation .ldfc-nav-items button[data-pool="READ"]')?.click()
    );
    await page.waitForTimeout(500);
    // 多选态点导航池子只提示、不批量移入（投放统一改为拖拽）
    const afterNav = await page.evaluate(
      (ids) => ({
        pools: ids.map((id) => window.LDFCTopicState.get(id)?.basePool ?? null),
        selecting: document.documentElement.classList.contains("ldfc-selecting")
      }),
      multiIds
    );

    // 拖拽投放：按住第一枚胶囊 → 移到「已读」格 → 松手
    await page.evaluate(() => {
      const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
      const rect = layer.getBoundingClientRect();
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        pointerType: "mouse",
        button: 0,
        pointerId: 9,
        isPrimary: true,
        buttons: 1
      };
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      layer.dispatchEvent(new PointerEvent("pointerdown", { ...base, clientX: cx, clientY: cy }));
      layer.dispatchEvent(new PointerEvent("pointermove", { ...base, clientX: cx, clientY: cy - 24 }));
    });
    await page.waitForTimeout(120);
    await page.evaluate(() => {
      const layer = document.querySelector(".topic-list-item[data-topic-id] .ldfc-actions");
      const panel = document.querySelector(".ldfc-drop");
      const read = panel?.querySelector('.ldfc-drop-item[data-pool="READ"]');
      const dx = Number.parseFloat(read?.style.getPropertyValue("--dx") ?? "0");
      const dy = Number.parseFloat(read?.style.getPropertyValue("--dy") ?? "0");
      const cx = Number.parseFloat(panel?.style.left ?? "0");
      const cy = Number.parseFloat(panel?.style.top ?? "0");
      const base = {
        bubbles: true,
        cancelable: true,
        view: window,
        pointerType: "mouse",
        button: 0,
        pointerId: 9,
        isPrimary: true
      };
      layer.dispatchEvent(
        new PointerEvent("pointermove", { ...base, buttons: 1, clientX: cx + dx, clientY: cy + dy })
      );
      layer.dispatchEvent(new PointerEvent("pointerup", base));
    });
    await page.waitForTimeout(900);
    const batch = await page.evaluate((ids) => ({
      pools: ids.map((id) => window.LDFCTopicState.get(id)?.basePool ?? null),
      exited: !document.documentElement.classList.contains("ldfc-selecting")
    }), multiIds);
    record(
      picked.rows === 2 &&
        picked.badge === "已选 2" &&
        afterNav.selecting &&
        // 这两条可能从没被记录过（undefined），只要没被导航移走即可
        afterNav.pools.every((pool) => pool === null || pool === "HOME") &&
        batch.pools.length === 2 &&
        batch.pools.every((pool) => pool === "READ") &&
        batch.exited,
      `油猴版拖拽投放批量移入（${picked.badge} → ${JSON.stringify(batch.pools)}，导航后=${JSON.stringify(
        afterNav
      )}，已退出=${batch.exited}）`
    );
    // 复位：不让这轮批量操作污染后面的预览用例
    await page.evaluate(async (ids) => {
      for (const id of ids) await window.LDFCPoolManager.moveHome(id);
      window.LDFCContent.decorateRows();
    }, multiIds);
    await page.waitForTimeout(300);
  }

  // 油猴版是最接近移动端的分发形态：它在 document-start 注入、和页面同世界，
  // 和扩展的 document_idle + 隔离世界不一样，所以预览引擎要单独验一次。
  const previewId = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".topic-list-item[data-topic-id]")].find(
      (candidate) => candidate.offsetParent !== null
    );
    return row?.dataset.topicId ?? null;
  });

  let preview = { overlay: false };
  if (previewId) {
    await page.evaluate(() => {
      // 行很窄，悬停按钮会压住标题；只验「点标题开预览」，按钮本身上一项已验过。
      document.querySelectorAll(".ldfc-actions").forEach((element) => {
        element.style.display = "none";
      });
    });
    await page.click(`.topic-list-item[data-topic-id="${previewId}"] a.title`, {
      position: { x: 6, y: 6 }
    });
    await page.waitForTimeout(1500);
    preview = await page.evaluate(() => {
      const overlay = document.querySelector(".ldp-overlay");
      return {
        overlay: Boolean(overlay),
        engine: overlay?.dataset.ldfcEngine ?? null,
        title: overlay?.querySelector(".ldp-title")?.textContent?.trim() ?? "",
        posts: overlay?.querySelectorAll(".ldp-topic .ldp-post").length ?? 0,
        dock:
          overlay?.querySelector(".ldp-body > .ldfc-preview-dock")?.shadowRoot
            ?.querySelectorAll("button[data-pool]").length ?? 0,
        // 油猴模式和扩展共用同一份 launcher；工具排能出来就说明
        // 新增的保存 / 只看楼主 / 展开楼中楼没有依赖扩展专属 API。
        tools:
          overlay?.querySelector(".ldp-body > .ldfc-preview-dock")?.shadowRoot
            ?.querySelectorAll("button[data-tool]").length ?? 0
      };
    });
  }
  record(
    preview.engine === "true" && preview.posts >= 1 && preview.dock === 3,
    `油猴版点标题弹出引擎预览（Topic ${previewId}，标题「${preview.title}」，` +
      `楼主楼 ${preview.posts}，dock ${preview.dock} 个图标）`
  );
  record(
    preview.tools === 6,
    `油猴版预览窗工具排 ${preview.tools} 个按钮（含通知级别 / 只看楼主 / 展开楼中楼 / 随机跳楼 / 两种保存）`
  );
  await page.evaluate(() => window.LDFCPreview?.close?.());

  // ---- 设置面板：油猴环境下必须明确降级，而不是假装能用 ----
  await page.evaluate(() => document.querySelector("#ldfc-settings-launch")?.click());
  await page.waitForTimeout(800);
  // 该账号库首次打开设置时是「首次安装」向导，先选 A 完成初始化，
  // 否则看到的是向导而不是设置项（扩展端验收里已单独覆盖向导）。
  await page.evaluate(() => document.querySelector("#ldfc-settings .ldfc-onboarding-card")?.click());
  await page.waitForTimeout(900);
  const settings = await page.evaluate(() => {
    const panel = document.querySelector("#ldfc-settings");
    const sync = panel?.querySelector("#ldfc-sync-settings");
    return {
      open: Boolean(panel) && getComputedStyle(panel).display !== "none",
      close: Boolean(panel?.querySelector("#ldfc-settings-close")),
      syncHost: Boolean(sync),
      syncText: (sync?.textContent ?? "").replace(/\s+/g, " ").trim(),
      autoRead: Boolean(panel?.querySelector("#ldfc-notify-auto-read")),
      previewToggle: Boolean(panel?.querySelector("#ldfc-preview-toggle")),
      ids: panel ? [...panel.querySelectorAll("[id]")].map((element) => element.id).slice(0, 20) : []
    };
  });
  record(
    settings.open && settings.close,
    `油猴版设置面板可打开（关闭按钮=${settings.close}）`
  );
  record(
    settings.syncHost && /没有扩展后台|无法跨域/.test(settings.syncText),
    `油猴版云同步明确降级（「${settings.syncText.slice(0, 28)}…」）`
  );
  record(
    settings.autoRead && settings.previewToggle,
    `油猴版设置含预览开关与「自动已读时」档位（${settings.previewToggle} / ${settings.autoRead}；实际 id：${settings.ids.join(",")}）`
  );
  await page.evaluate(() => document.querySelector("#ldfc-settings-close")?.click());
  await page.waitForTimeout(500);

  // ---- 信息池面板：四个池子都要能渲染出来 ----
  await page.evaluate(() => {
    const button = document.querySelector('#ldfc-navigation button[data-pool="INTERESTED"]');
    button?.click();
  });
  await page.waitForTimeout(700);
  const poolPanel = await page.evaluate(() => {
    const panel = document.querySelector("#ldfc-panel");
    return {
      open: Boolean(panel) && getComputedStyle(panel).display !== "none",
      close: Boolean(panel?.querySelector("#ldfc-panel-close")),
      rows: panel?.querySelectorAll(".ldfc-panel-item").length ?? 0,
      title: (panel?.querySelector(".ldfc-panel-title")?.textContent ?? "").trim()
    };
  });
  record(
    poolPanel.open && poolPanel.close,
    `油猴版信息池面板可打开（关闭按钮=${poolPanel.close}，标题「${poolPanel.title}」）`
  );
  record(
    poolPanel.rows >= 1,
    `油猴版池内能看到已标记记录（${poolPanel.rows} 行）`
  );

  // ---- GM 后端：有 GM_xmlhttpRequest 时必须渲染可用表单，而不是降级说明 ----
  const gmContext = await browser.newContext();
  try {
    await gmContext.addInitScript(() => {
      window.__gmCalls = [];
      window.GM_xmlhttpRequest = (options) => {
        window.__gmCalls.push({
          method: options.method,
          url: options.url,
          hasAuth: Boolean(options.headers?.Authorization),
          dataLength: options.data?.byteLength ?? null
        });
        setTimeout(() => {
          options.onload({ status: 404, responseHeaders: "", response: new ArrayBuffer(0) });
        }, 5);
      };
    });
    await gmContext.addInitScript({ path: USERSCRIPT });

    const gmPage = await gmContext.newPage();
    await gmPage.goto(url, { waitUntil: "domcontentloaded" });
    await gmPage.waitForSelector("#ldfc-navigation", { timeout: 15000 });
    await gmPage.waitForTimeout(900);
    await gmPage.evaluate(() => document.querySelector("#ldfc-settings-launch")?.click());
    await gmPage.waitForTimeout(800);
    await gmPage.evaluate(() =>
      document.querySelector("#ldfc-settings .ldfc-onboarding-card")?.click()
    );
    await gmPage.waitForTimeout(900);

    const gmForm = await gmPage.evaluate(() => {
      const panel = document.querySelector("#ldfc-settings");
      const fill = (id, value) => {
        const input = panel?.querySelector(`#${id}`);
        if (!input) return;
        input.value = value;
        input.dispatchEvent(new Event("input", { bubbles: true }));
      };
      fill("ldfc-sync-url", "https://dav.example.com/dav/");
      fill("ldfc-sync-username", "alice@example.com");
      fill("ldfc-sync-password", "app-password");
      return {
        backend: window.LDFCWebDAV?.backend?.() ?? "none",
        hasForm: Boolean(panel?.querySelector("#ldfc-sync-url")),
        hasAuthorize: Boolean(panel?.querySelector("#ldfc-sync-authorize")),
        degraded: /没有扩展后台/.test(
          panel?.querySelector("#ldfc-sync-settings")?.textContent ?? ""
        )
      };
    });
    record(
      gmForm.backend === "gm" && gmForm.hasForm && !gmForm.degraded,
      `油猴 + GM_xmlhttpRequest：渲染可用表单而不是降级说明（backend=${gmForm.backend}）`
    );

    // 「测试连接」内部会走 saveConfig → checkPermission → transport.test，
    // 顺便把权限行刷新出来，所以先点按钮再读状态。
    await gmPage.evaluate(() => document.querySelector("#ldfc-sync-test")?.click());
    await gmPage.waitForTimeout(1200);
    const gmPermission = await gmPage.evaluate(() =>
      (document.querySelector("#ldfc-sync-permission")?.textContent ?? "").trim()
    );
    record(
      !gmForm.hasAuthorize && /无需授权/.test(gmPermission),
      `油猴 + GM：隐藏「授权访问此域名」，权限行「${gmPermission}」`
    );

    const gmCalls = await gmPage.evaluate(() => window.__gmCalls ?? []);
    record(
      gmCalls.length >= 1 &&
        gmCalls[0].method === "GET" &&
        /dav\.example\.com/.test(gmCalls[0].url) &&
        gmCalls[0].hasAuth,
      `油猴 + GM：点「测试连接」真的走 GM_xmlhttpRequest（${gmCalls
        .map((call) => `${call.method} ${call.url}`)
        .join(" | ")}）`
    );
  } finally {
    await gmContext.close();
  }

  console.log("\n===== 油猴脚本冒烟验收 =====");
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(`\n汇总：${results.length - failed} 项通过，${failed} 项失败`);

  await context.close();
  await browser.close();
  process.exit(failed === 0 ? 0 : 1);
})().catch((error) => {
  console.error("冒烟验收失败：", error);
  process.exit(1);
});
