import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useQuery } from "@tanstack/react-query";
import { freebuffDebugEnv } from "../shared/debug";
import {
  SettingsCard,
  SettingsSection,
  SettingsSelect,
  SettingsInput,
  SettingsAction,
} from "@getpaseo/plugin/client/ui";
import { useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { FREEBUFF_MODELS } from "../shared/models";
import { freebuffSettings } from "../shared/settings";

export function FreebuffSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(freebuffSettings);
  const callDebugEnv = useRpc(freebuffDebugEnv);
  const debugEnv = useQuery({ queryKey: ["freebuff-debug-env"], queryFn: () => callDebugEnv({}) });
  const [apiKeyDraft, setApiKeyDraft] = useState<string | null>(null);
  const [stepsDraft, setStepsDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const apiKeyInputRef = useRef<{ getText(): string } | null>(null);
  const stepsInputRef = useRef<{ getText(): string } | null>(null);

  const styles = useMemo(
    () => ({
      screen: {
        flex: 1,
        padding: layout.compact ? 16 : 24,
        gap: layout.compact ? 12 : 16,
        backgroundColor: theme.colors.surface0,
      },
      note: { color: theme.colors.foregroundMuted, fontSize: 13 },
      status: { color: theme.colors.foreground, fontSize: 13 },
    }),
    [theme, layout.compact],
  );

  if (settings.status !== "ready") {
    return (
      <View style={styles.screen}>
        <Text style={styles.note}>
          {settings.status === "loading"
            ? "Loading freebuff settings."
            : `Settings unavailable: ${settings.error}`}
        </Text>
      </View>
    );
  }

  const values = settings.values;
  const modelOptions = FREEBUFF_MODELS.map((m) => ({ label: m.label, value: m.id }));

  async function save(next: typeof values) {
    setStatus(null);
    const revision = settings.status === "ready" ? settings.revision : "";
    const ok = await settings.save(next, revision);
    setStatus(ok ? "Saved." : "Save failed: unknown error");
  }

  return (
    <View style={styles.screen}>
      <SettingsSection
        title="Authentication"
        info="Empty uses your freebuff CLI login or CODEBUFF_API_KEY."
      >
        <SettingsCard>
          <SettingsInput
            ref={apiKeyInputRef as never}
            label="API key override"
            hint="Leave empty to use the freebuff CLI login."
            placeholder="cb_..."
            secureTextEntry
            initialValue={values.apiKey}
            onChangeText={(text) => setApiKeyDraft(text)}
          />
          <SettingsAction
            label="API key"
            hint={apiKeyDraft === null ? "No changes." : "Unsaved changes."}
            actionLabel="Save key"
            onPress={() =>
              save({ ...values, apiKey: apiKeyDraft ?? apiKeyInputRef.current?.getText() ?? values.apiKey })
            }
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Defaults">
        <SettingsCard>
          <SettingsSelect
            label="Default model"
            value={values.defaultModel}
            options={modelOptions}
            onValueChange={(defaultModel) => save({ ...values, defaultModel })}
          />
          <SettingsInput
            ref={stepsInputRef as never}
            label="Max agent steps"
            hint="Safety cap per turn (1-100)."
            placeholder="20"
            initialValue={String(values.maxAgentSteps)}
            onChangeText={(text) => setStepsDraft(text)}
          />
          <SettingsAction
            label="Agent steps"
            hint={stepsDraft === null ? "No changes." : "Unsaved changes."}
            actionLabel="Save steps"
            onPress={() => {
              const raw = stepsDraft ?? stepsInputRef.current?.getText() ?? String(values.maxAgentSteps);
              const parsed = Number.parseInt(raw, 10);
              if (!Number.isFinite(parsed) || parsed < 1 || parsed > 100) {
                setStatus("Steps must be a number between 1 and 100.");
                return;
              }
              save({ ...values, maxAgentSteps: parsed });
            }}
          />
        </SettingsCard>
      </SettingsSection>

      <Text style={styles.note}>
        The provider reads your freebuff CLI login from the daemon machine when no key is set. File
        edits, shell commands, and web lookups run through the Codebuff backend from the daemon.
      </Text>
      {status ? <Text style={styles.status}>{status}</Text> : null}
      <Text style={styles.note}>
        {debugEnv.data
          ? `daemon cwd: ${debugEnv.data.cwd}; plugin dir: ${debugEnv.data.pluginDir ?? "(unknown)"}`
          : debugEnv.isLoading
            ? "Probing daemon environment."
            : "Environment probe unavailable."}
      </Text>
    </View>
  );
}
