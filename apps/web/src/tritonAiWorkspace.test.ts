import { describe, expect, it } from "vite-plus/test";

import {
  TRITONAI_FIRST_RUN_WORKSPACE,
  isTritonAiCodeBrand,
  isTritonAiWorkspacePath,
  resolveTritonAiFirstRunWorkspacePath,
} from "./tritonAiWorkspace";

describe("tritonAiWorkspace", () => {
  it("is scoped to the TritonAI Harness brand", () => {
    expect(isTritonAiCodeBrand("TritonAI Harness")).toBe(true);
    expect(isTritonAiCodeBrand("TritonAI Code")).toBe(false);
  });

  it("resolves the first-run TritonAI home workspace", () => {
    expect(resolveTritonAiFirstRunWorkspacePath()).toBe(TRITONAI_FIRST_RUN_WORKSPACE);
    expect(isTritonAiWorkspacePath("~/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("/Users/david/TritonAI/")).toBe(true);
    expect(isTritonAiWorkspacePath("/home/david/TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("C:\\Users\\david\\TritonAI")).toBe(true);
    expect(isTritonAiWorkspacePath("~/Projects/TritonAI")).toBe(false);
  });
});
