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

## Update signing & native updater feeds
| Key | Value |
| --- | --- |
| Ed25519 public key (SDKs, `nexusSignature`) | `BJFda3TmU/VVV0s4KRVvI2Qg7ydhAHLAnegaDN3rH8Y=` |
| Tauri updater `pubkey` | `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXkgRkZGNTU3ODM1QTA3QTBFOApSV1Rvb0FkYWcxZjEvd1NSWFd0MDVsUDFWVmRMT0NrVmJ5TmtJTzhuWVFCeXdKM29HZ3pkNngvRwo=` |

| Updater | Feed URL (channel `stable`) |
| --- | --- |
| Tauri v2 | `https://nexus.cloud.jonasbl.de/api/v1/compat/tauri/aevar/clarity/stable/{{target}}/{{arch}}/{{current_version}}` |
| electron-updater (generic) | `https://nexus.cloud.jonasbl.de/api/v1/compat/electron/aevar/clarity/stable` |
| Sparkle appcast | `https://nexus.cloud.jonasbl.de/api/v1/compat/sparkle/aevar/clarity/stable/appcast.xml` |
| Velopack | `https://nexus.cloud.jonasbl.de/api/v1/compat/velopack/aevar/clarity/stable` |

## How updates work in this app
The app calls the update endpoint (no auth) with its platform, arch, current version and an anonymous,
persisted device id. `204` = up to date; `200` returns version, notes, `mandatory` and a signed, expiring
download URL with sha256 and an Ed25519 `nexusSignature`. Download, verify signature + sha256, install, restart.
Apps built with Electron, Tauri, Sparkle or Velopack use their native updater with the feed above instead.
Details: `nexus guide update-integration` (or MCP `get_integration_guide`) and the framework guides
`electron`, `tauri`, `sparkle`, `velopack`.

When changing update code: keep checks non-blocking (timeout ~10 s), respect `mandatory`, keep the device id
stable across updates, and never downgrade.

## Changelog conventions
Use Conventional Commits (`feat:`, `fix:`, `perf:` …) so `--changelog-from-git` can draft entries. Entries are
categorized as added / changed / fixed / removed / security / deprecated; internal-only notes use audience `technical`.
