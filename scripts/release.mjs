#!/usr/bin/env node
// Cut a release: bump the version everywhere, commit, tag and push.
// GitHub Actions (.github/workflows/release.yml) then builds, uploads to
// Nexus ReleaseHub and publishes; installed copies update themselves.
//
//   pnpm release patch | minor | major | 1.2.3   [--no-push]

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const run = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "inherit"] }).toString().trim();
const arg = process.argv[2];
const push = !process.argv.includes("--no-push");
if (!arg) {
  console.error("Usage: pnpm release <patch|minor|major|x.y.z> [--no-push]");
  process.exit(1);
}
if (run("git status --porcelain")) {
  console.error("Commit or stash your changes first; a release must match a clean commit.");
  process.exit(1);
}
const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(`Releases are cut from main (current: ${branch}).`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const [maj, min, pat] = pkg.version.split("-")[0].split(".").map(Number);
const next =
  arg === "patch" ? `${maj}.${min}.${pat + 1}` : arg === "minor" ? `${maj}.${min + 1}.0` : arg === "major" ? `${maj + 1}.0.0` : arg;
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(next)) {
  console.error(`Not a SemVer version: ${next}`);
  process.exit(1);
}
if (run(`git tag -l v${next}`)) {
  console.error(`v${next} already exists. Versions can only be released once.`);
  process.exit(1);
}

const edit = (file, fn) => writeFileSync(file, fn(readFileSync(file, "utf8")));
edit("package.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit("src-tauri/tauri.conf.json", (s) => s.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit("src-tauri/Cargo.toml", (s) => s.replace(/^version = "[^"]+"/m, `version = "${next}"`));
edit("src-tauri/Cargo.lock", (s) => s.replace(/(name = "clarity"\r?\nversion = )"[^"]+"/, `$1"${next}"`));

run("git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock");
run(`git commit -m "chore(release): v${next}"`);
run(`git tag -a v${next} -m "CLARITY ${next}"`);
console.log(`Prepared v${pkg.version} → v${next}.`);
if (push) {
  run("git push origin main");
  run(`git push origin v${next}`);
  console.log("Pushed. GitHub Actions now builds and publishes the release:");
  console.log("  https://github.com/ReignDeve/clarity/actions");
  console.log("  https://nexus.cloud.jonasbl.de/o/aevar/p/clarity");
} else {
  console.log(`Not pushed. Run: git push origin main && git push origin v${next}`);
}
