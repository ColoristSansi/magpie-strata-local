// Strata 本地服务的启停与就绪探测。
//
// 关键事实（来自本机 strata 0.1.49.2 / 引擎 0.1.55）：
//   - `strata launch ... --no-tui` 会打印地址后返回，引擎自己以独立进程运行，
//     所以插件不需要长期持有子进程；`strata launch --stop` 负责停止。
//   - `%LOCALAPPDATA%\Strata\terminal\current\bin\strata.cmd` 只是一个 Python 启动器；
//     直接调用它旁边的 `python\python.exe strata.py ...` 可以不经过 cmd.exe，
//     不会闪窗口，参数也不用转义。
//   - 就绪信号用 HTTP：/health 返回 {service:"strata", loaded:true, model, max_context}。

import { spawn } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { bundledPython, discoverCli, parseRunning } from "./discover.mjs"

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noop = () => {}

function tail(text, lines = 6) {
  const parts = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  return parts.slice(-lines).join(" | ")
}

function quoteIfNeeded(value) {
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value
}

function killTree(child) {
  if (!child) return
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      }).unref?.()
    } else {
      child.kill("SIGKILL")
    }
  } catch {
    /* 进程可能已经退出 */
  }
}

export class StrataService {
  constructor(options, { configDir, logger } = {}) {
    this.options = options
    this.configuredBase = (options.baseUrl || `http://127.0.0.1:${options.port}`).replace(/\/+$/, "")
    this.base = this.configuredBase
    this.discoveredBy = ""
    this.configDir = configDir || ""
    this.cliCachePath = configDir ? join(configDir, ".magpie-strata-cli.json") : ""
    this.logger = logger || noop
    this.inflight = 0
    this.lastUsed = Date.now()
    this.owned = this.readMarker()
    this.lastAction = null
    this.lastOutput = ""
    this._starting = null
    this._stopping = null
    this._statusCache = null
    this._statusAt = 0
    this._discoverAt = 0
    this._discovering = false
    this._discoverPromise = null
    this._timer = null
  }

  /** 实际在用的端口（可能来自发现到的运行实例）。 */
  get activePort() {
    try {
      return Number(new URL(this.base).port) || this.options.port
    } catch {
      return this.options.port
    }
  }

  get markerPath() {
    return this.configDir ? join(this.configDir, ".magpie-strata-owned.json") : ""
  }

  readMarker() {
    if (!this.markerPath) return false
    try {
      const parsed = JSON.parse(readFileSync(this.markerPath, "utf8"))
      return parsed && Number(parsed.port) === Number(this.options.port)
    } catch {
      return false
    }
  }

  async writeMarker() {
    if (!this.markerPath) return
    try {
      await mkdir(dirname(this.markerPath), { recursive: true })
      await writeFile(
        this.markerPath,
        JSON.stringify({ port: this.activePort, startedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      )
    } catch (error) {
      this.logger(`写所有权标记失败：${error?.message || error}`)
    }
  }

  async clearMarker() {
    if (!this.markerPath) return
    await rm(this.markerPath, { force: true }).catch(noop)
  }

  // ── 就绪探测 ────────────────────────────────────────────────────────
  async probeAt(url, timeoutMs = 1500) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetch(`${url.replace(/\/+$/, "")}/health`, {
        signal: controller.signal,
        headers: { "cache-control": "no-store" },
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) return { up: false, httpStatus: response.status, error: `HTTP ${response.status}` }
      const looksStrata =
        body && (body.service === "strata" || typeof body.loaded === "boolean" || typeof body.model === "string")
      if (!looksStrata) return { up: false, foreign: true, error: "端口上不是 Strata（/health 结构不符）" }
      return {
        up: true,
        loaded: body.loaded !== false,
        model: body.model,
        maxContext: body.max_context ?? body.maxContext,
        apiKeyRequired: Boolean(body.api_key),
        health: body,
      }
    } catch (error) {
      return { up: false, error: String(error?.name === "AbortError" ? "探测超时" : error?.message || error) }
    } finally {
      clearTimeout(timer)
    }
  }

  async probe(timeoutMs = 1500) {
    return await this.probeAt(this.base, timeoutMs)
  }

  /** 换用另一个地址（发现到的运行实例），地址变了才重置缓存。 */
  adopt(url, via) {
    const clean = url.replace(/\/+$/, "")
    if (clean === this.base) return false
    this.base = clean
    this.discoveredBy = via
    this._statusCache = null
    this._statusAt = 0
    return true
  }

  /**
   * 本机已经有 Strata 在跑、但不在配置的端口上时，找到它：
   * 先问 CLI（`launch --status` 的 url 就是真实端口），CLI 不在再按候选端口探 /health。
   */
  async tryDiscover() {
    if (!this.options.discover) return null
    // 并发调用共用同一次发现，避免一个请求还在找、另一个就判定“没在跑”并去启动。
    if (this._discoverPromise) return await this._discoverPromise
    const now = Date.now()
    if (now - this._discoverAt < 15000) return null
    this._discoverAt = now
    this._discovering = true
    this._discoverPromise = this._runDiscover().finally(() => {
      this._discovering = false
      this._discoverPromise = null
    })
    return await this._discoverPromise
  }

  async _runDiscover() {
    try {
      if (this.ensureCli()) {
        const status = await this.launchStatus()
        const entries = status.running || []
        const entry =
          entries.find((item) => item.state === "ready") ||
          entries.find((item) => item.state === "starting") ||
          entries[0]
        if (entry?.url) {
          if (entry.url !== this.base && (await this.probeAt(entry.url)).up) {
            this.adopt(entry.url, "strata launch --status")
            this.logger(`发现运行中的 Strata（${entry.name || "launch"}）：${entry.url}`)
            return { ...entry, via: "launch-status" }
          }
        }
      }
      for (const port of this.options.portCandidates) {
        const url = `http://127.0.0.1:${Number(port)}`
        if (url === this.base) continue
        if ((await this.probeAt(url)).up) {
          this.adopt(url, `端口扫描 ${port}`)
          this.logger(`发现运行中的 Strata 服务：${url}`)
          return { url, via: "port-scan" }
        }
      }
    } catch {
      /* 发现失败不影响正常流程 */
    }
    return null
  }

  async status({ fresh = false } = {}) {
    const now = Date.now()
    if (!fresh && this._statusCache && now - this._statusAt < this.options.statusTtlMs) {
      return this._statusCache
    }
    let probe = await this.probe()
    if (!probe.up && this.options.discover) {
      const found = await this.tryDiscover()
      if (found) probe = await this.probe()
    }
    const result = {
      ...probe,
      ready: probe.up && probe.loaded !== false,
      url: this.base,
      port: this.activePort,
      discoveredBy: this.discoveredBy,
    }
    this._statusCache = result
    this._statusAt = now
    return result
  }

  /** 用当前（可能发现到的）地址拼出的 baseURL，供 loader 使用。 */
  async readyBase() {
    try {
      await this.status()
    } catch {
      /* 探测失败就用配置的地址 */
    }
    return this.base
  }

  async waitFor(check, timeoutMs, intervalMs = 1500) {
    const deadline = Date.now() + Math.max(0, timeoutMs)
    for (;;) {
      if (await check()) return true
      const left = deadline - Date.now()
      if (left <= 0) return (await check()) === true
      await sleep(Math.min(intervalMs, left))
    }
  }

  // ── 命令 ────────────────────────────────────────────────────────────
  launchArgs() {
    const o = this.options
    return [
      "launch",
      "--model",
      o.model,
      "--context",
      o.context,
      "--vision",
      o.vision,
      "--access",
      o.access,
      "--port",
      String(o.port),
      "--tune",
      o.tune,
      "--yes",
      "--no-tui",
      ...o.extraArgs,
    ]
  }

  /** 解析 strata 命令：显式路径 → 环境变量 → PATH → 常见安装位置 → 目录扫描。结果写缓存。 */
  ensureCli() {
    if (this.options.cliPath && existsSync(this.options.cliPath)) return this.options.cliPath
    const now = Date.now()
    // 找不到时最多每分钟重试一次，避免每次请求都去扫盘。
    if (now - (this._cliAt || 0) < 60000) return this.options.cliPath || ""
    this._cliAt = now
    const found = discoverCli(this.options, this.cliCachePath)
    if (found) {
      this.options.cliPath = found
      this.logger(`找到 strata 命令：${found}`)
    }
    return found
  }

  invocation(args) {
    const cli = this.ensureCli()
    const env = { ...process.env, PYTHONUTF8: "1", ...this.options.env }
    if (env.STRATA_SOURCE === undefined) env.STRATA_SOURCE = "modelscope"
    if (env.HF_ENDPOINT === undefined) env.HF_ENDPOINT = "https://hf-mirror.com"

    if (process.platform !== "win32") {
      return { ok: true, file: cli || "strata", args, env }
    }
    if (!cli || !existsSync(cli)) {
      return {
        ok: false,
        error: `找不到 strata 命令（已查找 PATH、LOCALAPPDATA/Program Files 等常见位置）。请安装 Strata Terminal，或用 plugins.json 的 options.cliPath / 环境变量 STRATA_CLI 指定 strata.cmd 的路径。`,
      }
    }
    // 优先直接调用自带的 Python，绕开 cmd.exe（无窗口、无引号问题）。
    const bundled = bundledPython(cli)
    if (bundled) {
      env.PYTHONNOUSERSITE = "1"
      delete env.PYTHONHOME
      delete env.PYTHONPATH
      return { ok: true, file: bundled.python, args: [bundled.app, ...args], cwd: bundled.root, env }
    }
    if (/\.(cmd|bat)$/i.test(cli)) {
      const command = [quoteIfNeeded(cli), ...args.map(quoteIfNeeded)].join(" ")
      return { ok: true, file: command, args: [], env, shell: true }
    }
    return { ok: true, file: cli, args, env }
  }

  run(args, { timeoutMs }) {
    const call = this.invocation(args)
    if (!call.ok) return Promise.resolve({ ok: false, code: -1, output: call.error })
    return new Promise((resolve) => {
      let stdout = ""
      let stderr = ""
      let settled = false
      let timedOut = false
      let child
      const cap = (text) => (text.length > 80000 ? text.slice(-80000) : text)
      try {
        child = spawn(call.file, call.args, {
          cwd: call.cwd,
          env: call.env,
          shell: call.shell === true,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        })
      } catch (error) {
        resolve({ ok: false, code: -1, output: String(error?.message || error) })
        return
      }
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }
      const timer = setTimeout(() => {
        timedOut = true
        killTree(child)
      }, timeoutMs)
      timer.unref?.()
      child.stdout?.on("data", (chunk) => {
        stdout = cap(stdout + chunk)
      })
      child.stderr?.on("data", (chunk) => {
        stderr = cap(stderr + chunk)
      })
      child.on("error", (error) => {
        finish({ ok: false, code: -1, output: cap(`${stdout}\n${stderr}\n${error?.message || error}`) })
      })
      child.on("close", (code) => {
        const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
        finish({ ok: code === 0 && !timedOut, code, timedOut, output })
      })
    })
  }

  // ── 启动 / 停止 ─────────────────────────────────────────────────────
  start(reason = "manual") {
    if (this._starting) return this._starting
    this._starting = this._start(reason).finally(() => {
      this._starting = null
    })
    return this._starting
  }

  async _start(reason) {
    const before = await this.status({ fresh: true })
    if (before.ready) {
      this.lastUsed = Date.now()
      return { ok: true, alreadyRunning: true, ready: true, message: `Strata 已在 ${this.base} 运行`, status: before }
    }
    const claimed = !before.up
    if (claimed && this.base !== this.configuredBase) {
      // 发现到的实例已经不在了：回到配置的端口启动，别对着空地址等。
      this.adopt(this.configuredBase, "")
    }
    this.lastAction = { action: "start", at: new Date().toISOString(), reason }
    if (claimed) {
      // 先记所有权：magpie 的插件宿主可能比模型加载先退出，
      // 标记落盘后，空闲停止仍能在下一次宿主启动时接手。
      this.owned = true
      await this.writeMarker()
    }
    this.logger(`启动 Strata（${reason}）…`)
    const args = this.launchArgs()
    const run = await this.run(args, { timeoutMs: this.options.startTimeoutMs })
    this.lastOutput = run.output
    if (!run.ok) {
      this.logger(`strata launch 返回 ${run.code}${run.timedOut ? "（超时）" : ""}：${tail(run.output, 3)}`)
    }
    // launch 返回时通常已经在服务；首次启动（下载/调优）可能还要等。
    const ready = await this.waitFor(
      async () => (await this.status({ fresh: true })).ready,
      this.options.startTimeoutMs,
    )
    const status = await this.status({ fresh: true })
    if (ready) {
      this.lastUsed = Date.now()
      if (this.base === this.configuredBase) {
        // 只有“是我们启动的”才写标记；只是搭上别人的实例时不写。
        if (this.owned) await this.writeMarker()
      } else {
        // 就绪的是别人启动的实例（发现到的地址）：不接管所有权，也不自动停它。
        this.owned = false
        await this.clearMarker()
      }
      return {
        ok: true,
        ready: true,
        message: `Strata 已就绪：${this.base}`,
        output: tail(run.output),
        status,
      }
    }
    return {
      ok: false,
      ready: false,
      starting: !run.timedOut && Boolean(status.up || !run.ok),
      message: status.up
        ? `Strata 进程在线但模型尚未加载完成（${this.base}）。`
        : `启动失败：${tail(run.output) || `退出码 ${run.code}`}`,
      output: tail(run.output),
      status,
    }
  }

  stop(reason = "manual") {
    if (this._stopping) return this._stopping
    this._stopping = this._stop(reason).finally(() => {
      this._stopping = null
    })
    return this._stopping
  }

  async _stop(reason) {
    const before = await this.status({ fresh: true })
    if (!before.up) {
      this.owned = false
      await this.clearMarker()
      return { ok: true, alreadyStopped: true, message: "Strata 未在运行" }
    }
    this.lastAction = { action: "stop", at: new Date().toISOString(), reason }
    this.logger(`停止 Strata（${reason}）…`)
    const run = await this.run(["launch", "--stop"], { timeoutMs: this.options.stopTimeoutMs })
    this.lastOutput = run.output
    const down = await this.waitFor(
      async () => !(await this.status({ fresh: true })).up,
      this.options.stopTimeoutMs,
    )
    if (down) {
      this.owned = false
      this._statusCache = null
      this.adopt(this.configuredBase, "")
      await this.clearMarker()
      return { ok: true, message: "Strata 已停止", output: tail(run.output) }
    }
    return {
      ok: false,
      message: `停止超时：${this.base} 仍有响应。`,
      output: tail(run.output),
      status: await this.status({ fresh: true }),
    }
  }

  /** 请求路径上的“用到就启动”。最多等 requestWaitMs，不阻塞到模型加载完。 */
  async ensureReady(reason = "request") {
    const status = await this.status()
    if (status.ready) {
      this.lastUsed = Date.now()
      return { ready: true, status }
    }
    if (!this.options.autoStart) {
      return { ready: false, status, starting: false, message: "Strata 未运行，且插件选项 autoStart 已关闭。" }
    }
    // 不 await：冷启动可能几十秒，请求侧只等到 requestWaitMs。
    this.start(reason).catch(noop)
    if (this.options.requestWaitMs <= 0) {
      return { ready: false, status, starting: true, message: `Strata 正在启动（${this.base}）…` }
    }
    const ready = await this.waitFor(
      async () => (await this.status({ fresh: true })).ready,
      this.options.requestWaitMs,
    )
    if (ready) {
      this.lastUsed = Date.now()
      return { ready: true, status: await this.status({ fresh: true }) }
    }
    return {
      ready: false,
      starting: true,
      status: await this.status({ fresh: true }),
      message: `Strata 正在加载模型（首次约 15-60 秒）。地址 ${this.base}，稍后重试即可。`,
    }
  }

  kickStart(reason = "background") {
    if (!this.options.autoStart) return
    this.status()
      .then((status) => {
        if (!status.ready) return this.start(reason)
      })
      .catch(noop)
  }

  // ── 请求计数与空闲停止 ──────────────────────────────────────────────
  requestStarted() {
    this.inflight += 1
    this.lastUsed = Date.now()
  }

  requestEnded() {
    this.inflight = Math.max(0, this.inflight - 1)
    this.lastUsed = Date.now()
  }

  installIdleTimer() {
    if (this._timer) return
    const every = Math.max(5, this.options.idleCheckSeconds) * 1000
    this._timer = setInterval(() => {
      this.idleTick().catch(noop)
    }, every)
    this._timer.unref?.()
  }

  async idleTick() {
    if (!this.options.idleStopEnabled) return
    if (!this.owned) return
    if (this.inflight > 0) return
    if (this._starting || this._stopping) return
    const idleMs = Date.now() - this.lastUsed
    if (idleMs < this.options.idleStopMinutes * 60000) return
    this.logger(`空闲 ${Math.round(idleMs / 60000)} 分钟，停止 Strata`)
    await this.stop("idle")
  }

  async launchStatus() {
    const run = await this.run(["launch", "--status", "--output", "json"], { timeoutMs: 20000 })
    return { ok: run.ok, running: parseRunning(run.output), output: tail(run.output) }
  }

  async report() {
    const status = await this.status({ fresh: true })
    return {
      provider: "strata-local",
      running: Boolean(status.up),
      ready: Boolean(status.ready),
      modelLoaded: status.up ? status.loaded !== false : false,
      api: this.base,
      endpoints: {
        chat: `${this.base}/v1/chat/completions`,
        messages: `${this.base}/v1/messages`,
        responses: `${this.base}/v1/responses`,
        health: `${this.base}/health`,
      },
      model: status.model || this.options.apiModelId,
      contextTokens: status.maxContext || this.options.contextTokens,
      port: this.activePort,
      configuredPort: this.options.port,
      discoveredBy: this.discoveredBy || "",
      ownedByPlugin: this.owned,
      idleStopMinutes: this.options.idleStopEnabled ? this.options.idleStopMinutes : 0,
      idleSeconds: Math.round((Date.now() - this.lastUsed) / 1000),
      inFlight: this.inflight,
      starting: Boolean(this._starting),
      stopping: Boolean(this._stopping),
      lastAction: this.lastAction,
      lastOutput: this.lastOutput ? tail(this.lastOutput, 3) : "",
      cli: this.options.cliPath || this.ensureCli() || "",
    }
  }
}
