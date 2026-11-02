# Linux.do Personal Feed Manager — Phase 0 技术侦察报告

> **文档状态**：本文是**实现之前**的技术侦察结论，属于历史依据，不是需求也不是实现说明。
>
> - 产品行为以 `LDFC-V1-完整规格.md` 为准；
> - 当前代码做到哪一步，见 `LDFC-实现状态.md`；
> - 本文第 10 节的 `manifest.json`、第 3/4/5 节提到的字段名都是**当时的示例与线索**，
>   与最终实现不完全一致（例如实际 manifest 没有 `permissions` 字段、
>   内容脚本分成了主世界与隔离世界两条）。**不要把本文的示例当权威。**
> - 本文的结论之一是"可以进入 Phase 1"。**Phase 0 的真实站点验证至今尚未完成** ——
>   当年受站点防护限制，无法在真实 linux.do 上核对登录态字段。

> 状态：Discourse（论坛程序）机制已基于官方开源仓库 `main` 分支确认；Linux.do 站内实测受站点防护限制，需在真实浏览器里做二次验证。本报告可直接进入 Phase 1（第 1 阶段最小状态系统）开发。

## 1. Topic（主题）DOM（页面结构）结构

Discourse 桌面端列表行（核心证据：`discourse/frontend/discourse/app/components/topic-list/item.gjs`）：

```html
<tr class="topic-list-item ..." data-topic-id="12345">
  <td class="topic-list-data">
    <div class="main-link">
      <a class="title raw-link raw-topic-link" data-topic-id="12345" href="/t/{slug}/{id}/{near}">标题</a>
    </div>
  </td>
</tr>
```

“最新”样式列表使用（证据：`latest-topic-list-item.gjs`）：

```html
<div class="latest-topic-list-item" data-topic-id="12345">
  <a class="title" data-topic-id="12345" href="...">标题</a>
</div>
```

移动端行内同样渲染 `TopicLink`（标题链接），外层仍是 `.topic-list-item[data-topic-id]`。

扩展选择器建议（从稳到弱）：

1. `[data-topic-id]` 所在的最近列表项：`.topic-list-item[data-topic-id]` 或 `.latest-topic-list-item[data-topic-id]`。
2. 标题链接：`a.raw-topic-link[data-topic-id], a.title[data-topic-id]`。
3. 不要依赖具体主题皮肤类名；`data-topic-id` 是 Discourse 核心输出。

## 2. 稳定 Topic ID 获取方式

- 首选：列表项元素上的 `data-topic-id` 属性，直接就是数字 ID。
- 次选：链接 `href` 解析 `/t/{slug}/{topicId}` 或 `/t/{slug}/{topicId}/{postNumber}`；`topicId` 是第二个路径段，必须是数字。
- 本地数据库主键：字符串化的 `topicId`（例如 `"12345"`），不要用标题、slug（URL 里的文字别名）、作者或时间。

## 3. 当前 Topic List（主题列表）数据来源

两条路径（证据：`adapters/topic-list.js`、`lib/topic_list_responder.rb`）：

1. 首屏 HTML（服务端渲染）：`#data-preloaded` 元素里的 `topic_list` 键，前端 adapter 会优先消费它。
2. AJAX（异步请求）：`/{filter}.json`，例如 `https://linux.do/latest.json`；翻页继续用响应里的 `topic_list.more_topics_url`（形如 `/latest?no_definitions=true&page=1`），前端会自动补 `.json`。

登录用户在列表 JSON 中每个 Topic 可获得关键字段（证据：`app/serializers/listable_topic_serializer.rb`，已在 meta.discourse.org 实测 `latest.json` 返回）：

```json
{
  "id": 406194,
  "slug": "...",
  "title": "...",
  "posts_count": 88,
  "highest_post_number": 91,
  "last_read_post_number": 12,
  "unread_posts": 3,
  "unseen": false,
  "last_posted_at": "...",
  "bumped_at": "..."
}
```

未登录时 `last_read_post_number` / `unread_posts` 不存在。扩展必须兼容未登录态：此时只能显示主信息流和手动操作池，不能自动已读。

## 4. 如何获取 unread_posts（未读回复数）

- 登录后从列表 JSON 直接读取 `topic.unread_posts`。
- 数量口径：`unread_posts` 是“上次阅读位置之后”的未读帖子数（序列化器 `Unread` helper 生成）。
- 实时更新：Discourse 通过 MessageBus（消息总线）推送；前端 `topic-tracking-state.js` 订阅 `/latest`、`/new`、`/unread`、`/unread/{userId}` 频道，收到 `unread` / `read` 消息后更新 `highest_post_number`、`last_read_post_number`。
- 扩展策略：不要自己订阅 MessageBus 私有协议；优先消费页面已更新的列表 JSON / DOM（`unread-posts` CSS 类），并在返回列表页时刷新判断。

## 5. 如何获取 last_read_post_number（最后已读楼层号）

- 列表 JSON 字段：`last_read_post_number`；`null` 表示从未打开过（配合 `unseen` 判断新主题）。
- 推导：`last_read_post_number = highest_post_number - unread_posts`（前端 `topic-tracking-state.js` 也这么补偿）。
- 自动已读判定（Phase 3 用）：
  - `last_read_post_number != null` → 用户产生过阅读记录 → 归入「已读」。
  - `unseen === true` 且 `last_read_post_number == null` → 全新主题 → 仍属主信息流。
  - 注意：只凭 `unseen:false` 不能断定“打开过”（可能只是早于“视为新主题”的时间点），必须以 `last_read_post_number` 为准。

## 6. 如何跳转第一个未读回复

Discourse 原生实现（证据：`models/topic.js` 的 `lastUnreadUrl` / `urlForPostNumber`）：

```js
postNumber = last_read_post_number + 1;
if (postNumber > highest_post_number) postNumber = highest_post_number;
url = `/t/${slug}/${topicId}/${postNumber}`;
```

要点：

- URL 用的是 post_number（楼层号），不是 post id。
- 扩展的「进入未读位置」按钮直接构造上述链接，交给原站路由即可；Discourse 会定位到 `/:nearPost` 楼层。
- 若 `last_read_post_number` 为空（新主题），链接就是 `/t/{slug}/{id}`（默认第 1 楼）。

## 7. SPA（单页应用）路由机制

- Discourse 使用 Ember Router，`location = "history"`，即 History API（证据：`mapping-router.js`）。
- 点击由 `lib/intercept-click.js` 拦截后调用 `DiscourseURL.routeTo(href)` 做客户端跳转；列表行点击最终 `navigateToTopic()`。
- 路由表：`/latest`、`/top`、`/c/{category}`、`/t/{slug}/{id}`、`/t/{slug}/{id}/{near}` 等（证据：`routes/app-route-map.js`）。
- 扩展适配方案：
  1. 内容脚本里包装 `history.pushState` / `history.replaceState`（DOM 共享，隔离世界内也能改到），监听 `popstate`。
  2. 再配合 `MutationObserver` 观察 `.topic-list-body` / `[data-topic-id]` 节点插入，用 `data-ldfc-processed="true"` 标记 + debounce（防抖）防循环。
  3. 不要 patch Ember 内部对象；只依赖公开 DOM 和 History API。

## 8. 分页 / Infinite Scroll（无限滚动）机制

证据：`ui-kit/d-load-more.gjs` + `components/discovery/topics.gjs` + `models/topic-list.js`。

```text
列表底部渲染 .load-more-sentinel（哨兵元素）
  ↓ IntersectionObserver 发现哨兵可见
  ↓ 100ms debounce 防抖后调用 TopicList.loadMore()
  ↓ 请求 more_topics_url + ".json"（每页 30 条）
  ↓ 追加新 Topic 行并更新 more_topics_url
```

关键属性：

- `TopicList.canLoadMore = !!more_topics_url`；没有该字段就是没有更多。
- `loadingMore` 状态防止并发重复请求。
- 列表行由 Ember/Glimmer 管理。

## 9. 自动补位最安全的实现方式

结论（按安全等级排序）：

1. **第一版（Phase 2）**：只做“视觉补位”——把非 HOME 的行加 `hidden` / `display:none`，页面里剩余的 HOME 行自然顶上；当前已加载的 HOME 都显示完之前，**不发任何请求**。
2. **增强（Phase 7）**：只有当“视口内 + 视口下方一屏内”可见 HOME 行不足阈值时，才触发一次补页。触发方式优先复用原站哨兵（把 `.load-more-sentinel` 短暂滚入视口会走原生逻辑），或者直接 `fetch(more_topics_url + ".json")` 并把结果交给原站已有的渲染流（更复杂，不推荐先用）。
3. **硬性护栏**：同一路由下最多补 2 页/次进入；两次补页间隔 ≥ 3 秒；`loadingMore` 或 `!more_topics_url` 时不请求；用户停止滚动即停。

**重要技术风险（必须遵守）**：列表行 `<tr>` / `<div>` 由 Ember 管理，扩展**不要物理删除这些节点**，否则 Ember 重新渲染时可能报错或错乱。动画结束后用 `display:none`（或 `hidden`）实现“从视觉上移除并释放空间”，这与规格第 11 条的最终效果一致，但实现方式从“删除 DOM”调整为“隐藏 DOM”，属于必要偏差，已记录。

## 10. Chrome/Edge Extension（浏览器扩展）注入方案

Manifest V3：

```json
{
  "manifest_version": 3,
  "name": "Linux.do Personal Feed Manager",
  "version": "0.1.0",
  "content_scripts": [{
    "matches": ["https://linux.do/*"],
    "js": ["src/content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }],
  "permissions": ["storage"],
  "host_permissions": ["https://linux.do/*"]
}
```

要点：

- 内容脚本运行在隔离世界（isolated world），可以读写页面 DOM、包装 History API，但碰不到页面 JS 变量（如 Ember 内部 store）；这正是我们要的边界。
- IndexedDB 在内容脚本里以 `https://linux.do` 源存储，符合“本地数据”要求；Chrome/Edge 均支持。
- 不需要 background（后台脚本）参与 MVP；安装向导可用内容脚本内的浮层实现，避免开新页面打断用户。
- 不要在内容脚本里频繁 `chrome.storage` 读写：启动时一次性载入内存 `Set/Map`，操作后异步落库。

## 11. 已知风险与待验证清单

1. **Linux.do 站点防护**：无浏览器 Cookie（凭证）的脚本请求返回 403，本报告无法直接抓取 linux.do 的线上 JSON。需要你装上最小原型后在真实浏览器里核对：`/latest.json` 字段、`data-topic-id`、`.load-more-sentinel` 是否与 Discourse 核心一致。
2. **自定义主题/插件**：Linux.do 可能有定制皮肤和插件；若它覆盖了列表组件，`data-topic-id` 理论上仍在（核心输出），但类名可能变化。解析器必须以 `data-topic-id` 为锚。
3. **新回复预览**：列表 JSON 不包含“第一条未读回复”的正文。要显示规格里的引用预览，只有两条路：a) 每个新回复卡片懒加载一次 `/t/{id}.json`（有请求成本，必须缓存 + 节流）；b) V1 先显示最后发帖人 + 时间，预览正文降级。**这是待决策项，不阻塞 Phase 1–5 的主体**。
4. **已读回传时机**：Discourse 用 `/topics/timings` POST（阅读时长上报）更新 `last_read_post_number`，通常几秒到一分钟后生效，返回列表时才看得到。扩展要做“返回列表后轮询一次（最多 2 次、间隔 2 秒）”，避免误判未读。
5. **Ember 重渲染**：用户手动操作/MessageBus 更新都会重绘列表行；我们的按钮、标记必须挂在行内且每次重绘后重建（MutationObserver 负责补挂），不能指望一次性注入永久存在。
6. **移动端 Swipe（滑动）**：桌面优先，移动端 DOM 与桌面共用列表组件但布局不同；触摸手势实现时才需要专项验证，Phase 6 之前不阻塞。
7. **npm/代理环境**：本机 `.npmrc` 指向 `127.0.0.1:26561` 但该端口未开；装 Vite（构建工具）依赖前需修正或临时清空该配置。

## 结论

Phase 0 所需机制已确认完毕，可以进入 Phase 1：Topic ID + IndexedDB（浏览器本地数据库）+ 四个基础池状态 + 列表过滤。唯一必须先和你确认的偏差是第 9 节的“隐藏 DOM 而不是删除 DOM”——这是对规格第 11 条的安全化实现，不改变用户可见效果。
