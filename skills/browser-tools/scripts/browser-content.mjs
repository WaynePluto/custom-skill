#!/usr/bin/env node
// 导航到 URL 并提取可读正文为 Markdown（Readability + Turndown）。

import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { connectBrowser, getActivePage } from "./lib/cdp.mjs";

const TIMEOUT = 30000;
const MAX_OUTPUT = 60 * 1024;
setTimeout(() => {
  console.error("错误：30 秒超时");
  process.exit(1);
}, TIMEOUT).unref();

const url = process.argv[2];
if (!url) {
  console.log("用法: browser-content.js <url>");
  process.exit(1);
}

const browser = await connectBrowser();
const page = getActivePage(browser);

await Promise.race([
  page.goto(url, { waitUntil: "networkidle", timeout: 15000 }),
  new Promise(r => setTimeout(r, 10000)),
]).catch(() => {});

const outerHTML = await page.content();
const finalUrl = page.url();

const doc = new JSDOM(outerHTML, { url: finalUrl });
const article = new Readability(doc.window.document).parse();

function htmlToMarkdown(html) {
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  turndown.addRule("removeEmptyLinks", {
    filter: node => node.nodeName === "A" && !node.textContent?.trim(),
    replacement: () => "",
  });
  return turndown
    .turndown(html)
    .replace(/\[\\?\[\s*\\?\]\]\([^)]*\)/g, "")
    .replace(/ +/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

let content;
if (article?.content) {
  content = htmlToMarkdown(article.content);
} else {
  const fallbackDoc = new JSDOM(outerHTML, { url: finalUrl });
  const body = fallbackDoc.window.document;
  body.querySelectorAll("script, style, noscript, nav, header, footer, aside").forEach(el => el.remove());
  const main = body.querySelector("main, article, [role='main'], .content, #content") || body.body;
  const fallbackHtml = main?.innerHTML || "";
  content = fallbackHtml.trim().length > 100 ? htmlToMarkdown(fallbackHtml) : "(无法提取正文)";
}

if (content.length > MAX_OUTPUT) {
  content = content.slice(0, MAX_OUTPUT) + "\n\n...(内容已截断)";
}

console.log(`URL: ${finalUrl}`);
if (article?.title) console.log(`Title: ${article.title}`);
console.log("");
console.log(content);

process.exit(0);
