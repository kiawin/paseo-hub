# Fork

`kiawin/paseo-hub` is a soft fork of [`getpaseo/hub`](https://github.com/getpaseo/hub). It carries
a small number of fixes ahead of upstream and ships its own builds as GitHub Releases. It publishes
nothing to npm, GHCR, or Fly.

## Remotes

| Remote     | Repository         | Role                                       |
| ---------- | ------------------ | ------------------------------------------ |
| `origin`   | `kiawin/paseo-hub` | The fork. Pull requests merge into `main`. |
| `upstream` | `getpaseo/hub`     | The source. Merge `upstream/main` to sync. |

Every fork change should be small enough to send upstream as a pull request. Once upstream merges
it, the next sync drops the fork's copy.

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
2. Runs `npm ci`, `npm run build`, and `npm test`, then `npm pack`.
3. Installs the tarball into a temporary prefix and starts it on a spare loopback port with a
   temporary `HOME` and `PASEO_HUB_DATA_DIR`, and waits for `/health` to answer `{"ok":true}`.
   It never reads or writes `~/.local/share/paseo-hub`.
4. Writes `manifest.json` and creates the immutable release `fork-<version>` on
   `kiawin/paseo-hub` with the tarball and manifest attached, marked latest.

Rerunning on a commit that already has a release verifies that the existing tag and manifest match
that commit and marks it latest again; it never replaces assets. The last line of output is
`fork_version=<version>`.

| Variable                      | Default                         |
| ----------------------------- | ------------------------------- |
| `PASEO_HUB_FORK_SRC`          | The checkout holding the script |
| `PASEO_HUB_FORK_REPO`         | `kiawin/paseo-hub`              |
| `PASEO_HUB_FORK_ID`           | `kiawin`                        |
| `PASEO_HUB_FORK_NPM_REGISTRY` | `https://registry.npmjs.org/`   |
| `PASEO_HUB_FORK_HEALTH_PORT`  | A free port picked at start     |

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
