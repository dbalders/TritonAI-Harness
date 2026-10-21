import { describe, expect, it } from "vite-plus/test";
import { iosBuildTarget, nativeClientAppId } from "./mobile-native-client.ts";

describe("generated iOS build identity", () => {
  it("uses the downstream workspace, scheme and application after Expo prebuild", () => {
    expect(
      iosBuildTarget([
        "Pods",
        "Podfile",
        "TritonAIHarnessDev.xcworkspace",
        "TritonAIHarnessDev.xcodeproj",
      ]),
    ).toEqual({
      workspace: "TritonAIHarnessDev.xcworkspace",
      scheme: "TritonAIHarnessDev",
      appFile: "TritonAIHarnessDev.app",
    });
  });
  it("continues to support upstream development identities", () => {
    expect(iosBuildTarget(["T3CodeDev.xcworkspace"]).scheme).toBe("T3CodeDev");
  });
  it("refuses missing or ambiguous workspaces before invoking Xcode", () => {
    expect(() => iosBuildTarget(["Podfile"])).toThrow("Expected one generated iOS workspace");
    expect(() => iosBuildTarget(["One.xcworkspace", "Two.xcworkspace"])).toThrow(
      "Expected one generated iOS workspace",
    );
  });
});

it("detects the installed development app by its platform-specific identity", () => {
  expect(nativeClientAppId("ios")).toBe("edu.ucsd.tritonai.harness.dev");
  expect(nativeClientAppId("android")).toBe("com.t3tools.t3code.dev");
});
