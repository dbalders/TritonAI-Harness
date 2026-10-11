import { type TeamInviteeLookup, TeamsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

/**
 * The delegated permission that lets a team connection read other users' basic profiles. Invitee
 * lookup stays off until a connection's scopes include it.
 */
export const DIRECTORY_LOOKUP_SCOPE = "User.ReadBasic.All";

// User.ReadBasic.All returns only displayName, givenName, id, mail, photo, securityIdentifier,
// surname, and userPrincipalName. userType, accountEnabled, jobTitle, and department need broader
// directory permissions, so a guest is recognized by its `#EXT#` principal name instead.
const User = Schema.Struct({
  id: Schema.String,
  displayName: Schema.optionalKey(Schema.NullOr(Schema.String)),
  mail: Schema.optionalKey(Schema.NullOr(Schema.String)),
  userPrincipalName: Schema.String,
});
const decodeUsers = Schema.decodeUnknownEffect(Schema.Struct({ value: Schema.Array(User) }));
const failure = () =>
  new TeamsError({
    code: "unavailable",
    message: "Microsoft couldn't look up this address. Try again.",
  });

/**
 * Finds the one directory account whose sign-in name or mail is `email`, with a single Graph
 * request made through the caller's own delegated connection.
 */
export const lookupInvitee = (
  email: string,
  send: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, TeamsError>,
) =>
  Effect.gen(function* () {
    const address = email.toLowerCase();
    const literal = address.replaceAll("'", "''");
    const query = new URLSearchParams({
      $filter: `userPrincipalName eq '${literal}' or mail eq '${literal}'`,
      $select: "id,displayName,mail,userPrincipalName",
      $top: "2",
    });
    const response = yield* send(
      HttpClientRequest.get(`https://graph.microsoft.com/v1.0/users?${query}`),
    );
    // The connection's token doesn't carry the directory permission, or the tenant refused it.
    if (response.status === 403)
      return { email: address, status: "not-permitted" } satisfies TeamInviteeLookup;
    if (response.status !== 200) return yield* failure();
    const { value } = yield* response.json.pipe(
      Effect.flatMap(decodeUsers),
      Effect.mapError(failure),
    );
    const people = new Map(
      value
        .filter(
          (user) =>
            user.userPrincipalName.toLowerCase() === address ||
            user.mail?.toLowerCase() === address,
        )
        .map((user) => [user.id, user]),
    );
    const [person, ...others] = people.values();
    if (!person) return { email: address, status: "not-found" } satisfies TeamInviteeLookup;
    if (others.length) return { email: address, status: "ambiguous" } satisfies TeamInviteeLookup;
    if (person.userPrincipalName.toUpperCase().includes("#EXT#"))
      return { email: address, status: "guest" } satisfies TeamInviteeLookup;
    return {
      email: address,
      status: "found",
      displayName: person.displayName?.trim() || person.userPrincipalName,
      userPrincipalName: person.userPrincipalName,
      mail: person.mail ?? null,
    } satisfies TeamInviteeLookup;
  });
