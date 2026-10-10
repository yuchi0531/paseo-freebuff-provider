import type { PluginClientContext } from "@getpaseo/plugin/client";
import { FreebuffSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "freebuff",
    title: "Freebuff",
    icon: "Sparkles",
    Component: FreebuffSettingsScreen,
  });
  return () => {};
}
