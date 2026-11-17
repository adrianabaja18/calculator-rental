import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Starts and talks to the Python hardware bridge (hw-bridge/hw_bridge.py)
 * over JSON lines. Requests get an id and a timeout, so a stuck bridge can
 * never freeze the kiosk; if the bridge crashes it is restarted.
 */

export const BRIDGE_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../hw-bridge/hw_bridge.py');

type BridgeEvent =
  | { type: 'ready'; mode: 'real' | 'mock'; version: string; devices: Record<string, unknown> }
  | { type: 'coin'; pulses: number }
  | { type: 'log'; level: 'warn' | 'info' | 'error'; message: string };

type Reply = { type: string; id?: number | null; message?: string; [key: string]: unknown };

export interface BridgeClientOptions {
  pythonBin: string;
  args: string[];
  timeoutMs?: number;
  restartDelayMs?: number;
  log?: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void;
}

export class BridgeClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly coinHandlers: Array<(pulses: number) => void> = [];
  private stopped = false;
  private readyResolve: ((event: Extract<BridgeEvent, { type: 'ready' }>) => void) | null = null;
  ready: Promise<Extract<BridgeEvent, { type: 'ready' }>>;

  constructor(private readonly options: BridgeClientOptions) {
    this.ready = new Promise((resolve) => (this.readyResolve = resolve));
  }

  onCoin(handler: (pulses: number) => void) {
    this.coinHandlers.push(handler);
  }

  start() {
    this.stopped = false;
    const log = this.options.log ?? (() => {});
    const child = spawn(this.options.pythonBin, ['-u', BRIDGE_SCRIPT, ...this.options.args], { stdio: 'pipe' });
    this.child = child;

    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => log('warn', `hw-bridge: ${line}`));
    child.on('error', (error) => log('error', 'Could not start the hardware bridge', { error: error.message, python: this.options.pythonBin }));
    child.on('exit', (code) => {
      this.child = null;
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error('hardware bridge exited'));
      }
      this.pending.clear();
      if (this.stopped) return;
      log('error', 'Hardware bridge exited; restarting', { code });
      setTimeout(() => this.start(), this.options.restartDelayMs ?? 2000);
    });
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
  }

  /** Sends a command and waits for its reply (or rejects after the timeout). */
  request(cmd: string, params: Record<string, unknown> = {}): Promise<Reply> {
    const child = this.child;
    if (!child) return Promise.reject(new Error('hardware bridge is not running'));
    const id = this.nextId++;
    return new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hardware bridge did not answer "${cmd}"`));
      }, this.options.timeoutMs ?? 2000);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, cmd, ...params })}\n`);
    }).then((reply) => {
      if (reply.type === 'error') throw new Error(`hardware bridge: ${reply.message ?? 'error'}`);
      return reply;
    });
  }

  private onLine(line: string) {
    let msg: Reply;
    try {
      msg = JSON.parse(line) as Reply;
    } catch {
      return;
    }
    if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg);
      return;
    }
    const event = msg as unknown as BridgeEvent;
    if (event.type === 'coin' && Number.isInteger(event.pulses)) for (const h of this.coinHandlers) h(event.pulses);
    else if (event.type === 'ready') this.readyResolve?.(event);
    else if (event.type === 'log') this.options.log?.(event.level === 'error' ? 'error' : 'warn', `hw-bridge: ${event.message}`);
  }
}
