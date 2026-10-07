#!/bin/bash
set -euo pipefail

repo_root="${CI_PRIMARY_REPOSITORY_PATH:?}"
cd "$repo_root"
export APP_VARIANT="$(python3 -c 'import json; from pathlib import Path; p=Path("apps/mobile/ios/ci_scripts/stable-source.json"); print(json.loads(p.read_text())["variant"] if p.exists() else "preview")')"
case "$APP_VARIANT" in production|preview) ;; *) echo "Unsupported mobile variant" >&2; exit 1 ;; esac
if [ "$APP_VARIANT" = production ]; then export T3CODE_MOBILE_UPDATES_ENABLED=0; fi
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
if ! command -v pod >/dev/null 2>&1; then
  brew install cocoapods
fi
pod install

# CocoaPods regenerates widget metadata, so apply build numbers afterwards.
python3 - <<'PY'
import json
import os
import plistlib
import re
from pathlib import Path

receipt_path = Path('ci_scripts/stable-source.json') if os.environ['APP_VARIANT'] == 'production' else Path('ci_scripts/nightly-source.json')
receipt = json.loads(receipt_path.read_text())
print(f"Mobile source: {receipt['tag']} ({receipt['sourceSha']})")
native_name = 'TritonAIHarness' if os.environ['APP_VARIANT'] == 'production' else 'TritonAIHarnessPreview'
build_number = os.environ['CI_BUILD_NUMBER']
if not build_number.isdigit():
    raise ValueError('CI_BUILD_NUMBER must be numeric')
for target in [native_name, 'ExpoWidgetsTarget', 'expo-sharing-extension']:
    path = Path(target) / 'Info.plist'
    with path.open('rb') as file:
        info = plistlib.load(file)
    info['CFBundleVersion'] = build_number
    with path.open('wb') as file:
        plistlib.dump(info, file)
project = Path(f'{native_name}.xcodeproj/project.pbxproj')
contents, count = re.subn(r'(CURRENT_PROJECT_VERSION\s*=\s*)[^;]+;', lambda match: match[1] + build_number + ';', project.read_text())
if count < 6:
    raise ValueError('Expected build numbers for all three targets in Debug and Release')
project.write_text(contents)
PY

# Xcode's React Native build phases run in a fresh shell.
{
  printf 'export NODE_BINARY="%s/node"\n' "$node_bin"
  printf 'export PATH="%s:%s:%s/node_modules/.bin:$PATH"\n' "$node_bin" "$pnpm_bin" "$repo_root"
  printf 'export APP_VARIANT=%s\n' "$APP_VARIANT"
  if [ "$APP_VARIANT" = production ]; then printf 'export T3CODE_MOBILE_UPDATES_ENABLED=0\n'; fi
} > .xcode.env.local
