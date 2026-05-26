// UI 层：监听编辑器、运行编译、渲染各个面板。
// 与初版相比的新功能：
//   1. 编辑器加行号显示；
//   2. 诊断条目点击可跳转到对应源码行；
//   3. 四元式视图支持「列表」与「基本块」两种模式；
//   4. Token / IR / 符号表支持导出为 TXT 或 JSON。

import { compile } from "./compile.js";
import { SAMPLE_PROGRAMS } from "./samples.js";
import { typeToString } from "./types.js";
import { buildBasicBlocks, formatQuadsAsText } from "./ir.js";

const state = {
  lastResult: null,
  quadView: "list", // "list" | "blocks"
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderDiagnostics(result) {
  if (result.diagnostics.length === 0) {
    return `<div class="diagnostic info"><div class="diagnostic-title">编译通过</div><div class="diagnostic-meta">未发现词法、语法或基础语义错误。</div></div>`;
  }
  // 按行号排序，方便用户阅读。
  const sorted = [...result.diagnostics].sort((a, b) => {
    if (a.line !== b.line) return a.line - b.line;
    return a.column - b.column;
  });
  return sorted
    .map(
      (diag) => `<div class="diagnostic ${diag.severity}" data-line="${diag.line}" data-column="${diag.column}" role="button" tabindex="0" title="点击跳转到第 ${diag.line} 行">
        <div class="diagnostic-title">${escapeHtml(diag.message)}</div>
        <div class="diagnostic-meta">${escapeHtml(diag.phase)} · line ${diag.line}, col ${diag.column} · ${escapeHtml(diag.severity)}</div>
      </div>`
    )
    .join("");
}

function renderQuadsList(quads) {
  if (quads.length === 0) return `<div class="empty-state">暂无四元式。请先修正语法错误。</div>`;
  return `<table>
    <thead><tr><th>#</th><th>op</th><th>arg1</th><th>arg2</th><th>result</th></tr></thead>
    <tbody>${quads
      .map(
        (quad) => `<tr class="quad-row ${quadRowClass(quad)}">
          <td>${quad.index}</td>
          <td><code>${escapeHtml(quad.op)}</code></td>
          <td><code>${escapeHtml(quad.arg1)}</code></td>
          <td><code>${escapeHtml(quad.arg2)}</code></td>
          <td><code>${escapeHtml(quad.result)}</code></td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function quadRowClass(quad) {
  if (quad.op === "LABEL") return "row-label";
  if (quad.op === "FUNC" || quad.op === "END") return "row-func";
  if (quad.op === "GOTO" || quad.op === "IF_FALSE") return "row-jump";
  if (quad.op === "RETURN") return "row-return";
  return "";
}

function renderQuadsBlocks(quads) {
  if (quads.length === 0) return `<div class="empty-state">暂无四元式。请先修正语法错误。</div>`;
  const blocks = buildBasicBlocks(quads);
  return blocks
    .map((block) => {
      const head = block.functionName
        ? `function ${block.functionName}`
        : block.label
        ? `block @${block.label}`
        : `block #${block.id}`;
      return `<div class="basic-block">
        <div class="basic-block-head">B${block.id} · ${escapeHtml(head)} · [${block.start}, ${block.end}]</div>
        <table>
          <thead><tr><th>#</th><th>op</th><th>arg1</th><th>arg2</th><th>result</th></tr></thead>
          <tbody>${block.quads
            .map(
              (quad) => `<tr class="quad-row ${quadRowClass(quad)}">
                <td>${quad.index}</td>
                <td><code>${escapeHtml(quad.op)}</code></td>
                <td><code>${escapeHtml(quad.arg1)}</code></td>
                <td><code>${escapeHtml(quad.arg2)}</code></td>
                <td><code>${escapeHtml(quad.result)}</code></td>
              </tr>`
            )
            .join("")}</tbody>
        </table>
      </div>`;
    })
    .join("");
}

function renderQuads(result) {
  const toolbar = `<div class="view-toolbar" role="tablist">
    <button type="button" class="view-button ${state.quadView === "list" ? "active" : ""}" data-view="list">列表</button>
    <button type="button" class="view-button ${state.quadView === "blocks" ? "active" : ""}" data-view="blocks">基本块</button>
    <span class="spacer"></span>
    <button type="button" class="view-button" data-action="export-ir">导出为 TXT</button>
  </div>`;
  const body = state.quadView === "blocks" ? renderQuadsBlocks(result.quads) : renderQuadsList(result.quads);
  return toolbar + body;
}

function renderSymbols(result) {
  if (result.symbols.length === 0) return `<div class="empty-state">暂无符号表。</div>`;
  return `<table>
    <thead><tr><th>名称</th><th>IR 名</th><th>作用域</th><th>类别</th><th>类型</th><th>属性</th><th>位置</th></tr></thead>
    <tbody>${result.symbols
      .map(
        (symbol) => `<tr data-line="${symbol.line}" data-column="${symbol.column}">
          <td>${escapeHtml(symbol.name)}</td>
          <td><code>${escapeHtml(symbol.place)}</code></td>
          <td>${escapeHtml(symbol.scope)}</td>
          <td>${escapeHtml(symbol.kind)}</td>
          <td><code>${escapeHtml(typeToString(symbol.type))}</code></td>
          <td><span class="badge">${symbol.mutable ? "mut" : "immutable"}</span> ${symbol.initialized ? "已赋值" : "未赋值"}</td>
          <td>${symbol.line}:${symbol.column}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function renderTokens(result) {
  if (result.tokens.length === 0) return `<div class="empty-state">暂无 Token。</div>`;
  return `<table>
    <thead><tr><th>#</th><th>类型</th><th>文本</th><th>位置</th></tr></thead>
    <tbody>${result.tokens
      .map(
        (token, index) => `<tr data-line="${token.line}" data-column="${token.column}">
          <td>${index}</td>
          <td>${escapeHtml(token.type)}</td>
          <td><code>${escapeHtml(token.text)}</code></td>
          <td>${token.line}:${token.column}</td>
        </tr>`
      )
      .join("")}</tbody>
  </table>`;
}

function renderAst(result) {
  if (!result.ast) return `<div class="empty-state">语法树将在语法分析成功后显示。</div>`;
  return `<pre>${escapeHtml(JSON.stringify(result.ast, null, 2))}</pre>`;
}

// 根据 textarea 内容刷新行号区域。
function updateLineNumbers(textarea, gutter) {
  const lineCount = textarea.value.split("\n").length || 1;
  const lines = [];
  for (let i = 1; i <= lineCount; i += 1) lines.push(i);
  gutter.textContent = lines.join("\n");
  gutter.scrollTop = textarea.scrollTop;
}

// 把光标定位到指定行列，便于诊断跳转。
function jumpToLine(textarea, line, column) {
  const lines = textarea.value.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(line - 1, lines.length); i += 1) {
    offset += lines[i].length + 1; // +1 for '\n'
  }
  offset += Math.max(0, (column || 1) - 1);
  textarea.focus();
  textarea.setSelectionRange(offset, offset);
  // 让光标处可见。
  const approxLineHeight = 22;
  textarea.scrollTop = Math.max(0, (line - 3) * approxLineHeight);
}

function downloadText(filename, content) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function setupUi() {
  const sourceInput = document.getElementById("sourceInput");
  const gutter = document.getElementById("lineNumbers");
  const compileBtn = document.getElementById("compileBtn");
  const clearBtn = document.getElementById("clearBtn");
  const loadSampleBtn = document.getElementById("loadSampleBtn");
  const sampleSelect = document.getElementById("sampleSelect");
  const diagCount = document.getElementById("diagCount");
  const quadCount = document.getElementById("quadCount");
  const symbolCount = document.getElementById("symbolCount");

  for (const [index, sample] of SAMPLE_PROGRAMS.entries()) {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = sample.name;
    sampleSelect.appendChild(option);
  }

  function runCompile() {
    const result = compile(sourceInput.value);
    state.lastResult = result;
    diagCount.textContent = String(result.diagnostics.length);
    quadCount.textContent = String(result.quads.length);
    symbolCount.textContent = String(result.symbols.length);
    document.getElementById("diagnostics").innerHTML = renderDiagnostics(result);
    document.getElementById("quads").innerHTML = renderQuads(result);
    document.getElementById("symbols").innerHTML = renderSymbols(result);
    document.getElementById("tokens").innerHTML = renderTokens(result);
    document.getElementById("ast").innerHTML = renderAst(result);
  }

  loadSampleBtn.addEventListener("click", () => {
    sourceInput.value = SAMPLE_PROGRAMS[Number(sampleSelect.value)].code;
    updateLineNumbers(sourceInput, gutter);
    runCompile();
  });
  compileBtn.addEventListener("click", runCompile);
  clearBtn.addEventListener("click", () => {
    sourceInput.value = "";
    updateLineNumbers(sourceInput, gutter);
    runCompile();
    sourceInput.focus();
  });

  sourceInput.addEventListener("input", () => updateLineNumbers(sourceInput, gutter));
  sourceInput.addEventListener("scroll", () => {
    gutter.scrollTop = sourceInput.scrollTop;
  });
  sourceInput.addEventListener("keydown", (event) => {
    if (event.key === "Tab") {
      event.preventDefault();
      const start = sourceInput.selectionStart;
      const end = sourceInput.selectionEnd;
      sourceInput.value = `${sourceInput.value.slice(0, start)}    ${sourceInput.value.slice(end)}`;
      sourceInput.selectionStart = sourceInput.selectionEnd = start + 4;
      updateLineNumbers(sourceInput, gutter);
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      runCompile();
    }
  });

  document.querySelectorAll(".tab").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.remove("active"));
      document.querySelectorAll(".tab-body").forEach((body) => body.classList.remove("active"));
      button.classList.add("active");
      document.getElementById(button.dataset.tab).classList.add("active");
    });
  });

  // 诊断面板：点击跳转到对应源代码行。
  document.getElementById("diagnostics").addEventListener("click", (event) => {
    const card = event.target.closest(".diagnostic");
    if (!card) return;
    const line = Number(card.dataset.line);
    const column = Number(card.dataset.column);
    if (line) jumpToLine(sourceInput, line, column);
  });
  document.getElementById("diagnostics").addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const card = event.target.closest(".diagnostic");
    if (!card) return;
    event.preventDefault();
    const line = Number(card.dataset.line);
    const column = Number(card.dataset.column);
    if (line) jumpToLine(sourceInput, line, column);
  });

  // Token / 符号表行点击也跳转。
  for (const id of ["tokens", "symbols"]) {
    document.getElementById(id).addEventListener("click", (event) => {
      const row = event.target.closest("tr[data-line]");
      if (!row) return;
      const line = Number(row.dataset.line);
      const column = Number(row.dataset.column);
      if (line) jumpToLine(sourceInput, line, column);
    });
  }

  // 四元式视图切换 + 导出。
  document.getElementById("quads").addEventListener("click", (event) => {
    const target = event.target.closest("[data-view], [data-action]");
    if (!target) return;
    if (target.dataset.view) {
      state.quadView = target.dataset.view;
      document.getElementById("quads").innerHTML = renderQuads(state.lastResult || { quads: [] });
    } else if (target.dataset.action === "export-ir") {
      if (!state.lastResult || state.lastResult.quads.length === 0) return;
      downloadText("ir.txt", formatQuadsAsText(state.lastResult.quads));
    }
  });

  sourceInput.value = SAMPLE_PROGRAMS[0].code;
  updateLineNumbers(sourceInput, gutter);
  runCompile();
}