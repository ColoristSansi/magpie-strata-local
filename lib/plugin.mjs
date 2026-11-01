// 插件本体：供应商声明、无需登录的 key、请求前确保服务在跑、给 agent 的启停工具。

import { PROVIDER_ID, ICON, baseUrl, configDirectory, resolveOptions } from "./options.mjs"
import { StrataService } from "./strata.mjs"

const DISPLAY_NAME = "Strata 本地模型"
const MODEL_NAME = "Qwen3.8-Flash-Next Q2_0"
const SEAT_LABELS = {
  chat: "Chat",
  messages: "Messages",
  responses: "Responses",
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const noop = () => {}

// OpenCode 的 tool() 只是给定义加类型；args 也可以直接是 JSON Schema。
// 本插件不依赖 @opencode-ai/plugin，所以这里用同形状的恒等函数。
const tool = (definition) => definition

const NO_ARGS = { type: "object", properties: {}, additionalProperties: false }

function buildModels(options, live = {}) {
  const base = baseUrl(options).replace(/\/+$/, "")
  const apiModelId = live.model || options.apiModelId || "strata"
  const context = live.contextTokens || options.contextTokens
  const shared = {
    id: apiModelId,
    limit: { context, output: options.outputTokens },
    reasoning: true,
    tool_call: true,
    attachment: true,
    modalities: { input: ["text", "image"], output: ["text"] },
    cost: { input: 0, output: 0 },
    free: true,
  }

  const models = {}
  if (options.seats.chat) {
    models["strata-chat"] = {
      ...shared,
      name: `${MODEL_NAME} · ${SEAT_LABELS.chat}（本地）`,
    }
  }
  if (options.seats.messages) {
    models["strata-messages"] = {
      ...shared,
      name: `${MODEL_NAME} · ${SEAT_LABELS.messages}（本地）`,
      provider: { npm: "@ai-sdk/anthropic", api: `${base}/v1` },
    }
  }
  if (options.seats.responses) {
    models["strata-responses"] = {
      ...shared,
      name: `${MODEL_NAME} · ${SEAT_LABELS.responses}（本地）`,
      provider: { npm: "@ai-sdk/openai", api: `${base}/v1` },
    }
  }
  return models
}

// provider.models 钩子返回的是完整 Model 形状（api.id / api.url / api.npm），
// 每个座位在这里明确自己的协议——config 里的 provider 覆盖只是宿主尚未列出模型时的起点。
function fullModels(options, live = {}, baseOverride) {
  const base = (baseOverride || baseUrl(options)).replace(/\/+$/, "")
  const apiId = live.model || options.apiModelId || "strata"
  const context = live.contextTokens || options.contextTokens

  const row = (key, name, npm) => ({
    id: key,
    providerID: PROVIDER_ID,
    name,
    api: { id: apiId, url: `${base}/v1`, npm },
    limit: { context, output: options.outputTokens },
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, image: true },
      output: { text: true },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    variants: {},
    options: {},
    headers: {},
    status: "active",
    release_date: "",
    free: true,
  })

  const models = {}
  if (options.seats.chat) {
    models["strata-chat"] = row(
      "strata-chat",
      `${MODEL_NAME} · ${SEAT_LABELS.chat}（本地）`,
      "@ai-sdk/openai-compatible",
    )
  }
  if (options.seats.messages) {
    models["strata-messages"] = row(
      "strata-messages",
      `${MODEL_NAME} · ${SEAT_LABELS.messages}（本地）`,
      "@ai-sdk/anthropic",
    )
  }
  if (options.seats.responses) {
    models["strata-responses"] = row(
      "strata-responses",
      `${MODEL_NAME} · ${SEAT_LABELS.responses}（本地）`,
      "@ai-sdk/openai",
    )
  }
  return models
}

function errorResponse(url, status, message) {
  const isMessages = /\/messages(?:\?|$)/.test(url)
  const body = isMessages
    ? {
        type: "error",
        error: { type: status === 503 ? "overloaded_error" : "api_error", message },
      }
    : { error: { message, type: "strata_unavailable", code: "strata_unavailable" } }
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

export function createStrataPlugin(input, rawOptions) {
  const options = resolveOptions(input, rawOptions)
  const logger = (message) => {
    try {
      console.log(`[strata] ${message}`)
    } catch {
      /* 宿主可能已经关闭 */
    }
  }
  const service = new StrataService(options, {
    configDir: configDirectory(input),
    logger,
  })

  // 空闲自动停止的计时器；宿主退出时 unref 不会拖住进程。
  service.installIdleTimer()

  // 插件宿主起来后就把服务拉起来，用户点开模型时通常已经加载完。
  if (options.autoStart) {
    const timer = setTimeout(() => service.kickStart("plugin-load"), 1500)
    timer.unref?.()
  }

  const authSeats = [
    {
      key: "noAutoStart",
      label: "不随 Magpie 自动启动",
      description: "关（默认）：插件宿主启动后自动执行 strata launch；开：只在请求到来或手动调用工具时启动。",
      default: false,
    },
    {
      key: "noIdleStop",
      label: "不自动停止（常驻）",
      description:
        "关（默认）：本插件启动的 Strata 在连续 idleStopMinutes 分钟没有请求后自动停止（默认 30 分钟）；开：只能手动停止。",
      default: false,
    },
  ]

  return {
    async config(cfg) {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
        name: DISPLAY_NAME,
        npm: "@ai-sdk/openai-compatible",
        api: `${baseUrl(options).replace(/\/+$/, "")}/v1`,
        models: buildModels(options),
      }
    },

    auth: {
      provider: PROVIDER_ID,
      icon: ICON,
      maxConcurrency: options.maxConcurrency,
      options: authSeats,
      methods: [
        {
          type: "api",
          label: "本地 Strata（无需密钥，直接确认即可）",
          placeholder: options.apiKey,
          async authorize() {
            // 本地服务不校验 key；给一个非空值让 AI SDK 满足校验。
            return { type: "success", key: options.apiKey }
          },
        },
      ],
      async loader(getAuth) {
        let auth
        try {
          auth = await getAuth()
        } catch {
          auth = undefined
        }
        const key =
          (auth && auth.type === "api" && typeof auth.key === "string" && auth.key) || options.apiKey
        // 地址由服务对象给出：如果本机已有 Strata 跑在别的端口，这里用的是发现到的地址。
        const base = (await service.readyBase()).replace(/\/+$/, "")
        return {
          baseURL: `${base}/v1`,
          apiKey: key,
          async fetch(requestUrl, init) {
            service.requestStarted()
            try {
              const state = await service.ensureReady("request")
              if (!state.ready) {
                return errorResponse(
                  requestUrl,
                  503,
                  state.message || `Strata 未就绪（${service.base}）。`,
                )
              }
              return await fetch(requestUrl, init)
            } catch (error) {
              return errorResponse(
                requestUrl,
                502,
                `无法连接本地 Strata（${service.base}）：${error?.message || error}`,
              )
            } finally {
              service.requestEnded()
            }
          },
        }
      },
    },

    provider: {
      id: PROVIDER_ID,
      async models(provider) {
        // 列模型时顺手把服务拉起来（不阻塞列表返回）。
        service.kickStart("models")
        const status = await service.status()
        // 服务在线时用 /health 报告的模型名与上下文覆盖静态值；
        // 返回完整 Model 形状，每个座位明确自己的 api.npm（Chat / Messages / Responses）。
        return fullModels(
          options,
          {
            model: status.up ? status.model : undefined,
            contextTokens: status.up ? status.maxContext : undefined,
          },
          service.base,
        )
      },
    },

    tool: {
      status: tool({
        description:
          "查看本地 Strata 模型服务的状态：是否运行、模型是否加载完、API 地址、由谁启动、空闲多久、最近的启动/停止输出。",
        args: NO_ARGS,
        async execute() {
          return await service.report()
        },
      }),
      start: tool({
        description:
          "启动本地 Strata 模型服务（strata launch）。默认立即返回、后台加载；wait=true 时最多再等 45 秒。",
        args: {
          type: "object",
          properties: {
            wait: {
              type: "boolean",
              description: "是否等到模型加载完成（最多 45 秒，工具总时限 55 秒）",
            },
          },
          additionalProperties: false,
        },
        async execute(args = {}) {
          const starting = service.start("tool")
          if (args.wait === true) {
            await Promise.race([starting.catch(noop), sleep(45000)])
          } else {
            starting.catch(noop)
          }
          const report = await service.report()
          return {
            ok: report.ready,
            message: report.ready
              ? `Strata 已就绪：${report.api}`
              : report.running
                ? "Strata 进程在线，模型仍在加载"
                : "Strata 启动中（模型加载通常 15-60 秒）",
            ...report,
          }
        },
      }),
      stop: tool({
        description: "停止本地 Strata 模型服务（strata launch --stop），释放显存。",
        args: NO_ARGS,
        async execute() {
          const result = await Promise.race([
            service.stop("tool"),
            sleep(50000).then(() => ({ ok: true, pending: true, message: "停止命令仍在执行" })),
          ])
          const { output, ...rest } = result
          return { ...rest, cliOutput: output, status: await service.report() }
        },
      }),
      logs: tool({
        description: "查看插件最近一次 strata launch / --stop 的输出和动作记录，用于排查启动失败。",
        args: NO_ARGS,
        async execute() {
          return {
            cli: options.cliPath || service.ensureCli() || "",
            lastAction: service.lastAction,
            lastOutput: service.lastOutput || "(还没有启动或停止过)",
          }
        },
      }),
    },
  }
}
