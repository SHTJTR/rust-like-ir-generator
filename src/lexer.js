// 词法分析器：把源程序扫描成 Token 序列。
// 该模块导出 Lexer 类、KEYWORDS 集合和 CompileError 异常。

export const KEYWORDS = new Set([
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

// 编译阶段统一抛出的异常，附带行列号和阶段标签。
export class CompileError extends Error {
  constructor(message, token, phase) {
    super(message);
    this.name = "CompileError";
    this.line = token ? token.line : 1;
    this.column = token ? token.column : 1;
    this.phase = phase || "syntax";
  }
}

export class Lexer {
  constructor(source) {
    this.source = String(source || "");
    this.index = 0;
    this.line = 1;
    this.column = 1;
    this.tokens = [];
    // 收集词法错误，支持错误恢复：遇到非法字符时跳过它继续扫描。
    this.errors = [];
  }

  tokenize() {
    while (!this.isAtEnd()) {
      try {
        this.skipIgnored();
      } catch (error) {
        // 块注释未闭合等情况：记录错误并跳出，避免死循环。
        if (error instanceof CompileError) {
          this.errors.push(error);
          break;
        }
        throw error;
      }
      if (this.isAtEnd()) break;
      const ch = this.peek();
      try {
        if (this.isAlpha(ch)) {
          this.readIdentifier();
        } else if (this.isDigit(ch)) {
          this.readNumber();
        } else {
          this.readOperatorOrPunctuation();
        }
      } catch (error) {
        if (error instanceof CompileError) {
          this.errors.push(error);
          // 跳过当前字符继续扫描，避免一次只能报一个词法错误。
          if (!this.isAtEnd()) this.advance();
        } else {
          throw error;
        }
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