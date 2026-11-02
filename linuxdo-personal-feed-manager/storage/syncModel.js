(() => {
  // 同步合并模型：纯函数，不碰 IndexedDB、网络、DOM，方便脱离浏览器单测。
  //
  // 设计要点（对应 docs 里的 V1.1 云同步决策）：
  //   1. 逐条 LWW（updatedAt 大者胜），绝不整库覆盖；
  //   2. 删除靠墓碑传播：墓碑比记录新才算删除，否则记录保留；
  //   3. updatedAt 完全相同时用确定性 tie-break，保证 A、B 两台设备
  //      各自独立计算也得出同一个结果（否则会互相覆盖、来回抖）；
  //   4. 预览与本地阅读基线不参与新旧判定 —— 它们写入时不更新 updatedAt，
  //      若参与判定，合并会把记录顶到池子最前，或把字段冲掉。
  //   5. 通知「手动接管」标记用独立时间戳 notifyManualAt 合并：它也不动
  //      updatedAt，但不能被池子归属的 LWW 覆盖。
  // schema 2：远程文档改短键 + 设备字典 + 省略默认值。
  // 记录数上千时，长键名（"lastPosterUsername": 这种）比数据本身还大。
  //
  // schema 3：把 schema 2 的整份文档 gzip 后 base64 塞进一个封装对象。
  //   41 KB -> 23 KB，代价是文件不再人能读（用户已确认可以接受）。
  //   为什么不复用 schema 2 加个 encoding 字段：老版本读到 schema 2 但
  //   topics 是空的，会把它当成"远端没有数据"，再整库写回时会把对端
  //   独有的记录抹掉。升 schema 能让老版本直接拒绝、绝不写出坏数据。
  const SCHEMA_VERSION = 3;
  const PLAIN_SCHEMA_VERSION = 2;
  const LEGACY_SCHEMA_VERSION = 1;
  const ENCODING = "gzip+base64";

  const POOL_NAMES = ["HOME", "INTERESTED", "READ", "DISMISSED"];

  // 不进远程文档的字段（帖子正文片段）：默认只留本机。
  const CONTENT_FIELDS = ["excerpt", "previewForRead", "previewAuthor", "previewText"];

  // 参与远程文档的字段（归属状态 + 元数据 + 本地阅读基线）。
  const STATE_FIELDS = [
    "topicId",
    // 记录最后一次修改它的设备，供同 updatedAt 时的确定性 tie-break 使用。
    "deviceId",
    "basePool",
    "inNewReply",
    "createdAt",
    "enteredPoolAt",
    "updatedAt",
    "title",
    "slug",
    "categoryId",
    "lastPosterUsername",
    "lastReadPostNumber",
    "highestPostNumber",
    "unreadPosts",
    "lastPostedAt",
    "readUpToPostNumber",
    // 用户手动接管通知的标记；跨设备同步。
    "notifyManualLevel",
    // 该标记的独立时间戳；只在通知合并里比较。
    "notifyManualAt"
  ];

  const isBlank = (value) => value === undefined || value === null || value === "";

  // 远程文档里的短键。键名在每条记录里都要重复一次，长名字的代价是
  // 记录数 × 名字长度 —— 247 条时长键名比全部数据还占地方。
  const FIELD_KEYS = {
    topicId: "i",
    deviceId: "d",
    basePool: "p",
    inNewReply: "n",
    createdAt: "ca",
    enteredPoolAt: "ea",
    updatedAt: "ua",
    title: "t",
    slug: "s",
    categoryId: "c",
    lastPosterUsername: "u",
    lastReadPostNumber: "lr",
    highestPostNumber: "hp",
    unreadPosts: "up",
    lastPostedAt: "lp",
    readUpToPostNumber: "ru",
    notifyManualLevel: "nm",
    notifyManualAt: "nma",
    excerpt: "x",
    previewForRead: "pr",
    previewAuthor: "pa",
    previewText: "pt"
  };
  const KEY_FIELDS = Object.fromEntries(
    Object.entries(FIELD_KEYS).map(([field, key]) => [key, field])
  );

  // basePool 只有四个值，写一个字母比写 "DISMISSED" 省 8 字节/条。
  const POOL_CODES = { HOME: "h", INTERESTED: "s", READ: "r", DISMISSED: "x" };
  const POOL_BY_CODE = { h: "HOME", s: "INTERESTED", r: "READ", x: "DISMISSED" };

  // 稳定序列化（键排序）：用于"两条记录是否完全一致"与 tie-break。
  function canonical(value) {
    if (value === null || typeof value !== "object") {
      return JSON.stringify(value) ?? "null";
    }
    if (Array.isArray(value)) {
      return `[${value.map(canonical).join(",")}]`;
    }
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }

  // 同 updatedAt 时的确定性判据：先比 deviceId，再比整条记录的规范化文本。
  // 两台设备看到的输入相同，因此结果相同。
  function tieBreakKey(record) {
    return `${record?.deviceId ?? ""}|${canonical(record ?? null)}`;
  }

  function timestampOf(record, field) {
    const value = Number(record?.[field]);
    return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY;
  }

  function pickNewerRecord(left, right) {
    const leftAt = timestampOf(left, "updatedAt");
    const rightAt = timestampOf(right, "updatedAt");
    if (leftAt !== rightAt) return leftAt > rightAt ? left : right;
    return tieBreakKey(left) >= tieBreakKey(right) ? left : right;
  }

  function pickNewerTombstone(left, right) {
    if (!left) return right ?? null;
    if (!right) return left;
    return timestampOf(right, "deletedAt") > timestampOf(left, "deletedAt") ? right : left;
  }

  // 通知手动接管状态：{ level, at }。
  // level=null 且 at 有值 = 用户显式点了「跟随信息池」，这个"清除"也要同步，
  // 否则另一台设备会把旧的 manual 标记又带回来。
  function manualNotifyState(record) {
    if (!record) return null;
    const hasLevel = typeof record.notifyManualLevel === "number";
    const rawAt = Number(record.notifyManualAt);
    const hasAt = Number.isFinite(rawAt) && rawAt > 0;
    if (!hasLevel && !hasAt) return null;
    // 老记录可能只有 notifyManualLevel、没有时间戳；按 0 处理，
    // 任何带真实时间戳的清除/新设置都能赢过它。
    return { level: hasLevel ? record.notifyManualLevel : null, at: hasAt ? rawAt : 0 };
  }

  function pickManualNotifyState(left, right) {
    if (!left) return right ?? null;
    if (!right) return left;
    if (left.at !== right.at) return left.at > right.at ? left : right;
    // 同毫秒冲突：先偏向仍然"手动接管"的那一边，再用规范化文本保证
    // A/B 两台设备各自计算也会收敛到同一个结果。
    if (left.level !== null && right.level === null) return left;
    if (left.level === null && right.level !== null) return right;
    return canonical(left) >= canonical(right) ? left : right;
  }

  function withNotifyManual(winner, loser) {
    const picked = pickManualNotifyState(manualNotifyState(winner), manualNotifyState(loser));
    if (!picked) return winner;
    return {
      ...winner,
      notifyManualLevel: picked.level,
      notifyManualAt: picked.at > 0 ? picked.at : null
    };
  }

  // 胜者决定归属、时间、标题等；败者只补它独有的预览与阅读基线。
  //
  // 预览三件套（previewForRead / previewAuthor / previewText）是一个整体：
  // previewForRead 记录"这段预览来自哪一楼"，按字段逐个补会拼出
  // "A 的正文 + B 的楼层号"这种张冠李戴的组合。
  function withCarriedFields(winner, loser) {
    const merged = withNotifyManual({ ...winner }, loser);
    if (!loser) return merged;

    // 只有"胜者没有正文、败者有正文"时才整组搬过来；
    // 两边都没有就什么都不加，避免凭空补出 previewForRead: null 这种字段。
    if (isBlank(merged.previewText) && !isBlank(loser.previewText)) {
      merged.previewForRead = loser.previewForRead ?? null;
      merged.previewAuthor = loser.previewAuthor ?? "";
      merged.previewText = loser.previewText;
    }

    if (isBlank(merged.readUpToPostNumber) && !isBlank(loser.readUpToPostNumber)) {
      merged.readUpToPostNumber = loser.readUpToPostNumber;
    }

    return merged;
  }

  function indexById(items) {
    const map = new Map();
    for (const item of items ?? []) {
      const key = String(item?.topicId ?? "");
      if (/^\d+$/.test(key)) map.set(key, item);
    }
    return map;
  }

  // localState / remoteState 形如 { topics: [...], tombstones: [...] }
  // 返回 { topics, tombstones, stats }，stats 相对"本地"统计，供 UI 展示。
  function mergeTopics(localState = {}, remoteState = {}) {
    const localTopics = indexById(localState.topics);
    const remoteTopics = indexById(remoteState.topics);
    const localTombs = indexById(localState.tombstones);
    const remoteTombs = indexById(remoteState.tombstones);

    const ids = new Set([
      ...localTopics.keys(),
      ...remoteTopics.keys(),
      ...localTombs.keys(),
      ...remoteTombs.keys()
    ]);

    const topics = new Map();
    const tombstones = [];

    for (const id of ids) {
      const local = localTopics.get(id) ?? null;
      const remote = remoteTopics.get(id) ?? null;
      const tombstone = pickNewerTombstone(localTombs.get(id), remoteTombs.get(id));

      const winner = local && remote ? pickNewerRecord(local, remote) : local ?? remote;
      const loser = winner === local ? remote : local;

      if (!winner) {
        if (tombstone) tombstones.push({ topicId: id, deletedAt: tombstone.deletedAt });
        continue;
      }

      // 墓碑更晚 → 这条被删了；反之说明删除之后又被重新标记过，记录胜出。
      if (tombstone && timestampOf(tombstone, "deletedAt") > timestampOf(winner, "updatedAt")) {
        tombstones.push({ topicId: id, deletedAt: tombstone.deletedAt });
        continue;
      }

      topics.set(id, withCarriedFields(winner, loser));
    }

    const stats = { added: 0, updated: 0, removed: 0, unchanged: 0 };
    for (const [id, record] of topics) {
      const before = localTopics.get(id);
      if (!before) stats.added += 1;
      else if (canonical(before) === canonical(record)) stats.unchanged += 1;
      else stats.updated += 1;
    }
    for (const id of localTopics.keys()) {
      if (!topics.has(id)) stats.removed += 1;
    }

    return { topics: [...topics.values()], tombstones, stats };
  }

  function pickFields(record, includeContent) {
    const output = {};
    for (const field of STATE_FIELDS) {
      if (record?.[field] !== undefined) output[field] = record[field];
    }
    if (includeContent) {
      for (const field of CONTENT_FIELDS) {
        if (record?.[field] !== undefined) output[field] = record[field];
      }
    }
    return output;
  }

  // deviceId 每条都写一份 UUID 是纯浪费：它通常全场只有一个值。
  // 文档顶层放一个字典，记录里只存下标（0 最常见，直接省掉）。
  function deviceIndexOf(devices, value) {
    const text = String(value ?? "");
    let index = devices.indexOf(text);
    if (index === -1) {
      devices.push(text);
      index = devices.length - 1;
    }
    return index;
  }

  function encodeRow(row, devices) {
    const output = {};
    for (const field of Object.keys(FIELD_KEYS)) {
      const value = row[field];
      // 空值一律不写。真实数据里绝大多数记录都是 c/u/lr/hp/lp/ru = null/""，
      // 全写出来一条多 50 多字节，而读回来是同一个"空"。
      if (value === undefined || value === null || value === "") continue;
      // 省略"读出来一定是这个值"的默认项，解码时原样补回。
      if (field === "inNewReply" && value === false) continue;
      if (field === "unreadPosts" && value === 0) continue;
      if (field === "enteredPoolAt" && value === row.updatedAt) continue;
      // createdAt 与 updatedAt 相同很常见（标记后没再动过），解码时回退到 updatedAt。
      if (field === "createdAt" && value === row.updatedAt) continue;
      // slug 在真实数据里 279/279 都是占位 "topic"，/t/topic/<id> 会被站点重定向，
      // 只有真的拿到了有意义的 slug 才值得写。
      if (field === "slug" && value === "topic") continue;
      if (field === "basePool") {
        output.p = POOL_CODES[value] ?? value;
        continue;
      }
      if (field === "deviceId") {
        const index = deviceIndexOf(devices, value);
        if (index === 0) continue;
        output.d = index;
        continue;
      }
      output[FIELD_KEYS[field]] = value;
    }
    return output;
  }

  function decodeRow(row, devices) {
    const output = {};
    for (const [key, value] of Object.entries(row ?? {})) {
      if (key === "d") continue;
      const field = KEY_FIELDS[key];
      if (!field) continue; // 未知键（将来加的字段）直接忽略，不让它污染记录
      output[field] = field === "basePool" ? (POOL_BY_CODE[value] ?? value) : value;
    }
    output.topicId = String(row?.i ?? "");
    output.deviceId =
      row?.d === undefined ? String(devices[0] ?? "") : String(devices[Number(row.d)] ?? "");
    if (output.inNewReply === undefined) output.inNewReply = false;
    if (output.unreadPosts === undefined) output.unreadPosts = 0;
    if (output.enteredPoolAt === undefined) output.enteredPoolAt = output.updatedAt;
    if (output.createdAt === undefined) output.createdAt = output.updatedAt;
    return output;
  }

  // 一个 namespace 一个远程文档。
  // includePreviews 默认 false：预览/摘要是帖子正文片段，默认不出本机。
  function toRemoteDoc({ namespace, deviceId, topics, tombstones, includePreviews = false }) {
    const devices = [];
    const rows = (topics ?? []).map((record) => pickFields(record, includePreviews));
    const encoded = rows.map((row) => encodeRow(row, devices));
    return {
      // 语义文档本身仍是 schema 2；只有 encodeRemoteDoc 才会包成 schema 3。
      schema: PLAIN_SCHEMA_VERSION,
      namespace: String(namespace ?? ""),
      deviceId: String(deviceId ?? ""),
      generatedAt: new Date().toISOString(),
      devices,
      topics: encoded,
      // 墓碑也压成 [topicId, deletedAt]：正常回收后数量很少，但攒起来同样占地方。
      tombstones: (tombstones ?? []).map((item) => [String(item.topicId), item.deletedAt])
    };
  }

  // 读取"已解封装"的远程文档：格式不对就整体拒绝，绝不让坏数据进合并。
  // schema 3 的封装必须先过 decodeRemoteDoc。
  function fromRemoteDoc(doc, expectedNamespace) {
    if (!doc || typeof doc !== "object") throw new Error("远程数据不是对象");
    const schema = Number(doc.schema);
    if (schema === SCHEMA_VERSION) {
      throw new Error("远程数据是压缩封装，需要先调用 decodeRemoteDoc 解封装");
    }
    if (schema !== PLAIN_SCHEMA_VERSION && schema !== LEGACY_SCHEMA_VERSION) {
      throw new Error(
        `远程数据 schema 不兼容：${doc.schema}（本机支持 ${LEGACY_SCHEMA_VERSION} / ${PLAIN_SCHEMA_VERSION}，封装版为 ${SCHEMA_VERSION}，紧凑文件为 ${COMPACT_SCHEMA_VERSIONS.join(" / ")}）`
      );
    }

    const namespace = String(doc.namespace ?? "");
    if (expectedNamespace && namespace !== String(expectedNamespace)) {
      throw new Error(`远程数据属于另一个账号：${namespace}`);
    }

    const devices = schema === PLAIN_SCHEMA_VERSION && Array.isArray(doc.devices)
      ? doc.devices.map((item) => String(item ?? ""))
      : [];

    const decodeItem = schema === PLAIN_SCHEMA_VERSION
      ? (item) => decodeRow(item, devices)
      : (item) => ({ ...item, topicId: String(item?.topicId ?? "") });

    const topics = (Array.isArray(doc.topics) ? doc.topics : [])
      .map(decodeItem)
      .filter((item) => /^\d+$/.test(String(item?.topicId ?? "")) && POOL_NAMES.includes(item.basePool));

    const tombstoneList = (Array.isArray(doc.tombstones) ? doc.tombstones : [])
      .map((item) =>
        Array.isArray(item)
          ? { topicId: String(item[0] ?? ""), deletedAt: Number(item[1]) }
          : { topicId: String(item?.topicId ?? ""), deletedAt: Number(item?.deletedAt) }
      )
      .filter((item) => /^\d+$/.test(item.topicId) && Number.isFinite(item.deletedAt));

    return { topics, tombstones: tombstoneList };
  }

  // ---- 压缩封装（schema 3）----
  // 只影响"写到远端之前 / 从远端读回之后"，合并语义完全不变。
  const canCompress =
    typeof CompressionStream === "function" &&
    typeof DecompressionStream === "function" &&
    typeof Blob === "function" &&
    typeof Response === "function" &&
    typeof btoa === "function" &&
    typeof atob === "function";

  function bytesToBase64(bytes) {
    let binary = "";
    // 分块拼接：几十 KB 一次性 fromCharCode 在部分引擎上会爆栈。
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  async function runStream(bytes, transform) {
    const stream = new Blob([bytes]).stream().pipeThrough(transform);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // 写远端前把 schema 2 文档包成 schema 3。
  // 运行时没有 CompressionStream 时原样输出（写 schema 2），
  // 宁可文件大一点，也不能把同步功能弄挂。
  async function encodeRemoteDoc(doc) {
    if (!doc || typeof doc !== "object") throw new Error("待编码的远程文档不是对象");
    if (!canCompress) return doc;

    const text = JSON.stringify(doc);
    const gzipped = await runStream(new TextEncoder().encode(text), new CompressionStream("gzip"));
    return {
      schema: SCHEMA_VERSION,
      encoding: ENCODING,
      namespace: String(doc.namespace ?? ""),
      deviceId: String(doc.deviceId ?? ""),
      generatedAt: doc.generatedAt ?? new Date().toISOString(),
      payload: bytesToBase64(gzipped)
    };
  }

  // 读远端后解封装；schema 1 / 2 原样返回，不用手动迁移老文件。
  async function decodeRemoteDoc(doc) {
    if (!doc || typeof doc !== "object") throw new Error("远程数据不是对象");
    if (Number(doc.schema) !== SCHEMA_VERSION) return doc;

    if (!canCompress) throw new Error("当前浏览器不支持解压远程同步文件（缺少 CompressionStream）");
    if (doc.encoding !== ENCODING) {
      throw new Error(`远程数据编码不支持：${doc.encoding ?? "(缺失)"}（本机支持 ${ENCODING}）`);
    }
    if (typeof doc.payload !== "string" || !doc.payload) throw new Error("远程数据缺少 payload");

    const bytes = await runStream(base64ToBytes(doc.payload), new DecompressionStream("gzip"));
    let inner;
    try {
      inner = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Error("远程数据解压后不是合法 JSON");
    }
    if (doc.namespace && inner?.namespace && doc.namespace !== inner.namespace) {
      throw new Error("远程封装与内容 namespace 不一致");
    }
    return inner;
  }

  // ---- 文件级编解码（schema 4）----
  // 文件本体直接是 gzip 字节，不再套 base64（base64 本身要多占 33%）。
  // 压缩前先把记录压成"数组行 + base36 时间戳"，让 gzip 要处理的内容更小。
  // 读端靠 gzip 魔数（1f 8b）区分二进制文件与历史 JSON 文件。
  // schema 5 = schema 4 + 通知手动接管标记（nm / nma）。
  // 升版本而不是原地加列：旧版读到 schema 5 会明确拒绝，避免它把
  // 不认识的 nm/nma 在下次写回时抹掉。
  const FILE_SCHEMA_VERSION = 5;
  const COMPACT_SCHEMA_VERSIONS = [4, 5];
  // 注意必须包含 "d"（deviceId 下标）：漏掉它会让所有记录的 deviceId
  // 退回 devices[0]，同 updatedAt 的 tie-break 和归属都会算错。
  const ROW_COLUMNS = [
    "i",
    "d",
    "p",
    "n",
    "ca",
    "ea",
    "ua",
    "t",
    "s",
    "c",
    "u",
    "lr",
    "hp",
    "up",
    "lp",
    "ru",
    "nm",
    "nma"
  ];
  const BASE36_COLUMNS = new Set(["ca", "ea", "ua", "lp", "nma"]);

  function isGzipBytes(bytes) {
    return Boolean(bytes) && bytes.length > 1 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  }

  function parseJsonText(text) {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("远端文件不是合法 JSON");
    }
  }

  // 数字型字段写 base36 能省几个字节，但真实数据里 `lastPostedAt` 有时是
  // ISO 字符串、有时是毫秒数（同一个文件里混着），不加标记就会出现
  // "2026-10-31T..." 被 parseInt(x, 36) 解析成 30191 这种静默篡改。
  // 所以只有确认是有限数字才编码，并且加 "~" 前缀与普通字符串区分。
  function encodeCompactValue(key, value) {
    if (value === undefined || value === null || value === "") return null;
    if (key === "i") {
      const numeric = Number(value);
      // 超出安全整数的 ID 宁可保留字符串，也不要静默丢精度。
      return Number.isSafeInteger(numeric) ? numeric : String(value);
    }
    if (BASE36_COLUMNS.has(key) && typeof value === "number" && Number.isFinite(value)) {
      return `~${value.toString(36)}`;
    }
    return value;
  }

  function decodeCompactValue(key, value) {
    if (value === undefined || value === null || value === "") return undefined;
    if (key === "i") return String(value);
    if (typeof value === "string" && value.startsWith("~")) {
      const parsed = parseInt(value.slice(1), 36);
      return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
  }

  // schema 2 语义文档 → schema 4/5 紧凑文档（行变数组、数字时间戳变 base36）。
  function toCompactDoc(doc) {
    const topics = (doc?.topics ?? []).map((row) =>
      ROW_COLUMNS.map((key) => encodeCompactValue(key, row?.[key]))
    );
    return {
      schema: FILE_SCHEMA_VERSION,
      namespace: String(doc?.namespace ?? ""),
      deviceId: String(doc?.deviceId ?? ""),
      generatedAt: doc?.generatedAt ?? new Date().toISOString(),
      devices: Array.isArray(doc?.devices) ? doc.devices : [],
      // 列序写进文件：将来加字段时老读者不会把位置搞错。
      cols: ROW_COLUMNS,
      topics,
      tombstones: (doc?.tombstones ?? []).map((item) => [
        String(item?.[0] ?? item?.topicId ?? ""),
        Number(item?.[1] ?? item?.deletedAt)
      ])
    };
  }

  // schema 4/5 紧凑文档 → schema 2 语义文档，交给 fromRemoteDoc 统一处理。
  function fromCompactDoc(doc) {
    const cols = Array.isArray(doc?.cols) && doc.cols.length ? doc.cols.map(String) : ROW_COLUMNS;
    const topics = (Array.isArray(doc?.topics) ? doc.topics : []).map((cells) => {
      const row = {};
      cols.forEach((key, index) => {
        const value = decodeCompactValue(key, Array.isArray(cells) ? cells[index] : undefined);
        if (value !== undefined) row[key] = value;
      });
      return row;
    });
    return {
      schema: PLAIN_SCHEMA_VERSION,
      namespace: String(doc?.namespace ?? ""),
      deviceId: String(doc?.deviceId ?? ""),
      generatedAt: doc?.generatedAt ?? "",
      devices: Array.isArray(doc?.devices) ? doc.devices : [],
      topics,
      tombstones: Array.isArray(doc?.tombstones) ? doc.tombstones : []
    };
  }

  // 语义文档 → 远端文件字节。没有 CompressionStream 时退回明文 JSON（schema 4 文本）。
  async function serializeRemoteFile(doc) {
    const text = JSON.stringify(toCompactDoc(doc));
    const bytes = new TextEncoder().encode(text);
    if (!canCompress) return bytes;
    return runStream(bytes, new CompressionStream("gzip"));
  }

  // 远端文件字节 → schema 1 / 2 语义文档。同时兼容历史格式：
  //   裸 JSON（schema 1 / 2）、JSON 信封（schema 3）、gzip 二进制（schema 4）。
  async function parseRemoteFile(input) {
    const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
    if (!bytes || !bytes.length) throw new Error("远端文件是空的");

    let doc;
    if (isGzipBytes(bytes)) {
      if (!canCompress) throw new Error("当前浏览器不支持解压远程同步文件（缺少 DecompressionStream）");
      const plain = await runStream(bytes, new DecompressionStream("gzip"));
      doc = parseJsonText(new TextDecoder().decode(plain));
    } else {
      doc = parseJsonText(new TextDecoder().decode(bytes));
    }

    // schema 3：JSON 信封里再套 base64(gzip)。
    if (Number(doc?.schema) === SCHEMA_VERSION) {
      const inner = await decodeRemoteDoc(doc);
      return COMPACT_SCHEMA_VERSIONS.includes(Number(inner?.schema))
        ? fromCompactDoc(inner)
        : inner;
    }
    if (COMPACT_SCHEMA_VERSIONS.includes(Number(doc?.schema))) return fromCompactDoc(doc);
    return doc;
  }

  window.LDFCSyncModel = {
    ENCODING,
    FILE_SCHEMA_VERSION,
    PLAIN_SCHEMA_VERSION,
    SCHEMA_VERSION,
    canonical,
    decodeRemoteDoc,
    encodeRemoteDoc,
    fromCompactDoc,
    fromRemoteDoc,
    mergeTopics,
    parseRemoteFile,
    serializeRemoteFile,
    tieBreakKey,
    toCompactDoc,
    toRemoteDoc
  };
})();
