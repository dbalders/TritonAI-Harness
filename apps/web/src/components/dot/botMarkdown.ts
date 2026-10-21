import type { Nodes, Parents, PhrasingContent } from "mdast";

/**
 * Bot replies can quote email, chat and file text that someone else wrote, so their images never load on their
 * own: an image becomes a link to its address (or its alt text inside a link), and nothing is fetched until the
 * owner opens it.
 */
export function remarkBotImagesAsLinks() {
  return (tree: Nodes) => replaceImages(tree, false);
}

function replaceImages(node: Nodes, insideLink: boolean): void {
  if (!("children" in node)) return;
  const parent = node as Parents;
  const linked = insideLink || node.type === "link" || node.type === "linkReference";
  parent.children = parent.children.map((child) => {
    if (child.type === "image") {
      const label: PhrasingContent = { type: "text", value: child.alt?.trim() || child.url };
      return linked ? label : { type: "link", url: child.url, children: [label] };
    }
    if (child.type === "imageReference") return { type: "text", value: child.alt ?? "" };
    replaceImages(child, linked);
    return child;
  }) as typeof parent.children;
}
