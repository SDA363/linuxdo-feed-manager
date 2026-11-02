(() => {
  // 同步编排层：只负责"什么时候同步、按什么顺序合并、同步状态如何"，
  // 完全不关心远端是 WebDAV 还是 Google Drive。
  //
  // transport 契约（由组 4 / 组 6 实现），收发的是文件字节：
  //   read()                → Promise<{ bytes, etag } | null>   // 不存在时 bytes/etag 可空
  //   write(bytes, etag)    → Promise<{ etag }>
  //   write 冲突时抛出的错误需带 conflict = true（或 status 409 / 412）。
  //
  // 分工：
  //   组 2 的 syncModel 决定"两条记录谁赢"；
  //   这里只决定"拿本地与远端各读一次 → 合并 → 落库 → 写回"。
  const DEVICE_ID_KEY = "ldfc.deviceId";
  const SYNC_CONFIG_KEY = "ldfc.syncConfig";

  // 用户标记后延迟推送：连续操作只发一次请求。
  const PUSH_DEBOUNCE_MS = 10 * 1000;

  // 墓碑保留 90 天。超过这个时间，删除视为"所有设备都已看到"。
  const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;

  // 写入冲突时最多重新合并重试几次。
  const MAX_WRITE_RETRIES = 2;

  function emptyState() {
    return { topics: [], tombstones: [] };
  }

  function emptyStats() {
    return { added: 0, updated: 0, removed: 0, unchanged: 0 };
  }

  function statsChanged(stats) {
    return Boolean(stats && (stats.added || stats.updated || stats.removed));
  }

  function isConflict(error) {
    return Boolean(error && (error.conflict === true || error.status === 409 || error.status === 412));
  }

  function defaultRandomId() {
    const cryptoObject = typeof crypto !== "undefined" ? crypto : null;
    if (cryptoObject?.randomUUID) return cryptoObject.randomUUID();
    return `dev-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }

  // 依赖全部注入，Node 里可以脱离 IndexedDB / 网络 / 浏览器定时器单测。
  function createSyncService(options = {}) {
    const storage = options.storage;
    if (!storage) throw new Error("syncService 需要 storage");
    const model = options.model;
    if (!model) throw new Error("syncService 需要 syncModel");

    const now = options.now ?? (() => Date.now());
    const setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    const getNamespace = options.getNamespace ?? (() => "guest");
    const reloadState = options.reload ?? (async () => {});
    const randomId = options.randomId ?? defaultRandomId;
    const pushDebounceMs = options.pushDebounceMs ?? PUSH_DEBOUNCE_MS;
    const tombstoneTtlMs = options.tombstoneTtlMs ?? TOMBSTONE_TTL_MS;

    let transport = options.transport ?? null;
    let deviceId = "";
    let config = { autoSync: options.autoSync !== false };
    let autoSync = config.autoSync;
    let initialized = false;
    let initPromise = null;
    let pushTimer = null;
    let sessionPulled = false;
    let queue = Promise.resolve();

    const status = {
      state: "idle",
      lastSyncAt: null,
      lastPushAt: null,
      lastError: null,
      stats: null,
      lastResult: null
    };

    function enqueue(task) {
      const run = queue.then(task, task);
      // 队列只用来串行化，不让一次失败卡住后续同步。
      queue = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    }

    async function resolveTransport() {
      if (typeof transport === "function") return transport();
      return transport;
    }

    async function ensureDeviceId() {
      const existing = await storage.getMeta(DEVICE_ID_KEY);
      const value = typeof existing === "string" ? existing.trim() : "";
      if (value) return value;

      const created = String(randomId());
      await storage.putMeta(DEVICE_ID_KEY, created);
      return created;
    }

    function init() {
      if (initialized) return Promise.resolve(api);

      // 并发调用（打开站点 + 设置面板同时初始化）只能生成一个 deviceId。
      if (!initPromise) {
        initPromise = (async () => {
          deviceId = await ensureDeviceId();
          const stored = await storage.getMeta(SYNC_CONFIG_KEY);
          config =
            stored && typeof stored === "object"
              ? { autoSync: true, ...stored }
              : { autoSync: true };
          // 默认开启；只有明确存了 false 才关闭。
          autoSync = config.autoSync !== false;
          initialized = true;

          if (options.onDeviceId) options.onDeviceId(deviceId);
          return api;
        })().catch((error) => {
          initPromise = null;
          throw error;
        });
      }

      return initPromise;
    }

    async function collectLocal() {
      const [topics, tombstones] = await Promise.all([
        storage.getAllTopics(),
        storage.getTombstones()
      ]);
      return { topics: topics ?? [], tombstones: tombstones ?? [] };
    }

    // 只回收"已经足够旧"的墓碑；记录本身不受影响。
    function pruneTombstones(tombstones) {
      const cutoff = now() - tombstoneTtlMs;
      return (tombstones ?? []).filter((item) => Number(item?.deletedAt) >= cutoff);
    }

    // 把合并结果落回本地。
    // 注意：删除主题必须走 storage.deleteTopic（不写墓碑）——
    // 合并结果里的墓碑已经代表这次删除，再写一次会把删除时间刷新，
    // 而且会让"墓碑 vs 记录"的先后关系失真。
    async function applyMerged(local, merged) {
      const localTopics = new Map(local.topics.map((record) => [String(record.topicId), record]));
      const mergedTopics = new Map(merged.topics.map((record) => [String(record.topicId), record]));

      for (const [id, record] of mergedTopics) {
        const before = localTopics.get(id);
        if (!before || model.canonical(before) !== model.canonical(record)) {
          await storage.putTopic(record);
        }
      }

      for (const id of localTopics.keys()) {
        if (!mergedTopics.has(id)) await storage.deleteTopic(id);
      }

      const localTombs = new Map(local.tombstones.map((item) => [String(item.topicId), item]));
      const mergedTombs = new Map(merged.tombstones.map((item) => [String(item.topicId), item]));

      for (const [id, tombstone] of mergedTombs) {
        const before = localTombs.get(id);
        if (!before || Number(before.deletedAt) !== Number(tombstone.deletedAt)) {
          await storage.putTombstone(tombstone);
        }
      }

      // 合并时被判为"过期"的本地墓碑要删掉，否则它会一直参与下一轮合并。
      for (const id of localTombs.keys()) {
        if (!mergedTombs.has(id)) await storage.deleteTombstone(id);
      }
    }

    async function readRemote(remoteTransport, namespace) {
      const result = await remoteTransport.read();
      const bytes = result?.bytes;
      if (!result || !bytes || !bytes.length) {
        return { state: emptyState(), etag: result?.etag ?? null, exists: false };
      }
      // 远端可能是 schema 1/2 的 JSON、schema 3 的信封，或 schema 4 的 gzip 二进制，
      // 统一由 parseRemoteFile 归一成 schema 2 语义文档，再交给合并逻辑。
      const plain = await model.parseRemoteFile(bytes);
      return {
        state: model.fromRemoteDoc(plain, namespace),
        etag: result.etag ?? null,
        exists: true
      };
    }

    function markOk(result) {
      status.state = "idle";
      status.lastError = null;
      status.lastSyncAt = now();
      status.lastResult = result;
      if (result.stats) status.stats = result.stats;
      return { ok: true, ...result };
    }

    function markError(error) {
      const message = error?.message ? String(error.message) : String(error);
      status.state = "error";
      status.lastError = message;
      status.lastResult = { ok: false, reason: "error", error: message };
      return { ...status.lastResult };
    }

    async function pullTask() {
      const remoteTransport = await resolveTransport();
      if (!remoteTransport) return { ok: false, reason: "no-transport" };

      const namespace = await getNamespace();
      status.state = "syncing";

      try {
        const remote = await readRemote(remoteTransport, namespace);
        if (!remote.exists) {
          return markOk({ stats: emptyStats(), changed: false, empty: true });
        }

        const local = await collectLocal();
        const merged = model.mergeTopics(local, remote.state);
        merged.tombstones = pruneTombstones(merged.tombstones);

        await applyMerged(local, merged);
        await reloadState();

        return markOk({
          stats: merged.stats,
          changed: statsChanged(merged.stats),
          empty: false
        });
      } catch (error) {
        return markError(error);
      } finally {
        if (status.state === "syncing") status.state = "idle";
      }
    }

    function pull() {
      return enqueue(pullTask);
    }

    // 写之前先读一次远端并合并：否则本机只凭上一次的快照写回，
    // 会把另一台设备这段时间的改动覆盖掉。
    async function pushTask() {
      const remoteTransport = await resolveTransport();
      if (!remoteTransport) return { ok: false, reason: "no-transport" };

      const namespace = await getNamespace();
      status.state = "syncing";

      try {
        let remote = await readRemote(remoteTransport, namespace);
        let local = await collectLocal();
        let merged = model.mergeTopics(local, remote.state);
        merged.tombstones = pruneTombstones(merged.tombstones);
        await applyMerged(local, merged);
        await reloadState();

        let etag = remote.etag;
        let attempts = 0;

        for (;;) {
          const doc = model.toRemoteDoc({
            namespace,
            deviceId,
            topics: merged.topics,
            tombstones: merged.tombstones
          });
          const bytes = await model.serializeRemoteFile(doc);

          try {
            const written = await remoteTransport.write(bytes, etag);
            status.lastPushAt = now();
            return markOk({
              stats: merged.stats,
              changed: statsChanged(merged.stats),
              pushed: true,
              etag: written?.etag ?? null
            });
          } catch (error) {
            // 别人先写了：重新读、重新合并、再写。
            if (!isConflict(error) || attempts >= MAX_WRITE_RETRIES) throw error;
            attempts += 1;

            remote = await readRemote(remoteTransport, namespace);
            local = await collectLocal();
            merged = model.mergeTopics(local, remote.state);
            merged.tombstones = pruneTombstones(merged.tombstones);
            await applyMerged(local, merged);
            await reloadState();
            etag = remote.etag;
          }
        }
      } catch (error) {
        return markError(error);
      } finally {
        if (status.state === "syncing") status.state = "idle";
      }
    }

    function push() {
      return enqueue(pushTask);
    }

    async function syncNow() {
      const pulled = await pull();
      if (!pulled.ok) return { ok: false, pull: pulled, push: null };
      const pushed = await push();
      return { ok: pushed.ok, pull: pulled, push: pushed };
    }

    // 每次打开站点只自动拉一次；失败也不再循环重试（避免请求风暴）。
    async function pullOnce() {
      await init();
      if (!autoSync) return { ok: false, reason: "auto-sync-off" };
      if (sessionPulled) return { ok: false, reason: "already-pulled" };
      sessionPulled = true;
      return pull();
    }

    function schedulePush() {
      if (!initialized || !autoSync) return false;
      if (!transport) return false;

      if (pushTimer !== null) clearTimer(pushTimer);
      pushTimer = setTimer(() => {
        pushTimer = null;
        push();
      }, pushDebounceMs);
      return true;
    }

    function cancelScheduledPush() {
      if (pushTimer === null) return;
      clearTimer(pushTimer);
      pushTimer = null;
    }

    function setTransport(next) {
      transport = next ?? null;
      return transport;
    }

    // 整体读-改-写：设置页可能同时保存 WebDAV 凭据，这里绝不能只写 autoSync
    // 把其他字段冲掉。
    async function updateConfig(patch = {}) {
      if (!initialized) await init();

      config = { ...config, ...patch };
      autoSync = config.autoSync !== false;
      if (!autoSync) cancelScheduledPush();
      await storage.putMeta(SYNC_CONFIG_KEY, config);
      return getConfig();
    }

    async function setAutoSync(value) {
      await updateConfig({ autoSync: value !== false });
      return autoSync;
    }

    function getConfig() {
      return JSON.parse(JSON.stringify(config));
    }

    function getStatus() {
      return {
        initialized,
        deviceId,
        autoSync,
        hasTransport: Boolean(transport),
        ...status
      };
    }

    async function getDeviceId() {
      await init();
      return deviceId;
    }

    const api = {
      cancelScheduledPush,
      getConfig,
      getDeviceId,
      getStatus,
      init,
      pull,
      pullOnce,
      push,
      schedulePush,
      setAutoSync,
      setTransport,
      syncNow,
      updateConfig
    };

    return api;
  }

  // ---- 浏览器接线 ----

  function browserStorage() {
    return {
      getAllTopics: () => window.LDFCDB.getAllTopics(),
      getTombstones: () => window.LDFCDB.getTombstones(),
      putTopic: (record) => window.LDFCDB.putTopic(record),
      deleteTopic: (topicId) => window.LDFCDB.deleteTopic(topicId),
      putTombstone: (tombstone) => window.LDFCDB.putTombstone(tombstone),
      deleteTombstone: (topicId) => window.LDFCDB.deleteTombstone(topicId),
      getMeta: (key) => window.LDFCDB.getMeta(key),
      putMeta: (key, value) => window.LDFCDB.putMeta(key, value)
    };
  }

  let singleton = null;

  function browserInstance() {
    if (singleton) return singleton;

    singleton = createSyncService({
      storage: browserStorage(),
      model: window.LDFCSyncModel,
      getNamespace: async () => (await window.LDFCIdentity.resolve()).namespace,
      reload: () => window.LDFCTopicState.load(),
      onDeviceId: (id) => window.LDFCTopicState?.setDeviceId?.(id)
    });

    return singleton;
  }

  window.LDFCSyncService = {
    createSyncService,
    get instance() {
      return singleton;
    },
    init: () => browserInstance().init(),
    configureTransport: (transport) => browserInstance().setTransport(transport),
    getDeviceId: () => browserInstance().getDeviceId(),
    getStatus: () => browserInstance().getStatus(),
    getConfig: () => browserInstance().getConfig(),
    setAutoSync: (value) => browserInstance().setAutoSync(value),
    updateConfig: (patch) => browserInstance().updateConfig(patch),
    pull: () => browserInstance().pull(),
    push: () => browserInstance().push(),
    pullOnce: () => browserInstance().pullOnce(),
    syncNow: () => browserInstance().syncNow(),
    // 标记操作的热路径：同步服务不可用时绝不能把用户操作一起弄失败。
    schedulePush: () => {
      try {
        return browserInstance().schedulePush();
      } catch {
        return false;
      }
    },
    cancelScheduledPush: () => browserInstance().cancelScheduledPush()
  };
})();
