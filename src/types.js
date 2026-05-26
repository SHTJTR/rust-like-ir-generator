// 类型系统：定义内置类型常量、类型工厂函数与比较/转换工具。

export const TYPE_I32 = Object.freeze({ kind: "i32" });
export const TYPE_BOOL = Object.freeze({ kind: "bool" });
export const TYPE_UNIT = Object.freeze({ kind: "unit" });
export const TYPE_FLOAT = Object.freeze({ kind: "float" });
export const TYPE_ERROR = Object.freeze({ kind: "error" });

export function unknownType() {
  return { kind: "unknown" };
}

export function arrayType(element, length) {
  return { kind: "array", element, length };
}

export function tupleType(elements) {
  return { kind: "tuple", elements };
}

export function refType(inner, mutable) {
  return { kind: "ref", inner, mutable };
}

export function typeToString(type) {
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

export function sameType(left, right) {
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

export function isConcrete(type) {
  return type && type.kind !== "unknown" && type.kind !== "error";
}

// 是否允许使用 == / != 比较：i32、bool、不可变引用之间。
// 数组与元组的相等比较语义复杂，本项目暂不支持，避免出现误判。
export function isEqualityComparable(type) {
  if (!type) return false;
  return type.kind === "i32" || type.kind === "bool" || type.kind === "ref";
}