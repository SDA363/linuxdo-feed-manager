# LDFC 预览引擎接入与 Dock 结果

> 轮次目标：按用户要求「直接照搬本地增强阅读脚本的预览」，
> 把预览正文换成原脚本引擎，并把操作入口做成预览窗下方的无底色图标 dock；
> 预览窗从被点击的标题位置展开。
>
> **版本号未变**：`1.1.1`（本轮是预览层实现修正，不改产品语义、不加新功能面）。

---

## 一、改动清单

| 文件 | 改动 |
|---|---|
| `vendor/linuxdo-enhanced-reading.js` | **新增**。`脚本\linuxdo增强阅读脚本.md`（作者 Fashion，**MIT**，v1.8.7）解码后 vendor 进来，顶部保留归属说明 |
| `manifest.json` | 在 `ui/launcher.js` 之后、`ui/preview.js` 之前加载 vendor |
| `ui/preview.js` | 预览正文改走 `window.LDFCEnhancedPreview`；新增 `animateFromSource()` FLIP 转场；旧窗口保留为 `openLegacy()` 兜底 |
| `ui/launcher.js` | 新增 `createDock()` / `DOCK_STYLE` / `DOCK_ICONS`；预览窗按钮从 `.ldp-head-btns` 改挂 `.ldp-overlay > .ldfc-preview-dock`；首楼 `ACTIONS_STYLE` 改成图标 + 悬停展开 |
| `interaction/desktopActions.js` | 列表行悬停按钮改成同一套图标 + 文字展开结构 |
| `styles/content.css` | `ldfc-has-dock` 时 overlay 改纵向布局、modal 让出 dock 高度；dock 入场动画；列表行胶囊与图标样式；`prefers-reduced-motion` 收敛 |
| `browser-lab/probe-server.js` | 新增 `/n/-/<id>.json`，让引擎的楼中楼接口在本地 fixture 上可跑 |
| `browser-lab/run-ui-acceptance.js` | [12]/[13] 按新结构重写；UI 验收 56 → 60 项 |
| `browser-lab/run-userscript-smoke.js` | 新增「油猴版点标题弹引擎预览」一项；5 → 6 项 |
| `README.md`、`docs/LDFC-V1-完整规格.md`、`docs/LDFC-实现状态.md`、`browser-lab/README.md` | 同步当前行为、测试项数与 vendor 说明 |

---

## 二、实现要点

### 1. 预览正文 = vendored 引擎

- 只删掉原脚本第 15 节「拦截标题点击」，改为暴露：

```js
window.LDFCEnhancedPreview = {
  open(topicId, targetPostNumber = 0) { /* ... */ },
  close() { /* ... */ },
  get overlay() { return CURRENT_OVERLAY; }
};
```

- 因此楼中楼、点赞、回复、Boost、书签、图片灯箱、楼层滑块全部是原脚本的实现，
  插件不再维护第二套简化正文。
- `ui/preview.js` 只负责「何时弹窗」：开关、搜索页不接管、Ctrl/Cmd/Shift/Alt/中键放行、
  先关掉第三方脚本已弹出的窗口。
- 引擎缺失时 `openLegacy()` 仍可出窗（旧的 `/t/<id>.json` + `posts.json` 分批补楼），
  这条兜底路径在验收里单独覆盖。

### 2. 从标题位置展开（FLIP）

- 先让引擎同步插窗，再量 `.ldp-modal` 的真实矩形，把被点击标题的矩形换算成
  `translate + scale` 作为首帧，460ms `cubic-bezier(0.32,0.72,0,1)` 回落到 `none`；
  overlay 另有 200ms 轻淡入；`prefers-reduced-motion: reduce` 时跳过。
- 首帧不透明度必须够高（**0.92**，最初写成 0.18）：0.18 看起来是「淡入」，
  看不出「从标题长出来」，这是第一版被判断成「没做动画」的主要原因。
- 排查入口：`window.__ldfcOpenAnim` 记录本次是否跳过动画及原因
  （`no-source` / `reduced-motion` / `no-modal` / `zero-size` / `animate-failed`），
  `skipped === null` 表示动画真的跑了。
- 验收用 `Element.prototype.animate` 钩子（装在**插件隔离世界**，主世界装不上）取证：
  实测首帧 `translate(-201px, 63.875px) scale(0.12565625, 0.04)`，时长 `460/200`，
  起点矩形 `{left:11, top:88, width:126, height:21}`。

### 3. 窗口下方无底色 dock

```
.ldp-overlay
├── .ldp-modal            ← 引擎自己的 header/body/footer（5 个底部按钮保持原样）
└── .ldfc-preview-dock    ← 影子 DOM：⭐ / ✓ / ×，42px，无池子配色
```

- 默认只露单色图标；悬停时图标 360° 旋转 + `scale(1.06)`，标签 `max-width 0 → 140px` 横向展开；
  移开收回。
- 实测：默认 `width 42px / background rgba(0,0,0,0) / label opacity 0`；
  悬停 `width 119px / label opacity 1`；移开 `42px / 0`。
- 点击按钮不会冒泡成「点遮罩关闭」（捕获计数 0），标记成功后由 `afterMark` 主动关窗。

### 4. 三处入口统一图标语言（列表行 / 首楼 / 预览 dock）

旧版列表行与首楼是三块彩色 pill（绿 / 蓝 / 红）。现在四处共用同一套：

| 位置 | 默认 | 悬停 |
|---|---|---|
| 列表行悬停（`interaction/desktopActions.js` + `content.css`） | 中性半透明胶囊，只有 ⭐ / ✓ / × 图标 | 图标旋转 360°，文字横向展开 |
| Topic 页首楼（`ui/launcher.js` `ACTIONS_STYLE`） | 同上，图标右侧带池子计数 | 同上 |
| 预览窗 dock（`ui/launcher.js` `DOCK_STYLE`） | 深色玻璃胶囊，单色图标 + 计数 | 同上 |

- 颜色一律 `inherit` + 中性 `rgba(127,127,127,…)`，亮色/暗色主题都不用各写一套；
  图标统一 `fill:none; stroke:currentColor; stroke-width:1.8`。
- 实测：首楼按钮 `32px → 74px`（悬停展开），列表行按钮 `32px → 74px`；
  dock `42px → 119px`。

### 5. 二级界面（信息池面板 / 设置面板）

这两个面板原本用的是**浏览器原生白底按钮**（`#e9ecef` 底 + 黑字），在深色玻璃面板上非常突兀。
本轮只改 `styles/content.css`，不动 DOM 与交互：

| 元素 | 之前 | 现在 |
|---|---|---|
| 设置面板按钮（导出/导入/清理/测试连接/授权/清除凭据） | 白底黑字、7px 圆角 | 半透明幽灵按钮（`rgba(255,255,255,.06)` + 细边框），hover 提亮，`active` 缩放 0.985 |
| 主操作（保存配置 / 立即同步） | 同上，无层次 | 浅色实心 + 深色字，和其余按钮拉开 |
| 排序切换（最近加入 / 最近活动） | 亮黄色实心 `.active` | 中性分段控件，`.active` 用 `rgba(255,255,255,.16)` |
| 池子卡片 | 纯色块 | 12px 圆角 + 1px 细边框，hover 时轻微提亮 |
| 池子计数 | 亮黄色数字 | 中性小胶囊 |
| 「移回主信息流」 | 白底黑字 | 描边幽灵胶囊，hover 提亮 |
| 输入框 | 只有 focus 边框变色 | focus 加 3px 蓝色光晕，背景略提亮 |
| 面板本身 | 纯色 + 阴影 | 1px 细边框 + 玻璃模糊 + 内侧高光 + 细滚动条 |

证据：本地 fixture 截图（池子面板 6 条 / 设置面板含云同步段）已人工核对；
样式相关的自动化断言没有新增（视觉判断仍以人工截图为准，避免把"看起来对不对"写成 PASS）。

---

## 三、本轮抓到并修掉的真问题

**油猴版整包中断**：vendored 引擎原本在 IIFE 顶层执行
`document.head.appendChild(style)`；扩展侧的 content script 是 `document_idle`，head 一定存在，
所以没问题。但油猴产物是 `document-start` 注入，此时 `document.head` 还是 `null`，
抛错会让**拼接进去的后续所有模块**（预览、面板、content）一个都不执行，
表现为「五区导航都不出现」。

```
FAIL：等待 #ldfc-navigation 可见超时（15s）
```

修法（只改 vendored 那一处，其他不动）：

```js
const mountStyle = () => {
  const host = document.head || document.documentElement;
  if (!host) return false;
  if (!style.isConnected) host.appendChild(style);
  return true;
};
if (!mountStyle()) document.addEventListener('DOMContentLoaded', mountStyle, { once: true });
```

修复后油猴冒烟 6/6，并新增一项「油猴版点标题弹出引擎预览」防止回归。

---

## 四、验收结果（本轮实跑，非沿用旧数字）

```
browser-lab/run-ui-acceptance.js      63 / 63 通过
browser-lab/run-ldfc-acceptance.js    76 / 76 通过
browser-lab/run-sync-acceptance.js    37 / 37 通过
browser-lab/run-userscript-smoke.js    6 / 6  通过
tools/test-sync-model.js              26 / 26 通过
tools/test-sync-service.js            52 / 52 通过
tools/test-webdav-transport.js        16 / 16 通过
tools/test-sync-settings.js           13 / 13 通过
-----------------------------------------------
合计                                 289 项，0 项失败
```

构建：`node tools/build-userscript.js`（26 个脚本 + 1 个样式，388.4 KB）、
`node tools/build-firefox-ext.js`（33 个文件，`onlyManifestDiffers: true`）。

---

## 五、没验证到的（不要误读成 PASS）

| 项目 | 状态 |
|---|---|
| 真实 linux.do 上引擎预览的完整渲染（图片、代码块、楼中楼分页、灯箱） | **NOT TESTED** |
| 真实站点「本插件 + 原增强阅读脚本同时启用」的观感 | **NOT TESTED** |
| 真实 Android / Firefox 上的 dock 悬停与触摸 | **NOT TESTED**（桌面 Chrome 头less 环境实测） |

本地 fixture 里 `/n/-/<id>.json` 返回的是扁平 topic JSON，走引擎的
`standardTopicToNestedTree()` 兼容分支；**「评论」标题下同时出现「暂无评论」占位**
就是这条兼容分支的产物（`ctx.totalComments` 未被累加），真实站点返回嵌套树时不会走到。
本轮不为它改引擎，如实记录为 fixture 限制。

### 看不到展开动画时的排查顺序

1. **扩展是否重新加载**：改源码后必须到 `chrome://extensions` 点一次「重新加载」，
   否则页面里跑的还是旧 content script（旧版本根本没有这段动画）。
2. **系统是否关了动画**：Windows「设置 → 辅助功能 → 视觉效果 → 动画效果」关闭时，
   Chrome 会返回 `prefers-reduced-motion: reduce`，插件按无障碍规范直接显示窗口。
   在页面控制台执行 `matchMedia("(prefers-reduced-motion: reduce)").matches` 看一眼。
3. **直接看证据**：点开一次预览后，在控制台执行 `__ldfcOpenAnim`：
   - `{skipped: null, from: {...}, duration: 460}` → 动画跑了，`from` 就是标题的位置矩形；
   - `{skipped: "reduced-motion"}` → 被系统设置跳过；
   - `{skipped: "no-source"}` → 这次没有拿到标题矩形（例如由脚本直接调 `open()`）。

---

## 六、已知观察（不阻塞，未修）

1. **引擎会向站点上报阅读进度**：vendored 引擎自带 `createReadTracker()`，
   滚动预览窗时会 `POST /topics/timings`。这是原脚本的既定行为（也正是它能
   「读后回原池」的原因），但和上一版插件自带预览窗**行为不同**：
   以前预览不写站点已读。真实站点上的互动效果需要真机确认。
2. **夹具 meta 文案**：fixture 的 topic JSON 没有 `posts_count` / `views`，
   预览 meta 会显示「undefined 帖 · 0 浏览」。这是夹具缺字段，不是产品缺陷；
   真实站点这两个字段一定存在。
3. ~~**`ldfc-has-dock` 的窗口高度**~~：**已在 2026-11-01 轮解决** —— dock 移进
   `.ldp-body`（主贴下方），overlay 不再改成纵向布局，modal 回到引擎自己的 90vh，
   见下一节。

---

## 七、发布前状态

- 版本：`1.1.1`（未改）
- 四池 + `newReplyPending` 状态模型：未改
- IndexedDB 结构：未改
- 同步逻辑：未改
- 未提交 Git、未推送

---

## 八、2026-11-01 增量：dock 移到主贴下方 + 小助手工具 + 悬停预取

> 目标（用户原话）：预览窗打开帖子「不是秒开」要优化；悬浮按钮放到**主贴下方**；
> 再加上「linux.do 小助手」脚本的 `当前查看楼主 / 当前查看全部`、`💾 保存到本地`、`🖼️ 保存为图片`。
> 版本号仍未变（`1.1.1`）。

### 1. 改动清单

| 文件 | 改动 |
|---|---|
| `ui/launcher.js` | dock 挂载点从 `.ldp-overlay` 子节点改为 `.ldp-modal > .ldp-body`（主贴之后、评论标题之前）；dock 影子树里新增第二排 `.tools`（只看楼主 / 保存到本地 / 保存为图片）；新增 `applyOnlyOp()` / `setOnlyOp()` / `loadPrefs()` / `runSave()` |
| `ui/previewExport.js` | **新增**。`saveHtml()`（图片内联 base64 + 下载 `.html`）与 `saveImage()`（html2canvas → PNG） |
| `ui/preview.js` | 新增悬停预取：`pointerover`（90ms 意图延迟）/ `pointerout`（真离开链接才取消）/ `pointerdown`（触摸与快速点击）→ `LDFCEnhancedPreview.prefetch(id)` |
| `vendor/linuxdo-enhanced-reading.js` | `fetchNestedTree()` 加 60 秒 / 12 条 LRU 缓存；`LDFCEnhancedPreview` 暴露 `prefetch(topicId)` |
| `vendor/html2canvas.min.js` | **新增**。v1.4.1，MIT，本地分发，不引 CDN |
| `manifest.json` | 在 `ui/launcher.js` 之前插入 `vendor/html2canvas.min.js` 与 `ui/previewExport.js` |
| `styles/content.css` | 删掉 `.ldp-overlay.ldfc-has-dock` 的纵向布局与 modal 高度覆盖；新增 `.ldp-body > .ldfc-preview-dock` 间距与入场动画 |
| `browser-lab/run-ui-acceptance.js` | dock 断言改成"在 `.ldp-body` 内、主贴后、评论前"；新增工具排 / 只看楼主 / 预取命中 / HTML+PNG 产出 4 组断言 → 63 项变 69 项 |
| `browser-lab/run-userscript-smoke.js` | dock 选择器跟随新结构（仍 6 项） |

### 2. 打开速度：优化了什么，没优化什么

打开一次预览原有两段**串行**往返：

```
1) /t/<id>.json?track_visit=true   ← 取 last_read，决定跳到第几楼
2) /n/-/<id>.json?sort=old         ← 取嵌套树，画正文
```

本轮把第 2 段提前到**悬停**（90ms 意图延迟）或**按下鼠标**时发起，进 60 秒缓存；
点开时直接命中，串行链只剩第 1 段。本地实测：悬停后 `/n/-/102.json` 请求 1 次，
点开后**不再增加**（0 次）。

**没有做的事（如实记录）**：

- 第 1 段 `/t/<id>.json?track_visit=true` **故意不预取**：`track_visit` 会写站点阅读记录，
  悬停就上报会污染真实账号的已读状态，违反"不改用户已读"的底线。
- 因此"预取后点开"仍有一次往返；要彻底消除需要改引擎的阅读进度上报时序，
  风险高于收益，本轮不做。

### 3. 「只看楼主」的实现边界

- 判据是引擎每层的 `.ldp-op` 徽标（楼主的回帖也带），不是"第 1 楼之后全隐藏"。
- 引擎懒加载的新评论会被 `refresh()` 重新套用筛选（`MutationObserver` 去抖 120ms）。
- **已知局限**：如果一个非楼主楼层下面挂着楼主的楼中楼，整棵子树会一起隐藏
  （和参考脚本按 `article` 整体隐藏的行为一致）。
- 状态存 `LDFCDB.putMeta("previewOnlyOp")`，与参考脚本用 `localStorage` 不同（插件统一走 IndexedDB）。

### 4. 保存内容 = 主贴（1 楼）

和参考脚本一致：只存一楼正文，不存整个评论列表。
理由是整帖截图在几百楼的帖子里会超出浏览器画布上限并卡死页面。

### 5. 本轮证据

```
run-ui-acceptance     69 / 69 PASS   （新增：工具排 / 只看楼主 2→1→2 / 预取命中 / HTML 1022 字节 / PNG 32743 字节）
run-ldfc-acceptance   76 / 76 PASS
run-sync-acceptance   37 / 37 PASS
run-userscript-smoke   6 / 6  PASS
tools 单测           107 / 107 PASS（26 + 52 + 13 + 16）
────────────────────────────────
合计                 295
```

### 6. 未验证项（NOT TESTED）

- **真实 linux.do 上的保存结果**：`html2canvas` 对跨域图片（linux.do 的 CDN 图）在
  真实站点上是否会被 CORS 挡住、导出图片是否缺图 —— 本地 fixture 只有内联文字，测不到。
- **真实站点"秒开"体感**：预取只证明"少一次请求"，实际延迟取决于用户网络到 linux.do。
- **超长主题的截图**：本轮只截一楼，未验证一楼本身超长（> 20000px）时的表现。

---

## 九、2026-11-01 增量二：按楼层跳转 + 小助手 A1 / B2 / B3 / B4

本轮只做用户点名的五项，不碰四池 + `newReplyPending`、NEW_REPLY、IndexedDB、同步逻辑。

### 1. 改动清单

| 文件 | 改动 |
|---|---|
| `vendor/linuxdo-enhanced-reading.js` | 新增 `CURRENT_CTX` / `CURRENT_HIGHEST`；对外暴露 `jumpTo(postNumber)` / `highest()` |
| `ui/preview.js` | 新增 `postNumberFrom(anchor)`；`open(topicId, targetPostNumber, anchor)` 把楼层号透传给引擎 |
| `ui/previewExport.js` | `contentRoot` → `opRoot` 并导出；`saveHtml` / `saveImage` 改成接收 `root` 而不是 overlay（真实帖子页复用同一套导出） |
| `ui/launcher.js` | 工具排从 3 个扩到 5 个（新增「展开楼中楼」「随机跳楼」）；真实 Topic 页也挂工具排；`onlyOp` 按场景拆成 `preview` / `topic` 两份状态 |
| `ui/listMeta.js` | **新文件**：列表页主题创建时间 + 三档着色 |
| `manifest.json` | 在 `ui/previewExport.js` 之后插入 `ui/listMeta.js` |
| `content.js` | `decorateRows()` 里补一次 `LDFCListMeta.render()` |
| `styles/content.css` | 新增 `.ldfc-topic-created` / `.is-old` / `.is-ancient` |

### 2. 实现要点

**按楼层跳转**

- 引擎本来就支持 `openModal(topicId, targetPostNumber)`，问题只在
  `ui/preview.js` 一直传 0 —— 带楼层号的链接会被当成"打开主题"处理。
- `postNumberFrom()` 只认 `/t/(slug/)?<id>/<floor>`，站外链接直接返回 0。
- 目标楼已渲染 → `locatePost` 平滑滚动 + `.ldp-flash` 高亮 1.7 秒；
  未渲染 → `/t/<id>.json?post_number=N` 拉以目标为中心的窗口。

**真实 Topic 页工具排（A1）**

- 只看楼主判据对齐小助手脚本：`#post_1[data-user-id]` vs 每层 `article[data-user-id]`，
  隐藏 `article.closest(".topic-post")`。认不出楼主就整段不动。
- 保存导出首楼 `.cooked`；`NOISE_SELECTORS` 增加 `.ldfc-reader-actions` /
  `.ldfc-topic-actions-row` / `.save-buttons-container`，导出文件里不带我们自己的按钮。

**展开楼中楼（B2）**

- 依次点掉 `.ldp-load-more-replies`，最多 40 次；引擎点击时会立刻 `disabled = true`，
  所以 180ms 的轮询不会重复发请求。

**随机跳楼（B3）**

- 在 `2 ~ highest()` 之间随机（跳过 1 楼主贴）；`jumpTo()` 能跳就原地滚，
  跳不过就按楼层号重开预览。小助手原脚本是整页跳转，这里改成预览内跳。

**列表创建时间（B4）**

- 只读 `data-created-at` / `data-topic-created-at` / `td.age[title]` 里的「创建日期：…」；
  **不读 `data-bumped-at`** —— 那是最后活动时间，冒充创建时间语义就错了。
- 分档：≤30 天 `is-fresh`、30~90 天 `is-old`、>90 天 `is-ancient`。

### 3. 本轮抓到并修掉的真问题

1. **fixture 的 `/t/<id>/posts.json` 把 topicId 当 postId** —— `singlePostJson(102)`
   算出 `post_number=102`，随机跳楼后渲染出一个不存在的第 102 楼。
   产品逻辑没受影响，但测试证据是脏的。改成解析 `post_ids[]`。
2. **fixture 的 children 接口只返回"剩余回复"** —— 引擎 `loadAllChildren`
   会先清空子树再整体重渲染，只给 4、5 会把已经显示的第 3 楼弄丢。
   改成返回全部直接回复（3、4、5），与真实接口一致。
3. **`ui/listMeta.js` 无条件重写 DOM** —— `decorateRows` 自己挂在 MutationObserver 上，
   `render → mutation → decorateRows → render` 会每 100ms 空转一次。
   改成值没变就不写（和 `applyPreviewOnlyOp` 的处理一致）。

### 4. 本轮证据

```
run-ui-acceptance     75 / 75 PASS   （新增：首楼工具排 3 / 预览工具排 5 / 真实页只看楼主 / 真实页保存 / 按楼层跳转 / 随机跳楼 / 展开楼中楼 / 列表创建时间）
run-ldfc-acceptance   76 / 76 PASS
run-sync-acceptance   37 / 37 PASS
run-userscript-smoke   7 / 7  PASS   （新增：油猴版预览工具排 5 个按钮）
tools 单测           107 / 107 PASS（26 + 52 + 13 + 16）
────────────────────────────────
合计                 302
```

产物：

- `dist/ldfc.user.js` 618.9 KB（29 个脚本 + 1 个样式）
- `dist/linuxdo-feed-manager-firefox-1.1.1.zip` 198443 字节 / 36 文件，`onlyManifestDiffers: true`

### 5. 未验证项（NOT TESTED）

- **真实站点首楼的 `article[data-user-id]` 结构**：只看楼主在真实页上的判据未实测。
- **真实站点列表的创建时间来源**：`data-created-at` 是否存在、`td.age[title]`
  是否含「创建日期」都未实测；都不存在时表现为"不显示"（不会显示错误时间）。
- **真实长楼的楼号空洞**：删除楼层导致 `post_number` 不连续时，
  `resolveTargetPostNumber` 会退到最近可见楼层 —— 该分支只在单测/fixture 语义上验证过。
- **真实站点的随机跳楼体感**：本地 fixture 只有 6 层，几百层主题的实际滚动表现未测。

## 十、2026-11-01 增量三：二级面板同源展开 + 云同步说明 + 预取节流

### 1. 改了什么

1. **二级面板（信息池 / 设置）从导航面板的位置放大展开**
   - `ui/navigation.js` 新增 `sheetSourceRect()`（展开态取 `.ldfc-nav-panel`，
     收起态取 `.ldfc-nav-fab`）、`setSheetOrigin()`（按中心点写
     `--ldfc-sheet-ox/-oy`）、`revealSheet()`、`hideSheet()`，并挂到
     `window.LDFCNavigation`。
   - `ui/poolPanel.js`：切到 HOME 用 `hideSheet()` —— 必须**立即** `hidden`，
     面板是右侧固定区，留一层透明元素会拦住整块点击；`render()` 先记
     `reopening = panel.hidden`，只在两个出口对「隐藏 → 可见」调用
     `revealSheet()`，所以排序 / 标记之后的原地重绘不会反复播放动画。
   - `ui/settings.js`：`toggle()` 改判 `opening = panel.hidden`，
     互斥收起走 `hideSheet()`，渲染完再 `revealSheet()`。
   - `styles/content.css`：`transform-origin: var(--ldfc-sheet-ox, 100%)
     var(--ldfc-sheet-oy, 0%)`；`transition: transform 460ms
     cubic-bezier(0.32,0.72,0,1), opacity 240ms …`；
     `[data-sheet-state="closed"]` 为 `scale(0.62); opacity: 0`；
     `prefers-reduced-motion` 降到 1ms。参数与导航面板完全一致。
2. **云同步「?」内置说明**
   - 标题行右侧 18px 圆形「?」，`aria-expanded` / `aria-controls` 同步，默认 `hidden`。
   - 6 步：注册坚果云 → 建同步目录 → 填 `https://dav.jianguoyun.com/dav/<目录>/`
     （写明不要复制 `www.jianguoyun.com/#/...` 网页链接）→ 账号填登录邮箱 →
     应用密码在「账户设置 → 安全选项」生成、只显示一次 → 授权域名后先
     「测试连接」再保存。
   - 末尾注明同步文件按 Linux.do 账号区分（`ldfc-<账号>.json`），
     两台设备必须登录同一账号。
3. **预取节流**：`PREFETCH_DELAY` 90 → 160ms，新增 `PREFETCH_MIN_GAP = 500`；
   非 `force` 时冷却期内直接 return；`onPointerDown` 传 `force = true`，
   真正点击不会被冷却拖慢。

### 2. 请求量实测（本地 fixture，**不是**真实站点统计）

```js
{ listLoad:   { total: 3, byPath: { "/session/current.json": 1, "/latest.json": 1, "/unread.json": 1 } },
  backToList: { total: 4, byPath: { "/session/current.json": 2, "/latest.json": 1, "/unread.json": 1 } },
  hoverSweep: { rows: 5, nestedRequests: 1, byPath: { "/n/-/105.json?sort=old": 1 } } }
```

- 列表页 3 个 JSON，其中 `/latest.json` 与 `/unread.json` 是站点自己的列表页也会用的接口。
- 悬停扫过 5 行只发 1 个 `/n/-/`（冷却生效；改前每行一个），不发 `/t/<id>.json`。
- `/t/<id>.json` 只在「新回复」面板打开（串行、间隔 ≥1200ms、每次最多 10 条）
  和「真正点开预览」时出现。
- 插件自身代码没有轮询定时器；vendored 引擎里的 2 个 `setInterval`
  是阅读计时 tick 与本地 flush，不发网络请求。

### 3. 验收（本轮实跑）

```
run-ui-acceptance     85 / 85 PASS   （新增：二级面板逐帧放大 / 终态 / 贴着一级面板定位 / 动画速度倍率 / 收起立即隐藏 / 云同步「?」说明 / 地址即时校验 ×2 / 速度滑杆 ×2）
run-ldfc-acceptance   76 / 76 PASS
run-sync-acceptance   37 / 37 PASS
run-userscript-smoke   7 / 7  PASS
tools 单测           107 / 107 PASS（26 + 52 + 13 + 16）
────────────────────────────────
合计                 312
```

产物：`dist/ldfc.user.js` 636.2 KB（29 脚本 + 1 样式）、
`dist/linuxdo-feed-manager-firefox-1.1.1.zip` 203919 字节 / 36 文件。

### 4. 未验证 / 已知边界

- 展开动画的**观感**只能人眼判断；自动化只断言 `state / duration / origin / opacity`。
- 「?」说明里的坚果云菜单路径以网页版为准，客户端不同版本文案可能略有差异。
- 请求量：真实站点只统计了**游客态**（见本节 5）；登录态的请求数仍未统计。

### 5. 同日复测：真实站点反馈后修掉的两个问题

**问题 1：真实站点上二级面板没有动画，直接在右边出现。**

原因：`hidden = false` 与「缩起 → 展开」写在同一帧，Chrome 把它们合并成一次样式更新，
CSS transition 根本不会触发；本地测试只断言了最终态（`state=open`、`opacity=1`），
所以「没有动画」也能 PASS —— 测试设计本身有漏洞。

修法：`revealSheet()` 改用 Web Animations（`element.animate`，
`scale(0.62) → scale(1)` + `opacity 0 → 1`，460ms 同一 easing，`fill: both`，
播完 `cancel()`；`hideSheet()` 取消未播完的动画）。`settings.toggle()` 收起时也走
`hideSheet()`，不再直接写 `hidden` 留下 `data-sheet-state` 残留。
测试改成**逐帧采样**：必须出现 `scale < 0.95` 的中间帧才 PASS。

真实站点实测（游客态，`https://linux.do/latest`）：

```
scale: 0.620 → 0.730 → 0.883 → 0.948 → 0.973 → 0.986 → 0.993
opacity: 0 → 0.289 → 0.691 → 0.864 → 0.929 → 0.962 → 0.981
transform-origin: -820.872px 577.818px   （球所在位置）
```

**问题 2：WebDAV 地址填错要等点「保存配置」才报错。**

改成输入时即时校验（`input` / `blur`）：地址乱码、缺 `http(s)://`、坚果云网页链接
都在输入框下方立刻出红字，并给输入框加红边框 + `aria-invalid="true"`；
改正后提示自动消失。`saveConfig()` 复用同一个校验函数，保持单一真相。

**真实站点请求实测（2026-11-01，游客身份）**

```
列表页加载（插件自己发的 2 个）：
  GET /session/current.json   1
  GET /latest.json            1
  （未登录不请求 /unread.json）
同一次加载里站点/Cloudflare 自身另有 4 个请求：/srv/pv、/cdn-cgi/rum、2 个 challenge 相关

悬停 5 行（每行停留 0.5 秒，不点击）：
  GET /n/-/<id>.json?sort=old  5   （悬停预取，一行一个）

静置 20 秒：
  0 个请求   → 真实站点上也没有轮询
```

结论：列表页与正常用户基本持平（2~3 个 XHR，且都是站点自己的接口）；
额外开销集中在「悬停预取」和「点开预览」这两个用户主动动作上。
**登录态的请求数没测** —— lab profile 在 linux.do 上已经是游客。

### 6. 用户反馈第二轮：面板位置 + 动画速度

用户反馈两件事：①动画确实从球的位置放大，但人眼分辨不出；②他要的是
**二级面板贴着一级面板**，而不是钉在屏幕右缘（他的 DevTools 占了大半屏，
视口只剩 ~330px，旧实现 `right:16px` 直接把面板挤到左侧，看起来像"在右边/中间"）。

改动：

1. `positionSheet()`（`ui/navigation.js`）：一级面板在左半边就放它右边、
   右半边就放它左边；上半屏顶对齐、下半屏底对齐；两侧都放不下时退化成
   "盖在一级面板上"，仍然贴着它。`revealSheet()` 先定位再算缩放原点；
   球被拖动结束 / 窗口缩放时，已经打开的面板跟着挪。
2. `#ldfc-panel` / `#ldfc-settings` 补 `box-sizing: border-box` ——
   `width` 是内容宽度、`padding: 16px` 再加 32px，窄窗口下会溢出视口 22px。
3. 设置面板新增**动画速度**滑杆（`#ldfc-anim-speed`）：0.1× ~ 2×，
   **步进 0.1**（0.2 的档位会跳过 1.0× 正常速度，所以没有照抄 0.2），
   默认 1.0×，存 IndexedDB `meta.animSpeed`。一级面板把时长写进
   `--ldfc-nav-dur` 等 CSS 变量；二级面板按倍率算 Web Animations 的 duration
   （0.5× → 460ms / 0.5 = 920ms，自动化断言实测 920）。

窄窗口实测（Chrome 视口 500×569）：

```
一级面板   left=16   right=230
二级面板   left=242  right=488   （间距 12，右侧留白 12，不溢出）
```

未验证：真实 linux.do 上"贴着一级面板"的肉眼观感（游客态只验证了动画与请求数）；
速度倍率目前只作用于一级 / 二级面板，预览窗的 FLIP 转场没有接。

### 7. 用户反馈第三轮：关闭按钮 / 收起动画 / 启动形态

用户反馈四件事（原话要点）：

> 二级面板还是不太对，除了设置其他二级都没有关闭按钮，现在关闭得切换到设置的二级
> 才有关闭按钮；设置的动画效果消失是一下子消失的，不是收回球的；
> 把默认显示球和默认显示一级面板做成可以切换的功能；做五版球图标图片。

改动：

1. `ui/poolPanel.js`：信息池每个池子的标题行右侧加 `#ldfc-panel-close`，
   点击 = 回主信息流 + 收起面板（走下面的动画），不再需要切到设置。
2. `ui/navigation.js`：`hideSheet()` 从"直接 hidden"改成**朝源收缩**：
   终点缩放 = 源（展开时一级面板 / 收起时悬浮球）尺寸 ÷ 面板尺寸，
   360ms、同一条 `cubic-bezier(0.32,0.72,0,1)`，受动画速度倍率影响；
   收起途中 `pointer-events: none`，结束后才 `hidden = true`；
   收起期间再次 `render()` 会反转成展开（`data-sheet-state="closing"` 也视为需要展开）。
   `revealSheet()` 的起点同样改成按源尺寸算，不再是写死的 `scale(0.62)`。
3. 设置 → 阅读体验加「启动时显示」（`#ldfc-start-mode`，一级面板 / 悬浮球），
   存 `meta.navStartMode`；首帧先隐藏导航直到读出该值，避免"只留球"档位先闪面板。
4. 设置面板的 × 原来只有 class 没有 id，自动化点不到 —— 本轮补 `id="ldfc-settings-close"`，
   于是「关闭设置」这条路径第一次被真正断言（此前是 `?.click()` 空转）。

本轮实跑（干净 profile，扩展 + 本地 fixture）：

```
run-ui-acceptance     92 / 92 PASS  （85 → 92：四池关闭按钮 / 收起 360ms 与缩放终点 /
                                     收起结束才隐藏 / 设置关闭动画 / 启动形态切换 / 刷新持久化）
run-ldfc-acceptance   76 / 76 PASS
run-sync-acceptance   37 / 37 PASS
run-userscript-smoke   7 / 7  PASS
tools 单测           107 / 107 PASS（26 + 52 + 13 + 16）
────────────────────────────────
合计                 319，0 失败
```

产物：`dist/ldfc.user.js` 644.8 KB（29 脚本 + 1 样式）、
`dist/linuxdo-feed-manager-firefox-1.1.1.zip` 206143 字节 / 36 文件。

未验证：真实 linux.do 上的收起观感（本地 fixture 只能断言时长 / 缩放 / 状态）；
球图标的最终选择还没定 —— 候选图见 `docs/LDFC-悬浮球图标候选.png`（5 版，
现状是 ① 三层堆叠）。

## 十一、2026-11-01 增量四：三行图标 / 池子 toggle / 池间移入 / 长按多选

用户决策（原话要点）：

> 选择信息流三行图标；现在只有设置二级面板有点击展开再点击收起的操作逻辑，
> 其他面板也要同步；给信息池加入可以移入其他信息池的选项；这个操作可以多选；
> 主页面、搜索界面、话题拉到底的推荐和相关也要有悬浮按钮；
> 按住悬浮按钮，抖动后即可点击悬浮按钮进行多选移入任意池子，**不要多一个按钮**。

### 1. 改了什么

1. **球图标**换成「信息流三行」（三条横线 + 右侧圆点）。圆点必须内联
   `style="fill:currentColor;stroke:none"`，否则 `.ldfc-nav-fab-glyph{fill:none}` 会把它吃掉。
2. **池子按钮 toggle**：再点一次当前已打开的池子＝收起，与设置按钮同一套判断
   （`activePool === 目标 && !hidden && state !== "closing"`）；点别的池子仍是直接切换。
3. **池内移入其他池**：`poolManager.moveToPool(id, pool, metadata)` + `canMoveTo(id, pool)`；
   面板里每条记录多一个 `[移入…]`，展开成胶囊行（不用 `<select>`——弹层会被面板
   `overflow:auto` 裁掉）。目标列表排除当前池；`NEW_REPLY` 只接受
   `INTERESTED` / `READ`，其余来源按钮禁用并写明原因。
4. **长按多选**（`interaction/multiSelect.js`，新文件）：
   `pointerdown` 500ms → 整组按钮 `ldfc-shake` 抖一下 → `html.ldfc-selecting`；
   多选期间 capture 阶段拦 `click`，点行按钮只勾选；点导航池子 = 批量
   `moveToPool` 后退出。Esc / Toast「退出」/ 路由变化都会清空选择。
   `IGNORE_CLICK_MS = 400` 用来吞掉长按松手时浏览器补发的那次 click。
5. **覆盖到搜索页 / 推荐 / 相关**：`site/topicParser.js` 新增 `ROW_SELECTOR` 与
   `listRows()`（`.fps-result` / `.search-result` / `.more-topics__list-item` /
   `.suggested-topics [data-topic-id]` 等）；`content.js` 的 `decorateRows()`
   不再对搜索页和话题页提前 return，但**自动补位仍然只在主信息流触发**。
6. `manifest.json` 在 `desktopActions.js` 之后加载 `multiSelect.js`；
   `desktopActions.createActionLayer()` 末尾 `bindLongPress(layer)`。
7. **池内多选**：信息池面板里长按任意一条记录（按钮区以外）500ms → 进入多选，
   标题行换成「已选 N / 移入… / 完成」，点记录勾选，再从胶囊行选目标池批量移入。
   进入入口仍是长按，不新增常驻按钮。面板行用 `data-ldfc-panel-topic` 而不是
   `data-topic-id` —— 后者会被 `decorateRows()` 当成站点列表行（加 `ldfc-topic-row`、
   按池隐藏、再注入一套行按钮），这是本轮实际踩到并修掉的回归。

### 2. 同时修掉的实现细节

- TR 行的按钮层挂到第一个 `td/th`：挂在 `<tr>` 上会让 `position:absolute` 的定位基准
  变成整张表，按钮跑到表格左上角。
- 判断"这行已经有按钮层"从 `:scope > .ldfc-actions` 改成 `.ldfc-actions`：
  挂载点下沉到单元格后，直接子代选择器永远选不到，会重复注入。
- `rowOf(layer)` 用 `closest("[data-topic-id]")`，兼容 `tr[data-topic-id]` 与 `li`。

### 3. 本轮实跑（干净 profile，扩展 + 本地 fixture）

```
run-ui-acceptance    101 / 101 PASS  （92 → 101：池子 toggle / 移入菜单 / 移入已读 /
                                     长按进入多选 / 勾选两行 / 批量移入 READ）
run-ldfc-acceptance   77 / 77 PASS  （76 → 77：搜索页按钮 + 真实点击标记）
run-sync-acceptance   37 / 37 PASS
run-userscript-smoke   9 / 9  PASS  （7 → 9：长按多选 / 批量移入已读）
tools 单测           107 / 107 PASS（26 + 52 + 13 + 16）
────────────────────────────────
合计                 331，0 失败
```

产物：`dist/ldfc.user.js` 669.4 KB（30 脚本 + 1 样式）、
`dist/linuxdo-feed-manager-firefox-1.1.1.zip` 214773 字节 / 37 文件
（除 manifest 外与 Chrome 源码逐字节一致）。

### 4. 未验证项（NOT TESTED）

- **真实 linux.do 的长按 / 多选 / 批量移入（列表页与池面板两种）**：只在 fixture 上验过，
  真实站点的行结构、`tr` 复用、站点自身 `contextmenu` 行为都可能不同。
- **触屏长按**：只有桌面指针模拟（`pointerType: "mouse"`），
  没有 `pointerType: "touch"` 的真机证据；与页面纵向滚动的手势竞争未测。
- **真实搜索页 / 推荐 / 相关区块**是否都命中 `ROW_SELECTOR` 未在真实站点核对。
- 多选徽标 `.ldfc-select-count` 在真实站点上的层级遮挡未测。
