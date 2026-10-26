import type { EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";

export function OutdatedServerUpdateSection({
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  return (
    <SettingsSection title="TritonAI Harness">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">Update required</Text>
        <Text className="text-sm text-foreground-muted">
          Update TritonAI Harness on {label} through the desktop app or managed installer, then
          reconnect.
        </Text>
      </View>
    </SettingsSection>
  );
}
