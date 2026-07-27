#!/usr/bin/env node

/**
 * 使用 esbuild 将所有入口脚本及依赖打包到 dist/ 目录。
 * 打包后的脚本只需 Node.js 运行时，不再需要 node_modules。
 */

import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, "..");
const distDir = path.join(skillRoot, "dist");

// 清理旧产物
rmSync(distDir, { recursive: true, force: true });
mkdirSync(distDir, { recursive: true });

const entryPoints = [
  path.join(__dirname, "research.mjs"),
  path.join(__dirname, "search-bing.mjs"),
  path.join(__dirname, "read-page.mjs"),
  path.join(__dirname, "browser-check.mjs"),
];

try {
  const result = await build({
    entryPoints,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "esm",
    outdir: distDir,
    // 保持文件名不带 hash
    entryNames: "[name]",
    // playwright-core 和 jsdom 内部有动态 require，无法在 ESM 中正确打包
    // 保留为外部依赖，运行时从相邻 node_modules 加载
    external: ["playwright-core", "jsdom"],
    // 注入 CJS 兼容 shim（为 @mozilla/readability 等 CJS 包提供 require）
    inject: [path.join(__dirname, "cjs-shim.mjs")],
    // 源码映射便于调试
    sourcemap: false,
    // 压缩减小体积
    minify: true,
    // 保持顶层 await
    supported: { "top-level-await": true },
  });

  if (result.errors.length > 0) {
    console.error("构建失败：", result.errors);
    process.exit(1);
  }

  // 报告产物大小
  const { readdirSync, statSync } = await import("node:fs");
  const files = readdirSync(distDir);
  let totalSize = 0;
  for (const file of files) {
    const size = statSync(path.join(distDir, file)).size;
    totalSize += size;
    console.log(`  ${file}: ${(size / 1024).toFixed(1)} KB`);
  }
  console.log(`\n总计: ${(totalSize / 1024).toFixed(1)} KB`);
  console.log(`产物目录: ${distDir}`);
} catch (error) {
  console.error("构建出错：", error.message || error);
  process.exit(1);
}
