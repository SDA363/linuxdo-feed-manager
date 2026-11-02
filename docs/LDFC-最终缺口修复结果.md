# LDFC 最终缺口修复结果

> 修复对象：NEW_REPLY 期间 `lastReadPostNumber` 不同步，导致**第一条未读预览可能停在用户已读过的楼层**。
> 本轮**只改 `core/poolManager.js` 一个分支**，产品规格未动，架构未动。

- 日期：2026-09-20
- 版本：`0.4.0-rc.1`（候选发布节点；`1.0.0` 待真实站点复测后再定）

---

## 1. 缺口描述与用户可见后果

### 规格要求

> 预览内容 = 自上次阅读位置之后的第一条新回复

### 原实现

`core/poolManager.js` 的 `discoverNewReplies()` 对**已经在 NEW_REPLY 里**的 Topic 走这个分支：

```js
} else if (signal.unreadPosts !== record.unreadPosts) {
  await state().updateMetadata(record.topicId, { unreadPosts: signal.unreadPosts });
  // ← lastReadPostNumber / highestPostNumber 没有一起更新
}
```

### 用户可见后果（不是"缓存不漂亮"，而是会看错内容）

场景：Topic 在「新回复」里，用户打开读了一部分（阅读位置从 N 推进到 M），**但没读完**（仍留在 NEW_REPLY）。

| 步骤 | 后果 |
|---|---|
| 下一轮 discovery | 只更新了 `unreadPosts`，`lastReadPostNumber` 仍是 N |
| 「第一条未读预览」 | 缓存键 `previewForRead = N` 与 `lastReadPostNumber = N` 相等 → **判定为"未过期"，不重新抓** |
| 用户看到 | 预览停在**第 N+1 楼**，而用户其实已经读到 M 楼 |
| 「进入未读位置」 | 同样按 N+1 构造地址 → **跳到用户已经读过的地方** |

这与规格"预览 = 上次阅读位置之后的第一条"直接冲突。

---

## 2. 最小修复方案

**改动范围**：`core/poolManager.js` 的 `discoverNewReplies()` 内，把"已在 NEW_REPLY"分支从"只更新未读数"改成"未读数与阅读位置一起同步"。

方案要点（对应批准要求）：

| 要求 | 落实方式 |
|---|---|
| 先提最小方案 | 只动一个分支，不动 `newReplyPending` / `basePool` 架构 |
| 优先同步 tracking 的可靠 `last_read` | 从同一个 `signal`（来源即 tracking 快照或 `/unread.json`）取 `lastReadPostNumber` |
| 架构不变 | `markNewReply` / `clearNewReply` / 池归属逻辑一行未改 |
| 不引入轮询 / 逐 Topic 请求 | 本次改动**不增加任何请求** —— 数据来自已有来源 |
| 产品规格不动 | 未改 |

**两个必要的写法约束**：

1. **只在数据源给出数值时才覆盖**：`typeof signal.lastReadPostNumber === "number"`。
   否则 tracking 里 `last_read_post_number` 为 `null` 的 Topic 会把已知信息抹掉。
2. **阅读位置只增不减**：`> (record.lastReadPostNumber ?? 0)`。
   页面快照可能比本地缓存旧，不能让它把阅读位置往回退。

**预览缓存无需额外处理**：`core/newReply.js` 用 `previewForRead === lastReadPostNumber` 判断是否过期。
`lastReadPostNumber` 一变，缓存自然失效，下一轮会按新位置重新抓「第一条未读」。

---

## 3. 修复前的失败证据

改测试、**不改产品代码**，先跑一次：

```
FAIL：NEW_REPLY 期间阅读位置必须跟随更新
      lastRead 2 → 2（应为 4）
      未读 2                     ← 这个更新了
      第一个未读 /t/topic/102/3   ← 用户已读到 4，却仍指向 3
      预览缓存已失效=true

汇总：64 项通过，1 项失败
```

**关键点**：`第一个未读` 落在 `/3` 而不是 `/5` —— 这就是用户可见后果的**直接证据**，
不是推断。

### 回归测试的设计（对应批准要求 6）

| 要求的步骤 | 测试里的对应 |
|---|---|
| 初始 lastRead = N | 首次 discovery 用 `lastReadPostNumber: 2` → 记录 `lastRead=2` |
| NEW_REPLY 已存在 | 首次 discovery 后 `inNewReply=true` |
| 用户阅读推进到 M | 第二次 discovery 用 `lastReadPostNumber: 4`（仍剩 2 条未读） |
| 再次发现新状态 | 调用 `discoverNewReplies()` |
| 本地 lastRead 必须更新到 M | 断言 `lastReadPostNumber === 4` |
| 第一条未读预览必须从 M+1 开始 | 断言 `topicUnreadUrl()` === `/t/topic/102/5`，并断言预览缓存已失效 |

---

## 4. 修复内容

```js
if (!signal) continue;

if (!record.inNewReply) {
  await state().markNewReply(record.topicId, signal);
  changed = true;
  continue;
}

// Topic 已经在「新回复」里，但用户可能又读了一部分 ——
// 阅读位置必须跟着走，否则「第一条未读预览」会停在用户已经读过的楼层。
const patch = {};
if (typeof signal.unreadPosts === "number" && signal.unreadPosts !== record.unreadPosts) {
  patch.unreadPosts = signal.unreadPosts;
}
if (typeof signal.lastReadPostNumber === "number" &&
    signal.lastReadPostNumber > (record.lastReadPostNumber ?? 0)) {
  patch.lastReadPostNumber = signal.lastReadPostNumber;
}
if (typeof signal.highestPostNumber === "number" &&
    signal.highestPostNumber > (record.highestPostNumber ?? 0)) {
  patch.highestPostNumber = signal.highestPostNumber;
}

if (Object.keys(patch).length) {
  await state().updateMetadata(record.topicId, patch);
  changed = true;
}
```

**注意**：这条路径**不产生任何网络请求**，只是把已有数据写进本地缓存，
因此不违反"不引入后台轮询 / 不增加逐 Topic 高频请求"。

---

## 5. 修复后的通过证据

```
PASS：NEW_REPLY 期间阅读位置必须跟随更新
      lastRead 2 → 4  ·  未读 2  ·  第一个未读 /t/topic/102/5  ·  预览缓存已失效=true

PASS：离开 NEW_REPLY 后重新发现仍会全量刷新（{"unread":5,"lastRead":9}）
```

| 检查 | 修复前 | 修复后 |
|---|---|---|
| 阅读位置同步 | 2 → **2**（没动） | 2 → **4** ✓ |
| 未读数同步 | 2 ✓ | 2 ✓ |
| 第一个未读地址 | `/t/topic/102/3` ❌ | **`/t/topic/102/5`** ✓ |
| 预览缓存失效 | true | true ✓ |
| 清除后重新发现 | 全量刷新 ✓ | 全量刷新 ✓（**行为未变**） |

---

## 6. 本地全量回归

```
修复前：65 项检查 —— 64 通过 / 1 失败
修复后：65 项检查 —— 65 通过 / 0 失败
```

**原有 64 项全部继续通过**，包括 P0/P1/P2-A 以及上一轮新增的 15 项覆盖测试。

**没有引入新的测试项**（本次是把上一轮标记为"已知缺口"的那一项，从"断言缺口存在"改为"断言缺口已修复"），
所以总数仍是 65。

---

## 7. 真实站点复测

**状态：等待指定测试 Topic（未完成）**

### 为什么需要重新指定

上一次新回复闭环用的 Topic `2899328`，在验证过程中已被**真实读到 60/60**，
`unread = 0`，不再有未读，**无法再产生 NEW_REPLY**。

### 为什么不能自己挑

此前有明确规定：

> 在我指定测试 Topic 之前：不自己选择 Topic、不自己发回复、不改变真实账号的 Topic 状态。

本次复测同样会临时标记一个真实 Topic 的本地状态（测完还原），
因此需要使用者指定。

### 本次复测要额外覆盖的点

除了上一轮已验证的完整闭环，本次要专门验证**修复点**：

```
① Topic 有未读（读到 N / 最高 M+）
② 标记为感兴趣 → 进入 NEW_REPLY，记录 lastRead = N
③ 只读一部分（推进到 M，仍有未读）→ 回到列表触发同步
④ 断言本地 lastRead 变成 M（修复点）
⑤ 断言「第一条未读预览」从 M+1 楼开始，而不是 N+1
⑥ 读完 → unread=0 → NEW_REPLY 消失 → 归属仍是 INTERESTED
```

其中 ④⑤ 是本轮新增断言，其余沿用上一轮已验证的链路。

### 不变量

- 不修改正式代码
- 不修改产品规格
- 测试后按 id 精确还原本地状态
- 服务端阅读位置不可逆（会真的把该帖剩余的未读标记为已读）—— 需使用者知悉

---

## 8. 版本节点

```
0.4.0-rc.1   ← 当前（核心 V1 基本完成，缺口已修，等待真实站点复测）
    ↓ 真实站点复测通过后
1.0.0        正式封版
```

`manifest.json` 的 `version` 已改为 `0.4.0-rc.1`，与"候选发布"的实际工程状态一致。

---

## 9. 未变更 / 未覆盖

### 明确未变更

| 项 | 状态 |
|---|---|
| 产品规格 `LDFC-V1-完整规格.md` | **未改** |
| `newReplyPending` / `basePool` 架构 | **未改** |
| 已读判定 / 自动补位 / P2-A / 多账号 / Guest | **未改** |
| 网络请求数量 | **未增加**（本次是纯本地缓存同步） |

### 仍未覆盖（与上一轮相同，不受本次影响）

| 项 | 状态 |
|---|---|
| 两个真实账号切换 | **NOT TESTED**（无第二个账号；不阻塞 1.0.0） |
| 新回复即时发现时效性 | **非 V1 实时目标** |
| AC-007 / 019 / 020(专区长期恢复) / 023 / 026 / 027 | 本地 NOT TESTED |
| AC-036 / 025 / 022 / 038 的真实站点执行 | 本地已覆盖，真实站点未执行 |

---

## 10. 本轮结论

```
① 缺口已修复
   NEW_REPLY 期间阅读位置跟随 tracking 同步；预览不再停在已读楼层

② 最小改动
   仅 core/poolManager.js 一个分支；无新增请求；架构与规格未动

③ 先失败后通过
   修复前该测试失败（且暴露出 /3 而非 /5 的可见后果），修复后通过

④ 无回归
   本地 65 / 65 全通过

⑤ 待补
   真实站点 NEW_REPLY 复测（需要指定测试 Topic）

→ 真实站点复测通过后，可升 1.0.0。
```
