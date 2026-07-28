import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { createModelSelection } from "@t3tools/shared/model";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface PickerProps {
  readonly activeInstanceId: ProviderInstanceId;
  readonly instanceEntries: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly displayName: string;
    readonly driverKind: ProviderDriverKind;
  }>;
  readonly model: string;
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<{ readonly slug: string; readonly name: string }>
  >;
  readonly triggerAriaLabel?: string;
}

const componentState = vi.hoisted(() => ({
  providers: [] as ServerProvider[],
  settings: null as unknown as UnifiedSettings,
  updateSettings: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => componentState.providers,
}));

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => componentState.settings,
  useUpdatePrimarySettings: () => componentState.updateSettings,
}));

vi.mock("../chat/ProviderModelPicker", async () => {
  const { createElement: createMockElement } = await import("react");

  return {
    ProviderModelPicker: (props: PickerProps) => {
      const activeEntry = props.instanceEntries.find(
        (entry) => entry.instanceId === props.activeInstanceId,
      );
      const activeModel = props.modelOptionsByInstance
        .get(props.activeInstanceId)
        ?.find((model) => model.slug === props.model);

      return createMockElement(
        "div",
        {
          "aria-label": props.triggerAriaLabel,
          "data-active-instance": props.activeInstanceId,
          role: "group",
        },
        createMockElement(
          "span",
          { "data-active-selection": "true" },
          `${activeEntry?.displayName ?? props.activeInstanceId}: ${
            activeModel?.name ?? props.model
          }`,
        ),
        createMockElement(
          "ul",
          null,
          props.instanceEntries.map((entry) =>
            createMockElement(
              "li",
              { key: entry.instanceId },
              `${entry.displayName} (${entry.driverKind})`,
            ),
          ),
        ),
      );
    },
  };
});

import {
  SourceControlWritingSettingsSection,
  filterSupportedSourceControlWriterProviders,
} from "./SourceControlWritingSettings";

function provider(
  instanceId: string,
  driver: string,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-07-27T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("source control writer provider policy", () => {
  beforeEach(() => {
    componentState.providers = [];
    componentState.settings = DEFAULT_UNIFIED_SETTINGS;
    componentState.updateSettings.mockReset();
  });

  it("keeps every TritonAI Codex instance and drops legacy upstream drivers", () => {
    const providers = [
      provider("codex", "codex"),
      provider("codex_work", "codex"),
      provider("claude", "claudeAgent"),
      provider("cursor", "cursor"),
      provider("legacy", "legacy-upstream"),
    ];

    expect(
      filterSupportedSourceControlWriterProviders(providers).map(
        (candidate) => candidate.instanceId,
      ),
    ).toEqual([ProviderInstanceId.make("codex"), ProviderInstanceId.make("codex_work")]);
  });

  it("renders only TritonAI and falls back from an unsupported persisted writer", () => {
    const codexInstanceId = ProviderInstanceId.make("codex");
    const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
    const codexDriver = ProviderDriverKind.make("codex");
    const claudeDriver = ProviderDriverKind.make("claudeAgent");
    const codexModel = "tritonai-managed-default";
    const claudeModel = "claude-persisted-choice";

    componentState.providers = [
      provider("codex", "codex", {
        displayName: "TritonAI",
        models: [
          {
            slug: codexModel,
            name: "TritonAI Managed Default",
            isCustom: false,
            isDefault: true,
            capabilities: {},
          },
        ],
      }),
      provider("claudeAgent", "claudeAgent", {
        displayName: "Claude Code",
        models: [
          {
            slug: claudeModel,
            name: "Claude Persisted Choice",
            isCustom: false,
            isDefault: true,
            capabilities: {},
          },
        ],
      }),
    ];
    componentState.settings = {
      ...DEFAULT_UNIFIED_SETTINGS,
      textGenerationModelSelection: createModelSelection(codexInstanceId, codexModel),
      sourceControlWriterModelSelection: createModelSelection(claudeInstanceId, claudeModel),
      providerInstances: {
        [codexInstanceId]: { driver: codexDriver, enabled: true },
        [claudeInstanceId]: { driver: claudeDriver, enabled: true },
      },
    };

    const markup = renderToStaticMarkup(createElement(SourceControlWritingSettingsSection));

    expect(markup).toContain('aria-label="Source control writer model"');
    expect(markup).toContain('data-active-instance="codex"');
    expect(markup).toContain("TritonAI: TritonAI Managed Default");
    expect(markup).toContain("TritonAI (codex)");
    expect(markup).not.toContain("Claude Code");
    expect(markup).not.toContain("Claude Persisted Choice");
  });
});
