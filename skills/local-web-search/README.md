# local-web-search

面向 Pi 的本地浏览器网络搜索 Skill。主 Agent 自动判断是否需要联网，并通过独立 `pi --print` 子进程完成"搜索、阅读、核实、总结"。

## 特点

- 无 MCP Server、无常驻服务
- Chrome 自动发现，Edge 自动降级
- 可选显式浏览器路径，但不要求环境变量
- 独立临时 Profile，不读取个人 Cookie
- 子 Agent 隔离网页正文，减少主会话上下文污染
- Bing 搜索、Readability 正文提取、Markdown 转换

## 安装依赖

```bash
cd skills/local-web-search
npm install --ignore-scripts
```

## 构建打包

将 readability、turndown 等库打包到 `dist/`，运行时只需 playwright-core + jsdom：

```bash
npm run build
```

## 部署到全局 Skills 目录

```bash
python scripts/deploy.py
# 或指定目标路径：
python scripts/deploy.py --destination /path/to/target/local-web-search
```

部署后目标目录体积约 30 MB（主要是 playwright-core + jsdom），相比完整 node_modules 的 50 MB 减少 ~40%。

`playwright-core` 不会下载额外浏览器，直接使用本机 Chrome 或 Edge。

## 浏览器诊断

```bash
npm run browser:check
```

## 最小搜索测试

```bash
node scripts/search-bing.mjs --query "Microsoft official site" --max-results 3
```

## 完整采集测试

```bash
node scripts/research.mjs --query "Node.js latest LTS official" --max-results 5 --read 2
```

## 启动搜索子 Agent

```bash
python scripts/run-search-subagent.py --query "Node.js 当前最新 LTS 版本是什么？请引用官方来源"
```

## 浏览器选择

默认顺序：

1. 可选命令行参数 `--browser-path`
2. Playwright `chrome` channel
3. Playwright `msedge` channel
4. Windows 注册表和常见安装目录

可使用 `--browser chrome` 或 `--browser edge` 调整优先顺序，但仍会在首选浏览器不可用时降级。技能不读取任何浏览器路径或浏览器偏好环境变量。
