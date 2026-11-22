#!/usr/bin/env node
// 把 ai-gateway 里的火山账号一次性导入 k3s 里的 magpie（火山方舟订阅插件）。
// 在你自己的终端里运行：key 只经过这个脚本和 kubectl 的标准输入，不出现在命令行参数里。
//
// 默认只演练（打印计划，key 打码，不改任何东西）；确认没问题再加 --yes 真正导入。
//
//   node import-accounts.mjs keys.json                       # 演练
//   node import-accounts.mjs keys.json --yes                 # 真正导入
//   curl -s <ai-gateway>/api/admin/keys -H '…' | node import-accounts.mjs --yes
//
// 选项：
//   --skip a,b,c        跳过名称里含这些片段的账号（比如已经在 magpie 里的）
//   --only x            只导入名称里含 x 的账号（先拿一个试）
//   --include-flagged   连被标注 [!] 的账号一起导入（默认跳过：已禁用 / 有禁用记录 / 到期日已过）
//   --deploy deploy/magpie   kubectl exec 的目标（默认 deploy/magpie）
//   --provider volcengine-plan
// 环境变量：KUBECONFIG 照常生效；KUBECTL 可指定 kubectl 的路径（默认 kubectl）。
//
// 每个账号等价于在 magpie 里手动做：登录 -> 下拉选 plan/coding -> 依次填 名称、API key、到期日，AccessKey 留空。
// 这些项是按行灌进 `magpie plugin login` 的标准输入的，顺序必须和插件的登录提示一致（见 accounts-from-gateway.mjs）。
// 插件或 magpie 改了提示顺序后，先用 --only 导一个确认，再全量。

import { readFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { extractAccounts, accountLine, loginAnswers } from "./accounts-from-gateway.mjs"

const args = process.argv.slice(2)
const flag = (n) => args.includes(n)
const opt = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const valueOptions = new Set(["--skip", "--only", "--deploy", "--provider"])
const file = args.find((a, i) => !a.startsWith("--") && !valueOptions.has(args[i - 1]))

const yes = flag("--yes")
const includeFlagged = flag("--include-flagged")
const skips = String(opt("--skip", "")).split(/[,，]/).map((s) => s.trim()).filter(Boolean)
const only = opt("--only", "")
const deploy = opt("--deploy", "deploy/magpie")
const provider = opt("--provider", "volcengine-plan")
const kubectl = process.env.KUBECTL || "kubectl"

function readInput() {
  if (file) return readFileSync(file, "utf8")
  if (process.stdin.isTTY) {
    console.error("请给 JSON 文件路径，或用管道传入。见脚本开头的用法。")
    process.exit(1)
  }
  return readFileSync(0, "utf8")
}

let list
try {
  list = JSON.parse(readInput())
} catch (e) {
  console.error("不是合法的 JSON：" + e.message)
  process.exit(1)
}
if (!Array.isArray(list)) {
  console.error("期望是账号数组（GET /api/admin/keys 的返回）")
  process.exit(1)
}

const { accounts, ignored, renamed } = extractAccounts(list)
const todo = []
const skipped = []
for (const a of accounts) {
  if (only && !a.name.includes(only)) continue
  const hit = skips.find((s) => a.name.includes(s))
  if (hit) { skipped.push(`${a.name}（--skip ${hit}）`); continue }
  if (a.flags.length && !includeFlagged) { skipped.push(`${a.name}（${a.flags.join("、")}）`); continue }
  todo.push(a)
}

console.log(yes ? `== 开始导入 ${todo.length} 个账号 -> ${deploy}（${provider}）==` : `== 演练：将导入 ${todo.length} 个账号 -> ${deploy}（${provider}），key 已打码，不会改动任何东西 ==`)
for (const a of todo) console.log(`  [${a.kind}] ${accountLine(a, { mask: true })}`)
if (skipped.length) console.log("\n跳过：\n  " + skipped.join("\n  "))
if (ignored.length) console.log("\n非火山账号，已忽略：\n  " + ignored.join("\n  "))
if (renamed.length) console.log("\n名称里有空格或逗号，已替换成下划线：" + renamed.join("；"))

if (!yes) {
  console.log("\n确认无误后加 --yes 真正导入。")
  process.exit(0)
}

let ok = 0
let bad = 0
for (const a of todo) {
  const input = loginAnswers(a).join("\n") + "\n"
  const r = spawnSync(kubectl, ["exec", "-i", deploy, "--", "/magpie", "plugin", "login", provider], {
    input,
    encoding: "utf8",
    timeout: 120000,
  })
  // 输出里万一回显了 key 就打码
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.split(a.key).join("***").trim().split("\n").filter(Boolean)
  const tail = out.slice(-1)[0] ?? ""
  if (r.status === 0) {
    ok++
    console.log(`✓ ${a.name}  ${tail}`)
  } else {
    bad++
    console.log(`✗ ${a.name}  退出码 ${r.status ?? r.error?.message}  ${tail}`)
  }
}
console.log(`\n完成：成功 ${ok}，失败 ${bad}。`)
console.log("到 magpie 的 火山方舟订阅 页面确认账号都在；如果页面没出现，把插件关掉再打开一次。")
process.exit(bad ? 1 : 0)
