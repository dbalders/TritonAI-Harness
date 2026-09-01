import { describe, expect, it } from "@effect/vitest";
import type { ServerProviderSkillBundle } from "@t3tools/contracts";

import {
  isProtectedLocalSkillPathForCommons,
  prepareTritonAiCommonsSubmission,
  submitProviderSkillToTritonAiCommons,
  type CommonsIntegrationRegistry,
} from "./tritonAiCommons.ts";

const GITHUB_MISSING = "GitHub could not find that item, or the signed-in user cannot access it.";
const TEST_LICENSE =
  "MIT License\n\nCopyright (c) 2026 The Regents of the University of California\n";
const BASE_SHA = "a".repeat(40);
const TOOL_NAMES = [
  "github.identity.get",
  "github.repositories.get",
  "github.repositories.fork",
  "github.branches.create",
  "github.contents.get",
  "github.contents.put",
  "github.pulls.list",
  "github.pulls.get",
  "github.pulls.create",
  "github.commits.status.get",
];

interface Invocation {
  readonly name: string;
  readonly input: unknown;
  readonly writeApproved: boolean;
  readonly hasSignal: boolean;
}

function localSkill(markdown?: string): ServerProviderSkillBundle {
  return {
    version: 1,
    skillId: "local-accessibility-review",
    files: [
      {
        path: "SKILL.md",
        content:
          markdown ??
          `---\nname: local-accessibility-review\ndescription: Review a public webpage for accessibility issues.\nallowed-tools: Read, Bash\n---\n\n# Accessibility Review\n\nReview the page and report prioritized remediation steps.\n`,
      },
      {
        path: "references/checklist.md",
        content: "# Checklist\n\n- Keyboard access\n- Names and labels\n",
      },
    ],
  };
}

function registryFixture(options?: {
  readonly login?: string;
  readonly availableTools?: ReadonlyArray<string>;
  readonly existingPaths?: ReadonlySet<string>;
  readonly forkExists?: boolean;
  readonly wrongFork?: boolean;
  readonly closePullAfterCreation?: boolean;
  readonly branchExistsWithoutPull?: boolean;
  readonly pullChangedFilesDelta?: number;
  readonly staleFork?: boolean;
}) {
  const calls: Invocation[] = [];
  const login = options?.login ?? "contributor";
  const availableTools = options?.availableTools ?? TOOL_NAMES;
  let forkCreated = false;
  let branchCreated = options?.branchExistsWithoutPull === true;
  let pullCreated = false;
  const branchFiles = new Map<string, string>();
  const registry: CommonsIntegrationRegistry = {
    getAvailableToolDefinitionsSync: () => availableTools.map((name) => ({ name })),
    invokeTool: async (name, input, context) => {
      calls.push({
        name,
        input,
        writeApproved: context.writeApproved === true,
        hasSignal: context.signal instanceof AbortSignal,
      });
      if (name === "github.identity.get") return { login, id: 1 };
      if (name === "github.repositories.get") {
        const owner = (input as { owner: string }).owner;
        if (owner === "dbalders") return { default_branch: "main", fork: false };
        if (options?.forkExists === false && !forkCreated) throw new Error(GITHUB_MISSING);
        return {
          default_branch: "main",
          fork: true,
          parent: {
            full_name: options?.wrongFork
              ? "someone-else/UCSD-Skills-Library"
              : "dbalders/UCSD-Skills-Library",
          },
        };
      }
      if (name === "github.commits.status.get") {
        const { owner, ref } = input as { owner: string; ref: string };
        if (ref === "main") {
          return {
            sha: options?.staleFork === true && owner !== "dbalders" ? "c".repeat(40) : BASE_SHA,
          };
        }
        if (ref.startsWith("tritonai-commons/") && branchCreated) {
          return { sha: branchFiles.size === 0 ? BASE_SHA : "b".repeat(40) };
        }
        throw new Error(GITHUB_MISSING);
      }
      if (name === "github.contents.get") {
        const { path, ref } = input as { path: string; ref: string };
        if (path === "LICENSE" && ref === BASE_SHA) {
          return {
            type: "file",
            encoding: "base64",
            content: Buffer.from(TEST_LICENSE).toString("base64"),
          };
        }
        if (options?.existingPaths?.has(path)) return { type: "file", sha: "a".repeat(40) };
        if (path === "README.md" && branchCreated && ref.startsWith("tritonai-commons/")) {
          return {
            type: "file",
            encoding: "base64",
            content: Buffer.from("# Commons\n").toString("base64"),
          };
        }
        const content = branchFiles.get(`${ref}:${path}`);
        if (content !== undefined) {
          return {
            type: "file",
            encoding: "base64",
            content: Buffer.from(content).toString("base64"),
          };
        }
        throw new Error(GITHUB_MISSING);
      }
      if (name === "github.repositories.fork") {
        forkCreated = true;
        return { id: 2 };
      }
      if (name === "github.branches.create") {
        branchCreated = true;
        return { ref: "created" };
      }
      if (name === "github.contents.put") {
        const values = input as { branch: string; path: string; content: string };
        branchFiles.set(`${values.branch}:${values.path}`, values.content);
        return { content: { sha: "b".repeat(40) } };
      }
      if (name === "github.pulls.list") {
        return pullCreated
          ? [
              {
                number: 42,
                html_url: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
                draft: false,
                state: options?.closePullAfterCreation ? "closed" : "open",
              },
            ]
          : [];
      }
      if (name === "github.pulls.get") {
        return {
          number: 42,
          html_url: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
          draft: false,
          changed_files: branchFiles.size + (options?.pullChangedFilesDelta ?? 0),
          base: { sha: BASE_SHA },
        };
      }
      if (name === "github.pulls.create") {
        pullCreated = true;
        return { html_url: "https://github.com/dbalders/UCSD-Skills-Library/pull/42" };
      }
      return {};
    },
  };
  return { calls, registry };
}

describe("TritonAI Commons local skill submission", () => {
  it("preserves the existing skill while adding required public metadata", () => {
    const prepared = prepareTritonAiCommonsSubmission({
      bundle: localSkill(),
      githubLogin: "contributor",
      repositoryLicense: TEST_LICENSE,
    });

    expect(prepared.bundle.skillId).toBe("local-accessibility-review");
    expect(prepared.bundle.files).toHaveLength(3);
    expect(prepared.bundle.files.find(({ path }) => path === "SKILL.md")?.content).toContain(
      'maintainer: "@contributor"',
    );
    expect(prepared.bundle.files.find(({ path }) => path === "SKILL.md")?.content).toContain(
      "allowed-tools: Read, Bash",
    );
    expect(
      prepared.bundle.files.find(({ path }) => path === "references/checklist.md")?.content,
    ).toContain("Keyboard access");
    expect(prepared.bundle.files.find(({ path }) => path === "LICENSE")?.content).toBe(
      TEST_LICENSE,
    );
  });

  it("rejects unsupported frontmatter instead of opening a review the validator will reject", () => {
    expect(() =>
      prepareTritonAiCommonsSubmission({
        bundle: localSkill(
          `---\nname: local-accessibility-review\ndescription: Review a public webpage.\ncustom-field: value\n---\n\n# Review\n`,
        ),
        githubLogin: "contributor",
        repositoryLicense: TEST_LICENSE,
      }),
    ).toThrow("not supported by TritonAI Commons");
  });

  it("recognizes protected plugin skill paths case-insensitively on every platform", () => {
    expect(
      isProtectedLocalSkillPathForCommons(
        "C:\\Users\\Contributor\\.CODEX\\plugins\\example\\skills\\demo\\SKILL.md",
      ),
    ).toBe(true);
    expect(
      isProtectedLocalSkillPathForCommons(
        "C:\\Users\\Contributor\\.AGENTS\\PLUGINS\\example\\skills\\demo\\SKILL.md",
      ),
    ).toBe(true);
    expect(
      isProtectedLocalSkillPathForCommons("C:\\Users\\Contributor\\skills\\demo\\SKILL.md"),
    ).toBe(false);
  });

  it("preserves an explicit maintainer from the local skill", () => {
    const prepared = prepareTritonAiCommonsSubmission({
      bundle: localSkill(
        `---\nname: local-accessibility-review\ndescription: Review a public webpage for accessibility issues.\nmaintainer: Accessibility Team\n---\n\n# Review\n\nReview the webpage.\n`,
      ),
      githubLogin: "contributor",
      repositoryLicense: TEST_LICENSE,
    });

    expect(prepared.maintainer).toBe("Accessibility Team");
    expect(
      prepared.bundle.files.find(({ path }) => path === "SKILL.md")?.content.match(/maintainer:/gu),
    ).toHaveLength(1);
  });

  it("rejects unsafe local content before any repository write", () => {
    expect(() =>
      prepareTritonAiCommonsSubmission({
        bundle: {
          ...localSkill(),
          files: [
            ...localSkill().files,
            { path: "references/private.md", content: `api_key=${"s".repeat(24)}` },
          ],
        },
        githubLogin: "contributor",
        repositoryLicense: TEST_LICENSE,
      }),
    ).toThrow("hardcoded credential");
    expect(() =>
      prepareTritonAiCommonsSubmission({
        bundle: {
          ...localSkill(),
          files: [
            ...localSkill().files,
            {
              path: "references/multiple.md",
              content: `api_key=REPLACE_ME_WITH_TOKEN\npassword=${"s".repeat(24)}`,
            },
          ],
        },
        githubLogin: "contributor",
        repositoryLicense: TEST_LICENSE,
      }),
    ).toThrow("hardcoded credential");
    expect(() =>
      prepareTritonAiCommonsSubmission({
        bundle: { ...localSkill(), skillId: "Not Public Safe" },
        githubLogin: "contributor",
        repositoryLicense: TEST_LICENSE,
      }),
    ).toThrow("lowercase");
    expect(() =>
      prepareTritonAiCommonsSubmission({
        bundle: {
          ...localSkill(),
          files: [...localSkill().files, { path: "references/credentials.json", content: "{}" }],
        },
        githubLogin: "contributor",
        repositoryLicense: TEST_LICENSE,
      }),
    ).toThrow("sensitive file type");
    expect(() =>
      prepareTritonAiCommonsSubmission({
        bundle: {
          ...localSkill(),
          files: [...localSkill().files, { path: "LICENSE", content: "Different license\n" }],
        },
        githubLogin: "contributor",
        repositoryLicense: TEST_LICENSE,
      }),
    ).toThrow("does not match");
  });

  it("submits every local skill file to Community and opens a ready pull request", async () => {
    const fixture = registryFixture();
    const result = await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: fixture.registry,
      signal: new AbortController().signal,
    });

    expect(result).toMatchObject({
      reviewUrl: "https://github.com/dbalders/UCSD-Skills-Library/pull/42",
      path: "community/local-accessibility-review/SKILL.md",
      skillName: "local-accessibility-review",
    });
    const writes = fixture.calls.filter((call) =>
      [
        "github.repositories.fork",
        "github.branches.create",
        "github.contents.put",
        "github.pulls.create",
      ].includes(call.name),
    );
    expect(writes.every((call) => call.writeApproved && call.hasSignal)).toBe(true);
    expect(
      fixture.calls
        .filter((call) => !writes.includes(call))
        .every((call) => !call.writeApproved && call.hasSignal),
    ).toBe(true);
    expect(
      fixture.calls
        .filter(({ name }) => name === "github.contents.put")
        .map(({ input }) => (input as { path: string }).path),
    ).toEqual([
      "community/local-accessibility-review/SKILL.md",
      "community/local-accessibility-review/LICENSE",
      "community/local-accessibility-review/references/checklist.md",
    ]);
    const pull = fixture.calls.find(({ name }) => name === "github.pulls.create")!;
    expect(pull.input).toMatchObject({
      owner: "dbalders",
      head: expect.stringMatching(/^contributor:tritonai-commons\//u),
      base: "main",
      draft: false,
    });
    expect((pull.input as { body: string }).body).toContain("existing local skill");
    expect((pull.input as { body: string }).body).toContain("later maintainer decision");
    expect(
      fixture.calls.find(({ name }) => name === "github.branches.create")?.input,
    ).toMatchObject({
      fromRef: BASE_SHA,
    });
  });

  it("creates a contributor fork but branches directly for the repository owner", async () => {
    const contributor = registryFixture({ forkExists: false });
    await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: contributor.registry,
      signal: new AbortController().signal,
    });
    expect(contributor.calls.some(({ name }) => name === "github.repositories.fork")).toBe(true);

    const owner = registryFixture({ login: "dbalders" });
    await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: owner.registry,
      signal: new AbortController().signal,
    });
    expect(owner.calls.some(({ name }) => name === "github.repositories.fork")).toBe(false);
    expect(owner.calls.find(({ name }) => name === "github.contents.put")?.input).toMatchObject({
      owner: "dbalders",
      path: "community/local-accessibility-review/SKILL.md",
    });
  });

  it("requires an existing contributor fork to match the exact upstream base", async () => {
    const fixture = registryFixture({ staleFork: true });

    await expect(
      submitProviderSkillToTritonAiCommons({
        bundle: localSkill(),
        registry: fixture.registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("not synchronized");
    expect(fixture.calls.some(({ name }) => name === "github.branches.create")).toBe(false);
  });

  it("reuses the content-addressed branch and existing ready pull request on retry", async () => {
    const fixture = registryFixture();
    const first = await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: fixture.registry,
      signal: new AbortController().signal,
    });
    const second = await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: fixture.registry,
      signal: new AbortController().signal,
    });

    expect(second).toEqual(first);
    expect(fixture.calls.filter(({ name }) => name === "github.branches.create")).toHaveLength(1);
    expect(fixture.calls.filter(({ name }) => name === "github.pulls.create")).toHaveLength(1);
    expect(fixture.calls.filter(({ name }) => name === "github.contents.put")).toHaveLength(3);
  });

  it("refuses an unverified pre-existing branch without a pull request", async () => {
    const fixture = registryFixture({ branchExistsWithoutPull: true });

    await expect(
      submitProviderSkillToTritonAiCommons({
        bundle: localSkill(),
        registry: fixture.registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("already exists without a verified pull request");
    expect(fixture.calls.some(({ name }) => name === "github.contents.put")).toBe(false);
  });

  it("refuses to reuse a pull request with unrelated changed files", async () => {
    const fixture = registryFixture({ pullChangedFilesDelta: 1 });
    await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: fixture.registry,
      signal: new AbortController().signal,
    });

    await expect(
      submitProviderSkillToTritonAiCommons({
        bundle: localSkill(),
        registry: fixture.registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("unexpected number of changed files");
  });

  it("does not report a previously closed pull request as a successful review", async () => {
    const fixture = registryFixture({ closePullAfterCreation: true });
    await submitProviderSkillToTritonAiCommons({
      bundle: localSkill(),
      registry: fixture.registry,
      signal: new AbortController().signal,
    });

    await expect(
      submitProviderSkillToTritonAiCommons({
        bundle: localSkill(),
        registry: fixture.registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("previously closed");
    expect(fixture.calls.filter(({ name }) => name === "github.pulls.create")).toHaveLength(1);
  });

  it("does not resubmit an AI Team or Community skill", async () => {
    for (const existingPath of [
      "community/local-accessibility-review/SKILL.md",
      "tritonai/local-accessibility-review/SKILL.md",
    ]) {
      const fixture = registryFixture({ existingPaths: new Set([existingPath]) });
      await expect(
        submitProviderSkillToTritonAiCommons({
          bundle: localSkill(),
          registry: fixture.registry,
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("already exists");
      expect(fixture.calls.some(({ name }) => name === "github.branches.create")).toBe(false);
    }
  });

  it("refuses an unrelated repository that has the expected fork name", async () => {
    const fixture = registryFixture({ wrongFork: true });
    await expect(
      submitProviderSkillToTritonAiCommons({
        bundle: localSkill(),
        registry: fixture.registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("different repository");
    expect(fixture.calls.some(({ name }) => name === "github.branches.create")).toBe(false);
  });

  it("fails actionably before GitHub calls when a capability is disabled", async () => {
    const fixture = registryFixture({
      availableTools: TOOL_NAMES.filter((name) => name !== "github.pulls.create"),
    });
    await expect(
      submitProviderSkillToTritonAiCommons({
        bundle: localSkill(),
        registry: fixture.registry,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("Settings > Plugins > GitHub");
    expect(fixture.calls).toHaveLength(0);
  });
});
