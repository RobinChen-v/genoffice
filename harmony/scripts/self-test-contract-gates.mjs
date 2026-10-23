#!/usr/bin/env node
// 契约门禁反例自测（R2-6）：验证 gen-bridge-contract / gen-mock 的 --check 模式
// 能正确捕获三类不一致：
//   1. 篡改 preload 后契约必须变 → --check 报 FAIL
//   2. 契约 JSON 缺方法 → --check 报 FAIL
//   3. mock.js 与契约不一致 → --check 报 FAIL
//
// 同时验证纯函数逻辑：
//   - generateBridgeContract() 对真实 preload 的解析正确性
//   - generateMockJs() 对合成契约的生成正确性
//   - __has / __unsupported 在生成物中的存在性
//
// 范式参照 self-test-bridge-coverage.mjs：合成源码构造正反例，逐点破坏后断言必红。
//
//   node scripts/self-test-contract-gates.mjs
import { mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HARMONY = resolve(HERE, '..');
const ROOT = resolve(HARMONY, '..');

// Windows-safe dynamic import: absolute paths must be file:// URLs
const importAbs = (absPath) => import(pathToFileURL(absPath).href);

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + (extra ? '  → ' + String(extra).split('\n')[0].slice(0, 200) : ''));
  if (!ok) failures++;
};

// ─── 合成契约 JSON ───
function fakeContract({ missingMethod = false, extraMethod = false, wrongKind = false } = {}) {
  const contract = {
    shell: {
      aiOffice: {
        recents: { kind: 'invoke', params: ['query'], channel: 'home:recents' },
        starred: { kind: 'invoke', params: ['query'], channel: 'home:starred' },
        onFolderChanged: { kind: 'event', params: ['handler'], channel: 'home:folder-changed' },
        getLanguage: { kind: 'sync', params: [], channel: null },
        sendAnalytics: { kind: 'send', params: ['event'], channel: 'analytics:event' },
      },
    },
  };

  if (missingMethod) delete contract.shell.aiOffice.recents;
  if (extraMethod) contract.shell.aiOffice.brandNewMethod = { kind: 'invoke', params: [], channel: 'brand:new' };
  if (wrongKind) contract.shell.aiOffice.recents.kind = 'send';

  return contract;
}

// ─── 文件备份/恢复工具 ───
function backupFile(path) {
  return readFileSync(path, 'utf8');
}
function restoreFile(path, content) {
  writeFileSync(path, content);
}

// ─── 运行 CLI ───
function runCli(scriptName, args = [], cwd = HARMONY) {
  const result = spawnSync('node', [join(HERE, scriptName), ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env },
  });
  return { exitCode: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

// ── 1) 对照：真实仓库契约 --check 必须通过（基线绿） ──
{
  const r = runCli('gen-bridge-contract.mjs', ['--check']);
  check('对照：真实仓库 gen-bridge-contract --check 通过', r.exitCode === 0, r.stderr.slice(0, 200));
}

// ── 2) 对照：真实仓库 mock --check 必须通过（基线绿） ──
{
  const r = runCli('gen-mock.mjs', ['--check']);
  check('对照：真实仓库 gen-mock --check 通过', r.exitCode === 0, r.stderr.slice(0, 200));
}

// ── 3) 纯函数：generateBridgeContract 对真实 preload 解析成功 ──
{
  const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
  const contract = generateBridgeContract();
  const apps = Object.keys(contract);
  check('generateBridgeContract 返回 7 个 app', apps.length === 7, JSON.stringify(apps));

  const errorApps = apps.filter(a => contract[a]._error);
  check('所有 app 契约解析无 _error', errorApps.length === 0, JSON.stringify(errorApps));

  check('shell.aiOffice.recents 存在', !!contract.shell?.aiOffice?.recents, JSON.stringify(contract.shell?.aiOffice?.recents));
  check('shell.aiOffice.recents kind=invoke', contract.shell.aiOffice.recents.kind === 'invoke',
    JSON.stringify(contract.shell.aiOffice.recents));
}

// ── 4) 纯函数：generateMockJs 对合成契约生成正确 ──
{
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const mockJs = generateMockJs(fakeContract());

  check('mock.js 包含 __has 方法', mockJs.includes('__has: function'), '');
  check('mock.js 包含 __unsupported 方法', mockJs.includes('__unsupported: function'), '');
  check('mock.js invoke 方法返回 Promise.resolve', mockJs.includes('return Promise.resolve'), '');
  check('mock.js event 方法返回 NOOP', mockJs.includes('return NOOP'), '');
  check('mock.js send 方法返回 undefined', /sendAnalytics.*return undefined/.test(mockJs), '');
  check('mock.js sync boot 方法有有效返回值', /getLanguage.*return 'zh'/.test(mockJs), '');
  check('mock.js BRIDGE_MOCKS 包含 aiOffice', /BRIDGE_MOCKS[\s\S]*"aiOffice"/.test(mockJs), '');
}

// ── 5) 纯函数：generateMockJs 契约缺方法时 mock 也缺 ──
{
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const mockJs = generateMockJs(fakeContract({ missingMethod: true }));

  const recentsLines = mockJs.split('\n').filter(l => /recents/.test(l) && !l.startsWith('//'));
  check('契约缺 recents → mock 也不含 recents 方法', recentsLines.length === 0, JSON.stringify(recentsLines));
}

// ── 6) 纯函数：generateMockJs 契约多方法时 mock 也多 ──
{
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const mockJs = generateMockJs(fakeContract({ extraMethod: true }));

  check('契约多 brandNewMethod → mock 包含该方法', mockJs.includes('brandNewMethod'), '');
}

// ── 7) CLI --check：契约 JSON 缺方法 → 报红 ──
// 策略：备份真实 bridge-contract.json，写入缺方法的版本，运行 --check，恢复
{
  const contractPath = join(HERE, 'bridge-contract.json');
  const original = backupFile(contractPath);

  try {
    // 写入缺 recents 的过期契约
    writeFileSync(contractPath, JSON.stringify(fakeContract({ missingMethod: true }), null, 2));

    const r = runCli('gen-bridge-contract.mjs', ['--check']);
    check('CLI: 过期契约（缺方法）→ --check 报红', r.exitCode === 1, `exit=${r.exitCode}`);
    check('CLI: 报红信息含「不一致」', /不一致/.test(r.stderr), r.stderr.slice(0, 200));
  } finally {
    restoreFile(contractPath, original);
  }
}

// ── 8) CLI --check：新鲜契约 → 通过 ──
{
  const contractPath = join(HERE, 'bridge-contract.json');
  const original = backupFile(contractPath);

  try {
    // 用真实生成器生成正确契约
    const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
    const freshContract = generateBridgeContract();
    writeFileSync(contractPath, JSON.stringify(freshContract, null, 2));

    const r = runCli('gen-bridge-contract.mjs', ['--check']);
    check('CLI: 新鲜契约 → --check 通过', r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`);
  } finally {
    restoreFile(contractPath, original);
  }
}

// ── 9) CLI --check：mock.js 与契约不一致 → 报红 ──
// 策略：备份真实 mock.js，写入过期版本，运行 --check，恢复
{
  const mockPath = join(HARMONY, 'entry/src/main/resources/rawfile/injected/mock.js');
  if (existsSync(mockPath)) {
    const original = backupFile(mockPath);

    try {
      // 写入过期 mock.js
      writeFileSync(mockPath, '// stale mock without methods\nvar NOOP = function() {};\n');

      const r = runCli('gen-mock.mjs', ['--check']);
      check('CLI: 过期 mock.js → --check 报红', r.exitCode === 1, `exit=${r.exitCode}`);
      check('CLI: 报红信息含「不一致」', /不一致/.test(r.stderr), r.stderr.slice(0, 200));
    } finally {
      restoreFile(mockPath, original);
    }
  } else {
    // mock.js 不存在时，先生成再测试
    runCli('gen-mock.mjs'); // 生成 mock.js
    if (existsSync(mockPath)) {
      const original = backupFile(mockPath);
      try {
        writeFileSync(mockPath, '// stale mock\n');
        const r = runCli('gen-mock.mjs', ['--check']);
        check('CLI: 过期 mock.js → --check 报红', r.exitCode === 1, `exit=${r.exitCode}`);
      } finally {
        restoreFile(mockPath, original);
      }
    } else {
      check('CLI: 过期 mock.js → --check 报红', false, 'mock.js 无法生成（rawfile/injected 目录不存在）');
    }
  }
}

// ── 10) CLI --check：新鲜 mock.js → 通过 ──
{
  const mockPath = join(HARMONY, 'entry/src/main/resources/rawfile/injected/mock.js');
  if (existsSync(mockPath)) {
    const original = backupFile(mockPath);

    try {
      // 用真实生成器生成正确 mock.js
      const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
      const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
      const freshContract = generateBridgeContract();
      const freshMock = generateMockJs(freshContract);
      writeFileSync(mockPath, freshMock);

      const r = runCli('gen-mock.mjs', ['--check']);
      check('CLI: 新鲜 mock.js → --check 通过', r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 200)}`);
    } finally {
      restoreFile(mockPath, original);
    }
  } else {
    check('CLI: 新鲜 mock.js → --check 通过', false, 'mock.js 不存在');
  }
}

// ── 11) 端到端：篡改 preload（加方法）→ 契约变 → --check 报红 ──
// 这是 R2-6 的核心验收点：「上游一变，契约/mock 自动重生；门禁立即报出调用面不一致」
{
  const shellPreloadPath = join(ROOT, 'apps/shell/src/preload/index.ts');
  const originalPreload = backupFile(shellPreloadPath);
  const contractPath = join(HERE, 'bridge-contract.json');
  const originalContract = backupFile(contractPath);

  try {
    // 1. 先确保契约是新鲜的
    const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
    const freshContract = generateBridgeContract();
    writeFileSync(contractPath, JSON.stringify(freshContract, null, 2));

    // 2. 验证基线通过
    const r1 = runCli('gen-bridge-contract.mjs', ['--check']);
    check('端到端：基线契约 --check 通过', r1.exitCode === 0, `exit=${r1.exitCode}`);

    // 3. 篡改 preload：在 homeApi 对象开头加一个新方法
    // homeApi 定义格式：const homeApi: HomeApi = {
    //   async recents(query) { ... },
    // 在 `const homeApi` 的 `{` 后插入新方法
    const modifiedPreload = originalPreload.replace(
      /(const homeApi[^{]*\{)/,
      "$1\n  async __testNewMethod(q: string) {\n    return ipcRenderer.invoke('home:test-new', q);\n  },"
    );

    if (modifiedPreload !== originalPreload) {
      writeFileSync(shellPreloadPath, modifiedPreload);

      // 4. --check 应该报红
      const r2 = runCli('gen-bridge-contract.mjs', ['--check']);
      check('端到端：篡改 preload（加方法）→ --check 报红', r2.exitCode === 1, `exit=${r2.exitCode}`);
      check('端到端：报红信息含新增方法或「不一致」', /不一致|__testNewMethod|新增/.test(r2.stderr), r2.stderr.slice(0, 300));

      // 5. 恢复 preload
      restoreFile(shellPreloadPath, originalPreload);

      // 6. 恢复后 --check 应该再次通过
      const r3 = runCli('gen-bridge-contract.mjs', ['--check']);
      check('端到端：恢复 preload 后 --check 再次通过', r3.exitCode === 0, `exit=${r3.exitCode}`);
    } else {
      check('端到端：篡改 preload（加方法）→ --check 报红', false, '正则未匹配到 aiOffice 对象');
    }
  } finally {
    restoreFile(shellPreloadPath, originalPreload);
    restoreFile(contractPath, originalContract);
  }
}

// ── 12) 端到端：篡改 preload（删方法）→ 契约变 → --check 报红 ──
{
  const shellPreloadPath = join(ROOT, 'apps/shell/src/preload/index.ts');
  const originalPreload = backupFile(shellPreloadPath);
  const contractPath = join(HERE, 'bridge-contract.json');
  const originalContract = backupFile(contractPath);

  try {
    // 确保契约新鲜
    const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
    const freshContract = generateBridgeContract();
    writeFileSync(contractPath, JSON.stringify(freshContract, null, 2));

    // 篡改 preload：删除 recents 方法
    // 方法格式：async recents(query: string) { ... }
    const modifiedPreload = originalPreload.replace(
      /\s+async recents\([^)]*\)\s*\{[\s\S]*?\},/,
      ''
    );

    if (modifiedPreload !== originalPreload) {
      writeFileSync(shellPreloadPath, modifiedPreload);

      const r = runCli('gen-bridge-contract.mjs', ['--check']);
      check('端到端：篡改 preload（删方法）→ --check 报红', r.exitCode === 1, `exit=${r.exitCode}`);
      check('端到端：报红信息含移除方法或「不一致」', /不一致|recents|移除/.test(r.stderr), r.stderr.slice(0, 300));

      // 恢复
      restoreFile(shellPreloadPath, originalPreload);
      const r2 = runCli('gen-bridge-contract.mjs', ['--check']);
      check('端到端：恢复 preload 后 --check 再次通过', r2.exitCode === 0, `exit=${r2.exitCode}`);
    } else {
      check('端到端：篡改 preload（删方法）→ --check 报红', false, '正则未匹配到 recents 方法');
    }
  } finally {
    restoreFile(shellPreloadPath, originalPreload);
    restoreFile(contractPath, originalContract);
  }
}

// ── 13) CLI --check：契约 JSON 不存在 → 报红 ──
{
  const contractPath = join(HERE, 'bridge-contract.json');
  const original = backupFile(contractPath);

  try {
    rmSync(contractPath);
    const r = runCli('gen-bridge-contract.mjs', ['--check']);
    check('CLI: 契约 JSON 不存在 → --check 报红', r.exitCode === 1, `exit=${r.exitCode}`);
    check('CLI: 报红信息含「不存在」', /不存在/.test(r.stderr), r.stderr.slice(0, 200));
  } finally {
    restoreFile(contractPath, original);
  }
}

// ── 14) CLI --check：mock.js 不存在 → 报红 ──
{
  const mockPath = join(HARMONY, 'entry/src/main/resources/rawfile/injected/mock.js');
  if (existsSync(mockPath)) {
    const original = backupFile(mockPath);
    try {
      rmSync(mockPath);
      const r = runCli('gen-mock.mjs', ['--check']);
      check('CLI: mock.js 不存在 → --check 报红', r.exitCode === 1, `exit=${r.exitCode}`);
      check('CLI: 报红信息含「不存在」', /不存在/.test(r.stderr), r.stderr.slice(0, 200));
    } finally {
      restoreFile(mockPath, original);
    }
  } else {
    check('CLI: mock.js 不存在 → --check 报红', false, 'mock.js 本来就不存在');
  }
}

// ── 15) 纯函数：generateMockJs 对 _error app 的容错 ──
{
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const contractWithError = {
    shell: { _error: 'preload 不存在' },
    docs: {
      desktop: {
        getLanguage: { kind: 'sync', params: [], channel: null },
      },
    },
  };
  const mockJs = generateMockJs(contractWithError);

  check('_error app 在 mock.js 中被跳过', mockJs.includes('SKIPPED'), '');
  check('正常 app 方法正常生成', mockJs.includes('desktop_mock'), '');
  check('正常 app 的 __has 方法存在', mockJs.includes('__has: function'), '');
}

// ── 16) 纯函数：BOOT_METHODS 的 boot value 是字符串而非函数引用 ──
{
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const contract = {
    shell: {
      aiOffice: {
        recents: { kind: 'invoke', params: ['query'], channel: 'home:recents' },
        getLanguage: { kind: 'sync', params: [], channel: null },
      },
    },
  };
  const mockJs = generateMockJs(contract);

  check('boot value 是有效返回值（不是函数引用）',
    /recents.*Promise\.resolve\(\{ entries: \[\], total: 0, totalAll: 0 \}\)/.test(mockJs), '');
  check('getLanguage boot value 是 zh',
    /getLanguage.*return 'zh'/.test(mockJs), '');
}

// ── 17) 纯函数：契约中 unknown kind 的方法被当作 invoke（最安全默认） ──
{
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const contract = {
    shell: {
      aiOffice: {
        mysteryMethod: { kind: 'unknown', params: [], channel: null },
      },
    },
  };
  const mockJs = generateMockJs(contract);

  check('unknown kind 被当作 invoke（返回 Promise.resolve）',
    /mysteryMethod.*Promise\.resolve/.test(mockJs), '');
}

// ── 18) 真实契约方法总数稳定（585 ± 5） ──
{
  const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
  const contract = generateBridgeContract();

  let totalMethods = 0;
  let totalUnknown = 0;
  for (const [app, bridges] of Object.entries(contract)) {
    if (bridges._error) continue;
    for (const [ns, methods] of Object.entries(bridges)) {
      if (typeof methods !== 'object' || methods._error) continue;
      for (const m of Object.values(methods)) {
        totalMethods++;
        if (m.kind === 'unknown') totalUnknown++;
      }
    }
  }

  check('真实契约方法总数在 610-620 范围', totalMethods >= 610 && totalMethods <= 620,
    `total=${totalMethods}`);
  check('unknown kind 占比 < 1%', totalUnknown < totalMethods * 0.01,
    `unknown=${totalUnknown}/${totalMethods}`);
}

// ── 19) 真实 mock.js 包含所有桥命名空间的 __has/__unsupported ──
{
  const { generateBridgeContract } = await importAbs(join(HERE, 'gen-bridge-contract.mjs'));
  const { generateMockJs } = await importAbs(join(HERE, 'gen-mock.mjs'));
  const contract = generateBridgeContract();
  const mockJs = generateMockJs(contract);

  const hasCount = (mockJs.match(/__has: function/g) || []).length;
  const unsupportedCount = (mockJs.match(/__unsupported: function/g) || []).length;

  let nsCount = 0;
  for (const [app, bridges] of Object.entries(contract)) {
    if (bridges._error) continue;
    for (const [ns, methods] of Object.entries(bridges)) {
      if (typeof methods === 'object' && !methods._error) nsCount++;
    }
  }

  check('每个桥命名空间都有 __has 方法', hasCount === nsCount,
    `__has count=${hasCount}, ns count=${nsCount}`);
  check('每个桥命名空间都有 __unsupported 方法', unsupportedCount === nsCount,
    `__unsupported count=${unsupportedCount}, ns count=${nsCount}`);
}

// ── 20) R2-5: 契约对账纯函数测试 ──
{
  const { parseContractMethods, computeContractGaps, computeUncontractedImpls, NS_IMPL, nativeCovers } =
    await importAbs(join(HERE, 'lib', 'bridge-coverage.mjs'));

  // 合成契约
  const contract = {
    shell: {
      aiOffice: {
        recents: { kind: 'invoke', params: ['query'], channel: 'home:recents' },
        getLanguage: { kind: 'sync', params: [], channel: null },
      },
    },
  };

  const contractMethods = parseContractMethods(contract);
  check('parseContractMethods: aiOffice 有 2 个方法', contractMethods.get('aiOffice')?.size === 2, '');

  // 合成调用面：包含契约中有的方法和契约中没有的方法
  const calls = new Map([
    ['aiOffice', new Map([
      ['recents', [{ site: 'a.ts:1', reach: 'ui', context: '' }]],
      ['brandNewMethod', [{ site: 'a.ts:2', reach: 'ui', context: '' }]],
    ])],
  ]);

  // 契约缺口：brandNewMethod 不在契约中
  const gaps = computeContractGaps({ contract: contractMethods, calls });
  check('computeContractGaps: 检测到契约缺口', gaps.length === 1 && gaps[0].method === 'brandNewMethod', '');

  // 契约缺口排除实现面已有的方法
  const impls = { aiOffice: new Set(['recents', 'brandNewMethod']) };
  const gaps2 = computeContractGaps({ contract: contractMethods, calls, impls });
  check('computeContractGaps: 排除实现面已有的方法', gaps2.length === 0, '');

  // 契约缺口排除 native 已有的方法
  const native = new Set(['brandNewMethod']);
  const gaps3 = computeContractGaps({ contract: contractMethods, calls, native });
  check('computeContractGaps: 排除 native 已有的方法', gaps3.length === 0, '');

  // 超契约实现：mock 中有、契约中没有
  const mockKeys = { aiOffice: new Set(['recents', 'setDirty', '__has', '__unsupported']) };
  const uncontracted = computeUncontractedImpls({ contract: contractMethods, mockKeys });
  // setDirty 不在契约中 → 超契约实现；__has/__unsupported 被排除
  check('computeUncontractedImpls: 检测到超契约实现', uncontracted.length === 1 && uncontracted[0].method === 'setDirty', '');
}

// ── 21) R2-5: 真实仓库契约对账通过 ──
{
  const r = runCli('check-bridge-coverage.mjs');
  check('R2-5: 真实仓库契约对账通过', r.exitCode === 0, `exit=${r.exitCode} stderr=${r.stderr.slice(0, 300)}`);
}

console.log(failures === 0 ? '\nCONTRACT GATES SELF-TEST: ALL PASS' : '\nCONTRACT GATES SELF-TEST: ' + failures + ' FAIL');
process.exit(failures === 0 ? 0 : 1);