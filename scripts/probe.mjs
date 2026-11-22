#!/usr/bin/env node
// 探测一个账号的控制面返回，用来核对插件的解析（额度窗口、套餐到期）和真实返回是否一致。
// 在你自己的终端里运行；AK/SK 从环境变量读，不要写在命令行参数里（会进 shell 历史和进程列表）。
//
//   export VOLC_AK=AKLT…        # AccessKey ID
//   read -rs VOLC_SK && export VOLC_SK    # 粘贴 Secret，回车（不回显）
//   node scripts/probe.mjs coding           # Coding Plan
//   node scripts/probe.mjs agent            # Agent Plan（个人版或团队版）
//   node scripts/probe.mjs agent cn-shanghai
//
// 输出是火山返回的原始 JSON（不含你的 AK/SK）。贴给别人之前请自己扫一眼：
// 返回里可能带账号 ID、席位 ID 之类，不想给就先打码。
//
// 每个接口独立调用，某个失败不影响其他；失败会打印错误码，这本身就是有用的信息。

import { call, planOf, regionOf, timeMs } from "../quota.mjs"

const ak = (process.env.VOLC_AK ?? "").trim()
const sk = (process.env.VOLC_SK ?? "").trim()
const plan = process.argv[2] === "coding" ? "coding" : process.argv[2] === "agent" ? "agent" : ""
const region = (process.argv[3] ?? "").trim() || "cn-beijing"

if (!ak || !sk || !plan) {
  console.error("用法：先设置环境变量 VOLC_AK 和 VOLC_SK，再运行  node scripts/probe.mjs coding|agent [region]\n详见脚本开头的说明。")
  process.exit(1)
}

const show = (title, v) => console.log(`\n===== ${title}\n${typeof v === "string" ? v : JSON.stringify(v, null, 2)}`)

async function probe(action, body, host) {
  const label = `${action}${host ? ` @ ${host}` : ""}`
  try {
    const r = await call({ ak, sk, region, action, body, ...(host ? { host } : {}) })
    show(label, r)
    return r
  } catch (e) {
    show(label, `失败：${e.message}${e.code ? `  (错误码 ${e.code})` : ""}`)
    return undefined
  }
}

const planName = plan === "coding" ? "CodingPlan" : "AgentPlan"
// 套餐到期：两个域名都试，看哪个能用
const regional = await probe("GetPersonalPlan", { Plan: planName }, `ark.${region}.volcengineapi.com`)
const open = await probe("GetPersonalPlan", { Plan: planName }, "open.volcengineapi.com")
const got = regional ?? open
if (got?.EndTime !== undefined) {
  const ms = timeMs(got.EndTime)
  show("插件对 EndTime 的解析", `原始值 ${JSON.stringify(got.EndTime)}  ->  ${ms ? new Date(ms).toISOString() + "（UTC）" : "解析失败，返回 0（需要告诉我这个格式）"}`)
}

// 额度
if (plan === "coding") {
  await probe("GetCodingPlanUsage", {})
} else {
  const seat = await probe("GetSeatInfo", { ProjectName: "default", Scene: "agent_plan_enterprise" })
  if (seat?.SeatID) await probe("GetAgentPlanSeatAFPUsage", { SeatIDs: [seat.SeatID] })
  await probe("GetAFPUsage", {})
}

console.log(`\n插件会把这个账号当作：套餐类型 ${planOf(`https://ark.${region}.volces.com/api/${plan === "coding" ? "coding" : "plan"}`)}，地区 ${regionOf(`https://ark.${region}.volces.com/api/plan`)}`)
process.exit(0)
