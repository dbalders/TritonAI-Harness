# Visual replies

Agents can answer with a page instead of only text: a chart, table, diagram, image collage, or mockup. Ask for one ("show this as a chart", "make a collage of these screenshots") and the agent builds a self-contained HTML page, which appears in the thread above its written reply. It works with every provider, on web, desktop, and mobile.

Pages use your current theme, including custom themes, and follow light and dark mode as you switch. Previews stay offline: page-authored scripts, external resources, forms that submit, and external links are disabled. Text, styling, tables, expandable sections, inputs, and embedded images remain available. JavaScript charts and calculators may appear incomplete; download the original file when you need to inspect its code. Use the expand button to open a page full screen. On web and desktop, use the zoom controls to see more detail.

Agents can place local images in a page by file path. T3 Code embeds them when the page is published, so the page keeps working after the original files move or are deleted. Deleting the thread deletes its pages.

Before publishing, agents check their work with screenshots from a small headless browser that T3 Code keeps for itself; it never uses a browser you installed. The first preview on a machine downloads it once (about 120 MB) into T3 Code's data folder, so that preview can take a minute. Browser tabs on a remote environment use the same browser, so whichever comes first downloads it. Some Linux hosts need [setup](remote-access.md#browser-host-setup) before it can start. Pages publish without it.

## MCP apps

Some MCP servers return HTML apps with their tool results. These use the same safe, offline preview on web, desktop, and mobile. Their scripts, network connections, tool calls, and message actions are disabled. Some apps need scripts to draw their contents and may appear blank; ask the agent for a text or static visual result instead.
