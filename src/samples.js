// 内置示例程序，供 UI 一键载入。

export const SAMPLE_PROGRAMS = [
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
    name: "多语法错误（错误恢复）",
    code: `fn main() {
    let mut a = 1
    let mut b = 2;
    let c = ;
    let d = 3
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
  {
    name: "loop 表达式",
    code: `fn first_positive(mut start:i32) -> i32 {
    let mut value = loop {
        if start > 0 {
            break start;
        } else {
            start = start + 1;
        }
    };
    return value;
}`,
  },
  {
    name: "引用与借用",
    code: `fn main() {
    let mut value:i32 = 1;
    let r1 = &value;
    let r2 = &value;
    r1; r2;
    let mut exclusive = &mut value;
    *exclusive = 100;
}`,
  },
];