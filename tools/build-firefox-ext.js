"use strict";

// 生成 Firefox / Firefox Android 版扩展工作区。
//
// 为什么用"生成"而不是"手工维护一份副本"：
//   Chrome 版与 Firefox 版的**唯一差异**就是 manifest 里的 browser_specific_settings。
//   手工维护两份源码会出现"改了一边忘了另一边"的漂移，
//   而且无法保证两个交付物行为一致。
//   所以这里以 linuxdo-personal-feed-manager/ 为**唯一源码**，
//   每次按需生成 mobile-firefox/，并强制校验"差异只有 manifest"。
//
// 安全边界：
//   - 绝不写 linuxdo-personal-feed-manager/（Chrome v1.0.0 封版源码）
//   - 生成前清空目标目录（避免残留旧文件混进 Firefox 包）
//
// 用法：
//   node tools/build-firefox-ext.js              # 生成 mobile-firefox/
//   node tools/build-firefox-ext.js --zip        # 生成并打包成 AMO 可上传的 ZIP

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "linuxdo-personal-feed-manager");
const OUT_DIR = path.join(ROOT, "mobile-firefox");
const DIST_DIR = path.join(ROOT, "dist");

// ---- Firefox 侧的差异（唯一定义处）----

// gecko.id 一旦用于 AMO 签名就**永久固定**，后续版本必须沿用同一个 ID。
// 改成别的值会被 AMO 视为另一个扩展，导致无法更新。
const GECKO_ID = "linuxdo-feed-manager@ldfc.local";

// 最低版本 = 128.0，**已定案，不提高到 142**。
//
// 为什么是 128：`content_scripts.world: "MAIN"` 需要 Firefox 128（MDN BCD），
// 这是本扩展在 Firefox 上的**实际功能门槛**。
//
// 为什么明知道会有 linter 警告也不提到 142：
//   `data_collection_permissions` 是 Firefox 140（Android 142）才引入的
//   "内建数据收集同意界面"能力。**"字段存在"与"浏览器原生支持该字段的 UI"是两件事**：
//   - 低版本 Firefox 会忽略这个未知字段，没有实际后果
//     （本扩展不收集任何数据，忽略声明 ≠ 违规收集）
//   - AMO 的要求是"提交的扩展必须声明该字段"，与运行时版本无关
//   - 提到 142 会**收窄兼容范围**，把 128–141 的用户挡在外面，只为消除一条警告
//
// 因此 linter 的 `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` 与
// `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION` 两条属于
// **兼容性警告，不作为阻塞项**，保留并在报告里解释。
const MIN_VERSION = "128.0";

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

function buildManifest(sourceManifest) {
  const manifest = JSON.parse(JSON.stringify(sourceManifest));

  const existing = manifest.browser_specific_settings ?? {};

  manifest.browser_specific_settings = {
    gecko: {
      id: GECKO_ID,
      strict_min_version: MIN_VERSION,
      // AMO 自 2025-11-03 起对新提交强制要求声明数据收集。
      // 本扩展不收集任何数据（与产品规格"隐私"一节一致），所以如实填 none。
      data_collection_permissions: { required: ["none"] },
      ...(existing.gecko ?? {})
    },
    gecko_android: {
      strict_min_version: MIN_VERSION,
      ...(existing.gecko_android ?? {})
    }
  };

  return manifest;
}

function main() {
  const withZip = process.argv.includes("--zip");

  if (!fs.existsSync(SRC_DIR)) throw new Error(`找不到源码目录：${SRC_DIR}`);

  // ---- 1. 清空并重建输出目录 ----
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // ---- 2. 复制源码（逐文件，保持结构）----
  const sourceFiles = listFiles(SRC_DIR);
  for (const relative of sourceFiles) {
    const from = path.join(SRC_DIR, relative);
    const to = path.join(OUT_DIR, relative);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }

  // ---- 3. 只改 manifest ----
  const sourceManifestPath = path.join(SRC_DIR, "manifest.json");
  const outManifestPath = path.join(OUT_DIR, "manifest.json");
  const sourceManifest = JSON.parse(fs.readFileSync(sourceManifestPath, "utf8"));
  const firefoxManifest = buildManifest(sourceManifest);
  fs.writeFileSync(outManifestPath, JSON.stringify(firefoxManifest, null, 2) + "\n");

  // ---- 4. 强制校验：与源码的差异必须**只有** manifest.json ----
  const differing = [];
  for (const relative of sourceFiles) {
    const a = fs.readFileSync(path.join(SRC_DIR, relative));
    const b = fs.readFileSync(path.join(OUT_DIR, relative));
    if (!a.equals(b)) differing.push(relative);
  }
  const onlyManifestDiffers = differing.length === 1 && differing[0] === "manifest.json";

  // ---- 5. 输出 ----
  const result = {
    source: path.relative(ROOT, SRC_DIR).split(path.sep).join("/"),
    output: path.relative(ROOT, OUT_DIR).split(path.sep).join("/"),
    fileCount: sourceFiles.length,
    geckoId: GECKO_ID,
    minVersion: MIN_VERSION,
    onlyManifestDiffers,
    differingFiles: differing,
    // 顺便确认 Chrome 侧的版本未被改动
    chromeVersion: sourceManifest.version,
    firefoxVersion: firefoxManifest.version
  };

  if (!onlyManifestDiffers) {
    console.error("❌ 差异校验失败：除 manifest.json 外还有文件不同 →", differing);
    process.exit(1);
  }
  if (sourceManifest.version !== firefoxManifest.version) {
    console.error("❌ 版本号被意外改动");
    process.exit(1);
  }

  // ---- 6. 可选打包 ----
  if (withZip) {
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const zipName = `linuxdo-feed-manager-firefox-${firefoxManifest.version}.zip`;
    const zipPath = path.join(DIST_DIR, zipName);

    // 打包要点：**manifest.json 必须在 ZIP 根**（AMO 上传要求），
    // 且条目名不能带 "./" 前缀 —— 所以用显式顶层条目列表，不用 "."。
    //
    // 用 Windows 自带的 bsdtar（System32\tar.exe）：
    //   - 它支持 -a 按扩展名自动选 zip 格式
    //   - 对中文路径（本机是 D:\桌面\...）处理正常
    //   - 注意：必须传**正斜杠**路径，反斜杠会被它当成转义
    const BSdtar = "C:/Windows/System32/tar.exe";
    fs.rmSync(zipPath, { force: true });
    const topLevel = fs.readdirSync(OUT_DIR);
    execFileSync(BSdtar, [
      "-a", "-c", "-f", zipPath.split(path.sep).join("/"),
      "-C", OUT_DIR.split(path.sep).join("/"),
      ...topLevel
    ], { stdio: "pipe" });

    result.zip = {
      path: path.relative(ROOT, zipPath).split(path.sep).join("/"),
      bytes: fs.statSync(zipPath).size,
      topLevelEntries: topLevel.length,
      note: "manifest.json 位于 ZIP 根（无 ./ 前缀、无外层目录），可直接上传 AMO"
    };
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
