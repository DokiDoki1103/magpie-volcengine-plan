// package.json 里 magpie 字段的检查。运行：node test/package.test.mjs
// magpie 读这些字段：icon（发现页卡片、已安装、供应商图标）、name、summary（每种语言一行，最多 300 字节）、maxConcurrency。
// 超限或格式不对时 magpie 会直接忽略，卡片就退回默认样子，所以放在测试里盯着。
import { readFileSync } from "node:fs"

let failed = 0
const ok = (cond, msg) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`)
  if (!cond) failed++
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
const m = pkg.magpie ?? {}

// icon：https:// 地址或 data:image/… URI，最大 1 MB
ok(typeof m.icon === "string" && /^(https:\/\/|data:image\/)/.test(m.icon), "icon：是 https:// 地址或 data:image/ URI")
ok(Buffer.byteLength(m.icon ?? "") <= 1024 * 1024, "icon：不超过 1 MB")
{
  const mm = /^data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)$/.exec(m.icon ?? "")
  ok(Boolean(mm), "icon：是 base64 编码的 SVG data URI")
  const svg = mm ? Buffer.from(mm[1], "base64").toString("utf8") : ""
  ok(/^<svg[\s>]/.test(svg.trim()) && /<\/svg>\s*$/.test(svg), "icon：解码后是一个完整的 <svg> 元素")
  ok(!/<script|href=|xlink|\son\w+=|javascript:|<foreignObject|<image/i.test(svg), "icon：SVG 里没有脚本、外链、事件属性")
  ok(!svg.includes("elementtiming"), "icon：没有浏览器性能监控的残留属性")
  // 仓库里的 icon.svg 和 package.json 里内嵌的是同一份
  const file = readFileSync(new URL("../icon.svg", import.meta.url), "utf8")
  ok(file === svg, "icon：仓库里的 icon.svg 和 package.json 里内嵌的一致（改一处要同步另一处）")
}

ok(typeof m.name === "string" && Buffer.byteLength(m.name) <= 80 && !m.name.includes("\n"), "name：一行，最多 80 字节")
ok(Object.entries(m.summary ?? {}).length >= 1 && Object.values(m.summary).every((s) => Buffer.byteLength(s) <= 300 && !s.includes("\n")), "summary：每种语言一行，最多 300 字节")
ok(Number.isInteger(m.maxConcurrency) && m.maxConcurrency >= 1 && m.maxConcurrency <= 1000, "maxConcurrency：1 到 1000 的整数")
ok(pkg.keywords.includes("magpie-plugin"), "keywords：带 magpie-plugin（GitHub 话题要单独设置，这里只是 npm 的关键词）")
ok(pkg.main === "./index.mjs" && (pkg.files ?? []).includes("quota.mjs") && pkg.files.includes("discover.mjs"), "main 和 files：入口及它 import 的模块都在 files 里（npm 发布不会丢文件）")

console.log(failed ? `\n${failed} 项失败` : "\n全部通过")
process.exit(failed ? 1 : 0)
