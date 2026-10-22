import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { describe, expect, it } from "vite-plus/test";

import { remarkBotImagesAsLinks } from "./botMarkdown";

const render = (text: string) =>
  renderToStaticMarkup(<Markdown remarkPlugins={[remarkBotImagesAsLinks]}>{text}</Markdown>);

describe("remarkBotImagesAsLinks", () => {
  it("turns an image a quoted email could plant into a link that loads nothing", () => {
    const html = render("Summary ![status](https://tracker.example/p?d=secret) done");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://tracker.example/p?d=secret">status</a>');
  });

  it("keeps a linked image's link without nesting another link inside it", () => {
    const html = render("[![logo](https://cdn.example/l.png)](https://example.edu)");
    expect(html).not.toContain("<img");
    expect(html).toBe('<p><a href="https://example.edu">logo</a></p>');
  });

  it("shows a reference-style image as its alt text", () => {
    const html = render("![chart][c]\n\n[c]: https://cdn.example/c.png");
    expect(html).not.toContain("<img");
    expect(html).toContain("chart");
  });
});
