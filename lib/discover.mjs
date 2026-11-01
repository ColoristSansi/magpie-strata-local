// 找到本机的 strata 命令，以及本机已经在跑的 Strata 实例。
//
// 顺序：显式配置 → 环境变量 → PATH → 常见安装位置 → 名称扫描 → 上次找到的缓存。
// 已经在跑的实例用 `strata launch --status --output json` 读（端口随便改都能找到），
// CLI 不在时再按候选端口探 /health。

import { spawnSync } from "node:child_process"
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

const WIN = process.platform === "win32"
const CLI_NAMES = WIN ? ["strata.cmd", "strata.exe", "strata.bat", "strata"] : ["strata"]

// 扫描时跳过的目录：装 Strata 不可能在这些里面，跳过能省掉最多的时间。
const SKIP = new Set([
  "node_modules",
  ".git",
  ".cache",
  "Cache",
  "Code Cache",
  "GPUCache",
  "Temp",
  "tmp",
  "Windows",
  "WinSxS",
  "site-packages",
  "__pycache__",
  "AppData", // USERPROFILE 根下的；LOCALAPPDATA 本身仍会作为根单独扫
  "Microsoft",
  "Packages",
  ".venv",
])

function pathLookup() {
  const found = []
  try {
    const lookup = WIN ? "where" : "which"
    for (const name of WIN ? ["strata.cmd", "strata.exe", "strata"] : ["strata"]) {
      const result = spawnSync(lookup, [name], { encoding: "utf8", windowsHide: true, timeout: 5000 })
      const lines = String(result.stdout || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && existsSync(line))
      found.push(...lines)
    }
  } catch {
    /* PATH 上没有就是没有 */
  }
  return found
}

function wellKnownCandidates() {
  if (!WIN) return []
  const env = process.env
  const roots = [
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Strata"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Strata"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "chocolatey", "bin"),
    env.APPDATA && join(env.APPDATA, "Strata"),
    env.PROGRAMFILES && join(env.PROGRAMFILES, "Strata"),
    env["PROGRAMFILES(X86)"] && join(env["PROGRAMFILES(X86)"], "Strata"),
    env.ProgramW6432 && join(env.ProgramW6432, "Strata"),
    env.ProgramData && join(env.ProgramData, "Strata"),
    env.USERPROFILE && join(env.USERPROFILE, "Strata"),
    env.USERPROFILE && join(env.USERPROFILE, ".strata"),
    env.USERPROFILE && join(env.USERPROFILE, "scoop", "apps", "strata", "current"),
  ].filter(Boolean)

  const out = []
  for (const root of roots) {
    out.push(join(root, "strata.cmd"))
    out.push(join(root, "bin", "strata.cmd"))
    out.push(join(root, "terminal", "current", "bin", "strata.cmd"))
    out.push(join(root, ".venv", "Scripts", "strata.cmd"))
    // terminal\<版本号>\bin
    try {
      for (const name of readdirSync(join(root, "terminal"))) {
        out.push(join(root, "terminal", name, "bin", "strata.cmd"))
      }
    } catch {
      /* 没有 terminal 目录 */
    }
  }
  return out
}

/** 深度受限的目录扫描：找 `...\terminal\current\bin\strata.cmd`、`...\bin\strata.cmd` 或 strata.cmd 本身。 */
function scanForCli({ depth = 4, budget = 6000 } = {}) {
  if (!WIN) return ""
  const env = process.env
  const roots = [
    env.LOCALAPPDATA,
    env.PROGRAMFILES,
    env["PROGRAMFILES(X86)"],
    env.ProgramW6432,
    env.ProgramData,
    env.USERPROFILE,
  ].filter(Boolean)

  const queue = roots.map((dir) => ({ dir, level: 0 }))
  let visited = 0
  while (queue.length && visited < budget) {
    const { dir, level } = queue.shift()
    visited += 1
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          if (level >= depth || SKIP.has(entry.name)) continue
          for (const candidate of [
            join(full, "terminal", "current", "bin", "strata.cmd"),
            join(full, "bin", "strata.cmd"),
          ]) {
            if (existsSync(candidate)) return candidate
          }
          queue.push({ dir: full, level: level + 1 })
        } else if (entry.isFile() && CLI_NAMES.includes(entry.name)) {
          return full
        }
      } catch {
        /* 权限问题跳过 */
      }
    }
  }
  return ""
}

function readCache(cachePath) {
  if (!cachePath) return ""
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf8"))
    if (parsed && typeof parsed.cli === "string" && parsed.cli && existsSync(parsed.cli)) return parsed.cli
  } catch {
    /* 没有缓存 */
  }
  return ""
}

function writeCache(cachePath, cli) {
  if (!cachePath || !cli) return
  try {
    writeFileSync(cachePath, JSON.stringify({ cli, foundAt: new Date().toISOString() }, null, 2))
  } catch {
    /* 缓存写不了不影响使用 */
  }
}

/**
 * 找到可用的 strata 命令。
 * @param {object} options 插件选项
 * @param {string} cachePath 缓存文件（magpie 配置目录下）
 * @returns {string} 找到的路径，找不到时返回空字符串（POSIX 上优先返回 PATH 里的 "strata"）
 */
export function discoverCli(options = {}, cachePath = "") {
  if (options.cliPath && existsSync(options.cliPath)) return options.cliPath
  if (process.env.STRATA_CLI && existsSync(process.env.STRATA_CLI)) return process.env.STRATA_CLI

  const cached = readCache(cachePath)
  if (cached) return cached

  for (const candidate of [...pathLookup(), ...wellKnownCandidates()]) {
    if (candidate && existsSync(candidate)) {
      writeCache(cachePath, candidate)
      return candidate
    }
  }

  const scanned = scanForCli({ depth: options.scanDepth ?? 4 })
  if (scanned) {
    writeCache(cachePath, scanned)
    return scanned
  }

  // 非 Windows 上最后退回 PATH：由 shell 去解析。
  return WIN ? "" : "strata"
}

/** 从混杂的输出里取出第一个完整的 JSON 对象（`--output json` 后面可能跟着人类可读的行）。 */
function firstJsonObject(text) {
  const source = String(text || "")
  const start = source.indexOf("{")
  if (start < 0) return ""
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === "\\") escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === "{") depth += 1
    else if (ch === "}") {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  return ""
}

/** 从 `strata launch --status --output json` 的输出里取运行中的实例。 */
export function parseRunning(text) {
  const json = firstJsonObject(text)
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    const running = Array.isArray(parsed?.running) ? parsed.running : []
    return running
      .filter((entry) => entry && typeof entry === "object")
      .map((entry) => ({
        name: entry.name,
        profile: entry.profile,
        state: entry.state,
        port: Number(entry.port) || undefined,
        url: typeof entry.url === "string" ? entry.url.replace(/\/+$/, "") : undefined,
      }))
      .filter((entry) => entry.url || entry.port)
  } catch {
    return []
  }
}

/** 这条命令旁边有没有自带 Python（有就直接调用它，不经过 cmd.exe）。 */
export function bundledPython(cli) {
  if (!WIN) return null
  try {
    const root = dirname(dirname(cli))
    const python = join(root, "python", "python.exe")
    const app = join(root, "strata.py")
    if (existsSync(python) && existsSync(app)) return { python, app, root }
  } catch {
    /* 路径怪就退回 cli 本身 */
  }
  return null
}