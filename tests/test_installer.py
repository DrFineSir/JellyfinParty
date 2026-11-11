import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('patcher', Path(__file__).parents[1] / 'scripts/patch-web.py')
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)

class InstallerTests(unittest.TestCase):
    def test_install_idempotence_and_removal_preserve_existing_configuration(self):
        with tempfile.TemporaryDirectory() as name:
            root = Path(name)
            original = '<html><body><p>Existing client</p></body></html>'
            (root / 'index.html').write_text(original)
            config = {'menuLinks': [{'name': 'Existing', 'url': '/existing'}], 'customSetting': 42}
            (root / 'config.json').write_text(json.dumps(config))
            patcher.patch(root)
            patcher.patch(root)
            self.assertEqual((root / 'index.html').read_text().count(patcher.MARKER), 1)
            self.assertEqual(len(json.loads((root / 'config.json').read_text())['menuLinks']), 2)
            self.assertEqual((root / 'index.html.before-jellyfin-party').read_text(), original)
            patcher.patch(root, remove=True)
            self.assertNotIn(patcher.MARKER, (root / 'index.html').read_text())
            self.assertEqual(json.loads((root / 'config.json').read_text()), config)

    def test_refuses_unknown_web_layout_without_modifying_files(self):
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);(root/'index.html').write_text('invalid');(root/'config.json').write_text('{}')
            with self.assertRaises(SystemExit):patcher.patch(root)
            self.assertEqual((root/'index.html').read_text(),'invalid')

if __name__ == '__main__': unittest.main()
