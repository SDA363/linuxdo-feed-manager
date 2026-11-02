# Linux.do Personal Feed Manager（LDFC）

> **非官方项目（Unofficial）**：本项目由社区用户独立开发，与 [LINUX DO](https://linux.do/) 官方
> 没有任何隶属或背书关系。

给 [LINUX DO](https://linux.do/) 加一层个人信息流管理：把 Topic 按你的意愿分成
**感兴趣 / 已读 / 不感兴趣 / 新回复** 四个池子，把处理过的内容从列表里收起来。
论坛仍然负责内容、阅读位置和未读状态，扩展只做「归你管的那一层」。

当前版本：**1.1.1**（Chrome / Edge，Manifest V3）

## 下载

- 仓库：<https://github.com/SDA363/linuxdo-feed-manager>
- 发布页（含油猴脚本 `ldfc.user.js` 与 Firefox 打包产物）：
  <https://github.com/SDA363/linuxdo-feed-manager/releases/latest>

## 功能

- **四池 + 新回复**：感兴趣、已读、不感兴趣，外加一个由未读状态推导出的「新回复」区。
- **列表行内操作**：鼠标悬停出现三个按钮；支持长按进入多选，按住拖动悬浮按钮即可批量投放。
- **预览窗口**：列表页点标题直接弹窗读完整帖（内置「增强阅读」引擎），标记后自动关窗。
- **帖子页工具**：只看楼主 / 展开楼中楼 / 随机跳楼 / 按楼层跳转 / 保存为 HTML / 保存为图片。
- **触屏手势**：右滑 = 感兴趣，左滑 = 不感兴趣；纵向滚动不误触（不使用 `touch-action: none`）。
- **云同步（可选）**：手动 JSON 导出/导入；WebDAV（坚果云等）自动拉取与推送。
  逐条 LWW 合并 + 删除墓碑，**绝不整库覆盖**。
- **通知级别联动（可选）**：移入池子时按映射修改 Discourse 通知级别，用户手动改过的帖子优先。

## 界面

界面不是「弹出一个小方块」，而是尽量做成**从触发点长出来**的连续动画：

- **悬浮球 ⇄ 面板**：点球时球体**连续放大成面板**（能看到中间帧，不是淡入），
  收起时沿原路缩回球；展开方向按球所在四角自动判断，不会把球弹到别处。
- **列表行胶囊**：鼠标移到行上，三个图标（感兴趣 / 已读 / 不感兴趣）展开成胶囊；
  已在某个池子里的按钮会带一层光效，不用打开池子也知道这条标的什么。
- **二级面板**：从一级面板边缘**逐帧放大**贴出来，每个二级面板都有自己的关闭按钮，
  关闭同样走缩回动画。
- **预览窗**：从标题位置 FLIP 展开，关闭时缩回原标题；窗口整体居中。
- **拖拽投放**：长按进入多选后，按住悬浮球拖动，球会展开半圆扇形投放面板，
  松手即落池；未多选时拖动只是「移动并弹回」，不会误触。
- **动画速度**：设置里可调，默认 1×，调慢可以看清整个展开过程。

## ⚠️ 会修改站点设置，请先读这段

「通知级别联动」会调用站点自己的接口（`POST /t/<id>/notifications`），
**真的改变你在 linux.do 的邮件 / 推送通知设置**。

- 默认映射：感兴趣 → 关注、已读 → 跟踪、不感兴趣 → 免打扰。
- 总开关可在设置里关闭；关闭后只显示当前级别，不写任何东西。
- 「自动已读时」默认**不修改**（`null`），需要你主动打开才会对自动读完的帖子发请求。
- 你在某条帖子上手动改过级别后，池子联动不再覆盖它；菜单底部「跟随信息池」可以解除接管。

## 安装

### Chrome / Edge（未打包扩展）

1. 打开 `chrome://extensions`，右上角打开「开发者模式」。
2. 点「加载已解压的扩展程序」，选择本仓库的 `linuxdo-personal-feed-manager/` 目录。
3. 打开 <https://linux.do/>，刷新页面。

### 油猴 / 篡改猴

本仓库不提交构建产物（`dist/` 已忽略）。先本地生成：

```bash
node tools/build-userscript.js   # 输出 dist/ldfc.user.js
```

再把 `dist/ldfc.user.js` 导入脚本管理器即可（`@grant none`，纯页面脚本）。

> **不要同时开两个**：扩展和油猴脚本会各注入一份 UI。同一台浏览器只用一种。
> 油猴环境下没有扩展后台，**云同步不可用**，本地功能与导出/导入照常。

## 数据与隐私

- 所有记录存在浏览器本地 **IndexedDB**，按 linux.do 账号分库（`ldfc__user-<id>`）。
- 只读取 `data-topic-id`、标题、作者、时间等列表元数据；**不同步帖子正文**。
- 云同步只写到你**自己填的** WebDAV 目录；凭据（地址 / 账号 / 应用密码）
  以明文存本地 IndexedDB，不上传到任何第三方。设置里有「清除本地凭据」。
- 不引入统计、埋点或第三方服务。

## 云同步说明

- 一个账号命名空间对应一个远程文件，例如 `ldfc-user-42.json`。
- 远程文件为紧凑行 + 裸 gzip（schema 5），坚果云网页预览会显示为二进制，属正常现象。
- **跨设备注意**：schema 5 是单向升级。另一台设备必须先更新到同版本扩展，
  否则旧版读取新文件会明确报「schema 不兼容」并中止同步（不会写坏数据）。

## 兼容性

| 环境 | 状态 |
|---|---|
| Chrome / Edge（MV3，桌面） | 已实现并验收 |
| 油猴 / 篡改猴（`@grant none`） | 已实现并冒烟验收；云同步不可用 |
| Firefox for Android | 已生成签名用打包产物（`dist/linuxdo-feed-manager-firefox-1.1.1.zip`）；**仅模拟器链路验证，真实手机 NOT TESTED** |
| iOS / iPadOS | 未支持 |

## 测试

```bash
node tools/test-sync-model.js          # 合并算法（64 项）
node tools/test-notification-level.js  # 通知联动（13 项）
node tools/test-sync-service.js        # 同步编排（52 项）
node tools/test-webdav-transport.js    # 传输层（17 项）
node tools/test-sync-settings.js       # 设置纯函数（13 项）

# 浏览器端（需先启动 browser-lab/probe-server.js 与 browser-lab/browser.js）
node browser-lab/run-ui-acceptance.js      # 121 项
node browser-lab/run-sync-acceptance.js    # 42 项（需先 node browser-lab/mock-webdav.js）
node browser-lab/run-ldfc-acceptance.js    # 77 项
node browser-lab/run-userscript-smoke.js   # 9 项
```

## 未验证清单（如实标注）

- 真实 linux.do 上写入通知级别（自动化只用 mock 站点验证过请求形状）。
- 真实坚果云两端「通知接管标记」往返（自动化只覆盖 mock WebDAV）。
- 真实账号 A ↔ 真实账号 B 切换。
- Firefox for Android 真实手机安装与触摸手势。

## 目录结构

```
linuxdo-personal-feed-manager/   扩展源码（直接加载这个目录）
tools/                           单测与打包脚本
browser-lab/                     浏览器自动化验收（探针页 + mock WebDAV）
docs/                            规格、实现状态、各轮验证报告
dist/                            构建产物（油猴脚本 / Firefox 打包）
```

> 内部施工记录与含本机路径的文件（`AGENTS.md`、`_todo*.md`、`browser-lab/README.md`、
> 扩展目录里的旧版 README、两份含本机绝对路径的 `docs/`）**不进入版本库**，见 `.gitignore`。

## 友链与参考

- [LINUX DO](https://linux.do/) —— 本项目服务的社区，也是它的起点。

参考或复用的用户脚本：

- [Linux.do 小助手（增强版）](https://greasyfork.org/zh-CN/scripts/552210-linux-do-%E5%B0%8F%E5%8A%A9%E6%89%8B-%E5%A2%9E%E5%BC%BA%E7%89%88)
  —— 「只看楼主 / 展开楼中楼 / 随机跳楼 / 保存到本地 / 保存为图片 / 按楼层跳转」的功能来源。
- [LinuxDo 增强阅读](https://greasyfork.org/zh-CN/scripts/584412)
  —— 预览窗内置引擎的上游（v1.8.7，MIT，作者 Fashion）。

以上脚本与本项目没有隶属关系；复用部分各自遵守原许可，全文见 `THIRD-PARTY-NOTICES.md`。

## 许可

本项目以 **MIT License** 发布，见 `LICENSE`。

内置或参考的第三方作品（html2canvas、LinuxDo 增强阅读、linux.do 小助手）
及其许可全文见 `THIRD-PARTY-NOTICES.md`。
