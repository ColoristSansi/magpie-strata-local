// 发现逻辑的实测：假装插件装在另一台电脑上——端口不是 18777、cliPath 是错的，
// 看它能不能自己找到真实的 strata 命令和正在运行的实例。
//   node scripts/discover-test.mjs
import { StrataService } from "../lib/strata.mjs"
import { configDirectory, resolveOptions } from "../lib/options.mjs"

const configDir = configDirectory({ directory: process.env.USERPROFILE + "/.config/magpie" })

const options = resolveOptions(
  { directory: configDir, magpie: { option: () => undefined } },
  { port: 8080, cliPath: "C:\\definitely-not-here\\strata.cmd", discover: true },
)
const service = new StrataService(options, { configDir, logger: (m) => console.log("[discover]", m) })

const status = await service.status({ fresh: true })
console.log("发现结果：", {
  running: status.up,
  ready: status.ready,
  api: service.base,
  port: service.activePort,
  discoveredBy: service.discoveredBy,
  cli: options.cliPath,
})

if (!status.up) {
  console.log("跳过：本机此刻没有运行中的 Strata（先 start 再测）")
  process.exit(2)
}
if (service.activePort !== 18777) {
  console.error("失败：没有采用真实端口 18777")
  process.exit(1)
}
if (!options.cliPath || !options.cliPath.toLowerCase().endsWith("strata.cmd")) {
  console.error("失败：没有找到 strata 命令")
  process.exit(1)
}

// 关掉发现时应该回到配置的端口、并且不再找实例。
const isolated = new StrataService(
  resolveOptions({ magpie: { option: () => undefined } }, { port: 8080, discover: false }),
  { configDir: "", logger: () => {} },
)
const isolatedStatus = await isolated.status({ fresh: true })
console.log("discover=false：", { running: isolatedStatus.up, api: isolated.base })
if (isolatedStatus.up) {
  console.error("失败：discover=false 仍然发现到了实例")
  process.exit(1)
}

console.log("discover ok")
process.exit(0)