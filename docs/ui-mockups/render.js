"use strict";

// 生成 5 版 UI 效果图：替换模板占位符 → 无头 Chrome 截图。
// 用法：node docs/ui-mockups/render.js

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const DIR = __dirname;
const TEMPLATE = fs.readFileSync(path.join(DIR, "template.html"), "utf8");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const VARIANTS = [
  {
    letter: "A",
    cls: "styleA",
    title: "青瓷 Teal",
    acc: "#38c6b4",
    acc2: "#1e9086",
    desc: "冷青绿主色 + 左侧竖条高亮；二级面板分区用同色系浅底，克制但不再是一片灰。"
  },
  {
    letter: "B",
    cls: "styleB",
    title: "湖蓝 Azure",
    acc: "#4f9dff",
    acc2: "#2a6ad0",
    desc: "湖蓝 + 渐变描边；一级面板选中态整条胶囊填充，辨识度最高。"
  },
  {
    letter: "C",
    cls: "styleC",
    title: "琥珀石墨 Amber",
    acc: "#eaa33c",
    acc2: "#a86a19",
    desc: "中性石墨底 + 琥珀点缀；圆角更小、标签大写，偏工具感，彩色只出现在关键处。"
  },
  {
    letter: "D",
    cls: "styleD",
    title: "森林青柠 Green",
    acc: "#5fd08c",
    acc2: "#26995c",
    desc: "每个图标带浅色圆角底块；分组感最强，文件夹树和设置分区一眼能分开。"
  },
  {
    letter: "E",
    cls: "styleE",
    title: "珊瑚 Coral",
    acc: "#ff8173",
    acc2: "#cf4436",
    desc: "珊瑚红 + 顶部渐变条；图标加粗到 2.1，暗底上对比最强，适合小屏。"
  }
];

for (const v of VARIANTS) {
  const html = TEMPLATE
    .replaceAll("__CLASS__", v.cls)
    .replaceAll("__LETTER__", v.letter)
    .replaceAll("__TITLE__", v.title)
    .replaceAll("__DESC__", v.desc)
    .replaceAll("__ACC__", v.acc)
    .replaceAll("__ACC2__", v.acc2);
  const htmlPath = path.join(DIR, `${v.letter}.html`);
  fs.writeFileSync(htmlPath, html, "utf8");

  const png = path.join(DIR, `${v.letter}.png`);
  execFileSync(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--screenshot=${png}`,
    "--window-size=1480,1010",
    pathToFileURL(htmlPath).href
  ], { stdio: "ignore" });
  console.log(`${v.letter} ${v.title} -> ${png}`);
}
