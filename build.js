// 极简构建脚本：把 src/ 下的 ESM 模块拼成单个 IIFE 脚本。
//
// 输出: dist/compiler.bundle.js
// 用法: node build.js
//
// 拼接规则（适配本项目，不是通用打包器）：
//   - 按拓扑序读入模块；
//   - 删除每行 import 语句；
//   - 把 `export class X` / `export function X` / `export const X` 中的 export 关键字去掉；
//   - 把 `export { a, b as c };` 转换成空字符串；
//   - 整体包进一个 IIFE，最后调用 setupUi() 启动；
//
// 这种做法假设：模块间没有名字冲突（本项目里所有顶层标识符都是唯一的）。

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 按依赖顺序排列：被依赖者在前。
const MODULE_ORDER = [
  "src/types.js",
  "src/lexer.js",
  "src/parser.js",
  "src/semantic.js",
  "src/ir.js",
  "src/samples.js",
  "src/compile.js",
  "src/ui.js",
  // src/main.js 单独处理（只用于触发 setupUi）
];

function stripImports(source) {
  // 删除多行 import { a, b } from "..."; 形式。
  return source.replace(/^\s*import\s+\{[\s\S]*?\}\s+from\s+["'][^"']+["'];?\s*$/gm, "");
}

function stripExports(source) {
  return source
    // export class Foo -> class Foo
    .replace(/^export\s+class\s+/gm, "class ")
    // export function Foo -> function Foo
    .replace(/^export\s+function\s+/gm, "function ")
    // export const Foo -> const Foo
    .replace(/^export\s+const\s+/gm, "const ")
    // export { a, b as c }; -> (空行)
    .replace(/^export\s+\{[^}]*\};?\s*$/gm, "");
}

async function main() {
  const chunks = [];
  chunks.push("// AUTO-GENERATED bundle. Do not edit. Run `node build.js` to regenerate.");
  chunks.push("// 该文件由 src/ 下的 ES Module 自动拼接生成，用于让 file:// 协议下双击 index.html 也能运行。");
  chunks.push("(function () {");
  chunks.push('"use strict";');

  for (const rel of MODULE_ORDER) {
    const absolutePath = resolve(__dirname, rel);
    const source = await readFile(absolutePath, "utf8");
    chunks.push(`\n// ===== ${rel} =====`);
    chunks.push(stripExports(stripImports(source)).trim());
  }

  // 启动逻辑：DOM 就绪后调用 setupUi。
  chunks.push(`
// ===== bootstrap =====
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupUi);
} else {
  setupUi();
}
`);
  chunks.push("})();");

  const outDir = resolve(__dirname, "dist");
  await mkdir(outDir, { recursive: true });
  const outPath = resolve(outDir, "compiler.bundle.js");
  await writeFile(outPath, chunks.join("\n") + "\n", "utf8");
  console.log(`bundle written: ${outPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});