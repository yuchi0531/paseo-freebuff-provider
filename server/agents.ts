import type { AgentDefinition } from "@codebuff/sdk";
import { FREEBUFF_MODELS, type FreebuffModelEntry } from "../shared/models";

/**
 * Build a Codebuff agent definition for a freebuff model.
 *
 * This mirrors the freebuff CLI's `base3-free-*` roots (agents/base3.ts
 * createBase3CliRoot with isFreebuff: true): a single-loop coding agent with
 * the canonical Buffy opening, the harness toolset, and the selected model.
 * The server admits the turn in `free` cost mode, so allowlisted agent+model
 * combinations cost no credits.
 */
export function buildFreebuffAgentDefinition(
  model: FreebuffModelEntry,
): AgentDefinition {
  return {
    id: model.agentId,
    displayName: `Buffy on ${model.label}`,
    model: model.backendModel,
    spawnerPrompt:
      "Single-loop coding agent that explores, edits, and verifies directly with its own tools",
    inputSchema: {
      prompt: { type: "string", description: "A coding task to complete" },
    },
    outputMode: "last_message",
    includeMessageHistory: true,
    toolNames: [
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
    ],
    systemPrompt: `You are Buffy, the coding agent behind Codebuff. You help users with software engineering tasks: fixing bugs, adding functionality, refactoring, and explaining code.

- Match the project's existing conventions. Verify a library is already used in the project before employing it.
- Prefer editing existing files over creating new ones. Make the fewest changes that address the request.
- Verify non-trivial changes by running the project's typecheck and relevant tests.
- Use write_todos to plan and track multi-step tasks.
- Your responses are displayed in Paseo. Keep them short and concise.
- Don't run destructive or hard-to-undo commands (git push, resets, deploys) unless the user asks for them.
- You are running on the ${model.label} model through Freebuff, where users chat to code with AI for free. See freebuff.com for more information about the product.
`,
  } as AgentDefinition;
}

export function buildAllAgentDefinitions(): AgentDefinition[] {
  return FREEBUFF_MODELS.map(buildFreebuffAgentDefinition);
}
