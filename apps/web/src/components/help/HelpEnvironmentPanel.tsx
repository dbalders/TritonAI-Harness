import type { HelpContext } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { Fragment } from "react";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { RefreshIcon } from "../ui/refresh-icon";
import { HELP_SETTINGS_LINKS } from "./helpLinks";

/**
 * The environment snapshot, collapsed by default with its freshness still visible, and the
 * settings shortcuts, which stay in view so recovery never depends on Help answering.
 */
export function HelpEnvironmentPanel({
  context,
  pending,
  canRefresh,
  notice,
  onRefresh,
}: {
  readonly context: HelpContext | null;
  readonly pending: boolean;
  readonly canRefresh: boolean;
  readonly notice: string | null;
  readonly onRefresh: () => void;
}) {
  const enabledProviders = context?.providers.filter((provider) => provider.enabled) ?? [];
  const disabledProviders = context?.providers.filter((provider) => !provider.enabled) ?? [];
  return (
    <aside
      aria-label="Environment and settings"
      className="grid min-w-0 items-start gap-4 lg:grid-cols-2 xl:grid-cols-1"
    >
      <section
        aria-labelledby="help-environment-heading"
        className="min-w-0 rounded-xl border border-border/70 p-4"
      >
        <Collapsible>
          <div className="flex items-center justify-between gap-3">
            <h2 id="help-environment-heading" className="min-w-0 flex-1 text-sm font-semibold">
              <CollapsibleTrigger className="group flex w-full items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                <ChevronRightIcon
                  className="size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none group-data-panel-open:rotate-90"
                  aria-hidden="true"
                />
                This environment
              </CollapsibleTrigger>
            </h2>
            <Button
              size="xs"
              variant="ghost"
              disabled={!canRefresh || pending}
              onClick={onRefresh}
              aria-label="Refresh environment snapshot"
              aria-busy={pending}
            >
              <RefreshIcon refreshing={pending} />
              Refresh
            </Button>
          </div>
          <p className="mt-0.5 ps-6 text-xs leading-5 text-muted-foreground">
            {pending ? (
              context ? (
                "Refreshing snapshot…"
              ) : (
                "Loading snapshot…"
              )
            ) : context ? (
              <>
                Captured{" "}
                <time dateTime={context.capturedAt}>
                  {new Date(context.capturedAt).toLocaleString(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </time>
              </>
            ) : (
              "No snapshot loaded"
            )}
          </p>
          <CollapsiblePanel>
            <div className="mt-4 space-y-5 border-t border-border/60 pt-4">
              {notice ? (
                <p className="text-xs leading-5 text-muted-foreground" role="status">
                  {notice}
                </p>
              ) : null}
              {context ? (
                <>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-xs leading-5">
                    {[
                      ["Environment", context.environmentName],
                      ["Version", context.version],
                      ["Host platform", context.platform],
                      ["Mode", context.mode],
                      ["Help model", context.modelLabel],
                    ].map(([label, value]) => (
                      <Fragment key={label}>
                        <dt className="text-muted-foreground">{label}</dt>
                        <dd className="wrap-anywhere">{value}</dd>
                      </Fragment>
                    ))}
                  </dl>
                  <section
                    aria-labelledby="help-providers-heading"
                    className="space-y-2 border-t border-border/60 pt-4"
                  >
                    <h3 id="help-providers-heading" className="text-xs font-medium">
                      Provider discovery · reported / cached
                    </h3>
                    <p className="text-xs leading-5 text-muted-foreground">
                      This is saved discovery status, not a live connection check. Refresh captures
                      a new snapshot; it does not retest providers.
                    </p>
                    {enabledProviders.length === 0 ? (
                      <div className="space-y-2">
                        <p className="text-xs text-muted-foreground">No providers are enabled.</p>
                        <Button
                          size="xs"
                          variant="outline"
                          render={<Link to="/settings/providers" />}
                        >
                          Open Providers
                        </Button>
                      </div>
                    ) : (
                      <ul className="space-y-2.5">
                        {enabledProviders.map((provider) => (
                          <li key={provider.id} className="text-xs leading-5">
                            <p className="font-medium wrap-anywhere">{provider.name}</p>
                            <p className="text-muted-foreground wrap-anywhere">
                              {provider.status} ·{" "}
                              {provider.authenticated === null
                                ? "authentication unknown"
                                : provider.authenticated
                                  ? "authentication reported"
                                  : "not authenticated"}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                    {disabledProviders.length > 0 ? (
                      <Collapsible>
                        <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-sm text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                          <ChevronRightIcon
                            className="size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-data-panel-open:rotate-90"
                            aria-hidden="true"
                          />
                          Disabled providers ({disabledProviders.length})
                        </CollapsibleTrigger>
                        <CollapsiblePanel>
                          <ul className="space-y-1.5 pt-3 text-xs leading-5 text-muted-foreground">
                            {disabledProviders.map((provider) => (
                              <li key={provider.id} className="wrap-anywhere">
                                {provider.name} · {provider.driver}
                              </li>
                            ))}
                          </ul>
                        </CollapsiblePanel>
                      </Collapsible>
                    ) : null}
                  </section>
                  <div className="border-t border-border/60 pt-4">
                    <Collapsible>
                      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-sm text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                        <ChevronRightIcon
                          className="size-3.5 shrink-0 transition-transform motion-reduce:transition-none group-data-panel-open:rotate-90"
                          aria-hidden="true"
                        />
                        App locations
                      </CollapsibleTrigger>
                      <CollapsiblePanel>
                        <div className="space-y-3 pt-3">
                          <p className="text-xs leading-5 text-muted-foreground">
                            These locations belong to the environment host running TritonAI. For a
                            remote connection, they are on that host, not this browser or desktop
                            client. Paths are omitted from feedback reports.
                          </p>
                          {context.paths.length === 0 ? (
                            <p className="text-xs text-muted-foreground">No locations reported.</p>
                          ) : (
                            <dl className="space-y-3">
                              {context.paths.map((location) => (
                                <div key={location.label} className="space-y-1 text-xs">
                                  <dt className="text-muted-foreground">{location.label}</dt>
                                  <dd className="font-mono wrap-anywhere">{location.path}</dd>
                                </div>
                              ))}
                            </dl>
                          )}
                        </div>
                      </CollapsiblePanel>
                    </Collapsible>
                  </div>
                </>
              ) : null}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      </section>
      <nav
        aria-labelledby="help-recovery-heading"
        className="min-w-0 space-y-3 rounded-xl border border-border/70 p-4"
      >
        <div className="space-y-0.5">
          <h2 id="help-recovery-heading" className="text-sm font-semibold">
            Open settings
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            Use these directly, even when Help cannot respond.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {HELP_SETTINGS_LINKS.map((link) => (
            <Button key={link.to} size="xs" variant="outline" render={<Link to={link.to} />}>
              {link.label}
            </Button>
          ))}
        </div>
      </nav>
    </aside>
  );
}
