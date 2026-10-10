// Freebuff SDK runner subprocess.
//
// This file is NOT bundled by Paseo: server code never imports it, so it
// stays a plain Node script executed via `spawn(process.execPath, [runner])`.
// It loads @codebuff/sdk from the plugin's own node_modules with a
// createRequire anchored at this file, which keeps the SDK's Node-only
// initialization (web-tree-sitter wasm, createRequire(import.meta.url),
// @vercel/oidc interop) away from Paseo's eval-based plugin bundle.
//
// Protocol: NDJSON over stdio.
//   parent -> child (stdin, one JSON object per line):
//     { id, type: "run", run: { apiKey, cwd, env, agent, prompt, content,
//       previousRun, costMode, maxAgentSteps, knowledgeFiles } }
//     { id, type: "abort", runId }
//   child -> parent (stdout, one JSON object per line):
//     { id, type: "event", event: {...} }   (streaming SDK event projection)
//     { id, type: "done", runState, output }
//     { id, type: "failed", error }
//   A final { type: "ready" } line (no id) is emitted once the SDK loads.
const { createRequire } = require("node:module");
const readline = require("node:readline");

const localRequire = createRequire(__filename);
const sdk = localRequire("@codebuff/sdk");
const { CodebuffClient } = sdk;

const runs = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function projectSdkEvent(event) {
  switch (event.type) {
    case "text":
      return { kind: "text", text: event.text };
    case "reasoning_delta":
      return { kind: "reasoning", text: event.text };
    case "tool_call":
      return {
        kind: "tool_call",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.input,
      };
    case "tool_result":
      return {
        kind: "tool_result",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
      };
    case "subagent_start":
      return {
        kind: "subagent_start",
        agentId: event.agentId,
        agentType: event.agentType,
        displayName: event.displayName,
      };
    case "subagent_finish":
      return {
        kind: "subagent_finish",
        agentId: event.agentId,
        agentType: event.agentType,
        displayName: event.displayName,
      };
    case "error":
      return { kind: "error", message: event.message };
    default:
      return null;
  }
}

function projectStreamChunk(chunk) {
  if (typeof chunk === "string") return { kind: "text", text: chunk };
  if (chunk.type === "reasoning_chunk")
    return { kind: "reasoning", text: chunk.chunk };
  if (chunk.type === "subagent_chunk")
    return { kind: "text", text: chunk.chunk };
  return null;
}

const TOOL_NAMES = [
  "read_files",
  "str_replace",
  "write_file",
  "run_terminal_command",
  "code_search",
  "glob",
  "list_directory",
  "write_todos",
  "web_search",
  "read_url",
  "ask_user",
  "suggest_followups",
  "skill",
];

function toAgentDefinition(agent) {
  return {
    id: agent.id,
    displayName: agent.displayName,
    model: agent.model,
    spawnerPrompt:
      "Single-loop coding agent that explores, edits, and verifies directly with its own tools",
    inputSchema: {
      prompt: { type: "string", description: "A coding task to complete" },
    },
    outputMode: "last_message",
    includeMessageHistory: true,
    toolNames: TOOL_NAMES,
    systemPrompt: agent.systemPrompt,
  };
}

async function startRun(id, run) {
  const abort = new AbortController();
  runs.set(id, abort);
  try {
    const agentDefinitions = (run.agentDefinitions || []).map(toAgentDefinition);
    const client = new CodebuffClient({
      apiKey: run.apiKey,
      cwd: run.cwd,
      env: run.env,
      agentDefinitions,
      maxAgentSteps: run.maxAgentSteps,
      ...(run.knowledgeFiles ? { knowledgeFiles: run.knowledgeFiles } : {}),
    });
    const runState = await client.run({
      agent: toAgentDefinition(run.agent),
      prompt: run.prompt,
      content: run.content,
      previousRun: run.previousRun,
      costMode: run.costMode,
      maxAgentSteps: run.maxAgentSteps,
      signal: abort.signal,
      handleEvent: (event) => {
        const projected = projectSdkEvent(event);
        if (projected) send({ id, type: "event", event: projected });
      },
      handleStreamChunk: (chunk) => {
        const projected = projectStreamChunk(chunk);
        if (projected) send({ id, type: "event", event: projected });
      },
    });
    runs.delete(id);
    send({ id, type: "done", runState, output: runState.output });
  } catch (error) {
    runs.delete(id);
    const aborted = abort.signal.aborted;
    send({
      id,
      type: "failed",
      aborted,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main() {
  send({ type: "ready" });
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.type === "run") {
      void startRun(msg.id, msg.run);
    } else if (msg.type === "abort") {
      const abort = runs.get(msg.runId ?? msg.id);
      if (abort) abort.abort("Interrupted by user");
    }
  }
}

main().catch((error) => {
  process.stderr.write(`freebuff runner fatal: ${error.message}\n`);
  process.exit(1);
});
