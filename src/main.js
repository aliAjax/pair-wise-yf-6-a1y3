import "./styles.css";
import { mountApp } from "./ui.js";

// 入口只做组装：理赔判定 -> claims.js，状态存储 -> store.js，页面交互 -> ui.js
mountApp(document.querySelector("#app"));
