// 插件选项：把 plugins.json / 插件编辑器里的开关收成一份运行配置。
// 所有字段都有默认值，缺省即“开箱可用”。

import { homedir } from "node:os"
import { join } from "node:path"

export const PROVIDER_ID = "strata-local"
export const DEFAULT_PORT = 18777
export const ICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect x='1' y='1' width='30' height='30' rx='8' fill='%230f172a'/%3E%3Cpath d='M8 22.5 16 8l8 14.5' stroke='%2338bdf8' stroke-width='2.2' fill='none' stroke-linejoin='round'/%3E%3Cpath d='M11.5 18.5h9' stroke='%2322d3ee' stroke-width='2.2' stroke-linecap='round'/%3E%3Ccircle cx='16' cy='8' r='2.2' fill='%2334d399'/%3E%3C/svg%3E"

const DEFAULTS = {
  autoStart: true, // 插件宿主启动后自动拉起 Strata
  idleStopMinutes: 30, // 空闲多久后自动停止；0 = 关
  idleCheckSeconds: 60, // 空闲检查的间隔
  requestWaitMs: 25000, // 一个请求最多等冷启动多久（要短于客户端的请求超时）
  startTimeoutMs: 300000, // 启动命令 + 等待就绪的上限（首次可能要下载模型）
  stopTimeoutMs: 90000, // 等待停止的上限
  statusTtlMs: 3000, // 就绪状态的缓存时间，避免每个请求都探测 /health
  maxConcurrency: 2,
  port: DEFAULT_PORT,
  model: "q2_0",
  apiModelId: "strata", // Strata 接受任意模型名；connect 用的是 strata
  context: "256k",
  contextTokens: 262144,
  outputTokens: 32768,
  vision: "on",
  access: "local",
  tune: "skip",
  apiKey: "local", // 本地服务不校验 key，任意非空值即可
  extraArgs: [],
  seats: { chat: true, messages: true, responses: true },
  cliPath: "",
  discover: true, // 自动找 strata 命令和已经在本机运行的实例
  portCandidates: [18777, 8080], // CLI 找不到实例时，按这些端口探 /health
  scanDepth: 4, // 目录扫描深度（只在常见位置都没找到时才用）
  env: {},
}

function asBool(value, fallback) {
  if (typeof value === "boolean") return value
  if (value === "true" || value === 1) return true
  if (value === "false" || value === 0) return false
  return fallback
}

function asNumber(value, fallback) {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10)
  return Number.isFinite(n) ? n : fallback
}

/** "256k" / 262144 -> 262144 */
export function parseContext(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) return value
  const text = String(value ?? "").trim().toLowerCase()
  const match = /^(\d+(?:\.\d+)?)\s*([km])?$/.exec(text)
  if (!match) return fallback
  const n = Number.parseFloat(match[1])
  const unit = match[2]
  if (unit === "k") return Math.round(n * 1024)
  if (unit === "m") return Math.round(n * 1024 * 1024)
  return Math.round(n)
}

export function defaultCliPath() {
  if (process.env.STRATA_CLI) return process.env.STRATA_CLI
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
    return join(local, "Strata", "terminal", "current", "bin", "strata.cmd")
  }
  return "strata"
}

/** 插件自己能存文件的地方：magpie 的配置目录。 */
export function configDirectory(input) {
  if (input && typeof input.directory === "string" && input.directory) return input.directory
  if (process.env.XDG_CONFIG_HOME) return join(process.env.XDG_CONFIG_HOME, "magpie")
  return join(homedir(), ".config", "magpie")
}

/**
 * @param input 插件工厂拿到的 input（可能没有 magpie.option）
 * @param raw   plugins.json 里这一项的 options
 */
export function resolveOptions(input, raw) {
  const o = raw && typeof raw === "object" ? raw : {}
  const seat = o.seats && typeof o.seats === "object" ? o.seats : {}

  const optionSwitch = (key, fallback) => {
    try {
      const value = input?.magpie?.option?.(PROVIDER_ID, key)
      return typeof value === "boolean" ? value : fallback
    } catch {
      return fallback
    }
  }

  const context = o.context ?? DEFAULTS.context
  // 供应商编辑器里的开关：magpie 对没拨过的开关一律返回 false，
  // 所以用「关闭 X」这种默认 false 的开关，再取反。
  const noAutoStart = optionSwitch("noAutoStart", false)
  const noIdleStop = optionSwitch("noIdleStop", false)
  const autoStart = !noAutoStart && asBool(o.autoStart, DEFAULTS.autoStart)
  const idleEnabled = !noIdleStop && asNumber(o.idleStopMinutes, DEFAULTS.idleStopMinutes) > 0

  return {
    ...DEFAULTS,
    ...o,
    autoStart,
    idleStopEnabled: idleEnabled,
    idleStopMinutes: idleEnabled ? asNumber(o.idleStopMinutes, DEFAULTS.idleStopMinutes) : 0,
    idleCheckSeconds: Math.max(5, asNumber(o.idleCheckSeconds, DEFAULTS.idleCheckSeconds)),
    requestWaitMs: Math.max(0, asNumber(o.requestWaitMs, DEFAULTS.requestWaitMs)),
    startTimeoutMs: Math.max(10000, asNumber(o.startTimeoutMs, DEFAULTS.startTimeoutMs)),
    stopTimeoutMs: Math.max(5000, asNumber(o.stopTimeoutMs, DEFAULTS.stopTimeoutMs)),
    statusTtlMs: Math.max(0, asNumber(o.statusTtlMs, DEFAULTS.statusTtlMs)),
    maxConcurrency: Math.min(1000, Math.max(1, asNumber(o.maxConcurrency, DEFAULTS.maxConcurrency))),
    port: Math.max(1, asNumber(o.port, DEFAULT_PORT)),
    context,
    contextTokens: asNumber(o.contextTokens, parseContext(context, DEFAULTS.contextTokens)),
    outputTokens: Math.max(1, asNumber(o.outputTokens, DEFAULTS.outputTokens)),
    apiKey: typeof o.apiKey === "string" && o.apiKey ? o.apiKey : DEFAULTS.apiKey,
    extraArgs: Array.isArray(o.extraArgs) ? o.extraArgs.map(String) : [],
    seats: {
      chat: asBool(seat.chat ?? o.chatSeat, DEFAULTS.seats.chat),
      messages: asBool(seat.messages ?? o.messagesSeat, DEFAULTS.seats.messages),
      responses: asBool(seat.responses ?? o.responsesSeat, DEFAULTS.seats.responses),
    },
    cliPath: typeof o.cliPath === "string" ? o.cliPath : "",
    discover: asBool(o.discover, DEFAULTS.discover),
    portCandidates: Array.isArray(o.portCandidates)
      ? o.portCandidates.map((value) => asNumber(value, 0)).filter((value) => value > 0)
      : DEFAULTS.portCandidates,
    scanDepth: Math.min(8, Math.max(1, asNumber(o.scanDepth, DEFAULTS.scanDepth))),
    env: o.env && typeof o.env === "object" ? o.env : {},
  }
}

export function baseUrl(options) {
  return options.baseUrl || `http://127.0.0.1:${options.port}`
}
