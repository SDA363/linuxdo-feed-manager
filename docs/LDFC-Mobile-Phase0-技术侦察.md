# LDFC Mobile Phase 0 技术侦察

> **本文只做侦察，没有修改任何正式代码，没有修改产品规格，没有改版本号。**
> V1.0 保持冻结。移动端作为**新的迭代周期**（V1.1）。

- 日期：2026-09-20
- 起始版本：`1.0.0`（未改动）
- 侦察方式：一手资料核实 + 本地只读代码审计 + **真实 linux.do 移动仿真**

---

## 0. 一句话结论

**移动端最大的未知量不是 Swipe 怎么写，而是"哪个移动浏览器能装这个扩展"。**

而技术层面有一个**非常有利的发现**：

> 本扩展**完全没有使用任何浏览器专有 API**（0 处 `chrome.*` / `browser.*`）、
> **没有 service worker**、**没有声明任何 `permissions`** ——
> 这恰好绕开了 Mozilla 官方文档指出的"Firefox for Android 上 MV3 功能不完整"的全部已知缺口。

---

## 1. 当前支持的移动浏览器

### 1.1 已核实（附一手来源）

以下来自 MDN 的 browser-compat-data（`mdn/browser-compat-data`）：

| 能力 | Chrome | Firefox | **Firefox Android** | Safari / iOS |
|---|---|---|---|---|
| **Manifest V3** | 88 | 109 | **109（mirror）** | 15.4 |
| **`content_scripts.world: "MAIN"`** | 111 | 128 | **128（mirror）** | 18 |

> 本扩展用到 `world: "MAIN"`（`site/routeObserverMain.js`，用于接管 SPA 路由）。
> 因此 **Firefox for Android 需 ≥ 128**。

以下来自 Mozilla 官方扩展开发文档（`extensionworkshop.com`）：

- Firefox for Android **可以加载扩展**：
  - 开发期：`web-ext run -t firefox-android --android-device=<设备>`（包名 `org.mozilla.firefox`）
  - 正式分发：通过 AMO，并在 manifest 里声明 `browser_specific_settings.gecko_android`
- **Android 上的 MV3 功能不完整**：
  - **不支持 background service worker**（替代方案是 event pages）
  - host permission 的授权交互有缺口（无待授权提示、用户无法在扩展管理里改）
  - 官方原话建议：*"it's recommended you use Manifest V2 for extensions targeting Firefox for Android"*
- Lint 会报 `PERMISSION_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`、
  `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`、`ANDROID_INCOMPATIBLE_API`

### 1.2 本扩展在这些缺口下的处境（**代码审计结论**）

| Android MV3 缺口 | 本扩展是否受影响 |
|---|---|
| 不支持 background service worker | **不受影响** —— 本扩展**没有 service worker** |
| host permission 授权交互缺口 | **不受影响** —— 本扩展**没有声明 `permissions`**，只有 `host_permissions` |
| `permissions` 相关 API 不支持 | **不受影响** —— **0 处** `chrome.*` / `browser.*` 调用 |

**审计命令与结果**

```
grep -rn "chrome\.|browser\." --include=*.js .   → 无匹配（仅注释里提到 chrome-extension://）
manifest: manifest_version=3 · permissions=（无）· background=（无）· action=（无）
host_permissions: ["https://linux.do/*"]
```

本扩展的全部能力来自 **DOM + IndexedDB + fetch**，这三样在所有目标浏览器里都是标准 Web 能力。

### 1.3 未能从一手来源核实（**需要你确认或在真机验证**）

| 平台 | 状态 |
|---|---|
| **Android Chrome** | 你的说明是"不能安装扩展"。我尝试抓 Google 帮助页正文，但该页是 JS 渲染/被截断，**没有拿到可引用的原文**。标记为**【待确认】** |
| Kiwi Browser 等 Chromium 系 Android 浏览器 | 未核实（含其当前是否仍在维护） |
| AMO 的 Android 扩展上架规则 | 未核实（Mozilla 那篇公告博客链接已 404） |

> **不把未经核实的信息写成结论** —— 这正是本项目一贯要求。

---

## 2. 当前不支持的平台（已知）

| 平台 | 结论 | 依据 |
|---|---|---|
| **Android Chrome** | 预期**不能**安装 Chrome 扩展 | 使用者提供 + 业界普遍认知；**本文未能取得一手原文，标记待确认** |
| **iPhone / iPad** | **未评估** | Safari Web Extensions 是另一套 API 与分发方式，与本次侦察范围不同 |
| 桌面 Chrome / Edge | ✅ 已在 V1.0 真实验证 | `LDFC-1.0.0-封版报告.md` |

**因此 V1.1 的首要决策不是技术，而是产品：**

> 移动端 V1.1 究竟以**哪个浏览器**为目标？

在这一点确认之前，写 Swipe 没有意义 —— 因为代码写完可能根本装不上。

---

## 3. V1.0 可复用部分

**好消息：绝大多数逻辑不需要改。**

### 3.1 已实现、且已通过测试的部分

| 能力 | 位置 | 移动端可用性 |
|---|---|---|
| **Swipe（左右滑）** | `interaction/swipe.js` | ✅ **V1.0 里已经实现**（不是从零写） |
| Topic 解析 | `site/topicParser.js` | ✅ 移动 DOM 上实测正常 |
| 五区导航 | `ui/navigation.js` | ✅ 移动端注入 5 个按钮 |
| 池状态机 | `storage/topicState.js` | ✅ 与渲染无关 |
| IndexedDB 持久化 | `storage/db.js` | ✅ 标准 Web API |
| 新回复三层 | `core/poolManager.js` | ✅ 与渲染无关 |
| 自动补位 | `core/autofill.js` | ✅ 移动端哨兵存在 |

### 3.2 `interaction/swipe.js` 现状（V1.0 已存在）

```js
文档级 touchstart / touchmove / touchend（前两个 passive: true）
垂直守卫：Math.abs(deltaX) <= Math.abs(deltaY) * 1.5  → 不当作滑动
视觉反馈：|deltaX| > 24 时加 .ldfc-swipe-left / .ldfc-swipe-right
触发阈值：|deltaX| >= 72 且 |deltaX| > |deltaY| * 1.5
右滑 → markInterested     左滑 → markDismissed
```

**并且它没有使用 `touch-action: none`** —— 符合规格"不要禁掉页面正常滚动"的要求。

AC-022 已用合成 TouchEvent 在本地验证过（右滑/左滑/垂直不误判）。

---

## 4. 移动端差异（真实 linux.do 实测）

### 4.1 侦察方法（以及一次方法错误的更正）

```
CDP 移动仿真：390×844、deviceScaleFactor 3、touch 开启
导航到 https://linux.do/latest?mobile_view=1
```

> **⚠️ 更正记录**：第一次尝试同时把 User-Agent 改成 Android UA，
> 结果会话 cookie（桌面 UA 签发）与 UA 不一致，**直接触发 Cloudflare 人机验证**
> （页面标题变成"请稍候…"），侦察数据全部无效。
> 改为**不覆盖 UA**、用 Discourse 自己的 `?mobile_view=1` 强制移动模板后才拿到有效数据。

**诚实声明**：这是**桌面 Chrome 的移动仿真**，能验证 DOM / 触摸 / 布局，
但**不能**验证"移动浏览器能否加载扩展"（那是平台问题，见第 1 节）。

### 4.2 关键发现：**移动模板的 DOM 结构与桌面一致**

| 观测项 | 桌面 | **移动（`mobile-view`）** |
|---|---|---|
| `<html>` class | `desktop-view` | **`mobile-view` + `mobile-device` + `touch`** |
| `.topic-list-item` | 30 | **30** |
| 其中带 `data-topic-id` | 30 | **30** |
| `[data-topic-id]` 总数 | 60 | **60**（行 30 + 嵌套标题链接 30） |
| 行标签 | `<tr>` | **`<tr>`** |
| `.load-more-sentinel` | 1 | **1** |
| 标题链接 class | `title raw-link raw-topic-link` | **完全一致** |

→ **扩展的行选择器、ID 提取、无穷滚动哨兵选择器在移动端无需任何改动。**

### 4.3 扩展在移动端的实际表现

| 观测项 | 结果 |
|---|---|
| 隔离世界注入 | ✅ 正常 |
| `listRows()` | **30**（与桌面一致） |
| `findTopicRow()` | ✅ 找到同一行 |
| 账号身份 | ✅ `user-478515`、`loggedIn: true`、来源 `session` |
| 五区导航 | ✅ 5 个按钮全部注入 |
| 行内按钮注入数 | 60（每行 2 个） |

### 4.4 移动端真正的问题：**行内按钮不可见**

```
.ldfc-actions 的 computed style：
  display: none
  rect: 宽 0 / 高 0
  visibleWithoutHover: false
```

原因：`styles/content.css:53` → `.ldfc-topic-row:hover .ldfc-actions`，**只在 hover 时显示**。

**这是设计如此**（规格 §9.1 桌面 hover、§9.2 移动 swipe），但带来一个真实后果：

> **触摸端唯一的操作入口是 Swipe。** 一旦滑动失效（系统手势冲突、浏览器拦截、用户不习惯），
> 就没有任何兜底方式能标记 Topic。

### 4.5 窄屏布局

```
视口 391 × 844
#ldfc-navigation:  left 16 / right 160 / 宽 144 / 高 219   → 未溢出 ✓
#ldfc-settings-launch: 宽 128                              → 未溢出 ✓
导航 scrollWidth == clientWidth (144 == 144)               → 无横向滚动 ✓
```

导航固定在**左下角**、占据 391px 宽视口约 37% 的宽度与下方 219px 高度，
会遮住列表左下部分内容 —— **不溢出，但可能遮挡**。需要真机确认是否影响阅读。

### 4.6 linux.do 的移动端定制

`<body>` 上多了 `uc-floating-dismiss-topics-on-mobile`（站点自定义），
说明 linux.do 自己在移动端也改了 Topic 行行为。**真机验证时要留意它是否与 Swipe 冲突。**

---

## 5. Touch 事件实际情况（实测）

在真实 linux.do 移动仿真下，用合成 TouchEvent 分别测四种手势（**每种用不同的行**）：

| 手势 | 参数 | 实际结果 | 判定 |
|---|---|---|---|
| **垂直为主** | dx=14, dy=220 | 未产生新状态（pool 未变） | ✅ 未误触发 |
| **右滑** | dx=+180, dy=5 | → `INTERESTED` | ✅ |
| **左滑** | dx=−180, dy=5 | → `DISMISSED` | ✅ |
| **阈值以下** | dx=40（< 72） | 未触发 | ✅ |
| **滚动干扰** | 四种手势全程 | `scrollY` 始终 `0 → 0` | ✅ 未干扰滚动 |

`TouchEvent` / `Touch` 构造函数在仿真环境下可用；事件在隔离世界的监听器能收到。

> **⚠️ 方法更正记录**：第一版触摸测试把"垂直手势"和"右滑"用在**同一行**，
> 读到的是右滑之后的状态，**无法区分垂直是否误触发**（判定错误地显示 FAIL）。
> 已改为**不同行 + 每次手势后单独读状态**。
> 这与本地测试时犯过的同类错误一致 —— 记下来避免再犯。

> **⚠️ 仿真局限**：合成 TouchEvent 不等于真实手指。**快速滑动、慢速滑动、
> 斜向滑动、滑动中途转向、点在链接上**这些必须真机验证。

---

## 6. Swipe 候选方案（设计，不实现）

规格已确定产品方向（右滑 → ⭐ 感兴趣、左滑 → × 不感兴趣），
**不需要重新做需求拷问**。下面是技术层面的候选设计。

### 6.1 现有实现（V1.0，可直接沿用）

```
横纵判定：|dx| > |dy| × 1.5
触发阈值：|dx| ≥ 72 px
视觉反馈：|dx| > 24 px 时显示方向类
监听：document 级，touchstart/touchmove 用 passive: true
不使用 touch-action: none
```

### 6.2 待真机标定的【实现候选】（**不是用户决策**）

| 编号 | 项目 | 当前值 | 说明 |
|---|---|---|---|
| M-001 | 横向判定比例 | `\|dx\| > \|dy\| × 1.5` | 需真机标定，防斜向误触 |
| M-002 | 触发距离阈值 | `72 px` | 需按 DPI / 屏幕宽度标定 |
| M-003 | 视觉反馈距离 | `24 px` | 纯视觉，可调 |
| M-004 | 是否加入速度判定 | 无 | 快速轻扫是否应触发，待定 |
| M-005 | 滑动中途改向的处理 | 每次 touchmove 重算 | 已有基础，待真机验证 |
| M-006 | 是否需 `preventDefault` | 否（passive） | 保持不禁用滚动 |

**这些数值全部标为【实现候选】，由真机测试确定，不伪装成用户决策。**

### 6.3 需要明确处理的边界

| 场景 | 期望 |
|---|---|
| 正常上下滚动 | 不触发滑动 ✓（已有守卫） |
| 点击 Topic 链接 | 不被吞、正常跳转 |
| 点在链接上再横向滑 | 应触发滑动，而不是打开链接 |
| 快速轻扫 | 待定 |
| 斜向滑动 | 按 6.1 的守卫判定 |
| **与浏览器/系统手势冲突** | **真机重点验证**（Android 边缘返回手势、下拉刷新） |
| 与 linux.do 移动端自定义行为冲突 | 真机验证 `uc-floating-dismiss-topics-on-mobile` |

---

## 7. 风险

| 级别 | 风险 | 说明 |
|---|---|---|
| **高** | **平台可行性未定** | 若目标移动浏览器**装不上扩展**，整个 V1.1 不成立。这是**必须先解决的问题**，优先于任何代码 |
| **中** | **触摸端无兜底入口** | 行内按钮 `display:none`，唯一入口是 Swipe。Swipe 失效即功能不可用 |
| **中** | **仿真 ≠ 真机** | 本轮全部触摸结论来自桌面 Chrome 仿真；真实手指、真实浏览器手势未验证 |
| **中** | **linux.do 移动端定制** | `uc-floating-dismiss-topics-on-mobile` 等站点自定义可能与 Swipe 冲突 |
| 低 | 窄屏导航遮挡 | 导航占视口约 37% 宽、左下 219px 高，不溢出但可能遮挡内容 |
| 低 | Discourse 移动模板变更 | 目前 DOM 与桌面一致，但站点升级可能改变 |
| 低 | Firefox 的 manifest 差异 | 可能需要 `browser_specific_settings.gecko_android` |

---

## 8. 是否需要修改架构

**不需要。**

理由（均有审计证据）：

1. **零浏览器专有 API** —— 全部能力基于 DOM / IndexedDB / fetch
2. **无 service worker** —— 正好避开 Firefox Android 的 MV3 缺口
3. **无 `permissions`** —— 避开 host permission 授权交互缺口
4. **移动 DOM 与桌面结构一致** —— 解析器、哨兵选择器无需改动
5. **Swipe 已经存在且在 V1.0 通过测试**

**可能需要的最小增量**（都不是架构改动）：

- manifest 增加 `browser_specific_settings.gecko_android.strict_min_version`（若选 Firefox）
- 触摸端的兜底操作入口（长按菜单？）—— 需产品决策
- Swipe 参数按真机标定

---

## 9. 下一步最小实现方案

**强烈建议顺序：先解决平台，再写代码。**

```
① 确定目标移动浏览器                    ← 最大未知量，必须先做
   ├─ Firefox for Android ≥128（扩展支持明确、MV3 缺口对本扩展不适用）
   ├─ 某个 Chromium 系 Android 浏览器（需先确认可用性与维护状态）
   └─ 若都不行 → V1.1 需要重新定义（例如不做扩展、改做别形态）
        ↓
② 真机加载 v1.0.0，验证"能不能跑"
   ├─ 扩展是否装上
   ├─ linux.do 是否正常打开
   ├─ 五区导航是否出现
   ├─ Topic 行是否被识别（30 行）
   └─ 账号身份是否识别
        ↓
③ 真机触摸行为标定
   ├─ M-001 ~ M-006 的数值
   ├─ 与系统手势冲突验证
   └─ 与 linux.do 移动定制冲突验证
        ↓
④ 触摸端兜底入口决策（产品问题，需你拍板）
        ↓
⑤ 才进入 Swipe 的实际调整与 V1.1 实现
```

**① 没解决之前，②③④⑤ 都可能是白做。**

---

## 10. 附带发现：一个 V1.0 的既有缺陷（与移动端无关）

侦察过程中发现，**桌面端同样存在**：

> **通过行内按钮或滑动标记 Topic 时，不会把解析器已经拿到的 `title` / `slug` 写进记录。**

证据：

```js
// content.js
async function markInterested(topic) {
  await window.LDFCPoolManager.markInterested(topic);   // ← 没有传 metadata
  ...
}
// poolManager.markInterested(topic, metadata = {})  → setPool(topicId, "INTERESTED", {})
// topicState.setPool: title: metadata.title ?? existing?.title ?? ""
```

而解析器给出的 `topic` 对象里**本来就有** `title` 和 `slug`。

**用户可见后果**：

```js
// ui/poolPanel.js
link.textContent = record.title || `Topic ${record.topicId}`;
```

→ 面板里显示 **"Topic 847468"** 而不是真实标题。

**影响范围**：对这些 Topic，如果它们随后出现在 `/latest.json` 第一页或 tracking 快照里，
元数据会被补上；**否则标题会永久退化成 ID**（例如置顶公告这类不在常规列表里的 Topic）。

**性质**：体验降级，**不是功能性错误**（面板有兜底、链接可点、状态正确）。
与移动端无关，桌面端一直存在。

**处理建议**：不要在 V1.0 上改。记为 **`1.0.1` 的候选修复**
（最小改动：`markInterested` 传 `{ title: topic.title, slug: topic.slug }`，并补一个回归测试）。

---

## 11. 本轮的方法错误记录（如实留档）

| # | 错误 | 后果 | 更正 |
|---|---|---|---|
| 1 | 移动仿真时覆盖 Android User-Agent | 与桌面 UA 签发的 cookie 不一致 → **触发 Cloudflare 人机验证**，首次侦察数据全部无效 | 改为不覆盖 UA，用 `?mobile_view=1` |
| 2 | 触摸测试把垂直手势与右滑用在**同一行** | 读到右滑后的状态，**无法区分垂直是否误触发**，判定错误显示 FAIL | 改为不同行 + 每次手势后单独读状态 |
| 3 | 清理用 `moveHome`（只改归属不删记录） | 真实账号库里留下残留记录 | 改为**按 id 从 IndexedDB 精确删除** |

**清理结果**：真实账号库现存 **7 条**，全部是使用者自己浏览产生的（13:05–14:02）；
本轮测试产生的记录（含上一轮遗留的 `847468`）**已全部删除**。

---

## 12. 本轮没有做的事（按约定）

| 项 | 状态 |
|---|---|
| 修改 V1.0 正式代码 | ❌ 未做 |
| 修改 `LDFC-V1-完整规格.md` | ❌ 未做 |
| 升级版本号 | ❌ 未做（仍 `1.0.0`） |
| 引入第三方服务 | ❌ 未做 |
| 改变"四池 + newReplyPending"状态模型 | ❌ 未做 |
| 重新进行 60 题产品拷问 | ❌ 未做 |
| 实现 Swipe 改动 | ❌ 未做（只侦察） |
