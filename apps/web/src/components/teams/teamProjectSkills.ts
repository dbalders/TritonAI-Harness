import { shortTeamSkillVersion, type TeamProjectSkill } from "@t3tools/contracts";
import { teamContextRows, type TeamListedDocument } from "./threadTeamContext";

export type TeamProjectSkillState = "off" | "on" | "needs-review" | "not-applied";

/** A skill in the Skills settings for one linked project, with whether it is on for the user. */
export interface TeamProjectSkillRow {
  readonly path: string;
  readonly label: string;
  readonly description: string;
  readonly source: string;
  /** Why the skill can't be turned on, read from its listing. */
  readonly warning: string | null;
  readonly state: TeamProjectSkillState;
  /** Why a skill that is on isn't being added to messages now. */
  readonly reason: string | null;
  /** The short form of the approved version, for a skill that is on. */
  readonly version: string | null;
}

const states = {
  active: "on",
  "needs-review": "needs-review",
  unavailable: "not-applied",
} as const;

/**
 * One row per skill in the linked team's Skills folder, plus any skill the user turned on that
 * the folder no longer lists. Skills that are on come first, in the order they are added to
 * messages.
 */
export function teamProjectSkillRows(
  files: readonly TeamListedDocument[],
  authors: Readonly<Record<string, string>> | undefined,
  enabled: readonly TeamProjectSkill[],
): TeamProjectSkillRow[] {
  const listed = new Map(teamContextRows("skill", files, authors).map((row) => [row.path, row]));
  const titled = new Set(files.filter((file) => file.summary?.title).map((file) => file.path));
  const on = enabled.map((skill): TeamProjectSkillRow => {
    const row = listed.get(skill.path);
    return {
      path: skill.path,
      // A listing that didn't read the skill's title shows the one it had when approved.
      label: row && titled.has(skill.path) ? row.label : skill.title,
      description: row && titled.has(skill.path) ? row.description : "",
      source: row?.source ?? "No longer in the team’s Skills folder",
      warning: null,
      state: states[skill.state],
      reason: skill.reason ?? null,
      version: shortTeamSkillVersion(skill.version),
    };
  });
  const enabledPaths = new Set(enabled.map((skill) => skill.path));
  const off = [...listed.values()]
    .filter((row) => !enabledPaths.has(row.path))
    .map((row): TeamProjectSkillRow => ({
      ...row,
      state: "off",
      reason: null,
      version: null,
    }));
  return [...on, ...off];
}

/** What the composer says about a project's skills that are on, or null when none are. */
export function teamProjectSkillsNotice(
  teamName: string,
  skills: readonly TeamProjectSkill[],
): { variant: "info" | "warning"; title: string; description: string } | null {
  if (skills.length === 0) return null;
  const active = skills.filter((skill) => skill.state === "active");
  const withheld = skills.filter((skill) => skill.state !== "active");
  const names = (list: readonly TeamProjectSkill[]) =>
    list.map((skill) => `“${skill.title}”`).join(", ");
  if (withheld.length === 0)
    return {
      variant: "info",
      title: `Team ${active.length === 1 ? "skill" : "skills"} on: ${names(active)}`,
      description: `Harness adds ${active.length === 1 ? "it" : "them"} from ${teamName} to each message you send in this project, after checking your access. Once sent, ${active.length === 1 ? "it stays" : "they stay"} in the conversation.`,
    };
  const first = withheld[0]!;
  return {
    variant: "warning",
    title:
      withheld.length === 1
        ? `${names(withheld)} isn’t being added to your messages`
        : `${withheld.length} team skills aren’t being added to your messages`,
    description: [
      withheld.length === 1
        ? (first.reason ?? "It can’t be used right now.")
        : withheld.some((skill) => skill.state === "needs-review")
          ? "Some changed since you turned them on and need review."
          : "They can’t be used right now.",
      withheld.length === 1
        ? "Review it or turn it off in Settings → Skills."
        : "Review or turn them off in Settings → Skills.",
      active.length > 0 ? `Still added: ${names(active)}.` : "",
    ]
      .filter(Boolean)
      .join(" "),
  };
}
