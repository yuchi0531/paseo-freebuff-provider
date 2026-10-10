import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { PrintModeEvent } from "@codebuff/sdk";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCatalog,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
} from "@getpaseo/plugin/server/provider";
import { getFreebuffModel, FREEBUFF_MODELS } from "../shared/models";
import { resolveFreebuffApiKey } from "./auth";
import { buildAllAgentDefinitions, buildFreebuffAgentDefinition } from "./agents";
import { extractOutputText, mapSdkEvent, type TimelineAccumulator } from "./events";
import {
  FreebuffRunner,
  type RunnerProjectedEvent,
  type RunnerRunRequest,
} from "./bridge";
import { findPluginDir } from "./debug";

const CAPABILITIES = [
  "prompt.message",
  "prompt.image",
  "prompt.command",
  "session.configure",
  "session.list",
  "session.persistence",
] as const;

export const PLUGIN_ID = "freebuff";

interface FreebuffSession {
  config: ProviderSessionConfig;
  modelId: string;
  persistence: ProviderPersistence;
  runState: unknown | null;
  history: ProviderTimelineItem[];
  activeTurnId: string | null;
  runnerRunId: string | null;
  turn: number;
}

function catalogPayload(defaultModel?: string): ProviderCatalog {
  const models = FREEBUFF_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    isDefault: m.id === (defaultModel ?? "mimo-2-6-flash"),
    contextWindowMaxTokens: m.contextWindow,
  }));
  return {
    models,
    modes: [{ id: "build", label: "Build", description: "Build and edit code" }],
    thinkingOptions: [],
    defaultModel: defaultModel ?? "mimo-2-6-flash",
    defaultMode: "build",
  };
}

function configState(session: FreebuffSession): ProviderConfigState {
  const models = FREEBUFF_MODELS.map((m) => ({
    id: m.id,
    label: m.label,
    description: m.description,
    contextWindowMaxTokens: m.contextWindow,
  }));
  return {
    model: session.modelId,
    mode: session.config.mode ?? "build",
    thinkingOption: undefined,
    models,
    modes: [{ id: "build", label: "Build", description: "Build and edit code" }],
    thinkingOptions: [],
    settings: [],
  };
}

export interface FreebuffSettings {
  apiKey: string;
  defaultModel: string;
  maxAgentSteps: number;
}

export interface FreebuffProviderOptions {
  getSettings: () => Promise<FreebuffSettings>;
  getRunner: () => Promise<FreebuffRunner | null>;
}

/** Convert a runner-projected event back into SDK shape for timeline mapping. */
function toPrintModeEvent(event: RunnerProjectedEvent): PrintModeEvent | null {
  switch (event.kind) {
    case "text":
      return { type: "text", text: event.text };
    case "reasoning":
      return { type: "reasoning_delta", text: event.text, ancestorRunIds: [], runId: "" };
    case "tool_call":
      return {
        type: "tool_call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: (event.input ?? {}) as Record<string, unknown>,
      };
    case "tool_result":
      return {
        type: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: (event.output ?? []) as Array<{ type: "json"; value: unknown }>,
      };
    case "subagent_start":
      return {
        type: "subagent_start",
        agentId: event.agentId,
        agentType: event.agentType,
        displayName: event.displayName,
        onlyChild: false,
      };
    case "subagent_finish":
      return {
        type: "subagent_finish",
        agentId: event.agentId,
        agentType: event.agentType,
        displayName: event.displayName,
        onlyChild: false,
      };
    case "error":
      return { type: "error", message: event.message };
    default:
      return null;
  }
}

export function resolveRunnerPath(): { path: string | null; diagnostic: string | null } {
  const pluginDir = findPluginDir();
  if (!pluginDir) {
    return {
      path: null,
      diagnostic:
        "Cannot locate the freebuff plugin directory. Reinstall the plugin from its source directory.",
    };
  }
  const runnerPath = join(pluginDir, "server", "runner.cjs");
  if (!existsSync(runnerPath)) {
    return {
      path: null,
      diagnostic: `Runner script not found at ${runnerPath}. Reinstall the plugin.`,
    };
  }
  return { path: runnerPath, diagnostic: null };
}

export function createFreebuffProvider(
  options: FreebuffProviderOptions,
): ProviderRegistration {
  return {
    id: "freebuff",
    label: "Freebuff",
    description: "Free AI coding agent with leading models",
    icon: "icon.svg",
    async status() {
      // Availability reflects the runner, not credentials: authentication is
      // resolved per session at prompt time so the catalog stays browsable
      // and the error surfaces where the user can act on it.
      const runner = resolveRunnerPath();
      if (!runner.path) {
        return { available: false, diagnostic: runner.diagnostic ?? "Runner unavailable." };
      }
      const settings = await options.getSettings();
      const { apiKey, diagnostic } = resolveFreebuffApiKey({}, settings.apiKey);
      if (!apiKey) {
        return { available: true, diagnostic: diagnostic ?? undefined };
      }
      return { available: true };
    },
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Provider protocol version 1 is required");
      }
      return createConnection(
        negotiateProviderCapabilities(request.capabilities, CAPABILITIES),
        options,
      );
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  options: FreebuffProviderOptions,
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, FreebuffSession>();
  let closed = false;

  const emit = (event: ProviderEvent) => {
    if (closed) return;
    for (const listener of listeners) listener(event);
  };

  return {
    version: 1,
    capabilities,
    async send(input: ProviderInput) {
      if (closed) throw new Error("Provider connection is closed");
      requireProviderCapabilities(capabilities, input);
      if (input.type === "session.open" && sessions.has(input.sessionId)) {
        throw new Error(`Session already exists: ${input.sessionId}`);
      }
      if ("sessionId" in input && input.type !== "session.open") {
        if (!sessions.has(input.sessionId)) {
          throw new Error(`Unknown session: ${input.sessionId}`);
        }
      }
      queueMicrotask(() => {
        if (!closed) {
          void dispatch(input, { sessions, emit, options }).catch((error) => {
            if ("sessionId" in input) {
              emit({
                type: "session.runtime_failed",
                sessionId: input.sessionId,
                error: { message: error instanceof Error ? error.message : String(error) },
              });
            } else if ("requestId" in input) {
              emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: error instanceof Error ? error.message : String(error) },
              });
            }
          });
        }
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      const runner = await options.getRunner().catch(() => null);
      for (const session of sessions.values()) {
        if (session.runnerRunId) runner?.abort(session.runnerRunId);
      }
      sessions.clear();
      listeners.clear();
    },
  };
}

interface DispatchState {
  sessions: Map<string, FreebuffSession>;
  emit(event: ProviderEvent): void;
  options: FreebuffProviderOptions;
}

async function dispatch(input: ProviderInput, state: DispatchState): Promise<void> {
  switch (input.type) {
    case "catalog": {
      const settings = await state.options.getSettings();
      state.emit({ type: "catalog", requestId: input.requestId, catalog: catalogPayload(settings.defaultModel) });
      return;
    }
    case "sessions": {
      state.emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: [...state.sessions.values()].map((s) => ({
          persistence: s.persistence,
          cwd: s.config.cwd,
          title: s.config.title,
        })),
      });
      return;
    }
    case "session.open": {
      await openSession(input, state);
      return;
    }
    case "session.prompt": {
      await promptSession(input, state);
      return;
    }
    case "session.interrupt": {
      const session = state.sessions.get(input.sessionId);
      if (session?.runnerRunId) {
        const runner = await state.options.getRunner().catch(() => null);
        runner?.abort(session.runnerRunId);
        session.runnerRunId = null;
      }
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.configure": {
      const session = state.sessions.get(input.sessionId);
      if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
      if (input.changes.model) {
        session.modelId = getFreebuffModel(input.changes.model).id;
        session.runState = null;
      }
      state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.close": {
      const session = state.sessions.get(input.sessionId);
      if (session?.runnerRunId) {
        const runner = await state.options.getRunner().catch(() => null);
        runner?.abort(session.runnerRunId);
      }
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.archive":
    case "session.unarchive":
    case "session.revert": {
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
  }
}

async function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: DispatchState,
): Promise<void> {
  const settings = await state.options.getSettings();
  const modelId = getFreebuffModel(
    input.config.model ?? settings.defaultModel,
  ).id;
  const persistence: ProviderPersistence = input.persistence ?? {
    version: 1,
    data: { modelId, runs: 0 },
  };
  let runState: unknown | null = null;
  if (input.persistence) {
    runState = readRunState(input.persistence, modelId);
  }
  const session: FreebuffSession = {
    config: input.config,
    modelId,
    persistence,
    runState,
    history: [],
    activeTurnId: null,
    runnerRunId: null,
    turn: 0,
  };
  state.sessions.set(input.sessionId, session);
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: [
      "prompt.message",
      "prompt.image",
      "prompt.command",
      "session.configure",
      "session.list",
      "session.persistence",
    ],
    restoration: "core",
    persistence,
    title: input.config.title,
    cwd: input.config.cwd,
  });
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session) });
  state.emit({
    type: "session.commands",
    sessionId: input.sessionId,
    commands: [{ name: "model", description: "Show the current freebuff model" }],
  });
  if (input.history === "replay") {
    for (const item of session.history) {
      state.emit({ type: "timeline.item", sessionId: input.sessionId, item });
    }
    if (input.persistence && session.history.length === 0) {
      state.emit({
        type: "timeline.item",
        sessionId: input.sessionId,
        item: {
          type: "notification",
          id: "restored",
          level: "info",
          message: "Conversation restored from persistence",
        },
      });
    }
  }
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function readRunState(persistence: ProviderPersistence, modelId: string): unknown | null {
  try {
    const data = persistence.data as { modelId?: string; runState?: unknown } | null;
    if (!data || typeof data !== "object") return null;
    if (data.modelId && data.modelId !== modelId) return null;
    if (!data.runState || typeof data.runState !== "object") return null;
    return data.runState;
  } catch {
    return null;
  }
}

async function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: DispatchState,
): Promise<void> {
  const session = state.sessions.get(input.sessionId);
  if (!session) throw new Error(`Unknown session: ${input.sessionId}`);
  const settings = await state.options.getSettings();

  if (input.prompt.delivery === "steer") {
    if (!session.activeTurnId) {
      state.emit({
        type: "session.prompt_result",
        sessionId: input.sessionId,
        clientMessageId: input.prompt.clientMessageId,
        result: { type: "failed", error: { message: "There is no active turn to steer" } },
      });
      return;
    }
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "steer", turnId: session.activeTurnId },
    });
    return;
  }

  if (input.prompt.input.type === "command") {
    await runCommand(input, state, session);
    return;
  }

  const parts = input.prompt.input.content;
  const textParts = parts.filter((p) => p.type === "text").map((p) => (p as { text: string }).text);
  const imageParts = parts.filter((p) => p.type === "image") as Array<{ data: string; mimeType: string }>;
  const text = textParts.join("\n").trim();
  if (!text && imageParts.length === 0) {
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message: "Empty prompt" } },
    });
    return;
  }

  session.turn += 1;
  const turnId = `${session.turn}-${randomUUID().slice(0, 8)}`;
  session.activeTurnId = turnId;

  const userItem: ProviderTimelineItem = {
    type: "user_message",
    id: `user:${turnId}`,
    text: text || "(image)",
    clientMessageId: input.prompt.clientMessageId,
  };
  session.history.push(userItem);
  state.emit({ type: "timeline.item", sessionId: input.sessionId, item: userItem });
  state.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "turn", turnId },
  });
  state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "started" });

  const { apiKey, diagnostic } = resolveFreebuffApiKey(session.config.env, settings.apiKey);
  if (!apiKey) {
    const message = diagnostic ?? "Freebuff authentication is missing.";
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: { type: "error", id: `error:${turnId}`, message },
    });
    state.emit({
      type: "session.turn",
      sessionId: input.sessionId,
      turnId,
      state: "failed",
      error: { message },
    });
    session.activeTurnId = null;
    return;
  }

  const runner = await state.options.getRunner().catch(() => null);
  if (!runner) {
    const message = "Freebuff runner is unavailable. Reload the plugin and try again.";
    state.emit({
      type: "timeline.item",
      sessionId: input.sessionId,
      item: { type: "error", id: `error:${turnId}`, message },
    });
    state.emit({
      type: "session.turn",
      sessionId: input.sessionId,
      turnId,
      state: "failed",
      error: { message },
    });
    session.activeTurnId = null;
    return;
  }

  const model = getFreebuffModel(session.modelId);
  const acc: TimelineAccumulator = { text: "", reasoning: "", toolCalls: new Map() };
  const pushItem = (item: ProviderTimelineItem) => {
    const index = session.history.findIndex((h) => h.id === item.id);
    if (index >= 0) session.history[index] = item;
    else session.history.push(item);
    state.emit({ type: "timeline.item", sessionId: input.sessionId, item });
  };
  const onRunnerEvent = (event: RunnerProjectedEvent) => {
    if (event.kind === "text") {
      acc.text += event.text;
      pushItem({ type: "assistant_message", id: `assistant:${turnId}`, text: acc.text });
      return;
    }
    if (event.kind === "reasoning") {
      acc.reasoning += event.text;
      pushItem({ type: "reasoning", id: `reasoning:${turnId}`, text: acc.reasoning });
      return;
    }
    const sdkEvent = toPrintModeEvent(event);
    if (sdkEvent) mapSdkEvent(sdkEvent, { sessionId: input.sessionId, turnId, acc, emit: pushItem });
  };

  const request: RunnerRunRequest = {
    apiKey,
    cwd: session.config.cwd,
    env: { ...session.config.env },
    agent: {
      id: model.agentId,
      displayName: `Buffy on ${model.label}`,
      model: model.backendModel,
      systemPrompt: buildSystemPrompt(model.label, session.config.systemPrompt),
    },
    agentDefinitions: buildAllAgentDefinitions().map((d) => ({
      id: d.id,
      displayName: d.displayName,
      model: d.model,
      systemPrompt: d.systemPrompt ?? "",
    })),
    prompt: text || "See attached image(s)",
    content:
      imageParts.length > 0
        ? [
            ...(text ? [{ type: "text" as const, text }] : []),
            ...imageParts.map((img) => ({
              type: "image" as const,
              image: img.data,
              mediaType: img.mimeType,
            })),
          ]
        : undefined,
    previousRun: session.runState ?? undefined,
    costMode: "free",
    maxAgentSteps: settings.maxAgentSteps,
    ...(session.config.systemPrompt ? { knowledgeFiles: { "PASEO.md": session.config.systemPrompt } } : {}),
  };

  try {
    const outcome = await new Promise<{ runState: unknown; output: unknown }>((resolve, reject) => {
      void runner
        .run(request, {
          onEvent: onRunnerEvent,
          onDone: (runState, output) => resolve({ runState, output }),
          onFailed: (error, aborted) =>
            reject(Object.assign(new Error(error), { aborted })),
        })
        .then((runId) => {
          session.runnerRunId = runId;
        })
        .catch(reject);
    });
    session.runnerRunId = null;

    session.runState = outcome.runState;
    session.persistence = {
      version: 1,
      data: toJsonValue({ modelId: session.modelId, runs: session.turn, runState: outcome.runState }),
    };
    state.emit({ type: "session.persistence", sessionId: input.sessionId, persistence: session.persistence });

    const output = outcome.output as { type?: string; message?: string } | undefined;
    if (output?.type === "error") {
      const message = output.message || "The freebuff run failed.";
      pushItem({ type: "error", id: `error:${turnId}`, message });
      state.emit({
        type: "session.turn",
        sessionId: input.sessionId,
        turnId,
        state: "failed",
        error: { message },
      });
    } else {
      const finalText = extractOutputText(outcome.output) ?? acc.text;
      if (finalText && finalText !== acc.text) {
        pushItem({ type: "assistant_message", id: `assistant:${turnId}`, text: finalText });
      } else if (!finalText) {
        pushItem({
          type: "assistant_message",
          id: `assistant:${turnId}`,
          text: "(The agent finished without text output. File changes, if any, are in the working directory.)",
        });
      }
      state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "completed" });
    }
  } catch (error) {
    session.runnerRunId = null;
    const aborted = (error as { aborted?: boolean } | null)?.aborted === true;
    const message = error instanceof Error ? error.message : String(error);
    if (aborted) {
      state.emit({ type: "session.turn", sessionId: input.sessionId, turnId, state: "canceled" });
    } else {
      pushItem({ type: "error", id: `error:${turnId}`, message });
      state.emit({
        type: "session.turn",
        sessionId: input.sessionId,
        turnId,
        state: "failed",
        error: { message },
      });
    }
  } finally {
    session.activeTurnId = null;
  }
}

function buildSystemPrompt(modelLabel: string, extra?: string): string {
  return (
    `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.\n` +
    `\n` +
    `- Match the project's existing conventions. Verify a library is already used in the project before employing it.\n` +
    `- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.\n` +
    `- Verify non-trivial changes by running the project's typecheck and relevant tests.\n` +
    `- Use write_todos to plan and track multi-step tasks.\n` +
    `- Your responses are displayed in Paseo. Keep them short and concise.\n` +
    `- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.\n` +
    `- You are running on the ${modelLabel} model through Freebuff, where users chat to code with AI for free. See freebuff.com for more information about the product.\n` +
    (extra ? `\n${extra}\n` : "")
  );
}

async function runCommand(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: DispatchState,
  session: FreebuffSession,
): Promise<void> {
  if (input.prompt.input.type !== "command") return;
  const name = input.prompt.input.name;
  if (name === "model") {
    const model = getFreebuffModel(session.modelId);
    const item: ProviderTimelineItem = {
      type: "assistant_message",
      id: `cmd:${input.prompt.clientMessageId}`,
      text: `Current model: ${model.label} (${model.description})`,
    };
    session.history.push(item);
    state.emit({ type: "timeline.item", sessionId: input.sessionId, item });
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "completed" },
    });
    return;
  }
  state.emit({
    type: "session.prompt_result",
    sessionId: input.sessionId,
    clientMessageId: input.prompt.clientMessageId,
    result: { type: "failed", error: { message: `Unknown command: ${name}` } },
  });
}
