#!/usr/bin/env node
// 把 ai-gateway 的 GET /api/admin/keys 导出的 JSON 整理成"火山方舟订阅"插件登录时要填的内容，方便对照着手动添加。
// 只读本地输入、只往终端输出，不联网、不写文件。非火山的账号（codex、ollama 等）会被忽略。
// 想全自动导入，用 import-accounts.mjs。
//
// 用法：
//   node export-for-magpie.mjs keys.json              # 从文件读
//   curl -s <ai-gateway>/api/admin/keys -H '…' | node export-for-magpie.mjs      # 从标准输入读
//   node export-for-magpie.mjs keys.json --mask       # 预览：key 只显示末 4 位
//   node export-for-magpie.mjs keys.json --skip-flagged   # 跳过被标注 [!] 的账号
//
// 输出按订阅类型分组（plan / coding），每行是：
//   名称 API-key 到期日
// magpie 添加账号时下拉选这一组的类型，然后依次填 名称、API key、到期日，AccessKey 留空（回车跳过）。
// 到期日取 expires_at，按北京时间换成 YYYY-MM-DD。

import { readFileSync } from "node:fs"
import { extractAccounts, accountLine } from "./accounts-from-gateway.mjs"

const args = process.argv.slice(2)
const mask = args.includes("--mask")
const skipFlagged = args.includes("--skip-flagged")
const file = args.find((a) => !a.startsWith("--"))

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
const skipped = []
const picked = accounts.filter((a) => {
  if (skipFlagged && a.flags.length) {
    skipped.push(`${a.id} ${a.name} (已跳过：${a.flags.join("、")})`)
    return false
  }
  return true
})

for (const kind of ["plan", "coding"]) {
  const g = picked.filter((a) => a.kind === kind)
  console.log(`\n# ${kind}（${g.length} 个）：添加账号时下拉选 ${kind}，再依次填 名称、API key、到期日（AccessKey 留空）`)
  for (const a of g) console.log(accountLine(a, { mask }) + (a.flags.length ? `    # [!] ${a.flags.join("、")}` : ""))
}
console.log(`\n共 ${picked.length} 个火山账号。`)
if (renamed.length) console.error("名称里有空格或逗号，已替换成下划线：" + renamed.join("；"))
const notes = [...ignored, ...skipped]
if (notes.length) console.error("已忽略：\n  " + notes.join("\n  "))
if (mask) console.error("（--mask 预览模式：key 只显示末 4 位，不能直接使用）")
process.exit(0)
