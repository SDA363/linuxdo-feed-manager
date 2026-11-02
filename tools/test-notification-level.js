"use strict";

// 通知级别模块的纯 Node 单测：不需要浏览器 / 网络 / 真实站点。
// 覆盖：默认设置、自动已读独立映射、手动优先、跟随信息池、撤销、未登录。
//
// 用法：node tools/test-notification-level.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const MODULE_FILE = path.join(
  ROOT,
  "linuxdo-personal-feed-manager",
  "core",
  "notificationLevel.js"
);

const results = [];
const check = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

async function main() {
  const meta = new Map();
  const records = new Map();
  const fetches = [];
  let pushes = 0;
  let loggedIn = true;
  let csrf = "csrf-test";

  const state = {
    get(topicId) {
      return records.get(String(topicId)) ?? null;
    },
    async setNotifyLevel(topicId, level, manual = false) {
      const key = String(topicId);
      const existing = records.get(key);
      if (!existing) return null;
      const value = typeof level === "number" ? level : null;
      const record = {
        ...existing,
        notifyLevel: value,
        notifyManualLevel: manual ? value : existing.notifyManualLevel ?? null,
        notifyManualAt: manual ? Date.now() : existing.notifyManualAt ?? null
      };
      records.set(key, record);
      return record;
    },
    async clearNotifyManual(topicId) {
      const key = String(topicId);
      const existing = records.get(key);
      if (!existing || existing.notifyManualLevel == null) return existing ?? null;
      const record = { ...existing, notifyManualLevel: null, notifyManualAt: Date.now() };
      records.set(key, record);
      return record;
    }
  };

  const window = {
    LDFCDB: {
      async getMeta(key) {
        return meta.get(key);
      },
      async putMeta(key, value) {
        meta.set(key, value);
      }
    },
    LDFCIdentity: {
      current() {
        return { loggedIn, username: loggedIn ? "alice" : "", namespace: "user-1" };
      }
    },
    LDFCTopicState: state,
    LDFCTrackingState: {
      rowFor() {
        return null;
      }
    },
    LDFCSyncService: {
      schedulePush() {
        pushes += 1;
      }
    }
  };

  const document = {
    querySelector(selector) {
      if (selector !== 'meta[name="csrf-token"]' || !csrf) return null;
      return { getAttribute: () => csrf };
    }
  };

  const sandbox = {
    window,
    document,
    console,
    Date,
    fetch: async (url, init = {}) => {
      fetches.push({ url: String(url), method: init.method, body: init.body, headers: init.headers });
      return { ok: true, status: 200, json: async () => ({}) };
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(MODULE_FILE, "utf8"), sandbox, { filename: MODULE_FILE });
  const notify = window.LDFCNotify;

  const settings = await notify.loadSettings();
  check(
    settings.autoReadLevel === null && settings.linkPools === true,
    `默认：自动已读不修改、池子联动开启（${JSON.stringify(settings)}）`
  );

  await notify.setSettings({ autoReadLevel: 2 });
  check(
    meta.get("notifyLinkage")?.autoReadLevel === 2,
    `自动已读档位写入本地设置（${JSON.stringify(meta.get("notifyLinkage"))}）`
  );

  records.set("1", {
    topicId: "1",
    basePool: "HOME",
    notifyLevel: 3,
    notifyManualLevel: null,
    notifyManualAt: null
  });
  const auto = await notify.applyAutoRead("1");
  check(
    auto.applied === true && auto.previous === 3,
    `自动已读按独立映射写入（applied=${auto.applied}，previous=${auto.previous}）`
  );
  check(
    state.get("1").notifyLevel === 2 &&
      state.get("1").notifyManualLevel === null &&
      fetches.at(-1)?.body === "notification_level=2",
    `自动已读请求体正确且不产生手动标记（${fetches.at(-1)?.body}）`
  );

  const beforeManualPushes = pushes;
  await notify.set("1", 1, { manual: true });
  check(
    state.get("1").notifyManualLevel === 1 &&
      typeof state.get("1").notifyManualAt === "number" &&
      pushes > beforeManualPushes,
    `手动改通知写入接管标记并安排同步推送（${JSON.stringify(state.get("1"))}）`
  );

  const beforeManualFetch = fetches.length;
  const blocked = await notify.applyAutoRead("1");
  check(
    blocked.applied === false && blocked.reason === "manual" && fetches.length === beforeManualFetch,
    `手动接管后自动已读不再覆盖，也不发请求（reason=${blocked.reason}）`
  );

  const beforeFollowPushes = pushes;
  await notify.followPool("1");
  check(
    state.get("1").notifyManualLevel === null &&
      typeof state.get("1").notifyManualAt === "number" &&
      pushes > beforeFollowPushes,
    `跟随信息池清除接管标记并安排同步推送（${JSON.stringify(state.get("1"))}）`
  );

  records.set("2", {
    topicId: "2",
    basePool: "HOME",
    notifyLevel: 3,
    notifyManualLevel: null,
    notifyManualAt: null
  });
  await notify.setSettings({ linkPools: false, autoReadLevel: 0 });
  const off = await notify.applyAutoRead("2");
  check(
    off.applied === false && off.reason === "linkage-off",
    `联动总开关关闭时自动已读不写站点（reason=${off.reason}）`
  );

  await notify.setSettings({ linkPools: true });
  const zero = await notify.applyAutoRead("2");
  check(
    zero.applied === true &&
      state.get("2").notifyLevel === 0 &&
      fetches.at(-1)?.body === "notification_level=0",
    `自动已读可选免打扰(0)，且 0 不会被当成空值（body=${fetches.at(-1)?.body}）`
  );

  await notify.revert("2", 3);
  check(
    state.get("2").notifyLevel === 3 && fetches.at(-1)?.body === "notification_level=3",
    `撤销回滚到操作前档位（body=${fetches.at(-1)?.body}）`
  );

  await notify.set("2", 2, { manual: true });
  await notify.revert("2", 3);
  check(
    state.get("2").notifyLevel === 3 && state.get("2").notifyManualLevel === 2,
    `撤销不改手动接管标记本身（level=${state.get("2").notifyLevel}，manual=${state.get("2").notifyManualLevel}）`
  );

  loggedIn = false;
  records.set("3", {
    topicId: "3",
    basePool: "HOME",
    notifyLevel: 3,
    notifyManualLevel: null,
    notifyManualAt: null
  });
  const guest = await notify.applyAutoRead("3");
  check(
    guest.applied === false && guest.reason === "guest",
    `未登录时不发必败的通知请求（reason=${guest.reason}）`
  );

  loggedIn = true;
  csrf = "";
  records.set("4", {
    topicId: "4",
    basePool: "HOME",
    notifyLevel: 3,
    notifyManualLevel: null,
    notifyManualAt: null
  });
  const noCsrf = await notify.applyAutoRead("4");
  check(
    noCsrf.applied === false && noCsrf.reason === "error" && state.get("4").notifyLevel === 3,
    `缺 CSRF 令牌时明确失败且不改本地缓存（reason=${noCsrf.reason}）`
  );

  console.log("===== 通知级别模块单测 =====");
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(`\n汇总：${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
