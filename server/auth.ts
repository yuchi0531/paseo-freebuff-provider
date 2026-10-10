import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface StoredUser {
  authToken?: string;
  tokenStore?: string;
  id?: string;
  email?: string;
}

/**
 * Resolve the freebuff config directory. Mirrors the freebuff CLI
 * (cli/src/utils/config-dir.ts): FREEBUFF_CONFIG_DIR wins, otherwise
 * ~/.config/manicode (plus a non-prod suffix outside production, which we
 * ignore here because the plugin always targets production).
 */
export function getFreebuffConfigDir(env: Record<string, string>): string {
  const configured = env.FREEBUFF_CONFIG_DIR ?? process.env.FREEBUFF_CONFIG_DIR;
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  return join(homedir(), ".config", "manicode");
}

function readDefaultProfile(configDir: string): StoredUser | null {
  try {
    const raw = readFileSync(join(configDir, "credentials.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const profile = parsed.default;
    if (!profile || typeof profile !== "object") return null;
    return profile as StoredUser;
  } catch {
    return null;
  }
}

/**
 * Resolve the API key freebuff requests should use.
 *
 * Priority:
 * 1. Explicit plugin setting (per-host settings document).
 * 2. CODEBUFF_API_KEY from the session environment.
 * 3. The freebuff CLI login (authToken in credentials.json).
 *
 * Keychain-pointer profiles (tokenStore: "keychain" without an inline
 * authToken) are not readable from the daemon subprocess, so they are
 * skipped with a diagnostic guiding the user to set CODEBUFF_API_KEY or
 * the plugin setting.
 */
export function resolveFreebuffApiKey(
  sessionEnv: Readonly<Record<string, string>>,
  settingsApiKey: string,
): { apiKey: string | null; diagnostic: string | null } {
  if (settingsApiKey.trim().length > 0) {
    return { apiKey: settingsApiKey.trim(), diagnostic: null };
  }
  const envKey =
    sessionEnv.CODEBUFF_API_KEY ?? process.env.CODEBUFF_API_KEY ?? "";
  if (envKey.trim().length > 0) {
    return { apiKey: envKey.trim(), diagnostic: null };
  }
  const configDir = getFreebuffConfigDir(sessionEnv as Record<string, string>);
  const profile = readDefaultProfile(configDir);
  if (profile?.authToken) {
    return { apiKey: profile.authToken, diagnostic: null };
  }
  if (profile?.tokenStore === "keychain") {
    return {
      apiKey: null,
      diagnostic:
        "Freebuff login lives in the OS keychain, which the Paseo daemon cannot read. " +
        "Run `freebuff login` in a terminal, or set CODEBUFF_API_KEY in the session environment, " +
        "or store a key in the freebuff plugin settings.",
    };
  }
  return {
    apiKey: null,
    diagnostic:
      `No freebuff login found (looked in ${join(configDir, "credentials.json")} and CODEBUFF_API_KEY). ` +
      "Run `freebuff login` in a terminal, or set CODEBUFF_API_KEY, or store a key in the freebuff plugin settings.",
  };
}
