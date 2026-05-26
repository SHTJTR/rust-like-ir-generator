// 语法分析器：递归下降 + panic-mode 错误恢复。
// 与初版相比的主要差异：
//   1. 元组类型 (T, U) 严格要求逗号分隔，不再接受 (T; U)（PDF 9.1 反例）；
//   2. parseStatement 在遇到语法错误时同步到下一个 ; 或 } 后继续分析；
//   3. parseFunction 在解析失败时跳过整个函数体，保证多函数文件的其他函数依然被检查。

import { CompileError } from "./lexer.js";
import {
  TYPE_I32,
  TYPE_BOOL,
  TYPE_UNIT,
  arrayType,
  tupleType,
  refType,
} from "./types.js";

export class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.currentIndex = 0;
    // 收集语法错误，配合 panic-mode 一次性报多个。
    this.errors = [];
  }

  parseProgram() {
    const functions = [];
    while (!this.isAtEnd()) {
      try {
        functions.push(this.parseFunction());
      } catch (error) {
        if (error instanceof CompileError) {
          this.errors.push(error);
          this.synchronizeToFunction();
        } else {
          throw error;
        }
      }
    }
    return { type: "Program", functions };
  }

  // 在出错后跳到下一个 fn 关键字或文件末尾，便于继续解析后续函数。
  synchronizeToFunction() {
    while (!this.isAtEnd()) {
      if (this.peek().value === "fn") return;
      this.advance();
    }
  }

  // 在出错后跳过到下一条语句的起点：分号之后，或匹配出当前块的 }。
  synchronizeToStatement() {
    let depth = 0;
    while (!this.isAtEnd()) {
      const token = this.peek();
      if (token.value === "{") depth += 1;
      else if (token.value === "}") {
        if (depth === 0) return;
        depth -= 1;
      } else if (token.value === ";" && depth === 0) {
        this.advance();
        return;
      }
      this.advance();
    }
  }

  parseFunction() {
    const start = this.consume("fn", "函数声明应以 fn 开始");
    const name = this.consumeIdentifier("缺少函数名");
    this.consume("(", "函数名后缺少 '('");
    const params = [];
    if (!this.check(")")) {
      do {
        params.push(this.parseParam());
      } while (this.match(","));
    }
    this.consume(")", "形参列表后缺少 ')'");
    let returnType = TYPE_UNIT;
    if (this.match("->")) {
      returnType = this.parseType();
    }
    const body = this.parseBlock({ allowFinalExpr: true });
    return {
      type: "FunctionDecl",
      name: name.value,
      params,
      returnType,
      body,
      line: start.line,
      column: start.column,
    };
  }

  parseParam() {
    const mutable = this.match("mut");
    const name = this.consumeIdentifier("形参缺少标识符");
    this.consume(":", "形参缺少 ':' 类型标注");
    const paramType = this.parseType();
    return {
      type: "Param",
      name: name.value,
      mutable,
      paramType,
      line: name.line,
      column: name.column,
    };
  }

  parseType() {
    if (this.match("&")) {
      const mutable = this.match("mut");
      return refType(this.parseType(), mutable);
    }
    if (this.match("[")) {
      const element = this.parseType();
      this.consume(";", "数组类型缺少 ';'");
      const length = this.consumeNumber("数组长度必须是整数字面量");
      if (!length.isInteger || length.numericValue <= 0) {
        this.error("数组长度必须是正整数字面量", length);
      }
      this.consume("]", "数组类型缺少 ']'");
      return arrayType(element, length.numericValue);
    }
    if (this.match("(")) {
      if (this.match(")")) return TYPE_UNIT;
      const elements = [this.parseType()];
      let sawComma = false;
      // 修复：元组类型必须用逗号分隔，分号会被报错。
      // PDF 9.1 中 let b:(i32;i32;) 是反例。
      while (this.check(",")) {
        this.advance();
        sawComma = true;
        if (this.check(")")) break;
        elements.push(this.parseType());
      }
      if (this.check(";")) {
        this.error("元组类型元素之间必须使用 ',' 分隔，不能使用 ';'", this.peek());
      }
      this.consume(")", "元组类型缺少 ')'");
      // (T) 视作括号包裹的类型；(T,) 视作单元素元组；多元素自然是元组。
      if (elements.length === 1 && !sawComma) return elements[0];
      return tupleType(elements);
    }
    if (this.match("i32")) return TYPE_I32;
    if (this.match("bool")) return TYPE_BOOL;
    this.error("仅支持 i32、bool、引用、数组和元组类型", this.peek());
  }

  parseBlock(options = {}) {
    const start = this.consume("{", "语句块缺少 '{'");
    const statements = [];
    let finalExpr = null;
    while (!this.check("}") && !this.isAtEnd()) {
      try {
        const stmt = this.parseStatement(Boolean(options.allowFinalExpr));
        if (stmt.type === "FinalExpression") {
          finalExpr = stmt.expression;
          break;
        }
        statements.push(stmt);
      } catch (error) {
        if (error instanceof CompileError) {
          this.errors.push(error);
          this.synchronizeToStatement();
        } else {
          throw error;
        }
      }
    }
    this.consume("}", "语句块缺少 '}'");
    return {
      type: "Block",
      statements,
      finalExpr,
      line: start.line,
      column: start.column,
    };
  }

  parseStatement(allowFinalExpr) {
    if (this.match(";")) {
      const token = this.previous();
      return { type: "EmptyStmt", line: token.line, column: token.column };
    }
    if (this.check("let")) return this.parseLetStatement();
    if (this.check("return")) return this.parseReturnStatement();
    if (this.check("if")) return this.parseIfStatement();
    if (this.check("while")) return this.parseWhileStatement();
    if (this.check("for")) return this.parseForStatement();
    if (this.check("loop")) return this.parseLoopStatement();
    if (this.check("break")) return this.parseBreakStatement();
    if (this.check("continue")) return this.parseContinueStatement();

    const expression = this.parseExpression();
    if (this.match("=")) {
      const equals = this.previous();
      const value = this.parseExpression();
      this.consume(";", "赋值语句缺少 ';'");
      return {
        type: "AssignStmt",
        target: expression,
        value,
        line: equals.line,
        column: equals.column,
      };
    }
    if (this.match(";")) {
      return {
        type: "ExprStmt",
        expression,
        line: expression.line,
        column: expression.column,
      };
    }
    if (allowFinalExpr && this.check("}")) {
      return {
        type: "FinalExpression",
        expression,
        line: expression.line,
        column: expression.column,
      };
    }
    if (expression.type === "BlockExpression") {
      return {
        type: "ExprStmt",
        expression,
        line: expression.line,
        column: expression.column,
      };
    }
    this.error("表达式语句缺少 ';'", this.peek());
  }

  parseLetStatement() {
    const start = this.consume("let", "变量声明应以 let 开始");
    const mutable = this.match("mut");
    const name = this.consumeIdentifier("变量声明缺少标识符");
    let declaredType = null;
    if (this.match(":")) {
      declaredType = this.parseType();
    }
    let initializer = null;
    if (this.match("=")) {
      initializer = this.parseExpression();
    }
    this.consume(";", "变量声明语句缺少 ';'");
    return {
      type: "VarDeclStmt",
      name: name.value,
      mutable,
      declaredType,
      initializer,
      line: start.line,
      column: start.column,
      nameLine: name.line,
      nameColumn: name.column,
    };
  }

  parseReturnStatement() {
    const start = this.consume("return", "返回语句应以 return 开始");
    if (this.match(";")) {
      return { type: "ReturnStmt", expression: null, line: start.line, column: start.column };
    }
    const expression = this.parseExpression();
    this.consume(";", "return 语句缺少 ';'");
    return { type: "ReturnStmt", expression, line: start.line, column: start.column };
  }

  parseIfStatement() {
    const start = this.consume("if", "if 语句应以 if 开始");
    const condition = this.parseExpression();
    const thenBlock = this.parseBlock({ allowFinalExpr: false });
    let elseBranch = null;
    if (this.match("else")) {
      elseBranch = this.check("if")
        ? this.parseIfStatement()
        : this.parseBlock({ allowFinalExpr: false });
    }
    return {
      type: "IfStmt",
      condition,
      thenBlock,
      elseBranch,
      line: start.line,
      column: start.column,
    };
  }

  parseWhileStatement() {
    const start = this.consume("while", "while 语句应以 while 开始");
    const condition = this.parseExpression();
    const body = this.parseBlock({ allowFinalExpr: false });
    return { type: "WhileStmt", condition, body, line: start.line, column: start.column };
  }

  parseForStatement() {
    const start = this.consume("for", "for 语句应以 for 开始");
    const mutable = this.match("mut");
    const iterator = this.consumeIdentifier("for 循环缺少迭代变量");
    this.consume("in", "for 循环缺少 in");
    const rangeStart = this.parseExpression();
    this.consume("..", "for 循环目前支持 start..end 区间");
    const rangeEnd = this.parseExpression();
    const body = this.parseBlock({ allowFinalExpr: false });
    return {
      type: "ForStmt",
      iterator: iterator.value,
      iteratorMutable: mutable,
      rangeStart,
      rangeEnd,
      body,
      line: start.line,
      column: start.column,
    };
  }

  parseLoopStatement() {
    const start = this.consume("loop", "loop 语句应以 loop 开始");
    const body = this.parseBlock({ allowFinalExpr: false });
    return { type: "LoopStmt", body, line: start.line, column: start.column };
  }

  parseBreakStatement() {
    const start = this.consume("break", "break 语句应以 break 开始");
    if (this.match(";")) {
      return { type: "BreakStmt", expression: null, line: start.line, column: start.column };
    }
    const expression = this.parseExpression();
    this.consume(";", "break 语句缺少 ';'");
    return { type: "BreakStmt", expression, line: start.line, column: start.column };
  }

  parseContinueStatement() {
    const start = this.consume("continue", "continue 语句应以 continue 开始");
    this.consume(";", "continue 语句缺少 ';'");
    return { type: "ContinueStmt", line: start.line, column: start.column };
  }

  parseExpression() {
    if (this.check("if")) return this.parseIfExpression();
    if (this.check("loop")) return this.parseLoopExpression();
    return this.parseComparison();
  }

  parseIfExpression() {
    const start = this.consume("if", "if 表达式应以 if 开始");
    const condition = this.parseExpression();
    const thenBlock = this.parseBlock({ allowFinalExpr: true });
    this.consume("else", "if 表达式必须带 else 分支");
    const elseBranch = this.check("if")
      ? this.parseIfExpression()
      : this.parseBlock({ allowFinalExpr: true });
    return {
      type: "IfExpression",
      condition,
      thenBlock,
      elseBranch,
      line: start.line,
      column: start.column,
    };
  }

  parseLoopExpression() {
    const start = this.consume("loop", "loop 表达式应以 loop 开始");
    const body = this.parseBlock({ allowFinalExpr: false });
    return { type: "LoopExpression", body, line: start.line, column: start.column };
  }

  parseComparison() {
    let expression = this.parseTerm();
    const ops = new Set(["<", "<=", ">", ">=", "==", "!="]);
    while (ops.has(this.peek().value)) {
      const op = this.advance();
      const right = this.parseTerm();
      expression = {
        type: "BinaryExpr",
        operator: op.value,
        left: expression,
        right,
        line: op.line,
        column: op.column,
      };
    }
    return expression;
  }

  parseTerm() {
    let expression = this.parseFactor();
    while (this.check("+") || this.check("-")) {
      const op = this.advance();
      const right = this.parseFactor();
      expression = {
        type: "BinaryExpr",
        operator: op.value,
        left: expression,
        right,
        line: op.line,
        column: op.column,
      };
    }
    return expression;
  }

  parseFactor() {
    let expression = this.parseUnary();
    while (this.check("*") || this.check("/")) {
      const op = this.advance();
      const right = this.parseUnary();
      expression = {
        type: "BinaryExpr",
        operator: op.value,
        left: expression,
        right,
        line: op.line,
        column: op.column,
      };
    }
    return expression;
  }

  parseUnary() {
    if (this.check("-") || this.check("!") || this.check("*") || this.check("&")) {
      const op = this.advance();
      let mutable = false;
      if (op.value === "&") mutable = this.match("mut");
      const argument = this.parseUnary();
      return {
        type: "UnaryExpr",
        operator: op.value,
        mutable,
        argument,
        line: op.line,
        column: op.column,
      };
    }
    return this.parsePostfix();
  }

  parsePostfix() {
    let expression = this.parsePrimary();
    while (true) {
      if (this.match("(")) {
        const args = [];
        if (!this.check(")")) {
          do {
            args.push(this.parseExpression());
          } while (this.match(","));
        }
        const close = this.consume(")", "函数调用缺少 ')'");
        expression = {
          type: "CallExpr",
          callee: expression,
          args,
          line: expression.line,
          column: expression.column,
          endLine: close.line,
          endColumn: close.column,
        };
      } else if (this.match("[")) {
        const index = this.parseExpression();
        this.consume("]", "数组索引缺少 ']'");
        expression = {
          type: "IndexExpr",
          object: expression,
          index,
          line: expression.line,
          column: expression.column,
        };
      } else if (this.match(".")) {
        const member = this.consumeNumber("元组索引必须是整数字面量");
        expression = {
          type: "MemberExpr",
          object: expression,
          member: member.text,
          line: expression.line,
          column: expression.column,
        };
      } else {
        break;
      }
    }
    return expression;
  }

  parsePrimary() {
    if (this.match("true")) {
      const token = this.previous();
      return {
        type: "LiteralExpr",
        literalType: "bool",
        value: true,
        line: token.line,
        column: token.column,
      };
    }
    if (this.match("false")) {
      const token = this.previous();
      return {
        type: "LiteralExpr",
        literalType: "bool",
        value: false,
        line: token.line,
        column: token.column,
      };
    }
    if (this.peek().type === "number") {
      const token = this.advance();
      return {
        type: "LiteralExpr",
        literalType: token.isInteger ? "i32" : "float",
        value: token.numericValue,
        text: token.text,
        line: token.line,
        column: token.column,
      };
    }
    if (this.peek().type === "identifier") {
      const token = this.advance();
      return {
        type: "IdentifierExpr",
        name: token.value,
        line: token.line,
        column: token.column,
      };
    }
    if (this.match("(")) {
      const start = this.previous();
      if (this.match(")")) {
        return { type: "UnitLiteralExpr", line: start.line, column: start.column };
      }
      const first = this.parseExpression();
      if (this.match(",")) {
        const elements = [first];
        while (!this.check(")")) {
          elements.push(this.parseExpression());
          if (!this.match(",")) break;
        }
        this.consume(")", "元组表达式缺少 ')'");
        return {
          type: "TupleLiteralExpr",
          elements,
          line: start.line,
          column: start.column,
        };
      }
      this.consume(")", "括号表达式缺少 ')'");
      return first;
    }
    if (this.match("[")) {
      const start = this.previous();
      const elements = [];
      if (!this.check("]")) {
        do {
          elements.push(this.parseExpression());
        } while (this.match(","));
      }
      this.consume("]", "数组表达式缺少 ']'");
      return {
        type: "ArrayLiteralExpr",
        elements,
        line: start.line,
        column: start.column,
      };
    }
    if (this.check("{")) {
      const block = this.parseBlock({ allowFinalExpr: true });
      return {
        type: "BlockExpression",
        block,
        line: block.line,
        column: block.column,
      };
    }
    this.error("缺少表达式", this.peek());
  }

  match(value) {
    if (!this.check(value)) return false;
    this.advance();
    return true;
  }

  consume(value, message) {
    if (this.check(value)) return this.advance();
    this.error(message, this.peek());
  }

  consumeIdentifier(message) {
    if (this.peek().type === "identifier") return this.advance();
    this.error(message, this.peek());
  }

  consumeNumber(message) {
    if (this.peek().type === "number") return this.advance();
    this.error(message, this.peek());
  }

  check(value) {
    if (this.isAtEnd()) return false;
    return this.peek().value === value;
  }

  advance() {
    if (!this.isAtEnd()) this.currentIndex += 1;
    return this.previous();
  }

  isAtEnd() {
    return this.peek().type === "eof";
  }

  peek() {
    return this.tokens[this.currentIndex];
  }

  previous() {
    return this.tokens[this.currentIndex - 1];
  }

  error(message, token) {
    throw new CompileError(`语法错误：${message}`, token || this.peek(), "syntax");
  }
}