import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import type { RpcInput } from "@getpaseo/plugin";
import { freebuffDebugEnv } from "../shared/debug";

export function findPluginDir(): string | undefined {
  const home =
    process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const configPath = join(home, "config.json");
  try {
    if (!existsSync(configPath)) return undefined;
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      plugins?: Record<string, { path?: string }>;
    };
    return config.plugins?.["freebuff"]?.path;
  } catch {
    return undefined;
  }
}

export function debugEnv(_input: RpcInput<typeof freebuffDebugEnv>) {
  const home =
    process.env.PASEO_HOME ?? join(homedir(), ".paseo");
  const configPath = join(home, "config.json");
  return {
    cwd: process.cwd(),
    execPath: process.execPath,
    home: homedir(),
    paseoHome: process.env.PASEO_HOME,
    configPath,
    pluginDir: findPluginDir(),
  };
}
