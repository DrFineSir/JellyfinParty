#!/bin/sh
set -eu
project_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$project_root"
dotnet build src/JellyfinParty.csproj -c Release --nologo
mkdir -p dist
cp src/bin/Release/net10.0/Jellyfin.Plugin.JellyfinParty.dll dist/
sha256sum dist/Jellyfin.Plugin.JellyfinParty.dll > dist/SHA256SUMS
