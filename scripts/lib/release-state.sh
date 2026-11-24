#!/usr/bin/env bash
# Shared GitHub tag and Release state checks for release-validate.sh and
# release-publish-draft.sh. Designed to be sourced by Bash 3.2+ scripts.

# Compute lowercase SHA-256 hex digest of a file using shasum or sha256sum.
compute_file_sha256() {
  local file_path="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file_path" | awk '{print $1}'
  else
    sha256sum "$file_path" | awk '{print $1}'
  fi
}

# Dereference refs/tags/<tag_name> to a commit SHA via GitHub REST API.
# Prints the 40-char commit SHA if the tag exists remotely, or empty string if absent.
# Handles both lightweight tags (object.type == "commit") and annotated/nested
# tags (object.type == "tag"). Fails non-zero on non-404 API errors or invalid targets.
resolve_remote_tag_commit() {
  local repo="$1"
  local tag_name="$2"
  local err_file
  err_file="$(mktemp)"

  local ref_json=""
  local rc=0
  set +e
  ref_json="$(gh api "repos/${repo}/git/ref/tags/${tag_name}" 2>"$err_file")"
  rc=$?
  set -e

  if [ "$rc" -ne 0 ]; then
    local err_msg=""
    err_msg="$(cat "$err_file")"
    rm -f "$err_file"
    if printf '%s\n%s' "$err_msg" "$ref_json" | grep -Eq 'HTTP 404|Not Found|"status"[[:space:]]*:[[:space:]]*"404"'; then
      printf ''
      return 0
    fi
    echo "Error: Failed to query remote tag 'refs/tags/${tag_name}': ${err_msg}" >&2
    return 1
  fi
  rm -f "$err_file"

  if [ -z "$ref_json" ]; then
    echo "Error: Empty response from git/ref/tags/${tag_name}." >&2
    return 1
  fi

  local json_type=""
  json_type="$(printf '%s' "$ref_json" | jq -r 'type')"
  if [ "$json_type" = "array" ]; then
    # GitHub returns prefix matches as an array if the exact ref does not exist.
    ref_json="$(printf '%s' "$ref_json" | jq -c --arg ref "refs/tags/${tag_name}" 'map(select(.ref == $ref)) | .[0] // empty')"
    if [ -z "$ref_json" ]; then
      printf ''
      return 0
    fi
  elif [ "$json_type" = "object" ]; then
    local msg=""
    msg="$(printf '%s' "$ref_json" | jq -r '.message // empty')"
    if [ "$msg" = "Not Found" ]; then
      printf ''
      return 0
    fi
    local actual_ref=""
    actual_ref="$(printf '%s' "$ref_json" | jq -r '.ref // empty')"
    if [ "$actual_ref" != "refs/tags/${tag_name}" ]; then
      echo "Error: Unexpected ref '${actual_ref}' returned for 'refs/tags/${tag_name}'." >&2
      return 1
    fi
  else
    echo "Error: Unexpected JSON type '${json_type}' from git/ref/tags/${tag_name}." >&2
    return 1
  fi

  local obj_type=""
  local obj_sha=""
  obj_type="$(printf '%s' "$ref_json" | jq -r '.object.type // empty')"
  obj_sha="$(printf '%s' "$ref_json" | jq -r '.object.sha // empty')"

  local hop=0
  while [ "$obj_type" = "tag" ]; do
    hop=$((hop + 1))
    if [ "$hop" -gt 8 ]; then
      echo "Error: Exceeded maximum tag dereference depth for '${tag_name}'." >&2
      return 1
    fi
    if [ -z "$obj_sha" ]; then
      echo "Error: Annotated tag '${tag_name}' is missing object SHA." >&2
      return 1
    fi
    local tag_json=""
    tag_json="$(gh api "repos/${repo}/git/tags/${obj_sha}")"
    obj_type="$(printf '%s' "$tag_json" | jq -r '.object.type // empty')"
    obj_sha="$(printf '%s' "$tag_json" | jq -r '.object.sha // empty')"
  done

  if [ "$obj_type" != "commit" ] || [ -z "$obj_sha" ]; then
    echo "Error: Remote tag '${tag_name}' resolved to unsupported object type '${obj_type}' (sha='${obj_sha}')." >&2
    return 1
  fi

  printf '%s' "$obj_sha"
}

# Verify that remote tag <tag_name> (if present) points to <build_sha>, no
# published Release exists for <tag_name>, and any existing draft Release is
# unambiguous and bound to <build_sha>.
# Prints existing draft Release ID to stdout, or empty string if none exists.
check_release_target_state() {
  local repo="$1"
  local tag_name="$2"
  local build_sha="$3"

  local remote_tag_commit=""
  remote_tag_commit="$(resolve_remote_tag_commit "$repo" "$tag_name")"
  if [ -n "$remote_tag_commit" ] && [ "$remote_tag_commit" != "$build_sha" ]; then
    echo "Error: Remote tag '${tag_name}' points to commit ${remote_tag_commit}, which differs from build commit ${build_sha}." >&2
    return 1
  fi

  local releases_json=""
  releases_json="$(gh api --paginate "repos/${repo}/releases")"

  local matches_json=""
  matches_json="$(printf '%s' "$releases_json" | jq -c -n --arg tag "$tag_name" '[inputs | .[]? | select(.tag_name == $tag)]')"

  local published_id=""
  published_id="$(printf '%s' "$matches_json" | jq -r '[.[] | select(.draft == false)] | .[0].id // empty')"
  if [ -n "$published_id" ]; then
    echo "Error: Release for tag '${tag_name}' is already published (id=${published_id}); refusing to modify or upload assets to a published release." >&2
    return 1
  fi

  local match_count=0
  match_count="$(printf '%s' "$matches_json" | jq 'length')"
  if [ "$match_count" -gt 1 ]; then
    echo "Error: Found ${match_count} draft releases for tag '${tag_name}'; resolve duplicate drafts before publishing." >&2
    return 1
  fi

  if [ "$match_count" -eq 1 ]; then
    local draft_id=""
    local draft_commitish=""
    draft_id="$(printf '%s' "$matches_json" | jq -r '.[0].id // empty')"
    draft_commitish="$(printf '%s' "$matches_json" | jq -r '.[0].target_commitish // empty')"
    if [ -z "$draft_id" ]; then
      echo "Error: Existing draft release for '${tag_name}' is missing an id." >&2
      return 1
    fi
    if [ "$draft_commitish" != "$build_sha" ]; then
      echo "Error: Existing draft release (id=${draft_id}) for '${tag_name}' is bound to target_commitish='${draft_commitish}', expected '${build_sha}'." >&2
      return 1
    fi
    printf '%s' "$draft_id"
    return 0
  fi

  printf ''
}

# Fetch a single release by ID and assert it is still a draft for <tag_name>
# bound to <build_sha>, with remote tag (if present) still pointing to <build_sha>
# and a valid upload_url matching that exact release ID.
# Prints the release JSON object on stdout.
fetch_verified_draft_release_json() {
  local repo="$1"
  local release_id="$2"
  local tag_name="$3"
  local build_sha="$4"

  local remote_tag_commit=""
  remote_tag_commit="$(resolve_remote_tag_commit "$repo" "$tag_name")"
  if [ -n "$remote_tag_commit" ] && [ "$remote_tag_commit" != "$build_sha" ]; then
    echo "Error: Remote tag '${tag_name}' points to commit ${remote_tag_commit}, which differs from build commit ${build_sha}." >&2
    return 1
  fi

  local release_json=""
  release_json="$(gh api "repos/${repo}/releases/${release_id}")"

  local actual_id=""
  local actual_tag=""
  local is_draft=""
  local commitish=""
  local upload_url=""
  actual_id="$(printf '%s' "$release_json" | jq -r '.id // empty')"
  actual_tag="$(printf '%s' "$release_json" | jq -r '.tag_name // empty')"
  is_draft="$(printf '%s' "$release_json" | jq -r 'if .draft == true then "true" else "false" end')"
  commitish="$(printf '%s' "$release_json" | jq -r '.target_commitish // empty')"
  upload_url="$(printf '%s' "$release_json" | jq -r '.upload_url // empty')"

  if [ "$actual_id" != "$release_id" ]; then
    echo "Error: Release lookup returned id='${actual_id}', expected '${release_id}'." >&2
    return 1
  fi
  if [ "$actual_tag" != "$tag_name" ]; then
    echo "Error: Release id=${release_id} has tag_name='${actual_tag}', expected '${tag_name}'." >&2
    return 1
  fi
  if [ "$is_draft" != "true" ]; then
    echo "Error: Release id=${release_id} for '${tag_name}' is no longer a draft (draft=${is_draft}); refusing to modify a published release." >&2
    return 1
  fi
  if [ "$commitish" != "$build_sha" ]; then
    echo "Error: Release id=${release_id} for '${tag_name}' is bound to target_commitish='${commitish}', expected '${build_sha}'." >&2
    return 1
  fi

  local upload_base="${upload_url%%\{*}"
  case "$upload_base" in
    https://*/releases/"${release_id}"/assets|http://*/releases/"${release_id}"/assets) ;;
    *)
      echo "Error: Release id=${release_id} returned unexpected upload_url '${upload_url}'." >&2
      return 1
      ;;
  esac

  printf '%s' "$release_json"
}
