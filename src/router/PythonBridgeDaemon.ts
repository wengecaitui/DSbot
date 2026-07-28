/**
 * PythonBridgeDaemon.ts
 * Phase 4.2: TS ↔ Python 跨语言管道桥接器
 *
 * 协议: JSON Lines over stdin/stdout
 * - TS → Python: spawn + stdin.write(JSON + '\n')
 * - Python → TS: readline → handleIncomingMessage
 * - 超时: 默认 2s，Fast Pipeline 守门
 *
 * Sprint 2C: 超时后分级终止 Python 进程
 *   SIGTERM → 5s 等待退出 → SIGKILL → 清理引用 → 下次请求重生
 *
 * Stage 1C: 解释器选择 + stderr 尾部捕获 + Quant Engine 环境净化
 *   - 显式配置 fail-fast，不静默 fallback
 *   - quant_engine 子进程清除继承的 PYTHONPATH/PYTHONHOME/VIRTUAL_ENV
 *   - 16KB stderr ring buffer，进程故障时附加在 reject message
 *
 * Stage 3B4C5-PRE1:
 *   - startupTimeoutMs 与 CALC timeout 严格分离
 *   - init() 启动顺序确定化
 *   - stderr 在进程绑定后、PING 前不清空
 *   - 超时后完整进程清理
 */

import { spawn, ChildProcess } from 'child_process';
import * as path from 'path';
import * as readline from 'readline';
import type { Series } from '../data/types';

interface CalcRequest {
    asset: string;
    series: Series[];
    indicators: Array<{ name: string; params: Record<string, any> }>;
}

interface PendingRequest {
    resolve: (val: any) => void;
    reject: (err: any) => void;
    timer: ReturnType<typeof setTimeout>;
}

/**
 * 构造参数：string 兼容旧调用，object 用于显式 pythonExecutable / env / role / startupTimeout。
 */
export type PythonBridgeOptions = string | {
    scriptPath: string;
    pythonExecutable?: string;
    /** 该 daemon 的角色，决定是否净化继承环境。默认按 scriptPath 推断。 */
    role?: 'quant-engine' | 'tradingagents' | 'generic';
    /** 额外显式注入的子进程环境变量（在净化之后合并，可覆盖）。 */
    env?: Record<string, string>;
    /**
     * 仅用于 Python 进程冷启动和 PING/PONG 握手。
     * 不影响 CALC 请求 SLA。默认 10_000ms。
     * 必须为正整数，否则同步抛错。
     */
    startupTimeoutMs?: number;
};

const ENV_VARS = [
    'QUANT_ENGINE_PYTHON',
    'TRADINGAGENTS_PYTHON',
    'PYTHONBRIDGE_PYTHON',
] as const;

/** 启动超时默认值：10 秒（覆盖冷启动 import 最慢情况） */
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;

/** 内部用于测试的终止优雅等待期（单元测试通过私有常量注入缩短） */
const PROCESS_TERMINATE_GRACE_MS = 5000;

/**
 * 解析 Python 解释器路径，按以下优先级：
 *   1. 显式 pythonExecutable（构造参数）
 *   2. 与 role 对应的环境变量（QUANT_ENGINE_PYTHON / TRADINGAGENTS_PYTHON）
 *   3. PYTHONBRIDGE_PYTHON
 *   4. 'python'
 *
 * 显式值必须真实可执行，否则抛出明确错误，不静默 fallback。
 */
function resolvePythonInterpreter(opts: {
    pythonExecutable?: string;
    role?: 'quant-engine' | 'tradingagents' | 'generic';
}): string {
    const candidates: Array<{ value: string | undefined; source: string; explicit: boolean }> = [
        { value: opts.pythonExecutable, source: 'pythonExecutable (constructor)', explicit: true },
        {
            value: opts.role === 'quant-engine' ? process.env.QUANT_ENGINE_PYTHON
                : opts.role === 'tradingagents' ? process.env.TRADINGAGENTS_PYTHON
                    : undefined,
            source: 'role-specific env (QUANT_ENGINE_PYTHON / TRADINGAGENTS_PYTHON)',
            explicit: true,
        },
        { value: process.env.PYTHONBRIDGE_PYTHON, source: 'PYTHONBRIDGE_PYTHON', explicit: true },
        { value: 'python', source: 'default fallback', explicit: false },
    ];

    for (const c of candidates) {
        if (!c.value) continue;
        if (!c.explicit) {
            // 'python' 最后兜底，仅作为隐式默认，不再做存在性校验
            return c.value;
        }
        // 显式配置：必须可解析
        const fs = require('fs');
        if (!fs.existsSync(c.value)) {
            throw new Error(
                `PythonBridgeDaemon: 显式配置的解释器路径不存在 - source=${c.source} path=${c.value}`
            );
        }
        return c.value;
    }
    return 'python';
}

/**
 * 根据脚本路径推断角色。
 * quant_engine/daemon.py → 'quant-engine'
 * tradingagents_adapter.py → 'tradingagents'
 * 其它 → 'generic'
 */
function inferRole(scriptPath: string): 'quant-engine' | 'tradingagents' | 'generic' {
    const normalized = scriptPath.replace(/\\/g, '/');
    if (normalized.includes('quant_engine/daemon.py')) return 'quant-engine';
    if (normalized.includes('tradingagents_adapter.py')) return 'tradingagents';
    return 'generic';
}

/**
 * 为子进程构造环境变量。
 * - quant-engine: 删除继承的 PYTHONPATH/PYTHONHOME/VIRTUAL_ENV，避免 Hermes venv 泄漏
 * - tradingagents / generic: 保留继承环境
 * - 显式传入的 options.env 在净化之后合并，可覆盖
 * - 最后强制 PYTHONUNBUFFERED=1
 */
function buildChildEnv(
    role: 'quant-engine' | 'tradingagents' | 'generic',
    extraEnv?: Record<string, string>
): NodeJS.ProcessEnv {
    const childEnv: NodeJS.ProcessEnv = { ...process.env };

    if (role === 'quant-engine') {
        delete childEnv.PYTHONPATH;
        delete childEnv.PYTHONHOME;
        delete childEnv.VIRTUAL_ENV;
    }

    if (extraEnv) {
        for (const [k, v] of Object.entries(extraEnv)) {
            childEnv[k] = v;
        }
    }

    childEnv.PYTHONUNBUFFERED = '1';
    return childEnv;
}

/**
 * 分级终止 Python 子进程：SIGTERM → grace → SIGKILL。
 * 验证退出后才 resolve，不依赖 child_process.killed 属性。
 *
 * @param graceMs SIGTERM → SIGKILL 等待毫秒（默认 5000，测试可注入缩短）。
 */
function processTerminate(proc: ChildProcess | null, graceMs: number = PROCESS_TERMINATE_GRACE_MS): Promise<void> {
    return new Promise((resolve) => {
        if (!proc || proc.killed) {
            resolve();
            return;
        }

        // 监听一次退出事件
        let settled = false;
        const onExit = () => {
            if (settled) return;
            settled = true;
            resolve();
        };
        proc.once('exit', onExit);
        proc.once('close', onExit);

        // SIGTERM（优雅退出）
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }

        // grace 后如果还没退出 → SIGKILL
        setTimeout(() => {
            if (settled) return;
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            // 再等 grace 让 SIGKILL 生效
            setTimeout(() => {
                if (settled) return;
                settled = true;
                resolve();
            }, graceMs);
        }, graceMs);
    });
}

/**
 * 16KB stderr ring buffer，超出后丢弃最旧字节。
 * 进程故障时通过 getTail() 输出最后 16KB，避免无限缓存与敏感数据泄漏。
 */
const STDERR_TAIL_MAX_BYTES = 16 * 1024;
class StderrTail {
    private buf: Buffer = Buffer.alloc(0);

    push(chunk: Buffer): void {
        const combined = Buffer.concat([this.buf, chunk]);
        if (combined.length > STDERR_TAIL_MAX_BYTES) {
            this.buf = combined.subarray(combined.length - STDERR_TAIL_MAX_BYTES);
        } else {
            this.buf = combined;
        }
    }

    getTail(): string {
        return this.buf.toString('utf8');
    }

    clear(): void {
        this.buf = Buffer.alloc(0);
    }
}

export class PythonBridgeDaemon {
    private pythonProcess: ChildProcess | null = null;
    private rl: readline.Interface | null = null;
    private scriptPath: string;
    private pythonExecutable: string;
    private role: 'quant-engine' | 'tradingagents' | 'generic';
    private extraEnv: Record<string, string> | undefined;
    /** Stage 3B4C5-PRE1: startup timeout for cold-start PING/PONG. */
    private readonly startupTimeoutMs: number;
    /** 测试可替换的 terminate grace-period，不扩大公共 API。 */
    private terminateGraceMs: number = PROCESS_TERMINATE_GRACE_MS;
    private stderrTail = new StderrTail();

    // correlationId → Promise 寄存器
    private pendingRequests = new Map<string, PendingRequest>();

    constructor(scriptPathOrOptions: PythonBridgeOptions = 'quant_engine/daemon.py') {
        if (typeof scriptPathOrOptions === 'string') {
            this.scriptPath = scriptPathOrOptions;
            this.role = inferRole(scriptPathOrOptions);
            this.extraEnv = undefined;
            this.startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
        } else {
            this.scriptPath = scriptPathOrOptions.scriptPath;
            this.role = scriptPathOrOptions.role ?? inferRole(this.scriptPath);
            this.extraEnv = scriptPathOrOptions.env;
            // Validate startupTimeoutMs
            if (scriptPathOrOptions.startupTimeoutMs !== undefined) {
                const v = scriptPathOrOptions.startupTimeoutMs;
                if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || Math.floor(v) !== v) {
                    throw new Error(
                        `PythonBridgeDaemon: startupTimeoutMs must be a positive integer, got ${JSON.stringify(v)}`
                    );
                }
                this.startupTimeoutMs = v;
            } else {
                this.startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS;
            }
        }
        this.pythonExecutable = resolvePythonInterpreter({
            pythonExecutable: typeof scriptPathOrOptions === 'object' ? scriptPathOrOptions.pythonExecutable : undefined,
            role: this.role,
        });
    }

    /**
     * 启动 Python 守护进程并绑定管道
     * 握手验证 PING/PONG 通过后才 resolve
     */
    public async init(): Promise<void> {
        // Stage 3B4C5-PRE1: 清理上一轮 stderr tail
        this.stderrTail.clear();

        const childEnv = buildChildEnv(this.role, this.extraEnv);

        return new Promise((resolve, reject) => {
            try {
                this.pythonProcess = spawn(
                    this.pythonExecutable,
                    ['-u', this.scriptPath],
                    { env: childEnv }
                );
            } catch (err) {
                reject(new Error(`Python 守护进程 spawn 失败 [${this.pythonExecutable} -u ${this.scriptPath}]: ${err}`));
                return;
            }

            if (!this.pythonProcess.stdin || !this.pythonProcess.stdout || !this.pythonProcess.stderr) {
                this.cleanupProcess();
                return reject(new Error('无法开辟 Python stdio 管道通道'));
            }

            this.rl = readline.createInterface({
                input: this.pythonProcess.stdout,
                terminal: false
            });

            this.rl.on('line', (line: string) => this.handleIncomingMessage(line));

            // Stage 3B4C5-PRE1: stderr 捕获在 spawn 后立即绑定，不预清空
            this.pythonProcess.stderr.on('data', (chunk: Buffer) => {
                this.stderrTail.push(chunk);
            });

            // 进程故障 → 熔断
            this.pythonProcess.on('error', (err: Error) => {
                this.panicMeltdown(`Python 守护进程物理异常: ${err}\n--- stderr tail ---\n${this.stderrTail.getTail()}`);
            });

            this.pythonProcess.on('close', (code: number | null) => {
                this.panicMeltdown(`Python 守护进程 close (code=${code})\n--- stderr tail ---\n${this.stderrTail.getTail()}`);
            });

            // Stage 3B4C5-PRE1: 用 startupTimeoutMs 发起 PING
            this.ping()
                .then(() => resolve())
                .catch((err) => {
                    // 启动超时/失败时确保进程清理
                    this.cleanupProcess();
                    reject(err);
                });
        });
    }

    /**
     * 处理 Python 侧回吐的数据行
     */
    private handleIncomingMessage(line: string): void {
        try {
            const payload = JSON.parse(line);
            const cid: string | undefined = payload.correlationId;
            if (!cid) return;

            const pending = this.pendingRequests.get(cid);
            if (!pending) return;

            clearTimeout(pending.timer);
            this.pendingRequests.delete(cid);

            if (payload.type === 'ERROR' || payload.status === 'FAILED') {
                pending.reject(new Error(
                    `Python 计算层报错 [${payload.correlationId}]: ${payload.error}\n${payload.traceback || ''}\n--- stderr tail ---\n${this.stderrTail.getTail()}`
                ));
            } else {
                pending.resolve(payload);
            }
        } catch (e) {
            console.error('解析管道 JSON 行失败:', e, 'raw:', line.slice(0, 100));
        }
    }

    /**
     * 发送 PING 握手请求（使用 startupTimeoutMs 作为 timeout）。
     */
    private async ping(): Promise<void> {
        return this.sendPayload('PING', {}, this.startupTimeoutMs);
    }

    /**
     * 向 Python 发送计算请求（快路径核心调用）
     * @param timeoutMs 超时毫秒，默认 2000ms（2s 硬熔断）— 与 startup 严格独立
     */
    public async calculate(req: CalcRequest, timeoutMs: number = 2000): Promise<any> {
        return this.sendPayload('CALC', req, timeoutMs);
    }

    /**
     * 通用 payload 发送器（带 correlationId 和超时控制）
     * 超时后：reject → SIGTERM → grace → SIGKILL → panicMeltdown
     */
    private sendPayload(type: string, body: Record<string, any>, timeoutMs: number): Promise<any> {
        if (!this.pythonProcess || !this.pythonProcess.stdin) {
            return Promise.reject(new Error('Python 进程未就绪，拒绝派发计算任务'));
        }

        const cid = Math.random().toString(36).substring(2, 15);
        const payload = { type, correlationId: cid, ...body };

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(cid);
                reject(new Error(`管道通信超时 [${type}] - correlationId=${cid}，超过 ${timeoutMs}ms 未响应\n--- stderr tail ---\n${this.stderrTail.getTail()}`));

                // ── 分级终止：SIGTERM → grace → SIGKILL ───────────────────
                const proc = this.pythonProcess;
                processTerminate(proc, this.terminateGraceMs).then(() => {
                    this.panicMeltdown(`管道通信超时 [${type}] correlationId=${cid}`);
                }).catch(() => {});
            }, timeoutMs);

            this.pendingRequests.set(cid, { resolve, reject, timer });

            try {
                this.pythonProcess!.stdin!.write(JSON.stringify(payload) + '\n');
            } catch (err) {
                clearTimeout(timer);
                this.pendingRequests.delete(cid);
                reject(new Error(`写入管道失败: ${err}\n--- stderr tail ---\n${this.stderrTail.getTail()}`));
            }
        });
    }

    /**
     * Stage 3B4C5-PRE1: 清理进程和管道引用，不触发热熔断事件。
     * 用于启动失败后的干净重置。
     */
    private cleanupProcess(): void {
        this.rl?.close();
        this.rl = null;
        if (this.pythonProcess) {
            const proc = this.pythonProcess;
            // 终止但不等待（fire and forget）
            try { proc.kill('SIGKILL'); } catch { /* ignore */ }
            this.pythonProcess = null;
        }
        // 未完成的请求全部拒绝
        this.pendingRequests.forEach((pending) => {
            clearTimeout(pending.timer);
            pending.reject(new Error('PythonBridgeDaemon init 未完成'));
        });
        this.pendingRequests.clear();
    }

    /**
     * 紧急故障熔断
     * 清理所有悬挂请求，清除进程引用
     * （留 bridgeInitPromise 给 ensureAdapter 重生判定）
     */
    private panicMeltdown(reason?: string): void {
        this.rl?.close();

        // 标记所有悬挂请求为失败
        this.pendingRequests.forEach((pending) => {
            clearTimeout(pending.timer);
            pending.reject(new Error(`Python 计算层进程意外死亡: ${reason ?? ''}`));
        });
        this.pendingRequests.clear();

        // 清除进程引用 — next ensureAdapter 检测 bridge === null 后重生
        this.pythonProcess = null;
        this.rl = null;
    }

    /**
     * 优雅关闭
     */
    public shutdown(): void {
        const proc = this.pythonProcess;
        this.panicMeltdown();
        if (proc) {
            try {
                proc.kill('SIGTERM');
            } catch {
                // 忽略
            }
        }
    }

    /**
     * 异步优雅关闭 — 分级终止并等待子进程完全退出。
     * 测试和关键路径使用，避免进程泄漏。
     */
    public async shutdownAsync(): Promise<void> {
        const proc = this.pythonProcess;
        this.panicMeltdown();
        if (proc) {
            await processTerminate(proc, this.terminateGraceMs);
        }
    }

    // ─── 测试辅助（不开新公共 API） ─────────────────────────────
    /* internal for testing */ __setTerminateGraceMs(ms: number): void {
        this.terminateGraceMs = ms;
    }
}
