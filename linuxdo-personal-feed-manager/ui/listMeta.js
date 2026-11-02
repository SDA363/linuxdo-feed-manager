(() => {
  // 列表页显示主题创建时间，并按新旧着色。
  //
  // 来源是「linux.do 小助手」的 renderTopicCreatedTimeInList() / getTopicAgeLevel()。
  // 只移植"能读到真实创建时间"的那几条来源：
  //   1. 行上的 data-created-at / data-topic-created-at（ISO 或 10/13 位时间戳）
  //   2. td.age[title] / td.activity[title] 里的「创建日期：2024年1月2日 03:04」
  // 参考脚本还会退到 data-bumped-at（最后活动时间）—— 那会把"最后回复"当成
  // "创建时间"显示，语义是错的，这里不做：读不到就不显示。
  const ROW_SELECTOR =
    "tr.topic-list-item[data-topic-id], tr.latest-topic-list-item[data-topic-id]";
  const CLASS = "ldfc-topic-created";

  function parseDate(value) {
    const text = String(value ?? "").trim();
    if (!text) return null;

    if (/^\d{13}$/.test(text)) return new Date(Number(text));
    if (/^\d{10}$/.test(text)) return new Date(Number(text) * 1000);

    const cn = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/);
    if (cn) {
      const [, year, month, day, hour, minute] = cn;
      const date = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute)
      );
      return Number.isNaN(date.getTime()) ? null : date;
    }

    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function createdAt(row) {
    for (const value of [
      row.getAttribute("data-created-at"),
      row.getAttribute("data-topic-created-at")
    ]) {
      const date = parseDate(value);
      if (date) return date;
    }

    const cell = row.querySelector(
      "td.age[title], td.activity[title], td.topic-list-data.age[title]"
    );
    const title = cell?.getAttribute("title") || "";
    const match = title.match(/创建日期[:：]\s*([^\n]+)/);
    if (!match) return null;
    return parseDate(match[1]);
  }

  function level(date) {
    const days = (Date.now() - date.getTime()) / 86400000;
    if (days > 90) return "ancient";
    if (days > 30) return "old";
    return "fresh";
  }

  function pad(value) {
    return String(value).padStart(2, "0");
  }

  function label(date) {
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
      date.getMinutes()
    )}`;
  }

  function render() {
    for (const row of document.querySelectorAll(ROW_SELECTOR)) {
      const existing = row.querySelector(`.${CLASS}`);
      const date = createdAt(row);
      // 年份明显不对（解析到 1970 / 2001 之类的误判）就当没读到。
      if (!date || date.getFullYear() < 2000) {
        existing?.remove();
        continue;
      }

      const cell = row.querySelector("td.age, td.activity, td.topic-list-data.age");
      if (!cell) {
        existing?.remove();
        continue;
      }

      let node = existing;
      if (!node) {
        node = document.createElement("span");
        node.className = CLASS;
        cell.appendChild(node);
      }
      const nextClass = `${CLASS} is-${level(date)}`;
      const nextLabel = label(date);
      const nextTitle = `创建时间：${date.toLocaleString("zh-CN")}`;
      // decorateRows 自己也挂在 MutationObserver 上：值没变就别写，
      // 否则 render → mutation → decorateRows → render 会每 100ms 空转一次。
      if (node.className !== nextClass) node.className = nextClass;
      if (node.textContent !== nextLabel) node.textContent = nextLabel;
      if (node.title !== nextTitle) node.title = nextTitle;
    }
  }

  window.LDFCListMeta = { render };
})();
