# TritonAI Commons

TritonAI Commons is the public skill library in **Settings → Skills**. AI Team and Community skills come from Commons; skills you create or add locally stay under **Your Skills** until you decide to publish them.

## Submit a local skill

1. Create, install, and use the skill locally in Harness.
2. Find it under **Your Skills**.
3. Select **Share with UCSD**.
4. Read and accept the public-share confirmation. It identifies the exact local folder and explains that its supported, non-hidden text files will become public.
5. After Harness finishes, choose whether to open the pull request immediately. The skill remains marked **Shared with UCSD** in Harness, with a **Review PR** button for returning to the contribution later.

You can also ask in chat to “submit `<skill-name>` to UCSD.” Harness exposes a dedicated, approval-gated action for this request. The action resolves one exact installed skill in the active Codex provider and uses the same validation and submission service as the Settings button. Successful chat submissions receive the same durable **Shared with UCSD** marker in Settings. If more than one skill has that name, use the Settings button beside the intended row.

Harness reads the existing local skill folder; it does not generate or replace the skill. Supporting text files under folders such as `references/` and `scripts/` are included. If `SKILL.md` has no maintainer, Harness adds the signed-in GitHub user as maintainer in the submitted copy. If the folder has no license, Harness adds the current Commons MIT license to the submitted copy. A conflicting local license must be resolved before submission. None of these public-copy adjustments change local files.

Submission requires the GitHub integration to be installed, connected, and allowed to read and write repositories and create pull requests. The button authorizes Harness to validate the public copy, create or verify your fork, create a contribution branch, add the skill under `community/<skill-name>/`, and open a ready-for-review pull request.

If GitHub is missing or lacks required authorization, Harness can install or enable the bundled plugin and directs you to **Settings → Plugins → GitHub**. Connect your contributor account and enable identity read, repository read/write, and pull-request creation. Then return to **Settings → Skills** and select **Share with UCSD** again. Harness revalidates the current local files and safely recovers through a clean content-addressed retry branch or an existing verified pull request rather than overwriting remote content.

Harness never exposes GitHub tokens, overwrites an existing Commons skill, or merges the pull request. AI Team and already-published Community skills cannot be submitted again. Campus approval, when appropriate, is a later maintainer decision rather than a contributor-selected scope.

Only submit material that is safe to publish. Do not include secrets, private data, internal infrastructure details, restricted runbooks, or files you do not have permission to share.
