#!/bin/zsh
# 編譯成 HeadTracker.app（需要 Xcode 或 Command Line Tools）
set -e
cd "$(dirname "$0")"

APP=HeadTracker.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
cp Info.plist "$APP/Contents/Info.plist"

swiftc -O -parse-as-library -swift-version 5 \
    -target "$(uname -m)-apple-macos14.0" \
    main.swift -o "$APP/Contents/MacOS/HeadTracker"

codesign --force --sign - "$APP"
echo "完成：$(pwd)/$APP"
