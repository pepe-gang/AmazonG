/**
 * Post-release verifier — catches exactly the failure modes that have
 * burned us before:
 *
 *   1. `gh release create` returned without uploading the DMG / ZIP
 *      (you get an "untagged-XXXX" URL because the asset upload
 *      timed out, and the release is stuck in draft).
 *   2. Release is in draft state — `releases/latest` falls through
 *      to the previous published release, so the "Download Now"
 *      link inside AmazonG hands users the OLD DMG even though
 *      the new one was just built.
 *   3. version.json on BG hasn't been bumped — the in-app update
 *      banner stays silent.
 *   4. version.json bumped but Vercel deploy didn't take effect —
 *      curl returns the old version.
 *   5. The DMG that GitHub serves at /releases/latest/.../X-arm64.dmg
 *      doesn't match the one we just built (caching / wrong tag).
 *
 * Every check is a hard error — exit code 1 stops the pipeline.
 *
 * Usage:
 *   tsx scripts/verifyRelease.ts vX.Y.Z [--bg-url=https://...]
 *     X.Y.Z must match package.json's `version` exactly.
 *     --bg-url defaults to https://betterbg.vercel.app
 */
import { readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
  .version as string;

const expectedTag = process.argv[2];
const bgUrl =
  process.argv.find((a) => a.startsWith("--bg-url="))?.slice("--bg-url=".length) ??
  "https://betterbg.vercel.app";

if (!expectedTag) {
  console.error("usage: tsx scripts/verifyRelease.ts vX.Y.Z [--bg-url=...]");
  process.exit(1);
}
const expectedVersion = expectedTag.replace(/^v/, "");

if (expectedVersion !== VERSION) {
  fail(
    `package.json version (${VERSION}) does not match expected tag ${expectedTag}. Bump package.json first or pass the matching tag.`,
  );
}

console.log(`Verifying release ${expectedTag}…`);

// 1. Release must exist + be published (not draft)
let release: {
  isDraft: boolean;
  tagName: string;
  url: string;
  assets: Array<{ name: string; size: number; state: string }>;
};
try {
  release = JSON.parse(
    execSync(`gh release view ${expectedTag} --json isDraft,tagName,url,assets`, {
      encoding: "utf8",
    }),
  );
} catch (err) {
  fail(`gh release view ${expectedTag} failed — release doesn't exist`);
}
if (release.isDraft) {
  fail(
    `Release ${expectedTag} is in DRAFT — publish it before users can download (gh release edit ${expectedTag} --draft=false)`,
  );
}
ok(`Release ${expectedTag} is published (URL: ${release.url})`);

// 2. Three required assets, each non-zero, all in 'uploaded' state
const expectedAssets = ["AmazonG-arm64.dmg", "AmazonG-arm64.zip", "latest-mac.yml"];
for (const name of expectedAssets) {
  const a = release.assets.find((x) => x.name === name);
  if (!a) fail(`Asset ${name} missing from release`);
  else if (a.size === 0) fail(`Asset ${name} has size=0`);
  else if (a.state !== "uploaded")
    fail(`Asset ${name} is in state '${a.state}' (expected 'uploaded')`);
  else ok(`Asset ${name} OK (${(a.size / 1024 / 1024).toFixed(1)} MB)`);
}

// 3. Local DMG sizes match the released DMG (catches "uploaded
//    something but not the latest build" mistakes)
const localDmg = statSync(join(ROOT, "release", "AmazonG-arm64.dmg")).size;
const remoteDmg = release.assets.find((a) => a.name === "AmazonG-arm64.dmg")!.size;
if (localDmg !== remoteDmg) {
  fail(
    `Local DMG size (${localDmg}) ≠ uploaded DMG size (${remoteDmg}) — did you re-build after creating the release? Re-upload with 'gh release upload ${expectedTag} release/AmazonG-arm64.dmg --clobber'.`,
  );
}
ok(`Local DMG matches released DMG (${localDmg} bytes)`);

// 4. /releases/latest must redirect to THIS tag. Use -I (HEAD) without
//    -L so we capture the FIRST redirect target — which is the
//    /releases/download/vX.Y.Z/... URL we want to assert against.
//    Following all redirects (-L) lands on a signed asset URL that
//    no longer contains the tag, defeating the check.
const latestUrl = execSync(
  `curl -sI "https://github.com/pepe-gang/AmazonG/releases/latest/download/AmazonG-arm64.dmg" | awk -F': ' '/^[Ll]ocation:/ { print $2 }' | tr -d '\\r\\n'`,
  { encoding: "utf8" },
).trim();
if (!latestUrl.includes(expectedTag)) {
  fail(
    `'releases/latest/download/...' redirects to ${latestUrl || "(empty)"} — expected URL containing ${expectedTag}. Either the release isn't published, or there's a NEWER release already.`,
  );
}
ok(`releases/latest resolves to ${expectedTag}`);

// 5. BG version.json must serve the same version
const versionJson = execSync(
  `curl -s -m 10 ${bgUrl}/downloads/version.json`,
  { encoding: "utf8" },
);
let parsed: { latestVersion: string };
try {
  parsed = JSON.parse(versionJson);
} catch {
  fail(`BG ${bgUrl}/downloads/version.json returned non-JSON: ${versionJson.slice(0, 80)}`);
}
if (parsed.latestVersion !== expectedVersion) {
  fail(
    `BG version.json says ${parsed.latestVersion}, expected ${expectedVersion}. Bump public/downloads/version.json on BG and re-deploy with 'vercel --prod --yes'.`,
  );
}
ok(`BG version.json serves ${expectedVersion}`);

console.log(`\n✅ Release ${expectedTag} verified end-to-end. Users will see the update banner.`);

// ── helpers ──────────────────────────────────────────────────────

function ok(msg: string) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg: string): never {
  console.error(`  ✗ ${msg}`);
  process.exit(1);
}
