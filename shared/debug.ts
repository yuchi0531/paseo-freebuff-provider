import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

/** Debug RPC: reports the plugin subprocess environment for bridge setup. */
export const freebuffDebugEnv = defineRpc({
  name: "freebuff.debug-env",
  input: z.object({}),
  output: z.object({
    cwd: z.string(),
    execPath: z.string(),
    home: z.string(),
    paseoHome: z.string().optional(),
    configPath: z.string().optional(),
    pluginDir: z.string().optional(),
  }),
});
