// 火山方舟控制面取额度（可选功能：账号填了 AccessKey ID / Secret 才会用到）。
//
// 签名（SigV4 风格）、控制面调用、额度窗口解析移植自 hzk8000/magpie-ark（MIT, Copyright (c) 2026 hzk），
// 见 NOTICE。差异：窗口名用中文，套餐类型从账号地址（/api/plan、/api/coding）推断，不依赖 /v3。
//
// 取数路径：
//   Coding Plan  -> GetCodingPlanUsage
//   Agent Plan   -> GetSeatInfo -> GetAgentPlanSeatAFPUsage（团队版，额度属于席位）
//                   没有席位（个人计划）才回退 GetAFPUsage
//
// AccessKey 只发往 open.volcengineapi.com；数据面（聊天）用账号的 Ark API key，和这里无关。

import { createHash, createHmac } from "node:crypto"

const OPENAPI = { url: "https://open.volcengineapi.com", host: "open.volcengineapi.com" }
const API_VERSION = "2024-01-01"
const SERVICE = "ark"
export const DEFAULT_REGION = "cn-beijing"

const str = (v) => (typeof v === "string" ? v.trim() : "")
const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.trim() !== "") {
    const f = Number(v.trim())
    if (Number.isFinite(f)) return f
  }
  return undefined
}

// 窗口名（和 429 暂停里用的名字一致，才能按名字合并）：5 小时 / 周 / 月
const WIN = [
  ["5 小时", "AFPFiveHour", 5 * 3600],
  ["周", "AFPWeekly", 7 * 24 * 3600],
  ["月", "AFPMonthly", 30 * 24 * 3600],
]
const CODING_LEVELS = {
  session: ["5 小时", 5 * 3600],
  weekly: ["周", 7 * 24 * 3600],
  monthly: ["月", 30 * 24 * 3600],
}

// 计数显示：有额度就 "已用 / 总额"，只有百分比就 "n%"。
function displayOf(amount, limit, used) {
  if (limit > 0 && amount !== undefined) {
    const round = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, ""))
    return `${round(amount)} / ${round(limit)}`
  }
  return `${used.toFixed(1)}%`
}

// 复位时间可能是 epoch 秒、epoch 毫秒或 RFC 3339。
function iso(v) {
  if (typeof v === "string" && v.trim()) {
    const t = Date.parse(v)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  const n = num(v)
  if (n === undefined || n <= 0) return undefined
  return new Date(n > 1e11 ? n : n * 1000).toISOString()
}

// Agent Plan 的三个 bucket。一个 bucket 没有配额时不在套餐里，跳过。
export function windowsOf(buckets) {
  const out = []
  if (!buckets || typeof buckets !== "object") return out
  for (const [name, key, span] of WIN) {
    const b = buckets[key]
    if (!b || typeof b !== "object") continue
    const used = num(b.Used)
    const limit = num(b.Quota) ?? num(b.Total)
    const percent = num(b.Percent)
    const counts = used !== undefined && limit !== undefined && limit > 0
    if (percent === undefined && !counts) continue
    const pct = percent !== undefined ? percent : (100 * used) / limit
    const resetsAt = iso(b.ResetTime) ?? iso(b.ResetTimestamp)
    out.push({
      name,
      used: Math.round(pct * 100) / 100,
      ...(counts ? { amount: used, limit } : {}),
      display: displayOf(counts ? used : undefined, counts ? limit : undefined, pct),
      span,
      ...(resetsAt ? { resetsAt } : {}),
    })
  }
  return out
}

// GetCodingPlanUsage 的 QuotaUsage：Percent 是已用比例，ResetTimestamp 是秒。
export function codingWindows(result) {
  const out = []
  for (const u of Array.isArray(result?.QuotaUsage) ? result.QuotaUsage : []) {
    const level = CODING_LEVELS[str(u?.Level).toLowerCase()]
    const used = num(u?.Percent)
    if (!level || used === undefined) continue
    out.push({
      name: level[0],
      used: Math.round(used * 100) / 100,
      display: `${used.toFixed(1)}%`,
      span: level[1],
      ...(iso(u?.ResetTimestamp) ? { resetsAt: iso(u?.ResetTimestamp) } : {}),
    })
  }
  return out
}

// 账号地址 -> 套餐类型。地址是根地址（.../api/plan、.../api/coding），后面可能带 /v1、/v3。
export function planOf(base) {
  let path = ""
  try {
    path = new URL(base).pathname.replace(/\/+$/, "") + "/"
  } catch {
    return "unknown"
  }
  if (path.startsWith("/api/coding/")) return "coding"
  if (path.startsWith("/api/plan/")) return "agent"
  return "unknown" // 按量付费等：没有额度接口
}

export function regionOf(base) {
  try {
    const labels = new URL(base).hostname.toLowerCase().split(".")
    if (labels.length === 4 && labels[0] === "ark" && labels[1]) return labels[1]
  } catch {}
  return DEFAULT_REGION
}

const hex = (b) => createHash("sha256").update(b).digest("hex")
const mac = (key, s) => createHmac("sha256", key).update(s).digest()

// 签名：canonical request 的头按字典序，scope 是 date/region/ark/request，密钥从 Secret 逐级派生。
export function sign({ ak, sk, region, query, body, xDate, host = OPENAPI.host }) {
  const date = xDate.slice(0, 8)
  const contentSHA = hex(body)
  const signed = "content-type;host;x-content-sha256;x-date"
  const canonical = [
    "POST",
    "/",
    query,
    "content-type:application/json\n" + "host:" + host + "\n" + "x-content-sha256:" + contentSHA + "\n" + "x-date:" + xDate + "\n",
    signed,
    contentSHA,
  ].join("\n")
  const scope = `${date}/${region}/${SERVICE}/request`
  const toSign = ["HMAC-SHA256", xDate, scope, hex(canonical)].join("\n")
  let key = mac(sk, date)
  for (const s of [region, SERVICE, "request"]) key = mac(key, s)
  const signature = createHmac("sha256", key).update(toSign).digest("hex")
  return {
    "Content-Type": "application/json",
    "X-Date": xDate,
    "X-Content-Sha256": contentSHA,
    Accept: "application/json",
    Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
  }
}

const pad = (n) => String(n).padStart(2, "0")

// 调一次控制面 action，返回 Result；火山在 ResponseMetadata 里报的错误按原文抛出（err.code 是火山的错误码）。
// host 默认是 open.volcengineapi.com；有的接口（GetPersonalPlan）社区工具用地域域名 ark.<region>.volcengineapi.com。
export async function call({ ak, sk, region, action, body = {}, signal, host = OPENAPI.host }) {
  const now = new Date()
  const xDate =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}T` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`
  const query = `Action=${encodeURIComponent(action)}&Version=${API_VERSION}`
  const payload = JSON.stringify(body)
  const headers = sign({ ak, sk, region, query, body: payload, xDate, host })
  const res = await fetch(`https://${host}/?${query}`, {
    method: "POST",
    headers,
    body: payload,
    ...(signal ? { signal } : {}),
  })
  const raw = await res.text()
  let env
  try {
    env = JSON.parse(raw)
  } catch {
    throw new Error(`Volcengine ${action}: ${res.status} ${raw.slice(0, 200)}`)
  }
  const e = env?.ResponseMetadata?.Error
  if (e && (e.Code || e.Message)) {
    const hint = /accesskey|signature|accessdenied|unauthorized|forbidden|credential|authfailure/i.test(str(e.Code))
      ? "；检查 AccessKey ID / Secret 以及该 AK 是否允许 ark 控制面（IAM）"
      : ""
    const err = new Error(`Volcengine ${action}: ${str(e.Code)} ${str(e.Message)}${hint}`)
    err.code = str(e.Code)
    throw err
  }
  if (!res.ok) throw new Error(`Volcengine ${action}: ${res.status} ${raw.slice(0, 200)}`)
  return env?.Result ?? {}
}

// 到期时间字符串 -> 毫秒。真实返回的格式没见过：认 RFC3339、"YYYY-MM-DD HH:MM:SS"（没写时区按北京时间）、
// 以及秒/毫秒时间戳。解析不了返回 0。
export function timeMs(v) {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v > 1e11 ? v : v * 1000
  const s = str(v)
  if (!s) return 0
  if (/^\d{9,13}$/.test(s)) return timeMs(Number(s))
  let t = Date.parse(s)
  if (Number.isNaN(t) && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) t = Date.parse(s.replace(" ", "T") + (s.length === 16 ? ":00" : "") + "+08:00")
  return Number.isNaN(t) ? 0 : t
}

// 个人版套餐：档位 / 状态 / 生效与到期 / 自动续费。没订阅或已回收返回 null（那是"没有这个套餐"，不是故障）。
// 先试地域域名，再试 open.volcengineapi.com；火山的业务错误（没套餐）直接定论，其余错误换域名再试一次。
export async function getPersonalPlan({ ak, sk, region, plan, signal }) {
  const hosts = [`ark.${region}.volcengineapi.com`, OPENAPI.host]
  let last
  for (const host of hosts) {
    try {
      const r = await call({
        ak,
        sk,
        region,
        host,
        action: "GetPersonalPlan",
        body: { Plan: plan === "coding" ? "CodingPlan" : "AgentPlan" },
        signal,
      })
      if (!str(r?.PlanType) && !str(r?.Status)) return null
      return {
        planType: str(r.PlanType),
        status: str(r.Status),
        endsAt: timeMs(r.EndTime),
        autoRenew: r.AutoRenew === true,
      }
    } catch (e) {
      if (e?.code === "ResourceNotFound.Plan") return null
      last = e
    }
  }
  throw last
}

// 套餐是否已经结束：Status 是回收/过期，或者到期时间已过且没有自动续费（自动续费的账号到期那一刻可能正在续，不拦）。
export function endedNow({ endsAt = 0, autoRenew = false, status = "" } = {}, now = Date.now()) {
  if (/reclaimed|expired/i.test(status)) return true
  return endsAt > 0 && endsAt <= now && !autoRenew
}

// 套餐到期（尽力而为）：个人版走 GetPersonalPlan；团队版席位自带 ExpiredTime，就不用再问。
// 取不到不影响额度，返回 undefined。
async function subscriptionOf({ ak, sk, region, plan, signal, seatExpiredTime }) {
  const seatEnds = timeMs(seatExpiredTime)
  if (seatEnds) return { endsAt: seatEnds, autoRenew: false, status: "", source: "seat" }
  try {
    const p = await getPersonalPlan({ ak, sk, region, plan, signal })
    return p ? { endsAt: p.endsAt, autoRenew: p.autoRenew, status: p.status, source: "personal-plan" } : undefined
  } catch {
    return undefined
  }
}

// 取一个账号的真实额度和套餐到期。返回 { plan, windows, subscription? }；额度取不到抛错（信息已带中文提示）。
export async function fetchUsage({ ak, sk, region, plan, signal }) {
  if (plan === "coding") {
    const r = await call({ ak, sk, region, action: "GetCodingPlanUsage", signal })
    const ws = codingWindows(r)
    if (!ws.length) {
      // 真实返回：没有 coding 套餐 / 已回收的账号，这里给的是 {"Status":"Reclaimed","UpdateTimestamp":…} 而不是窗口。
      // 那是"订阅已经没了"，当作订阅结束（插件会据此停止调度），不是故障。
      const status = str(r?.Status)
      if (/reclaimed|expired/i.test(status)) {
        return { plan: "Coding Plan", windows: [], subscription: { endsAt: 0, autoRenew: false, status, source: "coding-plan" } }
      }
      throw new Error("GetCodingPlanUsage 没有窗口：该 AK 可能不在 Coding Plan 上")
    }
    const subscription = await subscriptionOf({ ak, sk, region, plan, signal })
    return { plan: "Coding Plan", windows: ws, ...(subscription ? { subscription } : {}) }
  }
  // Agent Plan：团队版的额度属于席位，个人计划没有席位。
  let tier = ""
  let seatExpiredTime
  try {
    const seat = await call({
      ak,
      sk,
      region,
      action: "GetSeatInfo",
      body: { ProjectName: "default", Scene: "agent_plan_enterprise" },
      signal,
    })
    const id = str(seat?.SeatID)
    tier = str(seat?.BizInfo)
    seatExpiredTime = seat?.ExpiredTime
    if (id) {
      const r = await call({ ak, sk, region, action: "GetAgentPlanSeatAFPUsage", body: { SeatIDs: [id] }, signal })
      const s = Array.isArray(r?.SeatAFPUsages) ? r.SeatAFPUsages[0] : undefined
      const ws = windowsOf(s)
      if (ws.length) {
        const subscription = await subscriptionOf({ ak, sk, region, plan, signal, seatExpiredTime })
        return {
          plan: `Agent Plan${str(s?.PlanType) || tier ? " " + (str(s?.PlanType) || tier) : ""}`,
          windows: ws,
          ...(subscription ? { subscription } : {}),
        }
      }
    }
  } catch {
    // 没有席位（个人计划）或 GetSeatInfo 不被允许：按账号范围再问一次
  }
  const r = await call({ ak, sk, region, action: "GetAFPUsage", signal })
  const ws = windowsOf(r)
  if (!ws.length) throw new Error("GetAFPUsage 没有窗口：该 AK 可能不在 Agent Plan 上")
  const subscription = await subscriptionOf({ ak, sk, region, plan, signal })
  // 档位：真实返回的字段是 PlanType（"medium"）；社区工具里写的 Tier 也兼容。
  const tierName = str(r?.PlanType) || str(r?.Tier)
  return { plan: `Agent Plan${tierName ? " " + tierName : ""}`, windows: ws, ...(subscription ? { subscription } : {}) }
}
