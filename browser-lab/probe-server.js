"use strict";

// LDFC 本地模拟服务（fixture）。
//
// 目标不是"让测试通过"，而是**尽量复刻真实 Linux.do 的数据与 DOM 形状**，
// 让真实站点上会犯的错误在本地也能失败。
//
// 本文件的形状依据 `LDFC-Phase0-真实站点验证报告.md` 的实测结论：
//   1. 一个 Topic 有 **2 个** data-topic-id：行本身 + 嵌套的标题链接
//   2. Topic 行的真实层级是 table.topic-list > tbody.topic-list-body > tr.topic-list-item
//   3. slug 是字面量 "topic"（/t/topic/847468），不是标题 slug
//   4. /latest.json 第一页里**绝大多数** Topic 的阅读字段是 null
//      （真实观测 28/30；只有用户真正互动过的 Topic 才带这些字段）
//   5. /unread.json **每页 30 条**，带 more_topics_url，可翻页
//   6. #data-preloaded 里有 topicTrackingStates，且值是**二次 JSON 编码的字符串**
//   7. topicTrackingStates 是**有界窗口**，覆盖不到所有 Topic
//   8. /t/<id>.json 登录态给 last_read_post_number + highest_post_number，
//      **但不给 unread_posts**（真实站点上该键根本不存在）
//   9. 登录 / 未登录两种数据形态不同
//
// 启动：node probe-server.js   （端口 8123）

const http = require("node:http");

const PORT = 8123;

// identity: "user"（已登录）| "guest"（未登录）
const state = {
  identity: "user",
  userId: 42,
  // 用来切换 Topic 102 的未读状态，验证"读完 → 移出新回复区"
  unreadEnabled: true
};

const LOGGED_IN = () => state.identity === "user";

// ---------------------------------------------------------------- 数据

const CATEGORY_ID = 7;

// 核心 Topic：验收脚本直接操作这几个。
// engaged = 用户在真实站点上"互动过"，因此 Discourse 会带阅读状态。
const coreTopics = [
  { id: 101, title: "Probe Topic One", lastRead: 3, unread: 0, engaged: true },
  { id: 102, title: "Probe Topic Two", lastRead: 2, unread: 4, engaged: true },
  { id: 103, title: "Probe Topic Three", lastRead: 9, unread: 0, engaged: true },
  // 从未互动过：真实站点上这类 Topic 的阅读字段是 null，也不在 tracking 里
  { id: 104, title: "Probe Topic Four", lastRead: null, unread: 0, engaged: false },

  // 复刻真实站点 topic 2902024 的情形：
  //   - 在 /latest.json 第一页，且带 unread_posts = 3（因为用户互动过）
  //   - **不在** tracking 快照里
  //   - **不在** /unread.json 第 0 页
  // 即"只有 /latest.json 这一个来源能看到它"。
  { id: 105, title: "Probe Topic Five", lastRead: 59, unread: 3, engaged: true, onlyInLatest: true },

  // 复刻"tracking 语义过宽"的情形：
  //   - 在 tracking 里，但 last_read_post_number = null（从未读过）
  //   - 没有任何可靠来源说它有未读
  // 若把 tracking 的 null 当成"整帖未读"，它会被错误地判成有新回复。
  { id: 106, title: "Probe Topic Six", lastRead: null, unread: 5, engaged: false, trackedWithNullRead: true }
];

// 楼中楼夹具：**不**进入列表页 / latest / unread / tracking，
// 只在预览里直接打开。它返回真实嵌套树形状（roots + direct_reply_count），
// 用来验证「展开全部楼中楼」——标准 topic 转树的分支会把 direct_reply_count
// 一律置 0，永远出不来「展示更多回复」按钮。
const nestedTopic = {
  // 用 9xx 段，避开 ldfc 验收里拿 101~110 当"纯状态夹具"的 id。
  id: 907,
  title: "Probe Nested Topic",
  // 已读到最后一楼：否则 targetPostNumber=0 会先跳「第一条未读」，
  // 走的是跳楼分支，拿不到嵌套树。
  lastRead: 5,
  unread: 0,
  engaged: true,
  nested: true
};

// 顶层回复分两页返回：用来验证「只看楼主」的 loadAllComments
// 真的会翻页拉完，而不是依赖哨兵碰巧还在视口。
// 同样用 9xx 段，避开 101~110 的状态夹具。
const pagedTopic = {
  id: 908,
  title: "Probe Paged Topic",
  lastRead: 3,
  unread: 0,
  engaged: true,
  nested: true,
  paged: true
};

// 40 条批量未读：把 /unread.json 撑到一页以上，
// 让 102 落到第 2 页 —— 这样"不在第 0 页 ⇒ 已处理完"的错误必然暴露。
const bulkTopics = Array.from({ length: 40 }, (_, index) => ({
  id: 201 + index,
  title: `Bulk Topic ${201 + index}`,
  lastRead: 1,
  unread: 5,
  engaged: true,
  bulk: true
}));

// 27 条"从未碰过"的 Topic：用来把 /latest.json 第一页填成
// "大多数 Topic 没有阅读状态"，与真实站点观测一致。
const freshTopics = Array.from({ length: 27 }, (_, index) => ({
  id: 301 + index,
  title: `Fresh Topic ${301 + index}`,
  lastRead: null,
  unread: 0,
  engaged: false
}));

// 再补 60 条：让 /latest.json 有第 1、2 页可翻，
// 这样自动补位在本地也有东西可加载（真实站点每页 30 条）。
const moreTopics = Array.from({ length: 60 }, (_, index) => ({
  id: 401 + index,
  title: `More Topic ${401 + index}`,
  lastRead: null,
  unread: 0,
  engaged: false
}));

const allTopics = [
  ...coreTopics,
  nestedTopic,
  pagedTopic,
  ...bulkTopics,
  ...freshTopics,
  ...moreTopics
];

// topicTrackingStates 的窗口上限。真实站点实测在 195~210 之间浮动，
// 这里取 40，正好把最后几条批量 Topic 挤出窗口，
// 逼使扩展处理"tracking 查不到这个 Topic"的分支。
const TRACKING_WINDOW = 40;

const PREVIEW_AUTHOR = "probe-user";
const PREVIEW_TEXT = "第一条未读回复的内容，用于验证预览。";

const byId = (topicId) => allTopics.find((topic) => String(topic.id) === String(topicId));

// 原站对未登录访客不返回用户级阅读状态。
function effectiveUnread(topic) {
  if (!LOGGED_IN()) return 0;
  if (topic.id === 102) return state.unreadEnabled ? topic.unread : 0;
  return topic.unread;
}

function highestOf(topic) {
  const unread = effectiveUnread(topic);
  if (topic.lastRead === null || topic.lastRead === undefined) return unread;
  return topic.lastRead + unread;
}

// post id 约定：topicId * 1000 + postNumber
const postId = (topicId, postNumber) => topicId * 1000 + postNumber;

// ---------------------------------------------------------------- 列表

// 页面 DOM 渲染顺序。注意 102 **在页面里**（验收要点击它），
// 但**不在 /latest.json 第一页**（模拟真实站点：未读老帖不在 latest 首页）。
function pageOrder() {
  return [...coreTopics.map((topic) => topic.id), ...freshTopics.map((topic) => topic.id)];
}

// /latest.json 第一页：只有 101 / 103 互动过，其余 28 条阅读字段为 null。
function latestOrder() {
  return [101, 103, 105, 104, ...freshTopics.map((topic) => topic.id)];
}

// /unread.json 顺序：批量在前，102 排到最后 → 落在第 2 页。
function unreadOrder() {
  return [...bulkTopics.map((topic) => topic.id), 102];
}

const UNREAD_PER_PAGE = 30;

function topicListPayload(ids) {
  return {
    topic_list: {
      per_page: UNREAD_PER_PAGE,
      topics: ids.map((id) => {
        const topic = byId(id);
        const payload = {
          id: topic.id,
          slug: "topic",
          title: topic.title,
          excerpt: `摘要：${topic.title}`,
          category_id: CATEGORY_ID,
          last_poster_username: `poster-${topic.id}`,
          posts_count: highestOf(topic),
          highest_post_number: highestOf(topic),
          last_posted_at: "2026-09-01T00:00:00.000Z"
        };

        // 只有"互动过"的 Topic 才带用户级阅读状态。
        // 真实站点上其余 Topic 这几个键是 null。
        if (topic.engaged && topic.lastRead !== null) {
          payload.last_read_post_number = topic.lastRead;
          payload.unread_posts = effectiveUnread(topic);
          payload.notification_level = 2;
        } else {
          payload.last_read_post_number = null;
          payload.unread_posts = null;
          payload.notification_level = null;
        }

        return payload;
      })
    }
  };
}

// /latest.json 分页：第 0 页 = 现有 30 条；第 1、2 页来自 moreTopics。
// 真实站点每页 30 条并带 more_topics_url，这里照做。
function latestPageIds(page) {
  if (page === 0) return latestOrder();
  const start = (page - 1) * UNREAD_PER_PAGE;
  return moreTopics.slice(start, start + UNREAD_PER_PAGE).map((topic) => topic.id);
}

function latestPayload(page = 0) {
  const payload = topicListPayload(latestPageIds(page));
  const hasMore = latestPageIds(page + 1).length > 0;
  payload.topic_list.per_page = UNREAD_PER_PAGE;
  payload.topic_list.more_topics_url = hasMore ? `/latest?no_definitions=true&page=${page + 1}` : null;
  return payload;
}

// 未读列表分页：每页 30 条 + more_topics_url。
function unreadPayload(page = 0) {
  const ids = LOGGED_IN() ? unreadOrder().filter((id) => effectiveUnread(byId(id)) > 0) : [];
  const start = page * UNREAD_PER_PAGE;
  const slice = ids.slice(start, start + UNREAD_PER_PAGE);
  const hasMore = start + UNREAD_PER_PAGE < ids.length;

  const payload = topicListPayload(slice);
  payload.topic_list.more_topics_url = hasMore ? `/unread?page=${page + 1}` : null;
  return payload;
}

// ---------------------------------------------------------------- 预加载数据

// 真实站点上 topicTrackingStates 只覆盖"用户跟踪的一批 Topic"，是有界窗口。
function trackingRows() {
  const order = [101, 103, 106, 102, ...bulkTopics.map((topic) => topic.id)];
  return order.slice(0, TRACKING_WINDOW).map((id) => {
    const topic = byId(id);
    return {
      topic_id: topic.id,
      highest_post_number: highestOf(topic),
      last_read_post_number: topic.lastRead,
      created_at: "2026-08-01T00:00:00.000Z",
      category_id: CATEGORY_ID,
      is_category_topic: false,
      notification_level: 2,
      created_in_new_period: true,
      treat_as_new_topic_start_date: "2026-08-01T00:00:00.000Z",
      tags: []
    };
  });
}

// #data-preloaded。真实站点上 currentUser / topicTrackingStates 这两个值
// 本身又是"被 JSON 编码过的字符串"，必须二次解析 —— 这里刻意复刻。
function preloadData() {
  const data = {
    topic_list: JSON.stringify(latestPayload().topic_list),
    topicTrackingStates: JSON.stringify(trackingRows()),
    topicTrackingStateMeta: JSON.stringify({ "/latest": 3428900 })
  };

  if (LOGGED_IN()) {
    data.currentUser = JSON.stringify({
      id: state.userId,
      username: `probe-user-${state.userId}`,
      name: `Probe User ${state.userId}`
    });
  }

  return data;
}

// ---------------------------------------------------------------- Topic 详情

function topicJson(topic, targetPostNumber = 0) {
  const highest = highestOf(topic);
  const stream = [];
  for (let number = 1; number <= highest; number += 1) stream.push(postId(topic.id, number));

  // 默认只返回前两楼：目标楼层（last_read + 1）不在窗口里，
  // 强迫预览逻辑走 post_stream.stream 索引 + 单独取楼的分支。
  //
  // 带 ?post_number=N 时按真实 Discourse 的行为返回以 N 为中心的窗口
  // （不保证包含 1 楼），这样「按楼层跳转」才走的是真实分支。
  const target = Number(targetPostNumber);
  const windowNumbers =
    Number.isFinite(target) && target > 1
      ? [target - 1, target, target + 1].filter((number) => number >= 1 && number <= highest)
      : [1, 2];

  const posts = windowNumbers
    .filter((number) => number <= highest)
    .map((number) => ({
      id: postId(topic.id, number),
      post_number: number,
      username: `user-${number}`,
      cooked: `<p>楼层 ${number}</p>`
    }));

  const payload = {
    id: topic.id,
    slug: "topic",
    title: topic.title,
    posts_count: highest,
    views: 0,
    highest_post_number: highest,
    post_stream: { stream, posts }
  };

  // 登录态：给 last_read_post_number 与 highest_post_number，
  // 但**不给 unread_posts**（真实站点上这个键根本不存在）。
  if (LOGGED_IN()) {
    payload.last_read_post_number = topic.lastRead;
    payload.current_post_number = 1;
  }

  return payload;
}

function singlePostJson(targetPostId) {
  // post id 约定：topicId * 1000 + postNumber。
  const number = Number(targetPostId) % 1000;
  return {
    post_stream: {
      posts: [
        {
          id: targetPostId,
          post_number: number,
          username: PREVIEW_AUTHOR,
          cooked: `<p>${PREVIEW_TEXT}</p>`
        }
      ]
    }
  };
}

// ---------------------------------------------------------------- 嵌套树

function nestedPost(topic, number) {
  return {
    id: postId(topic.id, number),
    post_number: number,
    username: `user-${number}`,
    name: `User ${number}`,
    cooked: `<p>楼层 ${number}</p>`,
    created_at: "2026-08-01T00:00:00.000Z",
    trust_level: 1,
    actions_summary: [],
    boosts: [],
    can_boost: false
  };
}

// 真实嵌套树接口的形状：op_post + roots（每层带 children / direct_reply_count）。
// 2 楼声称有 3 条直接回复，但只随树带回 1 条 —— 剩下 2 条由
// /n/-/<id>/children/<n>.json 提供，这正是「展示更多回复」按钮的触发条件。
function nestedTreeJson(topic, page = 0) {
  const highest = highestOf(topic);
  const topicMeta = {
    id: topic.id,
    title: topic.title,
    posts_count: highest,
    highest_post_number: highest,
    bookmarked: false,
    bookmark_id: null
  };

  // 分页夹具：第 0 页给 2 楼并声明还有下一页，第 1 页给 3 楼。
  if (topic.paged) {
    const pageNum = Math.max(0, Number(page) || 0);
    const roots =
      pageNum === 0
        ? [nestedPost(topic, 2)]
        : pageNum === 1
          ? [nestedPost(topic, 3)]
          : [];
    return {
      op_post: nestedPost(topic, 1),
      roots,
      topic: topicMeta,
      has_more_roots: pageNum < 1,
      page: pageNum
    };
  }

  return {
    op_post: nestedPost(topic, 1),
    roots: [
      {
        ...nestedPost(topic, 2),
        direct_reply_count: 3,
        children: [nestedPost(topic, 3)]
      }
    ],
    topic: topicMeta,
    has_more_roots: false,
    page: 0
  };
}

function nestedChildrenJson(topic, postNumber) {
  if (Number(postNumber) !== 2) return { children: [], has_more: false, page: 0 };
  // 这个接口返回的是**全部**直接回复（3、4、5），不是"剩余那些"。
  // 引擎会先清空再整体重渲染；只返回 4、5 会把已经显示的第 3 楼弄丢。
  return {
    children: [3, 4, 5].map((number) => nestedPost(topic, number)),
    has_more: false,
    page: 0
  };
}

// ---------------------------------------------------------------- 触摸探针

// 用于标定 Android 模拟器的触摸注入：
// `adb shell input swipe` 到底能不能产生合格的 touchstart/touchmove/touchend 序列，
// 还是会被系统当成一次点击？页面把每次触摸的原始坐标与 move 次数回报给服务端。
//
// 这是**测试夹具**，不属于产品代码。
const touchLog = [];

function touchProbePage() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LDFC 触摸探针</title></head>
<body style="margin:0">
<div style="position:fixed;inset:0;background:#eef;font:13px/1.5 monospace;padding:10px;overflow:auto;white-space:pre-wrap" id="pad"><div id="log">等待触摸…</div></div>
<script>
  var log = [];
  var pad = document.getElementById('pad');
  var out = document.getElementById('log');
  var startX = 0, startY = 0, moves = 0;
  function render() { out.textContent = log.join('\\n'); }

  pad.addEventListener('touchstart', function (e) {
    var t = e.touches[0];
    startX = t.clientX; startY = t.clientY; moves = 0;
    log.push('touchstart  x=' + Math.round(t.clientX) + ' y=' + Math.round(t.clientY));
    render();
    e.preventDefault();
  }, { passive: false });

  pad.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    moves += 1;
    log.push('touchmove#' + moves + '  x=' + Math.round(t.clientX) + ' y=' + Math.round(t.clientY) +
             '  dx=' + Math.round(t.clientX - startX) + ' dy=' + Math.round(t.clientY - startY));
    render();
    e.preventDefault();
  }, { passive: false });

  pad.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    log.push('touchend    x=' + Math.round(t.clientX) + ' y=' + Math.round(t.clientY) +
             '  dx=' + Math.round(t.clientX - startX) + ' dy=' + Math.round(t.clientY - startY) +
             '  moveCount=' + moves);
    log.push('=== 本次结束 ===');
    render();
    fetch('/touch-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ moves: moves, dx: Math.round(t.clientX - startX), dy: Math.round(t.clientY - startY) })
    });
  }, { passive: true });
</script>
</body></html>`;
}

// ---------------------------------------------------------------- 页面

// 创建时间夹具：不同行给不同"年龄"，让三档着色都能被断言。
// 用相对当天的时间生成，避免测试随真实日期流逝而失效。
const CREATED_AGE_DAYS = { 101: 15, 102: 45, 103: 200 };

function topicRow(topic) {
  // 真实层级：table.topic-list > tbody.topic-list-body > tr.topic-list-item
  // 并且行内标题链接**也带** data-topic-id（一个 Topic 两个 data-topic-id）。
  const ageDays = CREATED_AGE_DAYS[topic.id];
  const createdAttr =
    ageDays != null
      ? ` data-created-at="${new Date(Date.now() - ageDays * 86400000).toISOString()}"`
      : "";
  const ageCell = ageDays != null ? '\n        <td class="age"></td>' : "";
  return `      <tr class="topic-list-item" data-topic-id="${topic.id}"${createdAttr}>
        <td class="main-link">
          <a class="title raw-link raw-topic-link" data-topic-id="${topic.id}" href="/t/topic/${topic.id}">${topic.title}</a>
        </td>
        <td class="posters"><a href="/u/poster-${topic.id}">poster-${topic.id}</a></td>
        <td class="num posts">${highestOf(topic)}</td>${ageCell}
      </tr>`;
}

function pageShell(title, body) {
  const preload = JSON.stringify(preloadData());
  return `<!doctype html>
<html class="${LOGGED_IN() ? "" : "anon"}">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<script type="application/json" id="data-preloaded">${preload}</script>
<header><h1>${title}</h1></header>
${body}
</body></html>`;
}

// 模拟 Discourse 的原生无限滚动：
// 监听 scroll，哨兵进入视口就加载下一页并追加行。
// 扩展的自动补位就是"派发一次 scroll 事件"来驱动这段逻辑。
const INFINITE_SCROLL_SCRIPT = `<script>
(function () {
  var page = 0;
  var loading = false;
  var sentinel = document.querySelector(".load-more-sentinel");

  function maybeLoad() {
    if (loading || !sentinel) return;
    var rect = sentinel.getBoundingClientRect();
    // 哨兵不在视口内就不加载 —— 与 Discourse 行为一致
    if (rect.top > window.innerHeight + 120) return;

    loading = true;
    fetch("/latest.json?page=" + (page + 1), { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        var topics = (payload && payload.topic_list && payload.topic_list.topics) || [];
        if (!topics.length) { loading = false; return; }
        page += 1;
        var tbody = document.querySelector(".topic-list-body");
        topics.forEach(function (topic) {
          var row = document.createElement("tr");
          row.className = "topic-list-item";
          row.setAttribute("data-topic-id", topic.id);
          row.innerHTML =
            '<td class="main-link"><a class="title raw-link raw-topic-link" data-topic-id="' +
            topic.id + '" href="/t/topic/' + topic.id + '">' + topic.title + "</a></td>";
          tbody.appendChild(row);
        });
        window.__fixtureLoadedPage = page;
        loading = false;
      })
      .catch(function () { loading = false; });
  }

  window.addEventListener("scroll", maybeLoad);
  window.__fixtureInfiniteScroll = maybeLoad;
})();
</script>`;

function listPage() {
  const rows = pageOrder()
    .map((id) => byId(id))
    .filter(Boolean)
    .map(topicRow)
    .join("\n");

  return pageShell(
    "LDFC Probe 页面",
    `<table class="topic-list">
  <tbody class="topic-list-body">
${rows}
  </tbody>
</table>
<div aria-hidden="true" class="load-more-sentinel"></div>
${INFINITE_SCROLL_SCRIPT}`
  );
}

function topicPage(topic) {
  const posts = [];
  for (let number = 1; number <= Math.min(highestOf(topic), 20); number += 1) {
    posts.push(`<div id="post_${number}" class="topic-post"><p>楼层 ${number}</p></div>`);
  }
  return pageShell(topic.title, `<div id="main-outlet">${posts.join("\n")}</div>`);
}

// ---------------------------------------------------------------- HTTP

function sendJson(response, payload) {
  response.writeHead(200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, body) {
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(body);
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname;

  try {
    // ---- 测试开关 ----
    if (pathname === "/__set") {
      if (url.searchParams.has("unread")) {
        state.unreadEnabled = url.searchParams.get("unread") !== "0";
      }
      // user=<数字 id> 切换账号
      if (url.searchParams.has("user")) {
        state.userId = Number(url.searchParams.get("user"));
        state.identity = "user";
      }
      // login=0|1 切换登录 / 未登录
      if (url.searchParams.has("login")) {
        state.identity = url.searchParams.get("login") === "0" ? "guest" : "user";
      }
      return sendJson(response, { ...state });
    }

    // ---- 身份 ----
    if (pathname === "/session/current.json") {
      if (!LOGGED_IN()) {
        response.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        response.end("{}");
        return;
      }
      return sendJson(response, {
        current_user: { id: state.userId, username: `probe-user-${state.userId}` }
      });
    }

    // ---- 列表 ----
    if (pathname === "/latest.json") {
      return sendJson(response, latestPayload(Number(url.searchParams.get("page") || 0)));
    }

    if (pathname === "/unread.json") {
      // 未登录没有"我的未读列表"，真实站点返回 403。
      if (!LOGGED_IN()) {
        response.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
        response.end("{}");
        return;
      }
      const page = Number(url.searchParams.get("page") || 0);
      return sendJson(response, unreadPayload(page));
    }

    // ---- Topic 详情 ----
    const singlePostMatch = pathname.match(/^\/t\/(\d+)\/posts\.json$/);
    if (singlePostMatch) {
      // 真实接口是 /t/<topicId>/posts.json?post_ids[]=<postId>。
      // 路径里的 <topicId> **不是** postId，早先拿它当 postId 会算出
      // post_number=102 这种脏楼层，把「随机跳楼」的断言带偏。
      const ids = url.searchParams
        .getAll("post_ids[]")
        .map(Number)
        .filter((value) => Number.isFinite(value));
      const posts = ids.length
        ? ids.flatMap((id) => singlePostJson(id).post_stream.posts)
        : [];
      return sendJson(response, { post_stream: { posts } });
    }

    const topicJsonMatch = pathname.match(/^\/t\/(\d+)\.json$/);
    if (topicJsonMatch) {
      const topic = byId(topicJsonMatch[1]);
      if (!topic) {
        response.writeHead(404).end("{}");
        return;
      }
      const postNumber = Number(url.searchParams.get("post_number") || 0);
      return sendJson(response, topicJson(topic, postNumber));
    }

    // 预览引擎优先请求嵌套树接口。
    //   - 普通 Topic 返回标准 topic，引擎走 standardTopicToNestedTree() 兼容分支；
    //   - 标记了 nested 的 Topic 返回真实嵌套树形状，用来验证「展开楼中楼」。
    const nestedTopicMatch = pathname.match(/^\/n\/-\/(\d+)\.json$/);
    if (nestedTopicMatch) {
      const topic = byId(nestedTopicMatch[1]);
      if (!topic) {
        response.writeHead(404).end("{}");
        return;
      }
      if (topic.nested) {
        const page = Number(url.searchParams.get("page") || 0);
        return sendJson(response, nestedTreeJson(topic, page));
      }
      const postNumber = Number(url.searchParams.get("post_number") || 0);
      return sendJson(response, topicJson(topic, postNumber));
    }

    const nestedChildrenMatch = pathname.match(/^\/n\/-\/(\d+)\/children\/(\d+)\.json$/);
    if (nestedChildrenMatch) {
      const topic = byId(nestedChildrenMatch[1]);
      if (!topic) {
        response.writeHead(404).end("{}");
        return;
      }
      return sendJson(response, nestedChildrenJson(topic, nestedChildrenMatch[2]));
    }

    // ---- 页面 ----
    // slug 固定为 "topic"（与真实站点一致）
    const topicPageMatch = pathname.match(/^\/t\/topic\/(\d+)(?:\/(\d+))?$/);
    if (topicPageMatch) {
      const topic = byId(topicPageMatch[1]);
      if (!topic) {
        response.writeHead(404).end("not found");
        return;
      }
      return sendHtml(response, topicPage(topic));
    }

    if (pathname === "/" || pathname === "/latest" || pathname === "/top" || pathname === "/unread") {
      return sendHtml(response, listPage());
    }

    if (pathname === "/search") {
      // 真实站点搜索结果用 .fps-result，**不是** .topic-list-item
      return sendHtml(
        response,
        pageShell(
          "搜索",
          `<div class="search-container"><div class="search-results">
${pageOrder()
  .slice(0, 5)
  .map((id) => {
    const topic = byId(id);
    return `    <div class="fps-result" data-topic-id="${topic.id}"><a href="/t/topic/${topic.id}">${topic.title}</a></div>`;
  })
  .join("\n")}
</div></div>`
        )
      );
    }

    // ---- 触摸探针（仅测试用）----
    if (pathname === "/touch-probe") {
      return sendHtml(response, touchProbePage());
    }
    if (pathname === "/touch-log") {
      if (request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          try { touchLog.push(JSON.parse(body)); } catch { touchLog.push({ parseError: true, raw: body.slice(0, 200) }); }
          sendJson(response, { ok: true, count: touchLog.length });
        });
        return;
      }
      return sendJson(response, touchLog);
    }

    response.writeHead(404).end("not found");
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(String(error && error.stack ? error.stack : error));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LDFC probe fixture listening on http://127.0.0.1:${PORT}`);
});
