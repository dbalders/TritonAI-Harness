const crypto = require("node:crypto");

const APP_ID = "6813147394";
const BUNDLE_ID = "edu.ucsd.tritonai.harness";
const API_ORIGIN = "https://api.appstoreconnect.apple.com";
const stableTag = /^v(\d+)\.(\d+)\.(\d+)$/;

function compareVersions(left, right) {
  const parse = (value) => {
    if (!/^\d+(?:\.\d+){0,2}$/.test(value)) throw new Error(`Invalid version: ${value}`);
    return [...value.split("."), "0", "0"].slice(0, 3).map(BigInt);
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

function newestStable(releases, firstTag) {
  if (!stableTag.test(firstTag))
    throw new Error("IOS_APP_REVIEW_FIRST_TAG must be a stable vMAJOR.MINOR.PATCH tag");
  return releases
    .filter((release) => !release.draft && !release.prerelease && stableTag.test(release.tag_name))
    .filter((release) => compareVersions(release.tag_name.slice(1), firstTag.slice(1)) >= 0)
    .sort((a, b) => compareVersions(b.tag_name.slice(1), a.tag_name.slice(1)))[0];
}

function nextMarketingVersion({ tag, sourceSha, configuredVersion, previous }) {
  if (tag !== "main" && !stableTag.test(tag))
    throw new Error("Version allocation requires a stable release");
  compareVersions(configuredVersion, configuredVersion);
  if (tag === "main" && previous?.marketingVersion && stableTag.test(previous.tag)) {
    throw new Error(
      "Main builds are only for initial setup; rebuild the published stable tag instead",
    );
  }
  if (tag !== "main" && previous?.tag === tag && previous.marketingVersion) {
    if (previous.sourceSha !== sourceSha) throw new Error("Published release source changed");
    return previous.marketingVersion;
  }
  if (
    tag !== "main" &&
    previous?.marketingVersion &&
    stableTag.test(previous.tag) &&
    compareVersions(tag.slice(1), previous.tag.slice(1)) <= 0
  ) {
    throw new Error("Cannot replace a newer native release with an older release");
  }
  const baseline =
    previous?.marketingVersion && compareVersions(previous.marketingVersion, configuredVersion) > 0
      ? previous.marketingVersion
      : configuredVersion;
  if (tag === "main") return baseline;
  const parts = baseline.split(".");
  parts[2] = String(BigInt(parts[2]) + 1n);
  return parts.join(".");
}

function appleClient({ keyId, issuerId, privateKey, keyType = "team", fetchImpl = fetch }) {
  if (!["team", "individual"].includes(keyType))
    throw new Error("Unsupported App Store Connect key type");
  if (!keyId || !privateKey || (keyType === "team" && !issuerId))
    throw new Error("App Store Connect API secrets are required");
  function token() {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const issued = Math.floor(Date.now() / 1000);
    const identity = keyType === "individual" ? { sub: "user" } : { iss: issuerId };
    const body = `${encode({ alg: "ES256", kid: keyId, typ: "JWT" })}.${encode({ ...identity, iat: issued, exp: issued + 600, aud: "appstoreconnect-v1" })}`;
    const signature = crypto
      .sign("sha256", Buffer.from(body), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      })
      .toString("base64url");
    return `${body}.${signature}`;
  }
  async function request(route, method = "GET", data) {
    const url = new URL(route, API_ORIGIN);
    if (url.origin !== API_ORIGIN) throw new Error("Unexpected Apple API pagination origin");
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      ...(data ? { body: JSON.stringify({ data }) } : {}),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      // Do not log response bodies: review details can contain login credentials.
      throw new Error(
        `Apple API ${method} ${url.pathname}: HTTP ${response.status}; inspect App Store Connect for metadata, permission, or review issues`,
      );
    }
    return response.status === 204 ? {} : response.json();
  }
  async function list(route) {
    const items = [];
    for (let page = 0; route; page++) {
      if (page >= 100) throw new Error("Apple API pagination exceeded its bound");
      const response = await request(route);
      items.push(...response.data);
      route = response.links?.next;
    }
    return items;
  }
  return { request, list };
}

const relationship = (type, id) => ({ data: { type, id } });
const stateOf = (version) => version.attributes.appVersionState ?? version.attributes.appStoreState;
const finishedStates = new Set([
  "READY_FOR_SALE",
  "READY_FOR_DISTRIBUTION",
  "REPLACED_WITH_NEW_VERSION",
  "DEVELOPER_REMOVED_FROM_SALE",
  "REMOVED_FROM_SALE",
]);
const rejectedStates = new Set([
  "REJECTED",
  "METADATA_REJECTED",
  "INVALID_BINARY",
  "DEVELOPER_REJECTED",
]);

async function reconcile({
  github,
  context,
  apple,
  firstTag,
  summary,
  releaseAfterApproval = false,
  log = console.log,
}) {
  const releases = await github.paginate(github.rest.repos.listReleases, {
    ...context.repo,
    per_page: 100,
  });
  const release = newestStable(releases, firstTag);
  const done = async (message) => {
    log(message);
    await summary.addRaw(`${message}\n`).write();
    return message;
  };
  if (!release) return done("No eligible stable iOS release is pending.");
  const { data: source } = await github.rest.repos.getCommit({
    ...context.repo,
    ref: release.tag_name,
  });
  let native;
  try {
    native = (await github.rest.repos.getCommit({ ...context.repo, ref: "mobile-stable" })).data;
  } catch (error) {
    if (error.status === 404) return done("Waiting for the mobile-stable native handoff.");
    throw error;
  }
  const { data: file } = await github.rest.repos.getContent({
    ...context.repo,
    ref: native.sha,
    path: "apps/mobile/ios/ci_scripts/stable-source.json",
  });
  const receipt = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  if (receipt.tag !== release.tag_name || receipt.sourceSha !== source.sha) {
    return done(
      `Waiting for the native handoff for ${release.tag_name}; older pending releases are superseded.`,
    );
  }
  if (receipt.variant !== "production" || !receipt.marketingVersion) {
    throw new Error(
      "Native handoff lacks production identity or allocated marketing version; rebuild with the updated stable workflow",
    );
  }
  const versionString = receipt.marketingVersion;
  compareVersions(versionString, versionString);
  const { data: app } = await apple.request(`/v1/apps/${APP_ID}`);
  if (app.attributes.bundleId !== BUNDLE_ID) throw new Error("Unexpected App Store app identity");
  const versions = await apple.list(
    `/v1/apps/${APP_ID}/appStoreVersions?filter[platform]=IOS&limit=200`,
  );
  let version = versions.find((item) => item.attributes.versionString === versionString);
  if (version && finishedStates.has(stateOf(version)))
    return done(`${release.tag_name} / iOS ${versionString} has already been released.`);
  const released = versions.filter((item) => finishedStates.has(stateOf(item)));
  const blocked = versions.find(
    (item) =>
      rejectedStates.has(stateOf(item)) &&
      !released.some(
        (live) => compareVersions(live.attributes.versionString, item.attributes.versionString) > 0,
      ),
  );
  if (blocked)
    throw new Error(
      `iOS ${blocked.attributes.versionString} is ${stateOf(blocked)}; resolve the rejection in App Store Connect before resuming automation`,
    );
  const active = versions.find(
    (item) =>
      !finishedStates.has(stateOf(item)) &&
      !rejectedStates.has(stateOf(item)) &&
      !["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"].includes(stateOf(item)),
  );
  if (active)
    return done(
      `iOS ${active.attributes.versionString} is ${stateOf(active)}; ${release.tag_name} remains pending. No review was withdrawn.`,
    );
  if (
    versions.some(
      (item) =>
        finishedStates.has(stateOf(item)) &&
        compareVersions(item.attributes.versionString, versionString) >= 0,
    )
  ) {
    throw new Error(`Allocated iOS ${versionString} is not newer than the released version`);
  }
  const submissions = await apple.list(
    `/v1/reviewSubmissions?filter[app]=${APP_ID}&filter[platform]=IOS&limit=200`,
  );
  if (submissions.some((item) => item.attributes.state === "UNRESOLVED_ISSUES")) {
    throw new Error("Apple review has unresolved issues; resolve them before resuming automation");
  }
  if (
    submissions.some((item) => !["READY_FOR_REVIEW", "COMPLETE"].includes(item.attributes.state))
  ) {
    return done("An Apple review submission is active; the newest stable release remains pending.");
  }
  const { data: product } = await apple.request(`/v1/apps/${APP_ID}/ciProduct`);
  const runs = await apple.list(`/v1/ciProducts/${product.id}/buildRuns?sort=-number&limit=200`);
  const run = runs.find((item) => item.attributes.sourceCommit?.commitSha === native.sha);
  if (!run) return done(`Waiting for Xcode Cloud to build ${release.tag_name} (${native.sha}).`);
  if (run.attributes.isPullRequestBuild)
    throw new Error("Pull-request builds cannot be submitted by stable automation");
  if (["FAILED", "ERRORED", "CANCELED", "SKIPPED"].includes(run.attributes.completionStatus)) {
    throw new Error(
      `Xcode Cloud build ${run.attributes.number} ${run.attributes.completionStatus}; rebuild the stable handoff`,
    );
  }
  if (run.attributes.completionStatus !== "SUCCEEDED")
    return done("Waiting for Xcode Cloud to finish.");
  const builds = await apple.list(
    `/v1/ciBuildRuns/${run.id}/builds?filter[app]=${APP_ID}&filter[preReleaseVersion.platform]=IOS&filter[preReleaseVersion.version]=${versionString}&limit=200`,
  );
  const build = builds.find(
    (item) =>
      item.attributes.processingState === "VALID" &&
      item.attributes.expired === false &&
      item.attributes.buildAudienceType === "APP_STORE_ELIGIBLE",
  );
  if (!build) {
    if (builds.some((item) => ["FAILED", "INVALID"].includes(item.attributes.processingState)))
      throw new Error("Apple rejected the uploaded binary");
    if (builds.some((item) => item.attributes.buildAudienceType === "INTERNAL_ONLY"))
      throw new Error("Xcode Cloud archive must be App Store eligible, not internal-only");
    return done(
      "Waiting for an App Store eligible, processed iOS build from the exact stable commit.",
    );
  }
  const unrelatedDraft = versions.find(
    (item) =>
      item.id !== version?.id &&
      ["PREPARE_FOR_SUBMISSION", "READY_FOR_REVIEW"].includes(stateOf(item)),
  );
  if (unrelatedDraft)
    throw new Error(
      `An unrelated iOS ${unrelatedDraft.attributes.versionString} draft exists; resolve it before automation creates another version`,
    );
  let draft;
  for (const submission of submissions.filter(
    (item) => item.attributes.state === "READY_FOR_REVIEW",
  )) {
    const items = await apple.list(
      `/v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion&limit=200`,
    );
    if (
      version &&
      items.length === 1 &&
      items[0].relationships?.appStoreVersion?.data?.id === version.id
    ) {
      if (draft) throw new Error("Multiple review drafts exist; manual resolution required");
      draft = submission;
    } else if (version && items.length === 0 && !draft) {
      draft = submission;
    } else {
      throw new Error("Unrelated review draft exists; manual resolution required");
    }
  }
  if (!version) {
    ({ data: version } = await apple.request("/v1/appStoreVersions", "POST", {
      type: "appStoreVersions",
      attributes: {
        platform: "IOS",
        versionString,
        releaseType: releaseAfterApproval ? "AFTER_APPROVAL" : "MANUAL",
      },
      relationships: { app: relationship("apps", APP_ID), build: relationship("builds", build.id) },
    }));
  } else {
    await apple.request(`/v1/appStoreVersions/${version.id}/relationships/build`, "PATCH", {
      type: "builds",
      id: build.id,
    });
    await apple.request(`/v1/appStoreVersions/${version.id}`, "PATCH", {
      type: "appStoreVersions",
      id: version.id,
      attributes: { releaseType: releaseAfterApproval ? "AFTER_APPROVAL" : "MANUAL" },
    });
  }
  const locales = await apple.list(
    `/v1/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`,
  );
  if (!locales.length)
    throw new Error("App Store listing must be initialized before automatic submissions");
  // Plain release text is committed/published by maintainers; no AI generation.
  const notes =
    `TritonAI Harness ${release.tag_name.slice(1)}\n\n${release.body || "Improvements and fixes."}`.slice(
      0,
      4000,
    );
  for (const locale of locales) {
    await apple.request(`/v1/appStoreVersionLocalizations/${locale.id}`, "PATCH", {
      type: "appStoreVersionLocalizations",
      id: locale.id,
      attributes: { whatsNew: notes },
    });
  }
  if (!draft) {
    ({ data: draft } = await apple.request("/v1/reviewSubmissions", "POST", {
      type: "reviewSubmissions",
      attributes: { platform: "IOS" },
      relationships: { app: relationship("apps", APP_ID) },
    }));
  }
  const items = await apple.list(
    `/v1/reviewSubmissions/${draft.id}/items?include=appStoreVersion&limit=200`,
  );
  if (!items.some((item) => item.relationships?.appStoreVersion?.data?.id === version.id)) {
    await apple.request("/v1/reviewSubmissionItems", "POST", {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: relationship("reviewSubmissions", draft.id),
        appStoreVersion: relationship("appStoreVersions", version.id),
      },
    });
  }
  await apple.request(`/v1/reviewSubmissions/${draft.id}`, "PATCH", {
    type: "reviewSubmissions",
    id: draft.id,
    attributes: { submitted: true },
  });
  const { data: submitted } = await apple.request(`/v1/reviewSubmissions/${draft.id}`);
  if (
    !["WAITING_FOR_REVIEW", "IN_REVIEW", "COMPLETING", "COMPLETE"].includes(
      submitted.attributes.state,
    )
  ) {
    throw new Error("Apple did not confirm the submitted review state");
  }
  return done(
    `Submitted ${release.tag_name} / iOS ${versionString} build ${build.attributes.version} for Apple review (${submitted.attributes.state}). ${releaseAfterApproval ? "Release is automatic after approval." : "Approved builds await manual App Store release."}`,
  );
}

module.exports = {
  APP_ID,
  compareVersions,
  newestStable,
  nextMarketingVersion,
  appleClient,
  reconcile,
};
