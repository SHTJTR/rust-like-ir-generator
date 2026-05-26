// 编译入口：将词法、语法、语义阶段串起来，输出统一的结果对象。
// 与初版的区别：词法、语法的多条错误会全部收集进 diagnostics，而不是只报第一条。

import { Lexer, CompileError } from "./lexer.js";
import { Parser } from "./parser.js";
import { SemanticAnalyzer } from "./semantic.js";

export function compile(source) {
  const result = {
    ok: false,
    tokens: [],
    ast: null,
    diagnostics: [],
    quads: [],
    symbols: [],
  };

  try {
    // 词法阶段：内部已经做了错误恢复，errors 数组里有未能识别的字符。
    const lexer = new Lexer(source);
    const tokens = lexer.tokenize();
    result.tokens = tokens.filter((token) => token.type !== "eof");
    for (const error of lexer.errors) {
      result.diagnostics.push(toDiagnostic(error));
    }

    // 语法阶段：内部 panic-mode 恢复，errors 数组里有所有语法错误。
    const parser = new Parser(tokens);
    const ast = parser.parseProgram();
    result.ast = ast;
    for (const error of parser.errors) {
      result.diagnostics.push(toDiagnostic(error));
    }

    // 即使存在语法错误，只要 AST 非空仍尝试语义分析，
    // 这样用户能一次看到尽量多的诊断信息。
    const semantic = new SemanticAnalyzer(ast).analyze();
    for (const diag of semantic.diagnostics) {
      result.diagnostics.push(diag);
    }
    result.quads = semantic.quads;
    result.symbols = semantic.symbols;

    result.ok = !result.diagnostics.some((item) => item.severity === "error");
  } catch (error) {
    if (error instanceof CompileError) {
      result.diagnostics.push(toDiagnostic(error));
    } else {
      result.diagnostics.push({
        severity: "error",
        phase: "internal",
        message: error && error.message ? error.message : String(error),
        line: 1,
        column: 1,
      });
    }
  }
  return result;
}

function toDiagnostic(error) {
  return {
    severity: "error",
    phase: error.phase || "syntax",
    message: error.message,
    line: error.line || 1,
    column: error.column || 1,
  };
}