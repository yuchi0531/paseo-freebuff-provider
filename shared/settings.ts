import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped settings for the freebuff provider.
 *
 * `apiKey` is optional: when empty, the provider reads the freebuff CLI
 * login (credentials.json under the freebuff config dir, or the
 * CODEBUFF_API_KEY environment variable). An explicit key here overrides
 * both, which is useful on shared daemon machines.
 */
export const freebuffSettings = defineSettings({
  id: "freebuff",
  scope: "host",
  version: 1,
  schema: z.object({
    apiKey: z.string().default(""),
    defaultModel: z.string().default("mimo-2-6-flash"),
    maxAgentSteps: z.number().int().min(1).max(100).default(20),
  }),
});
