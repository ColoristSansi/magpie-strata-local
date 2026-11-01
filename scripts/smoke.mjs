// 本地冒烟测试：不启动模型，只检查插件对象、config/auth/tool 的形状。
//   node scripts/smoke.mjs
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pluginEntry from "../index.mjs"

const factory = pluginEntry.server
assert.equal(typeof factory, "function")
assert.equal(pluginEntry.id, "strata-local")

const hooks = await factory(
  {
    // 临时目录：不把发现缓存写进插件目录。
    directory: mkdtempSync(join(tmpdir(), "magpie-strata-smoke-")),
    magpie: { option: () => undefined },
  },
  { autoStart: false, idleStopMinutes: 0 },
)

const cfg = {}
await hooks.config(cfg)
const provider = cfg.provider["strata-local"]
assert.equal(provider.npm, "@ai-sdk/openai-compatible")
assert.equal(provider.api, "http://127.0.0.1:18777/v1")
assert.deepEqual(Object.keys(provider.models).sort(), [
  "strata-chat",
  "strata-messages",
  "strata-responses",
])
assert.equal(provider.models["strata-chat"].id, "strata")
assert.equal(provider.models["strata-messages"].provider.npm, "@ai-sdk/anthropic")
assert.equal(provider.models["strata-responses"].provider.npm, "@ai-sdk/openai")
assert.equal(provider.models["strata-chat"].limit.context, 262144)

assert.equal(hooks.auth.provider, "strata-local")
assert.equal(hooks.auth.methods.length, 1)
const authorized = await hooks.auth.methods[0].authorize()
assert.equal(authorized.type, "success")
assert.ok(authorized.key)

const loader = await hooks.auth.loader(async () => ({ type: "api", key: "test" }))
assert.equal(loader.baseURL, "http://127.0.0.1:18777/v1")

const response = await loader.fetch("http://127.0.0.1:18777/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "strata", messages: [] }),
})
// 服务没跑时是 503（插件自己的说明），在跑时请求会被转发给 Strata，空请求会得到 400。
assert.ok([400, 503].includes(response.status), `unexpected status ${response.status}`)
const body = await response.json()
assert.ok(body.error?.message || body.error)

const listed = await hooks.provider.models(provider, {})
assert.equal(listed["strata-messages"].api.npm, "@ai-sdk/anthropic")
assert.equal(listed["strata-responses"].api.npm, "@ai-sdk/openai")
assert.ok(typeof listed["strata-chat"].api.id === "string" && listed["strata-chat"].api.id.length > 0)

const status = await hooks.tool.status.execute()
assert.equal(typeof status.running, "boolean")
assert.equal(status.port, 18777)
assert.equal(typeof status.ready, "boolean")

const logs = await hooks.tool.logs.execute()
assert.equal(logs.cli.length > 0, true)

console.log("smoke ok")
console.log(JSON.stringify({ provider, status }, null, 2))
process.exit(0)
