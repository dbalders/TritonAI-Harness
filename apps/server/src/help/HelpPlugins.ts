import type {
  HelpKnowledge,
  HelpPlugin,
  IntegrationsListResult,
  IntegrationSummary,
} from "@t3tools/contracts";

import { safeHelpText } from "./HelpSafety.ts";

export type HelpPluginsSnapshot = Pick<
  HelpKnowledge,
  "pluginsStatus" | "plugins" | "pluginsOmittedCount"
>;

const MAX_PLUGINS = 100;
// A single large manifest must not fill the help prompt with its entire inventory.
const MAX_DETAILS = 200;
const MAX_DESCRIPTION_CHARACTERS = 32_000;
const MAX_DESCRIPTION_LENGTH = 1_000;
const detailLimits = { capability: 100, tool: 150, skill: 100 } as const;

type Detail =
  | { kind: "capability"; value: IntegrationSummary["capabilities"][number]; score: number }
  | { kind: "tool"; value: IntegrationSummary["tools"][number]; score: number }
  | { kind: "skill"; value: IntegrationSummary["skills"][number]; score: number };

const normalize = (value: string): string =>
  safeHelpText(value, 8_000)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

function relevanceFor(
  question: string,
): (names: ReadonlyArray<string>, description: string) => number {
  const query = normalize(question);
  const words = [...new Set(query.split(" ").filter((word) => word.length > 2))].slice(0, 40);
  return (names, description) => {
    if (query.length === 0) return 0;
    const labels = names.map(normalize);
    const text = normalize(description);
    const named = labels.map((label) => label.length > 1 && ` ${query} `.includes(` ${label} `));
    return (
      (named[0] ? 400 : named.some(Boolean) ? 200 : 0) +
      words.reduce(
        (score, word) =>
          score + (labels.some((label) => label.includes(word)) ? 10 : text.includes(word) ? 1 : 0),
        0,
      )
    );
  };
}

function detailsFor(
  plugin: IntegrationSummary,
  relevance: ReturnType<typeof relevanceFor>,
): Array<Detail> {
  return [
    ...plugin.capabilities.map((value): Detail => ({
      kind: "capability",
      value,
      score: relevance([value.id, value.displayName], value.description),
    })),
    ...plugin.tools.map((value): Detail => ({
      kind: "tool",
      value,
      score: relevance([value.name, value.displayName], value.description),
    })),
    ...plugin.skills.map((value): Detail => ({
      kind: "skill",
      value,
      score: relevance([value.name], value.description),
    })),
  ];
}

/**
 * Transform only the cached result of IntegrationRegistry.snapshot(), never list()/refresh().
 * Registry availability is authoritative: selection, grants, and effective availability differ.
 * No account labels, provider messages, or arbitrary extra fields escape.
 */
export function buildHelpPluginSnapshot(
  inventory: IntegrationsListResult,
  question = "",
): HelpPluginsSnapshot {
  const relevance = relevanceFor(question);
  // Stable ordering retains registry order for ties. Search the complete inventory before capping
  // it, including tools/skills that might otherwise be hidden inside a large manifest.
  const ranked = inventory.integrations
    .map((plugin) => {
      const details = detailsFor(plugin, relevance);
      return {
        plugin,
        details,
        score: details.reduce(
          (best, detail) => Math.max(best, detail.score),
          relevance([plugin.id, plugin.name], plugin.description),
        ),
      };
    })
    .sort((a, b) => b.score - a.score);
  let remainingDetails = MAX_DETAILS;
  let remainingDescriptionCharacters = MAX_DESCRIPTION_CHARACTERS;
  const plugins = ranked.slice(0, MAX_PLUGINS).map(({ plugin, details }): HelpPlugin => {
    let detailsOmitted = false;
    const text = (value: string, limit: number): string => {
      const safe = safeHelpText(value, limit);
      if (safe !== value) detailsOmitted = true;
      return safe;
    };
    const description = (value: string): string => {
      const safe = text(value, Math.min(MAX_DESCRIPTION_LENGTH, remainingDescriptionCharacters));
      remainingDescriptionCharacters -= safe.length;
      return safe;
    };
    const capabilities: Array<HelpPlugin["capabilities"][number]> = [];
    const tools: Array<HelpPlugin["tools"][number]> = [];
    const skills: Array<HelpPlugin["skills"][number]> = [];
    // Narrow inconsistent/stale positive flags, but never infer a positive from grants alone.
    // Use the complete IDs before any display truncation or inventory omission.
    const active = plugin.installed && plugin.enabled && plugin.connectionState === "connected";
    const availableCapabilities = new Set(
      plugin.capabilities
        .filter((value) => active && value.enabled && value.granted && value.available)
        .map(({ id }) => id),
    );
    const core = {
      id: text(plugin.id, 200),
      name: text(plugin.name, 200),
      description: description(plugin.description),
      version: text(plugin.version, 100),
      installed: plugin.installed,
      enabled: plugin.enabled,
      requiresConnection: plugin.requiresConnection,
      connectionState: text(plugin.connectionState, 100),
    };
    const counts = { capability: 0, tool: 0, skill: 0 };
    for (const detail of details.sort((a, b) => b.score - a.score)) {
      if (remainingDetails === 0 || counts[detail.kind] === detailLimits[detail.kind]) {
        detailsOmitted = true;
        continue;
      }
      remainingDetails -= 1;
      counts[detail.kind] += 1;
      switch (detail.kind) {
        case "capability": {
          const value = detail.value;
          capabilities.push({
            id: text(value.id, 200),
            name: text(value.displayName, 200),
            description: description(value.description),
            access: text(value.access, 100),
            enabled: value.enabled,
            granted: value.granted,
            available: availableCapabilities.has(value.id),
          });
          break;
        }
        case "tool": {
          const value = detail.value;
          tools.push({
            name: text(value.name, 200),
            description: description(value.description),
            effect: value.effect,
            capabilities: value.capabilities.slice(0, 100).map((id) => text(id, 200)),
            available:
              active &&
              value.available &&
              value.capabilities.some((id) => availableCapabilities.has(id)),
          });
          break;
        }
        case "skill": {
          const value = detail.value;
          skills.push({
            name: text(value.name, 200),
            description: description(value.description),
            enabled: value.enabled,
            capabilities: value.capabilities.slice(0, 100).map((id) => text(id, 200)),
            available:
              active &&
              value.available &&
              value.capabilities.some((id) => availableCapabilities.has(id)),
          });
          break;
        }
      }
    }
    return { ...core, capabilities, tools, skills, detailsOmitted };
  });
  return {
    pluginsStatus: "reported",
    plugins,
    pluginsOmittedCount: inventory.integrations.length - plugins.length,
  };
}
