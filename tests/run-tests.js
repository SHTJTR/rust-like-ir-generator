"use strict";

const assert = require("assert");
const { compile } = require("../compiler");

function errorsOf(source) {
  return compile(source).diagnostics.filter((diag) => diag.severity === "error");
}

function expectOk(name, source) {
  const result = compile(source);
  assert.strictEqual(
    result.diagnostics.filter((diag) => diag.severity === "error").length,
    0,
    `${name} should compile without errors:\n${JSON.stringify(result.diagnostics, null, 2)}`
  );
  assert.ok(result.quads.length > 0, `${name} should produce quadruples`);
}

function expectError(name, source, pattern) {
  const errors = errorsOf(source);
  assert.ok(errors.length > 0, `${name} should report an error`);
  if (pattern) {
    assert.ok(
      errors.some((diag) => pattern.test(diag.message)),
      `${name} should include ${pattern}, got:\n${JSON.stringify(errors, null, 2)}`
    );
  }
}

expectOk(
  "basic function call and while",
  `fn add(mut a:i32, mut b:i32) -> i32 {
    return a + b;
}

fn main() {
    let mut x:i32;
    x = add(1, 2);
    while x > 0 {
        x = x - 1;
    }
}`
);

expectOk(
  "if else returns",
  `fn abs(mut a:i32) -> i32 {
    if a > 0 {
        return a;
    } else {
        return 0 - a;
    }
}`
);

expectOk(
  "type inference after assignment",
  `fn main() {
    let mut b;
    b = 1;
    b = b + 1;
}`
);

expectError(
  "read before assignment",
  `fn main() {
    let mut a:i32;
    let mut b:i32 = a;
}`,
  /使用前未赋值/
);

expectError(
  "return type mismatch",
  `fn main() {
    return 1;
}`,
  /返回语句类型 i32 与函数返回类型 \(\) 不一致/
);

expectError(
  "call arity mismatch",
  `fn needs_one(mut a:i32) {
}

fn main() {
    needs_one(1, 2);
}`,
  /需要 1 个实参/
);

expectError(
  "assignment type mismatch",
  `fn main(mut a:i32) {
    a = 1 == 1;
}`,
  /赋值类型不一致/
);

expectError(
  "break outside loop",
  `fn main() {
    break;
}`,
  /break 必须出现在循环体内/
);

expectOk(
  "required grammar basics",
  `fn program_1_1() {
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
}`
);

expectOk(
  "variable declaration assignment shadowing",
  `fn main() {
    let mut a:i32;
    a = 1;
    let mut a;
    a = 2;
}`
);

expectOk(
  "operators precedence and calls",
  `fn inc(mut a:i32) -> i32 {
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
}`
);

expectOk(
  "extended control flow",
  `fn main(mut n:i32) {
    for mut i in 0..n {
        n = n - 1;
    }
    loop {
        break;
    }
}`
);

expectOk(
  "loop expression returns break value",
  `fn main(mut x:i32) {
    let mut value = loop {
        if x > 0 {
            break 1;
        } else {
            break 2;
        }
    };
    value = value + 1;
}`
);

expectOk(
  "arrays tuples and references",
  `fn main() {
    let mut arr:[i32;3] = [1, 2, 3];
    arr[0] = arr[1] + arr[2];
    let mut pair:(i32, i32) = (arr[0], 9);
    pair.0 = pair.0 + 1;
    let mut value:i32 = 1;
    let mut ref_value:&mut i32 = &mut value;
    *ref_value = pair.0;
}`
);

expectOk(
  "reference borrow ends with block scope",
  `fn main() {
    let mut value:i32 = 1;
    {
        let shared = &value;
        shared;
    }
    let mut exclusive = &mut value;
    *exclusive = 2;
}`
);

expectOk(
  "reference borrow released by shadowing",
  `fn main() {
    let mut value:i32 = 1;
    let shared = &value;
    let shared = 0;
    let mut exclusive = &mut value;
    *exclusive = shared;
}`
);

expectOk(
  "reference borrow released by reassignment",
  `fn main() {
    let mut left:i32 = 1;
    let mut right:i32 = 2;
    let mut shared = &left;
    shared = &right;
    let mut exclusive = &mut left;
    *exclusive = 3;
}`
);

expectError(
  "missing type inference source",
  `fn main() {
    let mut b;
}`,
  /无法推断变量 'b' 的类型/
);

expectError(
  "undeclared assignment",
  `fn main() {
    a = 32;
}`,
  /变量 'a' 未声明/
);

expectError(
  "unit function cannot be used as rhs",
  `fn f() {
}

fn main() {
    let mut a = f();
}`,
  /无返回值表达式不能作为变量初值/
);

expectError(
  "if condition must be bool",
  `fn main() {
    if 1 {
        ;
    }
}`,
  /if 条件表达式必须是 bool/
);

expectError(
  "while condition must be bool",
  `fn main() {
    while 1 {
        ;
    }
}`,
  /while 条件表达式必须是 bool/
);

expectError(
  "immutable variable reassignment",
  `fn main() {
    let a:i32 = 1;
    a = 2;
}`,
  /不可变/
);

expectError(
  "for range must be i32",
  `fn main(mut n:i32) {
    for mut i in 1..n+0.1 {
        n = n - 1;
    }
}`,
  /浮点字面量|右操作数必须是 i32/
);

expectError(
  "loop expression break type mismatch",
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
);

expectError(
  "break value outside loop expression",
  `fn main() {
    while true {
        break 1;
    }
}`,
  /只有 loop 表达式支持 break 返回值/
);

expectError(
  "array length mismatch",
  `fn main() {
    let mut a:[i32;2];
    a = [1, 2, 3];
}`,
  /赋值类型不一致/
);

expectError(
  "array index out of range",
  `fn main() {
    let mut a = [1, 2, 3];
    let mut b = a[3];
}`,
  /数组索引必须在合法范围/
);

expectError(
  "tuple length mismatch",
  `fn main() {
    let mut a:(i32, i32);
    a = (1, 2, 3);
}`,
  /赋值类型不一致/
);

expectError(
  "tuple index out of range",
  `fn main() {
    let mut a = (1, 2, 3);
    let mut b = a.3;
}`,
  /元组索引必须在合法范围/
);

expectError(
  "mutable reference conflicts with shared reference",
  `fn main() {
    let mut a:i32 = 1;
    let b = &a;
    let mut c = &mut a;
}`,
  /可变引用不能和其他引用共存/
);

expectError(
  "shared reference cannot write pointee",
  `fn main() {
    let mut a:i32 = 1;
    let mut b = &a;
    *b = 2;
}`,
  /不可变引用不能修改指向数据/
);

expectError(
  "mutable reference cannot be copied",
  `fn main() {
    let mut a:i32 = 1;
    let mut b = &mut a;
    let mut c = b;
}`,
  /可变引用不能和其他引用共存/
);

console.log("All compiler checks passed.");
