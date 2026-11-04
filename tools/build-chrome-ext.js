"use strict";

// 打包 Chrome / Edge 扩展（MV3）：dist/linuxdo-feed-manager-chrome-<version>.zip
//
// 为什么需要这个脚本：
//   1.1.3 之前 Chrome 包一直是**手工**打的（见 docs 里的封版记录），发版时要重复敲 tar，
//   而且踩过两个坑——新增文件忘了加、manifest 被打进外层目录
//   （后者会让"加载已解压的扩展程序"直接报 "Manifest file is missing or unreadable"）。
//
// 与 build-firefox-ext.js 的分工：
//   Firefox 需要一个独立工作区（改 manifest 加 browser_specific_settings），
//   所以那边是"复制源码 → 改 manifest → 校验差异只有 manifest → 打包"；
//   Chrome 源码目录**本身就是**可加载的扩展，不需要副本，直接按同一套打包规格出包：
//     - 顶层条目（没有外层目录）
//     - manifest.json 位于 ZIP 根、无 "./" 前缀
//   打包器沿用 bsdtar（C:\Windows\System32\tar.exe），与 firefox 脚本一致：
//   支持 -a 自动选格式，且对中文路径（本机 D:\桌面\...）处理正常。
//
// 安全边界：
//   - 只读 linuxdo-personal-feed-manager/，只写 dist/
//
// 用法：
//   node tools/build-chrome-ext.js

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "linuxdo-personal-feed-manager");
const DIST_DIR = path.join(ROOT, "dist");
const TAR = "C:/Windows/System32/tar.exe";

// manifest 里不会出现、但运行期会被打开的页面（permissions.html 由扩展自己
// 用 runtime.getURL 打开来申请可选域名权限）。缺一个不会报错，只会静默打不开，
// 所以单独纳入校验。
const EXTRA_REQUIRED = ["permissions.html", "permissions.js", "permissions.css"];

function listFiles(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, base));
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out.sort();
}

function collectManifestRefs(manifest) {
  const refs = [];
  if (manifest.background && manifest.background.service_worker) {
    refs.push(manifest.background.service_worker);
  }
  if (manifest.options_ui && manifest.options_ui.page) refs.push(manifest.options_ui.page);
  if (manifest.options_page) refs.push(manifest.options_page);
  if (manifest.action && manifest.action.default_popup) refs.push(manifest.action.default_popup);
  for (const icon of Object.values(manifest.icons || {})) refs.push(icon);
  for (const entry of manifest.content_scripts || []) {
    refs.push(...(entry.js || []), ...(entry.css || []));
  }
  for (const entry of manifest.web_accessible_resources || []) {
    for (const resource of entry.resources || []) {
      // 通配符（如 "assets/*"）无法逐文件校验，交给"源码文件全部进包"这条兜底
      if (!resource.includes("*")) refs.push(resource);
    }
  }
  return refs;
}

function main() {
  if (!fs.existsSync(SRC_DIR)) throw new Error(`找不到源码目录：${SRC_DIR}`);

  const manifestPath = path.join(SRC_DIR, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  // ---- 1. 校验：manifest 引用的文件 + 运行期动态打开的页面，必须都在源码目录里 ----
  const sourceFiles = listFiles(SRC_DIR);
  const present = new Set(sourceFiles);
  const missing = [...new Set([...collectManifestRefs(manifest), ...EXTRA_REQUIRED])]
    .filter((ref) => !present.has(ref));
  if (missing.length) {
    console.error("❌ 以下文件被引用但源码目录里不存在：", missing);
    process.exit(1);
  }

  // ---- 2. 打包：顶层条目 + manifest 在根 ----
  fs.mkdirSync(DIST_DIR, { recursive: true });
  const zipName = `linuxdo-feed-manager-chrome-${manifest.version}.zip`;
  const zipPath = path.join(DIST_DIR, zipName);
  const posixZip = zipPath.split(path.sep).join("/");
  const posixSrc = SRC_DIR.split(path.sep).join("/");
  const topLevel = fs.readdirSync(SRC_DIR);

  // tar 会直接截断同名文件，不需要先删
  execFileSync(TAR, ["-a", "-c", "-f", posixZip, "-C", posixSrc, ...topLevel], { stdio: "pipe" });

  // ---- 3. 回读校验：manifest 必须在根，且源码文件一个不落 ----
  const entries = execFileSync(TAR, ["-tf", posixZip], { encoding: "utf8" })
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  const entrySet = new Set(entries);
  const manifestAtRoot = entrySet.has("manifest.json");
  const absentFromZip = sourceFiles.filter((file) => !entrySet.has(file));

  const result = {
    version: manifest.version,
    zip: {
      path: path.relative(ROOT, zipPath).split(path.sep).join("/"),
      bytes: fs.statSync(zipPath).size,
      entries: entries.length,
      topLevelEntries: topLevel.length
    },
    sourceFiles: sourceFiles.length,
    manifestAtRoot,
    absentFromZip,
    note: "manifest.json 位于 ZIP 根（无 ./ 前缀、无外层目录），可直接「加载已解压的扩展程序」"
  };

  if (!manifestAtRoot || absentFromZip.length) {
    console.error("❌ 打包结果不合格：", JSON.stringify(result, null, 2));
    process.exit(1);
  }

  console.log(JSON.stringify(result, null, 2));
}

main();
