#!/bin/bash
set -euo pipefail

repo_root="${CI_PRIMARY_REPOSITORY_PATH:?}"
cd "$repo_root"
export APP_VARIANT=preview
export NODE_OPTIONS=--max-old-space-size=8192

tools_dir="$repo_root/.xcode-cloud-tools"
mkdir -p "$tools_dir"
node_version="$(python3 -c 'import json; print(json.load(open("package.json"))["engines"]["node"].lstrip("^~"))')"
[[ "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
case "$(uname -m)" in
  arm64) node_arch=arm64 ;;
  x86_64) node_arch=x64 ;;
  *) echo "Unsupported build architecture" >&2; exit 1 ;;
esac
node_archive="node-v$node_version-darwin-$node_arch.tar.gz"
curl --fail --location --retry 3 "https://nodejs.org/dist/v$node_version/$node_archive" -o "$tools_dir/$node_archive"
curl --fail --location --retry 3 "https://nodejs.org/dist/v$node_version/SHASUMS256.txt" -o "$tools_dir/SHASUMS256.txt"
(
  cd "$tools_dir"
  grep "  $node_archive$" SHASUMS256.txt | shasum -a 256 -c -
  tar -xzf "$node_archive"
)
node_bin="$tools_dir/node-v$node_version-darwin-$node_arch/bin"
export PATH="$node_bin:$PATH"
pnpm_version="$(node --print "require('./package.json').packageManager.split('@').pop()")"
[[ "$pnpm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
npm install --prefix "$tools_dir/pnpm" --no-package-lock --no-save "pnpm@$pnpm_version"
pnpm_bin="$tools_dir/pnpm/node_modules/.bin"
export PATH="$pnpm_bin:$repo_root/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile --filter '@t3tools/mobile...'

cd apps/mobile/ios
python3 - <<'PY'
import json
import os
import plistlib
from pathlib import Path

receipt = json.loads(Path('ci_scripts/nightly-source.json').read_text())
print(f"Nightly source: {receipt['tag']} ({receipt['sourceSha']})")
build_number = os.environ['CI_BUILD_NUMBER']
if not build_number.isdigit():
    raise ValueError('CI_BUILD_NUMBER must be numeric')
for target in ['TritonAIHarnessPreview', 'ExpoWidgetsTarget', 'expo-sharing-extension']:
    path = Path(target) / 'Info.plist'
    with path.open('rb') as file:
        info = plistlib.load(file)
    info['CFBundleVersion'] = build_number
    with path.open('wb') as file:
        plistlib.dump(info, file)
PY

if ! command -v pod >/dev/null 2>&1; then
  brew install cocoapods
fi
pod install

# Xcode's React Native build phases run in a fresh shell.
{
  printf 'export NODE_BINARY="%s/node"\n' "$node_bin"
  printf 'export PATH="%s:%s:%s/node_modules/.bin:$PATH"\n' "$node_bin" "$pnpm_bin" "$repo_root"
  printf 'export APP_VARIANT=preview\n'
} > .xcode.env.local
