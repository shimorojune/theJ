#!/usr/bin/env bash
# A new phone build, for native changes: incremental Gradle, arm64 only (the S23), then a
# shareable EAS install link. JavaScript-only changes go out with ship-ota.sh instead.
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/env.sh
[ -d android ] || npx expo prebuild -p android --no-install
(cd android && ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a)
eas upload -p android --build-path android/app/build/outputs/apk/release/app-release.apk --non-interactive
