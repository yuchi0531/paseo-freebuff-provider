/**
 * Freebuff model catalog for the Paseo provider plugin.
 *
 * These are the free-tier models Freebuff exposes through its CLI picker.
 * Each entry maps a Paseo model id to the Codebuff backend model id and the
 * Codebuff agent root that runs it in `free` cost mode. The agent ids are the
 * compiled `base3-free-*` roots from the freebuff repository
 * (agents/base3-free-*.ts, FREEBUFF_CLI_BASE3_AGENT_ID_BY_MODEL).
 *
 * Model ids below were read from the freebuff repository:
 * - common/src/constants/freebuff-models.ts (wire ids)
 * - common/src/constants/freebuff-model-ids.ts (fast mode id)
 * - common/src/constants/free-agents.ts (agent root ids)
 */

export interface FreebuffModelEntry {
  /** Paseo model id, selectable in the agent form. */
  id: string;
  /** Human-readable label. */
  label: string;
  /** One-line description. */
  description: string;
  /** Codebuff backend wire id (the agent definition's `model`). */
  backendModel: string;
  /** Compiled freebuff agent root id for this model. */
  agentId: string;
  /** Approximate context window in tokens. */
  contextWindow: number;
  /** Whether the model accepts image input. */
  multimodal: boolean;
}

export const FREEBUFF_MODELS: readonly FreebuffModelEntry[] = [
  {
    id: "mimo-2-6-flash",
    label: "MiMo 2.6 Flash",
    description: "Balanced default, unmetered",
    backendModel: "xiaomi/mimo-v2.5",
    agentId: "base3-free-mimo",
    contextWindow: 200_000,
    multimodal: true,
  },
  {
    id: "glm-5-3-flash",
    label: "GLM 5.3 Flash",
    description: "Deepest reasoning, unmetered",
    backendModel: "z-ai/glm-5.3-flash",
    agentId: "base3-free-glm-5-3-flash",
    contextWindow: 1_000_000,
    multimodal: false,
  },
  {
    id: "deepseek-v4-1-flash",
    label: "DeepSeek V4.1 Flash",
    description: "Fast coding and tool use, unmetered",
    backendModel: "deepseek/deepseek-v4-flash",
    agentId: "base3-free-deepseek-flash",
    contextWindow: 1_048_576,
    multimodal: true,
  },
  {
    id: "deepseek-v4-1-flash-fast",
    label: "DeepSeek V4.1 Flash Fast",
    description: "Parallel subagents on DeepSeek's own API",
    backendModel: "deepseek/deepseek-v4-flash-fast",
    agentId: "base3-fast-free-deepseek-flash",
    contextWindow: 1_048_576,
    multimodal: true,
  },
  {
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    description: "Strong all-around with native images",
    backendModel: "openai/gpt-6-luna",
    agentId: "base3-free-luna-6",
    contextWindow: 1_000_000,
    multimodal: true,
  },
  {
    id: "mimo-2-6-pro",
    label: "MiMo 2.6 Pro",
    description: "Stronger reasoning with image support",
    backendModel: "xiaomi/mimo-v2.6-pro",
    agentId: "base3-free-mimo-2-6-pro",
    contextWindow: 200_000,
    multimodal: true,
  },
  {
    id: "solar-mini-4",
    label: "Solar Mini 4",
    description: "Fast and compact, 524K context",
    backendModel: "upstage/solar-mini-4",
    agentId: "base3-free-solar-mini4",
    contextWindow: 500_000,
    multimodal: false,
  },
  {
    id: "solar-pro-4",
    label: "Solar Pro 4",
    description: "Larger and stronger, 524K context",
    backendModel: "upstage/solar-pro-4",
    agentId: "base3-free-solar-pro4",
    contextWindow: 500_000,
    multimodal: false,
  },
];

export const DEFAULT_FREEBUFF_MODEL_ID = "mimo-2-6-flash";

export function getFreebuffModel(id: string | undefined): FreebuffModelEntry {
  if (!id) {
    return FREEBUFF_MODELS.find((m) => m.id === DEFAULT_FREEBUFF_MODEL_ID)!;
  }
  return (
    FREEBUFF_MODELS.find((m) => m.id === id) ??
    FREEBUFF_MODELS.find((m) => m.id === DEFAULT_FREEBUFF_MODEL_ID)!
  );
}
