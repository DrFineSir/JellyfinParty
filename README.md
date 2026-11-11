# Jellyfin Party

Watch parties for **Jellyfin 12.1** with synchronized playback, collapsible chat, movable webcams, and adjustable transparency that increases while someone speaks. Calls use P2P when available, with a WebSocket relay fallback that works over the existing server connection.

**Experimental. Supports the server-hosted desktop web client.** Camera and microphone require HTTPS. Relay webcams use approximately 6 fps. Stock TV/native apps are not supported.

## Installation

### 1. Install the server plugin

In **Dashboard → Plugins → Repositories**, add:

```text
https://github.com/DrFineSir/JellyfinParty/releases/latest/download/manifest.json
```

Open the plugin catalog, install **Jellyfin Party**, and restart Jellyfin. The repository URL becomes available when the [first release](https://github.com/DrFineSir/JellyfinParty/releases) has finished publishing.

### 2. Enable the web interface

**Dashboard installation alone does not add the chat and webcam interface.** The web bootstrap must also be installed.

Download this repository's source, then run the included patcher against Jellyfin's web directory (Python 3 required):

```sh
python3 scripts/patch-web.py /path/to/jellyfin-web
```

For Docker, copy the container's web `index.html` and `config.json` into a local folder, run the patcher on that folder, then copy or bind-mount the patched files back. The official image uses `/jellyfin/jellyfin-web`; other images may use different paths. Keep these changes persistent across container recreation. Reapply the patch using the new web files after a Jellyfin upgrade.

Alternatively, for the **official Jellyfin Docker image**, extract the release's plugin ZIP into `dist/` and build the included image:

```sh
docker build -t jellyfin-party:12.1 .
```

Use that image in the existing Jellyfin service, preserving its volumes, user, devices, ports, and proxy network. The image installs both parts. `compose.override.example.yaml` provides an optional Compose override. No additional forwarded ports are required.

### 3. Start a party

Hard-refresh Jellyfin, open **Watch parties** from the main menu, and create or join a room. Each participant uses their own Jellyfin account and must have access to the movie. Camera and microphone start off.

Drag webcam captions to move them and the corner grip to resize. **Settings** controls quiet/speaking opacity and can force the tunnel relay. **Hide chat** removes the chat panel. Everyone can pause, play, and seek. Leave Jellyfin's built-in SyncPlay group before using a Party room.

## Publishing a release

After uploading this repository to GitHub, push a tag matching the version in `src/JellyfinParty.csproj`, `package.json`, and `src/Web/party.js`:

```sh
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions runs the tests and publishes the plugin ZIP, checksums, and `manifest.json`. Repository URLs are generated automatically; no personal access token or GitHub Pages setup is needed. The manifest URL above follows the latest release. CI also runs on pull requests and pushes to `main`.

## Removing

Remove the plugin from Jellyfin's dashboard, undo the web patch with `python3 scripts/patch-web.py /path/to/jellyfin-web --remove`, and restart Jellyfin. If using the custom Docker image, switch back to the previous image so it does not reinstall the plugin on startup.

GPL-3.0-only. Independent project; not an official Jellyfin plugin.
