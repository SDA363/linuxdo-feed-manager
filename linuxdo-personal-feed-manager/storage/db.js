(() => {
  // 每个 Linux.do 账号使用一个独立的 IndexedDB（浏览器本地数据库）。
  // 数据库名形如 <前缀>user-123（身份读不到时是 <前缀>unresolved）。
  // 用"一个账号一个库"而不是"一个库里加账号字段"，是因为前者的隔离
  // 由浏览器保证，不存在跨账号误覆盖的可能，删某个账号的数据也只是
  // 清空自己的库。
  const DB_PREFIX = "ldfc__";
  const LEGACY_DB_NAME = "ldfc";
  const { DB_VERSION, META_STORE, TOPICS_STORE, TOMBSTONES_STORE, VISITS_STORE } =
    window.LDFCMigration;

  let databaseName = null;
  let dbPromise = null;

  async function databaseNameFor(identity) {
    return `${DB_PREFIX}${identity.namespace}`;
  }

  // ---- 底层工具（显式接收 database，供主流程和迁移共用）----

  function readAll(database, storeName) {
    return new Promise((resolve) => {
      if (!database.objectStoreNames.contains(storeName)) {
        resolve([]);
        return;
      }
      const request = database.transaction(storeName, "readonly").objectStore(storeName).getAll();
      request.onsuccess = () => resolve(request.result ?? []);
      request.onerror = () => resolve([]);
    });
  }

  function readAllMeta(database) {
    return new Promise((resolve) => {
      if (!database.objectStoreNames.contains(META_STORE)) {
        resolve({});
        return;
      }
      const store = database.transaction(META_STORE, "readonly").objectStore(META_STORE);
      const keysRequest = store.getAllKeys();
      keysRequest.onsuccess = async () => {
        const out = {};
        for (const key of keysRequest.result ?? []) {
          out[key] = await new Promise((done) => {
            const single = database.transaction(META_STORE, "readonly").objectStore(META_STORE).get(key);
            single.onsuccess = () => done(single.result);
            single.onerror = () => done(undefined);
          });
        }
        resolve(out);
      };
      keysRequest.onerror = () => resolve({});
    });
  }

  function writeAll(database, storeName, records) {
    return new Promise((resolve) => {
      if (!records.length || !database.objectStoreNames.contains(storeName)) {
        resolve();
        return;
      }
      const transaction = database.transaction(storeName, "readwrite");
      const store = transaction.objectStore(storeName);
      for (const record of records) store.put(record);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => resolve();
      transaction.onabort = () => resolve();
    });
  }

  // ---- 旧版本数据迁移 ----
  //
  // 这一版之前所有状态都存在名为 "ldfc" 的单个库里。升级后把它整库
  // 搬到"当前账号"的命名空间下，避免升级即丢数据。
  //
  // 关键点：迁移标记必须写在**旧库里**，不能写在当前命名空间的库里。
  // 否则每换一个账号（包括身份读不到时的 unresolved 空间）都会各自跑一次迁移，
  // 把旧数据复制进每一个空间，账号隔离就破了。

  function readMetaValue(database, key) {
    return new Promise((resolve) => {
      if (!database.objectStoreNames.contains(META_STORE)) {
        resolve(undefined);
        return;
      }
      const request = database.transaction(META_STORE, "readonly").objectStore(META_STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  }

  function writeMetaValue(database, key, value) {
    return new Promise((resolve) => {
      if (!database.objectStoreNames.contains(META_STORE)) {
        resolve();
        return;
      }
      const request = database.transaction(META_STORE, "readwrite").objectStore(META_STORE).put(value, key);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
    });
  }

  async function existingDatabaseNames() {
    if (typeof indexedDB.databases !== "function") return null;
    try {
      const list = await indexedDB.databases();
      return list.map((entry) => entry.name);
    } catch {
      return null;
    }
  }

  function openLegacyDatabase() {
    return new Promise((resolve) => {
      const request = indexedDB.open(LEGACY_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      // 旧库不该触发升级；真触发了也不动它
      request.onupgradeneeded = () => {};
    });
  }

  // 注意：这里绝不能调用 openDatabase() —— 本函数正是被 openDatabase 等待的，
  // 再回去等它就会死锁。所有写入都用传进来的 database 直接做。
  async function migrateLegacy(database, namespace) {
    const names = await existingDatabaseNames();
    // databases() 不可用时宁可不迁移，也不要凭空创建一个空库
    if (!names || !names.includes(LEGACY_DB_NAME)) return;

    const legacy = await openLegacyDatabase();
    if (!legacy) return;

    try {
      const migratedTo = await readMetaValue(legacy, "migratedTo");
      if (migratedTo) return;

      const [topics, visits, meta] = await Promise.all([
        readAll(legacy, TOPICS_STORE),
        readAll(legacy, VISITS_STORE),
        readAllMeta(legacy)
      ]);

      const withoutRetiredFields = (record) => {
        const { previousPool, ...rest } = record;
        return rest;
      };

      await writeAll(database, TOPICS_STORE, topics.map(withoutRetiredFields));
      await writeAll(database, VISITS_STORE, visits);

      // meta（元数据）用的是外部 key（out-of-line key），不能走批量 put，
      // 必须逐个带 key 写入。
      const { migratedTo: _ignored, ...carried } = meta ?? {};
      for (const [key, value] of Object.entries(carried)) {
        if (value === undefined) continue;
        await writeMetaValue(database, key, value);
      }

      await writeMetaValue(legacy, "migratedTo", namespace);
    } finally {
      legacy.close();
    }
  }

  // ---- 主流程 ----

  async function openDatabase() {
    if (dbPromise) return dbPromise;

    dbPromise = (async () => {
      const identity = await window.LDFCIdentity.resolve();
      databaseName = await databaseNameFor(identity);

      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(databaseName, DB_VERSION);
        let settled = false;

        request.onupgradeneeded = (event) => {
          window.LDFCMigration.apply(request.result, event.oldVersion);
        };

        // 别的标签页还占着旧版本连接时，Chrome 会把这次升级挂起：
        // onsuccess / onerror 都不触发，Promise 永远不 settle。
        // 那样界面就是"没有 UI、也没有报错"。这里把原因说清楚。
        request.onblocked = () => {
          settled = true;
          reject(
            new Error("本地数据库正被其他 linux.do 标签页占用，请关闭其他标签页后刷新")
          );
        };

        request.onsuccess = () => {
          if (settled) {
            // 已经被 onblocked 判过死刑，就别再留一条连接。
            request.result.close();
            return;
          }
          // 将来有新版本要升级时，主动让旧连接让位，避免再次挂起。
          request.result.onversionchange = () => request.result.close();
          resolve(request.result);
        };
        request.onerror = () => reject(request.error);
      });

      try {
        await migrateLegacy(database, identity.namespace);
      } catch {
        // 迁移失败不影响使用，只是少一份历史数据
      }

      return database;
    })();

    return dbPromise;
  }

  // 注意：IDBTransaction（数据库事务）没有 onsuccess 事件，只有
  // oncomplete / onerror / onabort。监听 onsuccess 会让 Promise 永远处于
  // 等待状态，导致调用方永久挂起、界面不渲染。
  async function withStore(storeName, mode, callback) {
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, mode);
      const store = transaction.objectStore(storeName);
      let request;

      try {
        request = callback(store);
      } catch (error) {
        reject(error);
        return;
      }

      transaction.oncomplete = () => resolve(request ? request.result : undefined);
      transaction.onerror = () => reject(transaction.error ?? request.error);
      transaction.onabort = () =>
        reject(transaction.error ?? request.error ?? new Error("IndexedDB 事务被中止"));
    });
  }

  // 删除必须留墓碑：同步时"本地没有这条"和"这条被删了"是两种不同状态，
  // 不留墓碑的话另一台设备会把它当成自己独有的新增重新推回来。
  // 写墓碑和删记录放在同一个事务里，避免只写了一半。
  function deleteWithTombstones(predicate) {
    return openDatabase().then(
      (database) =>
        new Promise((resolve, reject) => {
          const transaction = database.transaction(
            [TOPICS_STORE, TOMBSTONES_STORE],
            "readwrite"
          );
          const topics = transaction.objectStore(TOPICS_STORE);
          const tombstones = transaction.objectStore(TOMBSTONES_STORE);
          const deletedAt = Date.now();
          let removed = 0;

          const cursorRequest = topics.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) return;
            const record = cursor.value;
            if (predicate(record)) {
              tombstones.put({ topicId: String(record.topicId), deletedAt });
              cursor.delete();
              removed += 1;
            }
            cursor.continue();
          };
          cursorRequest.onerror = () => reject(cursorRequest.error);

          transaction.oncomplete = () => resolve(removed);
          transaction.onerror = () => reject(transaction.error ?? cursorRequest.error);
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("IndexedDB 事务被中止"));
        })
    );
  }

  window.LDFCDB = {
    async getAllTopics() {
      return withStore(TOPICS_STORE, "readonly", (store) => store.getAll());
    },

    async putTopic(record) {
      return withStore(TOPICS_STORE, "readwrite", (store) => store.put(record));
    },

    // 清理全部：同样留墓碑，否则同步会把删掉的记录推回来。
    async clearTopics() {
      return deleteWithTombstones(() => true);
    },

    // 按池清理：只删本地记录，不动 Linux.do 上的任何内容。
    async deleteTopicsByPool(basePool) {
      return deleteWithTombstones((record) => record?.basePool === basePool);
    },

    // 只删记录、不写墓碑：给"同步/导入已经确认删除"的场景用，
    // 用户主动清理请走 clearTopics / deleteTopicsByPool。
    async deleteTopic(topicId) {
      return withStore(TOPICS_STORE, "readwrite", (store) => store.delete(String(topicId)));
    },

    async getTombstones() {
      return withStore(TOMBSTONES_STORE, "readonly", (store) => store.getAll());
    },

    async putTombstone(record) {
      return withStore(TOMBSTONES_STORE, "readwrite", (store) => store.put(record));
    },

    async deleteTombstone(topicId) {
      return withStore(TOMBSTONES_STORE, "readwrite", (store) => store.delete(String(topicId)));
    },

    async clearTombstones() {
      return withStore(TOMBSTONES_STORE, "readwrite", (store) => store.clear());
    },

    async getVisits() {
      return withStore(VISITS_STORE, "readonly", (store) => store.getAll());
    },

    async putVisit(record) {
      return withStore(VISITS_STORE, "readwrite", (store) => store.put(record));
    },

    async deleteVisit(topicId) {
      return withStore(VISITS_STORE, "readwrite", (store) => store.delete(String(topicId)));
    },

    async clearVisits() {
      return withStore(VISITS_STORE, "readwrite", (store) => store.clear());
    },

    async getMeta(key) {
      return withStore(META_STORE, "readonly", (store) => store.get(key));
    },

    async putMeta(key, value) {
      return withStore(META_STORE, "readwrite", (store) => store.put(value, key));
    },

    async getDatabaseName() {
      await openDatabase();
      return databaseName;
    }
  };
})();
