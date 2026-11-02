const endpoint = process.env.LDFC_DEBUG_URL ?? "http://127.0.0.1:9227";

async function main() {
  const versionResponse = await fetch(`${endpoint}/json/version`);
  const version = await versionResponse.json();
  const listResponse = await fetch(`${endpoint}/json/list`);
  const pages = await listResponse.json();

  console.log(JSON.stringify({
    browser: version.Browser,
    userAgent: version["User-Agent"],
    pages: pages.map((page) => ({
      id: page.id,
      type: page.type,
      url: page.url,
      title: page.title
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
