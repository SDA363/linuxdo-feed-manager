(() => {
  // WebDAV 传输层：把"读写一个 JSON 文件"翻译成后台消息。
  //
  // 真正的 fetch 在 background/service-worker.js 里执行：
  // MV3 的 content script 受页面 CORS 限制，而 WebDAV 服务器不会给
  // linux.do 发 CORS 头，直接在这里 fetch 必然失败。
  //
  // 对外契约与 syncService 的 transport 一致，但收发的是**字节**：
  //   read()             → { bytes: Uint8Array | null, etag }
  //   write(bytes, etag) → { etag }
  //   冲突时抛出 error.conflict = true。
  //
  // 为什么是字节而不是 JSON 对象：schema 4 的文件本体是 gzip 二进制，
  // 套 base64 会白多占 33%。消息通道仍然是 JSON，所以 base64 只在
  // content script ↔ background 这一段用，落盘的是原始字节。
  //
  // 第二个后端：油猴脚本（Tampermonkey / Violentmonkey）。
  //   脚本没有扩展后台，但 GM_xmlhttpRequest 本身就是跨域接口，
  //   所以同一份契约再实现一遍，上层（syncService / 设置面板）完全无感。
  //   判断顺序是"有扩展后台就走扩展"，避免扩展环境里被油猴分支截走。
  const MESSAGE_TYPE = "ldfc:webdav";

  function base64ToBytes(text) {
    const binary = atob(text);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
  }

  function sendToBackground(payload) {
    return new Promise((resolve, reject) => {
      const runtime = typeof chrome !== "undefined" ? chrome.runtime : null;
      if (!runtime?.id || typeof runtime.sendMessage !== "function") {
        reject(new Error("当前环境没有扩展后台，无法访问 WebDAV"));
        return;
      }

      runtime.sendMessage({ type: MESSAGE_TYPE, payload }, (response) => {
        const lastError = runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "后台通信失败"));
          return;
        }
        resolve(response);
      });
    });
  }

  function hasExtensionRuntime() {
    const runtime = typeof chrome !== "undefined" ? chrome.runtime : null;
    return Boolean(runtime?.id && typeof runtime.sendMessage === "function");
  }

  // 扩展环境里没有这两个标识符；typeof 对未声明的名字不会抛错。
  function getGMRequest() {
    if (typeof GM_xmlhttpRequest === "function") return GM_xmlhttpRequest;
    if (typeof GM !== "undefined" && typeof GM?.xmlHttpRequest === "function") {
      return GM.xmlHttpRequest.bind(GM);
    }
    return null;
  }

  function backend() {
    if (hasExtensionRuntime()) return "extension";
    if (getGMRequest()) return "gm";
    return "none";
  }

  function utf8Bytes(text) {
    return new TextEncoder().encode(String(text));
  }

  function basicAuthHeader(username, password) {
    // btoa 只吃 Latin-1，先按 UTF-8 编码再转二进制字符串（与后台实现一致）。
    const bytes = utf8Bytes(`${username}:${password}`);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `Basic ${btoa(binary)}`;
  }

  function headerValue(rawHeaders, name) {
    if (!rawHeaders) return null;
    const match = new RegExp(`^${name}:\\s*(.+)$`, "im").exec(String(rawHeaders));
    return match ? match[1].trim() : null;
  }

  function responseBytes(value) {
    if (!value) return null;
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (typeof value === "string") return utf8Bytes(value);
    // 跨 realm 的 ArrayBuffer 用 instanceof 判不出来，用 byteLength 鸭子类型。
    if (typeof value.byteLength === "number") return new Uint8Array(value);
    return null;
  }

  // 错误映射必须与 background/service-worker.js 逐条对齐：
  // 两边不一致的话，同一份配置在扩展和油猴上会得到不同的报错。
  function normalizeGMResponse(response, method) {
    const status = Number(response?.status) || 0;
    const etag = headerValue(response?.responseHeaders, "etag");
    const bytes = responseBytes(response?.response);
    // 404 的错误页不是数据，不能当正文交出去。
    const bodyBase64 = status === 404 || !bytes ? "" : bytesToBase64(bytes);

    if (status === 401 || status === 403) {
      return { ok: false, reason: "auth", status, error: "认证失败（401/403）" };
    }
    if (method === "write" && (status === 409 || status === 412)) {
      return { ok: false, reason: "conflict", status, error: "远端文件已被其他设备修改" };
    }
    if (status === 404) return { ok: true, status, bodyBase64: "", etag: null };
    if (status >= 200 && status < 300) return { ok: true, status, bodyBase64, etag };
    return { ok: false, reason: "http", status, error: `HTTP ${status}` };
  }

  function sendViaGM(payload) {
    const gm = getGMRequest();
    if (!gm) return Promise.reject(new Error("当前环境没有 GM_xmlhttpRequest，无法访问 WebDAV"));

    const headers = { Accept: "*/*" };
    if (payload.username || payload.password) {
      headers.Authorization = basicAuthHeader(payload.username ?? "", payload.password ?? "");
    }

    // 油猴这边不需要 base64 中转，直接给 Uint8Array：
    // Tampermonkey 5.4+ / Violentmonkey 2.12+ 都支持二进制请求体。
    let method = "GET";
    let data;
    if (payload.method === "write") {
      method = "PUT";
      headers["Content-Type"] = payload.contentType || "application/octet-stream";
      if (payload.etag) headers["If-Match"] = payload.etag;
      else headers["If-None-Match"] = "*";
      data = base64ToBytes(payload.bodyBase64 ?? "");
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };

      try {
        gm({
          method,
          url: payload.url,
          headers,
          data,
          responseType: "arraybuffer",
          timeout: 20000,
          onload: (response) => finish(normalizeGMResponse(response, payload.method)),
          onerror: (response) =>
            finish({
              ok: false,
              reason: "network",
              status: 0,
              error: response?.error || "网络请求失败"
            }),
          ontimeout: () => finish({ ok: false, reason: "network", status: 0, error: "请求超时" }),
          onabort: () => finish({ ok: false, reason: "network", status: 0, error: "请求已取消" })
        });
      } catch (error) {
        finish({ ok: false, reason: "network", status: 0, error: error?.message || "GM 请求失败" });
      }
    });
  }

  function defaultRequest(payload) {
    if (hasExtensionRuntime()) return sendToBackground(payload);
    if (getGMRequest()) return sendViaGM(payload);
    return Promise.reject(
      new Error("当前环境既没有扩展后台，也没有 GM_xmlhttpRequest，无法访问 WebDAV")
    );
  }

  function toError(response) {
    const error = new Error(response?.error || "WebDAV 请求失败");
    error.reason = response?.reason || "http";
    error.status = response?.status ?? 0;
    if (response?.reason === "conflict") error.conflict = true;
    return error;
  }

  function createTransport(options = {}) {
    const url = String(options.url ?? "").trim();
    const username = options.username ?? "";
    const password = options.password ?? "";
    const request = options.request ?? defaultRequest;

    if (!url) throw new Error("缺少 WebDAV 地址");

    async function send(payload) {
      const response = await request({ ...payload, url, username, password });
      if (!response || typeof response !== "object") {
        throw new Error("后台没有返回有效响应");
      }
      return response;
    }

    async function read() {
      const response = await send({ method: "read" });
      if (!response.ok) throw toError(response);

      // 文件还不存在 / 是空文件：都按"远端没有数据"处理。
      if (response.status === 404 || !response.bodyBase64) {
        return { bytes: null, etag: null };
      }
      return { bytes: base64ToBytes(response.bodyBase64), etag: response.etag ?? null };
    }

    async function write(bytes, etag) {
      const buffer = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
      const response = await send({
        method: "write",
        bodyBase64: bytesToBase64(buffer),
        contentType: "application/gzip",
        etag: etag ?? null
      });
      if (!response.ok) throw toError(response);
      return { etag: response.etag ?? null };
    }

    // 只用于设置页的"测试连接"：404 说明地址可达、只是还没有文件。
    async function test() {
      const response = await send({ method: "test" });
      if (!response.ok) throw toError(response);
      return { status: response.status, exists: response.status !== 404 };
    }

    return { read, write, test, url };
  }

  window.LDFCWebDAV = { createTransport, MESSAGE_TYPE, backend };
})();
