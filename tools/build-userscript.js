"use strict";

// 生成油猴脚本产物（Tampermonkey / Violentmonkey 等）。
//
// 为什么用"生成"而不是另写一份脚本：
//   油猴脚本与扩展的**功能代码完全相同**，差异只有三处：
//     1. 没有 manifest，需要 @match / @run-at 头部；
//     2. 没有 content_scripts.css，样式要内联注入；
//     3. 所有文件拼成一个脚本，在页面主世界执行（@grant none）。
//   手写第二份源码必然漂移，所以这里以 linuxdo-personal-feed-manager/
//   为唯一源码，每次生成 dist/ldfc.user.js。
//
// 安全边界：
//   - 绝不写 linuxdo-personal-feed-manager/（Chrome v1.0.0 封版源码）
//   - 只写 dist/（已在 .gitignore 中排除）
//
// 用法：
//   node tools/build-userscript.js

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC_DIR = path.join(ROOT, "linuxdo-personal-feed-manager");
const OUT_DIR = path.join(ROOT, "dist");
const OUT_FILE = path.join(OUT_DIR, "ldfc.user.js");

const manifest = JSON.parse(fs.readFileSync(path.join(SRC_DIR, "manifest.json"), "utf8"));

// 按 manifest 的加载顺序拼接：MAIN 世界的路由钩子必须排在最前，
// 否则 document-start 阶段拦不到 Discourse 的 history.pushState。
const jsFiles = [];
const cssFiles = [];
for (const entry of manifest.content_scripts || []) {
  jsFiles.push(...(entry.js || []));
  cssFiles.push(...(entry.css || []));
}

const readSource = (relativePath) => {
  const absolute = path.join(SRC_DIR, relativePath);
  if (!fs.existsSync(absolute)) throw new Error(`源码缺失：${relativePath}`);
  return fs.readFileSync(absolute, "utf8");
};

const cssText = cssFiles.map(readSource).join("\n");
const jsText = jsFiles
  .map((file) => `\n// ======== ${file} ========\n${readSource(file)}`)
  .join("\n");

const header = `// ==UserScript==
// @name         ${manifest.name}
// @namespace    linuxdo-feed-manager@ldfc.local
// @version      ${manifest.version}-mobile.1
// @description  ${manifest.description}
// @match        https://linux.do/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==
`;

// 油猴脚本没有 manifest 的 css 字段，样式在脚本里内联注入。
// 选择器全部以 ldFC 自己的类名/属性为作用域，不依赖插入顺序。
//
// 注意（实测踩过）：document-start 阶段 documentElement / head 都可能还不存在，
// 直接 appendChild 会抛错。而注入的整段脚本是"一个整体"，
// 开头抛错会连后面所有模块一起不执行（表现为完全没反应、也没有报错提示）。
const styleBlock = `
(() => {
  const applyStyle = () => {
    const target = document.head || document.documentElement;
    if (!target || document.getElementById("ldfc-styles")) return false;
    const style = document.createElement("style");
    style.id = "ldfc-styles";
    style.textContent = ${JSON.stringify(cssText)};
    target.appendChild(style);
    return true;
  };
  if (!applyStyle()) {
    document.addEventListener("DOMContentLoaded", applyStyle, { once: true });
  }
})();
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, `${header}${styleBlock}${jsText}`, "utf8");

const sizeKb = (fs.statSync(OUT_FILE).size / 1024).toFixed(1);
console.log(`油猴脚本已生成：${OUT_FILE}`);
console.log(`  脚本文件 ${jsFiles.length} 个，样式 ${cssFiles.length} 个，产物 ${sizeKb} KB`);
