// 插件自测：mock 掉 fetch 和 client，不连真实火山。运行：node test/plugin.test.mjs
import { VolcenginePlanPlugin, _internal } from "../index.mjs"

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`)
  if (!cond) failed++
}

// 1) 纯函数
const msg = "You have exceeded the quota, reset at 2026-11-23 15:00:00"
ok(_internal.parseResetTime(msg) === Date.parse("2026-11-23T15:00:00+08:00"), "恢复时间按北京时间解析")
ok(_internal.parseResetTime("no time here") === 0, "没有恢复时间返回 0")
ok(_internal.parseError('{"error":{"code":"AccountQuotaExceeded","message":"x"}}').code === "AccountQuotaExceeded", "解析 {error:{code}}")
ok(_internal.parseError('{"code":"AccountDisabled","message":"x"}').code === "AccountDisabled", "解析顶层 code")
ok(_internal.parseError("not json").code === undefined, "非 JSON 不崩")
ok(_internal.windowFor(2 * 3600 * 1000).name === "5 小时", "2 小时 -> 5 小时窗口")
ok(_internal.windowFor(3 * 86400 * 1000).name === "7 天", "3 天 -> 7 天窗口")
ok(_internal.windowFor(20 * 86400 * 1000).name === "月", "20 天 -> 月窗口")

// 真实的火山 429 响应体（周、月各一条）
const REAL_MONTH = '{"error":{"code":"AccountQuotaExceeded","message":"You have exceeded the monthly usage quota. It will reset at 2026-12-06 23:59:59 +0800 CST. We recommend upgrading your plan for more quota, or waiting for the reset. Request id: 0217952068","param":"","type":"TooManyRequests"}}'
const REAL_WEEK = '{"error":{"code":"AccountQuotaExceeded","message":"You have exceeded the weekly usage quota. It will reset at 2026-11-23 00:00:00 +0800 CST. We recommend upgrading your plan for more quota, or waiting for the reset. Request id: 0217953536","param":"","type":"TooManyRequests"}}'
const mErr = _internal.parseError(REAL_MONTH)
const wErr = _internal.parseError(REAL_WEEK)
ok(mErr.code === "AccountQuotaExceeded" && wErr.code === "AccountQuotaExceeded", "真实响应：code 解析正确")
ok(_internal.parseResetTime(mErr.message) === Date.parse("2026-12-06T23:59:59+08:00"), "真实月额度响应：恢复时间 2026-12-06 23:59:59 +08:00")
ok(_internal.parseResetTime(wErr.message) === Date.parse("2026-11-23T00:00:00+08:00"), "真实周额度响应：恢复时间 2026-11-23 00:00:00 +08:00")
ok(_internal.windowKind(mErr.message) === "monthly" && _internal.windowKind(wErr.message) === "weekly", "真实响应：识别出 monthly / weekly")
ok(_internal.windowInfo("monthly", 1).name === "月" && _internal.windowInfo("weekly", 1).name === "周", "窗口名：月 / 周")
ok(_internal.windowInfo("", 2 * 3600 * 1000).name === "5 小时", "没写明窗口类型时按剩余时间兜底")

// 2) 整条链路：429 -> 暂停 -> 短路 -> metadata 落盘
const saved = []
const client = { auth: { set: async (a) => saved.push(a) } }
const plugin = await VolcenginePlanPlugin({ client })
const auth = { type: "api", key: "ark-test" }
const { fetch: pfetch } = await plugin.auth.loader(async () => auth)

const resetAt = new Date(Date.now() + 2 * 3600 * 1000)
const pad = (n) => String(n).padStart(2, "0")
const bj = new Date(resetAt.getTime() + 8 * 3600 * 1000) // 转成北京时间的各字段
const stamp = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())} ${pad(bj.getUTCHours())}:${pad(bj.getUTCMinutes())}:${pad(bj.getUTCSeconds())}`

let upstreamCalls = 0
let nextResponse
globalThis.fetch = async () => {
  upstreamCalls++
  return nextResponse()
}

nextResponse = () =>
  new Response(JSON.stringify({ error: { code: "AccountQuotaExceeded", message: `You have exceeded the weekly usage quota. It will reset at ${stamp} +0800 CST.` } }), { status: 429 })
const r1 = await pfetch("https://x/messages", { method: "POST", body: "{}" })
ok(r1.status === 429 && upstreamCalls === 1, "第一次 429 原样返回，并且请求了上游")
ok(saved.length === 1 && saved[0].body.metadata.suspendUntil, "暂停时间写进了账号 metadata")

const r2 = await pfetch("https://x/messages", { method: "POST", body: "{}" })
ok(r2.status === 429 && upstreamCalls === 1, "暂停期内不再请求上游，直接回 429")
ok(Number(r2.headers.get("retry-after")) > 0, "带 retry-after")

// 3) 从 metadata 恢复：重启后 loader 读到暂停时间
const plugin2 = await VolcenginePlanPlugin({ client })
const { fetch: f2 } = await plugin2.auth.loader(async () => saved[0].body)
const r3 = await f2("https://x/messages", { method: "POST", body: "{}" })
ok(r3.status === 429 && upstreamCalls === 1, "重启后读 metadata 仍处于暂停")

// 4) usage 钩子
const usage = await plugin.auth.usage(async () => saved[0].body)
ok(saved[0].body.metadata.suspendWindow === "weekly", "metadata 里记下了窗口类型 weekly")
ok(usage.windows[0].used === 100 && usage.windows[0].name === "周", "暂停时 usage 报「周」窗口已满（取自 429 原话，不看剩余时间）")
ok(usage.windows.filter((w) => !w.aside).length === 1, "暂停时只有一个会影响路由的窗口，Base URL 窗口是 aside")
const usage2 = await plugin.auth.usage(async () => auth)
ok(usage2.windows.length === 1 && usage2.windows[0].aside === true && usage2.windows[0].used === undefined, "未暂停时只有 aside 的 Base URL 窗口，没有用量")
ok(usage2.windows[0].display === "https://ark.cn-beijing.volces.com/api/plan", "没有自定义地址：显示默认根地址（不带 /v1）")
const usageNamed = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { name: "主力" } }))
ok(usageNamed.user === undefined, "usage 不返回 user（标题只由登录时的名称决定）")
ok(usageNamed.windows.length === 1 && usageNamed.windows[0].name === "Base URL", "usage 只有 Base URL 窗口，不再重复显示名称")
const usage3 = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { baseURL: "https://custom.example/v1/" } }))
ok(usage3.windows[0].display === "https://custom.example/v1", "有自定义地址：显示账号自己的 Base URL")

// 5) 永久错误打 expired 头
const plugin3 = await VolcenginePlanPlugin({ client })
const { fetch: f3 } = await plugin3.auth.loader(async () => auth)
nextResponse = () => new Response(JSON.stringify({ error: { code: "AccountDisabled", message: "disabled" } }), { status: 403 })
const r4 = await f3("https://x/messages", { method: "POST", body: "{}" })
ok(r4.status === 403 && r4.headers.get("x-magpie-sign-in") === "expired", "AccountDisabled -> 403 + x-magpie-sign-in: expired")

// 6) 普通 429（不是额度用尽）不暂停
nextResponse = () => new Response(JSON.stringify({ error: { code: "RateLimitExceeded", message: "slow down" } }), { status: 429 })
const before = saved.length
const r5 = await f3("https://x/messages", { method: "POST", body: "{}" })
ok(r5.status === 429 && saved.length === before, "普通限流 429 不触发暂停")

// 7) 每账号自定义名称和 Base URL
const method = plugin.auth.methods[0]
ok(method.prompts.map((p) => p.key).join() === "type,account", "登录两步：订阅类型下拉 + 一行输入")
ok(method.prompts[0].type === "select" && method.prompts[0].options.map((o) => o.value).join() === "plan,coding,custom", "下拉选项：plan / coding / 自定义地址")
const r6 = await method.authorize({ account: "  备用1  https://example.com/api/plan/v1/  ark-x " })
ok(r6.type === "success" && r6.key === "ark-x" && r6.metadata.name === "备用1", "三项：名称存 metadata.name，key 去空白")
ok(r6.accountId === "备用1" && !("email" in r6.metadata), "名称作 accountId（卡片标题），不写 metadata.email")
ok(r6.metadata.baseURL === "https://example.com/api/plan/v1", "三项：Base URL 去掉末尾 /")
const r7 = await method.authorize({ account: "ark-y" })
ok(r7.type === "success" && r7.key === "ark-y" && r7.accountId === undefined && !("baseURL" in r7.metadata), "只有 key：用默认地址、无 accountId（标题用默认的 API key …尾号）")
const r7b = await method.authorize({ account: "主力 ark-z" })
ok(r7b.metadata.name === "主力" && r7b.key === "ark-z" && !("baseURL" in r7b.metadata), "名称 + key：用默认地址")
const r7c = await method.authorize({ account: "https://x.example/v1 ark-q 备用" })
ok(r7c.type === "failed" || r7c.key === "备用", "顺序约定：最后一项是 key（这里最后是「备用」，按约定当作 key）")
const r7d = await method.authorize({ account: "主力,https://x.example/v1,ark-w" })
ok(r7d.metadata.name === "主力" && r7d.key === "ark-w" && r7d.metadata.baseURL === "https://x.example/v1", "逗号分隔也行")
ok((await method.authorize({ account: "  " })).type === "failed", "空输入返回 failed")
ok((await method.authorize({ account: "a b c ark-d" })).type === "failed", "多于两项非地址的内容返回 failed")
ok((await method.authorize({ account: "https://a/v1 https://b/v1 ark-d" })).type === "failed", "两个地址返回 failed")
ok((await method.authorize({ account: "https://a/v1" })).type === "failed", "只有地址没有 key 返回 failed")
const lineP = method.prompts.find((p) => p.key === "account")
ok(lineP.validate("") !== undefined && lineP.validate("主力 ark-x") === undefined, "输入框校验：空不通过、合法通过")

const custom = await plugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { baseURL: "https://custom.example/v1" } }))
ok(custom.baseURL === "https://custom.example/v1", "loader 用账号自己的 Base URL")
const dflt = await plugin.auth.loader(async () => ({ type: "api", key: "k" }))
ok(dflt.baseURL === "https://ark.cn-beijing.volces.com/api/plan/v1", "没有自定义地址的老账号用默认地址（根地址补 /v1）")

// 10) 订阅类型下拉 + 请求路径补 /v1
ok(_internal.apiBase("https://ark.cn-beijing.volces.com/api/coding") === "https://ark.cn-beijing.volces.com/api/coding/v1", "apiBase：根地址补 /v1")
ok(_internal.apiBase("https://x.example/api/coding/") === "https://x.example/api/coding/v1", "apiBase：末尾 / 先去掉")
ok(_internal.apiBase("https://x.example/v1") === "https://x.example/v1" && _internal.apiBase("https://x.example/api/v3") === "https://x.example/api/v3", "apiBase：已经以 /v1、/v3 结尾的不再补")
const codingLoader = await plugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { baseURL: "https://ark.cn-beijing.volces.com/api/coding" } }))
ok(codingLoader.baseURL === "https://ark.cn-beijing.volces.com/api/coding/v1", "老账号存的是 .../api/coding：请求时自动补 /v1（实测不补是 404）")
const tPlan = await method.authorize({ type: "plan", account: "主力 ark-k" })
ok(tPlan.metadata.baseURL === "https://ark.cn-beijing.volces.com/api/plan" && tPlan.accountId === "主力", "下拉选 plan：存 .../api/plan，不用写地址")
const tCoding = await method.authorize({ type: "coding", account: "主力 ark-k 2026-12-31" })
ok(tCoding.metadata.baseURL === "https://ark.cn-beijing.volces.com/api/coding" && tCoding.metadata.expiresAt, "下拉选 coding：存 .../api/coding，到期日照常")
const tCustom = await method.authorize({ type: "custom", account: "主力 https://my.example/api ark-k" })
ok(tCustom.type === "success" && tCustom.metadata.baseURL === "https://my.example/api", "下拉选自定义：用这一行里写的地址")
ok((await method.authorize({ type: "custom", account: "主力 ark-k" })).type === "failed", "选了自定义但没写地址：报错")
const tOverride = await method.authorize({ type: "plan", account: "主力 https://my.example/api ark-k" })
ok(tOverride.metadata.baseURL === "https://my.example/api", "这一行里写了地址：优先于下拉")
const tNone = await method.authorize({ account: "ark-k" })
ok(!("baseURL" in tNone.metadata), "没选类型也没写地址：不存地址，用默认的 plan")

// 9) 手填的订阅到期时间
ok(_internal.parseExpiry("2026-12-31") === new Date("2026-12-31T23:59:59+08:00").toISOString(), "到期日按北京时间当天 23:59:59")
ok(_internal.parseExpiry("2026/1/5") === new Date("2026-01-05T23:59:59+08:00").toISOString(), "也认 YYYY/M/D")
ok(_internal.parseExpiry("2026-02-30") === "" && _internal.parseExpiry("2026-13-01") === "" && _internal.parseExpiry("abc") === "", "非法日期返回空")
ok(_internal.parseExpiry("2028-02-29") !== "" && _internal.parseExpiry("2027-02-29") === "", "闰年 2 月 29 日只在闰年有效")
const e1 = await method.authorize({ account: "主力 https://x.example/v1 ark-k 2026-12-31" })
ok(e1.type === "success" && e1.key === "ark-k" && e1.accountId === "主力" && e1.metadata.baseURL === "https://x.example/v1" && e1.metadata.expiresAt === "2026-12-31T15:59:59.000Z", "四项齐全：名称、地址、key、到期日")
const e2 = await method.authorize({ account: "2026-12-31 主力 ark-k" })
ok(e2.type === "success" && e2.accountId === "主力" && e2.key === "ark-k" && e2.metadata.expiresAt, "到期日位置随意")
const e3 = await method.authorize({ account: "ark-k" })
ok(!("expiresAt" in e3.metadata), "没填到期日不写 expiresAt")
ok((await method.authorize({ account: "ark-k 2026-02-30" })).type === "failed", "非法到期日返回 failed")
ok((await method.authorize({ account: "ark-k 2026-12-01 2026-12-31" })).type === "failed", "两个到期日返回 failed")
ok(lineP.validate("ark-k 2026-02-30") !== undefined, "输入框校验也拦非法日期")

const future = new Date(Date.now() + 30 * 86400 * 1000).toISOString()
const past = new Date(Date.now() - 86400 * 1000).toISOString()
const ux1 = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { expiresAt: future } }))
ok(ux1.until === future && ux1.plan === "火山方舟订阅", "usage 返回 until，未到期套餐名不变")
const ux2 = await plugin.auth.usage(async () => ({ type: "api", key: "k", metadata: { expiresAt: past } }))
ok(ux2.until === past && ux2.plan === "火山方舟订阅（已到期）", "过期后套餐名标注「已到期」")
ok(ux2.signIn === "expired" && ux2.error.includes("已于") && ux2.error.includes("到期"), "过期后 usage 标成需要重新登录，并说明原因")
ok(ux1.signIn === undefined && ux1.error === undefined, "未到期不标记")
const ux3 = await plugin.auth.usage(async () => ({ type: "api", key: "k" }))
ok(!("until" in ux3) && ux3.signIn === undefined, "没填到期日不返回 until，也不标记")
ok(ux2.error.includes(_internal.beijingDate(Date.parse(past))), "提示里的到期日按北京时间显示")

// 到期后拦截：不请求上游，回 403 + x-magpie-sign-in: expired
nextResponse = () => new Response("{}", { status: 200 })
const callsBefore = upstreamCalls
const expiredLoader = await plugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { expiresAt: past } }))
const rExp = await expiredLoader.fetch("https://x/messages", { method: "POST", body: "{}" })
ok(rExp.status === 403 && rExp.headers.get("x-magpie-sign-in") === "expired", "到期后拦截：403 + x-magpie-sign-in: expired")
ok(upstreamCalls === callsBefore, "到期后不请求上游")
const bodyExp = await rExp.json()
ok(bodyExp.error.code === "SubscriptionExpired" && bodyExp.error.message.includes("续费"), "到期响应带原因和续费提示")
// 未到期、没填日期：正常放行
const okLoader = await plugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { expiresAt: future } }))
const rOk = await okLoader.fetch("https://x/messages", { method: "POST", body: "{}" })
ok(rOk.status === 200 && upstreamCalls === callsBefore + 1, "未到期：正常请求上游")
const noExpLoader = await plugin.auth.loader(async () => ({ type: "api", key: "k" }))
const rNo = await noExpLoader.fetch("https://x/messages", { method: "POST", body: "{}" })
ok(rNo.status === 200, "没填到期日：正常请求上游")
// 续费后用同名重新添加，新的 metadata 带新日期，不再被拦
const renewed = await method.authorize({ account: `主力 ark-k ${new Date(Date.now() + 40 * 86400 * 1000).toISOString().slice(0, 10)}` })
const renewedLoader = await plugin.auth.loader(async () => ({ type: "api", key: renewed.key, metadata: renewed.metadata }))
const rRen = await renewedLoader.fetch("https://x/messages", { method: "POST", body: "{}" })
ok(rRen.status === 200, "续费后重新添加、填新到期日：恢复调度")

// 8) 迁移：清掉上一版写进去的 metadata.email（和 name 相同的才清）
const migSaved = []
const migPlugin = await VolcenginePlanPlugin({ client: { auth: { set: async (a) => migSaved.push(a) } } })
await migPlugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { name: "主力", email: "主力", baseURL: "https://m.example/v1" } }))
ok(migSaved.length === 1 && !("email" in migSaved[0].body.metadata) && migSaved[0].body.metadata.name === "主力" && migSaved[0].body.metadata.baseURL === "https://m.example/v1", "迁移：去掉和名称相同的 email，其余 metadata 保留")
migSaved.length = 0
await migPlugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { name: "主力", email: "real@x.com" } }))
ok(migSaved.length === 0, "真邮箱不动")
await migPlugin.auth.loader(async () => ({ type: "api", key: "k", metadata: { name: "主力" } }))
ok(migSaved.length === 0, "没有 email 不触发保存")

console.log(failed ? `\n${failed} 项失败` : "\n全部通过")
process.exit(failed ? 1 : 0)
