import { EnvironmentId, type HelpContext } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { buildHelpReport, redactHelpText } from "./helpReport";

const context: HelpContext = {
  capturedAt: "2026-10-22T18:00:00.000Z",
  environmentId: EnvironmentId.make("private-environment-id"),
  environmentName: "Private research host",
  version: "0.3.8-nightly.20261021.94",
  platform: "darwin arm64",
  mode: "desktop",
  paths: [{ label: "Settings", path: "/Users/private-person/secret/settings.json" }],
  providers: [
    {
      id: "private-account",
      name: "Personal provider name",
      driver: "codex",
      enabled: true,
      status: "ready",
      authenticated: true,
    },
  ],
  modelLabel: "Private model label",
  diagnostics: {
    recordCount: 20,
    failureCount: 3,
    slowSpanCount: 1,
    partial: true,
    recentFailures: [
      {
        operation: "private-operation",
        category: "private-cause",
        occurredAt: "2026-10-22T17:55:00.000Z",
      },
    ],
  },
};

const reportInput = {
  context,
  summary: "Provider stops replying",
  steps: "Send a message, then try a follow-up.",
  expected: "The follow-up receives a response.",
  actual: "The request stops with an error.",
  conversation: [{ role: "user" as const, content: "Private support question" }],
  includeConversation: false,
};

const expandedContext: HelpContext = {
  ...context,
  knowledge: {
    settings: {
      entries: [
        { key: "worktreesDirectory", value: "/unusual-host/private worktrees" },
        {
          key: "previousWorktreesDirectories",
          value: JSON.stringify(["/older-host/private worktrees", "relative/private-worktrees"]),
        },
        { key: "provider.clientSecret", value: "opaque-setting-credential" },
        { key: "usageLimitSources.source.managementKey", value: "opaque-management-key" },
        { key: "theme", value: "dark" },
      ],
      totalCount: 5,
      omittedCount: 0,
    },
    pluginsStatus: "reported",
    plugins: [
      {
        id: "private-plugin-id",
        name: "Private plugin name",
        description: 'Installed at "/plugin-volume/private plugin".',
        version: "private-plugin-version",
        installed: true,
        enabled: true,
        requiresConnection: true,
        connectionState: "connected",
        capabilities: [],
        tools: [],
        skills: [],
        detailsOmitted: false,
      },
    ],
    pluginsOmittedCount: 0,
    documentation: [
      {
        title: "Private manual",
        path: "/manual-volume/private.md",
        content: "Private manual text",
      },
      { title: "Help", path: "docs/user/help.md", content: "Open /settings/providers." },
    ],
    documentationStatus: "available",
  },
  client: {
    surface: "desktop",
    platform: "Client platform detail",
    settingsStatus: "ready",
    settings: {
      entries: [
        { key: "addProjectBaseDirectory", value: "/client-volume/private projects" },
        {
          key: "browserProfiles",
          value: JSON.stringify([
            { id: "private-profile", userDataDir: "\\\\private-server\\private share\\profile" },
            { id: "other-profile", userDataDir: "Z:\\odd client root\\private profile" },
            { id: "home-profile", userDataDir: "~/private browser profile" },
            { id: "variable-profile", userDataDir: "%APPDATA%\\Private Profile" },
            { id: "file-profile", userDataDir: "file:///client-volume/encoded%20profile" },
          ]),
        },
        {
          key: "desktopComputerUse.executablePath",
          value: "relative/private-desktop-helper",
        },
      ],
      totalCount: 3,
      omittedCount: 0,
    },
    settingsCatalog: [
      {
        id: "private-catalog-id",
        title: "Private catalog title",
        route: "/settings/providers",
        searchTerms: "Private catalog search terms",
      },
    ],
    computerUse: {
      enabled: true,
      available: true,
      running: false,
      accessibilityPermission: true,
      screenRecordingPermission: false,
    },
  },
};

describe("Help report preparation", () => {
  it("includes reproducible behavior and useful app metadata while excluding host identity and conversation by default", () => {
    const report = buildHelpReport(reportInput);
    expect(report).toContain("Provider stops replying");
    expect(report).toContain("0.3.8-nightly.20261021.94");
    expect(report).toContain("codex: ready");
    expect(report).toContain("3 failures");
    expect(report).toContain("Incomplete sample");
    for (const excluded of [
      "Private support question",
      "Private research host",
      "private-environment-id",
      "private-person",
      "private-account",
      "Personal provider name",
      "Private model label",
      "private-operation",
      "private-cause",
    ]) {
      expect(report).not.toContain(excluded);
    }
  });

  it("only attaches the Help conversation after opt-in and removes common credentials, local paths and email addresses", () => {
    const report = buildHelpReport({
      ...reportInput,
      includeConversation: true,
      conversation: [
        {
          role: "user",
          content:
            "Check /Users/researcher/project/private.txt and C:\\Users\\researcher\\secret.txt for person@example.edu; token=private-token-value",
        },
      ],
    });
    expect(report).toContain("Help conversation (included by choice)");
    expect(report).toContain("[local path]");
    expect(report).toContain("[email removed]");
    expect(report).not.toContain("researcher");
    expect(report).not.toContain("person@example.edu");
    expect(report).not.toContain("private-token-value");
  });

  it("keeps host knowledge, plugins and client settings out of the default report", () => {
    expect(buildHelpReport({ ...reportInput, context: expandedContext })).toBe(
      buildHelpReport(reportInput),
    );
  });

  it("redacts exact host and client paths from optional snapshots, including serialized profiles", () => {
    const privatePaths = [
      "/unusual-host/private worktrees",
      "/older-host/private worktrees",
      "relative/private-worktrees",
      "/client-volume/private projects",
      "\\\\private-server\\private share\\profile",
      "Z:\\odd client root\\private profile",
      "~/private browser profile",
      "%APPDATA%\\Private Profile",
      "file:///client-volume/encoded%20profile",
      "relative/private-desktop-helper",
      "/plugin-volume/private plugin",
      "/manual-volume/private.md",
    ];
    const report = buildHelpReport({
      ...reportInput,
      context: expandedContext,
      actual: privatePaths.join("; "),
      includeConversation: true,
      conversation: [{ role: "assistant", content: privatePaths.join("\n") }],
    });
    for (const path of privatePaths) expect(report).not.toContain(path);
    expect(report).toContain("[local path]");
    expect(report).toContain("Help conversation (included by choice)");
  });

  it("does not expose pasted raw snapshot configuration or known setting credentials after opt-in", () => {
    const profiles = expandedContext.client!.settings.entries[1]!.value;
    const report = buildHelpReport({
      ...reportInput,
      context: expandedContext,
      includeConversation: true,
      conversation: [
        {
          role: "assistant",
          content: `Profiles: ${profiles}\nThe credential was opaque-setting-credential and opaque-management-key.`,
        },
      ],
    });
    expect(report).not.toContain("private-profile");
    expect(report).not.toContain("private-server");
    expect(report).not.toContain("opaque-setting-credential");
    expect(report).not.toContain("opaque-management-key");
    expect(report).toContain("[redacted]");
  });

  it("preserves useful settings routes and safe guidance with optional context present", () => {
    const content =
      "Open /settings/providers or /settings/plugins. Read docs/user/help.md. The theme is dark.";
    const report = buildHelpReport({
      ...reportInput,
      context: expandedContext,
      includeConversation: true,
      conversation: [{ role: "assistant", content }],
    });
    expect(report).toContain(content);
    expect(report).not.toContain("Private catalog");
    expect(report).not.toContain("accessibilityPermission");
  });

  it("redacts credentials in manually entered report fields as well as attachments", () => {
    const report = buildHelpReport({
      ...reportInput,
      actual: 'The command used api_key="sensitive-value" and Bearer abc.def.ghi',
    });
    expect(report).not.toContain("sensitive-value");
    expect(report).not.toContain("abc.def.ghi");
    expect(report).toContain("[redacted]");
  });

  it("removes complete quoted paths containing spaces before preparing public feedback", () => {
    const report = buildHelpReport({
      ...reportInput,
      actual:
        'Open "/Users/alice/Confidential Project/customer-list.csv" or "C:\\Users\\alice\\Confidential Project\\customer-list.csv".',
    });
    expect(report).toContain('"[local path]"');
    expect(report).not.toContain("Confidential");
    expect(report).not.toContain("customer-list");
    expect(report).not.toContain("alice");
  });

  it("prepares a report with no server or model available without claiming diagnostics succeeded", () => {
    const report = buildHelpReport({ ...reportInput, context: null });
    expect(report).toContain("App context unavailable");
    expect(report).toContain("Provider stops replying");
    expect(report).not.toContain("0 failures");
  });

  it("removes Linux host paths and exact snapshot paths under arbitrary roots", () => {
    const report = buildHelpReport({
      ...reportInput,
      context: { ...context, paths: [{ label: "State", path: "/custom-mount/private app/state" }] },
      actual:
        'Open /root/.t3/userdata/settings.json or "/srv/private project/customer.csv"; state is /custom-mount/private app/state.',
      includeConversation: true,
      conversation: [{ role: "user", content: "Check /srv/private-project/customer.csv" }],
    });
    expect(report).toContain("[local path]");
    for (const excluded of ["/root", "/srv", "/custom-mount", "private app", "customer.csv"]) {
      expect(report).not.toContain(excluded);
    }
  });

  it("removes pasted cookie headers from fields and the optional conversation", () => {
    const report = buildHelpReport({
      ...reportInput,
      actual: "Cookie: session=opaque-cookie-secret; auth=another-cookie",
      includeConversation: true,
      conversation: [
        { role: "user", content: "Set-Cookie: session=conversation-secret; HttpOnly" },
      ],
    });
    for (const secret of ["opaque-cookie-secret", "another-cookie", "conversation-secret"]) {
      expect(report).not.toContain(secret);
    }
    expect(report).toContain("[redacted]");
  });

  it("bounds large pasted content and only includes the most recent conversation messages", () => {
    const report = buildHelpReport({
      ...reportInput,
      summary: "x".repeat(80_000),
      includeConversation: true,
      conversation: Array.from({ length: 40 }, (_, index) => ({
        role: "user" as const,
        content: `message-${index}: ${"z".repeat(8_000)}`,
      })),
    });
    expect(report.length).toBeLessThan(25_000);
    expect(report).not.toContain("message-0:");
    expect(report).not.toContain("message-20:");
    expect(report).toContain("message-39:");
  });

  it("keeps the latest failure and chronological order when the conversation exceeds its budget", () => {
    const report = buildHelpReport({
      ...reportInput,
      includeConversation: true,
      conversation: [
        ...Array.from({ length: 6 }, (_, index) => ({
          role: "user" as const,
          content: `earlier-${index}: ${"x".repeat(4_000)}`,
        })),
        { role: "user", content: "latest failure: provider stopped replying" },
      ],
    });
    expect(report).toContain("latest failure: provider stopped replying");
    expect(report).not.toContain("earlier-0:");
    expect(report.indexOf("earlier-5:")).toBeLessThan(report.indexOf("latest failure:"));
  });
});

describe("Help credential redaction", () => {
  it.each([
    ['password="correct horse battery"', "correct horse battery"],
    ["Cookie: session=opaque-cookie-secret; auth=another-cookie", "opaque-cookie-secret"],
    ['{"Cookie":"session=json-cookie-secret; auth=another"}', "json-cookie-secret"],
    ["Set-Cookie: session=server-cookie-secret; HttpOnly", "server-cookie-secret"],
    [
      'Authorization: Digest username="private-user", response="private-response"',
      "private-response",
    ],
    ["https://example.test/report?sig=private-url-signature&view=help", "private-url-signature"],
    ["GEMINI_API_KEY=AIzaSyntheticCredential123456789", "AIzaSyntheticCredential123456789"],
    ["AWS_SECRET_ACCESS_KEY=syntheticSecret123456789", "syntheticSecret123456789"],
    ["AWS_SESSION_TOKEN=syntheticSession123456789", "syntheticSession123456789"],
    ['export OPENAI_API_KEY="syntheticOpenAI123456789"', "syntheticOpenAI123456789"],
    ['{"client_secret":"client-value"}', "client-value"],
    ['{"managementKey":"management-value"}', "management-value"],
    ["https://example.test/?access_token=secret-value&view=help", "secret-value"],
    ["https://example.test/?refreshToken=refresh-value&view=help", "refresh-value"],
    ["wss://example.test/?pairingToken=pairing-value", "pairing-value"],
    ["https://example.test/#id_token=fragment-value", "fragment-value"],
    ["https://example.test/?X-Amz-Credential=signed-url-value", "signed-url-value"],
    ["wss://username:private-password@example.test/help", "private-password"],
    ["https://username:private-password@example.test/help", "private-password"],
    ["sk-proj-abcdefghijklmno0123456789", "abcdefghijklmno0123456789"],
    ["github_pat_abcdefghijklmno0123456789", "abcdefghijklmno0123456789"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature_value", "signature_value"],
    [
      "-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----",
      "private-key-body",
    ],
    ["-----BEGIN PRIVATE KEY-----\nincomplete-private-key-body", "incomplete-private-key-body"],
  ])("removes a credential from %s", (input, secret) => {
    expect(redactHelpText(input)).not.toContain(secret);
    expect(redactHelpText(input)).toMatch(/redacted|removed/u);
  });

  it("preserves useful settings guidance and exact application paths for private troubleshooting", () => {
    const text =
      "Open /settings/providers. Settings live at /Users/example/.t3/userdata/settings.json.";
    expect(redactHelpText(text)).toBe(text);
  });
});
