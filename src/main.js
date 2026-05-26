// 浏览器入口：等待 DOM 就绪后初始化 UI。

import { setupUi } from "./ui.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", setupUi);
} else {
  setupUi();
}