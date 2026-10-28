#!/bin/sh
# Install a locally built dsh-feiyu-zeta archive using the official DSH CLI.
set -eu

PACKAGE_PATH=''
PROFILE='web'
while [ "$#" -gt 0 ]; do
  case "$1" in
    --package|--profile)
      option=$1
      shift
      if [ "$#" -eq 0 ]; then printf 'Missing value for %s\n' "$option" >&2; exit 1; fi
      if [ "$option" = '--package' ]; then PACKAGE_PATH=$1; else PROFILE=$1; fi
      ;;
    -h|--help)
      printf '%s\n' 'Usage: sh install.sh --package ./dsh-feiyu-zeta-VERSION.tgz [--profile web]'
      printf '%s\n' 'Build with npm ci, npm run build, then npm pack. This project is not published to npm.'
      printf '%s\n' 'For Windows Desktop, use scripts/install-local.ps1 instead.'
      exit 0
      ;;
    *) printf 'Unknown argument: %s\n' "$1" >&2; exit 1 ;;
  esac
  shift
done
if [ -z "$PACKAGE_PATH" ] || [ ! -f "$PACKAGE_PATH" ]; then
  printf '%s\n' 'Pass an existing local .tgz archive using --package.' >&2
  exit 1
fi
case "$PACKAGE_PATH" in *.tgz) ;; *) printf '%s\n' 'The package must be a .tgz archive.' >&2; exit 1 ;; esac
if ! command -v dsh >/dev/null 2>&1; then
  printf '%s\n' 'Install and configure DeepSeek Harness before using this helper.' >&2
  exit 1
fi
package_directory=$(CDPATH= cd -- "$(dirname -- "$PACKAGE_PATH")" && pwd)
package_file=$(basename -- "$PACKAGE_PATH")
dsh plugin --profile "$PROFILE" add "$package_directory/$package_file"
printf 'Installed dsh-feiyu-zeta in profile %s. Reload DSH to use it.\n' "$PROFILE"
