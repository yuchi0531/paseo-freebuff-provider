import type { PluginServerContext } from "@getpaseo/plugin/server";
import { FreebuffRunner } from "./server/bridge";
import { debugEnv } from "./server/debug";
import { createFreebuffProvider, resolveRunnerPath } from "./server/provider";
import { freebuffDebugEnv } from "./shared/debug";
import { freebuffSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(freebuffSettings);
  server.handle(freebuffDebugEnv, debugEnv);

  let runner: FreebuffRunner | null = null;
  const getRunner = async (): Promise<FreebuffRunner | null> => {
    if (runner?.isReady) return runner;
    const resolved = resolveRunnerPath();
    if (!resolved.path) {
      console.error(`[freebuff] ${resolved.diagnostic ?? "Runner unavailable."}`);
      return null;
    }
    if (!runner) {
      runner = new FreebuffRunner(resolved.path);
      runner.start();
    }
    return runner;
  };

  server.registerProvider(
    createFreebuffProvider({
      getSettings: async () => {
        const state = await settings.read();
        if (state.status === "ready") {
          return {
            apiKey: state.values.apiKey,
            defaultModel: state.values.defaultModel,
            maxAgentSteps: state.values.maxAgentSteps,
          };
        }
        return { apiKey: "", defaultModel: "mimo-2-6-flash", maxAgentSteps: 20 };
      },
      getRunner,
    }),
  );
  return () => {
    runner?.stop();
    runner = null;
  };
};
