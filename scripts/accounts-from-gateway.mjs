// 把 ai-gateway 的 GET /api/admin/keys 返回的 JSON 整理成火山账号清单。
// export-for-magpie.mjs 和 import-accounts.mjs 共用。只做解析，不联网、不写文件。

const HOUR = 3600 * 1000

// ISO 时间 -> 北京时间的 YYYY-MM-DD；空或不合法返回空串
export function beijingDate(iso) {
  const t = Date.parse(iso ?? "")
  return Number.isNaN(t) ? "" : new Date(t + 8 * HOUR).toISOString().slice(0, 10)
}

// list：ai-gateway 的账号数组。返回 { accounts, ignored, renamed }
//   accounts: [{ id, kind: "plan"|"coding", name, key, date, flags: string[] }]
//   flags：被标注的原因（已在 ai-gateway 禁用 / 有禁用记录 / 到期日已过）
export function extractAccounts(list, { now = Date.now() } = {}) {
  const accounts = []
  const ignored = []
  const renamed = []
  for (const a of list) {
    const url = String(a.upstream_url ?? "")
    const isVolc = url.includes("volces.com") && a.type !== "codex" && a.api_key
    if (!isVolc) {
      let host = ""
      try { host = new URL(url).hostname } catch {}
      ignored.push(`${a.id} ${a.name ?? ""} (${a.type ?? host})`)
      continue
    }
    const kind = /\/api\/coding\/?$/.test(url) ? "coding" : /\/api\/plan\/?$/.test(url) ? "plan" : ""
    if (!kind) {
      ignored.push(`${a.id} ${a.name ?? ""} (地址不是 .../api/plan 或 .../api/coding：${url})`)
      continue
    }
    const flags = []
    if (a.enabled === false) flags.push("已在 ai-gateway 禁用")
    if (a.disable_reason) flags.push("有禁用记录(" + (/"code":"(\w+)"/.exec(a.disable_reason)?.[1] ?? "?") + ")")
    const exp = Date.parse(a.expires_at ?? "")
    if (!Number.isNaN(exp) && exp <= now) flags.push("到期日已过")
    let name = String(a.name ?? "").trim()
    if (/[\s,，|]/.test(name)) {
      renamed.push(`${a.id} ${name}`)
      name = name.replace(/[\s,，|]+/g, "_")
    }
    accounts.push({ id: a.id, kind, name, key: String(a.api_key).trim(), date: beijingDate(a.expires_at), flags })
  }
  return { accounts, ignored, renamed }
}

// 登录时要粘贴的那一行：名称 key 到期日
export function accountLine(a, { mask = false } = {}) {
  return [a.name, mask ? `***${a.key.slice(-4)}` : a.key, a.date].filter(Boolean).join(" ")
}
