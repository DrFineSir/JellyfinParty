#!/bin/sh
set -eu
party_directory="${JELLYFIN_DATA_DIR:-/config}/plugins/JellyfinParty"
mkdir -p "$party_directory"
cp /opt/jellyfin-party/Jellyfin.Plugin.JellyfinParty.dll "$party_directory/Jellyfin.Plugin.JellyfinParty.dll.tmp"
mv "$party_directory/Jellyfin.Plugin.JellyfinParty.dll.tmp" "$party_directory/Jellyfin.Plugin.JellyfinParty.dll"
exec /jellyfin/jellyfin "$@"
