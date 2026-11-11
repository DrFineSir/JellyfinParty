#!/usr/bin/env python3
"""Install/remove the web entry point without replacing Jellyfin's bundled code."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil

MARKER = '<!-- Jellyfin Party begin -->'
BLOCK = MARKER + '\n<script defer src="../JellyfinParty/Assets/bootstrap.js"></script>\n<!-- Jellyfin Party end -->'
PATTERN = r'\s*<!-- Jellyfin Party begin -->.*?<!-- Jellyfin Party end -->'

def atomic(path, text):
    temporary = path.with_name(path.name + '.party-tmp')
    temporary.write_text(text, encoding='utf-8')
    shutil.copymode(path, temporary)
    os.replace(temporary, path)

def patch(web, remove=False):
    index, config = web / 'index.html', web / 'config.json'
    if not index.is_file() or not config.is_file():
        raise SystemExit(f'Not a Jellyfin web directory: {web}')
    original = index.read_text(encoding='utf-8')
    options = json.loads(config.read_text(encoding='utf-8'))
    links = [link for link in options.get('menuLinks', []) if 'jellyfinParty=1' not in str(link.get('url', ''))]
    clean = re.sub(PATTERN, '', original, flags=re.S)
    if not remove:
        if '</body>' not in clean.lower():
            raise SystemExit('index.html has no closing body tag; refusing to modify it.')
        for path in (index, config):
            backup = path.with_name(path.name + '.before-jellyfin-party')
            if not backup.exists(): shutil.copy2(path, backup)
        clean = re.sub(r'</body>', BLOCK + '\n</body>', clean, count=1, flags=re.I)
        links.append({'name': 'Watch parties', 'icon': 'groups', 'url': '#/home?jellyfinParty=1'})
    options['menuLinks'] = links
    atomic(index, clean)
    atomic(config, json.dumps(options, ensure_ascii=False, indent=2) + '\n')
    print(('Removed' if remove else 'Installed') + f' Jellyfin Party web integration in {web}')

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('web_directory', type=Path)
    parser.add_argument('--remove', action='store_true')
    args = parser.parse_args()
    patch(args.web_directory.resolve(), args.remove)
