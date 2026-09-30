# Product analytics

The server owns Plausible delivery, opt-out, and identity for every connected client.
Clients do not load a Plausible script. Client-use events require an authenticated
connection, so visiting the hosted app without connecting does not count as product use.

## Identity

[Identify.ts](../../apps/server/src/telemetry/Identify.ts) persists a random UUID as
`userdata/anonymous-id`, and every event carries it as the `aid` prop. The unit is a server
userdata install, not a person: desktop, web, and mobile clients of one server share an `aid`,
and one person using two servers counts twice. Upstream hashes Codex or Claude account IDs
instead. TritonAI does not, because a shared managed login would collapse every install into
one ID, and a login change would switch an install's ID. The ID is kept separate from
`environment-id` so an analytics reset does not rotate pairing or auth identity.

Plausible's own visitor metrics are not usable for this app. Every event has the same
User-Agent and campus networks share IPs, so a Plausible "visitor" is roughly a network and
version per day. Count distinct `aid` values instead; the dashboard cannot, so
[analytics-report.ts](../../scripts/analytics-report.ts) queries the Stats API. Its `event:goal`
filters need matching custom-event goals in Plausible, and `aid` must be allowed if the site
restricts custom properties.

## Collection boundary

[AnalyticsService.ts](../../apps/server/src/telemetry/AnalyticsService.ts) keeps a per-event
prop allowlist. An event or prop that is not listed is dropped silently, so a new
`analytics.record` call needs an allowlist entry. Plausible accepts at most 30 props per event,
including the common props and `aid`.

Keep payloads to product metadata and normalized measurements. Do not send prompts,
authentication material, raw provider payloads, user-assigned device names, free-form strings,
model names, or conversation identifiers. Client metadata is best effort; invalid values must
not reject a connection.

## Attribution boundaries

Client dimensions belong to the event's WebSocket connection. A server-global
"current client" would misattribute simultaneous web, desktop, and mobile use.
Provider execution has its own events because a turn can outlive the requesting
connection. `ProviderService` is the only producer of `provider.turn.completed`.

Keep client and server dimensions separate. A desktop host can serve a phone or a
remote browser, and a direct connection can cross a network. Older clients omit
metadata. Missing client values must stay unknown rather than being backfilled
from server properties. The legacy `clientType` property describes how the server
runs; use `surface` for the connected client.

## Interpreting events

Use `client.turn.requested` for active-use reports. `client.connected` counts
reconnects, so network behavior can inflate it. One install can appear in several
client groups during a period; adding those groups double-counts installs.

The heartbeat's `threadCount` includes deleted threads, so it only grows and an install's
largest value is its latest. With `firstThreadMonth`, it covers use from before `aid` existed.
Draft retries can recreate a thread and reset its creation time, so both are approximate.

Provider send and completion counts need not match. Providers can emit synthetic
turns without a send request, and interrupted or cancelled turns also complete. Collection
is best effort, with no scan or backfill of provider history.

Token totals cover the main agent. Child agents and model rerouting prevent a turn
from representing one provider/model combination's full cost. For provider
comparisons, require complete usage, no observed subagents, and no mixed models.
Plausible stores numeric props as dimension values, so sums and averages come from Stats API
breakdowns rather than the dashboard.
