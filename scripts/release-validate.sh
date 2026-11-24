#!/usr/bin/env bash
set -euo pipefail

# Validate release metadata, event-specific publish decision, version parity,
# and pre-build GitHub tag/Release state.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck source=scripts/lib/release-state.sh
. "$SCRIPT_DIR/lib/release-state.sh"

cd "${RELEASE_WORKDIR:-$REPO_ROOT}"

APP_VERSION="$(jq -r '.version' apps/desktop/src-tauri/tauri.conf.json)"
if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" = "null" ]; then
  echo "Error: Could not read version from apps/desktop/src-tauri/tauri.conf.json." >&2
  exit 1
fi

CARGO_VERSION="$(awk '
  /^\[workspace\.package\]$/ { in_section=1; next }
  /^\[/ { in_section=0 }
  in_section && /^version[[:space:]]*=/ {
    gsub(/^version[[:space:]]*=[[:space:]]*"|".*$/, "")
    print
    exit
  }
' Cargo.toml)"

if [ "$CARGO_VERSION" != "$APP_VERSION" ]; then
  echo "Error: Cargo.toml workspace version (${CARGO_VERSION}) does not match tauri.conf.json version (${APP_VERSION})." >&2
  exit 1
fi

BUILD_SHA="${BUILD_SHA:-$(git rev-parse HEAD)}"
if ! printf '%s' "$BUILD_SHA" | grep -Eq '^[0-9a-f]{40}$'; then
  echo "Error: Expected 40-character commit SHA for BUILD_SHA, got '${BUILD_SHA}'." >&2
  exit 1
fi

EVENT_NAME="${EVENT_NAME:-}"
REF_NAME="${REF_NAME:-}"
GITHUB_REF="${GITHUB_REF:-}"
INPUT_CREATE_RELEASE="${INPUT_CREATE_RELEASE:-false}"
INPUT_TAG="${INPUT_TAG:-}"
INPUT_ALLOW_UNSIGNED="${INPUT_ALLOW_UNSIGNED:-false}"

SHOULD_RELEASE=false
TAG_NAME=""

case "$EVENT_NAME" in
  push)
    case "$GITHUB_REF" in
      refs/tags/v*)
        SHOULD_RELEASE=true
        TAG_NAME="${REF_NAME:-${GITHUB_REF#refs/tags/}}"
        ;;
      *)
        echo "Error: Release push trigger requires a v* tag ref, got '${GITHUB_REF}'." >&2
        exit 1
        ;;
    esac
    ;;
  workflow_dispatch)
    # Manual dispatch releases ONLY when create_release=true, regardless of
    # whether it was dispatched from a branch or an existing v* tag ref.
    if [ "$INPUT_CREATE_RELEASE" = "true" ]; then
      if [ "$INPUT_ALLOW_UNSIGNED" = "true" ]; then
        echo "Error: Cannot create a GitHub Release from an unsigned macOS build (allow_unsigned=true)." >&2
        exit 1
      fi
      SHOULD_RELEASE=true
      if [ -n "$INPUT_TAG" ]; then
        TAG_NAME="$INPUT_TAG"
      else
        TAG_NAME="v${APP_VERSION}"
      fi
    else
      SHOULD_RELEASE=false
      TAG_NAME=""
    fi
    ;;
  *)
    echo "Error: Unsupported GitHub event '${EVENT_NAME}'." >&2
    exit 1
    ;;
esac

if [ "$SHOULD_RELEASE" = "true" ]; then
  case "$TAG_NAME" in
    *[[:space:]]*|*/*)
      echo "Error: Release tag '${TAG_NAME}' contains invalid whitespace or '/' characters." >&2
      exit 1
      ;;
    v*) ;;
    *)
      echo "Error: Release tag '${TAG_NAME}' must start with 'v'." >&2
      exit 1
      ;;
  esac

  if [ "${TAG_NAME#v}" != "$APP_VERSION" ]; then
    echo "Error: Tag '${TAG_NAME}' does not match tauri.conf.json version '${APP_VERSION}'." >&2
    exit 1
  fi

  if [ -z "${GITHUB_REPOSITORY:-}" ]; then
    echo "Error: GITHUB_REPOSITORY must be set when should_release=true." >&2
    exit 1
  fi

  # Pre-build check catches mismatched remote tags and published releases early.
  # Note: tokens with contents:read may not see unpublished drafts; publish-release
  # repeats this check with contents:write right before creating/uploading.
  check_release_target_state "$GITHUB_REPOSITORY" "$TAG_NAME" "$BUILD_SHA" >/dev/null
fi

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    echo "should_release=${SHOULD_RELEASE}"
    echo "tag_name=${TAG_NAME}"
    echo "app_version=${APP_VERSION}"
    echo "build_sha=${BUILD_SHA}"
  } >> "$GITHUB_OUTPUT"
fi

echo "Validated metadata: event=${EVENT_NAME}, should_release=${SHOULD_RELEASE}, tag_name=${TAG_NAME:-<none>}, app_version=${APP_VERSION}, build_sha=${BUILD_SHA}"
