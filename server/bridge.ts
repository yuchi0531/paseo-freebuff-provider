import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

export interface RunnerAgent {
  id: string;
  displayName: string;
  model: string;
  systemPrompt: string;
}

export interface RunnerRunRequest {
  apiKey: string;
  cwd: string;
  env: Record<string, string>;
  agent: RunnerAgent;
  agentDefinitions: RunnerAgent[];
  prompt: string;
  content?: Array<{ type: "text"; text: string } | { type: "image"; image: string; mediaType: string }>;
  previousRun?: unknown;
  costMode: string;
  maxAgentSteps: number;
  knowledgeFiles?: Record<string, string>;
}

export type RunnerProjectedEvent =
  | { kind: "text"; text: string }
  | { kind: "reasoning"; text: string }
  | { kind: "tool_call"; toolCallId: string; toolName: string; input: unknown }
  | { kind: "tool_result"; toolCallId: string; toolName: string; output: unknown }
  | { kind: "subagent_start"; agentId: string; agentType: string; displayName: string }
  | { kind: "subagent_finish"; agentId: string; agentType: string; displayName: string }
  | { kind: "error"; message: string };

export interface RunnerCallbacks {
  onEvent(event: RunnerProjectedEvent): void;
  onDone(runState: unknown, output: unknown): void;
  onFailed(error: string, aborted: boolean): void;
}

interface PendingRun {
  callbacks: RunnerCallbacks;
  settled: boolean;
}

/**
 * Manages the freebuff SDK runner subprocess. The runner executes outside
 * Paseo's eval bundle as a plain Node process, so the SDK's Node-only
 * initialization works unchanged.
 */
export class FreebuffRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private pending = new Map<string, PendingRun>();
  private buffer = "";
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(
    private readonly runnerPath: string,
    private readonly nodePath: string = process.execPath,
  ) {}

  start(): void {
    this.stopped = false;
    this.spawn();
  }

  stop(): void {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.failAll("Runner stopped");
    this.child?.kill();
    this.child = null;
    this.ready = false;
  }

  private spawn(): void {
    if (this.stopped) return;
    const child = spawn(this.nodePath, [this.runnerPath], {
      stdio: ["pipe", "pipe", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams;
    this.child = child;
    this.ready = false;
    child.stderr.on("data", (chunk: Buffer) => {
      console.error(`[freebuff-runner] ${chunk.toString().trimEnd()}`);
    });
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.onLine(line));
    child.on("exit", (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.ready = false;
      this.failAll(`Runner exited (code=${code}, signal=${signal})`);
      if (!this.stopped) {
        this.restartTimer = setTimeout(() => this.spawn(), 1000);
      }
    });
    child.on("error", (error) => {
      console.error(`[freebuff-runner] spawn error: ${error.message}`);
    });
  }

  private failAll(reason: string): void {
    for (const [, run] of this.pending) {
      if (!run.settled) {
        run.settled = true;
        run.callbacks.onFailed(reason, false);
      }
    }
    this.pending.clear();
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let msg: {
      id?: string;
      type: string;
      event?: RunnerProjectedEvent;
      runState?: unknown;
      output?: unknown;
      error?: string;
      aborted?: boolean;
    };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "ready") {
      this.ready = true;
      for (const waiter of this.readyWaiters.splice(0)) waiter();
      return;
    }
    if (!msg.id) return;
    const run = this.pending.get(msg.id);
    if (!run || run.settled) return;
    if (msg.type === "event" && msg.event) {
      run.callbacks.onEvent(msg.event);
    } else if (msg.type === "done") {
      run.settled = true;
      this.pending.delete(msg.id);
      run.callbacks.onDone(msg.runState, msg.output);
    } else if (msg.type === "failed") {
      run.settled = true;
      this.pending.delete(msg.id);
      run.callbacks.onFailed(msg.error ?? "Runner run failed", msg.aborted === true);
    }
  }

  private async waitReady(): Promise<void> {
    if (this.ready && this.child) return;
    if (!this.child) this.spawn();
    await new Promise<void>((resolve) => this.readyWaiters.push(resolve));
  }

  async run(request: RunnerRunRequest, callbacks: RunnerCallbacks): Promise<string> {
    await this.waitReady();
    const child = this.child;
    if (!child) throw new Error("Runner is not available");
    const id = randomUUID();
    this.pending.set(id, { callbacks, settled: false });
    child.stdin.write(`${JSON.stringify({ id, type: "run", run: request })}\n`);
    return id;
  }

  abort(id: string): void {
    const run = this.pending.get(id);
    if (!run || run.settled) return;
    run.settled = true;
    this.pending.delete(id);
    run.callbacks.onFailed("Interrupted by user", true);
    this.child?.stdin.write(`${JSON.stringify({ id, type: "abort", runId: id })}\n`);
  }

  get isReady(): boolean {
    return this.ready;
  }

  /** Expose buffered stderr lines for diagnostics (unused, keeps shape). */
  get buffered(): string {
    return this.buffer;
  }
}
