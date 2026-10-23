// verify-all.mjs 里 checkArkTsDuplicateMembers() 的自测（不动真实文件：注入伪 readFileSync）。
//
// 为什么需要自测：该门禁靠 maskNonCode() 先把模板字面量/字符串/注释屏蔽掉，再扫 2 空格
// 缩进的成员声明。屏蔽逻辑一旦写错，要么漏报（真机构建 10505001 又炸），要么把
// Index.ets 注入 JS 里 2 空格缩进的 mock 调用误判成方法 → 门禁假红。
//   node scripts/self-test-arkts-dup-gate.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const HARMONY = resolve(HERE, '..')
const ROOT = resolve(HARMONY, '..')
const src = readFileSync(resolve(HERE, 'verify-all.mjs'), 'utf8')

function grab(name) {
  const i = src.indexOf('function ' + name + '(')
  if (i < 0) throw new Error('没找到 ' + name)
  let depth = 0
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++
    else if (src[k] === '}') { depth--; if (!depth) return src.slice(i, k + 1) }
  }
  throw new Error('括号不闭合: ' + name)
}

const factory = new Function(
  'readFileSync', 'resolve', '__dirname',
  grab('maskNonCode') + '\n' + grab('checkArkTsDuplicateMembers') +
  '\nreturn { checkArkTsDuplicateMembers }'
)

const realDb = readFileSync(resolve(HARMONY, 'entry/src/main/ets/bridge/DesktopBridge.ets'), 'utf8')
const realIdx = readFileSync(resolve(HARMONY, 'entry/src/main/ets/pages/Index.ets'), 'utf8')

let failures = 0
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + extra : ''))
  if (!ok) failures++
}
const run = (fake) => {
  const { checkArkTsDuplicateMembers } = factory(fake, resolve, '')
  try { checkArkTsDuplicateMembers(); return '' } catch (e) { return e.message }
}
const pick = (idx, db) => (p) => (p.endsWith('Index.ets') ? idx : db)

// 1) 真实文件零重复（含 Index.ets 注入 JS 的误报防线）
{
  const err = run(pick(realIdx, realDb))
  check('真实 Index.ets + DesktopBridge.ets 无重复成员（零误报）', err === '', err)
}

// 2) 同类内重复方法名 → 必须报错（本次真机 10505001 的场景：baseNameOf 在最近打开节
//    与导出节各写了一份）
{
  const doctored = realDb.replace(
    '  async saveInDirJson(dirUri: string, fileName: string, b64: string): Promise<string> {',
    '  private baseNameOf(x: string): string {\n    return x;\n  }\n\n  async saveInDirJson(dirUri: string, fileName: string, b64: string): Promise<string> {'
  )
  if (doctored === realDb) throw new Error('注入失败：锚点未命中')
  const err = run(pick(realIdx, doctored))
  check('同类内重复 baseNameOf 可被捕获', /baseNameOf\(\) 重复声明/.test(err) && /10505001/.test(err), err)
}

// 3) 不同 struct/class 的同名成员合法 → 不得误报
{
  const doctored = realIdx.replace('struct Index {', 'struct Other {\n  build(): void {\n  }\n}\n\nstruct Index {')
  const err = run(pick(doctored, realDb))
  check('不同 struct 的同名成员不误报', err === '', err)
}

console.log(failures === 0 ? '\nGATE SELF-TEST: ALL PASS' : '\nGATE SELF-TEST: ' + failures + ' FAIL')
process.exit(failures === 0 ? 0 : 1)