import type {
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import type { PrintModeEvent } from "@codebuff/sdk";

export interface TimelineAccumulator {
  text: string;
  reasoning: string;
  toolCalls: Map<string, { name: string; input: Record<string, unknown> }>;
}

/** Normalize SDK tool input (unknown JSON) into a plain record. */
function toRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return { value: input };
}

function stringify(value: unknown, max = 4000): string {
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > max ? text.slice(0, max) + "…" : text;
  } catch {
    return String(value);
  }
}

/**
 * Map a Codebuff tool call to a Paseo tool-call detail. Covers the tools the
 * base3 harness uses; anything else becomes a plain-text detail so the call
 * is still visible.
 */
export function mapToolDetail(
  toolName: string,
  input: Record<string, unknown>,
  output: unknown,
): ProviderToolCallDetail {
  const out = output === undefined ? undefined : stringify(output);
  switch (toolName) {
    case "run_terminal_command": {
      const command =
        typeof input.command === "string" ? input.command : toolName;
      return { type: "shell", command, output: out };
    }
    case "read_files": {
      const paths = Array.isArray(input.filePaths ?? input.paths)
        ? ((input.filePaths ?? input.paths) as unknown[])
        : [];
      return {
        type: "read",
        filePath: typeof paths[0] === "string" ? (paths[0] as string) : "",
        content: out,
      };
    }
    case "str_replace": {
      return {
        type: "edit",
        filePath: typeof input.filePath === "string" ? input.filePath : "",
        oldString:
          typeof input.oldString === "string" ? input.oldString : undefined,
        newString:
          typeof input.newString === "string" ? input.newString : undefined,
      };
    }
    case "write_file": {
      return {
        type: "write",
        filePath: typeof input.filePath === "string" ? input.filePath : "",
        content:
          typeof input.content === "string" ? input.content : stringify(input),
      };
    }
    case "code_search":
    case "glob":
    case "list_directory":
    case "web_search": {
      const query =
        typeof input.pattern === "string"
          ? input.pattern
          : typeof input.query === "string"
            ? input.query
            : typeof input.path === "string"
              ? input.path
              : toolName;
      return {
        type: "search",
        query,
        toolName:
          toolName === "web_search"
            ? "web_search"
            : toolName === "glob"
              ? "glob"
              : "search",
        content: out,
      };
    }
    case "write_todos": {
      return { type: "plain_text", label: "Todos", text: out ?? toolName };
    }
    default: {
      return {
        type: "plain_text",
        label: toolName,
        text: out ?? stringify(input),
      };
    }
  }
}

export interface EventMappingContext {
  sessionId: string;
  turnId: string;
  acc: TimelineAccumulator;
  emit: (item: ProviderTimelineItem) => void;
}

/** Project one SDK event onto Paseo timeline snapshots. */
export function mapSdkEvent(
  event: PrintModeEvent,
  ctx: EventMappingContext,
): void {
  const assistantId = `assistant:${ctx.turnId}`;
  switch (event.type) {
    case "text": {
      ctx.acc.text += event.text;
      ctx.emit({ type: "assistant_message", id: assistantId, text: ctx.acc.text });
      return;
    }
    case "reasoning_delta": {
      ctx.acc.reasoning += event.text;
      ctx.emit({
        type: "reasoning",
        id: `reasoning:${ctx.turnId}`,
        text: ctx.acc.reasoning,
      });
      return;
    }
    case "tool_call": {
      ctx.acc.toolCalls.set(event.toolCallId, {
        name: event.toolName,
        input: toRecord(event.input),
      });
      // Hidden orchestration tools never get a timeline row.
      if (
        event.toolName === "spawn_agents" ||
        event.toolName === "spawn_agent_inline" ||
        event.toolName === "end_turn"
      ) {
        return;
      }
      ctx.emit({
        type: "tool_call",
        id: `tool:${event.toolCallId}`,
        callId: event.toolCallId,
        name: event.toolName,
        detail: mapToolDetail(event.toolName, toRecord(event.input), undefined),
        status: "running",
        error: null,
      });
      return;
    }
    case "tool_result": {
      const call = ctx.acc.toolCalls.get(event.toolCallId);
      const output = event.output?.[0];
      const value =
        output && typeof output === "object" && "value" in output
          ? (output as { value: unknown }).value
          : event.output;
      if (!call) {
        ctx.emit({
          type: "tool_call",
          id: `tool:${event.toolCallId}`,
          callId: event.toolCallId,
          name: event.toolName,
          detail: mapToolDetail(event.toolName, {}, value),
          status: "completed",
          error: null,
        });
        return;
      }
      if (
        call.name === "spawn_agents" ||
        call.name === "spawn_agent_inline" ||
        call.name === "end_turn"
      ) {
        ctx.acc.toolCalls.delete(event.toolCallId);
        return;
      }
      const failed =
        Array.isArray(event.output) &&
        event.output.some((item: unknown): boolean => {
          if (typeof item !== "object" || item === null) return false;
          if (!("value" in item)) return false;
          const inner = (item as { value: unknown }).value;
          if (typeof inner !== "object" || inner === null) return false;
          return (
            typeof (inner as { errorMessage?: unknown }).errorMessage === "string"
          );
        });
      ctx.emit({
        type: "tool_call",
        id: `tool:${event.toolCallId}`,
        callId: event.toolCallId,
        name: call.name,
        detail: mapToolDetail(call.name, call.input, value),
        status: failed ? "failed" : "completed",
        error: failed ? value : null,
      } as ProviderTimelineItem);
      ctx.acc.toolCalls.delete(event.toolCallId);
      return;
    }
    case "subagent_start": {
      ctx.emit({
        type: "notification",
        id: `subagent-start:${event.agentId}`,
        level: "info",
        message: `Subagent started: ${event.displayName || event.agentType}`,
      });
      return;
    }
    case "subagent_finish": {
      ctx.emit({
        type: "notification",
        id: `subagent-finish:${event.agentId}`,
        level: "info",
        message: `Subagent finished: ${event.displayName || event.agentType}`,
      });
      return;
    }
    case "error": {
      ctx.emit({ type: "error", id: `error:${ctx.turnId}`, message: event.message });
      return;
    }
    case "finish":
    case "start":
    case "download":
      return;
  }
}

/** Extract the final assistant text from a completed RunState output. */
export function extractOutputText(output: unknown): string | null {
  if (!output || typeof output !== "object") return null;
  const typed = output as { type?: string; value?: unknown; message?: string };
  if (typed.type === "error") {
    return null;
  }
  if (typed.type === "lastMessage" || typed.type === "allMessages") {
    const messages = Array.isArray(typed.value) ? typed.value : [];
    const texts: string[] = [];
    for (const message of messages) {
      if (!message || typeof message !== "object") continue;
      const m = message as { role?: string; content?: unknown };
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (
          part &&
          typeof part === "object" &&
          (part as { type?: string }).type === "text" &&
          typeof (part as { text?: unknown }).text === "string"
        ) {
          texts.push((part as { text: string }).text);
        }
      }
    }
    return texts.length > 0 ? texts.join("\n") : null;
  }
  if (typed.type === "structuredOutput") {
    return stringify(typed.value);
  }
  return null;
}
