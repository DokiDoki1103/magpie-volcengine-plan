// magpie 供应商插件：火山方舟订阅（Agent Plan / Coding Plan，走 Anthropic 协议）。
//
// 做什么：
//   - 429 且 error.code == "AccountQuotaExceeded"：从 message 里的 "reset at YYYY-MM-DD HH:MM:SS"
//     （北京时间）取恢复时间，账号暂停到那个时间；期间不再请求火山，直接回一个 429，
//     magpie 会据此切到下一个账号或模型。
//   - 400/403 且 code 是 InvalidSubscription / AccountSuspended / AccountDisabled：
//     回应里加 X-Magpie-Sign-In: expired，magpie 会标记账号、不再往它发请求，直到重新登录。
//   - 手填订阅到期日：到期后不再请求火山。
//   - 可选：账号填了 AccessKey ID / Secret，就用火山控制面查真实额度（5 小时 / 周 / 月），见 quota.mjs。
//
// 状态：每个账号一个 loader 闭包，所以暂停时间放闭包里；同时写进账号 metadata，重启后还在。
//
// 可在 plugins.json 里给这个插件传 options：
//   { "baseURL": "https://ark.cn-beijing.volces.com/api/plan",
//     "models": { "ark-code-latest": { "name": "Ark Code Latest" } } }

import { DEFAULT_REGION, endedNow, fetchUsage, planOf, regionOf } from "./quota.mjs"
import { discoverAccount } from "./discover.mjs"

// 自动识别账号（登录时只填了 ak/sk，metadata.mode === "auto"）：套餐类型、聊天用的 API key、Base URL 都由控制面查出来。
// 识别结果按 AK 缓存 30 分钟；明文 API key 只存在这个内存缓存里，不写盘。
// 请求被 401 拒绝（key 被轮换）时强制重新识别一次再重试，所以换 key 不用管。
const DISCOVERY_TTL = 30 * 60 * 1000
const discoveryCache = new Map() // `${ak}|${region}` -> { value, at }
const discoveryInflight = new Map() // 同一个账号同时多个请求，只识别一次
async function discover(md, { force = false, signal } = {}) {
  const ak = String(md?.accessKeyID ?? "").trim()
  const sk = String(md?.secretAccessKey ?? "").trim()
  const region = String(md?.region ?? "").trim() || DEFAULT_REGION
  const id = `${ak}|${region}`
  const hit = discoveryCache.get(id)
  if (!force && hit && Date.now() - hit.at < DISCOVERY_TTL) return hit.value
  let p = discoveryInflight.get(id)
  if (!p) {
    p = discoverAccount({ ak, sk, region, signal })
      .then((value) => {
        discoveryCache.set(id, { value, at: Date.now() })
        return value
      })
      .catch((e) => {
        // 刷新失败：除了凭据错误，沿用旧结果，1 分钟后再试，不因为一次网络抖动就让账号掉线
        if (hit && e?.kind !== "credential") {
          discoveryCache.set(id, { value: hit.value, at: Date.now() - DISCOVERY_TTL + 60 * 1000 })
          return hit.value
        }
        throw e
      })
      .finally(() => discoveryInflight.delete(id))
    discoveryInflight.set(id, p)
  }
  return p
}

// 识别失败时给 magpie 的回应：凭据不对 / 没套餐要重新登录（带 x-magpie-sign-in），其他的只是失败，magpie 会切号。
const DISCOVERY_FAILURE = {
  credential: { status: 401, type: "authentication_error", signIn: true, label: "AccessKey 不对或没有权限" },
  "no-plan": { status: 403, type: "permission_error", signIn: true, label: "没有识别到订阅" },
  "no-key": { status: 403, type: "permission_error", signIn: false, label: "没有可用的 API key" },
  gate: { status: 403, type: "permission_error", signIn: false, label: "读取 API key 被拒绝" },
  transient: { status: 503, type: "api_error", signIn: false, label: "临时故障，稍后重试" },
}
const discoveryFailure = (e) => DISCOVERY_FAILURE[e?.kind] ?? DISCOVERY_FAILURE.transient
const discoveryMessage = (e) => `火山自动识别失败（${discoveryFailure(e).label}）：${e?.message ?? e}`
function discoveryFailureResponse(e) {
  const f = discoveryFailure(e)
  const body = { type: "error", error: { type: f.type, code: "DiscoveryFailed", message: discoveryMessage(e) } }
  const headers = { "content-type": "application/json", ...(f.signIn ? { "x-magpie-sign-in": "expired" } : {}) }
  return new Response(JSON.stringify(body), { status: f.status, headers })
}

// loader 返回的基地址和识别出来的不一样时（loader 加载时识别失败，用了默认地址），请求时把前缀换掉。
function rewriteBase(input, from, to) {
  if (from === to) return input
  const s = typeof input === "string" ? input : input instanceof URL ? input.href : undefined
  return s && s.startsWith(from) ? to + s.slice(from.length) : input
}
// 请求体能不能重发（401 后换 key 重试一次要用）
const replayable = (body) => body === undefined || body === null || typeof body === "string" || body instanceof Uint8Array || body instanceof ArrayBuffer

// 看起来像 Ark API key：ark- 开头、UUID、或 32 位以上的字母数字串。
// 有 ak/sk 时，行里只剩一项：像 key 就是 key（手填 key + 查额度），否则是名称（自动识别）。
const looksLikeKey = (t) =>
  /^ark-/i.test(t) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(t) || /^[A-Za-z0-9_-]{32,}$/.test(t)

// 套餐到期的来源有两个：
//   1) 账号填了 AK/SK：usage 从控制面读到的真实到期时间（autoSubscription，按 API key 存在内存里）；
//   2) 登录时手填的到期日（metadata.expiresAt），读不到真实值时用它兜底。
// 两个都有时用真实的。到期后 fetch 不再请求火山；自动续费的账号到期那一刻可能正在续，不拦。
const autoSubscription = new Map()
function expiryOf(auth) {
  const auto = autoSubscription.get(auth?.key)
  if (auto) return { endsAt: auto.endsAt, autoRenew: auto.autoRenew, status: auto.status, source: auto.source }
  return { endsAt: parseISO(auth?.metadata?.expiresAt), autoRenew: false, status: "", source: "manual" }
}

const PROVIDER = "volcengine-plan"
// 订阅类型 -> 根地址（等同 ANTHROPIC_BASE_URL 的值，不带 /v1）。
const ENDPOINTS = {
  plan: "https://ark.cn-beijing.volces.com/api/plan",
  coding: "https://ark.cn-beijing.volces.com/api/coding",
}
const DEFAULT_BASE = ENDPOINTS.plan

// 账号里存的是根地址；magpie 的 Anthropic 请求是"基地址 + /messages"，火山的接口是 <根地址>/v1/messages，
// 所以请求时补 /v1（已经以 /v1、/v3 这类结尾的不再补）。实测：不补会得到 404。
function apiBase(root) {
  const u = String(root ?? "").trim().replace(/\/+$/, "")
  return /\/v\d+$/.test(u) ? u : `${u}/v1`
}

// 没有模型列表接口，模型只能手写。这里只是占位，务必在 options.models 里换成订阅里真有的模型 id。
const DEFAULT_MODELS = {
  "ark-code-latest": {
    name: "Ark Code Latest",
    limit: { context: 200000, output: 32000 },
    tool_call: true,
    reasoning: true,
  },
}

const QUOTA_CODE = "AccountQuotaExceeded"
const PERMANENT_CODES = new Set(["InvalidSubscription", "AccountSuspended", "AccountDisabled"])
const RESET_RE = /reset at (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/

const HOUR = 3600 * 1000

// 从响应体里取出 error.code / error.message；兼容 {error:{...}} 和顶层 {code,message} 两种形状。
function parseError(text) {
  if (!text) return {}
  try {
    const j = JSON.parse(text)
    const e = j?.error && typeof j.error === "object" ? j.error : j
    return { code: e?.code ?? e?.type, message: String(e?.message ?? "") }
  } catch {
    return {}
  }
}

// "reset at 2026-11-23 15:00:00" 是北京时间，返回毫秒时间戳；取不到返回 0。
function parseResetTime(message) {
  const m = RESET_RE.exec(message ?? "")
  if (!m) return 0
  const t = Date.parse(`${m[1]}T${m[2]}+08:00`)
  return Number.isNaN(t) ? 0 : t
}

// message 里写着是哪个窗口："You have exceeded the monthly usage quota" / "weekly usage quota"。
// 只确认过 weekly、monthly 两种；别的写法返回原词，由 windowInfo 退回按剩余时间推断。
function windowKind(message) {
  const m = /exceeded the ([\w-]+) usage quota/i.exec(message ?? "")
  return m ? m[1].toLowerCase() : ""
}

const KNOWN_WINDOWS = {
  weekly: { name: "周", span: 7 * 86400 },
  monthly: { name: "月", span: 30 * 86400 },
}

function windowInfo(kind, remainingMs) {
  return KNOWN_WINDOWS[kind] ?? windowFor(remainingMs)
}

// 没写明窗口类型时的兜底：按剩余时间粗分，这是推断。
function windowFor(remainingMs) {
  if (remainingMs <= 5.5 * HOUR) return { name: "5 小时", span: 5 * 3600 }
  if (remainingMs <= 7.5 * 24 * HOUR) return { name: "7 天", span: 7 * 86400 }
  return { name: "月", span: 30 * 86400 }
}

// 去掉首尾空白和末尾的 /；空值返回空字符串
function normalizeBase(v) {
  return String(v ?? "").trim().replace(/\/+$/, "")
}

// 订阅到期日：YYYY-MM-DD（也认 YYYY/M/D），按北京时间当天 23:59:59 到期。返回 ISO 字符串；不合法返回空串。
const DATE_RE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/
function parseExpiry(token) {
  const m = DATE_RE.exec(String(token ?? "").trim())
  if (!m) return ""
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return ""
  const t = Date.parse(`${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}T23:59:59+08:00`)
  return Number.isNaN(t) ? "" : new Date(t).toISOString()
}

// 解析"名称 Base URL API key 到期日 ak=… sk=… region=…"这一行。分隔符：空白、逗号、竖线。
// 以 http:// 或 https:// 开头的是 Base URL，形如 2026-12-31 的是到期日，ak=/sk=/region= 开头的是控制面凭据，
// 这几项位置随意；剩下的两项是 名称、key（顺序固定），只剩一项就是 key。
// ak 和 sk 要一起填（用来查真实额度，可省略）。
const KV_RE = /^(ak|sk|region)=(.*)$/i
function parseAccountLine(line) {
  const all = String(line ?? "").split(/[\s,，|]+/).filter(Boolean)
  if (all.length === 0) return { error: "请填写：名称 API key 到期日（名称、到期日可省略，至少要有 key）；要查真实额度再加 ak=… sk=…" }
  const kv = {}
  const parts = []
  for (const p of all) {
    const m = KV_RE.exec(p)
    if (!m) {
      parts.push(p)
      continue
    }
    const k = m[1].toLowerCase()
    if (k in kv) return { error: `${k}= 只能写一次` }
    kv[k] = m[2].trim()
  }
  if (Boolean(kv.ak) !== Boolean(kv.sk)) return { error: "ak= 和 sk= 要一起填（AccessKey ID 和 Secret），不查真实额度就都不写" }
  const urls = parts.filter((p) => /^https?:\/\//i.test(p))
  if (urls.length > 1) return { error: "只能有一个 Base URL" }
  const dates = parts.filter((p) => DATE_RE.test(p))
  if (dates.length > 1) return { error: "只能有一个到期日" }
  let expiresAt = ""
  if (dates.length === 1) {
    expiresAt = parseExpiry(dates[0])
    if (!expiresAt) return { error: `到期日 ${dates[0]} 不是有效日期，格式是 YYYY-MM-DD` }
  }
  const rest = parts.filter((p) => !/^https?:\/\//i.test(p) && !DATE_RE.test(p))
  const hasCreds = Boolean(kv.ak && kv.sk)
  let key = ""
  let name = ""
  if (rest.length > 2) return { error: "多了一项：名称不能带空格；格式是 名称 API key 到期日 ak=… sk=…" }
  if (rest.length === 2) {
    name = rest[0]
    key = rest[1]
  } else if (rest.length === 1) {
    // 有 ak/sk 时，只剩的这一项像 API key 就是 key，否则是名称（自动识别，不用填 key）
    if (hasCreds && !looksLikeKey(rest[0])) name = rest[0]
    else key = rest[0]
  } else if (!hasCreds) {
    return { error: "缺少 API key（只填 ak= sk= 想让插件自动识别的话，订阅类型请选「自动识别」）" }
  }
  return {
    name,
    baseURL: urls.length ? normalizeBase(urls[0]) : "",
    key,
    expiresAt,
    ak: kv.ak ?? "",
    sk: kv.sk ?? "",
    region: kv.region ?? "",
    auto: hasCreds && !key, // 没有 API key、只有 ak/sk：自动识别
  }
}

function suspendedUntil(auth) {
  const t = Date.parse(auth?.metadata?.suspendUntil ?? "")
  return Number.isNaN(t) ? 0 : t
}

// ISO 字符串 -> 毫秒；空或不合法返回 0
function parseISO(s) {
  const t = Date.parse(s ?? "")
  return Number.isNaN(t) ? 0 : t
}

// 到期日按北京时间显示，如 2026-12-31
function beijingDate(ms) {
  return new Date(ms + 8 * HOUR).toISOString().slice(0, 10)
}

function expiredMessage(expiresAt, status = "") {
  const when = expiresAt > 0 ? `已于 ${beijingDate(expiresAt)} 到期` : `已失效（${status || "状态异常"}）`
  return `火山订阅${when}，已停止调度；续费后重新读取（填了 AK/SK 的账号会自动恢复），或用同名重新添加账号并填新的到期日`
}

function expiredResponse(expiresAt, status = "") {
  const body = {
    type: "error",
    error: { type: "permission_error", code: "SubscriptionExpired", message: expiredMessage(expiresAt, status) },
  }
  return new Response(JSON.stringify(body), {
    status: 403,
    headers: { "content-type": "application/json", "x-magpie-sign-in": "expired" },
  })
}

function quotaResponse(until) {
  const wait = Math.max(1, Math.ceil((until - Date.now()) / 1000))
  const body = {
    type: "error",
    error: {
      type: "rate_limit_error",
      code: QUOTA_CODE,
      message: `火山额度已用尽，账号暂停调度，恢复时间 ${new Date(until).toISOString()}`,
    },
  }
  return new Response(JSON.stringify(body), {
    status: 429,
    headers: { "content-type": "application/json", "retry-after": String(wait) },
  })
}

// 真实额度的缓存：magpie 会反复读 usage，控制面每次都要签名请求，所以按 ak+套餐+地区缓存。成功 60 秒，失败 30 秒。
const quotaCache = new Map()
async function quotaFor(auth, defaultBase, signal) {
  const md = auth?.metadata ?? {}
  const ak = String(md.accessKeyID ?? "").trim()
  const sk = String(md.secretAccessKey ?? "").trim()
  if (!ak || !sk) return undefined // 没填 AK/SK：不查，也不报错打扰
  const root = normalizeBase(md.baseURL) || defaultBase
  const plan = planOf(root)
  if (plan === "unknown") return undefined // 按量付费等没有额度接口
  const region = String(md.region ?? "").trim() || regionOf(root)
  const id = `${ak}|${plan}|${region}`
  const hit = quotaCache.get(id)
  if (hit && Date.now() < hit.expires) return hit.value
  let value
  let ttl
  try {
    value = { ok: await fetchUsage({ ak, sk, region, plan, signal }) }
    ttl = 60 * 1000
  } catch (e) {
    value = { error: String(e?.message ?? e) }
    ttl = 30 * 1000
  }
  quotaCache.set(id, { value, expires: Date.now() + ttl })
  return value
}

export const VolcenginePlanPlugin = async ({ client }, options = {}) => {
  const base = options.baseURL ?? DEFAULT_BASE
  const models = options.models ?? DEFAULT_MODELS

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: "火山方舟订阅",
        npm: "@ai-sdk/anthropic",
        api: apiBase(base), // 同样是基地址，后面会拼 /messages，所以也要补 /v1
        models,
      }
    },

    auth: {
      provider: PROVIDER,
      // 添加账号只问一次（magpie 界面会把多个 prompts 拆成"下一步"），所以三项写在一个输入框里，空格分隔：
      //   名称 Base URL API key        例：主力 https://ark.cn-beijing.volces.com/api/plan/v1 ark-xxxx
      //   名称 API key                 Base URL 用默认地址
      //   API key                      只有 key
      // 名称和 Base URL 每个账号各自一份，存在账号 metadata 里。名称同时作 accountId：
      // magpie 用它给账号命名，重名的登录会替换旧账号。
      methods: [
        {
          type: "api",
          label: "火山方舟账号",
          prompts: [
            // 订阅类型下拉：选"自动识别"只要写 ak/sk，套餐类型、API key、地址全自动；
            // 选 plan / coding 就不用写地址（但要自己填 API key）；选"自定义"才在下一行里写 Base URL。
            {
              type: "select",
              key: "type",
              message: "订阅类型",
              options: [
                { label: "自动识别", value: "auto", hint: "只填 ak/sk：套餐类型、API key、地址、到期、额度全自动" },
                { label: "plan", value: "plan", hint: ENDPOINTS.plan },
                { label: "coding", value: "coding", hint: ENDPOINTS.coding },
                { label: "自定义地址", value: "custom", hint: "在下一行里写 Base URL" },
              ],
            },
            {
              type: "text",
              key: "account",
              message: "自动识别：名称 ak=… sk=…；手填 key：名称 API key 到期日 ak=… sk=…（空格分隔，名称、到期日都可省略；选了自定义地址时还要写 Base URL）",
              placeholder: "主力 ak=AKLT… sk=…",
              validate: (v) => parseAccountLine(v).error,
            },
          ],
          async authorize(inputs) {
            const r = parseAccountLine(inputs?.account)
            if (r.error) return { type: "failed", error: r.error }
            const type = String(inputs?.type ?? "")
            if (type === "auto" && !r.ak) return { type: "failed", error: "自动识别要在这一行里写 ak=… sk=…（火山账号的 AccessKey ID 和 Secret）" }
            if (type === "auto" && r.key) return { type: "failed", error: "自动识别不用填 API key（插件用 AK/SK 自己去取）；要手填 API key 请选 plan / coding" }
            // 自动识别：存 AccessKey ID 当"key"（它不是机密，也让同一个 AK 再次添加时替换旧账号）。
            // 聊天用的 API key 不存盘，运行时由控制面取。套餐类型和地址也是运行时识别的，所以不存 baseURL。
            if (r.auto) {
              return {
                type: "success",
                key: r.ak,
                accountId: r.name || undefined,
                metadata: {
                  name: r.name,
                  mode: "auto",
                  accessKeyID: r.ak,
                  secretAccessKey: r.sk,
                  ...(r.region ? { region: r.region } : {}),
                  ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), // 兜底：控制面读不到到期时间时用
                },
              }
            }
            // 地址来源：这一行里写了的最优先；否则按下拉选的类型；没选就不存，用默认地址。
            if (type === "custom" && !r.baseURL) return { type: "failed", error: "选了自定义地址，请在这一行里写上 Base URL（http:// 或 https:// 开头）" }
            r.baseURL = r.baseURL || ENDPOINTS[type] || ""
            // accountId 就是卡片的大标题：magpie 在登录这一刻把它记成账号的显示名，之后不会变。
            // 同名再次登录会按 accountId 替换旧账号。不写 metadata.email、usage 也不返回 user：
            // 标题只由登录时的名称决定，不会和别处对不上。没填名称就用 magpie 默认的"API key …尾号"。
            return {
              type: "success",
              key: r.key,
              accountId: r.name || undefined,
              metadata: {
                name: r.name,
                ...(r.baseURL ? { baseURL: r.baseURL } : {}),
                ...(r.expiresAt ? { expiresAt: r.expiresAt } : {}), // 手填的订阅到期时间
                // 控制面凭据（可选）：只发往 open.volcengineapi.com，用来查真实额度，不参与聊天请求
                ...(r.ak ? { accessKeyID: r.ak, secretAccessKey: r.sk } : {}),
                ...(r.region ? { region: r.region } : {}),
              },
            }
          },
        },
      ],

      // loader 每个账号运行一次，闭包里的变量就是这个账号自己的状态。
      async loader(getAuth) {
        const auth = await getAuth()
        if (auth?.type !== "api") return {}
        let until = suspendedUntil(auth)

        // 迁移：上一版曾把名称同时写进 metadata.email，会让 magpie 把账号当成有身份的账号、页面没有"改 key"。
        // 只清掉和 name 相同的 email（是我们自己写的），真有别的邮箱不动。保存后 loader 会按新内容重新运行。
        if (auth.metadata?.email && auth.metadata.email === auth.metadata.name) {
          const { email, ...rest } = auth.metadata
          try {
            await client.auth.set({ path: { id: PROVIDER }, body: { ...auth, metadata: rest } })
          } catch {
            // 迁移失败不影响使用
          }
        }

        // 自动识别的账号：套餐类型、API key、地址都由控制面查出来（见 discover.mjs）。
        // 加载时识别不了也要让账号出现在列表里，请求时再试，并给出具体原因。
        const auto = auth.metadata?.mode === "auto"
        let found
        const ensure = async (opts) => {
          found = await discover(auth.metadata, opts)
          if (found?.subscription) autoSubscription.set(auth.key, found.subscription)
          return found
        }
        if (auto) {
          try {
            await ensure()
          } catch {
            // 请求时再试
          }
        }

        // 每个账号可以有自己的 Base URL；没填的（包括之前添加的账号）用默认地址
        const accountBase = auto ? found?.root || base : normalizeBase(auth.metadata?.baseURL) || base
        const loaderApi = apiBase(accountBase)

        const suspend = async (resetAt, raw, kind) => {
          until = resetAt
          try {
            await client.auth.set({
              path: { id: PROVIDER },
              body: {
                ...auth,
                metadata: {
                  ...auth.metadata,
                  suspendUntil: new Date(resetAt).toISOString(),
                  suspendWindow: kind,
                  suspendBody: raw.slice(0, 500),
                },
              },
            })
          } catch {
            // 保存失败不影响本次内存里的暂停
          }
        }

        return {
          baseURL: loaderApi,
          async fetch(input, init) {
            // 聊天用的 API key：手填的账号是保存的 key；自动识别的账号是控制面取来的（只在内存里）。
            let apiKey = auth.key
            if (auto) {
              try {
                await ensure()
              } catch (e) {
                return discoveryFailureResponse(e)
              }
              apiKey = found.key
              input = rewriteBase(input, loaderApi, apiBase(found.root))
            }
            // 订阅已到期：不打上游，回 403 并标记需要重新登录，magpie 会切到别的账号。
            // 到期时间每次请求现取（真实值可能在 usage 里更新），续费后读到新的到期时间就自动恢复。
            const ex = expiryOf(auth)
            if (endedNow(ex)) return expiredResponse(ex.endsAt, ex.status)
            // 暂停期内不打上游，直接回 429 让 magpie 切号
            if (until > Date.now()) return quotaResponse(until)

            const send = (k) => {
              const headers = new Headers(init?.headers)
              headers.set("x-api-key", k)
              headers.set("authorization", `Bearer ${k}`)
              return fetch(input, { ...init, headers })
            }
            let res = await send(apiKey)
            // 自动识别的账号被 401 拒绝：key 可能被轮换了。强制重新取一次，换了就重试一次。
            if (auto && res.status === 401 && replayable(init?.body)) {
              try {
                const again = await ensure({ force: true })
                if (again.key !== apiKey) res = await send(again.key)
              } catch {
                // 刷新失败就把原来的 401 交给 magpie
              }
            }

            if (res.status === 429) {
              const text = await res.clone().text()
              const { code, message } = parseError(text)
              if (code === QUOTA_CODE) {
                const resetAt = parseResetTime(message)
                if (resetAt > Date.now()) await suspend(resetAt, text, windowKind(message))
              }
              return res
            }

            if (res.status === 400 || res.status === 403) {
              const text = await res.clone().text()
              const { code } = parseError(text)
              if (PERMANENT_CODES.has(code)) {
                const h = new Headers(res.headers)
                h.set("x-magpie-sign-in", "expired")
                return new Response(text, { status: res.status, statusText: res.statusText, headers: h })
              }
            }
            return res
          },
        }
      },

      // 额度：
      //   - 账号填了 ak/sk：用控制面查真实的 5 小时 / 周 / 月（quota.mjs），路由据此在接近用完时把账号排后面；
      //   - 没填：只有撞到 429 后暂停的那个窗口（周 / 月，取自 429 里的原话）。
      //   两种都有时，429 是事实，按名字覆盖进真实窗口（used 至少 100、重置时间取 429 里的）。
      async usage(getAuth, _provider, ctx = {}) {
        const auth = await getAuth()
        const until = suspendedUntil(auth)
        const now = Date.now()
        // 自动识别的账号：先识别，拿到套餐类型和地址再查额度。识别不了就直接说明原因：
        // 凭据不对 / 没订阅 => 标成需要重新登录；其他（没 key、被拒绝、临时故障）只显示原因。
        const isAuto = auth?.metadata?.mode === "auto"
        let md = auth?.metadata ?? {}
        if (isAuto) {
          try {
            const f = await discover(md, { signal: ctx?.signal })
            md = { ...md, baseURL: f.root }
            if (f.subscription) autoSubscription.set(auth.key, f.subscription)
          } catch (e) {
            return { plan: "火山方舟订阅", error: discoveryMessage(e), signIn: discoveryFailure(e).signIn ? "expired" : "kept", windows: [] }
          }
        }
        // magpie 的账号卡片没有 Base URL 这一项，借一个只带 display 的窗口把它显示出来。
        // aside: true：路由从不读它，用完与否都不影响账号调度。
        const baseWindow = {
          name: "Base URL",
          display: normalizeBase(md.baseURL) || base,
          aside: true,
        }
        // 真实额度和套餐到期（可选，要有 AK/SK）。失败只带 error，不动账号的登录状态：
        // 聊天用的 API key 是好的，AK/SK 错不该让账号下线。已到期的账号也要查：续费后读到新的到期时间才能自动恢复。
        const q = await quotaFor(isAuto ? { ...auth, metadata: md } : auth, base, ctx?.signal)
        if (q?.ok?.subscription) autoSubscription.set(auth.key, q.ok.subscription)
        // 到期时间交给 magpie 的 until，卡片会显示，"到期前用完"路由模式也读它。读到真实值就不用手填。
        // 到期后 fetch 会直接拦截（见 loader），这里同步标成需要重新登录，并说明原因。
        const ex = expiryOf(auth)
        const expired = endedNow(ex, now)
        const plan = expired ? "火山方舟订阅（已到期）" : "火山方舟订阅"
        const until2 = ex.endsAt ? { until: new Date(ex.endsAt).toISOString() } : {}
        const renew = ex.source !== "manual" ? { renew: ex.autoRenew ? "auto" : "off" } : {}
        if (expired) {
          return { plan, ...until2, ...renew, error: expiredMessage(ex.endsAt, ex.status), signIn: "expired", windows: [baseWindow] }
        }
        let windows = q?.ok ? q.ok.windows.map((w) => ({ ...w })) : []
        const planLabel = q?.ok ? q.ok.plan : plan
        // 名称已经是卡片标题（登录时的 accountId），这里不再重复显示。
        if (until > now) {
          const w = windowInfo(auth.metadata?.suspendWindow, until - now)
          const at = windows.findIndex((x) => x.name === w.name)
          if (at >= 0) {
            windows[at] = { ...windows[at], used: Math.max(100, windows[at].used), resetsAt: new Date(until).toISOString() }
          } else {
            windows.push({ name: w.name, used: 100, resetsAt: new Date(until).toISOString(), span: w.span })
          }
        }
        return {
          plan: planLabel,
          ...until2,
          ...renew,
          ...(q?.error ? { error: q.error, signIn: "kept" } : {}),
          windows: [...windows, baseWindow],
        }
      },
    },
  }
}

// 不要从入口导出辅助函数（每个导出的函数都会被当成插件调用），测试要用的放在对象上。
export const _internal = { discover, discoveryCache, discoveryInflight, looksLikeKey, rewriteBase, quotaFor, quotaCache, autoSubscription, expiryOf, parseError, parseResetTime, windowFor, windowKind, windowInfo, suspendedUntil, normalizeBase, parseAccountLine, parseExpiry, beijingDate, apiBase, ENDPOINTS, QUOTA_CODE, PERMANENT_CODES }
