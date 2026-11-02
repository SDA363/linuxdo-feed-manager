"use strict";

// 同步合并模型的单测（纯 Node，不需要浏览器 / 网络）。
//
// 覆盖：
//   1. 逐条 LWW（本地新 / 远程新 / 只有一边有）
//   2. 同 updatedAt 的 tie-break 确定性（两台设备结果必须一致）
//   3. 墓碑与记录的先后关系（删除 vs 重新标记）
//   4. 预览 / 已读基线这类"不更新 updatedAt"的字段
//   5. 幂等、入参不可变、远程文档校验与隐私默认值
//
// 用法：node tools/test-sync-model.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const MODEL_FILE = path.join(ROOT, "linuxdo-personal-feed-manager", "storage", "syncModel.js");

// Node 的 vm 上下文只有语言内建对象，没有宿主 API。
// schema 3 的 gzip + base64 用到下面这些，必须显式注入，
// 否则 canCompress 会静默为 false，压缩路径根本没被测到。
const sandbox = {
  window: {},
  console,
  btoa,
  atob,
  Blob,
  Response,
  TextEncoder,
  TextDecoder,
  CompressionStream,
  DecompressionStream
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(MODEL_FILE, "utf8"), sandbox, { filename: MODEL_FILE });
const model = sandbox.window.LDFCSyncModel;

const results = [];
const check = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

// 时间点用真实量级的毫秒值，便于对照"10:00 / 10:05 / 9:55"这类描述。
const T_955 = 35_700_000;
const T_1000 = 36_000_000;
const T_1005 = 36_300_000;

const record = (topicId, overrides = {}) => ({
  topicId: String(topicId),
  basePool: "INTERESTED",
  inNewReply: false,
  createdAt: 9_000,
  enteredPoolAt: 9_000,
  updatedAt: T_1000,
  title: `Topic ${topicId}`,
  slug: `slug-${topicId}`,
  ...overrides
});

const merge = (local, remote) => model.mergeTopics(local, remote);
const canonical = (value) => model.canonical(value);

// ---- 1. 基础 LWW ----
{
  const out = merge({ topics: [record("1")] }, { topics: [] });
  check(
    out.topics.length === 1 && out.topics[0].basePool === "INTERESTED" && out.stats.unchanged === 1,
    `只有本地有：保留（stats=${JSON.stringify(out.stats)}）`
  );
}

{
  const out = merge({ topics: [] }, { topics: [record("2", { basePool: "READ" })] });
  check(
    out.topics.length === 1 && out.topics[0].basePool === "READ" && out.stats.added === 1,
    `只有远程有：新增（stats=${JSON.stringify(out.stats)}）`
  );
}

{
  const out = merge(
    { topics: [record("3", { basePool: "INTERESTED", updatedAt: T_1000 })] },
    { topics: [record("3", { basePool: "DISMISSED", updatedAt: T_1005 })] }
  );
  check(
    out.topics[0].basePool === "DISMISSED" && out.stats.updated === 1,
    `远程更新：取远程（pool=${out.topics[0].basePool}，stats=${JSON.stringify(out.stats)}）`
  );
}

{
  const out = merge(
    { topics: [record("4", { basePool: "READ", updatedAt: T_1005 })] },
    { topics: [record("4", { basePool: "DISMISSED", updatedAt: T_1000 })] }
  );
  check(
    out.topics[0].basePool === "READ" && out.stats.unchanged === 1,
    `本地更新：取本地（pool=${out.topics[0].basePool}，stats=${JSON.stringify(out.stats)}）`
  );
}

// ---- 2. 同时间戳 tie-break ----
{
  const local = record("5", { deviceId: "device-a", updatedAt: T_1000, basePool: "INTERESTED" });
  const remote = record("5", { deviceId: "device-b", updatedAt: T_1000, basePool: "READ" });
  const ab = merge({ topics: [local] }, { topics: [remote] });
  const ba = merge({ topics: [remote] }, { topics: [local] });

  check(
    canonical(ab.topics[0]) === canonical(ba.topics[0]),
    "同时间戳：两台设备各自合并的结果完全一致（symmetric）"
  );
  check(
    ab.topics[0].deviceId === "device-b" && ab.topics[0].basePool === "READ",
    `同时间戳：deviceId 字典序较大者胜（winner=${ab.topics[0].deviceId}，pool=${ab.topics[0].basePool}）`
  );
}

{
  const left = record("6", { title: "标题 A", updatedAt: T_1000 });
  const right = record("6", { title: "标题 B", updatedAt: T_1000 });
  const ab = merge({ topics: [left] }, { topics: [right] });
  const ba = merge({ topics: [right] }, { topics: [left] });
  check(
    canonical(ab.topics[0]) === canonical(ba.topics[0]),
    `同时间戳且无 deviceId：仍收敛到同一结果（title=${ab.topics[0].title}）`
  );
}

// ---- 3. 墓碑与记录 ----
{
  const local = { topics: [record("7", { updatedAt: T_1000 })], tombstones: [] };
  const remote = { topics: [], tombstones: [{ topicId: "7", deletedAt: T_1005 }] };

  const forward = merge(local, remote);
  const backward = merge(remote, local);
  check(
    forward.topics.length === 0 &&
      forward.tombstones.length === 1 &&
      forward.tombstones[0].deletedAt === T_1005 &&
      forward.stats.removed === 1,
    `墓碑更晚（10:05 > 10:00）：删除记录（stats=${JSON.stringify(forward.stats)}）`
  );
  check(
    canonical(forward.topics) === canonical(backward.topics) &&
      canonical(forward.tombstones) === canonical(backward.tombstones),
    "墓碑更晚：反向合并得到同样结果（对称）"
  );
}

{
  const local = { topics: [record("8", { updatedAt: T_1000 })], tombstones: [] };
  const remote = { topics: [], tombstones: [{ topicId: "8", deletedAt: T_955 }] };
  const out = merge(local, remote);
  check(
    out.topics.length === 1 && out.tombstones.length === 0 && out.stats.unchanged === 1,
    `墓碑更早（9:55 < 10:00）：保留记录、丢弃过期墓碑（stats=${JSON.stringify(out.stats)}）`
  );
}

{
  const out = merge(
    { tombstones: [{ topicId: "11", deletedAt: T_1000 }] },
    { tombstones: [{ topicId: "11", deletedAt: T_1005 }] }
  );
  check(
    out.tombstones.length === 1 && out.tombstones[0].deletedAt === T_1005,
    `墓碑对墓碑：取较新的 deletedAt（${out.tombstones[0]?.deletedAt}）`
  );
}

// ---- 4. 预览与阅读基线（不参与 updatedAt 判定）----
{
  const local = {
    topics: [
      record("9", {
        updatedAt: T_1000,
        previewText: "本地预览",
        previewAuthor: "alice",
        previewForRead: 50,
        readUpToPostNumber: 12
      })
    ]
  };
  const remote = {
    topics: [
      record("9", {
        basePool: "READ",
        updatedAt: T_1005,
        previewText: "",
        previewAuthor: "",
        previewForRead: null,
        readUpToPostNumber: null
      })
    ]
  };

  const out = merge(local, remote);
  const merged = out.topics[0];
  check(
    merged.basePool === "READ" && merged.updatedAt === T_1005,
    `远程胜出：归属与 updatedAt 取远程（pool=${merged.basePool}，updatedAt=${merged.updatedAt}）`
  );
  check(
    merged.previewText === "本地预览" && merged.previewAuthor === "alice" && merged.previewForRead === 50,
    `远程没有预览：保留本地预览，不因 updatedAt 丢失（previewForRead=${merged.previewForRead}）`
  );
  check(
    merged.readUpToPostNumber === 12,
    `远程没有阅读基线：保留本地值（readUpToPostNumber=${merged.readUpToPostNumber}）`
  );
  check(
    merged.updatedAt === T_1005,
    `合并预览不会抬高 updatedAt（不会被顶到池子最前：updatedAt=${merged.updatedAt}）`
  );
}

// ---- 4b. 通知手动接管标记：独立时间戳，不被池子 LWW 覆盖 ----
{
  const local = record("23", {
    deviceId: "device-a",
    updatedAt: T_1005,
    notifyManualLevel: 1,
    notifyManualAt: T_1005
  });
  const remote = record("23", {
    deviceId: "device-b",
    updatedAt: T_1000,
    notifyManualLevel: 0,
    notifyManualAt: T_1000
  });
  const out = merge({ topics: [local] }, { topics: [remote] });
  check(
    out.topics[0].notifyManualLevel === 1 && out.topics[0].notifyManualAt === T_1005,
    `通知接管：池子胜者与通知胜者分开计算（level=${out.topics[0].notifyManualLevel}，at=${out.topics[0].notifyManualAt}）`
  );
}

{
  const local = record("24", {
    updatedAt: T_1000,
    notifyManualLevel: 1,
    notifyManualAt: T_1005
  });
  const remote = record("24", {
    basePool: "READ",
    updatedAt: T_1005,
    notifyManualLevel: null,
    notifyManualAt: null
  });
  const out = merge({ topics: [local] }, { topics: [remote] });
  check(
    out.topics[0].basePool === "READ" &&
      out.topics[0].notifyManualLevel === 1 &&
      out.topics[0].notifyManualAt === T_1005,
    `通知接管：远程池子更新不会抹掉本地较新的手动标记（pool=${out.topics[0].basePool}，level=${out.topics[0].notifyManualLevel}）`
  );
}

{
  const local = record("25", {
    updatedAt: T_1000,
    notifyManualLevel: 1,
    notifyManualAt: T_1000
  });
  const remote = record("25", {
    updatedAt: T_1005,
    notifyManualLevel: null,
    notifyManualAt: T_1005
  });
  const out = merge({ topics: [local] }, { topics: [remote] });
  check(
    out.topics[0].notifyManualLevel === null && out.topics[0].notifyManualAt === T_1005,
    `通知接管：较新的「跟随信息池」清除也能同步（level=${out.topics[0].notifyManualLevel}，at=${out.topics[0].notifyManualAt}）`
  );
}

{
  const left = record("26", {
    notifyManualLevel: 1,
    notifyManualAt: T_1005
  });
  const right = record("26", {
    notifyManualLevel: 0,
    notifyManualAt: T_1005
  });
  const ab = merge({ topics: [left] }, { topics: [right] });
  const ba = merge({ topics: [right] }, { topics: [left] });
  check(
    canonical(ab.topics[0]) === canonical(ba.topics[0]),
    `通知接管：同时间戳仍收敛到同一结果（level=${ab.topics[0].notifyManualLevel}）`
  );
}

{
  const out = merge(
    { topics: [record("10", { updatedAt: T_1000, previewText: "本地", readUpToPostNumber: 3 })] },
    { topics: [record("10", { updatedAt: T_1005, previewText: "远程", readUpToPostNumber: null })] }
  );
  check(
    out.topics[0].previewText === "远程" && out.topics[0].readUpToPostNumber === 3,
    `两边都有预览：胜者预览优先，缺的阅读基线从败者补（preview=${out.topics[0].previewText}，readUpTo=${out.topics[0].readUpToPostNumber}）`
  );
}

{
  const out = merge(
    { topics: [record("19", { updatedAt: T_1000, previewText: "", previewAuthor: "", previewForRead: 40 })] },
    { topics: [record("19", { updatedAt: T_1005, previewText: "远程正文", previewAuthor: "bob", previewForRead: 60 })] }
  );
  check(
    out.topics[0].previewForRead === 60 &&
      out.topics[0].previewAuthor === "bob" &&
      out.topics[0].previewText === "远程正文",
    `预览三件套不被拆开重组（previewForRead=${out.topics[0].previewForRead}，author=${out.topics[0].previewAuthor}）`
  );
}

// ---- 5. 幂等 / 入参不可变 ----
{
  const local = {
    topics: [record("20", { updatedAt: T_1000 }), record("21", { updatedAt: T_1000 })],
    tombstones: [{ topicId: "22", deletedAt: T_955 }]
  };
  const remote = {
    topics: [record("20", { updatedAt: T_1005, basePool: "READ" })],
    tombstones: [{ topicId: "21", deletedAt: T_1005 }]
  };

  const snapshot = canonical({ local, remote });
  const first = merge(local, remote);
  check(canonical({ local, remote }) === snapshot, "合并不修改入参");

  const second = merge({ topics: first.topics, tombstones: first.tombstones }, remote);
  check(
    second.stats.added === 0 && second.stats.updated === 0 && second.stats.removed === 0,
    `幂等：同一份远程数据再合并一次没有任何变化（stats=${JSON.stringify(second.stats)}）`
  );
  check(
    canonical(second.topics) === canonical(first.topics) &&
      canonical(second.tombstones) === canonical(first.tombstones),
    "幂等：两次合并结果完全一致"
  );
}

// ---- 6. 远程文档校验与隐私默认值 ----
{
  let threw = false;
  try {
    model.fromRemoteDoc({ schema: 99 });
  } catch {
    threw = true;
  }
  check(threw, "schema 不兼容：整体拒绝");
}

{
  let threw = false;
  try {
    model.fromRemoteDoc({ schema: 1, namespace: "user-1" }, "user-2");
  } catch {
    threw = true;
  }
  check(threw, "namespace 不符：整体拒绝");
}

{
  const parsed = model.fromRemoteDoc(
    {
      schema: 1,
      namespace: "user-1",
      topics: [
        { topicId: "12", basePool: "HOME" },
        { topicId: "bad", basePool: "HOME" },
        { topicId: "13", basePool: "NOPE" }
      ],
      tombstones: [
        { topicId: "14", deletedAt: 5 },
        { topicId: "x", deletedAt: 1 }
      ]
    },
    "user-1"
  );
  check(
    parsed.topics.length === 1 &&
      parsed.topics[0].topicId === "12" &&
      parsed.tombstones.length === 1 &&
      parsed.tombstones[0].topicId === "14",
    `非法条目被丢弃（topics=${parsed.topics.length}，tombstones=${parsed.tombstones.length}）`
  );
}

{
  const doc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "d1",
    topics: [record("15", { previewText: "秘密预览", excerpt: "正文摘要" })],
    tombstones: []
  });
  check(
    doc.schema === 2 &&
      doc.namespace === "user-1" &&
      !("pt" in doc.topics[0]) &&
      !("x" in doc.topics[0]),
    `远程文档默认不含正文片段（字段=${JSON.stringify(Object.keys(doc.topics[0]))}）`
  );
}

{
  const docWithContent = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "d1",
    topics: [record("16", { previewText: "预览" })],
    tombstones: [],
    includePreviews: true
  });
  check(
    docWithContent.topics[0].pt === "预览" &&
      model.fromRemoteDoc(docWithContent, "user-1").topics[0].previewText === "预览",
    "includePreviews=true 时才带预览"
  );
}

// 短键编码：键名必须都落在 FIELD_KEYS 内，且默认值被省略
{
  const doc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "d1",
    topics: [
      record("19", {
        deviceId: "d1",
        inNewReply: false,
        unreadPosts: 0,
        enteredPoolAt: T_1000,
        updatedAt: T_1000
      })
    ],
    tombstones: []
  });
  const row = doc.topics[0];
  check(
    !("n" in row) && !("up" in row) && !("ea" in row) && row.i === "19" && row.p === "s",
    `默认值被省略（字段=${JSON.stringify(Object.keys(row))}）`
  );
  const back = model.fromRemoteDoc(doc, "user-1").topics[0];
  check(
    back.inNewReply === false &&
      back.unreadPosts === 0 &&
      back.enteredPoolAt === T_1000 &&
      back.basePool === "INTERESTED" &&
      back.deviceId === "d1" &&
      back.title === "Topic 19",
    `省略的默认值解码后原样补回（${JSON.stringify(back)}）`
  );
}

// 设备字典：同一个 deviceId 不重复写进每条记录
{
  const doc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "dev-a",
    topics: [record("20", { deviceId: "dev-a" }), record("21", { deviceId: "dev-a" })],
    tombstones: []
  });
  check(
    doc.devices.length === 1 &&
      doc.devices[0] === "dev-a" &&
      doc.topics.every((row) => !("d" in row)),
    `设备字典只留一份（devices=${JSON.stringify(doc.devices)}）`
  );
  check(
    model.fromRemoteDoc(doc, "user-1").topics.every((row) => row.deviceId === "dev-a"),
    "设备字典解码回真实 deviceId"
  );
}

// 真实数据形态：slug 是占位 "topic"、一堆字段是 null / ""，编码后都应消失
{
  const doc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "d1",
    topics: [
      {
        topicId: "40",
        deviceId: "d1",
        basePool: "READ",
        inNewReply: false,
        createdAt: T_1000,
        enteredPoolAt: T_1000,
        updatedAt: T_1000,
        title: "标题",
        slug: "topic",
        categoryId: null,
        lastPosterUsername: "",
        lastReadPostNumber: null,
        highestPostNumber: null,
        unreadPosts: 0,
        lastPostedAt: null,
        readUpToPostNumber: null
      }
    ],
    tombstones: []
  });
  const keys = Object.keys(doc.topics[0]).sort().join(",");
  check(keys === "i,p,t,ua", `真实形态只留必要字段（${keys}）`);
  const back = model.fromRemoteDoc(doc, "user-1").topics[0];
  check(
    back.basePool === "READ" &&
      back.createdAt === T_1000 &&
      back.enteredPoolAt === T_1000 &&
      back.inNewReply === false &&
      back.unreadPosts === 0,
    `空值省略后往返语义不变（${JSON.stringify(back)}）`
  );
}

// 老 remote doc（schema 1，长键 + 对象墓碑）仍然能读，不要求用户手动迁移
{
  const legacy = model.fromRemoteDoc(
    {
      schema: 1,
      namespace: "user-1",
      topics: [{ topicId: "30", basePool: "READ", deviceId: "old", title: "老格式" }],
      tombstones: [{ topicId: "31", deletedAt: 7 }]
    },
    "user-1"
  );
  check(
    legacy.topics.length === 1 &&
      legacy.topics[0].basePool === "READ" &&
      legacy.topics[0].title === "老格式" &&
      legacy.tombstones[0].topicId === "31",
    "schema 1 老远端文件仍可读（只写不读会让人被迫手动迁移）"
  );
}

{
  const roundTrip = model.fromRemoteDoc(
    model.toRemoteDoc({
      namespace: "user-1",
      deviceId: "d1",
      topics: [record("17", { basePool: "READ" })],
      tombstones: [{ topicId: "18", deletedAt: T_1005 }]
    }),
    "user-1"
  );
  check(
    roundTrip.topics.length === 1 && roundTrip.tombstones.length === 1,
    "toRemoteDoc → fromRemoteDoc 往返不丢数据"
  );
}

// ---- schema 3：gzip + base64 封装 ----
(async () => {
  const plain = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "d1",
    topics: Array.from({ length: 40 }, (_, index) =>
      record(String(300 + index), { title: `某个中文标题 ${index}`, updatedAt: T_1000 + index })
    ),
    tombstones: []
  });

  check(model.SCHEMA_VERSION === 3, `封装版 schema = 3（实际 ${model.SCHEMA_VERSION}）`);
  check(
    model.PLAIN_SCHEMA_VERSION === 2,
    `未压缩文档 schema 仍为 2（实际 ${model.PLAIN_SCHEMA_VERSION}）`
  );
  check(
    model.FILE_SCHEMA_VERSION === 5,
    `紧凑文件 schema = 5（实际 ${model.FILE_SCHEMA_VERSION}）`
  );

  const envelope = await model.encodeRemoteDoc(plain);
  check(
    envelope.encoding === "gzip+base64" && typeof envelope.payload === "string" && envelope.payload.length > 0,
    `encodeRemoteDoc 输出 gzip+base64 封装（encoding=${envelope.encoding}）`
  );
  check(!("topics" in envelope), "封装体不暴露 topics（文件不可读是既定代价）");
  check(
    envelope.namespace === "user-1" && envelope.deviceId === "d1",
    "封装体保留 namespace / deviceId 便于快速识别"
  );

  const restored = await model.decodeRemoteDoc(JSON.parse(JSON.stringify(envelope)));
  check(
    JSON.stringify(restored) === JSON.stringify(plain),
    "解封装后与原始 schema 2 文档逐字节一致"
  );

  const decodedAgain = model.fromRemoteDoc(restored, "user-1");
  check(
    decodedAgain.topics.length === plain.topics.length && decodedAgain.topics[0].title === "某个中文标题 0",
    "解封装后可正常进入合并（标题等中文字段无损）"
  );

  const plainBytes = Buffer.byteLength(JSON.stringify(plain));
  const packedBytes = Buffer.byteLength(JSON.stringify(envelope));
  check(
    packedBytes < plainBytes,
    `封装后体积确实变小（${plainBytes} -> ${packedBytes}，${Math.round((1 - packedBytes / plainBytes) * 100)}%）`
  );

  check(
    JSON.stringify(await model.decodeRemoteDoc({ schema: 2, namespace: "user-1", topics: [] })) ===
      JSON.stringify({ schema: 2, namespace: "user-1", topics: [] }),
    "decodeRemoteDoc 对 schema 2 原样返回（老文件不用迁移）"
  );
  check(
    (await model.decodeRemoteDoc({ schema: 1, namespace: "user-1", topics: [] })).schema === 1,
    "decodeRemoteDoc 对 schema 1 原样返回"
  );

  let rejectedRaw = false;
  try {
    model.fromRemoteDoc(envelope, "user-1");
  } catch {
    rejectedRaw = true;
  }
  check(rejectedRaw, "fromRemoteDoc 拒绝未解封装的 schema 3（防止绕过解压）");

  let rejectedEncoding = false;
  try {
    await model.decodeRemoteDoc({ schema: 3, encoding: "lz4", payload: "AAAA" });
  } catch {
    rejectedEncoding = true;
  }
  check(rejectedEncoding, "未知 encoding 明确报错");

  let rejectedNamespace = false;
  try {
    const other = await model.encodeRemoteDoc({ ...plain, namespace: "user-2" });
    await model.decodeRemoteDoc({ ...other, namespace: "user-1" });
  } catch {
    rejectedNamespace = true;
  }
  check(rejectedNamespace, "封装 namespace 与内容不一致时报错");

  // ---- schema 4：裸 gzip 二进制 + 紧凑行 ----
  const richRows = [
    record("501", {
      deviceId: "dev-a",
      updatedAt: T_1000,
      // 真实数据里 lastPostedAt 有时是毫秒数、有时是 ISO 字符串
      lastPostedAt: 1_790_000_000_000,
      lastPosterUsername: "alice",
      title: "标题 501"
    }),
    record("502", {
      deviceId: "dev-b",
      updatedAt: T_1005,
      lastPostedAt: "2026-10-31T10:16:44.317Z",
      title: "标题 502"
    })
  ];
  const richDoc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "dev-a",
    topics: richRows,
    tombstones: [{ topicId: "503", deletedAt: T_1005 }]
  });
  const fileBytes = await model.serializeRemoteFile(richDoc);

  check(
    fileBytes[0] === 0x1f && fileBytes[1] === 0x8b,
    `serializeRemoteFile 产出裸 gzip（前两字节 ${fileBytes[0].toString(16)} ${fileBytes[1].toString(16)}）`
  );

  const parsedBack = await model.parseRemoteFile(fileBytes);
  const roundTripRecords = model.fromRemoteDoc(parsedBack, "user-1");
  const originalRecords = model.fromRemoteDoc(richDoc, "user-1");
  check(
    JSON.stringify(roundTripRecords.topics.map(model.canonical)) ===
      JSON.stringify(originalRecords.topics.map(model.canonical)),
    "schema 4 往返：记录逐字段一致"
  );
  check(
    roundTripRecords.tombstones.length === 1 && roundTripRecords.tombstones[0].deletedAt === T_1005,
    "schema 4 往返：墓碑完整"
  );

  const byId = new Map(roundTripRecords.topics.map((item) => [item.topicId, item]));
  check(
    byId.get("501")?.deviceId === "dev-a" && byId.get("502")?.deviceId === "dev-b",
    "schema 4：每条记录的 deviceId 各自保留（列里必须带 d）"
  );
  check(
    byId.get("501")?.lastPostedAt === 1_790_000_000_000 &&
      byId.get("502")?.lastPostedAt === "2026-10-31T10:16:44.317Z",
    "schema 4：数字时间戳与 ISO 字符串混用都不会被改写"
  );
  check(
    byId.get("501")?.updatedAt === T_1000,
    "schema 4：毫秒时间戳往返精确到毫秒（base36 无损）"
  );

  // schema 5：通知手动接管标记也要往返，且不能影响 updatedAt
  const notifyRows = [
    record("511", {
      deviceId: "dev-a",
      updatedAt: T_1000,
      notifyManualLevel: 0,
      notifyManualAt: T_1005
    }),
    record("512", {
      deviceId: "dev-a",
      updatedAt: T_1000,
      notifyManualLevel: null,
      notifyManualAt: T_1005
    })
  ];
  const notifyDoc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "dev-a",
    topics: notifyRows,
    tombstones: []
  });
  const compactNotify = model.toCompactDoc(notifyDoc);
  check(
    compactNotify.schema === 5 && compactNotify.cols.includes("nm") && compactNotify.cols.includes("nma"),
    `schema 5 文件带通知接管列（schema=${compactNotify.schema}，cols=${compactNotify.cols.join(",")}）`
  );
  const notifyBack = model.fromRemoteDoc(
    await model.parseRemoteFile(await model.serializeRemoteFile(notifyDoc)),
    "user-1"
  );
  const notifyById = new Map(notifyBack.topics.map((item) => [item.topicId, item]));
  check(
    notifyById.get("511")?.notifyManualLevel === 0 &&
      notifyById.get("511")?.notifyManualAt === T_1005 &&
      notifyById.get("511")?.updatedAt === T_1000,
    `schema 5 往返：手动接管 level=0 不丢、updatedAt 不被抬高（${JSON.stringify(notifyById.get("511"))}）`
  );
  check(
    (notifyById.get("512")?.notifyManualLevel === null ||
      notifyById.get("512")?.notifyManualLevel === undefined) &&
      notifyById.get("512")?.notifyManualAt === T_1005,
    `schema 5 往返：显式清除标记也保留时间戳（${JSON.stringify(notifyById.get("512"))}）`
  );

  // schema 4 老文件仍可读：列里没有 nm/nma 时按"无接管"处理
  const legacyCompact = {
    ...compactNotify,
    schema: 4,
    cols: compactNotify.cols.filter((key) => key !== "nm" && key !== "nma"),
    topics: compactNotify.topics.map((cells) =>
      compactNotify.cols
        .filter((key) => key !== "nm" && key !== "nma")
        .map((key) => cells[compactNotify.cols.indexOf(key)])
    )
  };
  const legacyParsed = await model.parseRemoteFile(
    new TextEncoder().encode(JSON.stringify(legacyCompact))
  );
  const legacySemantic = model.fromRemoteDoc(legacyParsed, "user-1");
  check(
    legacySemantic.topics.length === 2 &&
      legacySemantic.topics.every((item) => item.notifyManualLevel === undefined),
    `schema 4 老文件仍可读，且不会凭空补出接管标记（${legacySemantic.topics.length} 条）`
  );

  // 超过 2^53 的 ID 不能走 Number，否则静默丢精度
  const hugeDoc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "dev-a",
    topics: [record("9007199254740993", { title: "超大 ID" })],
    tombstones: []
  });
  const hugeBack = model.fromRemoteDoc(await model.parseRemoteFile(await model.serializeRemoteFile(hugeDoc)), "user-1");
  check(
    hugeBack.topics[0]?.topicId === "9007199254740993",
    `schema 4：超出安全整数的 topicId 保持字符串（实际 ${hugeBack.topics[0]?.topicId}）`
  );

  // 老格式仍然要能读
  check(
    (await model.parseRemoteFile(new TextEncoder().encode(JSON.stringify(plain)))).schema === 2,
    "parseRemoteFile 兼容 schema 2 明文 JSON"
  );
  check(
    (await model.parseRemoteFile(new TextEncoder().encode(JSON.stringify(envelope)))).schema === 2,
    "parseRemoteFile 兼容 schema 3 信封"
  );

  console.log("===== 同步合并模型单测 =====");
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(`\n汇总：${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
})();
