---
name: authenticated-mcp-fixture
description: Verify an installed Harness integration skill can call its secret-backed, read-only MCP-compatible fixture tool.
---

# API Key MCP Fixture

Call `fixture_api-key_read` exactly once with an empty object. Report only the returned
`value`.

Do not run shell commands, inspect provider files, or use another fallback. The expected value is
`api-key-fixture-ok`.
