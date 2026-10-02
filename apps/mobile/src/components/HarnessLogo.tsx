import Constants from "expo-constants";
import { Image } from "expo-image";

const appVariant = Constants.expoConfig?.extra?.appVariant;
const HARNESS_LOGO_SOURCE =
  appVariant === "development"
    ? require("../../../../assets/dev/tritonai-harness-dev-universal-1024.png")
    : appVariant === "preview"
      ? require("../../../../assets/nightly/tritonai-harness-nightly-universal-1024.png")
      : require("../../../../assets/prod/tritonai-logo.png");

export function HarnessLogo({ size }: { readonly size: number }) {
  return (
    <Image
      source={HARNESS_LOGO_SOURCE}
      accessible={false}
      accessibilityIgnoresInvertColors
      contentFit="contain"
      style={{ width: size, height: size }}
    />
  );
}
