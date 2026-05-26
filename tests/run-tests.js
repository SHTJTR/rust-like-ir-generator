// 编译器回归测试。
// 与初版相比：
//   1. 改为 ES Module，直接使用 src/ 下的真实模块；
//   2. 改造为收集式测试运行器，逐项报告通过/失败；
//   3. 新增对元组类型分号、错误恢复、除零警告、临时变量复用、
//      相等比较类型限制等的覆盖。

import { compile } from "../src/compile.js";

const tests = [];
let passed = 0;
let failed = 0;

function it(name, fn) {
  tests.push({ name, fn });
}

function errorsOf(source) {
  return compile(source).diagnostics.filter((diag) => diag.severity === "error");
}

function warningsOf(source) {
  return compile(source).diagnostics.filter((diag) => diag.severity === "warning");
}

function assertOk(source) {
  const result = compile(source);
  const errors = result.diagnostics.filter((diag) => diag.severity === "error");
  if (errors.length > 0) {
    throw new Error(`expected no errors, got:\n${JSON.stringify(errors, null, 2)}`);
  }
  if (result.quads.length === 0) {
    throw new Error("expected quadruples to be emitted");
  }
}

function assertError(source, pattern) {
  const errors = errorsOf(source);
  if (errors.length === 0) {
    throw new Error("expected an error, got none");
  }
  if (pattern && !errors.some((diag) => pattern.test(diag.message))) {
    throw new Error(
      `expected error matching ${pattern}, got:\n${JSON.stringify(errors, null, 2)}`
    );
  }
}

// ========== 必做规则正例 ==========

it("基础函数调用与 while", () =>
  assertOk(`fn add(mut a:i32, mut b:i32) -> i32 {
    return a + b;
}

fn main() {
    let mut x:i32;
    x = add(1, 2);
    while x > 0 {
        x = x - 1;
    }
}`));

it("if / else 返回", () =>
  assertOk(`fn abs(mut a:i32) -> i32 {
    if a > 0 {
        return a;
    } else {
        return 0 - a;
    }
}`));

it("赋值后能推断变量类型", () =>
  assertOk(`fn main() {
    let mut b;
    b = 1;
    b = b + 1;
}`));

it("必做规则覆盖 1.1 - 1.5", () =>
  assertOk(`fn program_1_1() {
}

fn program_1_2() {
    ;;;;;;
}

fn program_1_3() {
    return;
}

fn program_1_4(mut a:i32) {
    a;
}

fn program_1_5() -> i32 {
    return 1;
}`));

it("变量声明、赋值和重影", () =>
  assertOk(`fn main() {
    let mut a:i32;
    a = 1;
    let mut a;
    a = 2;
}`));

it("运算符优先级和函数调用", () =>
  assertOk(`fn inc(mut a:i32) -> i32 {
    return a + 1;
}

fn main(mut x:i32) {
    x = inc(1 + 2 * 3);
    x < 10;
    x <= 10;
    x > 0;
    x >= 0;
    x == 7;
    x != 8;
}`));

// ========== 必做规则反例 ==========

it("使用前未赋值", () =>
  assertError(
    `fn main() {
    let mut a:i32;
    let mut b:i32 = a;
}`,
    /使用前未赋值/
  ));

it("return 类型不匹配", () =>
  assertError(
    `fn main() {
    return 1;
}`,
    /返回语句类型 i32 与函数返回类型 \(\) 不一致/
  ));

it("函数实参数量不匹配", () =>
  assertError(
    `fn needs_one(mut a:i32) {
}

fn main() {
    needs_one(1, 2);
}`,
    /需要 1 个实参/
  ));

it("赋值类型不一致", () =>
  assertError(
    `fn main(mut a:i32) {
    a = 1 == 1;
}`,
    /赋值类型不一致/
  ));

it("循环外 break", () =>
  assertError(
    `fn main() {
    break;
}`,
    /break 必须出现在循环体内/
  ));

it("无法推断变量类型", () =>
  assertError(
    `fn main() {
    let mut b;
}`,
    /无法推断变量 'b' 的类型/
  ));

it("赋值未声明变量", () =>
  assertError(
    `fn main() {
    a = 32;
}`,
    /变量 'a' 未声明/
  ));

it("无返回值函数不能作右值", () =>
  assertError(
    `fn f() {
}

fn main() {
    let mut a = f();
}`,
    /无返回值表达式不能作为变量初值/
  ));

it("if 条件必须是 bool", () =>
  assertError(
    `fn main() {
    if 1 {
        ;
    }
}`,
    /if 条件表达式必须是 bool/
  ));

it("while 条件必须是 bool", () =>
  assertError(
    `fn main() {
    while 1 {
        ;
    }
}`,
    /while 条件表达式必须是 bool/
  ));

it("不可变变量二次赋值", () =>
  assertError(
    `fn main() {
    let a:i32 = 1;
    a = 2;
}`,
    /不可变/
  ));

it("for 区间必须是 i32", () =>
  assertError(
    `fn main(mut n:i32) {
    for mut i in 1..n+0.1 {
        n = n - 1;
    }
}`,
    /浮点字面量|右操作数必须是 i32/
  ));

// ========== 扩展规则正例 ==========

it("for / loop 控制流", () =>
  assertOk(`fn main(mut n:i32) {
    for mut i in 0..n {
        n = n - 1;
    }
    loop {
        break;
    }
}`));

it("loop 表达式返回 break 值", () =>
  assertOk(`fn main(mut x:i32) {
    let mut value = loop {
        if x > 0 {
            break 1;
        } else {
            break 2;
        }
    };
    value = value + 1;
}`));

it("数组、元组和引用", () =>
  assertOk(`fn main() {
    let mut arr:[i32;3] = [1, 2, 3];
    arr[0] = arr[1] + arr[2];
    let mut pair:(i32, i32) = (arr[0], 9);
    pair.0 = pair.0 + 1;
    let mut value:i32 = 1;
    let mut ref_value:&mut i32 = &mut value;
    *ref_value = pair.0;
}`));

it("引用借用在块作用域结束时释放", () =>
  assertOk(`fn main() {
    let mut value:i32 = 1;
    {
        let shared = &value;
        shared;
    }
    let mut exclusive = &mut value;
    *exclusive = 2;
}`));

it("重影后旧借用释放", () =>
  assertOk(`fn main() {
    let mut value:i32 = 1;
    let shared = &value;
    let shared = 0;
    let mut exclusive = &mut value;
    *exclusive = shared;
}`));

it("重新赋值后旧借用释放", () =>
  assertOk(`fn main() {
    let mut left:i32 = 1;
    let mut right:i32 = 2;
    let mut shared = &left;
    shared = &right;
    let mut exclusive = &mut left;
    *exclusive = 3;
}`));

// ========== 扩展规则反例 ==========

it("loop 表达式 break 类型不一致", () =>
  assertError(
    `fn main(mut x:i32) {
    let mut value = loop {
        if x > 0 {
            break 1;
        } else {
            break true;
        }
    };
}`,
    /loop 表达式多个 break 返回类型不一致/
  ));

it("while 内 break 不允许带值", () =>
  assertError(
    `fn main() {
    while true {
        break 1;
    }
}`,
    /只有 loop 表达式支持 break 返回值/
  ));

it("数组长度不匹配", () =>
  assertError(
    `fn main() {
    let mut a:[i32;2];
    a = [1, 2, 3];
}`,
    /赋值类型不一致/
  ));

it("数组索引越界", () =>
  assertError(
    `fn main() {
    let mut a = [1, 2, 3];
    let mut b = a[3];
}`,
    /数组索引必须在合法范围/
  ));

it("元组长度不匹配", () =>
  assertError(
    `fn main() {
    let mut a:(i32, i32);
    a = (1, 2, 3);
}`,
    /赋值类型不一致/
  ));

it("元组索引越界", () =>
  assertError(
    `fn main() {
    let mut a = (1, 2, 3);
    let mut b = a.3;
}`,
    /元组索引必须在合法范围/
  ));

it("可变引用与不可变引用冲突", () =>
  assertError(
    `fn main() {
    let mut a:i32 = 1;
    let b = &a;
    let mut c = &mut a;
}`,
    /可变引用不能和其他引用共存/
  ));

it("不可变引用不能写指向数据", () =>
  assertError(
    `fn main() {
    let mut a:i32 = 1;
    let mut b = &a;
    *b = 2;
}`,
    /不可变引用不能修改指向数据/
  ));

it("可变引用不能被复制", () =>
  assertError(
    `fn main() {
    let mut a:i32 = 1;
    let mut b = &mut a;
    let mut c = b;
}`,
    /可变引用不能和其他引用共存/
  ));

// ========== 改进项新增 ==========

it("【修复】元组类型不能用 ; 分隔（PDF 9.1 反例）", () =>
  assertError(
    `fn main() {
    let b:(i32;i32;);
}`,
    /元组类型元素之间必须使用 ',' 分隔/
  ));

it("【新增】错误恢复：一次报告多个语法错误", () => {
  const source = `fn main() {
    let mut a = 1
    let mut b = 2;
    let c = ;
    let d = 3
}`;
  const errors = errorsOf(source);
  if (errors.length < 2) {
    throw new Error(
      `expected multiple errors via panic-mode recovery, got ${errors.length}:\n${JSON.stringify(
        errors,
        null,
        2
      )}`
    );
  }
});

it("【新增】错误恢复：函数级同步，后续函数仍被检查", () => {
  // 前一个函数语法错误，后一个函数有语义错误 —— 两类错误都应出现。
  const source = `fn broken( {
    let a = 1;
}

fn after() {
    undeclared = 1;
}`;
  const diags = compile(source).diagnostics;
  const hasSyntax = diags.some((d) => d.phase === "syntax");
  const hasSemantic = diags.some((d) => d.phase === "semantic");
  if (!hasSyntax || !hasSemantic) {
    throw new Error(
      `expected both syntax and semantic diagnostics, got:\n${JSON.stringify(diags, null, 2)}`
    );
  }
});

it("【新增】除以常量 0 发出警告", () => {
  const source = `fn main(mut a:i32) {
    a = a / 0;
}`;
  const warnings = warningsOf(source);
  if (!warnings.some((w) => /除零|除以常量 0/.test(w.message))) {
    throw new Error(
      `expected divide-by-zero warning, got:\n${JSON.stringify(warnings, null, 2)}`
    );
  }
});

it("【新增】数组不支持 == 比较", () =>
  assertError(
    `fn main() {
    let a = [1, 2, 3];
    let b = [1, 2, 3];
    if a == b {
        ;
    }
}`,
    /不支持 == \/ != 比较/
  ));

it("【新增】元组不支持 != 比较", () =>
  assertError(
    `fn main() {
    let a = (1, 2);
    let b = (1, 2);
    let c = a != b;
}`,
    /不支持 == \/ != 比较/
  ));

it("【新增】临时变量在每个函数内独立编号", () => {
  // 两个简单函数应该都从 _t1 开始命名。
  const source = `fn first(mut a:i32) -> i32 {
    return a + 1;
}

fn second(mut b:i32) -> i32 {
    return b + 1;
}`;
  const result = compile(source);
  const temps = result.quads
    .map((q) => [q.arg1, q.arg2, q.result])
    .flat()
    .filter((s) => /^_t\d+$/.test(s));
  if (!temps.includes("_t1")) {
    throw new Error(`expected _t1 to appear, got temps: ${[...new Set(temps)].join(",")}`);
  }
  // 每个函数都应该有自己的 _t1。
  const firstT1Count = temps.filter((t) => t === "_t1").length;
  if (firstT1Count < 2) {
    throw new Error(
      `expected _t1 to appear in each of the two functions, got ${firstT1Count} occurrences`
    );
  }
});

it("【新增】单元素元组类型 (T,) 与括号类型 (T) 区分", () => {
  // (T,) 是单元素元组，访问 .0 合法；(T) 等价于 T，访问 .0 应报错。
  assertOk(`fn main() {
    let mut a:(i32,) = (1,);
    let mut b:i32 = a.0;
}`);
  assertError(
    `fn main() {
    let mut a:(i32) = 1;
    let mut b = a.0;
}`,
    /只有元组类型/
  );
});

// ========== 运行 ==========

(async () => {
  console.log(`运行 ${tests.length} 项测试…\n`);
  for (const t of tests) {
    try {
      await t.fn();
      passed += 1;
      console.log(`  ✓ ${t.name}`);
    } catch (error) {
      failed += 1;
      console.log(`  ✗ ${t.name}`);
      console.log(`    ${error.message.replace(/\n/g, "\n    ")}`);
    }
  }
  console.log(`\n通过 ${passed} / ${tests.length}，失败 ${failed}`);
  if (failed > 0) process.exit(1);
})();