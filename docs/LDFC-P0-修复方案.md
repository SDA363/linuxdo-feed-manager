# LDFC P0 修复方案

> **本文只是方案，尚未修改任何正式代码。**
> 全文严格区分三类内容：
> - 【事实】= 真实 linux.do 上直接观测到的
> - 【候选】= 实现方式，可以改
> - 【决策】= 用户已拍板的产品行为，**不因实现困难而修改**
>
> 依据：`LDFC-Phase0-真实站点验证报告.md`、本轮追加的 P0 证据采集
> （`browser-lab/real-site-p0-evidence.js`，约 10 次只读请求）。
> 产品规格 `LDFC-V1-完整规格.md` **无需任何改动**。

---

## 1. P0-1 真实证据

### 1.1 【事实】`/latest.json` 的未读字段大面积缺失

登录态下 `/latest.json` 第一页 30 条：

| 字段 | 有值 | null |
|---|---|---|
| `unread_posts` | 2 | **28** |
| `last_read_post_number` | 2 | **28** |
| `notification_level` | 2 | **28** |

当页带未读的 Topic 数：**0**。

原因：这些字段只在用户对该 Topic 存在 TopicUser 记录时才返回。

→ 当前 `syncWithDiscourse()` 用 `topic.unreadPosts > 0` 标记新回复，**在真实站点上几乎不可能触发**。

### 1.2 【事实】`#data-preloaded` 里的 `topicTrackingStates` 语义与 `/unread.json` **完全一致**

两者交叉验证（同一次页面加载）：

| 指标 | 值 |
|---|---|
| `topicTrackingStates` 总行数 | 195（上一次采样是 210，**会变**） |
| 其中算出未读 > 0 的行 | **32** |
| `/unread.json` 第 0 页条数 | **30** |
| 两者交集 | **30** |
| **只存在于 `/unread.json`、不在 tracking** | **0** |
| 只在 tracking、不在 `/unread` 第 0 页 | 2 |
| 抽样比对条数 | 8 |
| **未读数 / 阅读位置 / 最高楼层 不一致的条数** | **0** |

抽样明细（全部精确相等）：

```
id 2736395  tracking 19  = api 19   last 181 = 181   highest 200 = 200
id 2743741  tracking 74  = api 74   last  48 =  48   highest 122 = 122
id 2756196  tracking 48  = api 48   last  66 =  66   highest 114 = 114
id 2781486  tracking 120 = api 120  last  68 =  68   highest 188 = 188
id 2830655  tracking 96  = api 96   last  15 =  15   highest 111 = 111
id 2843463  tracking 163 = api 163  last   5 =   5   highest 168 = 168
id 2846243  tracking 1   = api 1    last  72 =  72   highest  73 =  73
id 2876334  tracking 13  = api 13   last   4 =   4   highest  17 =  17
```

结论：
- tracking **不是** `/unread.json` 的残缺子集，而是**超集**（32 ⊇ 30）
- 字段语义**完全一致**（未读 = `highest_post_number - last_read_post_number`，`last_read > 0` 时）
- tracking **没有 `unread_posts` 字段**，必须自己算

### 1.3 【事实】tracking 在**所有路由**都存在，且内容相同

| 路由 | `#data-preloaded` | tracking 行数 | 有未读行数 |
|---|---|---|---|
| `/latest` | 有 | 195 | 32 |
| `/top` | 有 | 195 | 32 |
| `/unread` | 有 | 195 | 32 |
| `/c/develop`（分类页） | 有 | 195 | 32 |
| `/t/534735`（Topic 详情页） | 有 | 195 | 32 |

→ 【事实】tracking **不是"当前列表页的局部数据"**，而是当前用户的全局跟踪快照，在任意页面都能读到。
→ 【事实】**Topic 详情页也有** —— 意味着在详情页也能零请求判断未读。

### 1.4 【事实】读 tracking 需要二次 JSON 解析

`#data-preloaded` 是 `<script type="application/json">`，其 `textContent` 是 JSON；
但 **`currentUser` 与 `topicTrackingStates` 的值本身又是 JSON 字符串**，需要再 `JSON.parse` 一次。

### 1.5 【事实】tracking 的时效性限制

- 它是**整页加载时的快照**。SPA 内部导航（pushState）不会重新生成它 —— 上面 5 个路由读到的是同一份数据（都是 195/32）。
- 行数在两次采样间从 210 变成 195，说明它是**有界的窗口**，不是"用户全部跟踪 Topic"。
- **未验证**：当用户未读 Topic 数远超这个窗口时（例如几百条），tracking 是否仍然覆盖。

## 2. P0-1 候选方案

### 候选 A：读 `#data-preloaded` 的 `topicTrackingStates`

- 优点：**零额外请求**；任意路由可用；语义已验证与 `/unread.json` 完全一致；是 `/unread.json` 第 0 页的超集
- 缺点：整页加载时的快照，SPA 内导航后会变旧；覆盖范围有界（未验证大未读量下的表现）

### 候选 B：继续用 `/unread.json`，但补上分页

- 优点：实时、权威
- 缺点：每多一页多一个请求；用户未读 300 条时就是 10 个请求 → 违反"低请求"原则

### 候选 C：通过主世界脚本读取 Discourse 的 `topic-tracking-state` service

- 思路：扩展已经有一个主世界脚本（`site/routeObserverMain.js`）。可以让它用 `requirejs` 取到 Discourse 的 tracking service，再把结果转发给隔离世界。
- 优点：**实时**（Discourse 用 MessageBus 维护，新回复会实时更新）；不受预加载快照的时效限制
- 缺点：依赖 Discourse 内部对象结构，站点升级可能失效；改动最大；本轮**未验证**该 service 的可达性

### 候选 D：对 pending Topic 逐个用 `/t/<id>.json` 确认

- 优点：**权威、定向**（只查关心的那几个 Topic）；已验证登录态下返回 `last_read_post_number` + `highest_post_number`
- 缺点：每 Topic 1 个请求

## 3. P0-1 最终推荐方案

**分层组合，不是单选：**

```
第 1 层（零请求，主源）  #data-preloaded 的 topicTrackingStates
                          → 覆盖"标记新回复"的绝大多数场景
                          → 在任意路由都可用

第 2 层（实时补充）      /unread.json 第 0 页
                          → 自然时机（路由变化后的同步）拉一次，弥补快照的时效性

第 3 层（定向确认）      /t/<id>.json
                          → 只用于"某个 pending Topic 到底读完没有"
                          → 有次数上限 + 节流
```

理由：

1. **第 1 层直接命中问题的根因。** 当前失败是因为数据源选错（`/latest.json` 的 `unread_posts` 在真实站点上 28/30 为 null）。tracking 在同一时刻给出 32 条未读，且与 `/unread.json` 逐字段一致 —— 这是**已验证的事实**，不是推测。
2. **不把 tracking 当成唯一真相。** 它是快照、有界，所以保留 `/unread.json` 做实时补充。
3. **第 3 层只在需要"确认某个具体 Topic 已完成"时才发请求**，请求量正比于新回复 Topic 数（通常个位数），不随历史池大小增长。
4. **候选 C 暂不采用。** 它可能更好（实时），但本轮没验证 Discourse 内部对象是否可达。建议**先记入 Backlog**，等第 1+2+3 层实测出现"时效性不够"的具体问题时再评估。不为了可能的收益先引入对内部结构的依赖。

### 对"移除对 `/latest.json` 未读字段的依赖"的说明

【候选变更】`syncWithDiscourse()` 不再用 `topic.unreadPosts` 判定新回复，
`/latest.json` **降级为纯元数据同步**（标题、slug、最后回复人、最后活动时间、`highest_post_number`）。

【事实】这不是"降低功能"，而是"换到真实可用的数据源"。产品行为不变。

## 4. P0-2 真实证据

### 4.1 【事实】`/unread.json` 确实有分页，且本账号已越界

| 页 | 条数 | `more_topics_url` |
|---|---|---|
| 第 0 页（`/unread.json`） | **30** | `/unread?page=1` |
| 第 1 页（`?page=1`） | **2** | `null` |
| 第 2 页（`?page=2`） | 0 | `null` |

页间无重叠（`overlap0and1: 0`），分页机制正常。

→ 【事实】该账号未读 Topic **恰好 32 条**，而第 0 页只给 30 条。
→ **当前实现会对那 2 个 Topic 误判为"已处理完成"并清除新回复状态 —— 不是假设，是当前可复现的缺陷。**

### 4.2 【事实】`/t/<id>.json`（登录态）可以定向确认

对 tracking 里两个有未读的 Topic 各请求一次：

| 字段 | topic 534735 | topic 2736395 |
|---|---|---|
| `last_read_post_number` 键存在 | ✅ | ✅ |
| 值 | 34 | 181 |
| `highest_post_number` | 185 | 200 |
| **`unread_posts` 键存在** | ❌ **不存在** | ❌ **不存在** |
| `notification_level` | null | null |

→ 【事实】登录态下 `/t/<id>.json` **给出 `last_read_post_number` 与 `highest_post_number`**，未读需自算 `highest - last`。
→ 【事实】它**不提供 `unread_posts`** —— 当前 `fetchTopicReadState()` 读 `payload.unread_posts` 会永远拿到 `0`（次要 bug，一并修）。

## 5. P0-2 候选方案

### 候选 A：给 `/unread.json` 翻页直到找到目标 Topic 或翻完

- 缺点：用户未读几百条时请求数线性增长，违反"低请求、不高频扫描"的【决策】

### 候选 B：废弃"不在列表就清除"，改为**只标记、不自动清除**

- 优点：绝不误清，改动最小
- 缺点：Topic 读完后新回复提醒不会消失，**违反【决策】"unread=0 立即移出新回复区"**

### 候选 C：只对 pending Topic 定向确认（`/t/<id>.json`）

- 优点：请求量正比于**新回复 Topic 数**（个位到几十），与历史池规模无关；权威
- 缺点：每个仍待确认的 Topic 一次请求

### 候选 D：用 tracking 快照做零请求预筛 + 候选 C 兜底

- 思路：先看 tracking
  - tracking 里该 Topic 未读 > 0 → **确定还没读完**，跳过，不发请求
  - tracking 里该 Topic 存在且未读 = 0 → **确定读完了**，清除，不发请求
  - tracking 里**没有**该 Topic → 无法判断 → 才走候选 C 的定向请求
- 优点：绝大多数情况零请求；只在 tracking 覆盖不到时才发请求
- 缺点：依赖 tracking 的覆盖面（已证实是 `/unread.json` 第 0 页的超集，但不保证无限）

## 6. P0-2 最终推荐方案

**候选 D（tracking 预筛 + 定向确认兜底），明确禁止候选 A。**

具体规则：

```
对每个 newReplyPending 的 Topic：

  1. tracking 里未读 > 0        → 保持 pending，不发请求
  2. tracking 里存在且未读 == 0 → 清除 pending，不发请求
  3. tracking 里查不到          → 走定向确认（/t/<id>.json，算 highest - last）
                                  受"每 Topic 最多 N 次 + 全局节流"约束

  永不使用：不在 /unread.json 第 0 页 ⇒ 已处理完成
```

理由：

1. 直接消除误清：判定依据从"某分页列表里没有"换成"这个 Topic 自己的阅读位置"，语义正确。
2. 请求量有界：第 3 条只对 tracking 覆盖不到的 pending Topic 生效；且已有 `VISIT_MAX_CHECKS = 3` 这一现成的次数上限模式可以复用。
3. 符合【决策】"只有 Discourse 自己确认已经处理完本次未读内容，才从新回复区移除" —— 定向确认正是"确认"，而"不在第 0 页"不是。

## 7. P0-3 Fixture 改造方案

**目标不是"让当前代码通过"，而是"让真实站点已经暴露的错误，在 fixture 上也会失败"。**

现有 fixture 与真实站点的差距（已实测）：

| # | 真实站点 | 当前 fixture | 影响 |
|---|---|---|---|
| 1 | 一个 Topic 有 **2 个** `data-topic-id`（行 + 嵌套 `a.title.raw-link.raw-topic-link`） | 只有行有 | 选择器误选风险无法暴露 |
| 2 | `table.topic-list > tbody.topic-list-body > tr.topic-list-item` | 结构过简 | 层级假设无法暴露 |
| 3 | `/latest.json` 中 **28/30** 的 `unread_posts`/`last_read_post_number` 为 null | 全部有值 | **P0-1 无法暴露** |
| 4 | `#data-preloaded` 含 `topicTrackingStates`（值二次编码） | 不存在 | 新数据源无法测试 |
| 5 | `/unread.json` **30 条分页 + `more_topics_url`** | 一次全返回 | **P0-2 无法暴露** |
| 6 | slug 是字面量 `topic`（`/t/topic/847468`） | 用了标题 slug | URL 构造假设无法暴露 |
| 7 | 登录 / 匿名两套数据形态（匿名 `unread_posts: null`、`/unread.json` 403） | 已有开关 | 基本够用 |
| 8 | `.load-more-sentinel` 位于文档底部 | 已有 | 基本够用 |

### 改造清单（`browser-lab/probe-server.js` + fixture 页面）

1. **列表页 DOM 改为真实层级**：`table.topic-list` → `tbody.topic-list-body` → `tr.topic-list-item[data-topic-id]`，行内标题为 `a.title.raw-link.raw-topic-link[data-topic-id]`（**嵌套第二个 data-topic-id**）
2. **slug 改为字面量 `topic`**，URL 形如 `/t/topic/<id>`
3. **`/latest.json` 改为真实形态**：只有"已建立 TopicUser 记录"的少数 Topic 带 `unread_posts`/`last_read_post_number`/`notification_level`，其余为 `null`
4. **新增 `#data-preloaded`**，内含 `currentUser` 与 `topicTrackingStates`，**值按真实站点做二次 JSON 编码**
5. **`/unread.json` 改为分页**：每页 30 条 + `more_topics_url`，支持 `?page=N`
   —— **让 P0-2 的误清在 fixture 上必然失败**（fixture 里把未读 Topic 数设成 > 30）
6. **`/t/<id>.json` 补上登录态的 `last_read_post_number`**（且**故意不提供 `unread_posts`**，与真实站点一致）
7. **新增可切换的 fixture 数据形态**：`logged-in` / `guest`（后者：`unread_posts` 全 null、`/unread.json` 403、无 `currentUser`）

### 新增回归测试（会**先失败**，用于证明 fixture 有效）

| 测试 | 期望 |
|---|---|
| fixture 行内存在嵌套 `[data-topic-id]` | 插件只选 30 行，不选 60 个元素 |
| 未读 Topic 有 35 个（> 一页） | **当前实现会误清第 2 页的 Topic → 测试应当失败**，修复后通过 |
| `/latest.json` 大多数 `unread_posts` 为 null | **当前实现标记不出新回复 → 测试应当失败**，修复后通过 |
| `topicTrackingStates` 存在且可解析 | 插件能从它读出正确未读数 |
| slug 为 `topic` | 生成的"第一个未读" URL 真实可跳 |

## 8. P1 自动补位问题记录（**本轮不改，仅记录**）

【事实】`.load-more-sentinel` 位于文档最底部（`top 2650` / 视口 `752` / 文档高 `2752`）；
原站无限滚动由"哨兵进入视口"触发，每次请求加载 **30 条**，一次滚动恰好 **1 个请求**。

【问题】当前 `core/autofill.js` 用 `scrollIntoView({block:"end"})` 触发 → **会把用户正在阅读的页面强制滚到底部**，打断阅读。

候选实现（**待定，不与 P0 混在一起改**）：

- **A**：只在用户**自然接近底部**时才补位（例如距底部不足一屏），不做任何主动滚动
- **B**：完全不主动滚动，只做"当前已加载数据内的补位"，跨页交给用户自己滚
- **C**：不触碰滚动位置，直接用 `more_topics_url` 拉下一页并本地插入
  → 但这属于**自建请求模式**，需要评估是否违背"优先使用原站机制"
- **D**：临时把哨兵移入视口、加载后立刻还原滚动位置
  → 会产生可见跳动，且改动原站 DOM，不推荐

倾向 **A**（最贴近"模拟真实用户正常浏览行为"），但需要先确认：用户不接近底部时"补位不足"是否可接受。
**这属于体验取舍，建议由用户决定，不由实现方拍板。**

## 9. 修改文件清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `site/trackingState.js` | **新增**：读取并缓存 `#data-preloaded` 的 `topicTrackingStates`，提供 `unreadFor(topicId)` | P0-1 |
| `site/discourseAdapter.js` | `fetchTopicReadState` 改为由 `highest - last` 计算未读（不再依赖不存在的 `unread_posts`）；`normalizeTopic` 保留 | P0-1 / P0-2 |
| `core/poolManager.js` | `syncWithDiscourse` 不再用 `topic.unreadPosts` 判定新回复；`syncUnreadTopics` 重写为"tracking 预筛 + 定向确认" | P0-1 / P0-2 |
| `storage/topicState.js` | 新增"上次定向确认时间 / 次数"字段，支撑请求上限 | P0-2 |
| `browser-lab/probe-server.js` | fixture 全面改造（DOM 层级、分页、null 字段、`#data-preloaded`、slug） | P0-3 |
| `browser-lab/run-ldfc-acceptance.js` | 新增 5 项回归测试 | P0-3 |

**不修改**：`LDFC-V1-完整规格.md`（产品规格）、`content.js` 的路由与访问记录逻辑、`ui/*`、`styles/*`。

## 10. 每个修改的原因

| 改动 | 原因（对应真实证据） |
|---|---|
| 引入 `topicTrackingStates` | `/latest.json` 的 `unread_posts` 在真实站点 28/30 为 null，新回复根本标不出来 |
| 移除 `syncWithDiscourse` 的未读判定 | 同上；`/latest.json` 降级为纯元数据 |
| 重写 `syncUnreadTopics` 的清除判定 | `/unread.json` 30 条分页，本账号 32 条未读 → 已可复现误清 |
| `fetchTopicReadState` 自算未读 | 登录态 `/t/<id>.json` **不存在** `unread_posts` 键，当前代码恒得 0 |
| 定向确认加次数上限 | 遵守【决策】"不建立逐 Topic 高频轮询" |
| fixture 改造 | 37/37 全绿却漏掉两个真实缺陷，说明 fixture 保真度不足是**更上游**的问题 |

## 11. 新增 / 修改测试

**新增（fixture）**

1. 嵌套 `data-topic-id` 不影响行选择（只选 30 行）
2. **未读 Topic 跨页（35 条）时，pending 不被误清** ← 修复前应失败
3. **`/latest.json` 未读字段为 null 时，仍能正确标记新回复** ← 修复前应失败
4. `topicTrackingStates` 二次编码可正确解析
5. slug 为 `topic` 时"第一个未读" URL 正确

**修改（既有 37 项中受影响者）**

- 原"未读清空后回到原池「感兴趣」"改为走新的定向确认路径
- 原"感兴趣 Topic 的未读进入新回复区"改为从 tracking 数据源驱动

**保持不变**：其余全部 37 项必须继续通过（这是本轮改动的硬约束）。

## 12. 不修改的部分

【事实】以下已在真实站点验证方向正确，**保持不动**：

- 账号身份用 `/session/current.json` 的数字 id
- SPA 路由用主世界 pushState/replaceState 钩子
- 行选择器 `.topic-list-item[data-topic-id]`
- 跳第一个未读用 `/t/<slug>/<id>/<lastRead+1>`（与原站 href 模式等价）
- 匿名 fallback 用 `highest_post_number`（匿名唯一可用字段）
- 搜索结果不过滤（结构性不命中 `.fps-result` 布局）
- 补位哨兵选择器 `.load-more-sentinel`
- `ui/*`、`styles/*`、`content.js` 的路由与访问记录

## 13. 对产品规格的影响

**产品规格 `LDFC-V1-完整规格.md` 零改动。**

本次全部改动都发生在【实现候选】层：**"从哪里拿到未读这个事实"变了，"未读为 0 就立即移出新回复区、且不改变原池归属"这个产品行为没变。**

| 用户决策 | 是否受影响 |
|---|---|
| 新回复不改变原池归属、原池计数不减 | 不受影响 |
| 新回复读完（unread=0）立即移出、回原池 | 不受影响（判定依据换成了更可靠的来源，行为不变） |
| 不感兴趣永不进入新回复 | 不受影响 |
| 主信息流只显示 HOME | 不受影响 |
| 自动补位要"低请求、有限、模拟真实用户" | 不受影响（P1 是让它更贴近这条决策） |
| 未登录也能用五区 | 不受影响 |

**唯一一条需要用户拍板的是 P1 自动补位的体验取舍**（不接近底部时要不要补位），
其余都是实现层替换，不需要用户决策。

---

## 附：本方案的执行顺序（待批准后）

```
1. 先改 fixture（P0-3），并加入 5 项新测试
2. 确认新测试"在修复前失败" —— 这是 fixture 有效的证明
3. 修 P0-1（引入 tracking 数据源）
4. 修 P0-2（重写清除判定）
5. 跑全套回归，确认旧 37 项 + 新 5 项全通过
6. 输出新的测试结果，明确区分「本地 fixture」与「真实站点」
7. 仍然不加载扩展做真实站点测试；等这一步结果再决定
```
