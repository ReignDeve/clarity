# Releases & auto-updates (Nexus ReleaseHub)

This application (**CLARITY**) is distributed through Nexus ReleaseHub at https://nexus.cloud.jonasbl.de.
The source repository may be private; builds, update checks and changelogs are served by Nexus.

| | |
| --- | --- |
| Organization / project | `aevar/clarity` |
| Panel | https://nexus.cloud.jonasbl.de/o/aevar/p/clarity |
| Public download page | https://nexus.cloud.jonasbl.de/aevar/clarity |
| Update endpoint | `https://nexus.cloud.jonasbl.de/api/v1/update/aevar/clarity/{channel}?platform=&arch=&current=&device=` |
| Changelog feed | https://nexus.cloud.jonasbl.de/aevar/clarity/changelog.rss |

## Channels
| Slug | Name | Access |
| --- | --- | --- |
| `stable` | Stable (default) | public |

## How to release (agents: follow exactly)
1. Bump the version in the app's manifest(s). It must be SemVer and identical to the release version.
2. Build the artifacts for every supported platform.
3. Release – pick one:
   - CLI: `nexus ship <version> <files…> --changelog-from-git --publish` (add `--channel <slug>`, `--rollout <percent>`)
   - MCP: `create_release` → `upload_artifacts` → `publish_release`
4. Verify: `nexus release show <version>` lists one artifact per platform; the update endpoint returns the new version.

Credentials: `NEXUS_URL` + `NEXUS_TOKEN` environment variables or `nexus login`. Never commit tokens and never
embed a management token in the app.

**In this repository:** `pnpm release <patch|minor|major|x.y.z> [--notes "…"]` does all of the above
(`scripts/release.mjs`: bumps package.json + Cargo.toml + tauri.conf.json, builds, uploads the NSIS and MSI
installers via the REST API, publishes to `stable`). It needs `NEXUS_TOKEN` in the environment.
Bundles are uploaded **without** `.sig` files: Nexus signs them with the project key that matches the
`pubkey` in `tauri.conf.json` (`createUpdaterArtifacts` stays off so no local signing key is needed).

## Update signing & native updater feeds
| Key | Value |
| --- | --- |
| Ed25519 public key (SDKs, `nexusSignature`) | `BJFda3TmU/VVV0s4KRVvI2Qg7ydhAHLAnegaDN3rH8Y=` |
| Tauri updater `pubkey` | `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRkZGNTU3ODM1QTA3QTBFOApSV1Rvb0FkYWcxZjEvd1NSWFd0MDVsUDFWVmRMT0NrVmJ5TmtJTzhuWVFCeXdKM29HZ3pkNngvRwo=` |

| Updater | Feed URL (channel `stable`) |
| --- | --- |
| Tauri v2 | `https://nexus.cloud.jonasbl.de/api/v1/compat/tauri/aevar/clarity/stable/{{target}}/{{arch}}/{{current_version}}` |

## How updates work in this app
`src/lib/updates.ts` uses `@tauri-apps/plugin-updater` against the Tauri feed above, sending a persistent
anonymous device id (`X-Nexus-Device`, stored in settings) for staged rollouts. It checks ~5 s after start
and every 6 hours (10 s timeout, never blocking), downloads in the background when "Install updates
automatically" is on, and shows "Restart to update" in the title bar; installing runs the NSIS installer in
passive mode and relaunches. Settings → Updates offers "Check now" and the toggle.

When changing update code: keep checks non-blocking (timeout ~10 s), respect `mandatory`, keep the device id
stable across updates, and never downgrade.

## Changelog conventions
Use Conventional Commits (`feat:`, `fix:`, `perf:` …). Entries are categorized as added / changed / fixed /
removed / security / deprecated; internal-only notes use audience `technical`. Write user-facing entries in
plain, factual language (no "you"-style marketing).
