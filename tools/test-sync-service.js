"use strict";

// 同步编排层（syncService）的单测：纯 Node，不碰浏览器 / 网络 / IndexedDB。
//
// 覆盖：
//   1. deviceId 生成、持久化、回调
//   2. 自动同步开关（默认开、持久化、关闭后不排推送）
//   3. pull：空远端、合并、namespace / schema 不符时整体拒绝
//   4. push：首次创建、写入冲突后的重读重合并、deviceId 随记录上传
//   5. 墓碑：90 天回收、远端墓碑删除本地记录
//   6. debounce：连续标记只排一次，10s 后推送
//   7. 打开站点只拉一次
//   8. 没有 transport 时是空操作，不抛错
//
// 用法：node tools/test-sync-service.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const EXT = path.join(ROOT, "linuxdo-personal-feed-manager");

// 注入宿主 API，让 schema 3 的压缩路径在单测里真正被执行（否则静默降级）。
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

for (const file of [
  path.join(EXT, "storage", "syncModel.js"),
  path.join(EXT, "storage", "syncService.js")
]) {
  vm.runInContext(fs.readFileSync(file, "utf8"), sandbox, { filename: file });
}

const model = sandbox.window.LDFCSyncModel;
const createSyncService = sandbox.window.LDFCSyncService.createSyncService;

const results = [];
const check = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

const clone = (value) => (value === null || value === undefined ? value : JSON.parse(JSON.stringify(value)));

const record = (topicId, overrides = {}) => ({
  topicId: String(topicId),
  basePool: "INTERESTED",
  inNewReply: false,
  createdAt: 1_000,
  enteredPoolAt: 1_000,
  updatedAt: 5_000,
  title: `Topic ${topicId}`,
  slug: `slug-${topicId}`,
  ...overrides
});

function createStorage(seed = {}) {
  const topics = new Map((seed.topics ?? []).map((item) => [String(item.topicId), clone(item)]));
  const tombstones = new Map((seed.tombstones ?? []).map((item) => [String(item.topicId), clone(item)]));
  const meta = new Map(Object.entries(seed.meta ?? {}));
  const writes = { putTopic: 0, deleteTopic: 0, putTombstone: 0, deleteTombstone: 0 };

  return {
    writes,
    topics,
    tombstones,
    meta,
    async getAllTopics() {
      return clone([...topics.values()]);
    },
    async getTombstones() {
      return clone([...tombstones.values()]);
    },
    async putTopic(item) {
      writes.putTopic += 1;
      topics.set(String(item.topicId), clone(item));
    },
    async deleteTopic(topicId) {
      writes.deleteTopic += 1;
      topics.delete(String(topicId));
    },
    async putTombstone(item) {
      writes.putTombstone += 1;
      tombstones.set(String(item.topicId), clone(item));
    },
    async deleteTombstone(topicId) {
      writes.deleteTombstone += 1;
      tombstones.delete(String(topicId));
    },
    async getMeta(key) {
      return clone(meta.get(key));
    },
    async putMeta(key, value) {
      meta.set(key, clone(value));
    }
  };
}

// 假传输层收发的是**文件字节**（与真实 WebDAV 传输层一致）：
// 内部仍按 schema 2 语义文档保存，读写时用 model 做序列化/归一化。
function createTransport(initialDoc = null) {
  let current = initialDoc ? clone(initialDoc) : null;
  let version = initialDoc ? 1 : 0;
  const transport = {
    writes: [],
    reads: 0,
    beforeWrite: null,
    async read() {
      transport.reads += 1;
      // 读端用明文 JSON 字节就够了：既能覆盖 schema 1/2/3，也能原样送进
      // 故意构造的非法文档（schema 99）来验证整体拒绝。
      return current
        ? { bytes: new TextEncoder().encode(JSON.stringify(clone(current))), etag: `v${version}` }
        : { bytes: null, etag: null };
    },
    async write(bytes, expectedEtag) {
      transport.writes.push({ expected: expectedEtag ?? null, bytes });

      // 模拟"另一台设备在我们读完之后写了一次"。
      if (transport.beforeWrite) {
        const hook = transport.beforeWrite;
        transport.beforeWrite = null;
        hook();
      }

      const currentEtag = current ? `v${version}` : null;
      if ((expectedEtag ?? null) !== currentEtag) {
        const error = new Error("etag mismatch");
        error.status = 412;
        throw error;
      }

      current = await model.parseRemoteFile(bytes);
      version += 1;
      return { etag: `v${version}` };
    },
    inject(doc) {
      current = clone(doc);
      version += 1;
    },
    doc() {
      return clone(current);
    }
  };

  return transport;
}

function createClock(start = 10_000_000) {
  let time = start;
  let sequence = 0;
  const timers = new Map();

  return {
    now: () => time,
    setTimeout(callback, ms) {
      sequence += 1;
      timers.set(sequence, { callback, at: time + ms });
      return sequence;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pending: () => timers.size
  };
}

const flush = async () => {
  // 推送到远端现在多了一层 gzip（Web Streams），需要多轮宏任务才能真正落地，
  // 只让一轮 microtask + 一次 setImmediate 会让断言跑在写入之前。
  for (let round = 0; round < 10; round += 1) {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
};

const buildService = (storage, transport, overrides = {}) => {
  const clock = overrides.clock ?? createClock();
  return createSyncService({
    storage,
    model,
    transport,
    getNamespace: overrides.getNamespace ?? (async () => "user-1"),
    now: clock.now,
    setTimeout: clock.setTimeout.bind(clock),
    clearTimeout: clock.clearTimeout.bind(clock),
    randomId: overrides.randomId ?? (() => "device-a"),
    reload: overrides.reload ?? (async () => {}),
    onDeviceId: overrides.onDeviceId,
    pushDebounceMs: overrides.pushDebounceMs ?? 10_000,
    tombstoneTtlMs: overrides.tombstoneTtlMs ?? 90 * 24 * 60 * 60 * 1000,
    autoSync: overrides.autoSync
  });
};

// Node 会把含顶层 await 的文件当 ESM 解析，所以所有用例包在 async main 里。
async function main() {
// ---- 1. deviceId ----
{
  const storage = createStorage();
  let seen = null;
  const service = buildService(storage, null, { onDeviceId: (id) => (seen = id) });

  const id = await service.getDeviceId();
  check(id === "device-a" && storage.meta.get("ldfc.deviceId") === "device-a", "deviceId 首次生成并持久化");
  check(seen === "device-a", "deviceId 生成后回调给调用方（用于写入 topicState）");

  const second = buildService(storage, null, { randomId: () => "device-should-not-be-used" });
  check((await second.getDeviceId()) === "device-a", "再次初始化沿用已保存的 deviceId");
}

{
  const storage = createStorage();
  let calls = 0;
  const service = buildService(storage, null, {
    randomId: () => {
      calls += 1;
      return "device-concurrent";
    }
  });

  const [first, second] = await Promise.all([service.getDeviceId(), service.getDeviceId()]);
  check(
    first === "device-concurrent" && second === first && calls === 1,
    `并发初始化只生成一次 deviceId（生成次数=${calls}）`
  );
}

// ---- 2. 自动同步开关 ----
{
  const storage = createStorage();
  const service = buildService(storage, createTransport());

  check(service.getConfig().autoSync === true, "自动同步默认开启");

  await service.setAutoSync(false);
  check(storage.meta.get("ldfc.syncConfig")?.autoSync === false, "关闭自动同步会持久化");

  const reopened = buildService(storage, createTransport());
  await reopened.init();
  check(reopened.getConfig().autoSync === false, "重新初始化读取到关闭状态");
  check(reopened.schedulePush() === false, "关闭自动同步后不再排推送");
}

// ---- 3. pull ----
{
  const storage = createStorage();
  const transport = createTransport(null);
  const service = buildService(storage, transport);

  const result = await service.pull();
  check(result.ok && result.empty === true && result.changed === false, "远端为空：pull 成功且不产生变化");
  check(storage.writes.putTopic === 0 && storage.writes.putTombstone === 0, "远端为空：不写本地");
  check(service.getStatus().lastError === null, "远端为空：状态无错误");
}

{
  const localRecord = record("1", { updatedAt: 1_000, deviceId: "device-a" });
  const storage = createStorage({ topics: [localRecord] });
  const remoteDoc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "device-b",
    topics: [
      record("1", { basePool: "READ", updatedAt: 2_000, deviceId: "device-b" }),
      record("2", { updatedAt: 2_000, deviceId: "device-b" })
    ],
    tombstones: []
  });
  const transport = createTransport(remoteDoc);
  let reloads = 0;
  const service = buildService(storage, transport, { reload: async () => (reloads += 1) });

  const result = await service.pull();
  check(result.ok && result.changed === true, "远端有更新：pull 报告发生变化");
  check(storage.topics.get("1").basePool === "READ", "远端更新：本地记录被远端覆盖");
  check(storage.topics.has("2"), "远端新增：本地补上记录");
  check(storage.topics.get("2").deviceId === "device-b", "记录携带的 deviceId 随文档一起同步");
  check(reloads === 1, "合并落库后重载内存状态一次");
  check(
    result.stats.added === 1 && result.stats.updated === 1,
    `合并统计正确（${JSON.stringify(result.stats)}）`
  );
}

{
  const storage = createStorage({ topics: [record("1", { updatedAt: 1_000 })] });
  const transport = createTransport({
    schema: 1,
    namespace: "user-2",
    topics: [record("1", { basePool: "DISMISSED", updatedAt: 9_000 })],
    tombstones: []
  });
  const service = buildService(storage, transport);

  const result = await service.pull();
  check(result.ok === false && result.reason === "error", "namespace 不符：pull 失败");
  check(storage.topics.get("1").basePool === "INTERESTED", "namespace 不符：本地数据完全没被改");
  check(service.getStatus().state === "error", "失败后状态标记为 error");
}

{
  const storage = createStorage({ topics: [record("1")] });
  const transport = createTransport({ schema: 99, namespace: "user-1", topics: [] });
  const service = buildService(storage, transport);

  const result = await service.pull();
  check(result.ok === false, "schema 不兼容：pull 失败");
  check(storage.writes.putTopic === 0, "schema 不兼容：不写入任何记录");
}

// ---- 4. push ----
{
  const storage = createStorage({
    topics: [record("1", { deviceId: "device-a" })],
    tombstones: [{ topicId: "9", deletedAt: 9_000_000 }]
  });
  const transport = createTransport(null);
  const service = buildService(storage, transport);

  const result = await service.push();
  const doc = transport.doc();
  check(result.ok && result.pushed === true, "远端为空：push 成功");
  // 推送出去的是裸 gzip 字节（schema 4）；这里按"解码后"的语义断言，
  // 不去锁死具体的短键名，避免以后换编码方式又得改一遍。
  const pushedBytes = transport.writes[0]?.bytes;
  check(
    pushedBytes?.[0] === 0x1f && pushedBytes?.[1] === 0x8b && doc?.namespace === "user-1",
    `push 出去的是 gzip 字节并带 namespace（magic=${pushedBytes?.[0]?.toString(16)}，namespace=${doc?.namespace}）`
  );
  const pushed = model.fromRemoteDoc(await model.decodeRemoteDoc(doc));
  check(
    pushed.topics.length === 1 && pushed.topics[0].deviceId === "device-a",
    "push 文档里的记录带 deviceId"
  );
  check(pushed.tombstones.length === 1 && pushed.tombstones[0].topicId === "9", "push 文档带墓碑");
  check(service.getStatus().lastPushAt !== null, "push 后记录 lastPushAt");
}

{
  const storage = createStorage({ topics: [record("1", { updatedAt: 1_000 })] });
  const transport = createTransport(
    model.toRemoteDoc({
      namespace: "user-1",
      deviceId: "device-b",
      topics: [record("2", { updatedAt: 1_000 })],
      tombstones: []
    })
  );

  // 第一次写入前，另一台设备又塞进来一条 topic 3。
  transport.beforeWrite = () => {
    transport.inject(
      model.toRemoteDoc({
        namespace: "user-1",
        deviceId: "device-c",
        topics: [record("2", { updatedAt: 1_000 }), record("3", { updatedAt: 3_000 })],
        tombstones: []
      })
    );
  };

  const service = buildService(storage, transport);
  const result = await service.push();
  const doc = transport.doc();

  check(result.ok && result.pushed === true, "写入冲突：重试后 push 成功");
  check(transport.writes.length === 2, `写入冲突：恰好重试一次（write 次数=${transport.writes.length}）`);
  check(
    model.fromRemoteDoc(await model.decodeRemoteDoc(doc)).topics.some((item) => item.topicId === "3"),
    "写入冲突：重读后把别人的新记录合并进来"
  );
  check(storage.topics.has("3"), "写入冲突：重读合并的结果也落回本地");
}

// ---- 5. 墓碑 ----
{
  const now = 10_000_000;
  const old = now - 100 * 24 * 60 * 60 * 1000;
  const recent = now - 10 * 24 * 60 * 60 * 1000;
  const storage = createStorage({
    topics: [record("1", { updatedAt: 1_000 })],
    tombstones: [
      { topicId: "8", deletedAt: old },
      { topicId: "9", deletedAt: recent }
    ]
  });
  const transport = createTransport(null);
  const clock = createClock(now);
  const service = buildService(storage, transport, { clock });

  const result = await service.push();
  const doc = transport.doc();
  check(result.ok, "墓碑回收：push 正常完成");
  const pushedTombs = model.fromRemoteDoc(await model.decodeRemoteDoc(doc)).tombstones;
  check(!pushedTombs.some((item) => item.topicId === "8"), "超过 90 天的墓碑不再上传");
  check(pushedTombs.some((item) => item.topicId === "9"), "90 天内的墓碑继续上传");
  check(!storage.tombstones.has("8"), "超过 90 天的本地墓碑被清掉");
  check(storage.topics.has("1"), "墓碑回收不影响正常记录");
}

{
  const storage = createStorage({ topics: [record("7", { updatedAt: 1_000 })] });
  const transport = createTransport({
    schema: 1,
    namespace: "user-1",
    topics: [],
    tombstones: [{ topicId: "7", deletedAt: 2_000 }]
  });
  const service = buildService(storage, transport);

  const result = await service.pull();
  check(result.ok && result.changed === true, "远端墓碑更新：pull 删除本地记录");
  check(!storage.topics.has("7"), "远端墓碑更新：本地记录被删除");
  check(storage.writes.deleteTopic === 1, "同步删除不额外写墓碑（走 deleteTopic）");
  check(storage.tombstones.get("7")?.deletedAt === 2_000, "远端墓碑落回本地");
}

// ---- 6. debounce ----
{
  const storage = createStorage({ topics: [record("1")] });
  const transport = createTransport(null);
  const clock = createClock();
  const service = buildService(storage, transport, { clock });
  await service.init();

  service.schedulePush();
  service.schedulePush();
  service.schedulePush();
  check(clock.pending() === 1, "连续三次标记只保留一个待执行推送");

  clock.advance(9_999);
  check(clock.pending() === 1 && transport.writes.length === 0, "不到 10 秒不推送");

  clock.advance(1);
  await flush();
  check(transport.writes.length === 1, "10 秒后推送一次");
}

// ---- 7. pullOnce ----
{
  const storage = createStorage();
  const transport = createTransport(null);
  const service = buildService(storage, transport);

  const first = await service.pullOnce();
  const second = await service.pullOnce();
  check(first.ok === true, "打开站点：第一次 pullOnce 执行");
  check(second.ok === false && second.reason === "already-pulled", "同一会话只拉一次");
}

{
  const storage = createStorage({ meta: { "ldfc.syncConfig": { autoSync: false } } });
  const transport = createTransport(null);
  const service = buildService(storage, transport);

  const result = await service.pullOnce();
  check(result.ok === false && result.reason === "auto-sync-off", "关闭自动同步后打开站点不拉取");
  check(transport.reads === 0, "关闭自动同步后不产生读取请求");
}

// ---- 8. 没有 transport ----
{
  const storage = createStorage({ topics: [record("1")] });
  const service = buildService(storage, null);

  const pulled = await service.pull();
  const pushed = await service.push();
  const scheduled = service.schedulePush();

  check(pulled.ok === false && pulled.reason === "no-transport", "未配置远端：pull 是安全的空操作");
  check(pushed.ok === false && pushed.reason === "no-transport", "未配置远端：push 是安全的空操作");
  check(scheduled === false, "未配置远端：不排推送");
}

// ---- 9. syncNow ----
{
  const storage = createStorage({ topics: [record("1")] });
  const transport = createTransport(null);
  const service = buildService(storage, transport);

  const result = await service.syncNow();
  check(result.ok === true && result.pull.ok === true && result.push.ok === true, "syncNow = pull + push");
  check((await model.decodeRemoteDoc(transport.doc()))?.topics?.length === 1, "syncNow 之后远端有本地数据");
  check(result.stats?.added === 0, "syncNow 统计：本地已有数据推上去不算新增");
}

// ---- 10. syncNow 的统计不能被 push 那份恒为 0 的结果盖掉 ----
{
  // 复现手机端现象：远端有 2 条、本地空。pull 把 2 条拉进来（added=2），
  // push 紧接着在已合并的状态上跑，它自己的 stats 是 0。UI 只看 push 就会显示 0。
  const remoteDoc = model.toRemoteDoc({
    namespace: "user-1",
    deviceId: "device-b",
    topics: [
      record("1", { updatedAt: 2_000, deviceId: "device-b" }),
      record("2", { updatedAt: 2_000, deviceId: "device-b" })
    ],
    tombstones: []
  });
  const storage = createStorage();
  const transport = createTransport(remoteDoc);
  const service = buildService(storage, transport);

  const result = await service.syncNow();
  check(result.ok === true, "syncNow 统计：远端 2 条 / 本地空，同步成功");
  check(result.push?.stats?.added === 0, "syncNow 统计：push 自己的新增确实是 0");
  check(result.stats?.added === 2, "syncNow 统计：对外给的是 pull 的新增数 2");
  check(service.getStatus().stats?.added === 2, "syncNow 统计：状态栏回填合计值");
}
}

main()
  .then(() => {
    console.log("===== 同步编排层单测 =====");
    for (const line of results) console.log(line);
    const failed = results.filter((line) => line.startsWith("FAIL")).length;
    console.log(`\n汇总：${results.length - failed} 项通过，${failed} 项失败`);
    process.exit(failed === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error("测试脚本异常：", error);
    process.exit(1);
  });
