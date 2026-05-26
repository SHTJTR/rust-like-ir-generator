// 四元式辅助工具：把线性 IR 切分成基本块，便于 UI 展示和未来做优化。
//
// 基本块定义（与编译原理教材一致）：
//   - 入口：函数起始 FUNC、LABEL 指令；
//   - 出口：GOTO / IF_FALSE / RETURN / END 指令，或下一条 LABEL 之前。

export function buildBasicBlocks(quads) {
  const leaders = new Set();
  if (quads.length > 0) leaders.add(0);
  for (let i = 0; i < quads.length; i += 1) {
    const quad = quads[i];
    if (quad.op === "FUNC" || quad.op === "LABEL") {
      leaders.add(i);
    }
    if (quad.op === "GOTO" || quad.op === "IF_FALSE" || quad.op === "RETURN" || quad.op === "END") {
      if (i + 1 < quads.length) leaders.add(i + 1);
    }
  }
  const sortedLeaders = [...leaders].sort((a, b) => a - b);
  const blocks = [];
  for (let i = 0; i < sortedLeaders.length; i += 1) {
    const start = sortedLeaders[i];
    const end = i + 1 < sortedLeaders.length ? sortedLeaders[i + 1] : quads.length;
    const blockQuads = quads.slice(start, end);
    blocks.push({
      id: i,
      start,
      end: end - 1,
      label: blockQuads[0].op === "LABEL" ? blockQuads[0].result : null,
      functionName: detectFunctionName(blockQuads),
      quads: blockQuads,
    });
  }
  return blocks;
}

function detectFunctionName(blockQuads) {
  for (const quad of blockQuads) {
    if (quad.op === "FUNC") return quad.result;
  }
  return null;
}

// 把四元式格式化为类汇编文本，便于复制/导出。
export function formatQuadsAsText(quads) {
  const lines = [];
  for (const quad of quads) {
    if (quad.op === "LABEL") {
      lines.push(`${quad.result}:`);
    } else if (quad.op === "FUNC") {
      lines.push(`\nfunc ${quad.result}:`);
    } else if (quad.op === "END") {
      lines.push(`endfunc ${quad.result}`);
    } else {
      const parts = [quad.op, quad.arg1, quad.arg2, quad.result]
        .map((part) => (part === "" ? "_" : part))
        .join(", ");
      lines.push(`    (${parts})`);
    }
  }
  return lines.join("\n");
}