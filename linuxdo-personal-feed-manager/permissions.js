(() => {
  const params = new URLSearchParams(location.search);
  const origin = params.get("origin") || "";
  const valid = /^https?:\/\/[^/]+\/\*$/.test(origin);

  const originElement = document.getElementById("origin");
  const statusElement = document.getElementById("status");
  const grantButton = document.getElementById("grant");
  const closeButton = document.getElementById("close");

  originElement.textContent = origin || "（缺少地址）";
  closeButton.addEventListener("click", () => window.close());

  function setStatus(text, tone = "") {
    statusElement.textContent = text;
    statusElement.dataset.tone = tone;
  }

  if (!valid) {
    grantButton.disabled = true;
    setStatus("地址无效，无法申请权限。", "error");
    return;
  }

  function check() {
    chrome.permissions.contains({ origins: [origin] }, (granted) => {
      grantButton.disabled = Boolean(granted);
      setStatus(granted ? "已授权，可以关闭本页。" : "尚未授权。", granted ? "ok" : "");
    });
  }

  check();

  grantButton.addEventListener("click", () => {
    setStatus("正在等待浏览器确认…");

    // 这里必须是真实用户点击：chrome.permissions.request 只接受用户手势。
    chrome.permissions.request({ origins: [origin] }, (granted) => {
      if (chrome.runtime.lastError) {
        setStatus(chrome.runtime.lastError.message || "授权失败", "error");
        return;
      }

      grantButton.disabled = Boolean(granted);
      setStatus(
        granted ? "已授权，可以关闭本页。" : "授权被拒绝，扩展无法访问该域名。",
        granted ? "ok" : "error"
      );
    });
  });
})();
