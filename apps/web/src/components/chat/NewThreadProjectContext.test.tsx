import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { NewThreadProjectContext } from "./NewThreadProjectContext";

describe("NewThreadProjectContext", () => {
  it("shows only the project name as the new-thread execution context", () => {
    const markup = renderToStaticMarkup(
      <NewThreadProjectContext projectName="Citizen-Developer" />,
    );

    expect(markup).toContain('data-chat-composer-project-context="true"');
    expect(markup).toContain('title="Citizen-Developer"');
    expect(markup).toContain("Citizen-Developer");
    expect(markup).toContain("truncate");
    expect(markup).not.toContain("Local");
    expect(markup).not.toContain("main");
  });
});
