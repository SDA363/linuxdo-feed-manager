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
    const request = options.request ?? sendToBackground;

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

  window.LDFCWebDAV = { createTransport, MESSAGE_TYPE };
})();
