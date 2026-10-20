import type { DesktopMcpServerConfiguration } from "@t3tools/contracts";
import { encodeCodexConfigString } from "./Drivers/TritonAiCodexConfig.ts";

export function createStdioMcpServerArgs(
  serverName: string,
  configuration: DesktopMcpServerConfiguration,
): ReadonlyArray<string> {
  const environmentEntries = Object.entries(configuration.environment);
  return [
    "-c",
    `mcp_servers.${serverName}.command=${encodeCodexConfigString(configuration.command)}`,
    "-c",
    `mcp_servers.${serverName}.args=[${configuration.args.map(encodeCodexConfigString).join(",")}]`,
    ...(environmentEntries.length > 0
      ? [
          "-c",
          `mcp_servers.${serverName}.env={${environmentEntries
            .map(
              ([name, value]) =>
                `${encodeCodexConfigString(name)}=${encodeCodexConfigString(value)}`,
            )
            .join(",")}}`,
        ]
      : []),
  ];
}
