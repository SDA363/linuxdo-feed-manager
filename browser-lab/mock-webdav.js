"use strict";

// 本地 mock WebDAV：故意不返回任何 CORS 头。
//
// 用途：
//   - 证明 content script 直接 fetch 会被浏览器拦截；
//   - 证明扩展后台拿到 host 权限后可以正常读写；
//   - 支持 ETag 条件写入（If-Match / If-None-Match）与 Basic Auth。
//
// 只在测试进程内使用，不对外暴露。

const http = require("node:http");

function startMockWebDAV(options = {}) {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8124;
  // 用目录前缀而不是固定文件名：目录模式下扩展会自动拼 ld <账号>.json。
  const pathPrefix = options.pathPrefix ?? "/dav/";
  const username = options.username ?? "tester";
  const password = options.password ?? "secret";
  const expectedAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  const state = {
    body: null,
    etag: null,
    version: 0,
    requests: [],
    doc() {
      // 落盘的是 schema 4 的 gzip 二进制，JSON.parse 走不通；
      // 想拿语义文档请用 bytes() + syncModel.parseRemoteFile（验收脚本就是这么做的）。
      if (this.body === null) return null;
      try {
        return JSON.parse(Buffer.isBuffer(this.body) ? this.body.toString("utf8") : this.body);
      } catch {
        return null;
      }
    },
    bytes() {
      if (this.body === null) return null;
      return Buffer.isBuffer(this.body) ? this.body : Buffer.from(this.body, "utf8");
    },
    setDoc(value) {
      if (value === null || value === undefined) {
        this.body = null;
        this.etag = null;
        return;
      }
      this.body = Buffer.isBuffer(value)
        ? value
        : Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
      this.version += 1;
      this.etag = `"v${this.version}"`;
    }
  };

  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      const body = rawBody.toString("utf8");
      state.requests.push({
        method: request.method,
        url: request.url,
        ifMatch: request.headers["if-match"] ?? null,
        ifNoneMatch: request.headers["if-none-match"] ?? null,
        authorization: Boolean(request.headers.authorization),
        bodyLength: body.length
      });

      if (!request.url.startsWith(pathPrefix)) {
        response.writeHead(404);
        response.end("not found");
        return;
      }

      if (request.headers.authorization !== expectedAuth) {
        response.writeHead(401, { "WWW-Authenticate": 'Basic realm="ldfc"' });
        response.end("unauthorized");
        return;
      }

      if (request.method === "GET") {
        if (state.body === null) {
          response.writeHead(404, { "Content-Type": "text/plain" });
          response.end("missing");
          return;
        }
        const headers = { "Content-Type": "application/json" };
        if (state.etag) headers.ETag = state.etag;
        response.writeHead(200, headers);
        response.end(state.body);
        return;
      }

      if (request.method === "PUT") {
        const ifMatch = request.headers["if-match"];
        const ifNoneMatch = request.headers["if-none-match"];

        if (ifMatch && ifMatch !== state.etag) {
          response.writeHead(412);
          response.end("precondition failed");
          return;
        }
        if (!ifMatch && ifNoneMatch === "*" && state.body !== null) {
          response.writeHead(412);
          response.end("precondition failed");
          return;
        }

        // 只对声明为 JSON 的请求做格式校验；schema 4 是 gzip 二进制，原样接收。
        if ((request.headers["content-type"] ?? "").includes("application/json")) {
          try {
            JSON.parse(body);
          } catch {
            response.writeHead(400);
            response.end("bad json");
            return;
          }
        }

        state.body = rawBody;
        state.version += 1;
        state.etag = `"v${state.version}"`;
        response.writeHead(200, { "Content-Type": "application/json", ETag: state.etag });
        response.end(JSON.stringify({ ok: true }));
        return;
      }

      response.writeHead(405);
      response.end("method not allowed");
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      resolve({
        port,
        state,
        url: `http://${host}:${port}${pathPrefix}`,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

module.exports = { startMockWebDAV };
