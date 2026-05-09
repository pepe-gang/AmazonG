# Claude operating notes for AmazonG

Project-level guidance Claude should follow in any session, regardless of memory state. Build spec lives in `AGENTS.md`; this file is for operational/release procedures and known gotchas.

## Release pipeline (READ BEFORE SHIPPING)

AmazonG releases require **two repos** and a **manual Vercel deploy**. Skipping any step leaves users without the update banner.

### Full sequence

1. **Commit + push AmazonG `main`**
   - Bump `package.json` version (patch by convention: `0.13.X`).
   - One commit per release with summary + bullet body, prefixed `vX.Y.Z:`. Match existing `git log --oneline` style.
   - `git push origin main`.

2. **Build the DMG locally**
   - `npm run package:signed` — takes 5–10 min, outputs to `release/`.
   - Produces three artifacts: `AmazonG-arm64.dmg` (~350MB), `AmazonG-arm64.zip` (~340MB), `latest-mac.yml` (electron-builder auto-update manifest, ~500B).

3. **Create the GitHub Release**
   - `gh release create vX.Y.Z release/AmazonG-arm64.dmg release/AmazonG-arm64.zip release/latest-mac.yml --title "vX.Y.Z" --notes "..."`
   - Notes should mirror the commit body. Use markdown.
   - The download URL `github.com/pepe-gang/AmazonG/releases/latest/download/AmazonG-arm64.dmg` resolves to whichever release is tagged latest, so just creating the release is enough — no separate "promote" step.
   - **Watch for these failure modes** (which `npm run release:verify` in step 6 catches automatically — but if you skip the verify step they bite silently):
     - `gh release create` with a 350+ MB DMG sometimes returns BEFORE asset upload completes. The release URL comes back as `untagged-XXXX...` (draft, missing DMG/ZIP) and `releases/latest/download/...` falls through to the previous version. Users click "Download Now" and get the OLD DMG — exactly the v0.13.31 incident on 2026-05-09.
     - If you see `untagged-...` in the URL, run `gh release upload vX.Y.Z release/AmazonG-arm64.dmg release/AmazonG-arm64.zip --clobber` and `gh release edit vX.Y.Z --draft=false` to publish.

4. **Bump the BG manifest** (in `~/Projects/Better-BuyingGroup`)
   - Edit `public/downloads/version.json` — change `latestVersion` to the new version.
   - Commit + `git push origin main`.

5. **Deploy BG to Vercel — MANUAL STEP, DO NOT SKIP**
   - `cd ~/Projects/Better-BuyingGroup && vercel --prod --yes`
   - **The BG repo is NOT wired for Vercel git auto-deploy** (user opted out due to cost, 2026-05-03). `git push` alone leaves the live `/api/autog/version` endpoint serving the previous manifest, and AmazonG users never see the update banner.
   - The version-endpoint code (`Better-BuyingGroup/src/app/api/autog/version/route.ts`) documents this in the route's docstring — search for "vercel --prod" if you forget.

6. **Verify the release end-to-end — ALWAYS RUN, DO NOT SKIP**
   - From AmazonG repo root: `npm run release:verify -- vX.Y.Z`
   - Hard-checks that catch every release-pipeline failure mode we've hit:
     1. Release exists + is published (not draft)
     2. All 3 assets uploaded (DMG, ZIP, latest-mac.yml) at expected sizes — catches the silent draft-with-empty-assets case
     3. Local `release/AmazonG-arm64.dmg` byte-size matches the uploaded one — catches "uploaded an old build"
     4. `releases/latest/download/AmazonG-arm64.dmg` redirects to THIS tag — catches missing publish
     5. `https://betterbg.vercel.app/downloads/version.json` returns the new version — catches missing `vercel --prod`
   - Exit code 1 on any failure with a remediation hint.
   - When this script prints "✅ Release vX.Y.Z verified end-to-end" the release is genuinely live for users.

### When users will see the update

- Existing AmazonG instances poll `/api/autog/version` every 1 hour (set in v0.13.10).
- The "Check for updates" button in the AmazonG header bypasses the poll for immediate testing.
- The auto-update banner appears whenever the user's version < `latestVersion`.

### Branch hygiene after release

- Feature branches that were merged into `main` should be deleted locally: `git branch -d <name>`. Remote feature branches usually weren't pushed (only `main` is), so a `git push origin --delete <name>` may say "remote ref does not exist" — that's fine.

## Known operational gotchas

- **Vercel auto-deploy is off.** See release pipeline step 5.
- **Saved `settings.json` overrides defaults.** When you bump a default value in `src/main/settings.ts`, existing installs keep their saved value. Mention this in the release notes if user-facing behavior depends on the new default.
- **The audited bug list lives in the user's session memory** (`~/.claude/projects/-Users-jack-Projects-AmazonG/memory/`). Read those files at the start of any session that involves filler-mode, AmazonG ↔ BG architecture, or scheduling decisions — they encode user preferences and prior incidents.

## Quick triage

- **"Stuck at Verify ready" rows in the table** → the verify handler probably bails on a profile match (`pollAndScrape.ts:1127-1133`) or `verifyOrder` keeps timing out. Check log for `job.verify.profile_missing` / `job.verify.error` / `job.verify.timeout`.
- **"Invisible parallelism" reports** → after the HTTP-first work (v0.13.11+), filler-add and cart-clear don't navigate any tabs. Multiple windows look idle even when all are working in parallel. Check `step.fillerBuy.add.http.ok` log lines for proof.
- **Update banner not showing** → almost certainly step 5 (manual `vercel --prod`) was skipped. Run `npm run release:verify -- vX.Y.Z` to find the exact failed step.
- **"Download Now" hands users an old DMG** → release got stuck in draft (asset upload silently timed out during `gh release create`). `gh release view vX.Y.Z` will show `draft: true`. Fix: `gh release upload vX.Y.Z release/AmazonG-arm64.dmg release/AmazonG-arm64.zip --clobber` + `gh release edit vX.Y.Z --draft=false`. v0.13.31 hit this on 2026-05-09 — `npm run release:verify` was added the same day to make it loud instead of silent.
