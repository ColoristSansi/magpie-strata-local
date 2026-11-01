// magpie 插件入口。
// 用 OpenCode v1 的 { id, server } 形状：magpie 只调用 server，不把其他导出当插件。
import { createStrataPlugin } from "./lib/plugin.mjs"

export default { id: "strata-local", server: createStrataPlugin }
