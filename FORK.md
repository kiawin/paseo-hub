# Fork

`kiawin/paseo-hub` is a soft fork of [`getpaseo/hub`](https://github.com/getpaseo/hub). It carries
a small number of fixes ahead of upstream and ships its own builds as GitHub Releases. It publishes
nothing to npm, GHCR, or Fly.

## Remotes

| Remote     | Repository         | Role                                                        |
| ---------- | ------------------ | ----------------------------------------------------------- |
| `origin`   | `kiawin/paseo-hub` | The fork. Fork changes are squash-merged into `main`.       |
| `upstream` | `getpaseo/hub`     | The source. `main` is rebased onto `upstream/main` to sync. |

Every fork change should be small enough to send upstream as a pull request. Once upstream merges
it, the next sync drops the fork's copy.

## Sync with upstream

`main` is always `upstream/main` plus a few squashed fork commits on top: linear, with no merge
commits. A sync keeps that shape by rebasing, never by merging.

```sh
git fetch upstream
git fetch origin
git switch -C sync/kiawin-paseo-hub origin/main
git rebase upstream/main
git push --force-with-lease origin sync/kiawin-paseo-hub
gh pr create --repo kiawin/paseo-hub --base main --head sync/kiawin-paseo-hub \
  --title "Sync getpaseo/hub - $(date +%F)"
```

- Stop if `upstream/main` has not moved since the last sync.
- Resolve each conflict inside the fork commit being replayed, with the smallest edit. Do not add
  a separate conflict-resolution or merge commit, and do not run a formatter while resolving.
- A fork commit the rebase drops means upstream accepted it. That is the goal.
- Always pass `--repo kiawin/paseo-hub` to `gh`; otherwise it targets the upstream parent.

Review the pull request, then land it with a force-push, not the Merge button. The branch is
`main` rebased, not a superset of it, so merging would add a merge commit and a duplicate of every
rebased commit:

```sh
git push --force-with-lease origin origin/sync/kiawin-paseo-hub:main
```

A daily Paseo schedule on the homelab host runs this sync and opens or updates the pull request.
It never pushes `main` and never cuts a release.

## Upstream-only workflows

`release.yml`, `release-notes-sync.yml`, and `deploy-fly.yml` publish the GHCR image and GitHub
Release, sync release notes, and deploy the hosted service. Each job is guarded with
`if: github.repository == 'getpaseo/hub'`, so on the fork they are skipped. CI (`ci.yml`) is
unguarded and runs wherever Actions are enabled.

## Versions

A fork build keeps upstream's version and appends the fork identifier and the source commit:

```
<upstream version>-kiawin.g<sha7>      e.g. 0.10.0-kiawin.g7cbdd52
```

The version exists only in the build. `package.json` on `main` keeps upstream's version, so a sync
never conflicts on it.

## Cut a release

```sh
git fetch origin
git switch main
git reset --hard origin/main
scripts/fork/build-fork-release.sh --dry-run   # build, test, smoke start, nothing published
scripts/fork/build-fork-release.sh             # same, then publish
```

The script refuses to run unless the checkout is clean, on `main`, and at the fetched
`origin/main`. It then:

1. Clones that commit into a temporary build tree and stamps the fork version there.
2. Runs `npm ci`, `npm run build`, and `npm test`, then `npm pack`. Tests run on at most half
   the cores, because one worker per core makes the Docker-backed tests time out on a workstation.
3. Installs the tarball into a temporary prefix and starts it on a spare loopback port with a
   temporary `HOME` and `PASEO_HUB_DATA_DIR`, and waits for `/health` to answer `{"ok":true}`.
   It never reads or writes `~/.local/share/paseo-hub`.
4. Writes `manifest.json` and creates the immutable release `fork-<version>` on
   `kiawin/paseo-hub` with the tarball and manifest attached, marked latest.

Rerunning on a commit that already has a release verifies that the existing tag and manifest match
that commit and marks it latest again; it never replaces assets. The last line of output is
`fork_version=<version>`.

| Variable                      | Default                                  |
| ----------------------------- | ---------------------------------------- |
| `PASEO_HUB_FORK_SRC`          | The checkout holding the script          |
| `PASEO_HUB_FORK_REPO`         | `kiawin/paseo-hub`                       |
| `PASEO_HUB_FORK_ID`           | `kiawin`                                 |
| `PASEO_HUB_FORK_NPM_REGISTRY` | `https://registry.npmjs.org/`            |
| `PASEO_HUB_FORK_HEALTH_PORT`  | A free port picked at start              |
| `PASEO_HUB_FORK_TEST_WORKERS` | `50%` (a count, or a share of the cores) |

`--skip-health-check` skips step 3 for a host that cannot start the server. It publishes an
unverified build; use it knowingly.

## Manifest

```json
{
  "version": "0.10.0-kiawin.g7cbdd52",
  "upstreamVersion": "0.10.0",
  "commit": "<40-character SHA>",
  "tarball": {
    "name": "getpaseo-hub-0.10.0-kiawin.g7cbdd52.tgz",
    "url": "https://github.com/kiawin/paseo-hub/releases/download/fork-0.10.0-kiawin.g7cbdd52/getpaseo-hub-0.10.0-kiawin.g7cbdd52.tgz",
    "sha256": "<hex>"
  }
}
```

`https://github.com/kiawin/paseo-hub/releases/latest/download/manifest.json` always points at the
newest release. A consumer reads it, downloads `tarball.url`, checks `tarball.sha256`, and installs
the tarball with `npm install`.
