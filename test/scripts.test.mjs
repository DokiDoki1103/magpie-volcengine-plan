// 脚本和插件登录提示的对齐检查。运行：node test/scripts.test.mjs
// import-accounts.mjs 是按固定顺序往 `magpie plugin login` 灌答案的。这里用插件真实的提示列表（含"跳过无关项"的条件）
// 模拟 CLI 逐项提问，确认：灌的答案刚好被消耗完、每项都通过校验、最后能登录成功。
// 插件的提示顺序一变，这个测试就会变红，免得导入时默默填错位。
import { VolcenginePlanPlugin, _internal } from "../index.mjs"
import { LOGIN_SELECT, loginAnswers, accountLine, extractAccounts } from "../scripts/accounts-from-gateway.mjs"

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`)
  if (!cond) failed++
}

// 模拟 CLI：依次问每个条件成立的提示，下拉按编号选，非空回答要过校验
function runPrompts(prompts, answers) {
  const inputs = {}
  let used = 0
  for (const p of prompts) {
    if (p.condition && !p.condition(inputs)) continue
    if (used >= answers.length) return { error: `答案不够：问到 ${p.key} 时没有答案了` }
    let v = String(answers[used++])
    if (p.type === "select") {
      const opt = p.options[Number(v) - 1]
      if (!opt) return { error: `下拉编号 ${v} 没有对应的选项` }
      v = opt.value
    }
    const err = p.validate?.(v)
    if (err) return { error: `${p.key}：${err}` }
    inputs[p.key] = v
  }
  return { inputs, used, left: answers.length - used }
}

const plugin = await VolcenginePlanPlugin({ client: { auth: { set: async () => {} } } })
const method = plugin.auth.methods[0]
const P = _internal.LOGIN_PROMPTS

// 下拉编号和插件选项的顺序一致
ok(P[0].options.map((o) => o.value).join() === Object.keys(LOGIN_SELECT).join(), "脚本里的下拉编号表和插件的选项顺序一致")
ok(Object.entries(LOGIN_SELECT).every(([value, n]) => P[0].options[n - 1].value === value), "每个类型的编号都指向正确的选项")

const cases = [
  { kind: "plan", name: "主力", key: "ark-aaaa-bbbb", date: "2027-01-06" },
  { kind: "coding", name: "备用1", key: "11111111-2222-3333-4444-555555555555", date: "2026-12-31" },
  { kind: "plan", name: "", key: "ark-nonname", date: "" }, // 没有名称、没有到期日
]
for (const c of cases) {
  const answers = loginAnswers(c)
  const r = runPrompts(P, answers)
  ok(!r.error, `${c.kind} ${c.name || "(无名称)"}：每个答案都通过校验${r.error ? "（" + r.error + "）" : ""}`)
  ok(r.used === answers.length && r.left === 0, `${c.kind} ${c.name || "(无名称)"}：答案刚好用完（共 ${answers.length} 个，用了 ${r.used}）`)
  const done = await method.authorize(r.inputs ?? {})
  const base = c.kind === "plan" ? "https://ark.cn-beijing.volces.com/api/plan" : "https://ark.cn-beijing.volces.com/api/coding"
  ok(done.type === "success" && done.key === c.key && (done.accountId ?? "") === c.name && done.metadata.baseURL === base, `${c.kind} ${c.name || "(无名称)"}：登录成功，key、名称、地址都对`)
  ok((done.metadata.expiresAt ? done.metadata.expiresAt.slice(0, 10) : "") === (c.date ? new Date(Date.parse(c.date + "T23:59:59+08:00")).toISOString().slice(0, 10) : ""), `${c.kind} ${c.name || "(无名称)"}：到期日一致`)
  ok(!("accessKeyID" in done.metadata), `${c.kind} ${c.name || "(无名称)"}：AccessKey 留空，不会多问 Secret 和地区`)
}

// 从 ai-gateway 导出的数据整理出来的账号能直接用
{
  const list = [{ id: 1, name: "测试甲", api_key: "ark-test-key-1", upstream_url: "https://ark.cn-beijing.volces.com/api/coding", enabled: true, expires_at: "2027-01-06T15:59:59Z" }]
  const { accounts } = extractAccounts(list)
  const answers = loginAnswers(accounts[0])
  ok(answers.join("|") === "3|测试甲|ark-test-key-1|2027-01-06|", "导出数据 -> 登录答案：[coding 编号 3, 名称, key, 北京时间日期, 空 AccessKey]")
  ok(!runPrompts(P, answers).error && accountLine(accounts[0], { mask: true }) === "测试甲 ***ey-1 2027-01-06", "导出数据：答案通过，显示行里 key 打码")
}

console.log(failed ? `\n${failed} 项失败` : "\n全部通过")
process.exit(failed ? 1 : 0)
