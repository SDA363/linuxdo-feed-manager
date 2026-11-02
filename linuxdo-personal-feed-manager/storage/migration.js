(() => {
  // IndexedDB（浏览器本地数据库）结构定义与升级。
  //
  // 每个账号一个独立数据库，所以这里只描述"一个库内部长什么样"，
  // 跨账号的搬迁逻辑在 db.js 里（那是数据库之间的事，不是结构升级）。
  const TOPICS_STORE = "topics";
  const META_STORE = "meta";
  const VISITS_STORE = "visits";
  const TOMBSTONES_STORE = "tombstones";

  const DB_VERSION = 3;

  // 每次改结构都必须追加一个 oldVersion 分支，不能修改历史分支，
  // 否则老用户升级时会丢数据。
  function apply(database, oldVersion) {
    if (oldVersion < 1) {
      if (!database.objectStoreNames.contains(TOPICS_STORE)) {
        database.createObjectStore(TOPICS_STORE, { keyPath: "topicId" });
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE);
      }
    }

    if (oldVersion < 2) {
      // visits（访问记录）：记录"安装之后被打开过"的 Topic。
      // 自动已读只认这些 Topic，避免把安装前的阅读历史猜成已读。
      if (!database.objectStoreNames.contains(VISITS_STORE)) {
        database.createObjectStore(VISITS_STORE, { keyPath: "topicId" });
      }
    }

    if (oldVersion < 3) {
      // tombstones（删除墓碑）：同步时"本地没有这条"和"这条被删了"是两种
      // 完全不同的状态。没有墓碑，另一台设备会把删掉的记录当成
      // "它本地独有的新增"重新推回来，清理等于白做。
      if (!database.objectStoreNames.contains(TOMBSTONES_STORE)) {
        database.createObjectStore(TOMBSTONES_STORE, { keyPath: "topicId" });
      }
    }
  }

  window.LDFCMigration = {
    DB_VERSION,
    META_STORE,
    TOPICS_STORE,
    TOMBSTONES_STORE,
    VISITS_STORE,
    apply
  };
})();
