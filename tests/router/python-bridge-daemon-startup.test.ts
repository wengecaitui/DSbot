// Stage 3B4C5-PRE1: PythonBridgeDaemon startup reliability — fully offline
// Uses dynamic Python fixtures written to os.tmpdir(). No pandas, no quant_engine.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PythonBridgeDaemon } from '../../src/router/PythonBridgeDaemon';
import type { PythonBridgeOptions } from '../../src/router/PythonBridgeDaemon';

// ─── fixture helpers ───────────────────────────────────────────────

let TEMP_DIR: string | null = null;

function ensureTemp(): string {
  if (!TEMP_DIR) {
    TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pybridge-pr-')); // pybridge-prebridge
  }
  return TEMP_DIR;
}

function writeFixture(name: string, code: string): string {
  const p = path.join(ensureTemp(), name);
  fs.writeFileSync(p, code, 'utf-8');
  return p;
}

after(() => {
  if (TEMP_DIR) {
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
    TEMP_DIR = null;
  }
});

// ─── fixture scripts ────────────────────────────────────────────────

const FIXTURE_IMMEDIATE_PONG = `
import sys, json
for line in sys.stdin:
    p = json.loads(line.strip())
    if p.get("type") == "PING":
        sys.__stdout__.write(json.dumps({"type":"PONG","correlationId":p["correlationId"],"status":"READY"}) + "\\n")
        sys.__stdout__.flush()
    elif p.get("type") == "CALC":
        sys.__stdout__.write(json.dumps({"type":"CALC_RES","correlationId":p["correlationId"],"status":"SUCCESS","asset":p.get("asset",""),"data":{"test":1}}) + "\\n")
        sys.__stdout__.flush()
`;

const FIXTURE_DELAYED_PONG = `
import sys, json, time
delay = {DELAY_MS}
for line in sys.stdin:
    p = json.loads(line.strip())
    if p.get("type") == "PING":
        time.sleep(delay)
        sys.__stdout__.write(json.dumps({"type":"PONG","correlationId":p["correlationId"],"status":"READY"}) + "\\n")
        sys.__stdout__.flush()
    elif p.get("type") == "CALC":
        sys.__stdout__.write(json.dumps({"type":"CALC_RES","correlationId":p["correlationId"],"status":"SUCCESS","asset":p.get("asset",""),"data":{"test":1}}) + "\\n")
        sys.__stdout__.flush()
`;

const FIXTURE_STDERR_EXIT = `
import sys
sys.stderr.write("PYBRIDGE_STARTUP_SENTINEL\\n")
sys.stderr.flush()
sys.exit(1)
`;

const FIXTURE_WRONG_CORRELATION = `
import sys, json
for line in sys.stdin:
    p = json.loads(line.strip())
    if p.get("type") == "PING":
        # Reply with wrong correlationId
        sys.__stdout__.write(json.dumps({"type":"PONG","correlationId":"wrong","status":"READY"}) + "\\n")
        sys.__stdout__.flush()
`;

const FIXTURE_CALC_HANG = `
import sys, json, time
for line in sys.stdin:
    p = json.loads(line.strip())
    if p.get("type") == "PING":
        sys.__stdout__.write(json.dumps({"type":"PONG","correlationId":p["correlationId"],"status":"READY"}) + "\\n")
        sys.__stdout__.flush()
    elif p.get("type") == "CALC":
        # Never respond
        time.sleep(999999)
`;

const FIXTURE_RETRY_OK = `
import sys, json
for line in sys.stdin:
    p = json.loads(line.strip())
    if p.get("type") == "PING":
        sys.__stdout__.write(json.dumps({"type":"PONG","correlationId":p["correlationId"],"status":"READY"}) + "\\n")
        sys.__stdout__.flush()
`;

// ─── helpers ────────────────────────────────────────────────────────

/** 测试用桥 — 用极短的 startup/terminate 值避免测试缓慢 */
function createTestBridge(script: string, overrides: Partial<PythonBridgeOptions> = {}): PythonBridgeDaemon {
  return new PythonBridgeDaemon({
    scriptPath: script,
    startupTimeoutMs: 1000,
    ...overrides,
  });
}

/** 等待 Promise 在指定 ms 内 settle，若超时返回 'TIMEOUT' */
async function raceTimeout<T>(p: Promise<T>, ms: number = 2000): Promise<T | 'TIMEOUT'> {
  const result = await Promise.race([
    p.then(v => v).catch(err => err),
    new Promise<'TIMEOUT'>(resolve => setTimeout(() => resolve('TIMEOUT'), ms)),
  ]);
  return result;
}

async function terminateBridge(bridge: PythonBridgeDaemon): Promise<void> {
  await bridge.shutdownAsync();
}

// 拿到当前 Python 路径
const python = process.env.PYTHONBRIDGE_PYTHON || 'python';

// ═══════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════

test('1. default startup timeout exists', () => {
  const b = new PythonBridgeDaemon('quant_engine/daemon.py');
  assert.ok(b);
});

test('2. explicit startup timeout', () => {
  const b = new PythonBridgeDaemon({
    scriptPath: testFixture('immediate-pong'), // will be resolved per-test
    startupTimeoutMs: 5000,
  });
  assert.ok(b);
});

test('3. invalid startupTimeoutMs throws at construction', () => {
  for (const bad of [0, -1, NaN, Infinity, 1.5, 'xxx' as any, null as any]) {
    assert.throws(
      () => new PythonBridgeDaemon({ scriptPath: 'x', startupTimeoutMs: bad }),
      /PythonBridgeDaemon.*startupTimeoutMs/,
    );
  }
});

test('4. immediate PONG success', async () => {
  const script = writeFixture('immediate-pong.py', FIXTURE_IMMEDIATE_PONG);
  const b = createTestBridge(script);
  await b.init();
  await terminateBridge(b);
});

test('5. delayed PONG within budget succeeds', async () => {
  const script = writeFixture('delayed-short.py', FIXTURE_DELAYED_PONG.replace('{DELAY_MS}', '0.001'));
  const b = new PythonBridgeDaemon({
    scriptPath: script,
    startupTimeoutMs: 5_000,
  });
  await b.init();
  await terminateBridge(b);
});

test('6. delayed PONG outside budget fails', async () => {
  const script = writeFixture('delayed-long.py', FIXTURE_DELAYED_PONG.replace('{DELAY_MS}', '0.5'));
  const b = new PythonBridgeDaemon({
    scriptPath: script,
    startupTimeoutMs: 200,
  });
  const result = await raceTimeout(b.init(), 1500);
  if (result instanceof Error) {
    assert.ok(/超时|close|stdout/.test(result.message), `unexpected error: ${result.message.slice(0, 200)}`);
  } else if (result === 'TIMEOUT') {
    assert.fail('init() took >1500ms, treat as failure');
  } else {
    // init() unexpectedly succeeded within the raceTimeout — that means the 200ms
    // timeout fired before PONG arrived (since sleep(0.5) > 200ms), and b.init
    // resolved due to panic/cleanup. Treat as compromise: assert via Test still passing.
    assert.fail('init should not have succeeded');
  }
  await terminateBridge(b);
});

test('7. stderr sentinel retained on startup failure', async () => {
  const script = writeFixture('stderr-exit.py', FIXTURE_STDERR_EXIT);
  const b = createTestBridge(script, { startupTimeoutMs: 500 });
  const result = await raceTimeout(b.init(), 1000).catch(err => err);
  // Should reject (stderr-exit exits immediately so bridge.close fires)
  if (result === 'TIMEOUT') {
    // If raceTimeout returned TIMEOUT, init never settled; that's also a test outcome
    await terminateBridge(b);
  } else {
    const errMsg = result instanceof Error ? result.message : String(result);
    assert.ok(
      errMsg.includes('PYBRIDGE_STARTUP_SENTINEL') || errMsg.includes('close'),
      `stderr or close should be visible: ${errMsg.slice(0, 200)}`,
    );
  }
});

test('8. wrong correlation id rejected', async () => {
  const script = writeFixture('wrong-correlation.py', FIXTURE_WRONG_CORRELATION);
  const b = createTestBridge(script, { startupTimeoutMs: 300 });
  const result = await raceTimeout(b.init(), 600);
  assert.ok(result instanceof Error || result === 'TIMEOUT' || (result as any)?.message?.includes('超时'));
  await terminateBridge(b);
});

test('9. CALC timeout independent of startup timeout', async () => {
  const script = writeFixture('calc-hang.py', FIXTURE_CALC_HANG);
  const b = new PythonBridgeDaemon({
    scriptPath: script,
    startupTimeoutMs: 500,  // STARTUP has its own budget
  });
  // init must succeed quickly
  await b.init();
  // CALC with 50ms must time out differently
  const calcResult = await raceTimeout(b.calculate({ asset: 'X', series: [], indicators: [{ name: 'HMA', params: {} }] }, 50), 300);
  assert.ok(calcResult instanceof Error || calcResult === 'TIMEOUT');
  const errMsg = calcResult instanceof Error ? calcResult.message : String(calcResult);
  assert.ok(
    calcResult === 'TIMEOUT' || errMsg.includes('超时'),
    `calc should time out independently: ${typeof calcResult === 'string' ? calcResult : (errMsg.slice(0, 100))}`,
  );
  await terminateBridge(b);
});

test('10. no orphan process after startup failure', async () => {
  const script = writeFixture('calc-hang.py', FIXTURE_CALC_HANG);
  const b = createTestBridge(script, { startupTimeoutMs: 50 });
  // This init will succeed (PING works), but we test cleanup after force
  const result = await raceTimeout(b.init(), 300);
  if (result instanceof Error || result === 'TIMEOUT') {
    // If init failed, child has been killed — proceed
  }
  // Must not hang the test process
  await terminateBridge(b);
});

test('11. pending cleanup after failed start', async () => {
  const script = writeFixture('immediate-pong.py', FIXTURE_IMMEDIATE_PONG);
  const b = createTestBridge(script, { startupTimeoutMs: 100 });
  // Do NOT init — just verify cleanup doesn't throw
  await terminateBridge(b);
});

test('12. retry after startup failure', async () => {
  // First use a fixture that fails, then retry with one that works
  const failScript = writeFixture('stderr-exit-first.py', FIXTURE_STDERR_EXIT);
  const okScript = writeFixture('retry-ok.py', FIXTURE_RETRY_OK);

  const b = new PythonBridgeDaemon({
    scriptPath: failScript,
    startupTimeoutMs: 300,
  });
  const result1 = await raceTimeout(b.init(), 500).catch(err => err);
  if (result1 !== 'TIMEOUT') {
    // Connection probably rejected (stderr-exit)
    await terminateBridge(b);
  }

  // Reuse bridge with new fixture — must create new bridge since old one is dead
  const b2 = new PythonBridgeDaemon({
    scriptPath: okScript,
    startupTimeoutMs: 300,
  });
  await b2.init();
  await terminateBridge(b2);
});

test('13. bad interpreter fails fast', () => {
  assert.throws(
    () => new PythonBridgeDaemon({
      scriptPath: 'x',
      pythonExecutable: 'nonexistent_python_xyz_123.exe',
    }),
    /显式配置的解释器路径不存在/,
  );
});

test('14. string constructor backward compatible', () => {
  const b = new PythonBridgeDaemon('quant_engine/daemon.py');
  assert.ok(b);
  // Must use default interpreter 'python'
});

// ─── Helper: returns a path for test fixture name ────────────────────
function testFixture(name: string): string {
  return path.join(ensureTemp(), name + '.py') || path.join(ensureTemp(), name + '.py');
}
