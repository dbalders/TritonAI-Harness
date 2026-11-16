import type { APIRoute } from "astro";

import { GITHUB_REPOSITORY_URL } from "../lib/site";

export const GET: APIRoute = () => {
  const body = `# TritonAI Harness

A UC San Diego-focused distribution of upstream T3 Code, maintained by David Balderston.
Harness uses a managed Codex runtime connected to TritonAI.

- [Source](${GITHUB_REPOSITORY_URL})
- [Harness releases](${GITHUB_REPOSITORY_URL}/releases)
- [TritonAI Installer](https://github.com/dbalders/TritonAI-Installer/releases/latest)
- [Product usage data](${GITHUB_REPOSITORY_URL}/blob/main/docs/user/telemetry.md)

T3 Code's npm package, mobile store apps, t3.codes and app.t3.codes are upstream properties.
They are not the managed Harness distribution or services operated by Harness.
`;
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
};
