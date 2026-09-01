# Open-source computer-use options for TritonAI Harness

Research date: 2026-08-14

## Decision

Use **[Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver)** from `trycua/cua` as the computer-use runtime for Citizen Developer. It is the best fit for this product—not merely the strongest GUI-agent demo—because it is a model-independent device layer with a native Electron embedding contract, stdio MCP, screen capture plus accessibility state, mouse/keyboard actions, a separate visible agent cursor, macOS and Windows releases, and an MIT license that expressly permits redistribution.

Use **[Peekaboo](https://github.com/openclaw/Peekaboo)** as the runner-up only if Citizen becomes macOS-only. Peekaboo has an excellent native macOS automation surface and MCP integration, but its released product requires macOS 15+ and its Windows/Linux ports are separate community projects rather than the same supported runtime.

This is an architecture recommendation based on primary-source review, not yet product proof. The release gate should be a signed Citizen build that completes the same smoke workflow on supported macOS and Windows versions.

## Why Cua Driver is the match

- The repository is [MIT licensed](https://github.com/trycua/cua/blob/main/LICENSE.md), including permission to use, modify, publish, distribute, sublicense, and sell copies, subject to retaining the notice. The repository warns that third-party components retain their own licenses, so the shipped driver subset still needs an SBOM and dependency-license audit.
- The driver exposes `cua-driver mcp` over stdio and also provides TypeScript and Python application SDKs. Its documented action surface includes app/window discovery, accessibility trees, screenshots, clicks, double/right click, typing, key chords, scrolling, dragging, values, app launch, verification, and browser-specific actions. [Driver integration documentation](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md)
- The project explicitly documents the exact Electron architecture Citizen needs: use `@trycua/cua-driver`, put the native executable outside ASAR, sign the nested executable before signing/notarizing the enclosing app, have the Electron main process own Accessibility and Screen Recording onboarding, and spawn the embedded daemon directly. It returns both SDK and MCP connection details. [Electron embedding guide](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md#node-and-electron-daemon-hosts)
- Embedded mode gives the host one macOS permission identity while retaining background capture/input and the visible agent-cursor overlay. The reference flow explicitly demonstrates a cursor glide without moving the user's physical pointer. [Embedding behavior and reference test](https://github.com/trycua/cua/blob/main/libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md#what-embedded-mode-changes-and-what-it-doesnt)
- The current driver release reviewed was [`cua-driver-rs-v0.19.3`](https://github.com/trycua/cua/releases/tag/cua-driver-rs-v0.19.3), published with universal/architecture-specific macOS, Windows x86_64/ARM64, and Linux preview artifacts plus SHA-256 checksums. The release describes ordinary SemVer releases as stable even though GitHub labels them pre-releases to avoid conflicts in the monorepo.
- Independent first-party adoption is unusually strong evidence of fit: current Open Interpreter says its native-app QA capability uses `trycua`; Hermes's computer-use backend invokes `cua-driver mcp`. [Open Interpreter README](https://github.com/openinterpreter/openinterpreter#computer-use), [Hermes backend](https://github.com/NousResearch/hermes-agent/blob/main/tools/computer_use/cua_backend.py)

### Important caveats

- Cua Driver is young and rapidly changing. Pin an exact version/commit; never install `latest` directly into production clients.
- Its macOS background-input path uses private SkyLight interfaces, which Hermes correctly notes can break across macOS updates. Foreground fallbacks and an OS-version test matrix are mandatory. [Hermes integration note](https://github.com/NousResearch/hermes-agent/blob/main/tools/computer_use/cua_backend.py)
- “Background” is capability-specific. The driver's own [action support matrix](https://github.com/trycua/cua/blob/main/libs/cua-driver/docs/action-support.md) records some input/app combinations as unavailable or occluded; the host must surface these structured refusals and, with user approval, retry in foreground.
- The upstream installer documents usage telemetry as enabled by default. Disable it in the institutional build unless UCSD explicitly approves the disclosure and data flow. [Cua Driver installation and telemetry controls](https://cua.ai/docs/how-to-guides/driver/install)
- Use `standard` for interactive operation and `bounded` for specifically approved unattended flows. Do not ship `unrestricted` as the default. [Permission modes](https://github.com/trycua/cua/blob/main/libs/cua-driver/README.md#permission-modes)
- MIT permission is not the end of the release review. Preserve notices, inventory transitive crates/npm/native libraries, produce an SBOM, vulnerability-scan the pinned artifact, and have UCSD review accessibility/screen-recording disclosure and data handling.

## Candidate comparison

| Project                          | License and platforms                                                                             | What it actually is                                                                                                                                                            | Decision for Citizen                                                                                                                                                                                                                                                                                                                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Cua Driver (`trycua/cua`)**    | [MIT](https://github.com/trycua/cua/blob/main/LICENSE.md); macOS, Windows, Linux                  | Model-neutral native automation driver; MCP, CLI, TypeScript/Python SDK, Electron host, accessibility + screenshots + input + visible cursor                                   | **Winner.** It replaces only the missing device layer and leaves Codex/TritonAI as the agent.                                                                                                                                                                                                                                              |
| **Peekaboo**                     | [MIT; released CLI/app requires macOS 15+](https://github.com/openclaw/Peekaboo#install)          | High-quality macOS capture/accessibility/automation CLI, app, agent, and MCP server; signed DMG and rich app/window/menu/dialog controls                                       | **Runner-up.** Excellent Mac option, but not one cross-platform runtime.                                                                                                                                                                                                                                                                   |
| **UI-TARS Desktop**              | [Apache-2.0; Windows/macOS/browser](https://github.com/bytedance/UI-TARS-desktop#ui-tars-desktop) | Full Electron GUI-agent application and SDK built around UI-TARS/Seed vision-language models; screenshot plus mouse/keyboard control                                           | Strong complete agent, but duplicates Citizen's agent/UI/model loop. Integration is heavier than adding an MCP driver.                                                                                                                                                                                                                     |
| **Agent-S**                      | [Apache-2.0; Linux/macOS/Windows](https://github.com/simular-ai/Agent-S#installation--setup)      | Python GUI-agent framework. Current recommended setup uses a main reasoning model plus a required separate grounding model such as UI-TARS-1.5-7B and targets a single monitor | Strong research agent, poor drop-in runtime: extra model serving, Python/Tesseract packaging, and a second planner around Codex.                                                                                                                                                                                                           |
| **OpenCUA (`xlang-ai/OpenCUA`)** | [MIT](https://github.com/xlang-ai/OpenCUA#license)                                                | Models (7B/32B/72B), training/data tooling, recorder, and benchmark/evaluation infrastructure                                                                                  | Not the needed local production driver. Useful later for model/grounding research, not mouse/screen plumbing in Electron.                                                                                                                                                                                                                  |
| **Open Interpreter**             | [Apache-2.0; macOS/Linux/Windows](https://github.com/openinterpreter/openinterpreter)             | A complete Codex-derived coding-agent runtime with MCP/ACP/Codex protocols                                                                                                     | Replacing Citizen's Codex runtime would be a much larger product change, and its native computer use already points to `trycua`. Use the dependency directly.                                                                                                                                                                              |
| **OpenClaw**                     | [MIT](https://github.com/openclaw/openclaw#license)                                               | Full personal-assistant gateway and channel ecosystem                                                                                                                          | Not a computer-use driver. Its documented Codex Computer Use path locates the proprietary OpenAI plugin inside installed ChatGPT/Codex bundles, so that route does not solve distribution. [OpenClaw Codex Computer Use docs](https://github.com/openclaw/openclaw/blob/main/docs/plugins/codex-computer-use.md#bundled-macos-marketplace) |
| **Hermes Agent**                 | [MIT](https://github.com/NousResearch/hermes-agent#license)                                       | Full general assistant, gateway, desktop UI, skills, memory, and providers                                                                                                     | Not worth embedding as a second agent. Its computer-use implementation invokes Cua Driver, reinforcing the direct choice.                                                                                                                                                                                                                  |

## Recommended Citizen implementation

### 1. Prove the driver without touching normal Codex state

- Pin Cua Driver `0.19.3` (or the exact reviewed successor) in a TritonAI dependency manifest.
- Place the PoC binary under TritonAI-owned application support, not `~/.codex`, and register `cua-driver mcp` only in `~/.tritonai-harness/codex`.
- Install the upstream Cua Driver skill into Citizen's isolated skill scope so the model consistently follows observe → act → verify rather than guessing tool semantics.
- Test: list apps/windows; capture screen and accessibility state; visible cursor move; semantic and coordinate click; type; key chord; scroll; drag; secondary click; permission denial; cancellation; host shutdown cleanup.

### 2. Productize the Electron embedding

- Add `@trycua/cua-driver` to the Electron main process and use `EmbeddedCuaDriverHost`; do not launch it from a renderer or a detached gateway.
- Bundle the native executable in `Contents/Resources` outside ASAR on macOS and the equivalent unpacked resource directory on Windows. Sign the nested binary with UCSD/TritonAI's identity before the enclosing app is signed and notarized.
- Have Citizen—not a second helper app—request macOS Accessibility and Screen Recording. Restart the embedded child after grants change, then require `check_permissions` to report host attribution and prove capture with a real screenshot.
- Feed the returned MCP endpoint to Citizen's Codex app-server. `CODEX_HOME` remains `~/.tritonai-harness/codex`; Cua does not require or read the user's normal `~/.codex`.
- Expose a visible Computer Use status, persistent stop control, current app/window target, permission health, action results, and foreground-escalation approval. Keep `standard` mode by default.

### 3. Own updates safely

Do not let every installed client follow GitHub `latest`. Use this reviewed release lane:

1. A scheduled CI job detects a newer `cua-driver-rs-v*` release but does not publish it.
2. It verifies the tag/commit, release checksum, license/notice changes, transitive dependency licenses, SBOM, vulnerabilities, and MCP tool-schema diff.
3. It builds or stages the exact pinned artifacts, signs them as nested Citizen resources, and opens a dependency-update PR.
4. CI runs macOS and Windows contract/smoke tests plus packaged-app permission, cursor, interaction, cancellation, and rollback tests.
5. A reviewed TritonAI release promotes the pair. Keep the previous signed version for rollback.

This produces the “everyone gets it” outcome legally under MIT without depending on a separately installed Codex/ChatGPT app.

## Exact path for OpenAI redistribution/OEM permission

OpenAI's published [Service Terms, section 10](https://openai.com/policies/service-terms/#10-licensed-materials) say downloaded Licensed Materials may not be modified, redistributed, or sublicensed unless another agreement grants that right. OpenAI does not publish a Computer Use OEM application or OEM email. Its [official sales guidance](https://help.openai.com/en/articles/9047878-how-can-i-contact-sales) says the sales contact form is the only supported sales channel and there is no public sales phone line or direct email.

Therefore:

1. Submit the request at **[openai.com/contact-sales](https://openai.com/contact-sales/)** from a UCSD work address. Choose the closest current ChatGPT Enterprise/Codex option and begin the free-text field with “OEM/redistribution licensing request—not a normal seat purchase.”
2. Include legal entity (`The Regents of the University of California, on behalf of UC San Diego`), product and owner (`TritonAI Citizen Developer`), countries, internal/external distribution, estimated seats/devices, platforms, launch date, expected OpenAI/API usage, and existing OpenAI organization/contract identifiers.
3. Ask Sales to route it to the product owner and legal/partnerships team for **written redistribution and embedding rights** to the native Computer Use helper and the `computer-use@openai-bundled` plugin.
4. Require a signed agreement/order-form amendment that answers the checklist below. A verbal statement, support response, working download URL, or artifact signature is not permission.
5. Do not copy or ship OpenAI's artifacts until the agreement is effective and an authorized artifact/update channel is provided.

### Copy/paste request

> Subject: OEM/redistribution request for OpenAI Computer Use in UC San Diego TritonAI
>
> UC San Diego is developing TritonAI Citizen Developer, an Electron desktop application that hosts the Codex CLI/app-server under an isolated application home. Our users will not have ChatGPT or Codex desktop installed. We are requesting a commercial/OEM agreement that expressly authorizes The Regents of the University of California, on behalf of UC San Diego, to reproduce, embed, install, and redistribute the unmodified OpenAI Computer Use native helper and `computer-use` Codex plugin as part of signed TritonAI installers for [macOS/Windows], to approximately [seat/device count] authorized [internal/external] users in [countries], beginning [target date].
>
> Please route this request to the Computer Use product owner and the legal/partnerships team. We need the agreement to cover sublicensing to authorized end users, users who do not separately install ChatGPT/Codex, permitted OpenAI account/seat and API requirements, an authenticated production artifact and update channel, helper/plugin compatibility versions, signing/notarization and checksum verification, security advisories and end-of-life notice, rollback rights, trademark/attribution requirements, telemetry and data-processing terms, support responsibilities, and termination/removal obligations. We will preserve OpenAI signatures, distribute only approved versions, and will not begin redistribution until written rights are effective.
>
> Organization: The Regents of the University of California / UC San Diego
>
> Product: TritonAI Citizen Developer
>
> Technical owner: [name, title, work email]
>
> Procurement/legal contact: [name, work email]
>
> Existing OpenAI organization/contract: [identifier or none]
> Expected seats/devices and launch timeline: [values]

### Terms the agreement must answer

- Exact artifacts, platforms, versions, and whether modification/white-labeling is allowed.
- Right to reproduce, bundle, distribute, update, and provide the artifacts to users without separate ChatGPT/Codex installation.
- Which OpenAI subscription/account/API entitlement every end user or organization must hold.
- Authorized source/feed, authentication, checksums/signatures, cadence, notice, security response, EOL, pinning, and rollback.
- Distribution territory, audience, device/seat limits, contractors, affiliates, and external customers if any.
- Branding/trademark and license-notice requirements.
- Telemetry, screen/action data flows, retention, DPA/security documentation, accessibility, and support/escalation ownership.
- Fees, term, audit rights, termination, and removal of installed copies.

## Bottom line

Pursue OpenAI OEM permission if exact OpenAI/T3 parity remains strategically important, but do not block delivery on it. Cua Driver is the strongest open-source runtime for Citizen's existing Electron + Codex architecture and can legally be bundled after ordinary MIT/dependency compliance. Peekaboo is the only close runner-up for a Mac-only product.
