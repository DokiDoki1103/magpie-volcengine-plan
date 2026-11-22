// 全自动识别：只凭 AccessKey ID / Secret 找到 套餐类型、聊天用的 API key、Base URL、到期。
//
// 流程（个人版 Agent Plan 已用真实账号验证；Coding 个人版和团队版按火山官方 ark-cli 文档实现，未验证）：
//   1) 套餐类型：对 AgentPlan、CodingPlan 各调一次 GetPersonalPlan，有套餐的返回数据，没有的返回 ResourceNotFound.Plan。
//      都没有再看团队版席位（GetSeatInfo，agent_plan_enterprise / coding_plan_enterprise）。
//   2) API key（套餐专用，普通账号级 key 打 /api/plan 会 401）：
//        Agent 个人版  ListApiKeys(Filter.Scene="RealAgentPlanPersonal") -> GetRawApiKey({Id})
//        Coding 个人版 ListApiKeys（普通池）                              -> GetRawApiKey({Id})
//        团队版        GetSeatInfo.Result.ApiKey
//      ListApiKeys 返回的 Key 是打码的，明文只能靠 GetRawApiKey。
//   3) Base URL：Agent -> /api/plan，Coding -> /api/coding。
//
// 明文 key 只在内存里用，不写盘。只调只读接口，不轮换、不创建、不禁用。
// 官方文档提醒 GetRawApiKey 是敏感凭证读取，个人版可能被协议/Access 闸门拒绝：被拒就如实报告，不绕。

import { call, getPersonalPlan, endedNow, timeMs } from "./quota.mjs"

const PROJECT = "default"
const str = (v) => (typeof v === "string" ? v.trim() : "")

// 识别失败的种类，调用方据此决定怎么回应：
//   credential 凭据不对 / 没权限 -> 要重新填 AK/SK
//   no-plan    没有任何套餐（没订阅或已回收）
//   no-key     有套餐但没有可用的专属 key
//   gate       读取明文 key 被拒绝（协议 / Access 闸门）
//   transient  网络等临时故障，稍后重试
export class DiscoveryError extends Error {
  constructor(kind, message) {
    super(message)
    this.name = "DiscoveryError"
    this.kind = kind
  }
}

const CREDENTIAL_RE = /accesskey|signature|accessdenied|unauthorized|forbidden|credential|authfailure|notlogin/i
// 火山的业务错误都带 code；没有 code 的是网络层故障
const isCredentialError = (e) => CREDENTIAL_RE.test(String(e?.code ?? ""))

export const rootFor = (plan, region) => `https://ark.${region}.volces.com/api/${plan === "agent" ? "plan" : "coding"}`

// 多把 key 时的选择：Active 的里面，优先"全部资源"范围，再取最近用过的；并列取靠前的。
// （官方文档不让盲取第一把，这里把选择规则定死，并在结果里带上 key 的名字，方便排查。）
function pickKey(items) {
  const active = items.filter((i) => i?.Status === "Active")
  const scoreScope = (i) => (Array.isArray(i.ResourceInstances) && i.ResourceInstances.some((r) => r?.ResourceType === "all") ? 1 : 0)
  const seen = (i) => timeMs(i.LastAccessTime)
  return [...active].sort((a, b) => scoreScope(b) - scoreScope(a) || seen(b) - seen(a))[0]
}

async function personalKey({ ak, sk, region, plan, signal }) {
  const body = { ProjectName: PROJECT, PageSize: 100, ...(plan === "agent" ? { Filter: { Scene: "RealAgentPlanPersonal" } } : {}) }
  let items
  try {
    const r = await call({ ak, sk, region, action: "ListApiKeys", body, signal })
    items = Array.isArray(r?.Items) ? r.Items : []
  } catch (e) {
    if (isCredentialError(e)) throw new DiscoveryError("credential", e.message)
    throw new DiscoveryError(e?.code ? "no-key" : "transient", `列出 API key 失败：${e.message}`)
  }
  const pick = pickKey(items)
  if (!pick) {
    throw new DiscoveryError("no-key", `没有找到${plan === "agent" ? " Agent Plan 个人版专属" : "可用的"} API key（项目 ${PROJECT}，Active 状态）；到火山控制台创建一把，或改用手填 API key`)
  }
  let raw
  try {
    raw = await call({ ak, sk, region, action: "GetRawApiKey", body: { Id: pick.Id }, signal })
  } catch (e) {
    if (isCredentialError(e) && !/accessdenied/i.test(String(e.code))) throw new DiscoveryError("credential", e.message)
    throw new DiscoveryError(e?.code ? "gate" : "transient", `读取 API key 明文被拒绝或失败：${e.message}（火山对个人版读取明文可能有协议 / 权限闸门，需要到控制台处理；也可改用手填 API key）`)
  }
  const key = str(raw?.ApiKey)
  if (!key || key.includes("*")) throw new DiscoveryError("gate", "读取 API key 明文只拿到了打码的值，无法使用；也可改用手填 API key")
  return { key, keyName: str(pick.Name) }
}

// 团队版席位：GetSeatInfo 返回的 SeatID 为空说明没有席位（个人版也是这样，不是报错）。
async function teamSeat({ ak, sk, region, signal }) {
  for (const [scene, plan] of [["agent_plan_enterprise", "agent"], ["coding_plan_enterprise", "coding"]]) {
    try {
      const seat = await call({ ak, sk, region, action: "GetSeatInfo", body: { ProjectName: PROJECT, Scene: scene }, signal })
      const key = str(seat?.ApiKey)
      if (str(seat?.SeatID) && key && !key.includes("*")) {
        return { plan, key, keyName: `seat ${str(seat.SeatID)}`, endsAt: timeMs(seat.ExpiredTime), planType: str(seat.BizInfo) }
      }
    } catch (e) {
      if (isCredentialError(e)) throw new DiscoveryError("credential", e.message)
    }
  }
  return undefined
}

// 识别一个账号。成功返回 { plan: "agent"|"coding", team, root, key, keyName, planType, subscription }；失败抛 DiscoveryError。
export async function discoverAccount({ ak, sk, region, signal }) {
  const found = []
  let transient
  for (const plan of ["agent", "coding"]) {
    try {
      const p = await getPersonalPlan({ ak, sk, region, plan, signal })
      if (p) found.push({ plan, p })
    } catch (e) {
      if (isCredentialError(e)) throw new DiscoveryError("credential", e.message)
      transient = e
    }
  }
  // 两种个人套餐都有时，选没结束的；都没结束选 Agent（先找到的）。
  const live = found.filter((f) => !endedNow({ endsAt: f.p.endsAt, autoRenew: f.p.autoRenew, status: f.p.status }))
  const chosen = live[0] ?? found[0]

  if (chosen) {
    const { key, keyName } = await personalKey({ ak, sk, region, plan: chosen.plan, signal })
    return {
      plan: chosen.plan,
      team: false,
      root: rootFor(chosen.plan, region),
      key,
      keyName,
      planType: chosen.p.planType,
      subscription: { endsAt: chosen.p.endsAt, autoRenew: chosen.p.autoRenew, status: chosen.p.status, source: "personal-plan" },
    }
  }

  const seat = await teamSeat({ ak, sk, region, signal })
  if (seat) {
    return {
      plan: seat.plan,
      team: true,
      root: rootFor(seat.plan, region),
      key: seat.key,
      keyName: seat.keyName,
      planType: seat.planType,
      subscription: { endsAt: seat.endsAt, autoRenew: false, status: "", source: "seat" },
    }
  }

  if (transient) throw new DiscoveryError("transient", `查询套餐失败：${transient.message}`)
  throw new DiscoveryError("no-plan", "这对 AccessKey 下没有识别到火山订阅（Agent Plan / Coding Plan 个人版、团队版席位都没有，或套餐已回收）")
}
