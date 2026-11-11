import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('release', ROOT / 'scripts/package-release.py')
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        for name in ['src/Web', 'dist']: (self.root / name).mkdir(parents=True)
        (self.root/'src/JellyfinParty.csproj').write_text('<Project><PropertyGroup><Version>0.1.0</Version></PropertyGroup></Project>')
        (self.root/'src/Web/party.js').write_text("const VERSION = '0.1.0';")
        (self.root/'package.json').write_text('{"version":"0.1.0"}')
        (self.root/'plugin.json').write_bytes((ROOT/'plugin.json').read_bytes())
        (self.root/'LICENSE').write_text('test license')
        (self.root/'dist/Jellyfin.Plugin.JellyfinParty.dll').write_bytes(b'test assembly')

    def test_catalog_layout_urls_and_checksums(self):
        archive = release.package(self.root, 'example/party', 'v0.1.0', self.root/'release')
        with zipfile.ZipFile(archive) as z:
            self.assertEqual(set(z.namelist()), {'Jellyfin.Plugin.JellyfinParty.dll','LICENSE'})
            self.assertEqual(z.read('Jellyfin.Plugin.JellyfinParty.dll'), b'test assembly')
        manifest=json.loads((archive.parent/'manifest.json').read_text())[0]
        version=manifest['versions'][0]
        self.assertEqual(manifest['owner'],'example')
        self.assertEqual(version['version'],'0.1.0.0')
        self.assertEqual(version['targetAbi'],'12.1.0.0')
        self.assertEqual(version['sourceUrl'],'https://github.com/example/party/releases/download/v0.1.0/JellyfinParty_0.1.0.0.zip')
        self.assertEqual(version['checksum'],hashlib.md5(archive.read_bytes(),usedforsecurity=False).hexdigest())
        self.assertIn(hashlib.sha256(archive.read_bytes()).hexdigest(),(archive.parent/'SHA256SUMS').read_text())
        notes=(archive.parent/'RELEASE_NOTES.md').read_text()
        self.assertIn('https://github.com/example/party/releases/latest/download/manifest.json',notes)
        self.assertIn('README.md#installation',notes)

    def test_archive_is_deterministic(self):
        first=release.package(self.root,'example/party','v0.1.0',self.root/'one').read_bytes()
        second=release.package(self.root,'example/party','v0.1.0',self.root/'two').read_bytes()
        self.assertEqual(first,second)

    def test_version_mismatch_rejected(self):
        with self.assertRaisesRegex(ValueError,'csproj'):release.package(self.root,'example/party','v0.2.0',self.root/'out')
        (self.root/'package.json').write_text('{"version":"0.2.0"}')
        with self.assertRaisesRegex(ValueError,'package.json'):release.package(self.root,'example/party','v0.1.0',self.root/'out')

    def test_client_version_mismatch_rejected(self):
        (self.root/'src/Web/party.js').write_text("const VERSION = '0.2.0';")
        with self.assertRaisesRegex(ValueError,'client VERSION'):release.package(self.root,'example/party','v0.1.0',self.root/'out')

    def test_bad_repository_or_tag_rejected(self):
        for repo in ['https://github.com/example/party','../outside','name;echo/private']:
            with self.subTest(repo=repo), self.assertRaises(ValueError):release.package(self.root,repo,'v0.1.0',self.root/'out')
        for tag in ['v0.1.0;echo','v0.1.0-beta','0.1.0']:
            with self.subTest(tag=tag), self.assertRaises(ValueError):release.package(self.root,'example/party',tag,self.root/'out')

    def test_missing_build_rejected(self):
        (self.root/'dist/Jellyfin.Plugin.JellyfinParty.dll').unlink()
        with self.assertRaisesRegex(ValueError,'Compiled plugin missing'):release.package(self.root,'example/party','v0.1.0',self.root/'out')

if __name__ == '__main__':unittest.main()
