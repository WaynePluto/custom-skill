// esbuild inject: 为 ESM 输出中 CJS 遗留代码提供 require 函数
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
var require = createRequire(import.meta.url);
export { __filename, __dirname, require };
