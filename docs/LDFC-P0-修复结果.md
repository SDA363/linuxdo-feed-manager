# LDFC P0 修复结果

> 全文严格区分：【真实站点事实】【用户决策】【实现候选】【测试结果】
> 产品规格 `LDFC-V1-完整规格.md` **未做任何修改**。

- 日期：2026-09-20
- 代码版本：`0.3.0`（未升版本号）
- 方案依据：`LDFC-P0-修复方案.md`、`LDFC-Phase0-真实站点验证报告.md`

## 1. Fixture 修改

`browser-lab/probe-server.js` 重写。依据是真实站点实测的形状，不是"让测试通过"。

| # | 复刻的真实形状 | 依据 |
|---|---|---|
| 1 | 一个 Topic **两个** `data-topic-id`：行本身 + 嵌套的 `a.title.raw-link.raw-topic-link` | 真实站点实测 60 个标记 / 30 行 |
| 2 | 真实层级 `table.topic-list > tbody.topic-list-body > tr.topic-list-item` | 真实 DOM |
| 3 | slug 是字面量 `topic`（`/t/topic/<id>`） | 实测 `/t/topic/847468` |
| 4 | `/latest.json` 第一页 **28/30** 条阅读字段为 null | 实测 2 有值 / 28 null |
| 5 | `/unread.json` **每页 30 条** + `more_topics_url` | 实测 page0=30、page1=2 |
| 6 | 未读 Topic 总数 **41（> 30）**，102 落在第 2 页 | 实测本账号未读 32 条，越界 |
| 7 | `#data-preloaded` 含 `topicTrackingStates`，值是**二次 JSON 编码的字符串** | 实测 `currentUser` / `topicTrackingStates` 都是字符串 |
| 8 | tracking 是**有界窗口**（40 行），覆盖不到全部 Topic | 实测 195~210 行且会变 |
| 9 | `/t/<id>.json` 登录态给 `last_read_post_number` + `highest_post_number`，**不给 `unread_posts`** | 实测该键根本不存在 |
| 10 | 页面 DOM 含 102，但 `/latest.json` 第一页不含它 | 实测未读老帖不在 latest 首页 |
| 11 | 登录 / 未登录两套形态（未登录：无 `currentUser`、`/unread.json` 403、无阅读字段） | 实测 |
| 12 | 搜索结果用 `.fps-result`，**不是** `.topic-list-item` | 实测 50 个 `.fps-result` / 0 个 `.topic-list-item` |

**没有做**：`.load-more-sentinel` 仍未加入 fixture（属于 P1 范围，避免把 P0 和体验问题混在一起）。

## 2. 修复前 5 项失败证据

**这一节是本轮最重要的证据。** 只改 fixture、**一行正式代码都没动**，跑出来的结果是：

```
FAIL：感兴趣 Topic 的未读进入新回复区（实际：{"pool":"INTERESTED","inNewReply":false}）
FAIL：新回复期间原池计数不减（感兴趣=1、新回复=0、导航 1/0）
FAIL：预览显示第一条未读回复（实际：""）
FAIL：能解析二次编码的 topicTrackingStates（窗口 null，102 未读=null，窗口外=null）
FAIL：102 不在 /latest.json 第一页也能发现新回复（inNewReply=false）
FAIL：新回复数量取自可用数据源（实际：0）
FAIL：不在未读列表第 0 页 ≠ 已处理完（102 仍保留在新回复区：false）
FAIL："第一个未读"地址使用真实 slug（实际：/t/topic/102/1）

汇总：36 项通过，8 项失败
```

其中 **3 项是"原本一直通过"的旧测试**：

- 感兴趣 Topic 的未读进入新回复区
- 新回复期间原池计数不减
- 预览显示第一条未读回复

它们之所以在旧 fixture 下通过、在新 fixture 下失败，正是因为旧 fixture 把 102 放进了 `/latest.json` 第一页并带上 `unread_posts`——**恰好掩盖了真实站点上真正的失效原因**。这直接印证了"fixture 保真度不足是更上游的问题"。

7 项新测试中 5 项按预期失败、2 项通过（行选择器本来就是对的；fixture 自检项）。

## 3. P0-1 修改

【事实】真实站点上 `/latest.json` 第一页 28/30 的 Topic 没有 `unread_posts`，旧代码据此判定新回复等于失效。

**新增 `site/trackingState.js`**：读取页面已加载的 `topicTrackingStates`（零额外请求）。

对外语义刻意区分"0"和"不知道"：

```
unread > 0   → 可以确信还有未读（用来省掉无谓请求）
unread == 0  → 只是"快照里是 0"，不等于服务器此刻一定没有未读
查不到(null) → 未知，必须走定向确认，不能当成 0
```

**`core/poolManager.js` 拆成三层，用途互不混用**（这是批准要求里明确的一条）：

| 层 | 函数 | 用途 | 数据源 |
|---|---|---|---|
| 1 | `syncWithDiscourse` | **元数据同步**（登录态不再做新回复判定） | `/latest.json` |
| 2 | `discoverNewReplies` | **discovery：发现新回复** | tracking 快照（零请求）→ `/unread.json` 第 0 页（实时补充） |
| 3 | `confirmNewReplyCompletions` | **completion：确认读完** | 定向 `/t/<id>.json` |

**约束 A 的落实**：tracking 只做预筛，**不是**清除依据。用户刚访问过的 Topic（`visitedTopicIds`）会**强制走一次定向确认**，即使快照仍显示未读——保证"读完了但快照还没刷新"不会导致新回复永久残留。优先级排序让这些 Topic 先消耗确认预算。

**约束 B 的落实**：`site/discourseAdapter.js` 新增 `unreadFromTopicPayload()`，取值顺序是

```
1. 原站原生 unread_posts          ← 优先，Discourse 自己的语义
2. highest - last_read 兜底计算    ← 【实现候选】，真实站点 8/8 抽样与原生值一致
3. 都没有 → null（未知）
```

注释里明确写了这是【实现候选】，一旦原站给原生字段就改回用原生的，**没有把它固化成产品逻辑**。

顺带修掉一个真实缺陷：`fetchTopicReadState` 原来读 `payload.unread_posts`，而该键在登录态 `/t/<id>.json` 里**根本不存在**，导致永远得到 0。

## 4. P0-2 修改

【事实】`/unread.json` 有 30 条分页上限，本账号 32 条未读 → 有 2 个 Topic 会被旧逻辑误清。**这不是假设，是现成可复现的缺陷。**

**彻底删除了**这条逻辑：

```
不在 /unread.json 第 0 页  ⇒  已处理完成      ← 已删除
```

（`syncUnreadTopics` 整个函数移除，它同时承担"标记"和"清除"两件事，本身就是问题根源。）

**新的清除判定**（`confirmNewReplyCompletions`）：

```
快照明确还有未读 且 用户不是刚读过  → 保持，不发请求
其余情况（快照说 0 / 快照查不到 / 用户刚读过） → 定向确认一次

定向确认：GET /t/<id>.json → 未读 == 0 ⇒ 清除
上限：每次同步最多 3 次；每个 Topic 最多 3 次（CONFIRM_MAX_ATTEMPTS）
```

**没有翻页扫描 `/unread.json`**，请求量正比于"待确认的新回复 Topic 数"，不随历史池规模增长。

## 5. 新增测试

`browser-lab/run-ldfc-acceptance.js` 新增 7 项（步骤 `[16/17]`）：

| # | 断言 | 修复前 |
|---|---|---|
| 1 | 一个 Topic 两个 `data-topic-id` 时仍只选行（标记 62、行 31、嵌套链接 31） | 通过 |
| 2 | 能解析二次编码的 topicTrackingStates（窗口 40，102 未读=4，窗口外=null） | **失败** |
| 3 | fixture 复刻了真实形状（未读第0页 30 / 第1页 11；102 只在第1页、不在 latest；latest 2/30 带阅读字段） | 通过 |
| 4 | 102 不在 /latest.json 第一页也能发现新回复 | **失败** |
| 5 | 新回复数量取自可用数据源（实际：4） | **失败** |
| 6 | 不在未读列表第 0 页 ≠ 已处理完（102 仍保留在新回复区） | **失败** |
| 7 | "第一个未读"地址使用真实 slug（实际：`/t/topic/102/3`） | **失败** |

## 6. 37 项旧测试结果

**全部通过**，且匿名相关用例未被影响（这是本轮改动的硬约束）：

```
PASS：未登录使用独立的 guest 空间（实际：ldfc__guest）
PASS：未登录打开 Topic 也能进入已读（实际：READ）
PASS：未登录模式记录本地阅读基线（实际：3）
PASS：guest 状态没有污染账号空间（库=ldfc__user-42，guest 标的 103="undefined"）
```

## 7. 新增测试结果

7 项全部通过：

```
PASS：一个 Topic 两个 data-topic-id 时仍只选行（标记 62、行 31、嵌套链接 31）
PASS：能解析二次编码的 topicTrackingStates（窗口 40，102 未读=4，窗口外=null）
PASS：fixture 复刻了真实形状（未读第0页 30 条 / 第1页 11 条；102 只在第1页、不在 latest；latest 2/30 条带阅读字段）
PASS：102 不在 /latest.json 第一页也能发现新回复（inNewReply=true）
PASS：新回复数量取自可用数据源（实际：4）
PASS：不在未读列表第 0 页 ≠ 已处理完（102 仍保留在新回复区：true）
PASS："第一个未读"地址使用真实 slug（实际：/t/topic/102/3）
```

## 8. 总测试数 / PASS 数

```
修复前：44 项检查 —— 36 通过 / 8 失败
修复后：44 项检查 —— 44 通过 / 0 失败   （连续 3 次运行结果一致）
```

构成：37 项旧测试 + 7 项新增测试。

## 9. 正式代码修改文件

| 文件 | 改动 |
|---|---|
| `site/trackingState.js` | **新增**：读取页面已有的 `topicTrackingStates`，区分"0"与"未知" |
| `site/discourseAdapter.js` | 新增 `unreadFromTopicPayload()` / `unreadFromPostNumbers()`；`normalizeTopic` 的 `unreadPosts` 缺字段时改为 `null`（原为 0，无法区分"0 条"与"不知道"）；`fetchTopicReadState` 改用新取值顺序 |
| `core/poolManager.js` | 拆成三层；删除 `syncUnreadTopics`；新增 `discoverNewReplies` / `confirmNewReplyCompletions`；`syncWithDiscourse` 登录态只做元数据；**匿名分支原样保留** |
| `storage/topicState.js` | 新增 `confirmAttempts` 字段、`bumpConfirmAttempt()`、`CONFIRM_MAX_ATTEMPTS`；进入/离开新回复区时重置计数 |
| `content.js` | 同步顺序改为：元数据 → 发现 → 访问提升 → 完成确认；在变更前先取走本次访问过的 Topic 列表 |
| `ui/poolPanel.js` | 未读数量未知时不再编造数字（原来兜底显示 1），改为不显示数字 |
| `manifest.json` | 注册 `site/trackingState.js` |

## 10. 未修改文件

- **`LDFC-V1-完整规格.md`（产品规格）—— 零改动**
- `LDFC-实现状态.md`、`LDFC-Phase0-真实站点验证报告.md`、`LDFC-P0-修复方案.md`（本轮只读）
- `site/identity.js`、`site/topicParser.js`、`site/routeObserverMain.js`
- `core/filter.js`、`core/newReply.js`、`core/autofill.js`
- `interaction/*`、`ui/navigation.js`、`ui/settings.js`、`ui/toast.js`
- `storage/db.js`、`storage/migration.js`

**P1 自动补位未做修改**，仍按 `LDFC-P0-修复方案.md` 第 8 节记录在案。

## 11. 是否修改任何产品决策

**没有。** 本轮全部改动都在【实现候选】层。

| 【用户决策】 | 是否受影响 |
|---|---|
| 新回复不改变原池归属、原池计数不减 | ✅ 不受影响（有测试断言） |
| 新回复读完（unread=0）立即移出、回原池 | ✅ 行为不变，判定依据换成更可靠的来源 |
| 不感兴趣永不进入新回复 | ✅ 不受影响 |
| 主信息流只显示 HOME | ✅ 不受影响 |
| 自动补位要"低请求、有限" | ✅ 不受影响（P1 未动） |
| 未登录也能用五区 | ✅ 不受影响（匿名用例全通过） |

被替换的【实现候选】记录如下（原候选 → 真实站点发现 → 新候选）：

1. **新回复判定数据源**：`/latest.json` 的 `unread_posts` → 实测 28/30 为 null → 改为 tracking 快照 + `/unread.json`
2. **新回复完成判定**：不在 `/unread.json` 第 0 页即视为完成 → 实测有 30 条分页上限 → 改为定向确认
3. **未读数计算**：直接读 `payload.unread_posts` → 实测该键在 Topic 详情里不存在 → 改为"原生优先 + `highest - last` 兜底"
4. **未知未读数**：默认 0 → 改为 `null`，并在 UI 上不显示数字

## 12. 尚未解决问题

### 仍未验证（需要真实站点加载扩展）

| 项 | 说明 |
|---|---|
| **AC-030 无高频轮询 / 无逐 Topic 请求** | 需要加载扩展后统计真实请求 |
| **AC-034 分批渲染 / 各池独立滚动位置** | 同上 |
| **AC-031 原站兼容再复测** | 上一轮只测了"未加载扩展"的基线 |
| **AC-011 / AC-012 部分未覆盖项** | 卡片上的未读数量断言、新回复区排序按钮 |
| **真实站点上的三层同步行为** | tracking 快照的时效性在 SPA 内长时间浏览后的实际表现 |
| **tracking 窗口覆盖不足时** | 当用户未读 Topic 数远超快照窗口（实测窗口约 195~210）时的表现 |
| **`/session/current.json` 之外的账号身份兜底** | 头部选择器在真实站点无效，尚未替换（首选来源可用，暂不阻塞） |

### 需要用户配合

| 项 | 说明 |
|---|---|
| **多账号隔离（AC-037）真实验证** | 需要手动登出、登录第二个账号 |

### 已知但本轮不处理

| 项 | 说明 |
|---|---|
| **P1 自动补位打断阅读** | `.load-more-sentinel` 在文档底部，`scrollIntoView` 会把页面猛滚到底。**待 P0 与真实站点功能验证完成后单独决策** |
| **fixture 仍无 `.load-more-sentinel`** | 属于 P1 范围，加了会触发滚动并干扰现有测试 |

### 本轮发现、需要记录的一点

工作区在本轮开始前已被改动过（匿名支持被完整加回：`identity.js` 的 `guest` 命名空间、`poolManager` 的匿名分支、fixture 的 `login=` 参数、验收脚本的 guest 用例）。

`LDFC-P0-修复方案.md` 是基于**更早的代码状态**写的，因此本轮实现时做了一处方案外的补充约束：

> **登录态路径的任何改动都不得影响匿名路径。**

匿名路径本来就不使用 `/unread.json` 与 `unread_posts`，因此三层的重构对它无影响；验收脚本里的匿名用例全部保持通过，可证明这一点。

---

## 附：本次修复前后的完整对比

```
                     修复前            修复后
检查项总数             44               44
通过                   36               44
失败                    8                0

失败项中含旧测试         3                0     ← 旧 fixture 掩盖了真实缺陷
```

**下一步（按批准的执行顺序）：**
加载扩展 → 真实 linux.do → AC-030 / AC-034 → AC-031 复测 → Guest → 多账号 → 真实站点最终验收。

在此之前，本地结果只能表述为：
**「本地 fixture 44 项通过」，不等于「真实站点验收通过」。**
