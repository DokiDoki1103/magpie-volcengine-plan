// 额度查询自测：mock 掉 fetch，不连真实火山。运行：node test/quota.test.mjs
import { createHash, createHmac } from "node:crypto"
import { VolcenginePlanPlugin, _internal } from "../index.mjs"
import { sign, windowsOf, codingWindows, planOf, regionOf, fetchUsage, timeMs, endedNow } from "../quota.mjs"

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`)
  if (!cond) failed++
}

// ---- 1) 签名 ----
// 这里的 refSign 按火山文档的步骤独立重新推导一遍，和 sign() 对比。
// 注意：它证明的是"代码按预期的算法实现、以后改动不会悄悄变样"，不是"和火山官方逐字节一致"。
// 官方一致性要用一对有效的 AK/SK 打一次真实接口才能确认。
function refSign({ ak, sk, region, action, body, xDate }) {
  const sha = (s) => createHash("sha256").update(s).digest("hex")
  const hmac = (k, s) => createHmac("sha256", k).update(s).digest()
  const day = xDate.slice(0, 8)
  const query = `Action=${action}&Version=2024-01-01`
  const canonical = `POST\n/\n${query}\ncontent-type:application/json\nhost:open.volcengineapi.com\nx-content-sha256:${sha(body)}\nx-date:${xDate}\n\ncontent-type;host;x-content-sha256;x-date\n${sha(body)}`
  const scope = `${day}/${region}/ark/request`
  const toSign = `HMAC-SHA256\n${xDate}\n${scope}\n${sha(canonical)}`
  const k = hmac(hmac(hmac(hmac(sk, day), region), "ark"), "request")
  return createHmac("sha256", k).update(toSign).digest("hex")
}
{
  const input = { ak: "AKLTtest", sk: "secret/with+chars==", region: "cn-beijing", xDate: "20261122T120000Z" }
  const body = JSON.stringify({ SeatIDs: ["seat-1"] })
  const h = sign({ ...input, query: "Action=GetAgentPlanSeatAFPUsage&Version=2024-01-01", body })
  const want = refSign({ ...input, action: "GetAgentPlanSeatAFPUsage", body })
  ok(h.Authorization.endsWith(`Signature=${want}`), "签名：和独立推导的结果一致")
  ok(h.Authorization.startsWith("HMAC-SHA256 Credential=AKLTtest/20261122/cn-beijing/ark/request, SignedHeaders=content-type;host;x-content-sha256;x-date, "), "签名：Authorization 头的格式")
  ok(h["X-Content-Sha256"] === createHash("sha256").update(body).digest("hex") && h["X-Date"] === "20261122T120000Z", "签名：X-Content-Sha256 / X-Date")
  const h2 = sign({ ...input, sk: "other", query: "Action=GetAgentPlanSeatAFPUsage&Version=2024-01-01", body })
  ok(h2.Authorization !== h.Authorization, "签名：换 Secret 签名就变")
  // 回归向量：由当前实现生成并冻结（不是官方向量）。签名逻辑被改动，这一行就会变红。
  ok(want === "4a0e70514d5eca3b1cd231e631d668aceb73d2474fd52da83c8fe878a9136c2d", "签名：固定输入的回归向量")
}

// ---- 2) 窗口解析 ----
{
  const ws = windowsOf({
    AFPFiveHour: { Used: 12, Quota: 100, ResetTime: 1795400000 },
    AFPWeekly: { Percent: 45.5, ResetTime: "2026-11-30T00:00:00+08:00" },
    AFPMonthly: { Quota: 0 },
    AFPDaily: { Used: 1, Quota: 2 },
  })
  ok(ws.length === 2, "windowsOf：没有配额的月窗口、不展示的日窗口被跳过")
  ok(ws[0].name === "5 小时" && ws[0].used === 12 && ws[0].amount === 12 && ws[0].limit === 100 && ws[0].display === "12 / 100", "windowsOf：有数量时显示 已用 / 总额")
  ok(ws[0].resetsAt === new Date(1795400000 * 1000).toISOString() && ws[0].span === 5 * 3600, "windowsOf：秒级时间戳、窗口长度")
  ok(ws[1].name === "周" && ws[1].used === 45.5 && ws[1].display === "45.5%" && ws[1].resetsAt === "2026-11-29T16:00:00.000Z", "windowsOf：只有百分比、RFC3339 时间")
  ok(windowsOf(undefined).length === 0 && windowsOf("x").length === 0, "windowsOf：空输入不崩")

  const cw = codingWindows({
    QuotaUsage: [
      { Level: "session", Percent: 30, ResetTimestamp: 1795400000 },
      { Level: "Weekly", Percent: 80 },
      { Level: "monthly", Percent: 5 },
      { Level: "other", Percent: 1 },
    ],
  })
  ok(cw.map((w) => w.name).join() === "5 小时,周,月", "codingWindows：session/weekly/monthly -> 5 小时/周/月，未知级别跳过")
  ok(cw[0].used === 30 && cw[0].display === "30.0%" && cw[0].resetsAt, "codingWindows：已用比例和重置时间")
}

// ---- 3) 套餐 / 地区推断 ----
ok(planOf("https://ark.cn-beijing.volces.com/api/coding") === "coding" && planOf("https://ark.cn-beijing.volces.com/api/coding/v1") === "coding", "planOf：coding（带不带 /v1 都行）")
ok(planOf("https://ark.cn-beijing.volces.com/api/plan") === "agent" && planOf("https://ark.cn-beijing.volces.com/api/plan/v3") === "agent", "planOf：agent")
ok(planOf("https://ark.cn-beijing.volces.com/api/v3") === "unknown" && planOf("not a url") === "unknown", "planOf：按量付费和不合法地址没有额度接口")
ok(regionOf("https://ark.cn-beijing.volces.com/api/plan") === "cn-beijing" && regionOf("https://ark.cn-shanghai.volces.com/api/plan") === "cn-shanghai" && regionOf("https://x.example/api") === "cn-beijing", "regionOf：从域名取，取不到用 cn-beijing")

// ---- 4) 控制面调用（mock fetch）----
const asked = []
let replies = {}
let dataCalls = 0
globalThis.fetch = async (url, init) => {
  const u = new URL(url)
  const action = u.searchParams.get("Action")
  if (!action) {
    dataCalls++ // 数据面（聊天）请求：直接放行
    return new Response("{}", { status: 200 })
  }
  asked.push({ action, host: u.host, url: String(url), headers: init.headers, body: init.body })
  let r = replies[action]
  if (typeof r === "function") r = r(u.host) // 回复可以按域名决定，也可以抛错模拟网络故障
  if (r === undefined) throw new Error(`unexpected action ${action}`)
  return new Response(JSON.stringify(r), { status: r?.ResponseMetadata?.Error ? 403 : 200 })
}
const reset = (r) => {
  replies = r
  asked.length = 0
  dataCalls = 0
  _internal.quotaCache.clear()
  _internal.autoSubscription.clear()
}
const planReply = (over = {}) => ({
  ResponseMetadata: {},
  Result: { PlanType: "Lite", Status: "Running", StartTime: "2026-10-01T00:00:00+08:00", EndTime: "2027-01-06T23:59:59+08:00", AutoRenew: false, ...over },
})
const creds = { ak: "AKteam", sk: "sk-team", region: "cn-beijing" }

reset({
  GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 50, ResetTimestamp: 1795400000 }] } },
  GetPersonalPlan: planReply({ AutoRenew: true }),
})
{
  const r = await fetchUsage({ ...creds, plan: "coding" })
  ok(r.plan === "Coding Plan" && r.windows.length === 1 && asked.map((a) => a.action).join() === "GetCodingPlanUsage,GetPersonalPlan", "fetchUsage coding：GetCodingPlanUsage + GetPersonalPlan")
  ok(asked[0].url.startsWith("https://open.volcengineapi.com/?Action=GetCodingPlanUsage&Version=2024-01-01"), "fetchUsage：额度接口的凭据只发往 open.volcengineapi.com")
  ok(asked[1].host === "ark.cn-beijing.volcengineapi.com" && JSON.parse(asked[1].body).Plan === "CodingPlan", "fetchUsage：套餐信息先走地域域名，Plan=CodingPlan")
  ok(r.subscription.endsAt === Date.parse("2027-01-06T23:59:59+08:00") && r.subscription.autoRenew === true && r.subscription.source === "personal-plan", "fetchUsage：读到到期时间和自动续费")
}

reset({
  GetSeatInfo: { ResponseMetadata: {}, Result: { SeatID: "seat-9", BizInfo: "medium", ExpiredTime: 1795400000 } },
  GetAgentPlanSeatAFPUsage: { ResponseMetadata: {}, Result: { SeatAFPUsages: [{ PlanType: "Team", AFPWeekly: { Percent: 20 } }] } },
})
{
  const r = await fetchUsage({ ...creds, plan: "agent" })
  ok(asked.map((a) => a.action).join() === "GetSeatInfo,GetAgentPlanSeatAFPUsage", "fetchUsage 团队版：GetSeatInfo -> GetAgentPlanSeatAFPUsage")
  ok(r.plan === "Agent Plan Team" && r.windows[0].name === "周", "fetchUsage 团队版：套餐名带席位类型")
  ok(JSON.parse(asked[1].body).SeatIDs[0] === "seat-9", "fetchUsage 团队版：用席位 ID 查")
  ok(r.subscription?.source === "seat" && r.subscription.endsAt === 1795400000 * 1000, "fetchUsage 团队版：到期时间取席位的 ExpiredTime，不再调 GetPersonalPlan")
}

reset({
  GetSeatInfo: { ResponseMetadata: { Error: { Code: "AccessDenied", Message: "no seat" } } },
  GetAFPUsage: { ResponseMetadata: {}, Result: { Tier: "pro", AFPMonthly: { Used: 5, Quota: 10 } } },
  GetPersonalPlan: planReply(),
})
{
  const r = await fetchUsage({ ...creds, plan: "agent" })
  ok(asked.map((a) => a.action).join() === "GetSeatInfo,GetAFPUsage,GetPersonalPlan" && r.plan === "Agent Plan pro" && r.windows[0].used === 50, "fetchUsage 个人版：没有席位回退 GetAFPUsage，再查套餐到期")
  ok(JSON.parse(asked[2].body).Plan === "AgentPlan", "fetchUsage 个人版：Plan=AgentPlan")
}

// ---- 套餐到期：GetPersonalPlan 的各种情形 ----
reset({ GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 1 }] } }, GetPersonalPlan: { ResponseMetadata: { Error: { Code: "ResourceNotFound.Plan", Message: "no plan" } } } })
{
  const r = await fetchUsage({ ...creds, plan: "coding" })
  ok(r.subscription === undefined && asked.filter((a) => a.action === "GetPersonalPlan").length === 1, "GetPersonalPlan：没订阅（ResourceNotFound.Plan）是定论，不换域名重试，额度照常返回")
}
reset({
  GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 1 }] } },
  GetPersonalPlan: (host) => {
    if (host.startsWith("ark.")) throw new Error("fetch failed")
    return planReply()
  },
})
{
  const r = await fetchUsage({ ...creds, plan: "coding" })
  const hosts = asked.filter((a) => a.action === "GetPersonalPlan").map((a) => a.host).join()
  ok(hosts === "ark.cn-beijing.volcengineapi.com,open.volcengineapi.com" && r.subscription?.source === "personal-plan", "GetPersonalPlan：地域域名不通就换 open.volcengineapi.com")
}
reset({
  GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 1 }] } },
  GetPersonalPlan: { ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "x" } } },
})
{
  const r = await fetchUsage({ ...creds, plan: "coding" })
  ok(r.windows.length === 1 && r.subscription === undefined, "GetPersonalPlan：出错不影响额度，只是没有到期信息")
}
reset({ GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 1 }] } }, GetPersonalPlan: { ResponseMetadata: {}, Result: {} } })
ok((await fetchUsage({ ...creds, plan: "coding" })).subscription === undefined, "GetPersonalPlan：空结果当作没有套餐")

// ---- 真实返回样本（2026-11-22 用有效 AK/SK 打真实接口得到，已去掉账号标识）----
// 个人版 Agent Plan：GetSeatInfo 返回一个全空的对象（不是报错），额度桶里的 ResetTime 是毫秒，
// 套餐信息里 EndTime 是 RFC3339 UTC，档位字段叫 PlanType。
const REAL_AFP = {
  PlanType: "medium",
  AFPFiveHour: { Quota: 10000, Used: 756.3365, SubscribeTime: 1795354070000, ResetTime: 1795372070000 },
  AFPWeekly: { Quota: 35000, Used: 3200.4534, SubscribeTime: 1794758400000, ResetTime: 1795363200000 },
  AFPMonthly: { Quota: 100000, Used: 3200.4534, SubscribeTime: 1795335992000, ResetTime: 1797955199000 },
  AFPDaily: { Quota: 50000, Used: 0, SubscribeTime: 1795276800000, ResetTime: 1795363200000 },
}
const REAL_EMPTY_SEAT = { SeatID: "", AccountID: "", ProjectName: "", BizInfo: "", BillingStatus: 0, InstanceID: "", OrderTime: 0, ExpiredTime: 0, ExtraConfig: null, SeatStatus: 0, IdentityType: "", IdentityId: "", IdentityDetail: "", BindCount: 0, ApiKeySID: "", ApiKey: "", CreateTime: 0, UpdateTime: 0, EmployeeBoosterPurchaseEnabled: false, Version: 0 }
const REAL_PLAN = { PlanType: "Medium", Status: "Running", StartTime: "2026-11-22T08:26:32Z", EndTime: "2027-01-22T15:59:59Z", AutoRenew: false }
reset({
  GetSeatInfo: { ResponseMetadata: {}, Result: REAL_EMPTY_SEAT },
  GetAFPUsage: { ResponseMetadata: {}, Result: REAL_AFP },
  GetPersonalPlan: { ResponseMetadata: {}, Result: REAL_PLAN },
})
{
  const r = await fetchUsage({ ...creds, plan: "agent" })
  ok(asked.map((a) => a.action).join() === "GetSeatInfo,GetAFPUsage,GetPersonalPlan", "真实样本：个人版 Agent Plan 的调用顺序（全空的席位对象不算席位）")
  ok(r.plan === "Agent Plan medium", "真实样本：档位取 PlanType")
  ok(r.windows.map((w) => w.name).join() === "5 小时,周,月", "真实样本：只展示 5 小时 / 周 / 月，AFPDaily 不展示")
  const h = r.windows[0]
  ok(h.amount === 756.3365 && h.limit === 10000 && Math.abs(h.used - 7.56) < 0.01 && h.display === "756.34 / 10000", "真实样本：已用 / 总额和百分比")
  ok(h.resetsAt === new Date(1795372070000).toISOString(), "真实样本：毫秒级 ResetTime")
  ok(r.subscription.endsAt === Date.parse("2027-01-22T15:59:59Z") && r.subscription.autoRenew === false && r.subscription.status === "Running", "真实样本：EndTime 是 RFC3339 UTC，Status Running，没有自动续费")
  ok(endedNow(r.subscription, Date.parse("2026-12-01T00:00:00Z")) === false && endedNow(r.subscription, Date.parse("2027-01-23T00:00:00Z")) === true, "真实样本：到期前不拦，到期后拦")
}

// 没有 coding 套餐（或已回收）的账号：GetCodingPlanUsage 给的是 Status，不是 QuotaUsage
reset({
  GetCodingPlanUsage: { ResponseMetadata: {}, Result: { Status: "Reclaimed", UpdateTimestamp: 1795360219, HasReward: false } },
  GetPersonalPlan: { ResponseMetadata: { Error: { Code: "ResourceNotFound.Plan", Message: "The user does not have an active or existing personal plan." } } },
})
{
  const r = await fetchUsage({ ...creds, plan: "coding" })
  ok(r.windows.length === 0 && r.subscription.status === "Reclaimed" && endedNow(r.subscription) === true, "真实样本：Coding 返回 Reclaimed 算订阅已结束，不是报错")
}

// ---- timeMs / endedNow ----
ok(timeMs("2027-01-06T23:59:59+08:00") === Date.parse("2027-01-06T15:59:59Z"), "timeMs：RFC3339")
ok(timeMs("2027-01-06 23:59:59") === Date.parse("2027-01-06T23:59:59+08:00"), "timeMs：'YYYY-MM-DD HH:MM:SS' 没写时区按北京时间")
ok(timeMs(1795400000) === 1795400000 * 1000 && timeMs(1795400000000) === 1795400000000 && timeMs("1795400000") === 1795400000 * 1000, "timeMs：秒 / 毫秒 / 数字字符串")
ok(timeMs("") === 0 && timeMs("garbage") === 0 && timeMs(undefined) === 0 && timeMs(-5) === 0, "timeMs：空和解析不了的返回 0")
{
  const T = Date.now()
  ok(endedNow({ endsAt: T - 1000, autoRenew: false }, T) === true, "endedNow：已过期且不自动续费")
  ok(endedNow({ endsAt: T - 1000, autoRenew: true }, T) === false, "endedNow：已过期但自动续费，不拦（可能正在续）")
  ok(endedNow({ endsAt: T + 1000 }, T) === false && endedNow({}, T) === false && endedNow(undefined, T) === false, "endedNow：未到期 / 没数据不拦")
  ok(endedNow({ endsAt: 0, status: "Reclaimed" }, T) === true && endedNow({ status: "Expired" }, T) === true, "endedNow：状态是回收 / 过期就是结束，哪怕没有日期")
  ok(endedNow({ endsAt: T + 1e9, autoRenew: true, status: "Reclaimed" }, T) === true, "endedNow：状态回收优先于日期和自动续费")
}

reset({ GetSeatInfo: { ResponseMetadata: {}, Result: {} }, GetAFPUsage: { ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "bad sig" } } } })
{
  let msg = ""
  try {
    await fetchUsage({ ...creds, plan: "agent" })
  } catch (e) {
    msg = e.message
  }
  ok(msg.includes("SignatureDoesNotMatch") && msg.includes("AccessKey ID / Secret"), "fetchUsage：火山报错原样抛出，并给 AK/SK 排查提示")
}

reset({ GetSeatInfo: { ResponseMetadata: {}, Result: {} }, GetAFPUsage: { ResponseMetadata: {}, Result: {} } })
{
  let msg = ""
  try {
    await fetchUsage({ ...creds, plan: "agent" })
  } catch (e) {
    msg = e.message
  }
  ok(msg.includes("没有窗口"), "fetchUsage：返回里没有窗口时报错")
}

// ---- 5) 登录行解析：ak= sk= region= ----
{
  const p = _internal.parseAccountLine("主力 ark-key 2027-01-06 ak=AKLTabc sk=se/cr+et== region=cn-shanghai")
  ok(p.name === "主力" && p.key === "ark-key" && p.ak === "AKLTabc" && p.sk === "se/cr+et==" && p.region === "cn-shanghai" && p.expiresAt, "解析：名称 key 到期日 ak sk region")
  const q = _internal.parseAccountLine("sk=x ak=y ark-key")
  ok(q.key === "ark-key" && q.ak === "y" && q.sk === "x" && q.name === "", "解析：ak/sk 位置随意，只剩一项就是 key")
  ok(_internal.parseAccountLine("ark-key ak=a").error?.includes("一起填"), "解析：只写 ak 不写 sk 报错")
  ok(_internal.parseAccountLine("ark-key sk=a").error?.includes("一起填"), "解析：只写 sk 不写 ak 报错")
  ok(_internal.parseAccountLine("ark-key ak=a ak=b sk=c").error?.includes("只能写一次"), "解析：重复写 ak 报错")
  const none = _internal.parseAccountLine("主力 ark-key")
  ok(none.ak === "" && none.sk === "" && none.region === "", "解析：不写就是空，不查真实额度")
}

// ---- 6) 插件：登录保存、usage 合并 ----
const plugin = await VolcenginePlanPlugin({ client: { auth: { set: async () => {} } } })
const method = plugin.auth.methods[0]
{
  const r = await method.authorize({ type: "coding", account: "主力 ark-k 2027-01-06 ak=AKLTz sk=s3cr3t" })
  ok(r.type === "success" && r.metadata.accessKeyID === "AKLTz" && r.metadata.secretAccessKey === "s3cr3t" && !("region" in r.metadata), "authorize：AK/SK 存进账号 metadata，region 没填就不存")
  ok(r.key === "ark-k" && r.metadata.accessKeyID !== r.key && r.metadata.secretAccessKey !== r.key, "authorize：保存的 key 仍是聊天用的 Ark API key，AK/SK 另存，不替换它")
  const r2 = await method.authorize({ type: "plan", account: "ark-k region=cn-shanghai ak=A sk=S" })
  ok(r2.metadata.region === "cn-shanghai", "authorize：region 填了就存")
  const r3 = await method.authorize({ type: "plan", account: "ark-k" })
  ok(!("accessKeyID" in r3.metadata) && !("secretAccessKey" in r3.metadata), "authorize：没填 AK/SK 就不存")
  ok((await method.authorize({ type: "plan", account: "ark-k ak=A" })).type === "failed", "authorize：只填 ak 返回 failed")
}

const authWith = (md = {}) => ({ type: "api", key: "ark-k", metadata: { baseURL: "https://ark.cn-beijing.volces.com/api/coding", accessKeyID: "AKLT", secretAccessKey: "SK", ...md } })
const codingReply = { GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 40, ResetTimestamp: 1795400000 }, { Level: "monthly", Percent: 10, ResetTimestamp: 1796000000 }] } } }

reset(codingReply)
{
  const u = await plugin.auth.usage(async () => authWith())
  const names = u.windows.map((w) => w.name).join()
  ok(names === "周,月,Base URL", "usage：真实窗口在前，Base URL 的 aside 窗口在后")
  ok(u.plan === "Coding Plan" && u.error === undefined && u.signIn === undefined, "usage：套餐名取自控制面，成功时不带 error")
  ok(u.windows.find((w) => w.name === "周").used === 40, "usage：周窗口 40%")
  const calls = asked.length
  await plugin.auth.usage(async () => authWith())
  ok(asked.length === calls, "usage：60 秒内再读走缓存，不重复请求控制面")
}

reset(codingReply)
{
  const until = new Date(Date.now() + 2 * 86400 * 1000).toISOString()
  const u = await plugin.auth.usage(async () => authWith({ suspendUntil: until, suspendWindow: "weekly" }))
  const w = u.windows.find((x) => x.name === "周")
  ok(w.used === 100 && w.resetsAt === until, "usage：429 暂停按名字覆盖真实窗口（used 100、重置时间取 429 的）")
  ok(u.windows.find((x) => x.name === "月").used === 10, "usage：其他窗口保持真实值")
  ok(u.windows.filter((x) => x.name === "周").length === 1, "usage：覆盖不重复添加窗口")
}

reset(codingReply)
{
  const until = new Date(Date.now() + 3600 * 1000).toISOString()
  const u = await plugin.auth.usage(async () => authWith({ suspendUntil: until, suspendWindow: "monthly" }))
  const w = u.windows.find((x) => x.name === "月")
  ok(w.used === 100 && w.resetsAt === until, "usage：429 说月额度用尽时，月窗口被置为 100%")
}

reset({ GetCodingPlanUsage: { ResponseMetadata: {}, Result: { QuotaUsage: [{ Level: "weekly", Percent: 40 }] } } })
{
  const until = new Date(Date.now() + 3600 * 1000).toISOString()
  const u = await plugin.auth.usage(async () => authWith({ suspendUntil: until, suspendWindow: "monthly" }))
  ok(u.windows.some((x) => x.name === "月" && x.used === 100), "usage：控制面没有该窗口时，把 429 的暂停窗口补进去")
}

reset({ GetCodingPlanUsage: { ResponseMetadata: { Error: { Code: "SignatureDoesNotMatch", Message: "bad" } } } })
{
  const u = await plugin.auth.usage(async () => authWith())
  ok(u.error?.includes("SignatureDoesNotMatch") && u.signIn === "kept", "usage：AK/SK 报错只带 error，signIn=kept（聊天 key 没问题，不让账号下线）")
  ok(u.windows.some((w) => w.name === "Base URL"), "usage：报错时仍有 Base URL 窗口")
  const calls = asked.length
  await plugin.auth.usage(async () => authWith())
  ok(asked.length === calls, "usage：失败也缓存 30 秒，不连续轰炸控制面")
}

reset({})
{
  const u = await plugin.auth.usage(async () => ({ type: "api", key: "ark-k", metadata: { baseURL: "https://ark.cn-beijing.volces.com/api/coding" } }))
  ok(asked.length === 0 && u.error === undefined && u.windows.length === 1, "usage：没填 AK/SK 不请求控制面，也不报错打扰")
  const u2 = await plugin.auth.usage(async () => authWith({ baseURL: "https://ark.cn-beijing.volces.com/api/v3" }))
  ok(asked.length === 0 && u2.windows.length === 1, "usage：按量付费地址没有额度接口，不请求")
}

// ---- 7) 套餐到期：自动读取 + 拦截 ----
const DAY = 86400 * 1000
const past = new Date(Date.now() - DAY).toISOString()
const future = new Date(Date.now() + 30 * DAY).toISOString()
const chat = async (auth) => {
  const l = await plugin.auth.loader(async () => auth)
  return l.fetch("https://ark.cn-beijing.volces.com/api/coding/v1/messages", { method: "POST", body: "{}" })
}
const withPlan = (over) => ({ ...codingReply, GetPersonalPlan: planReply(over) })

// 手填的到期日已过，控制面没有到期信息：仍按手填的处理；已过期也要查（续费后才能读到新日期）
reset(codingReply)
{
  const a = authWith({ expiresAt: past })
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === "expired" && u.plan === "火山方舟订阅（已到期）" && u.renew === undefined, "到期：手填日期已过，控制面读不到时按手填的处理")
  ok(asked.some((x) => x.action === "GetCodingPlanUsage"), "到期：已过期的账号也会查控制面（为了续费后自动恢复）")
  const r = await chat(a)
  ok(r.status === 403 && r.headers.get("x-magpie-sign-in") === "expired" && dataCalls === 0, "到期：拦截请求，不打火山")
}

// 手填已过，但控制面说还没到期（续费了）：以真实的为准，自动恢复
reset(withPlan({ EndTime: future }))
{
  const a = authWith({ expiresAt: past })
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === undefined && u.plan === "Coding Plan" && u.until === new Date(Date.parse(future)).toISOString(), "到期：手填已过但控制面读到新的到期时间，不再算过期，until 取真实值")
  ok(u.renew === "off", "到期：真实来源会带 renew（没有自动续费）")
  const r = await chat(a)
  ok(r.status === 200 && dataCalls === 1, "到期：续费后读到新到期时间，请求自动恢复")
}

// 真实到期已过且没有自动续费：即使手填的日期还没到，也拦
reset(withPlan({ EndTime: past }))
{
  const a = authWith({ expiresAt: future })
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === "expired" && u.error.includes("已于") && u.renew === "off", "到期：真实到期已过（手填的还没到）以真实的为准，标成过期")
  const r = await chat(a)
  ok(r.status === 403 && dataCalls === 0, "到期：真实到期已过，拦截")
}

// 自动续费：到期那一刻可能正在续，不拦
reset(withPlan({ EndTime: past, AutoRenew: true }))
{
  const a = authWith()
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === undefined && u.renew === "auto", "到期：已过期但自动续费，不标过期，renew=auto")
  ok((await chat(a)).status === 200, "到期：已过期但自动续费，请求照常")
}

// 状态是回收：没有日期也算结束，提示里说明状态
reset(withPlan({ EndTime: "", Status: "Reclaimed" }))
{
  const a = authWith()
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === "expired" && u.error.includes("Reclaimed") && u.until === undefined, "到期：状态 Reclaimed 算结束，没有日期也拦，提示里带状态")
  ok((await chat(a)).status === 403, "到期：状态 Reclaimed，拦截")
}

// 读到过真实值之后控制面出错：沿用上一次读到的，不会因为一次失败就放开
reset(withPlan({ EndTime: past }))
{
  const a = authWith()
  await plugin.auth.usage(async () => a)
  replies = { GetCodingPlanUsage: { ResponseMetadata: { Error: { Code: "InternalError", Message: "boom" } } } }
  _internal.quotaCache.clear()
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === "expired" && (await chat(a)).status === 403, "到期：控制面后来出错，仍沿用上次读到的到期状态")
}

// 先过期，续费后下一次读取就恢复
reset(withPlan({ EndTime: past }))
{
  const a = authWith()
  await plugin.auth.usage(async () => a)
  ok((await chat(a)).status === 403, "续费流程：续费前被拦")
  replies = withPlan({ EndTime: future })
  _internal.quotaCache.clear()
  const u = await plugin.auth.usage(async () => a)
  ok(u.signIn === undefined && (await chat(a)).status === 200, "续费流程：下一次读到新的到期时间，自动恢复，不用重新添加账号")
}

// 没填 AK/SK：只有手填的，行为和以前一致，也不带 renew
reset({})
{
  const a = { type: "api", key: "ark-nokey", metadata: { baseURL: "https://ark.cn-beijing.volces.com/api/coding", expiresAt: future } }
  const u = await plugin.auth.usage(async () => a)
  ok(asked.length === 0 && u.until === new Date(Date.parse(future)).toISOString() && u.renew === undefined && u.signIn === undefined, "没填 AK/SK：用手填的到期日，不请求控制面，不带 renew")
  ok((await chat(a)).status === 200, "没填 AK/SK：手填日期没到，请求正常")
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过")
process.exit(failed ? 1 : 0)
