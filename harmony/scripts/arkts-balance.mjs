import { readFileSync } from 'node:fs';

function check(file) {
  const s = readFileSync(file, 'utf8');
  let i = 0;
  const n = s.length;
  const stack = [];
  let line = 1;
  const push = (c) => stack.push({ c, line });
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const closer = new Set(Object.values(pairs));
  while (i < n) {
    const c = s[i];
    const c2 = s.slice(i, i + 2);
    if (c === '\n') { line++; i++; continue; }
    if (c2 === '//') { while (i < n && s[i] !== '\n') i++; continue; }
    if (c2 === '/*') { i += 2; while (i < n && s.slice(i, i + 2) !== '*/') { if (s[i] === '\n') line++; i++; } i += 2; continue; }
    if (c === "'" || c === '"') {
      const q = c; i++;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '\n') line++;
        if (s[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '`') {
      i++;
      while (i < n) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '\n') line++;
        if (s[i] === '`') { i++; break; }
        i++;
      }
      continue;
    }
    if (pairs[c]) { push(c); i++; continue; }
    if (closer.has(c)) {
      const top = stack.pop();
      if (!top || pairs[top.c] !== c) {
        console.log(`${file}: FAIL unmatched ${c} at line ${line} (top=${top ? top.c + '@' + top.line : 'empty'})`);
        return;
      }
      i++;
      continue;
    }
    i++;
  }
  if (stack.length) {
    const t = stack[stack.length - 1];
    console.log(`${file}: FAIL unclosed ${t.c} from line ${t.line}`);
  } else {
    console.log(`${file}: OK`);
  }
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  targets.push('entry/src/main/ets/pages/Index.ets', 'entry/src/main/ets/bridge/DesktopBridge.ets');
}
for (const t of targets) check(t);
