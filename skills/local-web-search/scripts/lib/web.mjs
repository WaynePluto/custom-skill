import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export function assertWebUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`URL 无效：${value}`);
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`只允许 http/https URL：${value}`);
  }
  return parsed.toString();
}

function normalizeWhitespace(markdown) {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlToMarkdown(html) {
  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });
  turndown.use(gfm);
  turndown.remove(["script", "style", "noscript", "iframe", "svg"]);
  return normalizeWhitespace(turndown.turndown(html));
}

export async function searchBing(context, query, {
  maxResults = 8,
  international = true,
  timeoutMs = 15_000,
} = {}) {
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    const searchUrl = new URL(international ? "https://www.bing.com/search" : "https://cn.bing.com/search");
    searchUrl.searchParams.set("q", query);
    searchUrl.searchParams.set("count", String(maxResults));
    if (international) searchUrl.searchParams.set("ensearch", "1");

    const response = await page.goto(searchUrl.toString(), {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });

    await page.waitForSelector("li.b_algo", { timeout: Math.min(timeoutMs, 10_000) });

    const results = await page.evaluate(limit => {
      const collected = [];
      for (const element of document.querySelectorAll("li.b_algo")) {
        const anchor = element.querySelector("h2 a");
        if (!(anchor instanceof HTMLAnchorElement)) continue;
        const url = anchor.href;
        if (!url || url.startsWith("javascript:") || url.includes("/aclk?")) continue;
        const snippetElement = element.querySelector(".b_caption p, p");
        collected.push({
          title: anchor.textContent?.trim() || "",
          url,
          snippet: snippetElement?.textContent?.trim() || "",
        });
        if (collected.length >= limit) break;
      }
      return collected;
    }, maxResults);

    return {
      query,
      searchUrl: page.url(),
      status: response?.status(),
      results,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function readWebPage(context, inputUrl, {
  timeoutMs = 20_000,
  maxChars = 10_000,
} = {}) {
  const url = assertWebUrl(inputUrl);
  const page = await context.newPage();
  page.setDefaultTimeout(timeoutMs);

  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: timeoutMs,
    });
    await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => {});

    const contentType = response?.headers()["content-type"] || "";
    if (contentType && !contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error(`不支持的网页内容类型：${contentType}`);
    }

    const finalUrl = page.url();
    const html = await page.content();
    const document = new JSDOM(html, { url: finalUrl }).window.document;
    const article = new Readability(document).parse();

    let title = article?.title || (await page.title()) || finalUrl;
    let markdown = article?.content ? htmlToMarkdown(article.content) : "";

    if (!markdown || markdown.length < 100) {
      const fallbackDocument = new JSDOM(html, { url: finalUrl }).window.document;
      fallbackDocument
        .querySelectorAll("script, style, noscript, nav, header, footer, aside, iframe, svg")
        .forEach(element => element.remove());
      const main =
        fallbackDocument.querySelector("main, article, [role='main'], .content, #content") ||
        fallbackDocument.body;
      markdown = htmlToMarkdown(main?.innerHTML || "");
    }

    const originalChars = markdown.length;
    if (markdown.length > maxChars) {
      markdown = `${markdown.slice(0, maxChars)}\n\n[正文已截断，原始字符数：${originalChars}]`;
    }

    return {
      title: title.trim(),
      url: finalUrl,
      status: response?.status(),
      contentType,
      originalChars,
      markdown,
    };
  } finally {
    await page.close().catch(() => {});
  }
}
