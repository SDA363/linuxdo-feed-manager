const { chromium } = require("C:/Users/asddn/AppData/Local/OpenAI/Codex/runtimes/cua_node/a708e72b10c27b59/bin/node_modules/playwright");

const extensionPath = "D:/桌面/codex/linuxdo插件/linuxdo-personal-feed-manager";
const userDataDir = "D:/桌面/codex/linuxdo插件/.ldfc-acceptance-profile";
const proxy = process.env.LDFC_PROXY;

async function run() {
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chrome",
    headless: false,
    viewport: null,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ],
    proxy: proxy ? { server: proxy } : undefined
  });

  const page = context.pages()[0] ?? await context.newPage();
  await page.goto("https://linux.do/latest", { waitUntil: "domcontentloaded" }).catch((error) => {
    console.error(`打开页面失败：${error.message}`);
  });

  console.log("请在打开的 Chrome 里完成 GitHub 登录。登录成功后关闭这个浏览器窗口。");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
