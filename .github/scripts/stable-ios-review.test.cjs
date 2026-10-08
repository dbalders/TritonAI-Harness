const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  APP_ID,
  compareVersions,
  newestStable,
  nextMarketingVersion,
  appleClient,
  reconcile,
} = require("./stable-ios-review.cjs");

const sourceSha = "a".repeat(40);
const nativeSha = "b".repeat(40);
const release = {
  tag_name: "v0.3.7",
  body: "A stable improvement.",
  draft: false,
  prerelease: false,
};
const version = (versionString, appStoreState, id = versionString) => ({
  id,
  attributes: { versionString, appStoreState },
});

function fixture(overrides = {}) {
  const writes = [];
  const messages = [];
  const receipt = {
    tag: release.tag_name,
    sourceSha,
    variant: "production",
    marketingVersion: "1.4.2",
    ...overrides.receipt,
  };
  const build = {
    id: "build",
    attributes: {
      version: "42",
      processingState: "VALID",
      expired: false,
      buildAudienceType: "APP_STORE_ELIGIBLE",
      ...overrides.build,
    },
  };
  const run = {
    id: "run",
    attributes: {
      sourceCommit: { commitSha: nativeSha },
      completionStatus: "SUCCEEDED",
      number: 42,
      ...overrides.run,
    },
  };
  const submissions = overrides.submissions || [];
  const draftItems = overrides.items || [];
  const options = {
    firstTag: "v0.3.7",
    context: { repo: { owner: "test", repo: "harness" } },
    log(message) {
      messages.push(message);
    },
    summary: {
      addRaw() {
        return this;
      },
      async write() {},
    },
    github: {
      paginate: async () => overrides.releases || [release],
      rest: {
        repos: {
          listReleases() {},
          async getCommit({ ref }) {
            return { data: { sha: ref === "mobile-stable" ? nativeSha : sourceSha } };
          },
          async getContent({ ref }) {
            assert.equal(ref, nativeSha);
            return { data: { content: Buffer.from(JSON.stringify(receipt)).toString("base64") } };
          },
        },
      },
    },
    apple: {
      async list(route) {
        if (route.startsWith(`/v1/apps/${APP_ID}/appStoreVersions?`))
          return overrides.versions || [version("1.4.1", "READY_FOR_SALE")];
        if (route.startsWith("/v1/reviewSubmissions?")) return submissions;
        if (route.includes("/buildRuns?")) return overrides.runs || [run];
        if (route.includes("/builds?")) return overrides.builds || [build];
        if (route.includes("/appStoreVersionLocalizations?")) return [{ id: "locale" }];
        if (route.includes("/items?")) return draftItems;
        throw new Error(`Unexpected route: ${route}`);
      },
      async request(route, method = "GET", data) {
        if (method !== "GET") {
          writes.push({ route, method, data });
          if (route === "/v1/appStoreVersions")
            return {
              data: {
                id: "version",
                attributes: { versionString: "1.4.2", appStoreState: "PREPARE_FOR_SUBMISSION" },
              },
            };
          if (route === "/v1/reviewSubmissions")
            return { data: { id: "submission", attributes: { state: "READY_FOR_REVIEW" } } };
          if (route === "/v1/reviewSubmissionItems")
            draftItems.push({
              relationships: {
                appStoreVersion: { data: { id: data.relationships.appStoreVersion.data.id } },
              },
            });
          return {};
        }
        if (route === `/v1/apps/${APP_ID}`)
          return {
            data: { attributes: { bundleId: overrides.bundleId || "edu.ucsd.tritonai.harness" } },
          };
        if (route.endsWith("/ciProduct")) return { data: { id: "product" } };
        if (route.startsWith("/v1/reviewSubmissions/"))
          return { data: { attributes: { state: "WAITING_FOR_REVIEW" } } };
        throw new Error(`Unexpected request: ${route}`);
      },
    },
  };
  return { options, writes, messages };
}

test("queues only the highest published stable release at or above the activation floor", () => {
  assert.equal(
    newestStable(
      [
        release,
        { ...release, tag_name: "v0.3.8" },
        { ...release, tag_name: "v0.3.9", draft: true },
        { ...release, tag_name: "v0.4.0", prerelease: true },
        { ...release, tag_name: "v0.4.0-nightly.20261008.1" },
      ],
      "v0.3.7",
    ).tag_name,
    "v0.3.8",
  );
  assert.equal(newestStable([release], "v0.3.8"), undefined);
  assert.throws(() => newestStable([release], ""), /FIRST_TAG/);
  assert.equal(compareVersions("1.10.0", "1.9.9"), 1);
});

test("allocates monotonic mobile versions independently of desktop and preserves retry identity", () => {
  const base = { tag: release.tag_name, sourceSha, configuredVersion: "1.4.0" };
  assert.equal(nextMarketingVersion(base), "1.4.1");
  const previous = { tag: "v0.3.6", sourceSha, marketingVersion: "1.4.8" };
  assert.equal(nextMarketingVersion({ ...base, previous }), "1.4.9");
  assert.equal(
    nextMarketingVersion({ ...base, previous: { ...previous, tag: release.tag_name } }),
    "1.4.8",
  );
  assert.throws(
    () =>
      nextMarketingVersion({
        ...base,
        sourceSha: nativeSha,
        previous: { ...previous, tag: release.tag_name },
      }),
    /source changed/,
  );
  assert.throws(
    () => nextMarketingVersion({ ...base, previous: { ...previous, tag: "v0.3.8" } }),
    /newer native/,
  );
});

test("submits the exact Xcode Cloud build once, with deterministic notes and manual publication by default", async () => {
  const f = fixture();
  assert.match(await reconcile(f.options), /Submitted v0.3.7 \/ iOS 1.4.2 build 42/);
  const created = f.writes.find((item) => item.route === "/v1/appStoreVersions");
  assert.equal(created.data.relationships.build.data.id, "build");
  assert.equal(created.data.attributes.releaseType, "MANUAL");
  assert.ok(f.writes.some((item) => item.data.attributes?.whatsNew?.includes(release.body)));
  assert.equal(f.writes.filter((item) => item.data.attributes?.submitted).length, 1);
  assert.ok(!f.writes.some((item) => item.data.attributes?.canceled));
});

test("automatic publication is a separate explicit configuration", async () => {
  const f = fixture();
  await reconcile({ ...f.options, releaseAfterApproval: true });
  assert.equal(
    f.writes.find((item) => item.route === "/v1/appStoreVersions").data.attributes.releaseType,
    "AFTER_APPROVAL",
  );
});

for (const state of [
  "WAITING_FOR_REVIEW",
  "IN_REVIEW",
  "PENDING_DEVELOPER_RELEASE",
  "PROCESSING_FOR_APP_STORE",
]) {
  test(`retains the pending release without writes when another version is ${state}`, async () => {
    const f = fixture({ versions: [version("1.4.1", state)] });
    assert.match(await reconcile(f.options), /pending/);
    assert.deepEqual(f.writes, []);
  });
}

for (const state of ["REJECTED", "METADATA_REJECTED", "INVALID_BINARY", "DEVELOPER_REJECTED"]) {
  test(`pauses for human resolution of ${state}`, async () => {
    const f = fixture({ versions: [version("1.4.1", state)] });
    await assert.rejects(reconcile(f.options), /resolve the rejection/);
    assert.deepEqual(f.writes, []);
  });
}

test("does not resubmit an already released version", async () => {
  const f = fixture({ versions: [version("1.4.2", "READY_FOR_SALE")] });
  assert.match(await reconcile(f.options), /already been released/);
  assert.deepEqual(f.writes, []);
});

test("waits for the newest handoff instead of submitting an older pending release", async () => {
  const f = fixture({ releases: [release, { ...release, tag_name: "v0.3.8" }] });
  assert.match(await reconcile(f.options), /superseded/);
  assert.deepEqual(f.writes, []);
});

test("waits when an unrelated Cloud commit has a successful archive", async () => {
  const f = fixture({ run: { sourceCommit: { commitSha: sourceSha } } });
  assert.match(await reconcile(f.options), /Waiting for Xcode Cloud/);
  assert.deepEqual(f.writes, []);
});

for (const overrides of [
  { run: { completionStatus: "FAILED" } },
  { build: { buildAudienceType: "INTERNAL_ONLY" } },
  { bundleId: "other.app" },
]) {
  test(`rejects unusable builds or the wrong app: ${JSON.stringify(overrides)}`, async () => {
    const f = fixture(overrides);
    await assert.rejects(reconcile(f.options));
    assert.deepEqual(f.writes, []);
  });
}

test("does not choose an expired or processing build", async () => {
  for (const build of [{ expired: true }, { processingState: "PROCESSING" }]) {
    const f = fixture({ build });
    assert.match(await reconcile(f.options), /Waiting for/);
    assert.deepEqual(f.writes, []);
  }
});

test("recovers an existing review draft without creating another item or submission", async () => {
  const f = fixture({
    versions: [
      version("1.4.1", "READY_FOR_SALE"),
      version("1.4.2", "PREPARE_FOR_SUBMISSION", "version"),
    ],
    submissions: [{ id: "submission", attributes: { state: "READY_FOR_REVIEW" } }],
    items: [{ relationships: { appStoreVersion: { data: { id: "version" } } } }],
  });
  await reconcile(f.options);
  assert.ok(!f.writes.some((item) => item.method === "POST"));
  assert.equal(f.writes.filter((item) => item.data.attributes?.submitted).length, 1);
});

test("an interrupted empty review draft can resume", async () => {
  const f = fixture({
    versions: [version("1.4.2", "PREPARE_FOR_SUBMISSION", "version")],
    submissions: [{ id: "submission", attributes: { state: "READY_FOR_REVIEW" } }],
  });
  await reconcile(f.options);
  assert.ok(!f.writes.some((item) => item.route === "/v1/reviewSubmissions"));
  assert.equal(f.writes.filter((item) => item.route === "/v1/reviewSubmissionItems").length, 1);
});

test("an unresolved review never triggers writes", async () => {
  const f = fixture({ submissions: [{ attributes: { state: "UNRESOLVED_ISSUES" } }] });
  await assert.rejects(reconcile(f.options), /unresolved issues/);
  assert.deepEqual(f.writes, []);
});

test("Apple authentication uses verifiable ES256 JWTs and bounded same-origin pagination", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let calls = 0;
  const apple = appleClient({
    keyId: "test",
    issuerId: "issuer",
    privateKey,
    fetchImpl: async (url, options) => {
      assert.equal(url.origin, "https://api.appstoreconnect.apple.com");
      const jwt = options.headers.Authorization.slice(7);
      const [header, payload, signature] = jwt.split(".");
      assert.equal(JSON.parse(Buffer.from(payload, "base64url")).aud, "appstoreconnect-v1");
      assert.ok(
        crypto.verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature, "base64url"),
        ),
      );
      calls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [calls],
          links: { next: calls === 1 ? "/v1/test?page=2" : null },
        }),
      };
    },
  });
  assert.deepEqual(await apple.list("/v1/test"), [1, 2]);
  await assert.rejects(apple.request("https://evil.example/api"), /pagination origin/);
  assert.throws(() => appleClient({}), /secrets are required/);
});

test("main setup cannot overwrite an allocated stable release identity", () => {
  const previous = { tag: "v0.3.6", sourceSha, marketingVersion: "1.4.8" };
  assert.throws(
    () => nextMarketingVersion({ tag: "main", sourceSha, configuredVersion: "1.4.0", previous }),
    /only for initial setup/,
  );
  assert.equal(
    nextMarketingVersion({ tag: previous.tag, sourceSha, configuredVersion: "1.4.0", previous }),
    "1.4.8",
  );
  assert.throws(
    () => nextMarketingVersion({ tag: "v0.3.5", sourceSha, configuredVersion: "1.4.0", previous }),
    /older release/,
  );
  assert.equal(
    nextMarketingVersion({ tag: "main", sourceSha, configuredVersion: "1.4.0" }),
    "1.4.0",
  );
});
test("historical rejections below the released version do not block future releases", async () => {
  const f = fixture({
    versions: [version("1.4.0", "REJECTED"), version("1.4.1", "READY_FOR_SALE")],
  });
  assert.match(await reconcile(f.options), /Submitted/);
});
test("unrelated review drafts fail before any metadata or submission writes", async () => {
  const f = fixture({
    submissions: [{ id: "other", attributes: { state: "READY_FOR_REVIEW" } }],
    items: [{ relationships: { appStoreVersion: { data: { id: "other" } } } }],
  });
  await assert.rejects(reconcile(f.options), /Unrelated review draft/);
  assert.deepEqual(f.writes, []);
});

test("recognizes Apple's modern released state and shorter marketing versions", async () => {
  assert.equal(compareVersions("1.4", "1.4.0"), 0);
  const live = {
    id: "live",
    attributes: { versionString: "1.4.2", appVersionState: "READY_FOR_DISTRIBUTION" },
  };
  const f = fixture({ versions: [live] });
  assert.match(await reconcile(f.options), /already been released/);
  assert.deepEqual(f.writes, []);
});

test("individual-key tokens use sub=user without an issuer and sign verifiable requests", async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const apple = appleClient({
    keyType: "individual",
    keyId: "test",
    privateKey,
    // Even a stale team issuer must never enter an individual token.
    issuerId: "unused",
    fetchImpl: async (_url, options) => {
      const [header, payload, signature] = options.headers.Authorization.slice(7).split(".");
      const claims = JSON.parse(Buffer.from(payload, "base64url"));
      assert.equal(claims.sub, "user");
      assert.equal(claims.iss, undefined);
      assert.equal(claims.aud, "appstoreconnect-v1");
      assert.ok(
        crypto.verify(
          "sha256",
          Buffer.from(`${header}.${payload}`),
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          Buffer.from(signature, "base64url"),
        ),
      );
      return { ok: true, status: 200, json: async () => ({ data: [] }) };
    },
  });
  await apple.list("/v1/apps");
  assert.doesNotThrow(() => appleClient({ keyType: "individual", keyId: "test", privateKey }));
  assert.throws(
    () => appleClient({ keyType: "team", keyId: "test", privateKey }),
    /secrets are required/,
  );
  assert.throws(() => appleClient({ keyType: "other", keyId: "test", privateKey }), /Unsupported/);
});
