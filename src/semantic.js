// 语义分析 + 四元式生成。
// 主要改进：
//   1. 临时变量 / 标签按函数独立编号，IR 更可读；
//   2. 除以零字面量发出 warning；
//   3. == / != 限制为可比较类型（i32 / bool / 引用）；
//   4. checkAssignable 对 unknown 类型补充推断。

import {
  TYPE_I32,
  TYPE_BOOL,
  TYPE_UNIT,
  TYPE_FLOAT,
  TYPE_ERROR,
  unknownType,
  arrayType,
  tupleType,
  refType,
  typeToString,
  sameType,
  isConcrete,
  isEqualityComparable,
} from "./types.js";

export class SemanticAnalyzer {
  constructor(ast) {
    this.ast = ast;
    this.diagnostics = [];
    this.quads = [];
    this.scopes = [];
    this.functions = new Map();
    this.symbolRows = [];
    this.symbolId = 0;
    // tempId 和 labelId 在每个函数进入时重置。
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
    // 每个函数独立的临时变量与标签命名空间。
    this.tempId = 0;
    this.labelId = 0;
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
      // 改进：右操作数为字面量 0 的除法发出警告。
      if (expr.operator === "/" && typeof right.constant === "number" && right.constant === 0) {
        this.addDiagnostic("warning", "检测到除以常量 0，运行时将出现除零错误", expr.right);
      }
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
      // 改进：== / != 限制为可比较类型（i32 / bool / 引用），其他类型报错。
      if (
        isConcrete(left.type) &&
        isConcrete(right.type) &&
        !isEqualityComparable(left.type) &&
        left.type.kind !== "error"
      ) {
        this.addDiagnostic(
          "error",
          `类型 ${typeToString(left.type)} 不支持 == / != 比较`,
          expr.left
        );
      }
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