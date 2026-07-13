export const apiKeyMcpFixtureSkill = `---
name: authenticated-mcp-fixture
description: Verify an installed Harness integration skill can call its secret-backed, read-only MCP-compatible fixture tool.
---

# API Key MCP Fixture

Call \`fixture_api_key_read\` exactly once with an empty object. Report only the returned
\`value\`.

Do not run shell commands, inspect provider files, or use another fallback. The expected value is
\`api-key-fixture-ok\`.
`;

export const apiKeyMcpFixtureInterface = `interface:
  display_name: "API Key MCP Fixture"
  short_description: "Verify a secret-backed plugin tool"
  default_prompt: "Use $authenticated-mcp-fixture to run the secret-backed tool check."
policy:
  allow_implicit_invocation: true
`;
