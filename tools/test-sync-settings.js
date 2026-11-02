"use strict";

// 云同步设置里的纯函数单测：远程文件地址推导 + 权限域名推导。
// 不需要浏览器。
//
// 用法：node tools/test-sync-settings.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "linuxdo-personal-feed-manager", "ui", "syncSettings.js");

const sandbox = { window: {}, console, URL };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: FILE });

const { resolveFileUrl, originPatternFor, assertWebdavAddress } = sandbox.window.LDFCSyncSettings;

const results = [];
const check = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

check(
  resolveFileUrl("https://dav.jianguoyun.com/dav/", "user-42") ===
    "https://dav.jianguoyun.com/dav/ldfc-user-42.json",
  "目录结尾带 /：追加按账号区分的文件名"
);

check(
  resolveFileUrl("https://dav.jianguoyun.com/dav", "user-42") ===
    "https://dav.jianguoyun.com/dav/ldfc-user-42.json",
  "目录结尾不带 /：自动补斜杠"
);

check(
  resolveFileUrl("https://dav.example.com/sync/my.json", "user-42") ===
    "https://dav.example.com/sync/my.json",
  "已经是 .json 完整地址：原样使用"
);

check(
  resolveFileUrl("https://dav.example.com/sync/my.json?x=1", "user-42") ===
    "https://dav.example.com/sync/my.json?x=1",
  "带查询参数的 .json 地址：原样使用"
);

check(resolveFileUrl("", "user-42") === "", "空地址：返回空字符串");

check(
  resolveFileUrl("https://dav.example.com/dav/", "user/a b") ===
    "https://dav.example.com/dav/ldfc-user_a_b.json",
  "namespace 中的非法字符被替换"
);

check(
  originPatternFor("https://dav.jianguoyun.com/dav/ldfc-user-42.json") ===
    "https://dav.jianguoyun.com/*",
  "权限域名：去掉路径与文件名"
);

check(
  originPatternFor("http://127.0.0.1:8124/dav/x.json") === "http://127.0.0.1/*",
  "权限域名去掉端口（匹配模式不含端口）"
);

{
  let threw = false;
  try {
    originPatternFor("ftp://example.com/x.json");
  } catch {
    threw = true;
  }
  check(threw, "非 http/https 地址被拒绝");
}

{
  let message = "";
  try {
    assertWebdavAddress("https://www.jianguoyun.com/#/sandbox/1/2/%2F/");
  } catch (error) {
    message = error.message;
  }
  check(
    message.includes("dav.jianguoyun.com"),
    `坚果云网页链接被拦下并提示正确地址（${message}）`
  );
}

{
  let message = "";
  try {
    assertWebdavAddress("https://dav.example.com/dav/#x");
  } catch (error) {
    message = error.message;
  }
  check(message.includes("#"), `带 # 的地址被拒绝（${message}）`);
}

{
  let threw = false;
  try {
    assertWebdavAddress("https://dav.jianguoyun.com/dav/");
  } catch {
    threw = true;
  }
  check(threw === false, "正确的坚果云 WebDAV 地址通过校验");
}

{
  let threw = false;
  try {
    assertWebdavAddress("https://dav.example.com/sync/");
  } catch {
    threw = true;
  }
  check(threw === false, "其他服务商的 WebDAV 地址不受影响");
}

console.log("===== 云同步设置纯函数单测 =====");
for (const line of results) console.log(line);
const failed = results.filter((line) => line.startsWith("FAIL")).length;
console.log(`\n汇总：${results.length - failed} 项通过，${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
