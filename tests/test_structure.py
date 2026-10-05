"""Catch broken static-site links before a GitHub Pages publication."""

from html.parser import HTMLParser
from pathlib import Path
import re
import unittest
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]


class References(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.urls = []

    def handle_starttag(self, _tag, attrs):
        attributes = dict(attrs)
        if attributes.get('id'):
            self.ids.append(attributes['id'])
        self.urls.extend(attributes[key] for key in ('src', 'href') if attributes.get(key))


class StructureTests(unittest.TestCase):
    def test_static_resources_exist_and_work_in_a_pages_subdirectory(self):
        page = References()
        page.feed((ROOT / 'index.html').read_text())
        local_urls = [url for url in page.urls if not urlsplit(url).scheme and not url.startswith('#')]
        for url in local_urls:
            with self.subTest(resource=url):
                self.assertFalse(url.startswith('/'), 'A root-relative path breaks project GitHub Pages sites.')
                self.assertTrue((ROOT / unquote(urlsplit(url).path)).is_file(), 'A referenced asset is missing.')
        for stylesheet in (ROOT / 'assets').rglob('*.css'):
            for url in re.findall(r'url\([\'"]?([^\)\'\"]+)', stylesheet.read_text()):
                if urlsplit(url).scheme:
                    continue
                with self.subTest(stylesheet=stylesheet.name, resource=url):
                    self.assertTrue((stylesheet.parent / url).is_file(), 'A stylesheet asset is missing.')

    def test_navigation_targets_exist_and_ids_are_unique(self):
        page = References()
        page.feed((ROOT / 'index.html').read_text())
        self.assertEqual(len(page.ids), len(set(page.ids)), 'Duplicate IDs make controls ambiguous.')
        for url in page.urls:
            if url.startswith('#'):
                with self.subTest(anchor=url):
                    self.assertIn(url[1:], page.ids, 'A navigation link has no destination.')


if __name__ == '__main__':
    unittest.main()
