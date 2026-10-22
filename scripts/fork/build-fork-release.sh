#!/usr/bin/env bash
# Build the Paseo Hub soft fork, prove the tarball starts, publish it to a
# GitHub Release on the fork.
#
# This script is deliberately mechanical. The caller fetches origin and puts the
# checkout on main at origin/main. This script refuses every other source commit.
#
# The version is stamped only inside a throwaway clone, never in the checkout,
# and the smoke start uses a temporary data directory, never the live
# ~/.local/share/paseo-hub.
#
# Prints "fork_version=<version>" on the last line so the caller can pin it
# without parsing the whole log.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${PASEO_HUB_FORK_SRC:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"
FORK_REPO="${PASEO_HUB_FORK_REPO:-kiawin/paseo-hub}"
FORK_ID="${PASEO_HUB_FORK_ID:-kiawin}"
# The lockfile resolves every package on the public registry. A user-level
# registry (a private mirror with an expired token, say) would break npm ci.
export npm_config_registry="${PASEO_HUB_FORK_NPM_REGISTRY:-https://registry.npmjs.org/}"

DRY_RUN=false
SKIP_HEALTH=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    # Escape hatch for a host that cannot spare a port. Publishing an
    # unverified build is how a bad merge reaches the service, so say so loudly.
    --skip-health-check) SKIP_HEALTH=true ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

log() { printf '\n== %s\n' "$1"; }
die() { printf 'error: %s\n' "$1" >&2; exit 1; }

for tool in node npm git gh shasum; do
  command -v "$tool" >/dev/null || die "$tool is required"
done

# ---------------------------------------------------------------------------
# 1. Resolve the source commit
# ---------------------------------------------------------------------------
[ -e "$SRC_DIR/.git" ] || die "no git checkout at $SRC_DIR"
cd "$SRC_DIR"

[ -z "$(git status --porcelain)" ] || die "working tree at $SRC_DIR is dirty; commit or reset before building"

# Prove gh works before spending minutes on a build. A dry run is checked too:
# its job is to prove the publish path, and one that passes while the real run
# dies at publish has told you nothing.
if ! GH_ERR="$(gh auth status 2>&1)"; then
  printf '%s\n' "$GH_ERR" >&2
  die "gh is not usable from $SRC_DIR (see above)"
fi
gh repo view "$FORK_REPO" --json name >/dev/null || die "cannot read $FORK_REPO with gh"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
COMMIT="$(git rev-parse HEAD)"
SHORT_SHA="$(git rev-parse --short=7 HEAD)"
[ "$BRANCH" = "main" ] || die "build checkout must be on main, not $BRANCH"
ORIGIN_MAIN="$(git rev-parse --verify refs/remotes/origin/main 2>/dev/null)" \
  || die "refs/remotes/origin/main is missing; fetch origin before building"
[ "$COMMIT" = "$ORIGIN_MAIN" ] \
  || die "HEAD $COMMIT does not match fetched origin/main $ORIGIN_MAIN"

# ---------------------------------------------------------------------------
# 2. Compute the fork version
# ---------------------------------------------------------------------------
# Keep upstream's version as the base and append the fork identifier plus the
# commit, so the string states its own lineage and is reproducible from the SHA.
# The "g" prefix keeps the identifier from being all-digits, which semver
# rejects when it carries a leading zero.
BASE_VERSION="$(node -p "require('./package.json').version")"
FORK_VERSION="$(
  node -e '
    const [base, id, sha] = process.argv.slice(1);
    const m = /^(\d+\.\d+\.\d+)(?:-(.+?))?(?:\+.*)?$/.exec(base);
    if (!m) throw new Error(`package.json version is not semver: ${base}`);
    const [, core, pre] = m;
    process.stdout.write(pre ? `${core}-${pre}.${id}.g${sha}` : `${core}-${id}.g${sha}`);
  ' "$BASE_VERSION" "$FORK_ID" "$SHORT_SHA"
)"
FORK_TAG="fork-$FORK_VERSION"
TARBALL="getpaseo-hub-$FORK_VERSION.tgz"

log "fork build"
printf '  source    %s\n  branch    %s\n  commit    %s\n  upstream  %s\n  version   %s\n' \
  "$SRC_DIR" "$BRANCH" "$COMMIT" "$BASE_VERSION" "$FORK_VERSION"

WORK_DIR="$(mktemp -d)"
BUILD_DIR="$WORK_DIR/build"
OUT_DIR="$WORK_DIR/out"
STAGE_PREFIX="$WORK_DIR/prefix"
STAGE_HOME="$WORK_DIR/home"
STAGE_DATA="$WORK_DIR/data"
mkdir -p "$OUT_DIR" "$STAGE_PREFIX" "$STAGE_HOME" "$STAGE_DATA"
HUB_PID=""

cleanup() {
  if [ -n "$HUB_PID" ]; then
    kill "$HUB_PID" 2>/dev/null || true
    wait "$HUB_PID" 2>/dev/null || true
  fi
  rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 3. Build tree: a clone of the exact commit, stamped with the fork version
# ---------------------------------------------------------------------------
log "cloning $SHORT_SHA into a throwaway build tree"
git clone --quiet "$SRC_DIR" "$BUILD_DIR"
git -C "$BUILD_DIR" checkout --quiet --detach "$COMMIT"
cd "$BUILD_DIR"

log "stamping $FORK_VERSION"
npm version "$FORK_VERSION" --no-git-tag-version --ignore-scripts >/dev/null

log "npm ci"
npm ci --no-audit --no-fund

log "build"
npm run build

log "test"
npm test

# ---------------------------------------------------------------------------
# 4. Pack
# ---------------------------------------------------------------------------
# prepack only reruns the build that just ran and was tested; skip it so the
# tarball holds exactly that output.
log "pack"
npm pack --ignore-scripts --pack-destination "$OUT_DIR" >/dev/null
[ -f "$OUT_DIR/$TARBALL" ] || die "expected tarball $TARBALL was not produced"
SHA256="$(shasum -a 256 "$OUT_DIR/$TARBALL" | cut -d' ' -f1)"
printf '  %s\n  sha256 %s\n' "$TARBALL" "$SHA256"

# ---------------------------------------------------------------------------
# 5. Prove the tarball starts
# ---------------------------------------------------------------------------
# Install the thing that ships into a throwaway prefix and start it on a spare
# loopback port with its own HOME and data directory. DATABASE_URL is cleared so
# it uses the embedded database inside that directory.
if [ "$SKIP_HEALTH" = true ]; then
  log "SKIPPING health check (--skip-health-check) — publishing an unverified build"
else
  log "staging install into a throwaway prefix"
  npm install --prefix "$STAGE_PREFIX" --no-audit --no-fund "$OUT_DIR/$TARBALL" >/dev/null
  installed="$(node -p "require('$STAGE_PREFIX/node_modules/@getpaseo/hub/package.json').version")"
  [ "$installed" = "$FORK_VERSION" ] || die "@getpaseo/hub installed as $installed, expected $FORK_VERSION"
  printf '  ok  @getpaseo/hub %s\n' "$installed"

  HEALTH_PORT="${PASEO_HUB_FORK_HEALTH_PORT:-$(
    node -e '
      const server = require("node:net").createServer();
      server.listen(0, "127.0.0.1", () => {
        process.stdout.write(String(server.address().port));
        server.close();
      });
    '
  )}"
  live_data="$(cd ~ && pwd)/.local/share/paseo-hub"
  [ "$STAGE_DATA" != "$live_data" ] || die "refusing to smoke-start against $live_data"

  log "starting the staged hub on 127.0.0.1:$HEALTH_PORT"
  env -u DATABASE_URL \
    HOME="$STAGE_HOME" \
    XDG_DATA_HOME="$STAGE_HOME/.local/share" \
    PASEO_HUB_DATA_DIR="$STAGE_DATA" \
    PASEO_HUB_BIND=127.0.0.1 \
    PORT="$HEALTH_PORT" \
    NODE_ENV=production \
    "$STAGE_PREFIX/node_modules/.bin/paseo-hub" >"$WORK_DIR/hub.log" 2>&1 &
  HUB_PID=$!

  healthy=false
  for _ in $(seq 1 60); do
    kill -0 "$HUB_PID" 2>/dev/null || break
    if node -e "
      require('node:http').get(
        {hostname:'127.0.0.1',port:$HEALTH_PORT,path:'/health',timeout:2000},
        (r) => {
          let body = '';
          r.on('data', (c) => (body += c));
          r.on('end', () => process.exit(r.statusCode === 200 && JSON.parse(body).ok === true ? 0 : 1));
        },
      ).on('error', () => process.exit(1));
    " 2>/dev/null; then
      healthy=true
      break
    fi
    sleep 2
  done

  if [ "$healthy" != true ]; then
    tail -50 "$WORK_DIR/hub.log" >&2 || true
    die "staged hub never answered {\"ok\":true} on /health — not publishing"
  fi
  printf '  ok  /health answered ok\n'
  kill "$HUB_PID" 2>/dev/null || true
  wait "$HUB_PID" 2>/dev/null || true
  HUB_PID=""
fi

# ---------------------------------------------------------------------------
# 6. Manifest
# ---------------------------------------------------------------------------
# The release has no registry metadata, so this file is what a consumer reads to
# learn the version and the tarball URL without guessing asset names.
node -e '
  const fs = require("node:fs");
  const [out, version, upstreamVersion, commit, repo, tag, name, sha256] = process.argv.slice(1);
  const url = `https://github.com/${repo}/releases/download/${tag}/${name}`;
  const manifest = { version, upstreamVersion, commit, tarball: { name, url, sha256 } };
  fs.writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
' "$OUT_DIR" "$FORK_VERSION" "$BASE_VERSION" "$COMMIT" "$FORK_REPO" "$FORK_TAG" "$TARBALL" "$SHA256"

if [ "$DRY_RUN" = true ]; then
  log "dry run — built and verified, nothing published"
  cat "$OUT_DIR/manifest.json"
  echo "fork_release_tag=$FORK_TAG"
  echo "fork_version=$FORK_VERSION"
  exit 0
fi

# ---------------------------------------------------------------------------
# 7. Publish
# ---------------------------------------------------------------------------
# One immutable release per source commit. An existing release is accepted only
# when its tag and manifest name this exact commit; it is never overwritten.
log "publishing to $FORK_REPO release $FORK_TAG"
if gh release view "$FORK_TAG" --repo "$FORK_REPO" >/dev/null 2>&1; then
  release_ref="$(gh api "repos/$FORK_REPO/git/ref/tags/$FORK_TAG" --jq '[.object.type,.object.sha] | @tsv')"
  [ "$release_ref" = $'commit\t'"$COMMIT" ] \
    || die "release $FORK_TAG already exists but its tag does not point to $COMMIT"

  published_assets="$(gh release view "$FORK_TAG" --repo "$FORK_REPO" --json assets --jq '.assets[].name')"
  for expected in manifest.json "$TARBALL"; do
    printf '%s\n' "$published_assets" | grep -Fxq "$expected" \
      || die "release $FORK_TAG already exists without $expected"
  done

  mkdir -p "$WORK_DIR/published"
  gh release download "$FORK_TAG" --repo "$FORK_REPO" --pattern manifest.json --dir "$WORK_DIR/published"
  node -e '
    const fs = require("node:fs");
    const [file, version, commit] = process.argv.slice(1);
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [key, expected] of Object.entries({ version, commit })) {
      if (manifest[key] !== expected) {
        throw new Error(`published manifest ${key}=${manifest[key]}, expected ${expected}`);
      }
    }
  ' "$WORK_DIR/published/manifest.json" "$FORK_VERSION" "$COMMIT"
  gh release edit "$FORK_TAG" --repo "$FORK_REPO" --latest >/dev/null
  log "immutable release already exists and matches"
  printf '  https://github.com/%s/releases/tag/%s\n' "$FORK_REPO" "$FORK_TAG"
  echo "fork_release_tag=$FORK_TAG"
  echo "fork_version=$FORK_VERSION"
  exit 0
fi

gh release create "$FORK_TAG" \
  "$OUT_DIR/$TARBALL" "$OUT_DIR/manifest.json" \
  --repo "$FORK_REPO" \
  --target "$COMMIT" \
  --title "Paseo Hub fork $FORK_VERSION" \
  --notes "Immutable soft-fork build of Paseo Hub $BASE_VERSION from $COMMIT. Read manifest.json for the version, tarball URL, and SHA-256." \
  --latest >/dev/null

log "published"
printf '  https://github.com/%s/releases/tag/%s\n' "$FORK_REPO" "$FORK_TAG"
echo "fork_release_tag=$FORK_TAG"
echo "fork_version=$FORK_VERSION"
