"use strict";

// WebDAV 传输层单测（纯 Node，不联网）：用假 request 验证它与
// background 之间的协议、错误映射和 ETag 传递；另起一个带
// GM_xmlhttpRequest 的沙箱验证油猴后端。
//
// 用法：node tools/test-webdav-transport.js

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "..");
const FILE = path.join(ROOT, "linuxdo-personal-feed-manager", "sync", "webdavTransport.js");

// 传输层收发的是文件字节，base64 只在 content ↔ background 之间用，
// 所以沙箱里必须提供 btoa / atob。
const sandbox = { window: {}, console, btoa, atob };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(FILE, "utf8"), sandbox, { filename: FILE });

const { createTransport } = sandbox.window.LDFCWebDAV;

const results = [];
const check = (ok, message) => {
  results.push(`${ok ? "PASS" : "FAIL"}：${message}`);
  return ok;
};

function build(response, overrides = {}) {
  const calls = [];
  const transport = createTransport({
    url: overrides.url ?? "https://dav.example.com/dav/ldfc.json",
    username: overrides.username ?? "alice",
    password: overrides.password ?? "app-password",
    request: async (payload) => {
      calls.push(payload);
      return typeof response === "function" ? response(payload) : response;
    }
  });
  return { transport, calls };
}

async function expectError(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

async function main() {
  // ---- read ----
  {
    const { transport, calls } = build({ ok: true, status: 404, bodyBase64: "", etag: null });
    const result = await transport.read();
    check(result.bytes === null && result.etag === null, "404：视为远端还没有文件");
    check(calls[0].method === "read" && calls[0].username === "alice", "read 请求带 method 与账号");
  }

  {
    const text = '{"schema":1,"topics":[]}';
    const { transport } = build({
      ok: true,
      status: 200,
      bodyBase64: Buffer.from(text, "utf8").toString("base64"),
      etag: '"v3"'
    });
    const result = await transport.read();
    const decoded = Buffer.from(result.bytes).toString("utf8");
    check(decoded === text && result.etag === '"v3"', "200：原样交出文件字节并保留 ETag");
  }

  {
    const { transport } = build({ ok: true, status: 200, bodyBase64: "", etag: null });
    check((await transport.read()).bytes === null, "200 空文件：视为空");
  }

  {
    // 传输层不再解析内容：格式校验搬到了 syncModel.parseRemoteFile。
    const text = "{not json";
    const { transport } = build({
      ok: true,
      status: 200,
      bodyBase64: Buffer.from(text, "utf8").toString("base64"),
      etag: null
    });
    const result = await transport.read();
    check(Buffer.from(result.bytes).toString("utf8") === text, "坏内容原样传出，解析交给上层");
  }

  {
    const { transport } = build({ ok: false, reason: "auth", status: 401, error: "认证失败（401/403）" });
    const error = await expectError(transport.read());
    check(error?.reason === "auth" && error?.status === 401, "认证失败：reason/status 透传");
  }

  // ---- write ----
  {
    const { transport, calls } = build({ ok: true, status: 200, etag: '"v4"' });
    const bytes = new Uint8Array([0x1f, 0x8b, 0x08, 0x00]);
    const result = await transport.write(bytes, '"v3"');
    check(result.etag === '"v4"', "write 返回新 ETag");
    check(calls[0].method === "write" && calls[0].etag === '"v3"', "write 带 If-Match 所需的 ETag");
    check(
      calls[0].bodyBase64 === Buffer.from(bytes).toString("base64"),
      "write 按 base64 交给后台（落盘仍是原始字节）"
    );
    check(calls[0].contentType === "application/gzip", "write 声明 application/gzip");
  }

  {
    const { transport, calls } = build({ ok: true, status: 200, etag: '"v1"' });
    await transport.write(new Uint8Array([1, 2, 3]), null);
    check(calls[0].etag === null, "首次写入不带 ETag（后台用 If-None-Match: *）");
  }

  {
    const { transport } = build({ ok: false, reason: "conflict", status: 412, error: "远端文件已被其他设备修改" });
    const error = await expectError(transport.write(new Uint8Array([1]), '"old"'));
    check(error?.conflict === true && error?.status === 412, "412：抛出 conflict 错误");
  }

  {
    const { transport } = build({ ok: false, reason: "network", status: 0, error: "Failed to fetch" });
    const error = await expectError(transport.write(new Uint8Array([1]), null));
    check(error?.reason === "network", "网络失败：reason=network");
  }

  // ---- test ----
  {
    const { transport } = build({ ok: true, status: 404, body: "", etag: null });
    const result = await transport.test();
    check(result.status === 404 && result.exists === false, "test：404 表示地址可达但还没有文件");
  }

  {
    const { transport } = build({ ok: true, status: 200, body: "{}", etag: '"v1"' });
    check((await transport.test()).exists === true, "test：200 表示文件已存在");
  }

  // ---- 入参 ----
  {
    let threw = false;
    try {
      createTransport({ request: async () => ({}) });
    } catch {
      threw = true;
    }
    check(threw, "缺少 WebDAV 地址：直接拒绝创建");
  }

  {
    const { transport } = build(() => undefined);
    const error = await expectError(transport.read());
    check(Boolean(error), "后台没有返回有效响应：抛出错误");
  }

  // ---- 后端探测：主沙箱里既没有 chrome 也没有 GM ----
  {
    check(
      sandbox.window.LDFCWebDAV.backend() === "none",
      "没有扩展后台也没有 GM：backend() 返回 none"
    );
  }

  // ---- 油猴后端：GM_xmlhttpRequest ----
  // 每个用例用独立沙箱：GM 是脚本启动时探测的，混用会互相污染。
  function gmSandbox(handler) {
    const calls = [];
    const context = {
      window: {},
      console,
      btoa,
      atob,
      TextEncoder,
      GM_xmlhttpRequest: (options) => {
        calls.push(options);
        handler(options);
      }
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(FILE, "utf8"), context, { filename: FILE });
    return { api: context.window.LDFCWebDAV, calls };
  }

  {
    const { api } = gmSandbox(() => {});
    check(api.backend() === "gm", "只有 GM_xmlhttpRequest：backend() 返回 gm");

    const transport = api.createTransport({
      url: "https://dav.example.com/dav/ldfc.json",
      username: "alice",
      password: "app-password"
    });
    check(typeof transport.read === "function", "GM 环境：不依赖 chrome 也能建出 transport");
  }

  {
    const body = Buffer.from('{"schema":5,"topics":[]}', "utf8");
    const { api, calls } = gmSandbox((options) => {
      options.onload({
        status: 200,
        responseHeaders: 'Content-Type: application/gzip\r\nETag: "v7"\r\n',
        response: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      });
    });
    const transport = api.createTransport({
      url: "https://dav.example.com/dav/ldfc.json",
      username: "alice",
      password: "应用密码"
    });
    const result = await transport.read();

    check(
      Buffer.from(result.bytes).toString("utf8") === '{"schema":5,"topics":[]}',
      "GM read：arraybuffer 原样还原成字节"
    );
    check(result.etag === '"v7"', "GM read：从 responseHeaders 解析 ETag（大小写不敏感）");
    check(
      calls[0].method === "GET" && calls[0].responseType === "arraybuffer",
      "GM read：GET + responseType=arraybuffer"
    );
    check(
      calls[0].headers.Authorization ===
        `Basic ${Buffer.from("alice:应用密码", "utf8").toString("base64")}`,
      "GM read：Authorization 按 UTF-8 编码（中文密码不乱码）"
    );
  }

  {
    const { api, calls } = gmSandbox((options) => {
      options.onload({ status: 201, responseHeaders: 'etag: "v8"\r\n', response: new ArrayBuffer(0) });
    });
    const transport = api.createTransport({
      url: "https://dav.example.com/dav/ldfc.json",
      username: "alice",
      password: "p"
    });
    const result = await transport.write(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]), '"v7"');

    check(result.etag === '"v8"', "GM write：返回新 ETag");
    check(
      calls[0].method === "PUT" && calls[0].headers["If-Match"] === '"v7"',
      "GM write：PUT + If-Match"
    );
    check(
      calls[0].headers["Content-Type"] === "application/gzip",
      "GM write：Content-Type 为 application/gzip"
    );
    check(
      Buffer.from(calls[0].data).toString("hex") === "1f8b0800",
      "GM write：请求体是原始字节（不是 base64 文本）"
    );
  }

  {
    const { api, calls } = gmSandbox((options) => {
      options.onload({ status: 201, responseHeaders: "", response: new ArrayBuffer(0) });
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    await transport.write(new Uint8Array([1, 2, 3]), null);
    check(calls[0].headers["If-None-Match"] === "*", "GM write 首次：用 If-None-Match: * 防并发创建");
  }

  {
    const { api } = gmSandbox((options) => {
      options.onload({ status: 404, responseHeaders: "", response: new ArrayBuffer(0) });
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    const result = await transport.read();
    check(result.bytes === null && result.etag === null, "GM read 404：视为远端还没有文件");
  }

  {
    const { api } = gmSandbox((options) => {
      options.onload({ status: 404, responseHeaders: "", response: new ArrayBuffer(0) });
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    const result = await transport.test();
    check(result.status === 404 && result.exists === false, "GM test：404 表示地址可达但还没有文件");
  }

  {
    const { api } = gmSandbox((options) => {
      options.onload({ status: 401, responseHeaders: "", response: new ArrayBuffer(0) });
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    const error = await expectError(transport.read());
    check(error?.reason === "auth" && error?.status === 401, "GM 401：reason=auth（与扩展端一致）");
  }

  {
    const { api } = gmSandbox((options) => {
      options.onload({ status: 412, responseHeaders: "", response: new ArrayBuffer(0) });
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    const error = await expectError(transport.write(new Uint8Array([1]), '"old"'));
    check(error?.conflict === true && error?.status === 412, "GM write 412：抛出 conflict");
  }

  {
    const { api } = gmSandbox((options) => {
      options.onerror({ error: "net::ERR_CONNECTION_REFUSED" });
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    const error = await expectError(transport.read());
    check(error?.reason === "network", "GM onerror：reason=network");
  }

  {
    const { api } = gmSandbox((options) => {
      options.ontimeout();
    });
    const transport = api.createTransport({ url: "https://dav.example.com/x.json" });
    const error = await expectError(transport.read());
    check(error?.reason === "network" && /超时/.test(error.message), "GM ontimeout：按网络错误上报");
  }

  console.log("===== WebDAV 传输层单测 =====");
  for (const line of results) console.log(line);
  const failed = results.filter((line) => line.startsWith("FAIL")).length;
  console.log(`\n汇总：${results.length - failed} 项通过，${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error("测试脚本异常：", error);
  process.exit(1);
});
