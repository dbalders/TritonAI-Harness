import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { DynamicColorIOS, Platform } from "react-native";

import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native-glass";
import { nativeHeaderScrollEdgeEffects } from "./scrollEdgeEffects";

export type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
  readonly unstable_headerMinimizationBehavior?: "onScrollUp" | "never";
};

/** A transparent bar that content scrolls under, with UIKit's scroll-edge blur where it has one. */
const SHEET_BACKGROUND_COLOR =
  Platform.OS === "ios"
    ? DynamicColorIOS({ light: "rgba(242, 242, 247, 0.98)", dark: "rgba(14, 14, 14, 0.98)" })
    : undefined;

export const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED
    ? { backgroundColor: "transparent" }
    : SHEET_BACKGROUND_COLOR === undefined
      ? undefined
      : { backgroundColor: SHEET_BACKGROUND_COLOR as unknown as string },
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
    ? nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version)
    : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};
