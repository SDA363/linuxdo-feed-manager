# LDFC Phase 0 — 真实站点验证报告

> **性质**：真实 Linux.do 上的只读技术侦察结果。
> **不是**需求文档，**不是**实现说明。产品行为以 `LDFC-V1-完整规格.md` 为准。
>
> 全文严格区分三类内容：
> - 【事实】= 在真实站点上直接观测到的
> - 【候选】= 实现方式，Phase 0 之后可以改
> - 【决策】= 用户已经拍板的产品行为，**任何情况下不得由实现方擅自修改**

- 报告日期：2026-09-20
- 对应代码版本：`0.3.0`（**本轮全程未在真实站点加载扩展**）
- 测试工具：`browser-lab/real-site-probe.js`、`real-site-flow.js`、`real-site-flow2.js`（均为只读诊断探针）
- 本地回归：37 / 37 通过，未因本轮验证改动任何正式代码

---

## 1. 测试环境

| 项 | 值 |
|---|---|
| 站点 | `https://linux.do` |
| 账号 | username `dsfg`，**user id `478515`** |
| Discourse 版本 | `2026.9.0-latest`（`meta[name=generator]`） |
| 主题 id | `105`，另有 linux.do 自定义：`<body class="uc-enable-new-checkbox-style uc-floating-dismiss-topics-on-mobile uc-modernize-foundation-theme">` |
| 浏览器 | Chrome 153，独立配置目录 `.ldfc-acceptance-profile`，CDP 端口 9223 |
| 页面类型 | 真实 Discourse SPA（`requirejs` / `Discourse` 全局存在） |
| 滚动容器 | **`<html>`**（`#main-outlet` 的 scrollHeight == clientHeight，不是滚动容器） |

## 2. 测试时间

2026-09-20（单次会话内完成；未做跨日复测）

## 3. 登录 / Guest 状态

**PASS**

| 观测 | 结果 |
|---|---|
| Cloudflare / 人机验证 | 【事实】**本轮全程未出现**，站点直接可达 |
| 未登录标识 | 【事实】`<html class="... anon ...">` |
| 登录后标识 | 【事实】`anon` class 消失 |
| `/session/current.json`（未登录） | 【事实】**404** |
| `/session/current.json`（登录） | 【事实】**200**，返回 `current_user.id = 478515`、`username = dsfg` |

【候选】当前实现用 `/session/current.json` 的数字 `id` 作为账号身份来源 —— **在真实站点成立**，无需修改。

### 3.1 头部兜底选择器失效

**FAIL**（次要，因为首选来源可用）

| 观测 | 结果 |
|---|---|
| `#current-user` 元素 | 【事实】**存在**（`<li class="header-dropdown-toggle current-user user-menu-panel" id="current-user">`） |
| `#current-user a[href*='/u/']` | 【事实】**不存在**。内部只有一个 `<button id="toggle-current-user">` + 头像 `<img>`；唯一的 `<a>` 是通知角标，`href="#"` |
| 用户名出现位置 | 【事实】只在头像 CDN 地址里：`https://cdn.ldstatic.com/user_avatar/linux.do/dsfg/96/...` |

→ 【事实】**当前 `site/identity.js` 里的 `probeHeader()` 在 linux.do 上永远返回 null，是死代码。**

【候选】更好的兜底源：`#data-preloaded` 里的 `currentUser`（真实存在，见 10.5）。头像 URL 解析可作第三级，但依赖 CDN 路径格式，较脆。

## 4. AC-014 结果：进入第一个未读位置

**PASS**（当前实现候选成立，且与原站机制等价）

【事实】

| 测试 | 结果 |
|---|---|
| `/t/topic/534735`（**不带**楼层号） | 落在**第 1 楼**，`scrollY = 0` → **原站不会自动跳到第一个未读** |
| `/t/topic/534735/31`（带楼层号） | 落在**第 31 楼**，`scrollY = 1006` ✓ |
| 原站 `/unread` 列表里的链接 | **自带楼层号**：`/t/topic/2743741/49`、`/t/topic/2830655/16`、`/t/topic/2736395/182` |
| timeline 里的原生入口 | 存在 `button.back-button`，title=「返回上一个未读帖子」，但**初次打开不显示**（滚动过未读位置后才出现） |

→ 【事实】**原站"跳到第一个未读"的实现方式就是链接 href 里的楼层号**，不存在一个"点一下自动跳"的按钮。

【候选】当前 `topicUnreadUrl()` 拼 `/t/<slug>/<id>/<lastRead+1>`，**与原站模式等价，不是自创机制**，可以保留。

【候选 · 可优化】从 `/unread` 列表进来的 Topic，其链接 **href 本身就已经是"第一个未读"的地址**，可以直接复用而不必自己算 —— 少一层推算，也更贴合"复用原站机制"。

【决策】不受影响。

## 5. AC-027 结果：SPA 路由

**PASS**

【事实】在主世界安装了 pushState / replaceState / popstate 记录器后，用**真实点击**观察：

| 操作 | 路由调用 | 是否同文档 |
|---|---|---|
| 列表 → Topic（点击标题） | **`pushState`** `/t/topic/847468` | `sameDocument: true` |
| Topic → 返回列表（浏览器后退） | **`popstate`** → `/latest` | `sameDocument: true` |
| `/latest` → `/top`（点击导航） | **`pushState`** `/top` | `sameDocument: true` |

→ 【事实】Discourse 的 SPA 切换**确实走 `pushState`**，且切换过程不重新加载文档。

→ 【候选】**主世界路由钩子（`site/routeObserverMain.js`）是必需的，且确实有拦截点** —— 当前实现方向正确，不需要修改。

`replaceState` 本轮未观测到调用（可能是滚动位置记录等低频场景）。

**MutationObserver 覆盖动态插入**：**NOT TESTED**（本轮未加载扩展，无法观测扩展自身的 observer 行为）。

## 6. AC-029 结果：自动补位

**PASS**（机制已摸清；参数仍属实现候选）

【事实】`.load-more-sentinel` **真实存在**：`<div aria-hidden="true" class="load-more-sentinel">`

| 滚动次数 | 触发请求 | 行数变化 |
|---|---|---|
| 第 1 次滚到底 | `/latest.json?no_definitions=true&page=1` | 30 → 59 |
| 第 2 次滚到底 | `/latest.json?no_definitions=true&page=2` | 59 → 89 |
| 第 3 次滚到底 | `/latest.json?no_definitions=true&page=3` | 89 → 119 |

- **每次滚动恰好 1 个请求**，每页 **30 条**
- 3 次滚动 = 3 个请求，无重复、无并发
- 触发条件：`.load-more-sentinel` 进入视口

【事实】**哨兵位于文档最底部**（哨兵 `top = 2650`，视口高 752，文档高 2752）→ 要触发原站加载，**必然要把页面滚到底部**。

【候选 · 需要改】当前 `core/autofill.js` 用 `scrollIntoView({block:"end", behavior:"smooth"})` 触发补位。在真实站点上这意味着**用户正在看上面时，页面会自己猛滚到最底部**。这不符合"尽量模拟真实用户正常浏览行为"。

可选方向（尚未定，属实现候选）：
- 只在用户已接近底部时才补位；
- 或直接用 `more_topics_url` 请求下一页并本地插入（但这是自建请求模式，需权衡）；
- 或干脆只做"当前已加载数据内补位"，把跨页补位交给用户自己的滚动。

【事实】当前参数 `2 页 / 3 秒` 与真实站点行为**不冲突**（真实站点每次请求只拉 1 页），但它仍然只是保守初值，**不是产品要求**。

## 7. AC-031 结果：原站兼容性

**PASS**（未加载扩展时；加载扩展后的复测见第 13 节）

【事实】

| 项目 | 结果 |
|---|---|
| Topic 点击 | ✓ 进入 `/t/` |
| Ctrl+Click | ✓ 开新标签页，原页仍留在 `/latest` |
| 鼠标中键 | ✓ 开新标签页，原页仍留在 `/latest` |
| 作者链接点击 | 弹出 **Discourse 用户卡片**，不跳转（`navigatedToUserPage: false`，`userCardShown: true`）—— 这是原站自身行为，本轮未加载扩展 |
| 前进 / 后退 | ✓（见 C2：`popstate` 正常） |
| 刷新 | ✓（流程中多次 `goto` 均正常） |
| 分页 / 无限滚动 | ✓（见第 6 节） |
| 分类点击 / 搜索 | 搜索页可达，分类未逐项点击（**PARTIAL**） |

【候选】作者链接会弹用户卡片，意味着扩展在行内注入按钮时**不能拦截该区域的点击**，也不能插到会挡住用户卡片的位置。

**AC-032 搜索结果不过滤：PASS（由结构保证）**

【事实】

| 选择器 | 搜索结果页命中数 |
|---|---|
| `.fps-result`（真实结果容器） | **50** |
| `.search-result` | 0 |
| `.topic-list-item` | **0** |
| `[data-topic-id]` | 50 |

→ 【事实】搜索结果用 `.fps-result`，**不带 `.topic-list-item` 类**。
→ 【事实】**插件的行选择器在搜索页匹配 0 行** —— 也就是说"搜索结果不过滤"是**结构性保证**，不依赖我们额外加的页面守卫。

→ 【候选】当前的双重保护（页面守卫 + 选择器天然不命中）可以保留。额外的好处是：不需要为搜索页写特例，也不会因为站点改版而突然开始过滤搜索结果。

## 8. Guest fallback 结果

**PARTIAL**（匿名可用字段已确认；"是否需要两轮同步"已由事实回答）

【事实】匿名态下各字段可用性：

| 字段 / 接口 | 匿名 | 登录 |
|---|---|---|
| `/latest.json` | ✅ 可用，30/页 | ✅ 可用，30/页 |
| `/unread.json` | ❌ **403** | ✅ 可用，30/页，带 `more_topics_url` |
| `highest_post_number` | ✅ **有值**（如 6226） | ✅ 有值 |
| `last_read_post_number` | ❌ null | ⚠️ 多数为 null（见 10.3） |
| `unread_posts` | ❌ null | ⚠️ 多数为 null（见 10.3） |
| `/t/<id>.json` 的阅读字段 | ❌ **键根本不存在** | 未复测 |

【事实】**匿名唯一可用的阅读相关字段就是 `highest_post_number`。**

→ 【候选】当前 Guest fallback 的方向（用 `highest_post_number` 与本地基线比较）**是匿名态下唯一可行的方案**，没有更可靠的原生替代。
→ 【事实】"两轮同步"的**根因确认存在**：匿名没有 `last_read_post_number`，无法一次确定"从哪开始算新"，必须先建立一个基线。
→ 【候选】基线其实可以在**用户点「⭐ 感兴趣」的那一刻**就写入（此时可从当前列表数据拿到 `highest_post_number`），从而把"两轮"压缩成"一轮"。属于可选优化，**不是产品要求**。

## 9. 多账号结果

**NOT TESTED**

原因：验证需要**登出当前账号、再登录另一个账号**，这需要用户本人操作（我不接触登录凭据）。

已知事实（从第 3 节）：真实站点上 `/session/current.json` 返回稳定数字 id（`478515`），足以支撑账号命名空间隔离。

→ 建议由用户手动完成：`登出 → 确认落到 guest 空间 → 登录账号 B → 确认 B 有独立空间 → 切回账号 A → 确认 A 的状态完好`。

## 10. 真实站点字段清单

### 10.1 `/latest.json`

30 条/页，`per_page: 30`，`more_topics_url: /latest?no_definitions=true&page=1`。

字段含：`id`、`slug`、`title`、`fancy_title`、`category_id`、`last_poster_username`、`excerpt`、`highest_post_number`、`last_posted_at`、`bumped_at`、`posts_count`、`posters`、`tags`、`pinned`、`unseen`、`bookmarked`、`notification_level` 等。

> 【候选】当前 `normalizeTopic()` 用到的字段（`id` / `slug` / `title` / `category_id` / `last_poster_username` / `last_read_post_number` / `highest_post_number` / `unread_posts` / `last_posted_at` / `excerpt`）**全部存在于真实响应中** ✓

### 10.2 `/unread.json`

【事实】登录后可用，30 条/页，`more_topics_url: /unread?page=1`。

### 10.3 ⚠️ 关键事实：列表里的未读字段大面积缺失

【事实】登录状态下，`/latest.json` 第一页 30 条 Topic 中：

| 字段 | 有值 | null |
|---|---|---|
| `unread_posts` | **2** | **28** |
| `last_read_post_number` | **2** | **28** |
| `notification_level` | **2** | **28** |

且当页 **没有任何一条 Topic 带未读**（`withUnreadCount: 0`）。

原因（Discourse 机制）：这些字段只在**用户对该 Topic 存在 TopicUser 记录**（读过 / 关注过）时才返回，否则为 `null`。

→ 【事实】**当前 `core/poolManager.js` 的 `syncWithDiscourse()` 依赖 `topic.unreadPosts > 0` 来标记新回复，在 `/latest` 上的命中率极低。**

→ 【候选 · 需要改】新回复标记的主数据源应当是：
1. `/unread.json`（原站直接给出"我当前有未读的 Topic"），或
2. 页面已有的 `topicTrackingStates`（见 10.5，零请求）
  
`/latest.json` 只适合做**元数据更新**（标题、回复数、最后活动），不适合做新回复判定。

### 10.4 ⚠️ `/unread.json` 有分页上限

【事实】`/unread.json` 只返回 **30 条**，并给出 `more_topics_url: /unread?page=1`。

→ 【候选 · 需要改】**当前 `syncUnreadTopics()` 把"Topic 不在未读列表里"直接判定为"本轮新回复已处理完"并清除新回复状态。** 若用户的未读 Topic 超过 30 条，第 2 页及以后的 Topic 会被**误判为已处理**，从而被错误地从「新回复」区移除。

这是一个**正确性风险**，不只是性能问题。

可选方向（属实现候选）：
- 只对"确认在未读列表里出现过"的 Topic 应用"消失即完成"的判定；
- 或结合 `topicTrackingStates`（本地可算未读）交叉验证；
- 或对不在列表里的 Topic 追加一次 `/t/<id>.json` 确认（有请求成本）。

### 10.5 ✅ `#data-preloaded` → `topicTrackingStates`（零请求的未读数据源）

【事实】`<script type="application/json" id="data-preloaded">` 存在，内容 457KB，顶级键含
`topic_list`、`site`、`siteSettings`、`currentUser`、**`topicTrackingStates`**、`topicTrackingStateMeta`、`banner` 等。

【事实】**这些值是"被 JSON 编码过的字符串"，需要二次 `JSON.parse`。**

【事实】`topicTrackingStates` 是 **210 行**数组，每行字段：

```
topic_id, highest_post_number, last_read_post_number, created_at,
category_id, is_category_topic, notification_level,
created_in_new_period, treat_as_new_topic_start_date, tags
```

- **没有 `unread_posts` 字段** → 未读需要自己算：`highest_post_number - last_read_post_number`（`last_read > 0` 时）
- **32 行有阅读位置，且这 32 行全部有未读**
- 样例：topic `534735` → `last=26 / highest=185` → 未读 159；topic `2736395` → `last=181 / highest=200` → 未读 19
- `notification_level` 可用（`2` = 跟踪）

【事实】`topicTrackingStateMeta` 是一组 channel 位置（如 `{"/latest":3428900,"/unread":1329104,"/unread/478515":3149}`），不是计数。

→ 【候选 · 值得采用】这是**页面已经加载好的、针对当前用户跟踪 Topic 的未读状态**，读取它**不需要任何额外请求**，完全符合"优先使用当前页面已经加载的数据"和"被动发现优先"。

代价与限制：
- 它是**页面加载时的快照**，之后靠 MessageBus 增量更新（扩展不订阅就不会自动刷新）；
- 只覆盖预加载的那一批（本次 210 行），不等于全站；
- 在非列表页（如 Topic 详情页）是否也存在，**尚未验证**。

### 10.6 其他

- 【事实】Topic URL 的 slug 是**字面量 `topic`**（`/t/topic/847468`、`/t/topic/534735/31`），不是标题 slug。当前的 `parseTopicUrl()` 与 `topicUnreadUrl()` 都能兼容。
- 【事实】`/t/<id>.json`（匿名）对 5975 楼的大帖返回 `post_stream.stream`（5975 个楼层 ID）+ 仅 **20 条** `posts` 窗口 → 【候选】"跨窗口时按 `stream[lastRead]` 补取单楼"这条候选**是必需的**。
- 【事实】`meta[name=csrf-token]` 不存在（`csrfPresent: false`）。

## 11. 当前实现与真实站点的差异

| # | 项 | 当前实现 | 真实站点 | 性质 |
|---|---|---|---|---|
| 1 | 身份兜底：头部选择器 | `#current-user a[href*='/u/']` | **该元素不存在**，永远为 null | 死代码 |
| 2 | 身份首选 | `/session/current.json` | ✅ 可用，返回数字 id | 一致 |
| 3 | 新回复判定主源 | `/latest.json` 的 `unread_posts` | 28/30 为 null | 数据源选错 |
| 4 | 未读列表清除判定 | 不在 `/unread.json` 即视为已处理 | 列表**有 30 条分页上限** | 正确性风险 |
| 5 | 自动补位触发 | `scrollIntoView` 滚动哨兵 | 哨兵在文档底部 | UX 问题 |
| 6 | 行选择器 | `.topic-list-item[data-topic-id]` | ✅ 精确命中 30 行 | 一致 |
| 7 | 跳第一个未读 | 拼 `/t/<slug>/<id>/<last+1>` | ✅ 与原站 href 模式等价 | 一致 |
| 8 | SPA 路由 | 主世界 pushState 钩子 | ✅ 确实走 pushState | 一致 |
| 9 | 搜索页不过滤 | 页面守卫 + 选择器不命中 | ✅ 结构性不命中 | 一致（双保险） |
| 10 | 匿名 fallback | `highest_post_number` vs 本地基线 | ✅ 匿名唯一可用字段 | 一致 |
| 11 | 补位哨兵选择器 | `.load-more-sentinel` | ✅ 存在 | 一致 |
| 12 | 滚动容器 | 未显式依赖 | `<html>` 是滚动容器 | 一致 |

## 12. 需要修改的【实现候选】

按优先级（**均不涉及产品决策，也不在本轮执行**）：

| 优先级 | 候选 | 原因 | 建议方向 |
|---|---|---|---|
| **P0** | 新回复判定数据源 | `/latest.json` 未读字段 28/30 为 null，当前逻辑近乎失效 | 主用 `/unread.json`；并考虑 `topicTrackingStates` 做零请求交叉验证 |
| **P0** | 「不在未读列表 = 已处理完」的清除逻辑 | `/unread.json` 有 30 条分页上限，会误清 page 2+ 的 Topic | 只对"曾在未读列表出现过"的 Topic 应用；必要时追加单帖确认 |
| **P1** | 自动补位触发方式 | `scrollIntoView` 会把用户页面猛滚到底部 | 只在用户接近底部时补位，或改用 `more_topics_url` |
| **P1** | 身份兜底选择器 | `#current-user a[href*='/u/']` 在 linux.do 不存在 | 改用 `#data-preloaded` 的 `currentUser`（注意二次 parse） |
| **P2** | 复用原站未读链接 | `/unread` 列表链接自带第一个未读楼层号 | 有 href 时直接复用，不再自己推算 |
| **P2** | 匿名基线写入时机 | 当前要"两轮同步"才能判定 | 在用户点「感兴趣」时就用列表数据写入基线，压缩成一轮 |

### 原候选 → 真实站点发现 → 新候选 → 为什么

**候选 1：新回复判定数据源**
- 原候选：读 `/latest.json` 的 `topic.unread_posts > 0`
- 真实站点发现：登录后 30 条里 28 条的 `unread_posts` 是 `null`；当页 0 条带未读。该字段只在用户有 TopicUser 记录时返回
- 新候选：以 `/unread.json` 为主判定源，`/latest.json` 降级为纯元数据同步；可叠加 `topicTrackingStates`
- 为什么：原候选在真实数据上命中率过低，功能会表现为"几乎从不标记新回复"

**候选 2：新回复完成判定**
- 原候选：Topic 不在 `/unread.json` 里 ⇒ 本轮新回复已处理完，清除暂态
- 真实站点发现：`/unread.json` 返回 30 条并给出 `more_topics_url`，说明**存在分页上限**
- 新候选：把"不在列表"的判定限制在"曾经在未读列表中被观测到"的 Topic 上，避免把 page 2+ 的 Topic 误判成已完成
- 为什么：原候选在未读数 > 30 时会**错误地清掉**新回复提醒，属于正确性缺陷而非体验问题

**候选 3：自动补位触发**
- 原候选：`scrollIntoView({block:"end"})` 让 `.load-more-sentinel` 进入视口以触发原站加载
- 真实站点发现：哨兵位于文档最底部（top 2650 / 视口 752），触发它必然把页面滚到底
- 新候选：待定（只在用户接近底部时补位 / 或有限使用 `more_topics_url`）
- 为什么：会让用户正在浏览的页面自己跳到底部，打断阅读

**候选 4：身份兜底**
- 原候选：`#current-user a[href*='/u/']` 解析用户名
- 真实站点发现：`#current-user` 内**没有任何 `/u/` 链接**，只有一个 button 和一个头像 `<img>`；用户名字面量只出现在头像 CDN 路径里
- 新候选：改用 `#data-preloaded` 的 `currentUser`（含数字 id，比用户名更稳定）
- 为什么：原候选在 linux.do 上恒为 null

## 13. 不需要修改的部分

以下经真实站点验证**方向正确，建议保持不动**：

- ✅ 账号身份首选 `/session/current.json` 的**数字 id**
- ✅ SPA 路由用**主世界 pushState/replaceState 钩子**（真实站点确实走 pushState）
- ✅ 行选择器 `.topic-list-item[data-topic-id]`（真实 DOM 精确命中 30 行，正确忽略 30 个嵌套标题链接）
- ✅ 跳第一个未读用 `/t/<slug>/<id>/<lastRead+1>`（与原站 href 模式等价）
- ✅ 匿名 fallback 用 `highest_post_number`（匿名唯一可用字段）
- ✅ 搜索结果不过滤（结构性不命中 `.fps-result` 布局）
- ✅ 补位哨兵选择器 `.load-more-sentinel`（真实存在）
- ✅ 本地 37 项回归基线（本轮未改动任何正式代码，无需重跑）

## 14. 尚未验证的项目

| 项 | 原因 |
|---|---|
| **AC-030 无高频轮询 / 无逐 Topic 请求** | 需要加载扩展后做长时间请求计数 |
| **AC-034 分批渲染 / 各池独立滚动位置** | 需要加载扩展后验证 |
| **扩展在真实站点上的整体行为** | 本轮全程**未加载扩展**（刻意如此，先拿纯事实基线） |
| **MutationObserver 对动态插入 Topic 的覆盖** | 同上 |
| **Topic 详情页是否存在 `topicTrackingStates`** | 未在详情页复采 |
| **多账号隔离（第 9 节）** | 需要用户手动登出 / 登录第二个账号 |
| **登录态的 `/t/<id>.json` 阅读字段** | 本轮只在匿名态采过 |
| **分类页 / 标签页的 DOM 与接口** | 只验证了 `/latest`、`/top`、`/unread`、`/search`、Topic 详情 |
| **原站兼容项在加载扩展后的复测** | 第 7 节的 PASS 是"未加载扩展"的基线 |

## 15. 风险与建议

### 风险

1. **【高】新回复功能在真实站点上可能"看起来没坏，其实几乎不工作"**
   `syncWithDiscourse` 依赖的 `unread_posts` 在真实 `/latest` 上 28/30 为 null。
   本地 fixture 里这个字段是齐的，所以 **37 项全绿完全掩盖了这个问题**。

2. **【高】误清新回复状态**
   `/unread.json` 有 30 条分页上限，而清除逻辑把"不在列表"当成"已完成"。
   未读数超过 30 的用户会看到新回复提醒莫名消失。

3. **【中】自动补位打断阅读**
   触发哨兵必然把页面滚到底部。

4. **【低】身份兜底失效**
   首选来源可用，仅在接口被拦时才会暴露；但那正是兜底存在的意义。

5. **【中】本地 fixture 与真实 DOM 的形状差异被低估**
   真实站点一个 Topic 有 **2 个** `data-topic-id` 元素（行 + 嵌套标题链接），fixture 只有 1 个。
   本次插件选择器侥幸正确，但说明 **fixture 的保真度需要提升**，否则类似问题还会以别的方式出现。

### 建议

1. **先改 P0 两项，再谈其他。** 它们影响的是"功能是否真的能工作"，不是体验。
2. **修 fixture 保真度**：让本地 probe 页的 Topic 行也带嵌套 `a.raw-topic-link[data-topic-id]`，
   并把 `/latest.json` 的 `unread_posts` 改成"多数为 null"，让回归测试能覆盖真实数据形状。
   —— 这是让 37 项基线**真正有意义**的前提。
3. **P0 修完后，必须加载扩展在真实站点上重跑第 7 节与第 14 节**，并补 AC-030 / AC-034 的实测。
4. **多账号（第 9 节）需要用户配合**，建议在下一轮开始前先做掉。
5. 本轮**未修改任何正式代码**；`real-site-probe.js` / `real-site-flow.js` / `real-site-flow2.js` 为只读诊断探针。
