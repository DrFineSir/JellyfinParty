#!/usr/bin/env python3
"""Build a Jellyfin catalog ZIP and manifest from the compiled assembly."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]

def package(root, repository, tag, output):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9_.-]+', repository):
        raise ValueError('Repository must be OWNER/REPOSITORY, without a URL.')
    if not re.fullmatch(r'v\d+\.\d+\.\d+', tag):
        raise ValueError('Release tags must use vMAJOR.MINOR.PATCH, for example v0.1.0.')
    version = tag[1:]
    project = ET.parse(root / 'src/JellyfinParty.csproj').getroot()
    if project.findtext('.//Version') != version:
        raise ValueError('Release tag does not match src/JellyfinParty.csproj Version.')
    if json.loads((root / 'package.json').read_text())['version'] != version:
        raise ValueError('Release tag does not match package.json version.')
    client_version = re.search(r"const VERSION = '([^']+)'", (root / 'src/Web/party.js').read_text())
    if not client_version or client_version[1] != version:
        raise ValueError('Release tag does not match the client VERSION in src/Web/party.js.')
    metadata = json.loads((root / 'plugin.json').read_text())
    assembly = root / 'dist' / metadata['assembly']
    if not assembly.is_file():
        raise ValueError('Compiled plugin missing. Run scripts/build.sh first.')
    output.mkdir(parents=True, exist_ok=True)
    assembly_version = version + '.0'
    archive = output / f'JellyfinParty_{assembly_version}.zip'
    # The DLL must be at the ZIP root for Jellyfin's plugin installer.
    # Fixed timestamps make repeated packaging of identical input deterministic.
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED) as target:
        for file, name in [(assembly, metadata['assembly']), (root / 'LICENSE', 'LICENSE')]:
            info = zipfile.ZipInfo(name, (2020, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            target.writestr(info, file.read_bytes())
    url = f'https://github.com/{repository}/releases/download/{tag}/{archive.name}'
    entry = {key: metadata[key] for key in ['name', 'guid', 'overview', 'description', 'category']}
    entry['owner'] = repository.split('/')[0]
    entry['versions'] = [{
        'version': assembly_version,
        'targetAbi': metadata['targetAbi'],
        'sourceUrl': url,
        # Jellyfin's installer specifically requires MD5. SHA-256 is also shipped.
        'checksum': hashlib.md5(archive.read_bytes(), usedforsecurity=False).hexdigest(),
        'timestamp': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'changelog': f'See https://github.com/{repository}/releases/tag/{tag}',
    }]
    (output / 'manifest.json').write_text(json.dumps([entry], indent=2) + '\n')
    sums = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n'
                   for path in [archive, output / 'manifest.json'])
    (output / 'SHA256SUMS').write_text(sums)
    repository_url = f'https://github.com/{repository}/releases/latest/download/manifest.json'
    (output / 'RELEASE_NOTES.md').write_text(
        f'Jellyfin Party {tag}\n\n'
        f'Target: Jellyfin Server/Web {metadata["targetAbi"].removesuffix(".0.0")}.\n\n'
        'Add this repository URL under **Dashboard → Plugins → Repositories**:\n\n'
        f'```text\n{repository_url}\n```\n\n'
        '**The dashboard installs the server plugin. The web bootstrap must also be installed '
        'to enable the menu, chat, and webcam overlays.**\n\n'
        f'[Installation guide](https://github.com/{repository}/blob/{tag}/README.md#installation) · '
        f'[Source](https://github.com/{repository}/tree/{tag})\n\n'
        'The catalog ZIP contains the plugin DLL at its root; use GitHub’s source archive '
        'for the Dockerfile, patcher, and project source.\n')
    return archive

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True, help='GitHub OWNER/REPOSITORY')
    parser.add_argument('--tag', required=True, help='Release tag, e.g. v0.1.0')
    parser.add_argument('--output', type=Path, default=ROOT / 'release')
    args = parser.parse_args()
    try:
        print(package(ROOT, args.repository, args.tag, args.output))
    except ValueError as error:
        parser.error(str(error))
