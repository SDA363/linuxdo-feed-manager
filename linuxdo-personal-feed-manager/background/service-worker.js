"use strict";

// 最小后台：只做一件事 —— 代 content script 发 WebDAV 请求。
//
// 为什么必须放在后台：
//   MV3 里 content script 的 fetch 受页面 CORS 限制。WebDAV 服务器
//   （坚果云等）不会给 linux.do 发 Access-Control-Allow-Origin，
//   在 content script 里直接请求必然失败。
//   扩展后台在获得该域名的 host 权限后不受页面 CORS 限制。
//
// 边界：
//   - 不持久化任何凭据；账号密码随单次消息传入、用完即弃；
//   - 不记录请求体 / Authorization 到日志；
//   - 只处理本扩展自己的消息类型。

const MESSAGE_TYPE = "ldfc:webdav";
const CHECK_PERMISSION_TYPE = "ldfc:check-permission";
const OPEN_PERMISSION_TYPE = "ldfc:open-permission-page";
const ALLOWED_METHODS = new Set(["read", "write", "test"]);

function basicAuthHeader(username, password) {
  // btoa 只接受 Latin-1，先按 UTF-8 编码再转二进制字符串，避免中文账号乱码。
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

// 同步文件是 gzip 二进制（schema 4）。消息通道只能传 JSON，
// 所以在这里做 base64 ↔ 字节的边界转换：落盘/下载保持原始字节。
function bytesToBase64(bytes) {
  let binary = "";
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

function originPatternFor(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("只支持 http / https 的 WebDAV 地址");
  }
  // 匹配模式不包含端口：Chrome 的 host 权限本来就按"协议 + 主机"生效。
  return `${parsed.protocol}//${parsed.hostname}/*`;
}

function isOriginPattern(value) {
  return typeof value === "string" && /^https?:\/\/[^/]+\/\*$/.test(value);
}

async function hasHostPermission(rawUrl) {
  try {
    return await chrome.permissions.contains({ origins: [originPatternFor(rawUrl)] });
  } catch {
    return false;
  }
}

async function forward(payload = {}) {
  const method = payload.method;
  const url = payload.url;

  if (!ALLOWED_METHODS.has(method)) throw new Error("未知的请求类型");
  if (!url) throw new Error("缺少 WebDAV 地址");

  if (!(await hasHostPermission(url))) {
    return { ok: false, reason: "permission", status: 0, error: "没有访问该域名的权限" };
  }

  const headers = { Accept: "*/*" };
  if (payload.username || payload.password) {
    headers.Authorization = basicAuthHeader(payload.username ?? "", payload.password ?? "");
  }

  let response;
  try {
    if (method === "write") {
      headers["Content-Type"] = payload.contentType || "application/octet-stream";
      // 有 ETag 用 If-Match（防止覆盖别人的写入）；
      // 没有 ETag 说明本地认为文件不存在，用 If-None-Match: * 防止并发创建。
      if (payload.etag) headers["If-Match"] = payload.etag;
      else headers["If-None-Match"] = "*";

      response = await fetch(url, {
        method: "PUT",
        headers,
        body: base64ToBytes(payload.bodyBase64 ?? ""),
        cache: "no-store",
        redirect: "follow"
      });
    } else {
      response = await fetch(url, {
        method: "GET",
        headers,
        cache: "no-store",
        redirect: "follow"
      });
    }
  } catch (error) {
    return { ok: false, reason: "network", status: 0, error: error?.message || "网络请求失败" };
  }

  const status = response.status;
  const etag = response.headers.get("etag");
  let bodyBase64 = "";
  try {
    bodyBase64 = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
  } catch {
    bodyBase64 = "";
  }

  if (status === 401 || status === 403) {
    return { ok: false, reason: "auth", status, error: "认证失败（401/403）" };
  }

  if (method === "write" && (status === 409 || status === 412)) {
    return { ok: false, reason: "conflict", status, error: "远端文件已被其他设备修改" };
  }

  // 文件还不存在不是错误：首次同步就是从这个状态开始的。
  if (status === 404) {
    return { ok: true, status, bodyBase64: "", etag: null };
  }

  if (status >= 200 && status < 300) {
    return { ok: true, status, bodyBase64, etag };
  }

  return { ok: false, reason: "http", status, error: `HTTP ${status}` };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === CHECK_PERMISSION_TYPE) {
    const origins = Array.isArray(message.origins) ? message.origins.filter(isOriginPattern) : [];
    chrome.permissions
      .contains({ origins })
      .then((granted) => sendResponse({ granted }))
      .catch(() => sendResponse({ granted: false }));
    return true;
  }

  // chrome.permissions.request 必须由用户手势触发，而 content script
  // 里根本没有 chrome.permissions。所以这里只负责打开扩展自己的授权页，
  // 由页面里的真实按钮点击去申请。
  if (message?.type === OPEN_PERMISSION_TYPE) {
    if (!isOriginPattern(message.origin)) {
      sendResponse({ ok: false, error: "无效的域名" });
      return false;
    }

    chrome.tabs
      .create({
        url: chrome.runtime.getURL(
          `permissions.html?origin=${encodeURIComponent(message.origin)}`
        )
      })
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || "无法打开授权页" }));
    return true;
  }

  if (message?.type !== MESSAGE_TYPE) return undefined;

  forward(message.payload)
    .then(sendResponse)
    .catch((error) =>
      sendResponse({
        ok: false,
        reason: "internal",
        status: 0,
        error: error?.message || String(error)
      })
    );

  // 必须返回 true：异步调用 sendResponse。
  return true;
});
