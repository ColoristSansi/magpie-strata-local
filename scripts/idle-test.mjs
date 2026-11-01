// 空闲自动停止的实测：把窗口缩到 3 秒，等它自己 stop。
//   node scripts/idle-test.mjs
// 会真的停止本机正在运行的 Strata，仅用于验证。
import { StrataService } from "../lib/strata.mjs"
import { configDirectory, resolveOptions } from "../lib/options.mjs"

const input = {
  directory: process.env.USERPROFILE + "/.config/magpie",
  magpie: { option: () => undefined },
}
const options = resolveOptions(input, {
  idleStopMinutes: 0.05,
  idleCheckSeconds: 5,
  autoStart: false,
})
const service = new StrataService(options, {
  configDir: configDirectory(input),
  logger: (m) => console.log("[idle-test]", m),
})

const before = await service.status({ fresh: true })
console.log("启动前：", before.ready ? "ready" : "down")
if (!before.ready) {
  console.log("服务没在运行；先手动 start 再测。")
  process.exit(1)
}

service.owned = true
service.lastUsed = Date.now()
service.installIdleTimer()
console.log(`窗口 ${options.idleStopMinutes} 分钟，检查间隔 ${options.idleCheckSeconds}s，等待…`)

for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const status = await service.status({ fresh: true })
  if (!status.up) {
    console.log(`已自动停止（等待 ${(i + 1) * 2}s）`)
    process.exit(0)
  }
}
console.log("超时：服务仍在运行")
process.exit(1)
