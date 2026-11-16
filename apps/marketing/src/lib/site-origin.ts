// Set the deployed Harness origin explicitly; local builds must not claim t3.codes.
export const SITE_ORIGIN = process.env.PUBLIC_SITE_ORIGIN ?? "http://localhost:4173";
export const HAS_PUBLIC_SITE_ORIGIN = Boolean(process.env.PUBLIC_SITE_ORIGIN);
