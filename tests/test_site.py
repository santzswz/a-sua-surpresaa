"""Browser checks for the surprise, served locally without external services.

Run with ``python -m unittest discover -s tests -v``. Set CHROMIUM_PATH to
use a particular Chromium binary; an installed Chromium or Playwright's
bundled browser is used otherwise. Tests never send personal content online.
"""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import os
import re
import shutil
import threading
import unittest
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
MEDIA_HOSTS = {"api.deezer.com", "audio-ssl.itunes.apple.com", "cdnt-preview.dzcdn.net"}


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        # Gallery filenames and personal text do not need to appear in logs.
        pass


class SiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(
            ("127.0.0.1", 0), partial(QuietHandler, directory=str(ROOT))
        )
        cls.addClassCleanup(cls.server.server_close)
        cls.server.daemon_threads = True
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.addClassCleanup(cls.server_thread.join, timeout=5)
        cls.addClassCleanup(cls.server.shutdown)
        cls.base_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.playwright = sync_playwright().start()
        cls.addClassCleanup(cls.playwright.stop)
        executable = os.environ.get("CHROMIUM_PATH") or shutil.which("chromium")
        launch_options = {"headless": True, "args": ["--no-sandbox", "--disable-dev-shm-usage"]}
        if executable:
            launch_options["executable_path"] = executable
        cls.browser = cls.playwright.chromium.launch(**launch_options)
        cls.addClassCleanup(cls.browser.close)

    def setUp(self):
        self.external_requests = []
        self.media_requests = 0
        self.runtime_errors = []
        self.page = self.new_page()

    def new_page(self, **options):
        settings = {"viewport": {"width": 1280, "height": 900}, "reduced_motion": "reduce"}
        settings.update(options)
        context = self.browser.new_context(**settings)
        self.addCleanup(context.close)

        def local_only(route):
            if route.request.resource_type == "media":
                self.media_requests += 1
            if route.request.url.startswith(self.base_url + "/"):
                route.continue_()
            else:
                self.external_requests.append(route.request.url)
                route.abort()

        context.route("**/*", local_only)
        page = context.new_page()
        page.set_default_timeout(6000)
        page.on("pageerror", lambda _error: self.runtime_errors.append(True))
        return page

    def enter_quietly(self, page=None):
        page = page or self.page
        page.goto(self.base_url + "/", wait_until="load")
        expect(page.locator("#entryGate")).to_be_visible()
        page.locator("#entryQuietBtn").click()
        expect(page.locator("#entryGate")).not_to_be_visible()
        expect(page.locator("h1")).to_be_focused()
        return page

    def assert_no_media_requests(self):
        requests = [url for url in self.external_requests if urlparse(url).hostname in MEDIA_HOSTS
                    or (urlparse(url).hostname or "").endswith(".dzcdn.net")]
        self.assertEqual(len(requests), 0, "Music must wait for an explicit listening action.")
        self.assertEqual(self.media_requests, 0, "Audio files must wait for an explicit listening action.")

    def assert_no_runtime_errors(self):
        self.assertEqual(len(self.runtime_errors), 0, "An uncaught browser error interrupted the page.")

    def assert_current_photo(self, source, page=None):
        page = page or self.page
        # A relative or absolute image URL should behave identically in production.
        expect(page.locator("#modalImg")).to_have_attribute(
            "src", re.compile(re.escape(urlparse(source).path) + r"$")
        )

    def assert_dialog_fits(self, dialog):
        fits = dialog.evaluate("""el => {
            const {left, right} = el.getBoundingClientRect();
            return left >= -1 && right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1;
        }""")
        self.assertTrue(fits, "The dialog needs to fit its viewport without horizontal scrolling.")

    def mock_immediate_playback(self):
        self.page.add_init_script("""(() => {
            const playing = new WeakSet();
            Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
                configurable: true, get() { return !playing.has(this); }
            });
            HTMLMediaElement.prototype.play = function () {
                playing.add(this);
                this.dispatchEvent(new Event('playing'));
                return Promise.resolve();
            };
            HTMLMediaElement.prototype.pause = function () {
                playing.delete(this);
                this.dispatchEvent(new Event('pause'));
            };
        })();""")

    def test_content_stays_visible_without_javascript(self):
        page = self.new_page(java_script_enabled=False)
        page.goto(self.base_url + "/", wait_until="load")
        expect(page.locator("h1")).to_be_visible()
        expect(page.locator(".letter")).to_be_visible()
        expect(page.locator(".shot-button").first).to_be_visible()
        expect(page.locator("#entryGate")).not_to_be_visible()
        expect(page.locator(".photo-dialog")).not_to_be_visible()
        invisible = page.locator(".reveal").evaluate_all("""elements => elements.some(el => {
            const style = getComputedStyle(el);
            return style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0;
        })""")
        self.assertFalse(invisible, "Reading content must not depend on JavaScript reveal effects.")
        expect(page.locator("#secretMessage")).to_have_attribute("hidden", "")
        expect(page.locator("#realBalanceMessage")).not_to_be_visible()
        self.assert_no_media_requests()

    def test_quiet_entry_sets_focus_and_never_requests_audio(self):
        self.page.goto(self.base_url + "/", wait_until="load")
        gate = self.page.locator("#entryGate")
        expect(gate).to_be_visible()
        self.assertTrue(gate.evaluate("el => el instanceof HTMLDialogElement && el.open"))
        expect(self.page.locator("#entryBtn")).to_be_focused()
        self.assert_no_media_requests()
        self.page.locator("#entryQuietBtn").click()
        expect(gate).not_to_be_visible()
        expect(self.page.locator("h1")).to_be_focused()
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        # Give accidental delayed eager preloads a chance to be observed.
        self.page.wait_for_timeout(250)
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_gallery_supports_keyboard_wraparound_and_restores_focus(self):
        self.enter_quietly()
        buttons = self.page.locator(".shot-button")
        first = buttons.first
        sources = self.page.locator(".shot img").evaluate_all("images => images.map(img => img.src)")
        first.click()
        dialog = self.page.locator(".photo-dialog")
        expect(dialog).to_be_visible()
        self.assertTrue(dialog.evaluate("el => el instanceof HTMLDialogElement && el.open"))
        self.assertTrue(dialog.evaluate("el => el.contains(document.activeElement)"))
        self.assert_current_photo(sources[0])
        expect(self.page.locator("#photoMusicStatus")).to_contain_text("Som desligado")
        self.page.keyboard.press("ArrowRight")
        self.assert_current_photo(sources[1])
        self.page.keyboard.press("ArrowLeft")
        self.assert_current_photo(sources[0])
        self.page.keyboard.press("ArrowLeft")
        self.assert_current_photo(sources[-1])
        expect(self.page.locator("#photoCounter")).to_have_text(re.compile(rf"^0?{len(sources)}\s*/\s*0?{len(sources)}$"))
        self.page.locator("#photoNext").click()
        self.assert_current_photo(sources[0])
        self.page.keyboard.press("Escape")
        expect(dialog).not_to_be_visible()
        expect(first).to_be_focused()
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_gift_reveal_and_hide_do_not_expose_the_real_value(self):
        self.enter_quietly()
        eye = self.page.locator("#balanceEye")
        value = self.page.locator("#balanceValue")
        real_message = self.page.locator("#realBalanceMessage")
        reveal = self.page.locator("#realBalanceBtn")
        expect(value).to_have_text(re.compile(r"^R\$\s*[•·*]+$"))
        expect(real_message).not_to_be_visible()
        eye.click()
        expect(eye).to_have_attribute("aria-pressed", "true")
        expect(value).to_have_text("R$ 0,20")
        expect(reveal).to_be_visible()
        expect(real_message).not_to_be_visible()
        reveal.click()
        expect(value).to_have_text("R$ 300,00")
        expect(real_message).to_be_visible()
        eye.click()
        expect(eye).to_have_attribute("aria-pressed", "false")
        expect(value).to_have_text(re.compile(r"^R\$\s*[•·*]+$"))
        expect(real_message).to_have_attribute("hidden", "")
        expect(real_message).not_to_be_visible()
        expect(reveal).not_to_be_visible()
        value_visible = self.page.locator("#giftBalance").evaluate('el => el.innerText.includes("300,00")')
        self.assertFalse(value_visible, "Hiding the gift balance must hide its amount everywhere in the card.")
        self.assert_no_runtime_errors()

    def test_secret_and_final_note_match_their_accessible_state(self):
        self.enter_quietly()
        for button_id, message_id in (("secretBtn", "secretMessage"), ("finalMoreBtn", "finalNote")):
            with self.subTest(control=button_id):
                button = self.page.locator(f"#{button_id}")
                message = self.page.locator(f"#{message_id}")
                expect(button).to_have_attribute("aria-expanded", "false")
                expect(button).to_have_attribute("aria-controls", message_id)
                expect(message).to_have_attribute("hidden", "")
                expect(message).not_to_be_visible()
                button.click()
                expect(button).to_have_attribute("aria-expanded", "true")
                expect(message).to_be_visible()
                self.assertIsNone(message.get_attribute("hidden"))
        self.assert_no_runtime_errors()

    def test_page_and_dialogs_fit_phone_tablet_and_desktop(self):
        for width in (320, 390, 768, 1440):
            with self.subTest(viewport=width):
                page = self.new_page(viewport={"width": width, "height": 900})
                page.goto(self.base_url + "/", wait_until="load")
                expect(page.locator("#entryGate")).to_be_visible()
                self.assert_dialog_fits(page.locator("#entryGate"))
                page.locator("#entryQuietBtn").click()
                self.assertLessEqual(
                    page.evaluate("document.documentElement.scrollWidth - innerWidth"),
                    1,
                    "The page needs to fit its viewport without horizontal scrolling.",
                )
                page.locator(".shot-button").first.click()
                self.assert_dialog_fits(page.locator(".photo-dialog"))
                page.keyboard.press("Escape")
                page.close()
        self.assert_no_runtime_errors()

    def test_long_letter_reveals_on_a_short_phone_screen(self):
        page = self.new_page(viewport={"width": 320, "height": 400}, reduced_motion="no-preference")
        self.enter_quietly(page)
        letter = page.locator(".letter")
        letter.evaluate("el => el.scrollIntoView({block: 'start', behavior: 'instant'})")
        expect(letter).not_to_have_class(re.compile(r"reveal-pending"))
        expect(letter).to_have_css("opacity", "1")
        self.assert_no_runtime_errors()

    def test_reduced_motion_stops_css_animation_and_particle_effects(self):
        self.enter_quietly()
        self.page.locator(".float-heart").click()
        self.page.locator("#secretBtn").click()
        active_animations = self.page.evaluate("""document.getAnimations().filter(animation =>
            animation instanceof CSSAnimation && animation.playState === 'running'
        ).length""")
        self.assertEqual(active_animations, 0, "Reduced motion must stop CSS animation.")
        expect(self.page.locator(".birthday-confetti, .tiny, .heart-particle, .secret-heart")).to_have_count(0)
        self.assert_no_runtime_errors()

    def test_unavailable_photo_music_keeps_navigation_working(self):
        self.enter_quietly()
        first = self.page.locator(".shot-button").first
        first.click()
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoMusicStatus")).to_contain_text("O trecho está indisponível")
        expect(self.page.locator("#photoTrackLink")).to_have_attribute("href", re.compile(r"^https://"))
        sources = self.page.locator(".shot img").evaluate_all("images => images.map(img => img.src)")
        self.page.locator("#photoNext").click()
        self.assert_current_photo(sources[1])
        self.page.keyboard.press("Escape")
        expect(first).to_be_focused()
        self.assertTrue(any(urlparse(url).hostname == "api.deezer.com" for url in self.external_requests))
        self.assert_no_runtime_errors()

    def test_unavailable_background_music_does_not_block_entry(self):
        self.page.goto(self.base_url + "/", wait_until="load")
        self.page.locator("#entryBtn").click()
        expect(self.page.locator("#entryGate")).not_to_be_visible()
        expect(self.page.locator("h1")).to_be_focused()
        expect(self.page.locator("#musicStatus")).to_contain_text("Não foi possível tocar")
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        expect(self.page.locator(".music-full-link")).to_have_attribute("href", re.compile(r"^https://"))
        self.page.locator("#secretBtn").click()
        expect(self.page.locator("#secretMessage")).to_be_visible()
        self.assert_no_runtime_errors()

    def test_untrusted_music_preview_is_rejected_before_loading_media(self):
        def invalid_preview(route):
            self.external_requests.append(route.request.url)
            query = parse_qs(urlparse(route.request.url).query)
            callback = query.get("callback", [""])[0]
            self.assertRegex(callback, r"^surprisePreview_[A-Za-z0-9_]+$")
            route.fulfill(
                content_type="application/javascript",
                body=f'{callback}({{"preview":"https://evil.example/preview.mp3"}});',
            )

        self.page.route("https://api.deezer.com/**", invalid_preview)
        self.enter_quietly()
        self.page.locator(".shot-button").first.click()
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoMusicStatus")).to_contain_text("O trecho está indisponível")
        untrusted_request = any(urlparse(url).hostname == "evil.example" for url in self.external_requests)
        self.assertFalse(untrusted_request, "Untrusted preview URLs must be rejected before a request.")
        self.page.keyboard.press("ArrowRight")
        expect(self.page.locator("#photoCounter")).to_have_text(re.compile(r"^02\s*/\s*09$"))
        self.page.keyboard.press("Escape")
        expect(self.page.locator(".shot-button").first).to_be_focused()
        self.assert_no_runtime_errors()

    def test_sound_controls_follow_actual_playback_after_quick_changes(self):
        self.mock_immediate_playback()
        self.enter_quietly()
        toggle = self.page.locator("#soundToggle")
        panel = self.page.locator(".audio-panel")
        for enabled in (True, False, True, False):
            toggle.click()
            expect(toggle).to_have_attribute("aria-pressed", str(enabled).lower())
            if enabled:
                expect(panel).to_have_class(re.compile(r"\bis-playing\b"))
            else:
                expect(panel).not_to_have_class(re.compile(r"\bis-playing\b"))
        self.page.wait_for_timeout(500)
        expect(toggle).to_have_attribute("aria-pressed", "false")
        self.assertTrue(self.page.locator("#bgMusic").evaluate("audio => audio.paused"))
        self.assert_no_runtime_errors()

    def test_photo_playback_changes_track_and_stays_muted_after_closing(self):
        requested_tracks = []

        def available_preview(route):
            self.external_requests.append(route.request.url)
            track = urlparse(route.request.url).path.rsplit("/", 1)[-1]
            requested_tracks.append(track)
            callback = parse_qs(urlparse(route.request.url).query).get("callback", [""])[0]
            self.assertRegex(callback, r"^surprisePreview_[A-Za-z0-9_]+$")
            route.fulfill(
                content_type="application/javascript",
                body=f'{callback}({{"preview":"https://cdnt-preview.dzcdn.net/preview-{track}.mp3"}});',
            )

        self.mock_immediate_playback()
        self.page.route("https://api.deezer.com/**", available_preview)
        self.enter_quietly()
        self.page.locator(".shot-button").first.click()
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoMusicStatus")).to_contain_text("Tocando um trecho")
        expect(self.page.locator(".shot").nth(0)).to_have_class(re.compile(r"\bplaying\b"))
        self.page.locator("#photoNext").click()
        expect(self.page.locator(".shot").nth(0)).not_to_have_class(re.compile(r"\bplaying\b"))
        expect(self.page.locator(".shot").nth(1)).to_have_class(re.compile(r"\bplaying\b"))
        expected_tracks = self.page.locator(".shot img").evaluate_all(
            "images => images.slice(0, 2).map(image => image.dataset.trackId)"
        )
        self.assertEqual(requested_tracks, expected_tracks, "Navigation must request the matching track.")
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        self.page.keyboard.press("Escape")
        expect(self.page.locator(".photo-dialog")).not_to_be_visible()
        expect(self.page.locator(".shot-button").first).to_be_focused()
        expect(self.page.locator(".shot.playing")).to_have_count(0)
        expect(self.page.locator(".audio-panel")).not_to_have_class(re.compile(r"\bis-playing\b"))
        self.assertTrue(self.page.locator("#bgMusic").evaluate("audio => audio.paused"))
        self.assert_no_runtime_errors()

    def test_late_audio_play_cannot_resume_after_muting(self):
        self.page.add_init_script("""(() => {
            const playing = new WeakSet();
            window.__pendingPlayback = [];
            Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
                configurable: true, get() { return !playing.has(this); }
            });
            HTMLMediaElement.prototype.play = function () {
                const audio = this;
                return new Promise(resolve => {
                    window.__pendingPlayback.push(() => {
                        playing.add(audio);
                        audio.dispatchEvent(new Event('playing'));
                        resolve();
                    });
                });
            };
            HTMLMediaElement.prototype.pause = function () {
                playing.delete(this);
                this.dispatchEvent(new Event('pause'));
            };
        })();""")
        self.enter_quietly()
        toggle = self.page.locator("#soundToggle")
        toggle.click()
        self.page.wait_for_function("window.__pendingPlayback.length === 1")
        # The user changes their mind while the browser still prepares playback.
        toggle.click()
        self.page.evaluate("window.__pendingPlayback.shift()()")
        expect(toggle).to_have_attribute("aria-pressed", "false")
        self.page.wait_for_function("document.getElementById('bgMusic').paused")
        expect(self.page.locator(".audio-panel")).not_to_have_class(re.compile(r"\bis-playing\b"))
        self.page.locator(".shot-button").first.click()
        expect(self.page.locator("#photoMusicStatus")).to_contain_text("Som desligado")
        self.page.keyboard.press("Escape")
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()


if __name__ == "__main__":
    unittest.main()
