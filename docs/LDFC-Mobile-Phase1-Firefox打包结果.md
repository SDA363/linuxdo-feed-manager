# LDFC Mobile Phase 1 — Firefox 打包结果

> **Chrome v1.0.0 一行未动；产品规格未动；版本号未动（仍 `1.0.0`）。**
> 本轮只新增了一个**生成脚本**与一个**生成的 Firefox 工作区**。

- 日期：2026-09-21
- `gecko.id`：**`linuxdo-feed-manager@ldfc.local`**（已确定，永久固定）

---

## 1. gecko.id

```
linuxdo-feed-manager@ldfc.local
```

| 性质 | 说明 |
|---|---|
| 它是什么 | **扩展身份标识**，不是网站账号、不是登录凭据 |
| 是否暴露真实邮箱 | 否 —— 刻意不用真实邮箱（Mozilla 也提醒真实邮箱形式的 ID 可能带来垃圾邮件问题） |
| 是否永久 | **是**。一旦用于 AMO 签名，后续所有版本必须沿用同一个 ID，否则会被当成另一个扩展、无法更新 |
| 唯一性 | 首次 AMO 签名时由 AMO 校验 |

---

## 2. manifest 修改

### 2.1 生成方式（重要：不是手工副本）

**没有手工维护一份 `mobile-firefox/` 副本**，而是用脚本从 Chrome 源码生成：

```
linuxdo-personal-feed-manager/   ← 唯一源码（Chrome v1.0.0 封版，不变）
            │
            │  tools/build-firefox-ext.js
            ▼
      mobile-firefox/            ← 生成物（已在 .gitignore 中排除）
```

**为什么这样**：两个交付物的**唯一差异就是 manifest 的 4 个字段**。
手工维护两份源码会出现"改了一边忘了另一边"的漂移，且无法保证行为一致。

脚本内置**强制校验**：

```
要求：生成物与源码的差异必须**只有 manifest.json**
若不满足 → 直接 exit(1)，不出包

本次结果：onlyManifestDiffers = true
          differingFiles = ["manifest.json"]
          （22 个文件中 21 个逐字节相同）
```

用法：

```bash
node tools/build-firefox-ext.js         # 只生成工作区
node tools/build-firefox-ext.js --zip   # 生成并打包
```

### 2.2 实际修改内容

`mobile-firefox/manifest.json` 新增（其余字段与 Chrome 版**完全一致**）：

```json
"browser_specific_settings": {
  "gecko": {
    "id": "linuxdo-feed-manager@ldfc.local",
    "strict_min_version": "128.0",
    "data_collection_permissions": {
      "required": ["none"]
    }
  },
  "gecko_android": {
    "strict_min_version": "128.0"
  }
}
```

| 字段 | 值 | 理由 |
|---|---|---|
| `gecko.id` | `linuxdo-feed-manager@ldfc.local` | 你已确认；MV3 签名必需 |
| `gecko.strict_min_version` | `128.0` | `content_scripts.world: "MAIN"` 需要 Firefox 128（MDN BCD） |
| `gecko.data_collection_permissions.required` | `["none"]` | **AMO 自 2025-11-03 起强制**，已过生效日 |
| `gecko_android.strict_min_version` | `128.0` | 声明 Android 可用范围 |

**未改动**：`manifest_version`、`version`、`content_scripts`（含 `world: "MAIN"`）、
`host_permissions`、`name`、`description`。

> `data_collection_permissions: none` 与产品规格「隐私」一节完全一致
> （无账号同步 / 无云数据库 / 无第三方 API / 无 Analytics / 无 Telemetry）——
> 不是权宜之计，是**如实声明**。

---

## 3. lint 结果

```
npx web-ext lint --source-dir=mobile-firefox

errors: 0   ✅   notices: 0   warnings: 5
```

### 对比修复前（Chrome 版）

| | 修复前（Chrome manifest） | 修复后（Firefox manifest） |
|---|---|---|
| errors | **1** —— `ADDON_ID_REQUIRED` | **0** ✅ |
| warnings | 4 | 5 |

**`ADDON_ID_REQUIRED` 已消除** ✓ —— 这是本轮的核心目标。
**`MISSING_DATA_COLLECTION_PERMISSIONS` 也已消除** ✓。

> 你要求的目标是 **errors = 0**，已达成。

---

## 4. warnings（逐条判断，不是"改到全绿"）

你明确要求：*"不要为了看起来全绿随意改产品代码；逐条判断是否需要处理，并记录原因。"*
以下是 5 条警告的逐条判断。

### 4.1 新增的 2 条：`KEY_*_UNSUPPORTED_BY_MIN_VERSION`

**linter 的原文说明（它自己指出了原因）**：

```
[桌面] "strict_min_version" requires Firefox 128, which was released before
       version 140 introduced support for
       "browser_specific_settings.gecko.data_collection_permissions".

[Android] "strict_min_version" requires Firefox for Android 128, which was
          released before version 142 introduced support for the same key.
```

**这是 linter 抓到的真实内部不一致**：我声明最低 128，但用了 140（桌面）/ 142（Android）才引入的 key。

**判断：保留 `128.0`，不改。**

理由：

1. **功能门槛是 128，不是 142** —— 扩展真正需要 128 的原因是 `world: "MAIN"`。
2. **那个 key 在 128–141 上被忽略，但没有实际后果** —— 本扩展**不收集任何数据**，
   忽略数据收集声明不等于违规收集。
3. **AMO 的要求是"该 key 必须存在"** —— 它已经存在 ✓
4. 改到 142 会**收窄兼容范围**（把 128–141 的用户挡在外面），而收益只是消除警告。

**但这是一个兼容性取舍，属于【实现候选】，建议你定。**

切换成本：`tools/build-firefox-ext.js` 顶部的**一个常量**。

```js
const MIN_VERSION = "128.0";   // 改成 "142.0" 即可消除这 2 条警告，代价是收窄兼容范围
```

### 4.2 原有的 3 条：`UNSAFE_VAR_ASSIGNMENT`

| 位置 | 实际代码 | 输入来源 | 判断 |
|---|---|---|---|
| `core/newReply.js:37` | `holder.innerHTML = html` | Discourse 服务端清洗过的 `post.cooked`；节点**游离**（不插入文档）；只读取 `textContent` | **实际风险低**。<br>这是唯一处理外部内容的一处。**建议后续版本**改用 `DOMParser.parseFromString(html, "text/html")` —— 行为完全不变，彻底不碰 `innerHTML` |
| `ui/navigation.js:32` | `button.innerHTML = \`${label} <span>${count}</span>\`` | `label` 来自同文件**硬编码常量**；`count` 是数字 | **安全**（无外部输入） |
| `ui/settings.js:212` | `card.innerHTML = \`<strong>${choice.label}</strong>…\`` | `choice.*` 是紧邻几行的**硬编码常量** | **安全**（无外部输入） |

**本轮判断：不改产品代码。**

理由：

- 三条**都不是已验证的漏洞**，其中两条输入是硬编码常量
- 唯一处理外部内容的那条风险低（游离节点 + 只读 textContent）
- **改产品代码会影响 Chrome 版**（同一个源码），而你要求本轮不动 Chrome v1.0.0
- 改它们属于**加固**，不是修 bug；应作为独立的小改动 + 回归测试来做

**但有一条现实提醒**：AMO 人工审核时**可能**提出这三条。
如果审核被打回，建议按上表改（`navigation.js` / `settings.js` 改 `createElement` + `textContent`；
`newReply.js` 改 `DOMParser`）—— 三处都是**行为完全不变**的小改动。

---

## 5. Firefox Android 安装包

```
dist/linuxdo-feed-manager-firefox-1.0.0.zip
  大小：46,016 字节（45 KB）
  条目：9 个顶层条目（22 个文件 + 目录）
```

### 结构校验（已逐项验证）

| 检查 | 结果 |
|---|---|
| `manifest.json` 位于 **ZIP 根** | ✅ 1 个 |
| 带 `./` 前缀的条目 | **0** ✅ |
| 多余的外层目录（`mobile-firefox/…`） | **0** ✅ |
| 与源码的差异 | **只有 manifest.json** ✅ |

> 打包用 **Windows 自带的 bsdtar**（`System32\tar.exe`）。
> 顺带记录两个坑：`Compress-Archive` 处理中文路径（本机 `D:\桌面\…`）会编码出错；
> bsdtar 必须传**正斜杠**路径，反斜杠会被它当成转义。

### 包内容

```
manifest.json          ← 含 browser_specific_settings
content.js
site/       identity.js  topicParser.js  discourseAdapter.js
            trackingState.js  routeObserverMain.js
storage/    migration.js  db.js  topicState.js
core/       poolManager.js  newReply.js  filter.js  autofill.js
interaction/desktopActions.js  swipe.js
ui/         toast.js  navigation.js  poolPanel.js  settings.js
styles/     content.css
README.md
```

**不含**：`browser-lab/`、测试探针、各轮报告、Chrome 的 dist 包、任何 profile。

---

## 6. 文件类型 / 是否需要签名 / 签名前后区别

### 文件类型

**普通 ZIP（未签名）**。它只是"源码 + Firefox manifest"的压缩包。

### 能否直接安装到 Firefox Android

**不能。**

| 环境 | 未签名 ZIP |
|---|---|
| Firefox 桌面（release/beta） | ❌ 不能安装（只能通过 `about:debugging` 临时加载，且不持久） |
| **Firefox for Android** | ❌ **不能安装** —— 官方文档要求「从文件安装」的是**已签名**的扩展包 |
| Firefox Nightly（关闭签名验证） | 技术上可以，但**你已明令禁止**，本轮也未采用 |

### 是否需要 AMO unlisted signing

**需要。**

选 **unlisted（仅自分发）** 即可：不公开上架 AMO 商店，只拿签名后的文件自己分发。

### 签名前后的区别

| | 签名前 | 签名后 |
|---|---|---|
| 文件扩展名 | `.zip` | **`.xpi`** |
| 内容 | 源码 | 源码 **+ `META-INF/`**（`manifest.mf`、`mozilla.rsa`、`cose.sig` 等签名文件） |
| 能否安装到 Firefox Android | ❌ | ✅ |
| 能否被 Firefox 识别为"同一个扩展" | — | ✅ 由 `gecko.id` 决定 |
| 能否后续自动更新 | ❌ | ✅（**必须沿用同一个 `gecko.id`**） |
| 源码是否被改动 | — | **不改源码**，只追加签名文件 |

> **关键**：签名**不修改你的代码**，只是在包里加一层 `META-INF/`。
> 所以签完名的 `.xpi` 与现在的 `.zip` 里的源码是同一份。

---

## 7. Chrome 是否受影响

**不受影响。有两层证据。**

### 证据 1：源码逐字节核对

```
$ git status --short linuxdo-personal-feed-manager/
（无输出）

$ git diff --stat 26e76b6 -- linuxdo-personal-feed-manager/
（无输出）
```

→ Chrome 源码相对 **v1.0.0 封版提交 `26e76b6`** **零改动**。

并且生成脚本强制校验：Firefox 工作区 22 个文件中 **21 个与 Chrome 源码逐字节相同**，
唯一差异是 `manifest.json`。

### 证据 2：完整回归实测

```
$ node run-ldfc-acceptance.js
汇总：70 项通过，0 项失败
```

→ Chrome v1.0.0 行为**经实测未变**（不是"应该没变"，是跑过了）。

### 版本号

| | 值 |
|---|---|
| Chrome `manifest.version` | `1.0.0`（未动） |
| Firefox `manifest.version` | `1.0.0`（与 Chrome 一致） |
| 官方版本号是否升级 | **未升级**（按你的要求） |

---

## 8. AMO 签名下一步（你需要做的）

```
① 打开 https://addons.mozilla.org/developers/
② 登录（或注册）Mozilla 账号
③ Submit a New Add-on
④ 选择分发方式：**On your own（unlisted / 自分发）**   ← 不要选 On this site
⑤ 上传：dist/linuxdo-feed-manager-firefox-1.0.0.zip
⑥ 等待自动校验通过（首次会校验 gecko.id 唯一性）
⑦ 下载签名后的 .xpi
⑧ 把 .xpi 交给我
```

**注意事项**

- 上传的是 **ZIP**（`manifest.json` 在根，已校验）✓
- `gecko.id` 首次使用会被登记，**之后永远不要改**
- 选择 unlisted 后**不会**出现在 AMO 商店里，只有拿到文件的人能装
- 版本号 `1.0.0` 会与 `gecko.id` 绑定记录；后续更新必须**提高 version**

---

## 9. 下一步：真机 / 模拟器安装步骤

环境已就绪（Phase 1 前半段已验证）：

```
模拟器     LDPlayer 14，运行中
adb        D:\leidian\LDPlayer14\adb.exe
设备       emulator-5554（Android 14 / API 34 / x86_64）
Firefox    org.mozilla.firefox 156.0 已装
linux.do   可正常访问，未遇 Cloudflare
```

### 拿到签名 `.xpi` 后我要做的

```
① adb push <signed.xpi> /sdcard/Download/
② 在模拟器里打开 Firefox → 设置 → 关于 Firefox → 连点 logo 5 次
③ 设置 → Install Extension from File → 选择该 xpi → Add
④ 验证五区导航出现
⑤ 打开 linux.do 验证 Topic List / Topic ID / 身份识别
⑥ 跑 Swipe 九种手势（垂直 / 斜向 / 右滑 / 左滑 / 阈值以下 / 快速 / 慢速 /
   从链接区域开始 / 滑动后继续滚动）
```

> 我也可以用 `adb shell input` 驱动③之前的部分，但「连点 logo 5 次」这一步在模拟器里
> 需要精确坐标操作 —— 如果自动化不顺，可能需要你手点两下。

### 安装链路（官方文档，供参考）

```
设置 → 关于 Firefox → 快速连点 Firefox 图标 5 次（解锁隐藏菜单）
→ 设置 → Install Extension from File → 选择 .xpi → Add
```

---

## 10. 本轮改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `tools/build-firefox-ext.js` | **新增**（入库） | Firefox 工作区生成 + 打包脚本，含"差异只有 manifest"强制校验 |
| `mobile-firefox/` | **生成物**（不入库） | 已在 `.gitignore` 排除 |
| `dist/linuxdo-feed-manager-firefox-1.0.0.zip` | **生成物**（不入库） | AMO 上传用 |
| `.gitignore` | 修改 | 增加 `mobile-firefox/` |

**正式源码（`linuxdo-personal-feed-manager/`）：零改动。**
**产品规格：零改动。**
**版本号：未升级。**

---

## 11. 本轮没有做的事（按你的禁令）

| 禁止项 | 状态 |
|---|---|
| 修改 Swipe 参数 | ❌ 未做 |
| 加移动端备用入口 | ❌ 未做 |
| 改桌面端 UI | ❌ 未做 |
| 改自动补位 | ❌ 未做 |
| 改 NEW_REPLY | ❌ 未做 |
| 改 IndexedDB | ❌ 未做 |
| 改四池 + newReplyPending 状态模型 | ❌ 未做 |
| 改 Linux.do 产品语义 | ❌ 未做 |
| 修改 Chrome v1.0.0 | ❌ 未做（git 证据 + 70/70 回归） |
| 升级正式版本号 | ❌ 未做（仍 `1.0.0`） |
| 为"看起来全绿"随意改产品代码 | ❌ 未做（5 条警告逐条判断，3 条明确判为"本轮不改"，理由已记录） |

---

## 12. 一句话总结

> **`errors = 0` 已达成**；manifest 差异只有 4 个字段且由脚本保证；
> Chrome v1.0.0 逐字节未动、70/70 回归通过；
> 安装包已就绪（ZIP → 需 AMO unlisted 签名 → `.xpi`）。
>
> **现在轮到你**：上传 AMO 做 unlisted 签名，把 `.xpi` 给我，
> 我就能装进已就绪的 Android 模拟器，跑 Swipe 九种手势。
>
> **另有一个请你定的兼容性取舍**：`strict_min_version` 保留 `128.0`（当前，含 2 条警告）
> 还是提到 `142.0`（消除警告，收窄兼容）—— 一行常量即可切换。
