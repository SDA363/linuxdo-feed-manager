"use strict";

// 生成"本地回归测试"用的插件副本：
// 把 linuxdo-personal-feed-manager 复制到 browser-lab/.probe-ext，
// 并把所有 content_scripts 的匹配范围从 https://linux.do/* 改成
// http://127.0.0.1/*，这样无需访问外网即可在本地模拟页（probe-server.js）上验收插件。
//
// 注意：必须按 JSON 解析后再改写，不能用字符串 replace。
// manifest 里现在有两个 content_scripts 条目，字符串 replace 只会改到第一个，
// 结果主逻辑（第二个条目）在本地页面上永远不会注入。

const fs = require("node:fs");
const path = require("node:path");

const LAB_DIR = __dirname;
const SOURCE = path.resolve(LAB_DIR, "..", "linuxdo-personal-feed-manager");
const TARGET = path.join(LAB_DIR, ".probe-ext");
const PROBE_ORIGIN = "http://127.0.0.1/*";

if (!fs.existsSync(path.join(SOURCE, "manifest.json"))) {
  console.error("找不到插件源目录：" + SOURCE);
  process.exit(1);
}

fs.rmSync(TARGET, { recursive: true, force: true });
fs.cpSync(SOURCE, TARGET, { recursive: true });

const manifestPath = path.join(TARGET, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

for (const entry of manifest.content_scripts ?? []) {
  entry.matches = [PROBE_ORIGIN];
}
manifest.host_permissions = [PROBE_ORIGIN];

// Chrome 会按「扩展 id + 版本」缓存 service worker 脚本。本地反复修改
// background 代码时，如果版本号不变，重启后仍可能执行旧的 worker
// （表现为新加的消息类型完全不响应）。给探测副本一个每次变化的构建号。
const baseVersion = manifest.version.split(".").slice(0, 3).join(".");
const buildStamp = Math.floor(Date.now() / 1000) % 60_000;
manifest.version = `${baseVersion}.${buildStamp}`;

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log("测试用插件副本已生成：" + TARGET);
