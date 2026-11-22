// 全自动识别自测：mock 掉控制面和聊天请求，不连真实火山。运行：node test/discover.test.mjs
import { VolcenginePlanPlugin, _internal } from "../index.mjs"
import { discoverAccount, DiscoveryError, rootFor } from "../discover.mjs"

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`)
  if (!cond) failed++
}

// ---- mock：控制面按 Action 回复（回复可以是函数 (host, body) => 结果 / 抛错），聊天请求单独记录 ----
const asked = []
const chats = []
let replies = {}
let chatReply = () => new Response("{}", { status: 200 })
globalThis.fetch = async (url, init) => {
  const u = new URL(url)
  const action = u.searchParams.get("Action")
  if (!action) {
    chats.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body })
    return chatReply(chats[chats.length - 1])
  }
  const body = JSON.parse(init.body)
  asked.push({ action, host: u.host, body })
  let r = replies[action]
  if (typeof r === "function") r = r(u.host, body)
  if (r === undefined) throw new Error(`unexpected action ${action}`)
  return new Response(JSON.stringify(r), { status: r?.ResponseMetadata?.Error ? 403 : 200 })
}
const err = (Code, Message = "x") => ({ ResponseMetadata: { Error: { Code, Message } } })
const okr = (Result) => ({ ResponseMetadata: {}, Result })
const reset = (r) => {
  replies = r
  asked.length = 0
  chats.length = 0
  chatReply = () => new Response("{}", { status: 200 })
  _internal.discoveryCache.clear()
  _internal.discoveryInflight.clear()
  _internal.quotaCache.clear()
  _internal.autoSubscription.clear()
}
const actions = () => asked.map((a) => a.action).join()

// ---- 真实形状的样本（个人版 Agent Plan，2026-11-22 真实接口返回，已去掉标识）----
const AGENT_PLAN = okr({ PlanType: "Medium", Status: "Running", StartTime: "2026-11-22T08:26:32Z", EndTime: "2027-01-22T15:59:59Z", AutoRenew: false })
const NO_PLAN = err("ResourceNotFound.Plan", "The user does not have an active or existing personal plan.")
const item = (over = {}) => ({ Id: 5456173, Name: "agent-plan-api-key", Key: "ark-9c04****-****-****-****-********0790", Status: "Active", ProjectName: "default", ResourceInstances: [{ ResourceId: "*", ResourceType: "all" }], LastAccessTime: "2026-11-22T23:15:00+08:00", ...over })
const listOf = (...items) => okr({ TotalCount: items.length, PageNumber: 1, PageSize: 100, Items: items })
const RAW = "ark-test-0000-1111-2222-3333-4444-aaaaa"
const creds = { ak: "AKLTdiscover", sk: "sk-discover", region: "cn-beijing" }

const agentReplies = (extra = {}) => ({
  GetPersonalPlan: (host, body) => (body.Plan === "AgentPlan" ? AGENT_PLAN : NO_PLAN),
  ListApiKeys: listOf(item()),
  GetRawApiKey: okr({ ApiKey: RAW }),
  ...extra,
})

// ---- 1) discoverAccount：个人版 Agent Plan ----
reset(agentReplies())
{
  const d = await discoverAccount(creds)
  ok(d.plan === "agent" && d.team === false && d.root === "https://ark.cn-beijing.volces.com/api/plan", "Agent 个人版：识别出套餐类型和 Base URL")
  ok(d.key === RAW && d.keyName === "agent-plan-api-key", "Agent 个人版：取到完整明文 key（不是列表里打码的那个）")
  ok(d.subscription.endsAt === Date.parse("2027-01-22T15:59:59Z") && d.subscription.status === "Running" && d.planType === "Medium", "Agent 个人版：到期、状态、档位")
  const list = asked.find((a) => a.action === "ListApiKeys")
  ok(list.body.Filter?.Scene === "RealAgentPlanPersonal" && list.body.ProjectName === "default", "Agent 个人版：用 Scene=RealAgentPlanPersonal 过滤专属 key 池")
  ok(asked.find((a) => a.action === "GetRawApiKey").body.Id === 5456173, "Agent 个人版：用列表里的数字 Id 取明文")
  ok(asked.filter((a) => a.action === "GetPersonalPlan").map((a) => a.body.Plan).slice(0, 2).join() === "AgentPlan,CodingPlan", "识别：AgentPlan、CodingPlan 各问一次")
}

// ---- 2) Coding 个人版：普通 key 池，不带 Scene 过滤 ----
reset({
  GetPersonalPlan: (host, body) => (body.Plan === "CodingPlan" ? okr({ PlanType: "Lite", Status: "Running", EndTime: "2027-02-01T15:59:59Z", AutoRenew: true }) : NO_PLAN),
  ListApiKeys: listOf(item({ Id: 9, Name: "coding-key", Key: "9540****-****-****-****-********ab12" })),
  GetRawApiKey: okr({ ApiKey: "11111111-2222-3333-4444-555555555555" }),
})
{
  const d = await discoverAccount(creds)
  ok(d.plan === "coding" && d.root === "https://ark.cn-beijing.volces.com/api/coding" && d.subscription.autoRenew === true, "Coding 个人版：识别出 coding，地址是 /api/coding，读到自动续费")
  ok(asked.find((a) => a.action === "ListApiKeys").body.Filter === undefined, "Coding 个人版：走普通 key 池，不带 Scene 过滤")
}

// ---- 3) 两种套餐都有：选没结束的 ----
reset({
  GetPersonalPlan: (host, body) =>
    body.Plan === "AgentPlan" ? okr({ PlanType: "Medium", Status: "Expired", EndTime: "2026-01-01T00:00:00Z" }) : okr({ PlanType: "Lite", Status: "Running", EndTime: "2027-02-01T15:59:59Z" }),
  ListApiKeys: listOf(item()),
  GetRawApiKey: okr({ ApiKey: RAW }),
})
ok((await discoverAccount(creds)).plan === "coding", "两种套餐都有：Agent 已过期就选没结束的 Coding")
reset({
  GetPersonalPlan: () => okr({ PlanType: "x", Status: "Running", EndTime: "2027-02-01T15:59:59Z" }),
  ListApiKeys: listOf(item()),
  GetRawApiKey: okr({ ApiKey: RAW }),
})
ok((await discoverAccount(creds)).plan === "agent", "两种套餐都没结束：选先找到的 Agent")

// ---- 4) 团队版席位 ----
reset({
  GetPersonalPlan: NO_PLAN,
  GetSeatInfo: (host, body) =>
    body.Scene === "agent_plan_enterprise" ? okr({ SeatID: "seat-1", ApiKey: "ark-seat-aaaa-bbbb-cccc-dddd-eeeee", BizInfo: "team", ExpiredTime: 1795400000 }) : okr({ SeatID: "" }),
})
{
  const d = await discoverAccount(creds)
  ok(d.team === true && d.plan === "agent" && d.key === "ark-seat-aaaa-bbbb-cccc-dddd-eeeee" && d.subscription.source === "seat", "团队版：用席位的 ApiKey，到期取 ExpiredTime")
  ok(d.subscription.endsAt === 1795400000 * 1000, "团队版：ExpiredTime 秒转毫秒")
}
reset({ GetPersonalPlan: NO_PLAN, GetSeatInfo: okr({ SeatID: "seat-1", ApiKey: "ark-****masked", BizInfo: "t" }) })
{
  let kind = ""
  try { await discoverAccount(creds) } catch (e) { kind = e.kind }
  ok(kind === "no-plan", "团队版：席位的 ApiKey 是打码的就不能用，当作没有识别到套餐")
}

// ---- 5) 失败分类 ----
const failKind = async (r) => {
  reset(r)
  try {
    await discoverAccount(creds)
    return "none"
  } catch (e) {
    return e instanceof DiscoveryError ? e.kind : `other:${e.message}`
  }
}
ok((await failKind({ GetPersonalPlan: NO_PLAN, GetSeatInfo: okr({ SeatID: "" }) })) === "no-plan", "失败：两种套餐、席位都没有 => no-plan")
ok((await failKind({ GetPersonalPlan: err("InvalidAccessKey", "bad ak") })) === "credential", "失败：InvalidAccessKey => credential")
ok((await failKind({ GetPersonalPlan: err("SignatureDoesNotMatch") })) === "credential", "失败：SignatureDoesNotMatch => credential")
ok((await failKind({ GetPersonalPlan: () => { throw new Error("fetch failed") } })) === "transient", "失败：网络错误 => transient")
ok((await failKind({ ...agentReplies(), ListApiKeys: listOf() })) === "no-key", "失败：专属池里没有 key => no-key")
ok((await failKind({ ...agentReplies(), ListApiKeys: listOf(item({ Status: "Inactive" })) })) === "no-key", "失败：只有非 Active 的 key => no-key")
ok((await failKind({ ...agentReplies(), GetRawApiKey: err("AccessDenied", "gate") })) === "gate", "失败：GetRawApiKey 被拒绝 => gate（不绕，如实报告）")
ok((await failKind({ ...agentReplies(), GetRawApiKey: okr({ ApiKey: "ark-****masked" }) })) === "gate", "失败：只拿到打码的 key => gate")
ok((await failKind({ ...agentReplies(), ListApiKeys: err("InvalidAccessKey") })) === "credential", "失败：列 key 时凭据错 => credential")

// ---- 6) 多把 key 的选择规则 ----
reset({
  ...agentReplies(),
  ListApiKeys: listOf(
    item({ Id: 1, Name: "inactive-newest", Status: "Inactive", LastAccessTime: "2026-11-22T23:00:00+08:00" }),
    item({ Id: 2, Name: "scoped-old", ResourceInstances: [{ ResourceType: "endpoint" }], LastAccessTime: "2026-11-20T00:00:00+08:00" }),
    item({ Id: 3, Name: "all-older", LastAccessTime: "2026-10-01T00:00:00+08:00" }),
    item({ Id: 4, Name: "all-newer", LastAccessTime: "2026-11-21T00:00:00+08:00" }),
  ),
})
{
  const d = await discoverAccount(creds)
  ok(d.keyName === "all-newer" && asked.find((a) => a.action === "GetRawApiKey").body.Id === 4, "多把 key：跳过非 Active，优先全部资源范围，再取最近用过的")
}

ok(rootFor("agent", "cn-shanghai") === "https://ark.cn-shanghai.volces.com/api/plan" && rootFor("coding", "cn-beijing") === "https://ark.cn-beijing.volces.com/api/coding", "rootFor：按套餐和地区生成地址")

// ---- 7) 插件：登录解析 / authorize ----
const plugin = await VolcenginePlanPlugin({ client: { auth: { set: async (a) => sets.push(a) } } })
const sets = []
const method = plugin.auth.methods[0]
{
  const p = _internal.parseAccountLine("主力 ak=AKLTx sk=sec/ret==")
  ok(p.auto === true && p.name === "主力" && p.key === "" && p.ak === "AKLTx" && p.sk === "sec/ret==", "解析：名称 + ak/sk（没有 API key）=> 自动识别")
  ok(_internal.parseAccountLine("ak=AKLTx sk=s").auto === true && _internal.parseAccountLine("ak=AKLTx sk=s").name === "", "解析：只有 ak/sk => 自动识别，没有名称")
  const m = _internal.parseAccountLine("ark-abc ak=AKLTx sk=s")
  ok(m.auto === false && m.key === "ark-abc" && m.name === "", "解析：ark- 开头的是 API key => 手填 key + 查额度，不是自动识别")
  ok(_internal.parseAccountLine("11111111-2222-3333-4444-555555555555 ak=A sk=S").key === "11111111-2222-3333-4444-555555555555", "解析：UUID 形状的也是 API key")
  ok(_internal.parseAccountLine("主力 ark-abc ak=A sk=S").auto === false, "解析：两项是 名称 + key => 手填")
  ok(_internal.parseAccountLine("ark-abc").auto === false && _internal.parseAccountLine("ark-abc").key === "ark-abc", "解析：没有 ak/sk，单独一项是 key，行为不变")
  ok(_internal.parseAccountLine("2027-01-06").error?.includes("缺少 API key") && _internal.parseAccountLine("https://a.example/v1").error?.includes("自动识别"), "解析：行里只有日期或地址、没有 key 也没有 ak/sk 报错，提示选自动识别")
  ok(_internal.parseAccountLine("主力").key === "主力", "解析：没有 ak/sk 时单独一个词仍是 key（和以前一致，没法和名称区分）")
  ok(_internal.looksLikeKey("ark-x") && _internal.looksLikeKey("a".repeat(32)) && !_internal.looksLikeKey("主力") && !_internal.looksLikeKey("backup1"), "looksLikeKey：名称不会被当成 key")
}
{
  const r = await method.authorize({ type: "auto", account: "主力 ak=AKLTa sk=secretb region=cn-shanghai 2027-01-06" })
  ok(r.type === "success" && r.key === "AKLTa" && r.accountId === "主力", "authorize 自动识别：保存的 key 是 AccessKey ID，名称作 accountId")
  ok(r.metadata.mode === "auto" && r.metadata.accessKeyID === "AKLTa" && r.metadata.secretAccessKey === "secretb" && r.metadata.region === "cn-shanghai" && r.metadata.expiresAt, "authorize 自动识别：metadata 带 mode/AK/SK/region，手填到期日作兜底")
  ok(!("baseURL" in r.metadata) && !JSON.stringify(r).includes("ark-"), "authorize 自动识别：不存地址，也不存任何 API key")
  ok((await method.authorize({ type: "auto", account: "主力" })).type === "failed", "authorize 自动识别：没写 ak/sk 报错")
  ok((await method.authorize({ type: "auto", account: "ark-k ak=A sk=S" })).type === "failed", "authorize 自动识别：又写了 API key 报错，要手填请选 plan/coding")
  const r2 = await method.authorize({ type: "plan", account: "ak=A sk=S" })
  ok(r2.type === "success" && r2.metadata.mode === "auto", "authorize：下拉选了 plan 但只写了 ak/sk，也按自动识别（没有 key 没法手填）")
  const r3 = await method.authorize({ type: "plan", account: "主力 ark-k ak=A sk=S" })
  ok(r3.key === "ark-k" && r3.metadata.mode === undefined && r3.metadata.baseURL === "https://ark.cn-beijing.volces.com/api/plan", "authorize：手填 key 的账号行为不变")
}

// ---- 8) 插件：自动识别账号的 loader / fetch ----
const autoAuth = (over = {}) => ({ type: "api", key: "AKLTauto", metadata: { name: "主力", mode: "auto", accessKeyID: "AKLTauto", secretAccessKey: "sk-auto", ...over } })
const MSG = "https://ark.cn-beijing.volces.com/api/plan/v1/messages"

reset(agentReplies())
{
  const a = autoAuth()
  const l = await plugin.auth.loader(async () => a)
  ok(l.baseURL === "https://ark.cn-beijing.volces.com/api/plan/v1", "自动识别 loader：基地址取识别出来的（plan 补 /v1）")
  const r = await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(r.status === 200 && chats.length === 1, "自动识别 fetch：请求正常发出")
  ok(chats[0].headers.get("x-api-key") === RAW && chats[0].headers.get("authorization") === `Bearer ${RAW}`, "自动识别 fetch：用的是控制面取来的聊天 key，不是 AccessKey ID")
  ok(chats[0].headers.get("x-api-key") !== a.key, "自动识别 fetch：没有把 AK 当聊天 key 发出去")
  ok(!JSON.stringify(sets).includes(RAW) && !JSON.stringify(a).includes(RAW), "自动识别：明文聊天 key 没有写进账号保存的数据")
  const before = asked.length
  await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(asked.length === before, "自动识别：识别结果缓存，之后的请求不再打控制面")
}

// loader 加载时识别失败，请求时再试，并把地址换成识别出来的
reset(agentReplies())
{
  let calls = 0
  replies.GetPersonalPlan = (host, body) => {
    if (++calls <= 2) throw new Error("fetch failed") // 加载时两个域名都不通
    return body.Plan === "AgentPlan" ? AGENT_PLAN : NO_PLAN
  }
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: "AKLTlater" }))
  ok(l.baseURL === "https://ark.cn-beijing.volces.com/api/plan/v1" && chats.length === 0, "自动识别：加载时识别不了也能加载（用默认地址）")
  _internal.discoveryCache.clear()
  const r = await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(r.status === 200 && chats[0].headers.get("x-api-key") === RAW, "自动识别：加载失败后，请求时重试识别成功")
}
reset({
  GetPersonalPlan: (host, body) => (body.Plan === "CodingPlan" ? okr({ PlanType: "Lite", Status: "Running", EndTime: "2027-02-01T15:59:59Z" }) : NO_PLAN),
  ListApiKeys: listOf(item({ Id: 9 })),
  GetRawApiKey: okr({ ApiKey: RAW }),
})
{
  // 加载时识别不了，用默认的 plan 地址；请求时识别出是 coding，要把地址换成 /api/coding
  let first = true
  const real = replies.GetPersonalPlan
  replies.GetPersonalPlan = (h, b) => {
    if (first) throw new Error("fetch failed")
    return real(h, b)
  }
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: "AKLTswap" }))
  first = false
  _internal.discoveryCache.clear()
  _internal.discoveryInflight.clear()
  await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(chats[0].url === "https://ark.cn-beijing.volces.com/api/coding/v1/messages", "自动识别：请求时识别出是 coding，把请求地址从 /api/plan 换成 /api/coding")
}
ok(_internal.rewriteBase("https://a/b/v1/messages", "https://a/b/v1", "https://a/c/v1") === "https://a/c/v1/messages" && _internal.rewriteBase("https://x/y", "https://a", "https://b") === "https://x/y", "rewriteBase：只换前缀，不匹配不动")

// 识别失败时的回应
for (const [name, r, status, signIn] of [
  ["凭据不对", { GetPersonalPlan: err("InvalidAccessKey") }, 401, "expired"],
  ["没有套餐", { GetPersonalPlan: NO_PLAN, GetSeatInfo: okr({ SeatID: "" }) }, 403, "expired"],
  ["没有 key", { ...agentReplies(), ListApiKeys: listOf() }, 403, null],
  ["被拒绝读 key", { ...agentReplies(), GetRawApiKey: err("AccessDenied") }, 403, null],
  ["临时故障", { GetPersonalPlan: () => { throw new Error("fetch failed") } }, 503, null],
]) {
  reset(r)
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: `AKLTfail${name}` }))
  const res = await l.fetch(MSG, { method: "POST", body: "{}" })
  const body = await res.json()
  ok(res.status === status && res.headers.get("x-magpie-sign-in") === signIn && chats.length === 0 && body.error.code === "DiscoveryFailed" && body.error.message.includes("火山自动识别失败"), `识别失败（${name}）：${status}，${signIn ? "标记需要重新登录" : "不标记，magpie 切号"}，不发聊天请求`)
}

// key 被轮换：401 后强制重新识别一次，换了新 key 就重试
reset(agentReplies())
{
  let current = "ark-old-0000-1111-2222-3333-4444-aaaaa"
  replies.GetRawApiKey = () => okr({ ApiKey: current })
  chatReply = (c) => (c.headers.get("x-api-key") === "ark-new-0000-1111-2222-3333-4444-bbbbb" ? new Response("{}", { status: 200 }) : new Response('{"error":{"code":"AuthenticationError"}}', { status: 401 }))
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: "AKLTrotate" }))
  current = "ark-new-0000-1111-2222-3333-4444-bbbbb" // 控制面上的 key 被轮换了，缓存里还是旧的
  const r = await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(r.status === 200 && chats.length === 2 && chats[1].headers.get("x-api-key") === current, "key 被轮换：401 后重新取 key，用新 key 重试一次就成功了")
  const n = chats.length
  await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(chats.length === n + 1 && chats[n].headers.get("x-api-key") === current, "key 被轮换：之后的请求直接用新 key")
}
reset(agentReplies())
{
  chatReply = () => new Response('{"error":{"code":"AuthenticationError"}}', { status: 401 })
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: "AKLTsame" }))
  const r = await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(r.status === 401 && chats.length === 1, "401 但重新取到的是同一把 key：不重复请求，把 401 交给 magpie")
  chats.length = 0
  const r2 = await l.fetch(MSG, { method: "POST", body: new ReadableStream() })
  ok(r2.status === 401 && chats.length === 1, "请求体是流、不能重发时：不重试")
}

// 并发：同一个账号同时多个请求，只识别一次
reset(agentReplies())
{
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: "AKLTconc" }))
  _internal.discoveryCache.clear()
  asked.length = 0
  await Promise.all([1, 2, 3, 4, 5].map(() => l.fetch(MSG, { method: "POST", body: "{}" })))
  ok(asked.filter((a) => a.action === "GetRawApiKey").length === 1 && chats.length === 5, "并发：5 个请求同时来，只识别一次（GetRawApiKey 只调 1 次）")
}

// 刷新失败沿用旧结果
reset(agentReplies())
{
  const md = autoAuth({ accessKeyID: "AKLTkeep" }).metadata
  const first = await _internal.discover(md)
  replies.GetPersonalPlan = () => { throw new Error("fetch failed") }
  const again = await _internal.discover(md, { force: true })
  ok(again === first, "刷新识别失败（网络）：沿用旧结果，不让账号掉线")
  replies.GetPersonalPlan = err("InvalidAccessKey")
  let kind = ""
  try { await _internal.discover(md, { force: true }) } catch (e) { kind = e.kind }
  ok(kind === "credential", "刷新识别失败（凭据错误）：不沿用旧结果，如实报错")
}

// 到期拦截对自动识别账号同样生效（到期时间来自识别）
reset({ ...agentReplies(), GetPersonalPlan: (h, b) => (b.Plan === "AgentPlan" ? okr({ PlanType: "Medium", Status: "Running", EndTime: "2026-01-01T00:00:00Z", AutoRenew: false }) : NO_PLAN) })
{
  const l = await plugin.auth.loader(async () => autoAuth({ accessKeyID: "AKLTexp" }))
  const r = await l.fetch(MSG, { method: "POST", body: "{}" })
  ok(r.status === 403 && r.headers.get("x-magpie-sign-in") === "expired" && chats.length === 0, "自动识别账号：识别出订阅已到期，同样拦截")
}

// ---- 9) usage（自动识别账号）----
const usageReplies = (extra = {}) => ({
  ...agentReplies(),
  GetSeatInfo: okr({ SeatID: "" }),
  GetAFPUsage: okr({ PlanType: "medium", AFPFiveHour: { Quota: 10000, Used: 756.3365, ResetTime: 1795372070000 }, AFPWeekly: { Quota: 35000, Used: 3200.4534, ResetTime: 1795363200000 }, AFPMonthly: { Quota: 100000, Used: 3200.4534, ResetTime: 1797955199000 } }),
  ...extra,
})
reset(usageReplies())
{
  const u = await plugin.auth.usage(async () => autoAuth({ accessKeyID: "AKLTuse" }))
  ok(u.plan === "Agent Plan medium" && u.windows.map((w) => w.name).join() === "5 小时,周,月,Base URL", "usage 自动识别：套餐、三个窗口、Base URL")
  ok(u.windows.at(-1).display === "https://ark.cn-beijing.volces.com/api/plan", "usage 自动识别：Base URL 窗口显示识别出来的地址")
  ok(u.until === "2027-01-22T15:59:59.000Z" && u.renew === "off" && u.signIn === undefined && u.error === undefined, "usage 自动识别：到期、自动续费，没有错误")
}
for (const [name, r, signIn] of [
  ["凭据错", { GetPersonalPlan: err("InvalidAccessKey") }, "expired"],
  ["没有套餐", { GetPersonalPlan: NO_PLAN, GetSeatInfo: okr({ SeatID: "" }) }, "expired"],
  ["没有 key", { ...usageReplies(), ListApiKeys: listOf() }, "kept"],
  ["临时故障", { GetPersonalPlan: () => { throw new Error("fetch failed") } }, "kept"],
]) {
  reset(r)
  const u = await plugin.auth.usage(async () => autoAuth({ accessKeyID: `AKLTu${name}` }))
  ok(u.signIn === signIn && u.error.includes("火山自动识别失败") && u.windows.length === 0, `usage 自动识别失败（${name}）：${signIn === "expired" ? "标记需要重新登录" : "只显示原因"}`)
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过")
process.exit(failed ? 1 : 0)
