const debuggerUrl = process.env.LDFC_DEBUG_URL ?? "http://127.0.0.1:9227";

async function main() {
  const versionResponse = await fetch(`${debuggerUrl}/json/version`);
  const version = await versionResponse.json();
  const listResponse = await fetch(`${debuggerUrl}/json/list`);
  const pages = await listResponse.json();
  const page = pages.find((item) => item.type === "page");

  if (!page) {
    throw new Error("没有找到可用的浏览器页面");
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "({url:location.href,title:document.title,readyState:document.readyState,nav:!!document.querySelector('#ldfc-navigation'),panel:!!document.querySelector('#ldfc-panel'),rows:document.querySelectorAll('.topic-list-item[data-topic-id],.latest-topic-list-item[data-topic-id]').length,state:!!window.LDFCTopicState,challenge:!!document.querySelector('input[name=cf-turnstile-response],iframe[src*=challenges]')})" } }));
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id === 1) {
      console.log(JSON.stringify(message.result?.result?.value ?? message, null, 2));
      socket.close();
    }
  });
  socket.addEventListener("error", (error) => {
    console.error(error);
    process.exitCode = 1;
  });
  setTimeout(() => {
    console.error("等待 CDP（浏览器调试协议）响应超时");
    socket.close();
    process.exitCode = 1;
  }, 10000);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
