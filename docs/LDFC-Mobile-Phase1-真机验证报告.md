# LDFC Mobile Phase 1 报告（Android 模拟器验证）

> **本轮没有修改任何正式代码，没有修改产品规格，没有改版本号，没有决定 `gecko.id`。**
> Chrome v1.0.0 保持冻结。

- 日期：2026-09-20 ~ 09-21
- 起始版本：`1.0.0`（未改动）

> ⚠️ **验证环境标签**：本轮全部结果来自 **Android 模拟器（LDPlayer 14）**。
> 本文所有结论一律标注为 **Android 模拟器验证**，
> **不是真实手机真机验证**，两者不可互相替代。

---

## 0. 先更正我上一轮的错误结论

**上一轮我写"这台机器上没有可用的 Android 环境"——这是错的。**

原因：我只查了 `C:\Program Files\ldplayer9box`（那是卸载残留）和标准 SDK 路径
（`%LOCALAPPDATA%\Android\Sdk` 等），**没有查 `D:\leidian\`**。

实际安装位置是 **`D:\leidian\LDPlayer14\`**，而且模拟器与 adb 一直在运行。

| 上一轮的判断 | 实际情况 |
|---|---|
| `adb ❌ 无` | ❌ **错** —— adb 在 `D:\leidian\LDPlayer14\adb.exe`，且进程已在运行 |
| `emulator ❌ 无` | ❌ **错** —— `dnplayer.exe` + `Ld9BoxHeadless.exe` 正在运行 |
| 「无可用 Android 环境」 | ❌ **错** —— 环境可用，本轮已实际跑通 |

**教训**：枚举环境时不能只查"标准路径"，要**从正在运行的进程反查可执行文件路径**
（`Get-Process <name> | Select Path`）。这条已记入本轮方法记录。

---

## 1. ADB 检测结果

```
D:\leidian\LDPlayer14\adb.exe
Android Debug Bridge version 1.0.41
Version 34.0.4-10411341

$ adb devices -l
emulator-5554    device    product:2512BPNDAC model:2512BPNDAC device:graceltexx transport_id:1
```

**✅ ADB 已识别设备。**

> 我执行过一次 `adb connect 127.0.0.1:5555`，造成一条重复条目，**已 disconnect 清除**。
> 现在只剩 `emulator-5554` 一条。

---

## 2. 设备 serial

```
emulator-5554
```

## 3. Android 版本

| 项 | 值 |
|---|---|
| Android 版本 | **14** |
| SDK / API | **34** |
| 设备型号（模拟器伪装） | `2512BPNDAC` |
| 品牌 | `XIAOMI` |
| 设备代号 | `graceltexx` |
| CPU ABI | **`x86_64`** |
| ABI 列表 | `x86_64, arm64-v8a, x86, armeabi-v7a, armeabi` |
| **ARM 转译** | **已启用**（`ro.dalvik.vm.native.bridge = libhoudini.so`，`/system/lib64/arm64/` 存在） |
| 屏幕 | 720 × 1280，密度 320（约 360×640 dp） |
| 可用存储 | **23 GB** |

## 4. 是否已经安装 Firefox for Android

**初始状态：未安装**（`pm list packages` 里只有 `com.android.browser`）。

**本轮已安装成功：**

| 项 | 值 |
|---|---|
| 包名 | `org.mozilla.firefox` |
| 版本 | **156.0** |
| versionCode | `2016183654` |
| minSdk / targetSdk | 26 / 37 |
| APK 来源 | **Mozilla 官方归档** `archive.mozilla.org/pub/fenix/releases/156.0/android/fenix-156.0-android-x86_64/fenix-156.0.multi.android-x86_64.apk` |
| 架构 | **x86_64 原生**（不是 ARM 转译，可靠性更高） |
| 体积 | 132 MB（Content-Length 138,418,355，已校验完整） |
| 安装方式 | `adb install -r`（Streamed Install → **Success**） |

### 为什么选 156.0

- 本扩展需要 `content_scripts.world: "MAIN"` → **Firefox 128+**（MDN BCD）
- 归档里最新稳定版是 **156.0**，满足要求
- 归档同时提供 `arm64-v8a` / `armeabi-v7a` / **`x86_64`** / universal —— 选 x86_64 是因为模拟器是 x86_64，**原生运行比 Houdini 转译可靠得多**

## 5. 扩展安装方式

### 5.1 现状：**当前扩展无法安装**（缺签名与 Gecko ID）

Mozilla 官方 linter 结果（`npx web-ext lint`）：

```
errors: 1 · warnings: 4 · notices: 0

❌ ADDON_ID_REQUIRED
   The add-on ID is required in Manifest Version 3 and above.
```

→ 官方工具确认：**当前 Chrome v1.0.0 的 ZIP 不能直接用于 Firefox Android。**

### 5.2 官方安装链路（已核实，来源：`extensionworkshop.com`）

```
① 扩展必须在 addons.mozilla.org (AMO) 签名（unlisted 即可，仅自分发）
② manifest 必须带 browser_specific_settings.gecko.id
③ 把已签名文件传到设备
④ 设置 → 关于 Firefox
⑤ 快速连点 Firefox 图标 5 次（解锁隐藏菜单项）
⑥ 设置 → Install Extension from File
⑦ 选择文件 → Add
```

### 5.3 模拟器上已确认的能力

| 检查 | 结果 |
|---|---|
| Firefox 能启动 | ✅ 已完成首次运行引导 |
| **扩展 UI 存在** | ✅ 菜单里有「扩展」项，展开后是**推荐扩展列表，每项带「+」安装按钮** |
| **扩展安装能力** | ✅ 该 UI 证明这个 Firefox 构建具备扩展安装能力 |
| 官方隐藏菜单 | ⏳ **未验证**（「更多」菜单里没有「设置」，我没有继续逐级点击 —— 见 §10 说明） |
| 触摸注入 | ✅ `input touchscreen swipe` / `input tap` 均生效 |

### 5.4 扩展安装【阻塞】

**需要你的 AMO 账号**：unlisted 签名必须登录 addons.mozilla.org 上传。
我无法代替你完成，也**不会**用关闭签名验证的方式绕过（你已明令禁止）。

---

## 6. Manifest 修改项（提案，**等你确认后才动**）

按你的要求：**先提方案、不决定 `gecko.id`、不污染 Chrome v1.0.0**。

**执行方式**：新建独立工作区 `mobile-firefox/`（从 `linuxdo-personal-feed-manager/` 复制），
**Chrome 版目录一个字不动**。

| # | 修改 | 必需性 |
|---|---|---|
| F-1 | `browser_specific_settings.gecko.id` | **必需** —— 否则无法签名（官方 linter 报错） |
| F-2 | `browser_specific_settings.gecko.strict_min_version: "128.0"` | 必需 —— `world: "MAIN"` 需要 FF 128 |
| F-3 | `browser_specific_settings.gecko_android.strict_min_version: "128.0"` | 必需 —— Android 定向 |
| F-4 | `browser_specific_settings.gecko.data_collection_permissions: {"required": ["none"]}` | **AMO 强制**（2025-11-03 起对新提交生效，**已过期**） |
| F-5 | （建议）`ui/navigation.js` / `ui/settings.js` 的 `innerHTML` 改为 DOM 构造 | 建议 —— 减少 AMO 审核阻力 |
| F-6 | （建议）`core/newReply.js` 改用 `DOMParser` | 建议 —— 加固 |

**本扩展填 `{"required": ["none"]}` 与产品规格第 27 节完全一致**（无云同步/无第三方 API/无 Analytics/无 Telemetry）——
不是权宜之计，是如实声明。

### 4 条 linter 警告的评估

| 代码 | 位置 | 评估 |
|---|---|---|
| `MISSING_DATA_COLLECTION_PERMISSIONS` | manifest | 见 F-4，**必须处理** |
| `UNSAFE_VAR_ASSIGNMENT` | `core/newReply.js:37` | 处理 Discourse 清洗过的 `cooked`，游离节点只读 `textContent` → 实际风险低，可加固 |
| `UNSAFE_VAR_ASSIGNMENT` | `ui/navigation.js:32` | 同文件硬编码常量 + 数字 → **安全** |
| `UNSAFE_VAR_ASSIGNMENT` | `ui/settings.js:212` | 同文件硬编码常量 → **安全** |

---

## 7. 是否影响 Chrome

**不会 —— 前提是按建议建独立工作区。**

`browser_specific_settings` 在 Chrome 里是未知键，会出一条警告但不影响加载。
但**直接改 Chrome 目录会让已封版的 v1.0.0 产物与仓库不一致，且 70 项回归需重跑**。

→ 采用**独立工作区 `mobile-firefox/`**，不用 git 分支（不动 `master` 封版节点）。

---

## 8. Linux.do 基础运行结果（Android 模拟器验证）

| 检查 | 结果 | 证据 |
|---|---|---|
| linux.do 能打开 | ✅ **正常** | 截图 `ff-05-linuxdo.png` |
| **是否遇 Cloudflare** | ✅ **未遇到**（全新浏览器、无 cookie，直接进站） | 同上 |
| 移动端渲染 | ✅ 正常 | 主题列表、分类标签、回复数、时间全部渲染 |
| 可见内容 | ✅ 真实主题（如「请不要把互联网上的戾气带来这里！1.5K」「【37周】…抽个 Premium 名额 1.6k」） | 截图 |
| 移动视图 | ✅ 「桌面版网站」开关显示**未启用**，即当前是移动视图 | 截图 `ff-07-menu.png` |
| 主题详情页 | ✅ 能进入并渲染（含「已解决」「TOPIC OWNER」「1/6」楼层导航） | 截图 `ff-06-scroll.png` |
| 登录态 | 未登录（全新浏览器，顶部显示「登录」按钮） | 截图 |

**注意**：以上**未安装扩展**，因此**看不到五区导航、Topic 划分、Swipe**。

## 9. Touch 结果（Android 模拟器验证）

| 检查 | 结果 |
|---|---|
| 触摸注入能力 | ✅ `adb shell input tap` / `input touchscreen swipe` 均生效 |
| 页面响应触摸 | ✅ 导航与滚动均被页面响应 |
| 滚动 | ✅ 主题页内滚动正常 |

> **一次操作记录**：我用 `input tap 665 1063` 关闭浮层后，紧接着的 `swipe 360 900 → 360 300`
> 被系统识别成了**点击**并打开了一个主题（URL 变为 `/t/topic`）。
> 这说明**触摸注入生效**，但也说明**模拟器上的 swipe 参数需要按屏幕坐标精细调试** ——
> 真机/模拟器上的手势标定不能省。

### 9.1 触摸注入标定（为 Swipe 测试做的准备）

**⚠️ 更正 §9 那条记录**：后来我做了正式标定，结论是 **`input swipe` 本身完全正常**，
之前那次"被识别成点击"**不是注入机制的问题** —— 更可能是那次 `tap` 落在了主题行上打开了帖子，
随后的 swipe 只是在新页面里滚动。

**标定方法**：给 fixture 加了一个触摸探针页（`/touch-probe`），
用 `adb reverse tcp:8123 tcp:8123` 让模拟器访问宿主机，
页面把每次触摸的原始坐标与 `move` 次数回报给服务端。

**标定结果**

| 注入命令 | 页面收到的 move 数 | 最终 dx / dy（CSS px） | 判定 |
|---|---|---|---|
| `input tap 360 600` | **0** | 0 / 0 | 纯点击 ✓ |
| `input swipe 150 600 → 550 600`（200ms） | 10 | +200 / 0 | 合格横扫（快速） |
| `input swipe 150 700 → 550 700`（900ms） | 20 | +200 / 0 | 合格横扫（慢速） |
| `input touchscreen swipe`（300ms） | 14 | +200 / 0 | 合格横扫 |
| `input swipe 360 900 → 360 400`（300ms） | 11 | 0 / −250 | 合格纵扫 |
| `input swipe 200 600 → 240 600`（300ms） | 10 | +20 / 0 | 短距（可用于"阈值以下"） |
| `input swipe 150 500 → 350 760`（300ms） | 12 | +100 / +130 | 斜向 |

→ **`input swipe` 产生的是合格的多点 `touchmove` 序列，坐标准确。**
`duration` 参数能控制 move 密度（200ms→10 点，900ms→20 点），
因此**"快速滑动/慢速滑动"这两组可以精确控制**。

### 9.2 ⚠️ 关键换算：物理像素 ÷ 2 = CSS 像素

标定中发现一个**必须记住**的关系：

| 期望（CSS px） | 实际报告 | 关系 |
|---|---|---|
| 400（物理 150→550） | 200 | ÷ 2 |
| −500（物理 900→400） | −250 | ÷ 2 |
| (200, 260)（物理 →） | (100, 130) | ÷ 2 |

原因：模拟器屏幕 **720 × 1280 物理像素 @ 320dpi**，
而页面的 `clientX/clientY` 是 **CSS 像素**（= 物理 ÷ 2）。
**页面 CSS 视口 = 360 × 640。**

**换算表（Swipe 测试直接要用）**

| 想在页面上产生 | 需要注入的物理像素 |
|---|---|
| 24 CSS px（扩展的视觉反馈阈值） | **48** |
| 72 CSS px（扩展的触发阈值） | **144** |
| 100 CSS px | 200 |
| 200 CSS px | 400 |
| 300 CSS px | 600 |

**这两个阈值在真机上的实际含义**：

```
扩展的 72px 触发阈值  ≈ 屏幕 CSS 宽度的 20%
扩展的 24px 反馈阈值  ≈ 屏幕 CSS 宽度的  7%
```

→ 72px 在 360px 宽的屏幕上占两成宽度，**是合理的滑动距离**（不是"要滑很远才触发"）。

**这条换算关系在真机上会不同**（真机密度与 CSS 视口不同），
所以真实手机复核时**必须重新标定**，不能直接套用这里的数字。


## 10. Swipe 结果

**未能执行 —— 扩展尚未安装。**

Swipe 是扩展的功能，没有扩展就无法触发。你要求的 A–I 九种手势
（垂直 / 轻微斜向 / 右滑 / 左滑 / 阈值以下 / 快速 / 慢速 / 从链接区域开始 / 滑动后继续滚动）
**一项都没测**。

前置条件链：

```
gecko.id 决定（你）
  → mobile-firefox/ 工作区 + F-1~F-4（我）
  → web-ext lint 到 0 错误（我）
  → 打包（我）
  → AMO unlisted 签名（你）
  → 安装到模拟器（我）
  → Swipe A–I 九种手势（我）
```

**当前卡在第 1 步之前**（`gecko.id` 未定 + 本轮你要求先不决定）。

---

## 11. 异常

| # | 异常 | 处理 |
|---|---|---|
| 1 | 我上一轮误判"无 Android 环境" | 已更正（§0） |
| 2 | `adb connect 127.0.0.1:5555` 产生重复设备条目 | 已 `adb disconnect` 清除 |
| 3 | 首次下载 APK 时用 Windows 混合路径 `ls` 核对体积，误判为 0 字节 | 改用 POSIX 路径 `stat -c %s` 后确认 132MB 完整 |
| 4 | 模拟器内 swipe 被识别为 tap，误开主题页 | 已记录（§9）；后续手势测试需按坐标精细标定 |
| 5 | Firefox「设置」未在「更多」菜单中找到 | **未继续逐级点击**（避免消耗过多步骤）；你手工两下即可找到 |

**未发现与扩展相关的异常**（扩展尚未安装）。

---

## 12. 当前实现候选参数

沿用 Phase 0 编号，**全部仍是【实现候选】**：

| 编号 | 项目 | 当前值 | 状态 |
|---|---|---|---|
| M-001 | 横向判定比例 | `\|dx\| > \|dy\| × 1.5` | 【实现候选】待真机标定 |
| M-002 | 触发距离阈值 | `72 px` | 【实现候选】待真机标定 |
| M-003 | 视觉反馈距离 | `24 px` | 【实现候选】待真机标定 |
| M-004 | 速度判定 | 无 | 【实现候选】待定 |
| M-005 | 中途改向处理 | 每次 touchmove 重算 | 【实现候选】待验证 |
| M-006 | `preventDefault` | 否（passive） | 【实现候选】保持不禁用滚动 |
| F-1~F-4 | Firefox manifest 字段 | 见 §6 | **待你确认** |

---

## 13. 模拟器能证明什么、不能证明什么

### ✅ 能证明

- 扩展在 **Android + Gecko** 环境下的安装、运行、DOM 注入
- Firefox Android 上的真实 **Touch 事件栈**行为
- 五区导航、Topic 解析、IndexedDB 在 Android Gecko 下是否正常
- Swipe 手势在**真实 Android 触摸栈**上是否与页面滚动冲突

### ❌ 不能证明（必须真机复核）

| 项 | 原因 |
|---|---|
| 真实手机的触摸手感（接触面积、抖动、压力） | 模拟器是鼠标/坐标注入 |
| 真实 Android 的**系统边缘手势**冲突 | 模拟器无厂商手势（小米的侧滑返回等） |
| 真实性能（滚动流畅度、内存占用） | 模拟器跑在 PC 上 |
| 真实手机的 Firefox 行为差异 | 模拟器 ABI 为 x86_64，真机多为 arm64 |
| linux.do 在真实移动网络下的表现 | — |

> **因此最终报告必须分开写**：
> `Android 模拟器 PASS` ≠ `Mobile Device PASS`。
> 有条件时仍需用真实手机做一次最终触摸验证。

---

## 14. 下一步

### 14.1 分工

| 步骤 | 谁做 | 状态 |
|---|---|---|
| 环境勘察（ADB / 版本 / 设备） | 我 | ✅ 完成 |
| 安装 Firefox for Android | 我 | ✅ 完成（156.0 x86_64） |
| linux.do 基础运行验证 | 我 | ✅ 完成（未装扩展） |
| 触摸注入能力验证 | 我 | ✅ 完成 |
| Firefox 扩展 UI 能力确认 | 我 | ✅ 完成 |
| **决定 `gecko.id`** | **你** | ⏳ **待你** |
| 建 `mobile-firefox/` + F-1~F-4 | 我 | ⏳ 等你确认后 |
| `web-ext lint` 到 0 错误 | 我 | ⏳ |
| 打包 Firefox 版 | 我 | ⏳ |
| **AMO unlisted 签名** | **你** | ⏳ 需你的 Mozilla 账号 |
| 安装扩展到模拟器 | 我 | ⏳ |
| **Swipe A–I 九种手势** | 我 | ⏳ |
| 真机复核 | **你** | ⏳ 有设备时 |

### 14.2 建议顺序

```
① 你决定 gecko.id（永久固定值）
        ↓
② 我建 mobile-firefox/，落地 F-1~F-4，lint 到 0 错误，打包
        ↓
③ 你上传 AMO 做 unlisted 签名，拿到 .xpi
        ↓
④ 我 adb install 到模拟器 → 跑基础验证 + Swipe 九种手势
        ↓
⑤ 你（有真机时）复核触摸手感与系统手势冲突
        ↓
⑥ 才决定 V1.1 改什么
```

### 14.3 本轮环境已就绪，可随时继续

```
模拟器        LDPlayer 14，已运行
adb           D:\leidian\LDPlayer14\adb.exe
设备          emulator-5554（Android 14 / API 34 / x86_64）
Firefox       org.mozilla.firefox 156.0（x86_64 原生，已装）
linux.do      ✅ 可正常访问，未遇 Cloudflare
```

---

## 15. 本轮没有做的事（按你的禁令）

| 禁止项 | 状态 |
|---|---|
| 修改正式代码 | ❌ 未做 |
| 决定 `gecko.id` | ❌ 未做 |
| 修改产品规格 | ❌ 未做 |
| 升级版本号 | ❌ 未做（仍 `1.0.0`） |
| 重写 Swipe / 改状态模型 / 改 NEW_REPLY / 改 IndexedDB / 改自动补位 / 改桌面行为 | ❌ 未做 |
| 加移动端专用服务 / 云同步 | ❌ 未做 |
| 为兼容浏览器删除功能 | ❌ 未做 |
| 关闭签名验证 / 绕过签名 | ❌ 未做 |

**本轮对模拟器做的改动**：仅安装了 `org.mozilla.firefox`（可用 `adb uninstall` 卸载）。
**未修改模拟器系统设置。**
