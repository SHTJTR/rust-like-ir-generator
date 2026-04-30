(function initCompiler(global) {
  "use strict";

  const KEYWORDS = new Set([
    "fn",
    "let",
    "mut",
    "return",
    "if",
    "else",
    "while",
    "for",
    "in",
    "loop",
    "break",
    "continue",
    "true",
    "false",
    "i32",
    "bool",
  ]);

  const TYPE_I32 = Object.freeze({ kind: "i32" });
  const TYPE_BOOL = Object.freeze({ kind: "bool" });
  const TYPE_UNIT = Object.freeze({ kind: "unit" });
  const TYPE_FLOAT = Object.freeze({ kind: "float" });
  const TYPE_ERROR = Object.freeze({ kind: "error" });

  function unknownType() {
    return { kind: "unknown" };
  }

  function arrayType(element, length) {
    return { kind: "array", element, length };
  }

  function tupleType(elements) {
    return { kind: "tuple", elements };
  }

  function refType(inner, mutable) {
    return { kind: "ref", inner, mutable };
  }

  function typeToString(type) {
    if (!type) return "unknown";
    switch (type.kind) {
      case "i32":
        return "i32";
      case "bool":
        return "bool";
      case "unit":
        return "()";
      case "float":
        return "float(unsupported)";
      case "unknown":
        return "unknown";
      case "error":
        return "error";
      case "array":
        return `[${typeToString(type.element)}; ${type.length}]`;
      case "tuple":
        return `(${type.elements.map(typeToString).join(", ")})`;
      case "ref":
        return `&${type.mutable ? "mut " : ""}${typeToString(type.inner)}`;
      default:
        return String(type.kind || "unknown");
    }
  }

  function sameType(left, right) {
    if (!left || !right) return false;
    if (left.kind === "error" || right.kind === "error") return true;
    if (left.kind !== right.kind) return false;
    switch (left.kind) {
      case "array":
        return left.length === right.length && sameType(left.element, right.element);
      case "tuple":
        return (
          left.elements.length === right.elements.length &&
          left.elements.every((item, index) => sameType(item, right.elements[index]))
        );
      case "ref":
        return left.mutable === right.mutable && sameType(left.inner, right.inner);
      default:
        return true;
    }
  }

  function isConcrete(type) {
    return type && type.kind !== "unknown" && type.kind !== "error";
  }

  class CompileError extends Error {
    constructor(message, token, phase) {
      super(message);
      this.name = "CompileError";
      this.line = token ? token.line : 1;
      this.column = token ? token.column : 1;
      this.phase = phase || "syntax";
    }
  }

  class Lexer {
    constructor(source) {
      this.source = String(source || "");
      this.index = 0;
      this.line = 1;
      this.column = 1;
      this.tokens = [];
    }

    tokenize() {
      while (!this.isAtEnd()) {
        this.skipIgnored();
        if (this.isAtEnd()) break;
        const ch = this.peek();
        if (this.isAlpha(ch)) {
          this.readIdentifier();
        } else if (this.isDigit(ch)) {
          this.readNumber();
        } else {
          this.readOperatorOrPunctuation();
        }
      }
      this.tokens.push({
        type: "eof",
        value: "<eof>",
        text: "",
        line: this.line,
        column: this.column,
      });
      return this.tokens;
    }

    isAtEnd() {
      return this.index >= this.source.length;
    }

    peek(offset = 0) {
      return this.source[this.index + offset] || "";
    }

    advance() {
      const ch = this.source[this.index++] || "";
      if (ch === "\n") {
        this.line += 1;
        this.column = 1;
      } else {
        this.column += 1;
      }
      return ch;
    }

    addToken(type, value, text, line, column, extra) {
      this.tokens.push({
        type,
        value,
        text,
        line,
        column,
        ...(extra || {}),
      });
    }

    skipIgnored() {
      let moved = true;
      while (moved && !this.isAtEnd()) {
        moved = false;
        while (/\s/.test(this.peek())) {
          this.advance();
          moved = true;
        }
        if (this.peek() === "/" && this.peek(1) === "/") {
          while (!this.isAtEnd() && this.peek() !== "\n") this.advance();
          moved = true;
        }
        if (this.peek() === "/" && this.peek(1) === "*") {
          const start = { line: this.line, column: this.column };
          this.advance();
          this.advance();
          while (!this.isAtEnd() && !(this.peek() === "*" && this.peek(1) === "/")) {
            this.advance();
          }
          if (this.isAtEnd()) {
            throw new CompileError("词法错误：块注释未闭合", start, "lexical");
          }
          this.advance();
          this.advance();
          moved = true;
        }
      }
    }

    readIdentifier() {
      const line = this.line;
      const column = this.column;
      let text = "";
      while (this.isAlphaNumeric(this.peek())) text += this.advance();
      this.addToken(KEYWORDS.has(text) ? "keyword" : "identifier", text, text, line, column);
    }

    readNumber() {
      const line = this.line;
      const column = this.column;
      let text = "";
      while (this.isDigit(this.peek())) text += this.advance();
      if (this.peek() === "." && this.isDigit(this.peek(1))) {
        text += this.advance();
        while (this.isDigit(this.peek())) text += this.advance();
      }
      this.addToken("number", text, text, line, column, {
        numericValue: Number(text),
        isInteger: !text.includes("."),
      });
    }

    readOperatorOrPunctuation() {
      const line = this.line;
      const column = this.column;
      const two = this.peek() + this.peek(1);
      const twoChar = new Set(["->", "==", "!=", "<=", ">=", "..", "&&", "||"]);
      if (twoChar.has(two)) {
        this.advance();
        this.advance();
        this.addToken("symbol", two, two, line, column);
        return;
      }
      const ch = this.advance();
      const singles = "{}()[];,:+-*/=<>&!.";
      if (singles.includes(ch)) {
        this.addToken("symbol", ch, ch, line, column);
        return;
      }
      throw new CompileError(`词法错误：无法识别字符 '${ch}'`, { line, column }, "lexical");
    }

    isAlpha(ch) {
      return /[A-Za-z_]/.test(ch);
    }

    isDigit(ch) {
      return /[0-9]/.test(ch);
    }

    isAlphaNumeric(ch) {
      return /[A-Za-z0-9_]/.test(ch);
    }
  }

  class Parser {
    constructor(tokens) {
      this.tokens = tokens;
      this.currentIndex = 0;
    }

    parseProgram() {
      const functions = [];
      while (!this.isAtEnd()) {
        functions.push(this.parseFunction());
      }
      return { type: "Program", functions };
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
        let hadSeparator = false;
        while (this.check(",") || this.check(";")) {
          this.advance();
          hadSeparator = true;
          if (this.check(")")) break;
          elements.push(this.parseType());
        }
        this.consume(")", "元组类型缺少 ')'");
        return elements.length === 1 && !hadSeparator ? elements[0] : tupleType(elements);
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
        const stmt = this.parseStatement(Boolean(options.allowFinalExpr));
        if (stmt.type === "FinalExpression") {
          finalExpr = stmt.expression;
          break;
        }
        statements.push(stmt);
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

  class SemanticAnalyzer {
    constructor(ast) {
      this.ast = ast;
      this.diagnostics = [];
      this.quads = [];
      this.scopes = [];
      this.functions = new Map();
      this.symbolRows = [];
      this.symbolId = 0;
      this.tempId = 0;
      this.labelId = 0;
      this.currentFunction = null;
      this.loopStack = [];
    }

    analyze() {
      this.collectFunctions();
      for (const fn of this.ast.functions) {
        this.analyzeFunction(fn);
      }
      return {
        diagnostics: this.diagnostics,
        quads: this.quads,
        symbols: this.symbolRows,
      };
    }

    collectFunctions() {
      for (const fn of this.ast.functions) {
        if (this.functions.has(fn.name)) {
          this.addDiagnostic("error", `函数 '${fn.name}' 重复声明`, fn);
          continue;
        }
        this.functions.set(fn.name, {
          name: fn.name,
          params: fn.params.map((param) => ({
            name: param.name,
            type: param.paramType,
            mutable: param.mutable,
          })),
          returnType: fn.returnType || TYPE_UNIT,
          node: fn,
        });
      }
    }

    analyzeFunction(fn) {
      const signature = this.functions.get(fn.name);
      if (!signature) return;
      this.currentFunction = signature;
      this.emit("FUNC", "", "", fn.name);
      this.pushScope(`fn ${fn.name}`);

      const seenParams = new Set();
      for (const param of fn.params) {
        if (seenParams.has(param.name)) {
          this.addDiagnostic("error", `形参 '${param.name}' 重复声明`, param);
        }
        seenParams.add(param.name);
        const symbol = this.declareVar(param.name, param.paramType, param.mutable, true, param, "param");
        this.emit("PARAM", typeToString(param.paramType), "", symbol.place);
      }

      const result = this.analyzeBlock(fn.body, { createScope: false });
      if (result.finalValue) {
        this.checkReturnValue(result.finalValue, fn.body.finalExpr);
        this.emit("RETURN", result.finalValue.place, "", "");
      } else if (!result.definiteReturn) {
        if (signature.returnType.kind !== "unit") {
          this.addDiagnostic(
            "error",
            `函数 '${fn.name}' 声明返回 ${typeToString(signature.returnType)}，但可能没有返回值`,
            fn
          );
        } else {
          this.emit("RETURN", "", "", "");
        }
      }

      this.popScope(fn);
      this.emit("END", "", "", fn.name);
      this.currentFunction = null;
    }

    analyzeBlock(block, options = {}) {
      const createScope = options.createScope !== false;
      if (createScope) this.pushScope("block");
      let definiteReturn = false;
      for (const stmt of block.statements) {
        if (definiteReturn) {
          this.addDiagnostic("warning", "该语句位于确定返回之后，运行时不可达", stmt);
        }
        const stmtResult = this.analyzeStatement(stmt);
        definiteReturn = definiteReturn || Boolean(stmtResult.definiteReturn);
      }
      let finalValue = null;
      if (block.finalExpr) {
        if (definiteReturn) {
          this.addDiagnostic("warning", "尾表达式位于确定返回之后，运行时不可达", block.finalExpr);
        }
        finalValue = this.analyzeExpression(block.finalExpr);
      }
      if (createScope) this.popScope(block);
      return { definiteReturn, finalValue };
    }

    analyzeStatement(stmt) {
      switch (stmt.type) {
        case "EmptyStmt":
          return { definiteReturn: false };
        case "VarDeclStmt":
          this.analyzeVarDecl(stmt);
          return { definiteReturn: false };
        case "AssignStmt":
          this.analyzeAssignment(stmt);
          return { definiteReturn: false };
        case "ExprStmt":
          this.analyzeExpression(stmt.expression);
          return { definiteReturn: false };
        case "ReturnStmt":
          this.analyzeReturn(stmt);
          return { definiteReturn: true };
        case "IfStmt":
          return this.analyzeIfStatement(stmt);
        case "WhileStmt":
          this.analyzeWhileStatement(stmt);
          return { definiteReturn: false };
        case "ForStmt":
          this.analyzeForStatement(stmt);
          return { definiteReturn: false };
        case "LoopStmt":
          this.analyzeLoopStatement(stmt);
          return { definiteReturn: false };
        case "BreakStmt":
          this.analyzeBreak(stmt);
          return { definiteReturn: true };
        case "ContinueStmt":
          this.analyzeContinue(stmt);
          return { definiteReturn: true };
        default:
          this.addDiagnostic("error", `暂不支持语句类型 ${stmt.type}`, stmt);
          return { definiteReturn: false };
      }
    }

    analyzeVarDecl(stmt) {
      let initializer = null;
      if (stmt.initializer) {
        initializer = this.analyzeExpression(stmt.initializer);
      }

      let declaredType = stmt.declaredType || unknownType();
      if (initializer) {
        if (initializer.type.kind === "unit") {
          this.addDiagnostic("error", "无返回值表达式不能作为变量初值", stmt.initializer);
          if (!stmt.declaredType) declaredType = TYPE_UNIT;
        } else if (!stmt.declaredType) {
          declaredType = initializer.type;
        } else {
          this.checkAssignable(declaredType, initializer.type, stmt.initializer, "变量初始化类型不一致");
        }
      }

      const symbol = this.declareVar(
        stmt.name,
        declaredType,
        stmt.mutable,
        Boolean(initializer && initializer.type.kind !== "error" && initializer.type.kind !== "unit"),
        stmt,
        "local"
      );
      this.emit("DECL", typeToString(symbol.type), stmt.mutable ? "mut" : "let", symbol.place);
      if (initializer) {
        this.attachBorrow(symbol, initializer, stmt.initializer);
        this.emit("ASSIGN", initializer.place, "", symbol.place);
        symbol.writes += 1;
      }
    }

    analyzeAssignment(stmt) {
      const target = this.analyzeLValue(stmt.target);
      const value = this.analyzeExpression(stmt.value);
      if (!target.assignable) {
        this.addDiagnostic("error", "赋值语句左侧必须是可赋值左值", stmt.target);
        return;
      }

      if (target.rootSymbol && target.rootSymbol.initialized && !target.mutable) {
        this.addDiagnostic("error", `变量 '${target.rootSymbol.name}' 不可变，不能被二次赋值`, stmt.target);
      }

      if (target.type.kind === "unknown" && target.symbol && isConcrete(value.type)) {
        target.symbol.type = value.type;
        target.type = value.type;
      } else {
        this.checkAssignable(target.type, value.type, stmt.value, "赋值类型不一致");
      }

      if (target.symbol) {
        this.attachBorrow(target.symbol, value, stmt.value);
        target.symbol.initialized = true;
        target.symbol.writes += 1;
      }
      if (target.rootSymbol && !target.symbol) {
        target.rootSymbol.writes += 1;
      }
      this.emit("ASSIGN", value.place, "", target.place);
    }

    analyzeReturn(stmt) {
      if (!stmt.expression) {
        if (this.currentFunction.returnType.kind !== "unit") {
          this.addDiagnostic(
            "error",
            `返回语句类型 () 与函数返回类型 ${typeToString(this.currentFunction.returnType)} 不一致`,
            stmt
          );
        }
        this.emit("RETURN", "", "", "");
        return;
      }
      const value = this.analyzeExpression(stmt.expression);
      this.checkReturnValue(value, stmt.expression);
      this.emit("RETURN", value.place, "", "");
    }

    checkReturnValue(value, node) {
      const expected = this.currentFunction.returnType;
      if (expected.kind === "unit") {
        if (value.type.kind !== "unit") {
          this.addDiagnostic(
            "error",
            `返回语句类型 ${typeToString(value.type)} 与函数返回类型 () 不一致`,
            node
          );
        }
        return;
      }
      this.checkAssignable(expected, value.type, node, "返回值类型不一致");
    }

    analyzeIfStatement(stmt) {
      const condition = this.analyzeExpression(stmt.condition);
      this.requireBool(condition, stmt.condition, "if 条件表达式必须是 bool");
      const elseLabel = this.newLabel();
      const endLabel = this.newLabel();
      this.emit("IF_FALSE", condition.place, "", elseLabel);
      const thenResult = this.analyzeBlock(stmt.thenBlock);
      let elseResult = { definiteReturn: false };
      if (stmt.elseBranch) {
        this.emit("GOTO", "", "", endLabel);
        this.emit("LABEL", "", "", elseLabel);
        elseResult =
          stmt.elseBranch.type === "Block"
            ? this.analyzeBlock(stmt.elseBranch)
            : this.analyzeStatement(stmt.elseBranch);
        this.emit("LABEL", "", "", endLabel);
      } else {
        this.emit("LABEL", "", "", elseLabel);
      }
      return {
        definiteReturn: Boolean(stmt.elseBranch && thenResult.definiteReturn && elseResult.definiteReturn),
      };
    }

    analyzeWhileStatement(stmt) {
      const startLabel = this.newLabel();
      const endLabel = this.newLabel();
      this.emit("LABEL", "", "", startLabel);
      const condition = this.analyzeExpression(stmt.condition);
      this.requireBool(condition, stmt.condition, "while 条件表达式必须是 bool");
      this.emit("IF_FALSE", condition.place, "", endLabel);
      this.loopStack.push({ breakLabel: endLabel, continueLabel: startLabel, allowsBreakValue: false });
      this.analyzeBlock(stmt.body);
      this.loopStack.pop();
      this.emit("GOTO", "", "", startLabel);
      this.emit("LABEL", "", "", endLabel);
    }

    analyzeForStatement(stmt) {
      const startValue = this.analyzeExpression(stmt.rangeStart);
      const endValue = this.analyzeExpression(stmt.rangeEnd);
      this.requireI32(startValue, stmt.rangeStart, "for 区间起点必须是 i32");
      this.requireI32(endValue, stmt.rangeEnd, "for 区间终点必须是 i32");

      this.pushScope("for");
      const iterator = this.declareVar(stmt.iterator, TYPE_I32, stmt.iteratorMutable, true, stmt, "loop");
      this.emit("ASSIGN", startValue.place, "", iterator.place);

      const startLabel = this.newLabel();
      const endLabel = this.newLabel();
      const stepLabel = this.newLabel();
      this.emit("LABEL", "", "", startLabel);
      const condTemp = this.newTemp(TYPE_BOOL);
      this.emit("<", iterator.place, endValue.place, condTemp);
      this.emit("IF_FALSE", condTemp, "", endLabel);
      this.loopStack.push({ breakLabel: endLabel, continueLabel: stepLabel, allowsBreakValue: false });
      this.analyzeBlock(stmt.body);
      this.loopStack.pop();
      this.emit("LABEL", "", "", stepLabel);
      const nextTemp = this.newTemp(TYPE_I32);
      this.emit("+", iterator.place, "1", nextTemp);
      this.emit("ASSIGN", nextTemp, "", iterator.place);
      this.emit("GOTO", "", "", startLabel);
      this.emit("LABEL", "", "", endLabel);
      this.popScope(stmt);
    }

    analyzeLoopStatement(stmt) {
      const startLabel = this.newLabel();
      const endLabel = this.newLabel();
      this.emit("LABEL", "", "", startLabel);
      this.loopStack.push({ breakLabel: endLabel, continueLabel: startLabel, allowsBreakValue: false });
      this.analyzeBlock(stmt.body);
      this.loopStack.pop();
      this.emit("GOTO", "", "", startLabel);
      this.emit("LABEL", "", "", endLabel);
    }

    analyzeBreak(stmt) {
      const currentLoop = this.loopStack[this.loopStack.length - 1];
      if (!currentLoop) {
        if (stmt.expression) this.analyzeExpression(stmt.expression);
        this.addDiagnostic("error", "break 必须出现在循环体内", stmt);
        return;
      }

      const value = stmt.expression
        ? this.analyzeExpression(stmt.expression)
        : { type: TYPE_UNIT, place: "()" };
      if (stmt.expression && !currentLoop.allowsBreakValue) {
        this.addDiagnostic("error", "只有 loop 表达式支持 break 返回值", stmt);
      }

      if (currentLoop.allowsBreakValue) {
        currentLoop.hasBreak = true;
        if (!currentLoop.breakType) {
          currentLoop.breakType = value.type;
        } else {
          this.checkAssignable(currentLoop.breakType, value.type, stmt.expression || stmt, "loop 表达式多个 break 返回类型不一致");
        }
        if (value.type.kind !== "unit" && value.type.kind !== "error") {
          if (!currentLoop.resultPlace) currentLoop.resultPlace = this.newTemp(value.type);
          this.emit("ASSIGN", value.place, "", currentLoop.resultPlace);
        }
      }

      this.emit("GOTO", "", "", currentLoop.breakLabel);
    }

    analyzeContinue(stmt) {
      const currentLoop = this.loopStack[this.loopStack.length - 1];
      if (!currentLoop) {
        this.addDiagnostic("error", "continue 必须出现在循环体内", stmt);
        return;
      }
      this.emit("GOTO", "", "", currentLoop.continueLabel);
    }

    analyzeExpression(expr) {
      switch (expr.type) {
        case "LiteralExpr":
          if (expr.literalType === "bool") {
            return { type: TYPE_BOOL, place: String(expr.value), constant: expr.value };
          }
          if (expr.literalType === "float") {
            this.addDiagnostic("error", "基础语言仅支持 i32，浮点字面量不受支持", expr);
            return { type: TYPE_FLOAT, place: expr.text, constant: expr.value };
          }
          return { type: TYPE_I32, place: expr.text, constant: expr.value };
        case "UnitLiteralExpr":
          return { type: TYPE_UNIT, place: "()" };
        case "IdentifierExpr":
          return this.analyzeIdentifier(expr);
        case "BinaryExpr":
          return this.analyzeBinary(expr);
        case "UnaryExpr":
          return this.analyzeUnary(expr);
        case "CallExpr":
          return this.analyzeCall(expr);
        case "ArrayLiteralExpr":
          return this.analyzeArrayLiteral(expr);
        case "TupleLiteralExpr":
          return this.analyzeTupleLiteral(expr);
        case "IndexExpr":
          return this.analyzeIndex(expr);
        case "MemberExpr":
          return this.analyzeMember(expr);
        case "BlockExpression":
          return this.analyzeBlockExpression(expr);
        case "IfExpression":
          return this.analyzeIfExpression(expr);
        case "LoopExpression":
          return this.analyzeLoopExpression(expr);
        default:
          this.addDiagnostic("error", `暂不支持表达式类型 ${expr.type}`, expr);
          return { type: TYPE_ERROR, place: "error" };
      }
    }

    analyzeIdentifier(expr) {
      const symbol = this.lookupVar(expr.name);
      if (!symbol) {
        if (this.functions.has(expr.name)) {
          this.addDiagnostic("error", `函数 '${expr.name}' 不能作为普通值使用，请补充调用括号`, expr);
        } else {
          this.addDiagnostic("error", `变量 '${expr.name}' 未声明`, expr);
        }
        return { type: TYPE_ERROR, place: expr.name };
      }
      if (!symbol.initialized) {
        this.addDiagnostic("error", `变量 '${expr.name}' 使用前未赋值`, expr);
      }
      symbol.reads += 1;
      return {
        type: symbol.type,
        place: symbol.place,
        symbol,
        rootSymbol: symbol.borrowTarget || symbol,
        borrowRoot: symbol.borrowTarget,
        borrowMutable: symbol.borrowMutable,
        borrowValid: true,
      };
    }

    analyzeBinary(expr) {
      const left = this.analyzeExpression(expr.left);
      const right = this.analyzeExpression(expr.right);
      const arithmetic = new Set(["+", "-", "*", "/"]);
      const ordered = new Set(["<", "<=", ">", ">="]);
      const equality = new Set(["==", "!="]);
      if (arithmetic.has(expr.operator)) {
        this.requireI32(left, expr.left, `运算符 '${expr.operator}' 左操作数必须是 i32`);
        this.requireI32(right, expr.right, `运算符 '${expr.operator}' 右操作数必须是 i32`);
        const place = this.newTemp(TYPE_I32);
        this.emit(expr.operator, left.place, right.place, place);
        return { type: TYPE_I32, place, constant: this.foldConstant(expr.operator, left, right) };
      }
      if (ordered.has(expr.operator)) {
        this.requireI32(left, expr.left, `比较运算符 '${expr.operator}' 左操作数必须是 i32`);
        this.requireI32(right, expr.right, `比较运算符 '${expr.operator}' 右操作数必须是 i32`);
        const place = this.newTemp(TYPE_BOOL);
        this.emit(expr.operator, left.place, right.place, place);
        return { type: TYPE_BOOL, place };
      }
      if (equality.has(expr.operator)) {
        this.checkAssignable(left.type, right.type, expr.right, "相等比较两侧类型不一致");
        const place = this.newTemp(TYPE_BOOL);
        this.emit(expr.operator, left.place, right.place, place);
        return { type: TYPE_BOOL, place };
      }
      this.addDiagnostic("error", `未知二元运算符 '${expr.operator}'`, expr);
      return { type: TYPE_ERROR, place: "error" };
    }

    analyzeUnary(expr) {
      if (expr.operator === "-") {
        const value = this.analyzeExpression(expr.argument);
        this.requireI32(value, expr.argument, "一元负号仅支持 i32");
        const place = this.newTemp(TYPE_I32);
        this.emit("NEG", value.place, "", place);
        return { type: TYPE_I32, place };
      }
      if (expr.operator === "!") {
        const value = this.analyzeExpression(expr.argument);
        this.requireBool(value, expr.argument, "逻辑非仅支持 bool");
        const place = this.newTemp(TYPE_BOOL);
        this.emit("NOT", value.place, "", place);
        return { type: TYPE_BOOL, place };
      }
      if (expr.operator === "*") {
        const value = this.analyzeExpression(expr.argument);
        if (value.type.kind !== "ref") {
          this.addDiagnostic("error", "不能对非引用类型解引用", expr);
          return { type: TYPE_ERROR, place: `*${value.place}` };
        }
        const place = this.newTemp(value.type.inner);
        this.emit("DEREF", value.place, "", place);
        return { type: value.type.inner, place, rootSymbol: value.rootSymbol };
      }
      if (expr.operator === "&") {
        const target = this.analyzeLValue(expr.argument);
        let validBorrow = true;
        if (target.symbol && !target.symbol.initialized) {
          this.addDiagnostic("error", `变量 '${target.symbol.name}' 使用前未赋值`, expr.argument);
          validBorrow = false;
        }
        if (expr.mutable) {
          if (target.rootSymbol && !target.rootSymbol.mutable) {
            this.addDiagnostic("error", "只能从可变变量创建可变引用", expr);
            validBorrow = false;
          }
          if (target.rootSymbol && (target.rootSymbol.borrowShared > 0 || target.rootSymbol.borrowMut > 0)) {
            this.addDiagnostic("error", "可变引用不能和其他引用共存", expr);
            validBorrow = false;
          }
        } else if (target.rootSymbol) {
          if (target.rootSymbol.borrowMut > 0) {
            this.addDiagnostic("error", "已有可变引用时不能再创建不可变引用", expr);
            validBorrow = false;
          }
        }
        const place = this.newTemp(refType(target.type, expr.mutable));
        this.emit(expr.mutable ? "REF_MUT" : "REF", target.place, "", place);
        return {
          type: refType(target.type, expr.mutable),
          place,
          rootSymbol: target.rootSymbol,
          borrowRoot: target.rootSymbol,
          borrowMutable: expr.mutable,
          borrowValid: validBorrow,
        };
      }
      this.addDiagnostic("error", `未知一元运算符 '${expr.operator}'`, expr);
      return { type: TYPE_ERROR, place: "error" };
    }

    analyzeCall(expr) {
      if (expr.callee.type !== "IdentifierExpr") {
        this.addDiagnostic("error", "当前仅支持直接通过函数名调用函数", expr.callee);
        for (const arg of expr.args) this.analyzeExpression(arg);
        return { type: TYPE_ERROR, place: "call_error" };
      }
      const signature = this.functions.get(expr.callee.name);
      if (!signature) {
        this.addDiagnostic("error", `函数 '${expr.callee.name}' 未声明`, expr.callee);
        for (const arg of expr.args) this.analyzeExpression(arg);
        return { type: TYPE_ERROR, place: `${expr.callee.name}()` };
      }
      const argValues = expr.args.map((arg) => this.analyzeExpression(arg));
      if (argValues.length !== signature.params.length) {
        this.addDiagnostic(
          "error",
          `函数 '${signature.name}' 需要 ${signature.params.length} 个实参，实际得到 ${argValues.length} 个`,
          expr
        );
      }
      const count = Math.min(argValues.length, signature.params.length);
      for (let index = 0; index < count; index += 1) {
        this.checkAssignable(
          signature.params[index].type,
          argValues[index].type,
          expr.args[index],
          `第 ${index + 1} 个实参与形参 '${signature.params[index].name}' 类型不一致`
        );
      }
      for (const value of argValues) {
        this.emit("ARG", value.place, "", "");
      }
      const resultPlace = signature.returnType.kind === "unit" ? "" : this.newTemp(signature.returnType);
      this.emit("CALL", signature.name, String(argValues.length), resultPlace);
      return { type: signature.returnType, place: resultPlace || "()" };
    }

    analyzeArrayLiteral(expr) {
      const values = expr.elements.map((item) => this.analyzeExpression(item));
      if (values.length === 0) {
        return { type: arrayType(TYPE_ERROR, 0), place: "[]" };
      }
      const elementType = values[0].type;
      for (let index = 1; index < values.length; index += 1) {
        this.checkAssignable(elementType, values[index].type, expr.elements[index], "数组元素类型不一致");
      }
      const place = this.newTemp(arrayType(elementType, values.length));
      this.emit("ARRAY", values.map((value) => value.place).join(", "), "", place);
      return { type: arrayType(elementType, values.length), place };
    }

    analyzeTupleLiteral(expr) {
      const values = expr.elements.map((item) => this.analyzeExpression(item));
      const place = this.newTemp(tupleType(values.map((value) => value.type)));
      this.emit("TUPLE", values.map((value) => value.place).join(", "), "", place);
      return { type: tupleType(values.map((value) => value.type)), place };
    }

    analyzeIndex(expr) {
      const object = this.analyzeExpression(expr.object);
      const index = this.analyzeExpression(expr.index);
      this.requireI32(index, expr.index, "数组索引必须是 i32");
      if (object.type.kind !== "array") {
        this.addDiagnostic("error", "只有数组类型可以使用 [] 索引", expr);
        return { type: TYPE_ERROR, place: `${object.place}[${index.place}]` };
      }
      if (typeof index.constant === "number" && Number.isInteger(index.constant)) {
        if (index.constant < 0 || index.constant >= object.type.length) {
          this.addDiagnostic(
            "error",
            `数组索引必须在合法范围 [0, ${object.type.length}) 内`,
            expr.index
          );
        }
      }
      const place = this.newTemp(object.type.element);
      this.emit("INDEX", object.place, index.place, place);
      return {
        type: object.type.element,
        place,
        rootSymbol: object.rootSymbol,
      };
    }

    analyzeMember(expr) {
      const object = this.analyzeExpression(expr.object);
      const index = Number(expr.member);
      if (!Number.isInteger(index)) {
        this.addDiagnostic("error", "元组索引必须是整数字面量", expr);
        return { type: TYPE_ERROR, place: `${object.place}.${expr.member}` };
      }
      if (object.type.kind !== "tuple") {
        this.addDiagnostic("error", "只有元组类型可以使用 .N 访问元素", expr);
        return { type: TYPE_ERROR, place: `${object.place}.${expr.member}` };
      }
      if (index < 0 || index >= object.type.elements.length) {
        this.addDiagnostic("error", `元组索引必须在合法范围 [0, ${object.type.elements.length}) 内`, expr);
        return { type: TYPE_ERROR, place: `${object.place}.${expr.member}` };
      }
      const place = this.newTemp(object.type.elements[index]);
      this.emit("MEMBER", object.place, String(index), place);
      return { type: object.type.elements[index], place, rootSymbol: object.rootSymbol };
    }

    analyzeBlockExpression(expr) {
      const result = this.analyzeBlock(expr.block);
      if (!result.finalValue) {
        return { type: TYPE_UNIT, place: "()" };
      }
      return result.finalValue;
    }

    analyzeIfExpression(expr) {
      const condition = this.analyzeExpression(expr.condition);
      this.requireBool(condition, expr.condition, "if 表达式条件必须是 bool");
      const elseLabel = this.newLabel();
      const endLabel = this.newLabel();
      const resultTemp = this.newTemp(unknownType());
      this.emit("IF_FALSE", condition.place, "", elseLabel);
      const thenResult = this.analyzeBlock(expr.thenBlock);
      const thenValue = thenResult.finalValue || { type: TYPE_UNIT, place: "()" };
      this.emit("ASSIGN", thenValue.place, "", resultTemp);
      this.emit("GOTO", "", "", endLabel);
      this.emit("LABEL", "", "", elseLabel);
      const elseValue =
        expr.elseBranch.type === "Block"
          ? this.analyzeBlock(expr.elseBranch).finalValue || { type: TYPE_UNIT, place: "()" }
          : this.analyzeExpression(expr.elseBranch);
      this.checkAssignable(thenValue.type, elseValue.type, expr.elseBranch, "if 表达式两个分支类型不一致");
      this.emit("ASSIGN", elseValue.place, "", resultTemp);
      this.emit("LABEL", "", "", endLabel);
      return { type: thenValue.type, place: resultTemp };
    }

    analyzeLoopExpression(expr) {
      const startLabel = this.newLabel();
      const endLabel = this.newLabel();
      const loopContext = {
        breakLabel: endLabel,
        continueLabel: startLabel,
        allowsBreakValue: true,
        hasBreak: false,
        breakType: null,
        resultPlace: null,
      };
      this.emit("LABEL", "", "", startLabel);
      this.loopStack.push(loopContext);
      this.analyzeBlock(expr.body);
      this.loopStack.pop();
      this.emit("GOTO", "", "", startLabel);
      this.emit("LABEL", "", "", endLabel);

      if (!loopContext.hasBreak) {
        this.addDiagnostic("warning", "loop 表达式没有可达的 break 返回值，按 () 处理", expr);
        return { type: TYPE_UNIT, place: "()" };
      }
      return {
        type: loopContext.breakType || TYPE_UNIT,
        place: loopContext.resultPlace || "()",
      };
    }

    analyzeLValue(expr) {
      if (expr.type === "IdentifierExpr") {
        const symbol = this.lookupVar(expr.name);
        if (!symbol) {
          this.addDiagnostic("error", `变量 '${expr.name}' 未声明`, expr);
          return {
            type: TYPE_ERROR,
            place: expr.name,
            assignable: false,
            mutable: false,
            symbol: null,
            rootSymbol: null,
          };
        }
        return {
          type: symbol.type,
          place: symbol.place,
          assignable: true,
          mutable: symbol.mutable || !symbol.initialized,
          symbol,
          rootSymbol: symbol,
        };
      }
      if (expr.type === "UnaryExpr" && expr.operator === "*") {
        const refValue = this.analyzeExpression(expr.argument);
        if (refValue.type.kind !== "ref") {
          this.addDiagnostic("error", "不能对非引用类型解引用", expr);
          return { type: TYPE_ERROR, place: `*${refValue.place}`, assignable: false };
        }
        if (!refValue.type.mutable) {
          this.addDiagnostic("error", "不可变引用不能修改指向数据", expr);
        }
        return {
          type: refValue.type.inner,
          place: `*${refValue.place}`,
          assignable: true,
          mutable: refValue.type.mutable,
          symbol: null,
          rootSymbol: refValue.rootSymbol,
        };
      }
      if (expr.type === "IndexExpr") {
        const object = this.analyzeExpression(expr.object);
        const index = this.analyzeExpression(expr.index);
        this.requireI32(index, expr.index, "数组索引必须是 i32");
        if (object.type.kind !== "array") {
          this.addDiagnostic("error", "只有数组类型可以使用 [] 索引", expr);
          return { type: TYPE_ERROR, place: `${object.place}[${index.place}]`, assignable: false };
        }
        if (typeof index.constant === "number" && Number.isInteger(index.constant)) {
          if (index.constant < 0 || index.constant >= object.type.length) {
            this.addDiagnostic(
              "error",
              `数组索引必须在合法范围 [0, ${object.type.length}) 内`,
              expr.index
            );
          }
        }
        return {
          type: object.type.element,
          place: `${object.place}[${index.place}]`,
          assignable: true,
          mutable: object.rootSymbol ? object.rootSymbol.mutable : true,
          symbol: null,
          rootSymbol: object.rootSymbol,
        };
      }
      if (expr.type === "MemberExpr") {
        const object = this.analyzeExpression(expr.object);
        const index = Number(expr.member);
        if (object.type.kind !== "tuple" || !Number.isInteger(index)) {
          this.addDiagnostic("error", "只有元组类型可以使用 .N 作为左值", expr);
          return { type: TYPE_ERROR, place: `${object.place}.${expr.member}`, assignable: false };
        }
        if (index < 0 || index >= object.type.elements.length) {
          this.addDiagnostic("error", `元组索引必须在合法范围 [0, ${object.type.elements.length}) 内`, expr);
          return { type: TYPE_ERROR, place: `${object.place}.${expr.member}`, assignable: false };
        }
        return {
          type: object.type.elements[index],
          place: `${object.place}.${index}`,
          assignable: true,
          mutable: object.rootSymbol ? object.rootSymbol.mutable : true,
          symbol: null,
          rootSymbol: object.rootSymbol,
        };
      }
      this.addDiagnostic("error", "该表达式不能作为左值", expr);
      return { type: TYPE_ERROR, place: "invalid_lvalue", assignable: false };
    }

    checkAssignable(expected, actual, node, message) {
      if (!expected || !actual) return;
      if (expected.kind === "error" || actual.kind === "error") return;
      if (expected.kind === "unknown" || actual.kind === "unknown") return;
      if (!sameType(expected, actual)) {
        this.addDiagnostic(
          "error",
          `${message}：需要 ${typeToString(expected)}，实际为 ${typeToString(actual)}`,
          node
        );
      }
    }

    requireI32(value, node, message) {
      if (value.type.kind === "error" || value.type.kind === "unknown") return;
      if (value.type.kind !== "i32") {
        this.addDiagnostic("error", `${message}，实际为 ${typeToString(value.type)}`, node);
      }
    }

    requireBool(value, node, message) {
      if (value.type.kind === "error" || value.type.kind === "unknown") return;
      if (value.type.kind !== "bool") {
        this.addDiagnostic("error", `${message}，实际为 ${typeToString(value.type)}`, node);
      }
    }

    foldConstant(operator, left, right) {
      if (typeof left.constant !== "number" || typeof right.constant !== "number") return undefined;
      switch (operator) {
        case "+":
          return left.constant + right.constant;
        case "-":
          return left.constant - right.constant;
        case "*":
          return left.constant * right.constant;
        case "/":
          return right.constant === 0 ? undefined : Math.trunc(left.constant / right.constant);
        default:
          return undefined;
      }
    }

    pushScope(name) {
      this.scopes.push({ name, symbols: new Map(), list: [] });
    }

    popScope(node) {
      const scope = this.scopes.pop();
      if (!scope) return;
      for (const symbol of scope.list) {
        if (symbol.type.kind === "unknown") {
          this.addDiagnostic("error", `无法推断变量 '${symbol.name}' 的类型`, {
            line: symbol.line,
            column: symbol.column,
          });
        }
        this.releaseBorrow(symbol);
      }
    }

    declareVar(name, type, mutable, initialized, node, kind) {
      const scope = this.scopes[this.scopes.length - 1];
      const previous = scope.symbols.get(name);
      if (previous) this.releaseBorrow(previous);
      const symbol = {
        id: ++this.symbolId,
        name,
        place: `${name}#${this.symbolId}`,
        scope: scope.name,
        kind,
        type: type || unknownType(),
        mutable: Boolean(mutable),
        initialized: Boolean(initialized),
        line: node.nameLine || node.line || 1,
        column: node.nameColumn || node.column || 1,
        reads: 0,
        writes: 0,
        borrowShared: 0,
        borrowMut: 0,
        borrowTarget: null,
        borrowMutable: false,
      };
      scope.symbols.set(name, symbol);
      scope.list.push(symbol);
      this.symbolRows.push(symbol);
      return symbol;
    }

    attachBorrow(symbol, value, node) {
      this.releaseBorrow(symbol);
      if (!value || value.type.kind !== "ref" || !value.borrowRoot || value.borrowValid === false) return;

      if (value.borrowMutable) {
        if (value.borrowRoot.borrowShared > 0 || value.borrowRoot.borrowMut > 0) {
          this.addDiagnostic("error", "可变引用不能和其他引用共存", node || symbol);
          return;
        }
        value.borrowRoot.borrowMut += 1;
      } else {
        if (value.borrowRoot.borrowMut > 0) {
          this.addDiagnostic("error", "已有可变引用时不能再创建不可变引用", node || symbol);
          return;
        }
        value.borrowRoot.borrowShared += 1;
      }

      symbol.borrowTarget = value.borrowRoot;
      symbol.borrowMutable = Boolean(value.borrowMutable);
    }

    releaseBorrow(symbol) {
      if (!symbol || !symbol.borrowTarget) return;
      if (symbol.borrowMutable) {
        symbol.borrowTarget.borrowMut = Math.max(0, symbol.borrowTarget.borrowMut - 1);
      } else {
        symbol.borrowTarget.borrowShared = Math.max(0, symbol.borrowTarget.borrowShared - 1);
      }
      symbol.borrowTarget = null;
      symbol.borrowMutable = false;
    }

    lookupVar(name) {
      for (let index = this.scopes.length - 1; index >= 0; index -= 1) {
        const symbol = this.scopes[index].symbols.get(name);
        if (symbol) return symbol;
      }
      return null;
    }

    newTemp(type) {
      const name = `_t${++this.tempId}`;
      return name;
    }

    newLabel() {
      return `L${++this.labelId}`;
    }

    emit(op, arg1, arg2, result) {
      this.quads.push({
        index: this.quads.length,
        op,
        arg1: arg1 || "",
        arg2: arg2 || "",
        result: result || "",
      });
    }

    addDiagnostic(severity, message, node, phase = "semantic") {
      this.diagnostics.push({
        severity,
        message,
        phase,
        line: node && node.line ? node.line : 1,
        column: node && node.column ? node.column : 1,
      });
    }
  }

  function compile(source) {
    const result = {
      ok: false,
      tokens: [],
      ast: null,
      diagnostics: [],
      quads: [],
      symbols: [],
    };
    try {
      const lexer = new Lexer(source);
      const tokens = lexer.tokenize();
      result.tokens = tokens.filter((token) => token.type !== "eof");
      const parser = new Parser(tokens);
      const ast = parser.parseProgram();
      result.ast = ast;
      const semantic = new SemanticAnalyzer(ast).analyze();
      result.diagnostics = semantic.diagnostics;
      result.quads = semantic.quads;
      result.symbols = semantic.symbols;
      result.ok = !result.diagnostics.some((item) => item.severity === "error");
    } catch (error) {
      if (error instanceof CompileError) {
        result.diagnostics.push({
          severity: "error",
          phase: error.phase,
          message: error.message,
          line: error.line,
          column: error.column,
        });
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

  const SAMPLE_PROGRAMS = [
    {
      name: "基础通过",
      code: `fn add(mut a:i32, mut b:i32) -> i32 {
    return a + b;
}

fn main() {
    let mut x:i32;
    x = add(1, 2);
    while x > 0 {
        x = x - 1;
    }
}`,
    },
    {
      name: "函数与 if",
      code: `fn abs(mut a:i32) -> i32 {
    if a > 0 {
        return a;
    } else {
        return 0 - a;
    }
}

fn main() {
    let mut value:i32 = abs(3 * 2 - 9);
    value;
}`,
    },
    {
      name: "语义错误示例",
      code: `fn bad(mut a:i32) {
    let mut b:i32;
    let mut c:i32 = b;
    a = 1 == 1;
    missing(1);
}`,
    },
    {
      name: "break/continue",
      code: `fn count(mut n:i32) {
    while n > 0 {
        n = n - 1;
        if n == 2 {
            continue;
        }
        if n == 0 {
            break;
        }
    }
}`,
    },
    {
      name: "数组和元组扩展",
      code: `fn data() {
    let mut a:[i32;3] = [1, 2, 3];
    let mut sum:i32 = a[0] + a[1] + a[2];
    let mut pair:(i32, i32) = (sum, 9);
    pair.0 = pair.0 + 1;
}`,
    },
  ];

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
    return result.diagnostics
      .map(
        (diag) => `<div class="diagnostic ${diag.severity}">
          <div class="diagnostic-title">${escapeHtml(diag.message)}</div>
          <div class="diagnostic-meta">${escapeHtml(diag.phase)} · line ${diag.line}, col ${diag.column} · ${escapeHtml(diag.severity)}</div>
        </div>`
      )
      .join("");
  }

  function renderQuads(result) {
    if (result.quads.length === 0) return `<div class="empty-state">暂无四元式。请先修正语法错误。</div>`;
    return `<table>
      <thead><tr><th>#</th><th>op</th><th>arg1</th><th>arg2</th><th>result</th></tr></thead>
      <tbody>${result.quads
        .map(
          (quad) => `<tr>
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

  function renderSymbols(result) {
    if (result.symbols.length === 0) return `<div class="empty-state">暂无符号表。</div>`;
    return `<table>
      <thead><tr><th>名称</th><th>IR 名</th><th>作用域</th><th>类别</th><th>类型</th><th>属性</th><th>位置</th></tr></thead>
      <tbody>${result.symbols
        .map(
          (symbol) => `<tr>
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
          (token, index) => `<tr>
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

  function setupUi() {
    const sourceInput = document.getElementById("sourceInput");
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
      runCompile();
    });
    compileBtn.addEventListener("click", runCompile);
    clearBtn.addEventListener("click", () => {
      sourceInput.value = "";
      runCompile();
      sourceInput.focus();
    });
    sourceInput.addEventListener("keydown", (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = sourceInput.selectionStart;
        const end = sourceInput.selectionEnd;
        sourceInput.value = `${sourceInput.value.slice(0, start)}    ${sourceInput.value.slice(end)}`;
        sourceInput.selectionStart = sourceInput.selectionEnd = start + 4;
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

    sourceInput.value = SAMPLE_PROGRAMS[0].code;
    runCompile();
  }

  const api = {
    compile,
    Lexer,
    Parser,
    SemanticAnalyzer,
    SAMPLE_PROGRAMS,
    typeToString,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  if (global) {
    global.RustLikeCompiler = api;
  }
  if (typeof window !== "undefined") {
    window.addEventListener("DOMContentLoaded", setupUi);
  }
})(typeof window !== "undefined" ? window : globalThis);
