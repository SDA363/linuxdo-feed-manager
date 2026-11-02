"use strict";

// browser-lab CLI —— 让 Codex 可以稳定地操作浏览器（含加载未打包插件）。
//
// 背景：Chrome 137 起官方禁用了 --load-extension 命令行开关，
// 所以这里改用 CDP（浏览器调试协议）的 Extensions.loadUnpacked 命令加载插件，
// 并且浏览器以独立进程常驻，Codex 可以反复连接操作同一个浏览器。
//
// 用法示例：
//   node browser.js start --ext "D:/path/to/extension" --url "https://example.com"
//   node browser.js status
//   node browser.js eval "document.title"
//   node browser.js eval --ext "Object.keys(window).filter(k => k.startsWith('LDFC'))"
//   node browser.js shot out.png --full
//   node browser.js click ".some-button"
//   node browser.js stop

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const LAB_DIR = __dirname;
const STATE_FILE = path.join(LAB_DIR, ".browser-lab.state.json");

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
    // 忽略：找不到 Codex 运行时目录时走下面的兜底查找
  }
  candidates.push("playwright");

  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // 试下一个候选路径
    }
  }

  throw new Error("找不到 Playwright 模块；可设置 PLAYWRIGHT_MODULE 指向 playwright 目录");
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error("找不到 Chrome 或 Edge 可执行文件");
}

function setFlag(flags, name, value) {
  if (flags[name] === undefined) {
    flags[name] = value;
  } else if (Array.isArray(flags[name])) {
    flags[name].push(value);
  } else {
    flags[name] = [flags[name], value];
  }
}

const BOOLEAN_FLAGS = new Set(["headed", "full", "ext-world", "help"]);

function parseArgs(argv) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const name = token.slice(2);
      if (BOOLEAN_FLAGS.has(name)) {
        setFlag(flags, name, true);
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        setFlag(flags, name, true);
      } else {
        setFlag(flags, name, next);
        index += 1;
      }
    } else {
      positionals.push(token);
    }
  }

  return { flags, positionals };
}

function configOf(flags) {
  const port = Number(flags.port || process.env.BROWSER_LAB_PORT || 9222);
  // 必须绝对路径：Chrome 的 --user-data-dir 按自身工作目录解析相对路径，
  // 传相对值会静静地在别处建目录，然后启动超时。
  const profile = path.resolve(
    flags.profile || process.env.BROWSER_LAB_PROFILE || path.join(LAB_DIR, ".chrome-lab-profile")
  );
  return { port, profile, endpoint: `http://127.0.0.1:${port}` };
}

async function browserVersion(endpoint) {
  try {
    const response = await fetch(`${endpoint}/json/version`);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

async function waitFor(callback, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

function normalizeList(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function outputAndExit(text, code = 0) {
  const target = code === 0 ? process.stdout : process.stderr;
  target.write(text.endsWith("\n") ? text : `${text}\n`, () => process.exit(code));
}

function fail(error) {
  outputAndExit(`ERROR: ${error && error.message ? error.message : String(error)}`, 1);
}

// 注意：对 connectOverCDP 得到的 browser 不能调用 browser.close()，
// 否则会把用户正在使用的浏览器一起关掉。直接退出进程即可。
function detachAndExit(text, code = 0) {
  outputAndExit(text, code);
}

async function connect(endpoint) {
  const { chromium } = loadPlaywright();
  return chromium.connectOverCDP(endpoint);
}

function firstPage(browser) {
  const context = browser.contexts()[0];
  if (!context) throw new Error("浏览器里没有可用的上下文（context）");
  const pages = context.pages();
  if (!pages.length) throw new Error("浏览器里没有打开的页面");
  return pages[0];
}

async function extensionWorldContext(page, browser) {
  const context = browser.contexts()[0];
  const session = await context.newCDPSession(page);
  const seen = [];
  session.on("Runtime.executionContextCreated", (event) => seen.push(event.context));
  await session.send("Runtime.enable");
  await new Promise((resolve) => setTimeout(resolve, 200));

  const target = seen.find((item) => (item.origin || "").startsWith("chrome-extension://"));
  if (!target) throw new Error("没找到插件的隔离世界（extension isolated world）");
  return { session, contextId: target.id };
}

async function evaluate(page, browser, expression, { inExtensionWorld = false } = {}) {
  const wrapped = `(async () => {
    const value = await (${expression});
    if (value === undefined) return "undefined";
    try { return JSON.parse(JSON.stringify(value)); } catch { return String(value); }
  })()`;

  if (!inExtensionWorld) {
    return page.evaluate(wrapped);
  }

  const { session, contextId } = await extensionWorldContext(page, browser);
  const result = await session.send("Runtime.evaluate", {
    expression: wrapped,
    contextId,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || "在插件世界里执行失败");
  }
  return result.result.value;
}

async function commandStart(flags) {
  const { port, profile, endpoint } = configOf(flags);
  const extensions = normalizeList(flags.ext).map((item) => path.resolve(String(item)));
  const url = typeof flags.url === "string" ? flags.url : null;

  let version = await browserVersion(endpoint);
  let launched = false;

  if (!version) {
    const chromePath = findChrome();
    fs.mkdirSync(profile, { recursive: true });

    const args = [
      "--remote-debugging-port=" + port,
      "--enable-unsafe-extension-debugging",
      "--user-data-dir=" + profile,
      // 下面这批参数来自 Playwright 启动 Chrome 的标准参数集，
      // 其中 --no-sandbox 用于避免浏览器自带沙箱与 Codex 沙箱冲突导致 GPU 进程崩溃。
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-field-trial-config",
      "--disable-background-networking",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-back-forward-cache",
      "--disable-breakpad",
      "--disable-client-side-phishing-detection",
      "--disable-component-extensions-with-background-pages",
      "--disable-component-update",
      "--disable-dev-shm-usage",
      "--no-default-browser-check",
      "--disable-default-apps",
      "--disable-features=AcceptCHFrame,AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,Translate,AutoDeElevate,RenderDocument,OptimizationHints",
      "--allow-pre-commit-input",
      "--disable-hang-monitor",
      "--disable-ipc-flooding-protection",
      "--disable-popup-blocking",
      "--disable-prompt-on-repost",
      "--disable-renderer-backgrounding",
      "--force-color-profile=srgb",
      "--metrics-recording-only",
      "--no-first-run",
      "--password-store=basic",
      "--use-mock-keychain",
      "--no-service-autorun",
      "--export-tagged-pdf",
      "--disable-search-engine-choice-screen",
      "--unsafely-disable-devtools-self-xss-warnings",
      "--disable-sync",
      "--disable-infobars",
      "--window-size=1440,900",
      "about:blank"
    ];

    if (flags.headed) {
      args.unshift("--new-window");
    } else {
      args.unshift("--headless=new", "--hide-scrollbars", "--mute-audio");
    }

    const logFd = fs.openSync(path.join(LAB_DIR, ".chrome-lab.log"), "a");
    const child = spawn(chromePath, args, {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      // 注意：有头模式必须关闭 windowsHide，否则 Chrome 的第一个窗口会被隐藏
      windowsHide: !flags.headed
    });
    fs.closeSync(logFd);
    child.unref();
    launched = true;

    version = await waitFor(() => browserVersion(endpoint), 20000, 300);
    if (!version) throw new Error(`浏览器启动超时：端口 ${port} 未就绪`);
  }

  const browser = await connect(endpoint);
  const session = await browser.newBrowserCDPSession();

  const loadedExtensions = [];
  for (const extensionPath of extensions) {
    try {
      const result = await session.send("Extensions.loadUnpacked", { path: extensionPath });
      loadedExtensions.push({ path: extensionPath, id: result.id });
    } catch (error) {
      loadedExtensions.push({ path: extensionPath, error: error.message });
    }
  }

  const context = browser.contexts()[0];
  let page = context.pages().find((candidate) => candidate.url() === "about:blank") || context.pages()[0];
  if (!page) page = await context.newPage();
  if (url) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 }).catch((error) => {
      loadedExtensions.push({ navigationError: `${url}: ${error.message}` });
    });
  }

  const state = {
    launched,
    endpoint,
    profile,
    browser: version.Browser,
    loadedExtensions,
    page: { url: page.url(), title: await page.title().catch(() => "") }
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
  detachAndExit(JSON.stringify(state, null, 2));
}

async function commandStop(flags) {
  const { endpoint } = configOf(flags);
  const version = await browserVersion(endpoint);
  if (!version) {
    detachAndExit(JSON.stringify({ stopped: false, reason: "浏览器没有在运行" }, null, 2));
    return;
  }
  const browser = await connect(endpoint);
  const session = await browser.newBrowserCDPSession();
  await session.send("Browser.close");
  detachAndExit(JSON.stringify({ stopped: true }, null, 2));
}

async function commandStatus(flags) {
  const { endpoint, port, profile } = configOf(flags);
  const version = await browserVersion(endpoint);
  if (!version) {
    detachAndExit(JSON.stringify({ running: false, endpoint, port, profile }, null, 2), 1);
    return;
  }
  const list = await (await fetch(`${endpoint}/json/list`)).json();
  const pages = list
    .filter((item) => item.type === "page")
    .map((item) => ({ id: item.id, url: item.url, title: item.title }));
  detachAndExit(
    JSON.stringify({ running: true, endpoint, browser: version.Browser, profile, pages }, null, 2)
  );
}

async function withPage(flags, callback) {
  const { endpoint } = configOf(flags);
  const version = await browserVersion(endpoint);
  if (!version) throw new Error(`浏览器没有在运行（${endpoint}）。先执行 start 命令。`);
  const browser = await connect(endpoint);
  const page = firstPage(browser);
  const result = await callback(page, browser);
  detachAndExit(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

async function commandOpen(flags, positionals) {
  const url = positionals[0];
  if (!url) throw new Error("缺少要打开的网址");
  await withPage(flags, async (page) => {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    return { url: page.url(), title: await page.title() };
  });
}

async function commandEval(flags, positionals) {
  const expression = positionals.join(" ");
  if (!expression) throw new Error("缺少要执行的表达式");
  const inExtensionWorld = Boolean(flags["ext-world"]);
  await withPage(flags, async (page, browser) => {
    const value = await evaluate(page, browser, expression, { inExtensionWorld });
    return { inExtensionWorld, value };
  });
}

async function commandShot(flags, positionals) {
  const file = path.resolve(positionals[0] || path.join(LAB_DIR, `shot-${Date.now()}.png`));
  await withPage(flags, async (page) => {
    await page.screenshot({ path: file, fullPage: Boolean(flags.full) });
    return { saved: file, url: page.url() };
  });
}

async function commandClick(flags, positionals) {
  const selector = positionals[0];
  if (!selector) throw new Error("缺少选择器（selector）");
  await withPage(flags, async (page) => {
    await page.click(selector, { timeout: Number(flags.timeout || 15000) });
    await page.waitForTimeout(400);
    return { clicked: selector, url: page.url(), title: await page.title() };
  });
}

async function commandFill(flags, positionals) {
  const [selector, ...rest] = positionals;
  if (!selector) throw new Error("缺少选择器（selector）");
  const value = rest.join(" ");
  await withPage(flags, async (page) => {
    await page.fill(selector, value, { timeout: Number(flags.timeout || 15000) });
    return { filled: selector, value };
  });
}

async function commandWait(flags, positionals) {
  const selector = positionals[0];
  if (!selector) throw new Error("缺少选择器（selector）");
  await withPage(flags, async (page) => {
    await page.waitForSelector(selector, { timeout: Number(flags.timeout || 20000) });
    return { appeared: selector };
  });
}

async function commandDom(flags) {
  await withPage(flags, async (page) =>
    page.evaluate(() => {
      const elements = [];
      for (const element of document.querySelectorAll("a,button,input,select,textarea,[role=button]")) {
        const text = (element.innerText || element.value || element.getAttribute("aria-label") || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 70);
        if (!text) continue;
        elements.push({
          tag: element.tagName.toLowerCase(),
          id: element.id || undefined,
          class: typeof element.className === "string" ? element.className.slice(0, 70) : undefined,
          text
        });
        if (elements.length >= 150) break;
      }
      return { url: location.href, title: document.title, count: elements.length, elements };
    })
  );
}

async function commandTabs(flags) {
  await withPage(flags, async (page, browser) => {
    const context = browser.contexts()[0];
    return {
      active: page.url(),
      tabs: context.pages().map((item, index) => ({ index, url: item.url() }))
    };
  });
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positionals } = parseArgs(rest);

  if (!command || command === "help" || flags.help) {
    outputAndExit(
      [
        "browser-lab 命令：",
        "  start   [--ext <dir> ...] [--url <url>] [--headed] [--port 9222] [--profile <dir>]",
        "  stop",
        "  status",
        "  open    <url>",
        "  eval    <表达式> [--ext-world]  # --ext-world 表示在插件隔离世界中执行",
        "  shot    [文件] [--full]",
        "  click   <选择器>",
        "  fill    <选择器> <内容>",
        "  wait    <选择器>",
        "  dom",
        "  tabs"
      ].join("\n")
    );
    return;
  }

  switch (command) {
    case "start":
      await commandStart(flags);
      return;
    case "stop":
      await commandStop(flags);
      return;
    case "status":
      await commandStatus(flags);
      return;
    case "open":
      await commandOpen(flags, positionals);
      return;
    case "eval":
      await commandEval(flags, positionals);
      return;
    case "shot":
      await commandShot(flags, positionals);
      return;
    case "click":
      await commandClick(flags, positionals);
      return;
    case "fill":
      await commandFill(flags, positionals);
      return;
    case "wait":
      await commandWait(flags, positionals);
      return;
    case "dom":
      await commandDom(flags);
      return;
    case "tabs":
      await commandTabs(flags);
      return;
    default:
      throw new Error(`未知命令：${command}`);
  }
}

main().catch(fail);
