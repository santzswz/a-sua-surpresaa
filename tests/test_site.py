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
from urllib.parse import parse_qs, unquote, urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
PROJECT_MOUNT = "/a-sua-surpresaa"
FULL_TRACK_NAME = "Baco Exu do Blues - Te Amo Disgraça (Faixa 09) [qeO5EBBCPm0].mp3"
MEDIA_HOSTS = {"api.deezer.com", "audio-ssl.itunes.apple.com", "cdnt-preview.dzcdn.net"}


class QuietHandler(SimpleHTTPRequestHandler):
    def translate_path(self, path):
        parsed = urlparse(path)
        if parsed.path == PROJECT_MOUNT or parsed.path.startswith(PROJECT_MOUNT + "/"):
            path = parsed._replace(path=parsed.path[len(PROJECT_MOUNT):] or "/").geturl()
        return super().translate_path(path)

    def send_head(self):
        self._audio_remaining = None
        path = self.translate_path(self.path)
        if Path(path).suffix.lower() != ".mp3" or not Path(path).is_file():
            return super().send_head()
        source = open(path, "rb")
        size = os.fstat(source.fileno()).st_size
        start, end = 0, size - 1
        requested_range = self.headers.get("Range")
        if requested_range:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", requested_range.strip())
            if match and any(match.groups()):
                first, last = match.groups()
                if first:
                    start = int(first)
                    end = min(int(last), end) if last else end
                else:
                    start = max(0, size - int(last))
            else:
                start = size
            if start >= size or end < start:
                source.close()
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None
        self.send_response(206 if requested_range else 200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if requested_range:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        source.seek(start)
        self._audio_remaining = end - start + 1
        return source

    def copyfile(self, source, outputfile):
        if self._audio_remaining is None:
            return super().copyfile(source, outputfile)
        try:
            while self._audio_remaining > 0:
                chunk = source.read(min(65536, self._audio_remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                self._audio_remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            # Closing a browser during a media download is expected.
            pass

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
        self.local_audio_requests = []
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
                if urlparse(route.request.url).path.lower().endswith(".mp3"):
                    self.local_audio_requests.append(route.request.url)
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

    def mock_immediate_playback(self, deferred=False, background_duration=30):
        script = """(() => {
            // Keep deterministic media.volume checks on the native fallback path.
            window.AudioContext = undefined;
            window.webkitAudioContext = undefined;
            window.__createdAudioCount = 0;
            const states = new WeakMap();
            const elements = new Set();
            let nextId = 0;
            const state = element => {
                if (!states.has(element)) {
                    states.set(element, {id: nextId++, paused: true, ended: false,
                        currentTime: 0, duration: element.id === 'bgMusic' ? __BACKGROUND_DURATION__ : 30,
                        volume: 1, playCalls: 0,
                        pauseCalls: 0, loads: 0, volumeSamples: [], seeks: []});
                    elements.add(element);
                }
                return states.get(element);
            };
            const nativeAudio = window.Audio;
            function MockAudio(...args) {
                window.__createdAudioCount += 1;
                const audio = new nativeAudio(...args);
                state(audio);
                return audio;
            }
            MockAudio.prototype = nativeAudio.prototype;
            Object.setPrototypeOf(MockAudio, nativeAudio);
            window.Audio = MockAudio;
            for (const name of ['paused', 'ended', 'duration']) {
                Object.defineProperty(HTMLMediaElement.prototype, name, {
                    configurable: true, get() { return state(this)[name]; }
                });
            }
            Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
                configurable: true,
                get() { return state(this).currentTime; },
                set(value) {
                    const data = state(this);
                    data.currentTime = Number(value);
                    data.ended = false;
                    data.seeks.push(data.currentTime);
                }
            });
            Object.defineProperty(HTMLMediaElement.prototype, 'volume', {
                configurable: true,
                get() { return state(this).volume; },
                set(value) {
                    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('Invalid test volume');
                    const data = state(this);
                    data.volume = value;
                    data.volumeSamples.push({at: performance.now(), value});
                }
            });
            window.__pendingPlayback = [];
            HTMLMediaElement.prototype.play = function () {
                const audio = this;
                state(audio).playCalls += 1;
                const start = () => {
                    const data = state(audio);
                    data.paused = false;
                    data.ended = false;
                    audio.dispatchEvent(new Event('loadedmetadata'));
                    audio.dispatchEvent(new Event('playing'));
                };
                if (__DEFERRED__) return new Promise(resolve => {
                    window.__pendingPlayback.push(() => { start(); resolve(); });
                });
                start();
                return Promise.resolve();
            };
            HTMLMediaElement.prototype.pause = function () {
                const data = state(this);
                data.pauseCalls += 1;
                if (data.paused) return;
                data.paused = true;
                this.dispatchEvent(new Event('pause'));
            };
            HTMLMediaElement.prototype.load = function () {
                this.pause();
                const data = state(this);
                data.currentTime = 0;
                data.ended = false;
                data.loads += 1;
                this.dispatchEvent(new Event('emptied'));
            };
            window.__mediaMock = {
                background: () => document.getElementById('bgMusic'),
                allPaused: () => [...elements].every(element => element.paused),
                photo: track => [...elements].find(element =>
                    element !== document.getElementById('bgMusic') &&
                    element.src.endsWith('/preview-' + track + '.mp3')),
                snapshot: element => ({...state(element), loop: element.loop,
                    seeks: [...state(element).seeks], volumeSamples: [...state(element).volumeSamples]}),
                setTime: (element, value) => {
                    element.currentTime = value;
                    element.dispatchEvent(new Event('timeupdate'));
                },
                finish: element => {
                    const data = state(element);
                    data.currentTime = data.duration;
                    data.paused = true;
                    data.ended = true;
                    element.dispatchEvent(new Event('timeupdate'));
                    element.dispatchEvent(new Event('ended'));
                },
                setHidden: hidden => {
                    Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
                    Object.defineProperty(document, 'visibilityState', {
                        configurable: true, get: () => hidden ? 'hidden' : 'visible'});
                    document.dispatchEvent(new Event('visibilitychange'));
                }
            };
        })();"""
        self.page.add_init_script(script.replace("__DEFERRED__", str(deferred).lower())
                                  .replace("__BACKGROUND_DURATION__", str(background_duration)))

    def enter_with_mocked_music(self, **mock_options):
        self.mock_immediate_playback(**mock_options)
        self.page.goto(self.base_url + "/", wait_until="load")
        self.page.locator("#entryBtn").click()
        expect(self.page.locator("#entryGate")).not_to_be_visible()
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "true")

    def background_snapshot(self):
        return self.page.evaluate("__mediaMock.snapshot(__mediaMock.background())")

    def mock_available_previews(self):
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

        self.page.route("https://api.deezer.com/**", available_preview)
        return requested_tracks

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
        self.assertIsNone(page.locator("#bgMusic").get_attribute("loop"), "Music must not loop without JavaScript.")
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

    def test_photo_note_and_accessible_description_follow_selection(self):
        self.enter_quietly()
        preserved_frames = self.page.locator(".gallery").evaluate("""gallery => {
            const shots = [...gallery.querySelectorAll(':scope > figure.shot')];
            return shots.length === 9 && shots.every(shot =>
                shot.querySelector('.shot-button img[data-track-id][data-song][data-artist]') &&
                shot.querySelector('figcaption') && shot.querySelector(':scope > p.shot-note'));
        }""")
        self.assertTrue(preserved_frames, "The nine gallery frames must keep their captions and music metadata.")
        meaningful_notes = self.page.locator(".gallery .shot-note").evaluate_all("""notes => {
            const texts = notes.map(note => note.textContent.trim());
            return texts.every(Boolean) && texts.some(text => text !== texts[0]);
        }""")
        self.assertTrue(meaningful_notes, "Photo notes must contain text specific to more than one memory.")
        matches_selected = r"""index => {
            const normalize = text => (text || '').trim().replace(/\s+/g, ' ');
            const shot = document.querySelectorAll('.gallery > figure.shot')[index];
            const dialog = document.querySelector('.photo-dialog');
            const note = document.getElementById('photoNote');
            const caption = document.getElementById('photoCaption');
            const ids = attribute => (dialog.getAttribute(attribute) || '').split(/\s+/);
            return dialog.open && note && caption && shot
                && normalize(note.textContent).length > 0
                && normalize(note.textContent) === normalize(shot.querySelector('.shot-note')?.textContent)
                && normalize(caption.textContent) === normalize(shot.querySelector('figcaption')?.textContent)
                && ids('aria-labelledby').includes(caption.id)
                && ids('aria-describedby').includes(note.id);
        }"""
        self.page.locator(".shot-button").first.click()
        for index in range(9):
            if index:
                self.page.keyboard.press("ArrowRight")
            self.page.wait_for_function(matches_selected, arg=index)
            expect(self.page.locator("#photoNote")).to_be_visible()
        self.page.keyboard.press("ArrowRight")
        self.page.wait_for_function(matches_selected, arg=0)
        self.page.keyboard.press("ArrowLeft")
        self.page.wait_for_function(matches_selected, arg=8)
        self.page.keyboard.press("Escape")
        self.page.locator(".shot-button").nth(1).click()
        self.page.wait_for_function(matches_selected, arg=1)
        expect(self.page.locator("#photoNote")).to_be_visible()
        self.page.keyboard.press("Escape")
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
        self.page.route(re.compile(r"\.mp3(?:\?.*)?$"), lambda route: route.abort())
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
        self.page.wait_for_function("document.getElementById('bgMusic').paused")
        expect(toggle).to_have_attribute("aria-pressed", "false")
        expect(panel).not_to_have_class(re.compile(r"\bis-playing\b"))
        self.assertTrue(self.page.locator("#bgMusic").evaluate("audio => audio.paused"))
        self.assert_no_runtime_errors()

    def test_photo_music_requires_a_click_for_every_selected_memory(self):
        self.mock_immediate_playback()
        requested_tracks = self.mock_available_previews()
        self.enter_quietly()
        expected_tracks = self.page.locator(".shot img").evaluate_all(
            "images => images.slice(0, 2).map(image => image.dataset.trackId)"
        )
        self.page.locator(".shot-button").first.click()
        self.assertEqual(len(requested_tracks), 0, "Opening a photo must not request music.")
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoMusicStatus")).to_contain_text("Tocando um trecho")
        expect(self.page.locator(".shot").nth(0)).to_have_class(re.compile(r"\bplaying\b"))
        self.page.evaluate("""track => {
            window.__firstPhotoAudio = __mediaMock.photo(track);
            __mediaMock.setTime(__firstPhotoAudio, 8.25);
        }""", expected_tracks[0])
        self.assertFalse(self.page.evaluate("__firstPhotoAudio.loop"), "Photo excerpts must not loop.")
        before_navigation = self.page.evaluate("__mediaMock.snapshot(__firstPhotoAudio)")
        self.page.locator("#photoNext").click()
        self.assertFalse(self.page.evaluate("__firstPhotoAudio.paused"), "Photo navigation must keep the active excerpt playing.")
        self.assertEqual(self.page.evaluate("__mediaMock.snapshot(__firstPhotoAudio).playCalls"),
                         before_navigation["playCalls"], "Photo navigation must not restart the active excerpt.")
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "false")
        self.assertEqual(requested_tracks, expected_tracks[:1], "Navigation must not start the next track.")
        self.assertEqual(self.page.evaluate("__firstPhotoAudio.currentTime"), 8.25)
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator(".shot").nth(1)).to_have_class(re.compile(r"\bplaying\b"))
        self.assertEqual(requested_tracks, expected_tracks, "Each listen action must request the selected track.")
        self.page.locator("#photoPrev").click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "false")
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator(".shot").nth(0)).to_have_class(re.compile(r"\bplaying\b"))
        self.assertEqual(self.page.evaluate("__firstPhotoAudio.currentTime"), 8.25,
                         "Returning to an excerpt must resume its saved position.")
        self.assertEqual(requested_tracks, expected_tracks, "A cached excerpt must not be fetched again.")
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        self.page.keyboard.press("Escape")
        expect(self.page.locator(".photo-dialog")).not_to_be_visible()
        expect(self.page.locator(".shot-button").first).to_be_focused()
        expect(self.page.locator(".shot.playing")).to_have_count(0)
        self.page.wait_for_function("__mediaMock.allPaused()")
        expect(self.page.locator(".audio-panel")).not_to_have_class(re.compile(r"\bis-playing\b"))
        self.assertTrue(self.page.locator("#bgMusic").evaluate("audio => audio.paused"))
        self.assert_no_runtime_errors()

    def test_late_audio_play_cannot_resume_after_muting(self):
        self.mock_immediate_playback(deferred=True)
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

    def test_background_continues_without_restarting_while_browsing_photos(self):
        self.enter_with_mocked_music()
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 12.5)")
        before = self.background_snapshot()
        self.assertFalse(before["loop"], "The background excerpt must not loop.")
        self.page.locator(".shot-button").first.click()
        self.page.keyboard.press("ArrowRight")
        self.page.keyboard.press("ArrowLeft")
        self.page.keyboard.press("Escape")
        after = self.background_snapshot()
        self.assertFalse(after["paused"], "Photo browsing must keep the chosen background playing.")
        self.assertEqual(after["currentTime"], before["currentTime"], "Photo browsing must not seek the background.")
        self.assertEqual(after["playCalls"], before["playCalls"], "Photo browsing must not restart playback.")
        self.assertEqual(after["pauseCalls"], before["pauseCalls"], "Photo browsing must not interrupt playback.")
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_matching_photo_reuses_the_full_background_and_its_saved_position(self):
        self.enter_with_mocked_music(background_duration=290.325)
        self.page.evaluate("""() => {
            window.__sharedBackground = __mediaMock.background();
            __mediaMock.setTime(__sharedBackground, 65.25);
        }""")
        before = self.background_snapshot()
        self.page.locator('.shot-button:has(img[data-track-id="445019772"])').click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
        self.page.locator("#photoListenBtn").click()
        self.page.wait_for_function("__sharedBackground.paused")
        self.assertEqual(self.background_snapshot()["currentTime"], 65.25)
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
        resumed = self.background_snapshot()
        self.assertEqual(resumed["currentTime"], 65.25, "The matching photo must continue the full song rather than restart it.")
        self.assertEqual(resumed["playCalls"], before["playCalls"] + 1)
        self.page.keyboard.press("ArrowRight")
        self.page.keyboard.press("ArrowLeft")
        self.page.keyboard.press("Escape")
        after = self.background_snapshot()
        self.assertFalse(after["paused"])
        self.assertEqual(after["playCalls"], resumed["playCalls"], "Photo navigation must keep the shared audio playing.")
        self.assertTrue(self.page.evaluate("__sharedBackground === document.getElementById('bgMusic')"))
        self.assertEqual(self.page.evaluate("window.__createdAudioCount"), 0, "The full song must not acquire a second audio element.")
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_real_full_song_plays_beyond_thirty_seconds_from_the_pages_project_path(self):
        # These probes retain the native media element and native Web Audio graph.
        probe = """(() => {
            window.__realMediaProbe = {firstPlayingTime: null, createdAudio: 0,
                contexts: [], sourceElements: [], gainSamples: []};
            const data = window.__realMediaProbe;
            document.addEventListener('playing', event => {
                if (event.target.id === 'bgMusic' && data.firstPlayingTime === null)
                    data.firstPlayingTime = event.target.currentTime;
            }, true);
            const NativeAudio = window.Audio;
            function ObservedAudio(...args) {
                data.createdAudio += 1;
                return new NativeAudio(...args);
            }
            ObservedAudio.prototype = NativeAudio.prototype;
            Object.setPrototypeOf(ObservedAudio, NativeAudio);
            window.Audio = ObservedAudio;
            const NativeContext = window.AudioContext || window.webkitAudioContext;
            function ObservedContext(...args) {
                const context = new NativeContext(...args);
                data.contexts.push(context);
                const createGain = context.createGain.bind(context);
                context.createGain = () => {
                    const node = createGain();
                    const setValue = node.gain.setValueAtTime.bind(node.gain);
                    node.gain.setValueAtTime = (value, at) => {
                        data.gainSamples.push(value);
                        return setValue(value, at);
                    };
                    return node;
                };
                const createSource = context.createMediaElementSource.bind(context);
                context.createMediaElementSource = element => {
                    data.sourceElements.push(element);
                    return createSource(element);
                };
                return context;
            }
            ObservedContext.prototype = NativeContext.prototype;
            Object.setPrototypeOf(ObservedContext, NativeContext);
            window.AudioContext = ObservedContext;
        })();"""
        iphone = {"viewport": {"width": 390, "height": 844}, "is_mobile": True, "has_touch": True,
                  "user_agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"}
        self.page.close()
        for name, options in (("desktop", {}), ("iPhone emulation", iphone)):
            with self.subTest(browser=name):
                page = self.new_page(**options)
                page.add_init_script(probe)
                requests_before = self.media_requests
                files_before = len(self.local_audio_requests)
                page.goto(self.base_url + PROJECT_MOUNT + "/", wait_until="load")
                audio = page.locator("#bgMusic")
                page.evaluate("window.__fullBackground = document.getElementById('bgMusic')")
                source = urlparse(audio.evaluate("element => element.src"))
                self.assertEqual(unquote(source.path), PROJECT_MOUNT + "/" + FULL_TRACK_NAME)
                self.assertEqual(source.fragment, "")
                page.wait_for_timeout(200)
                self.assertEqual(self.media_requests, requests_before, "The MP3 must not load before a listening gesture.")
                self.assertEqual(len(self.local_audio_requests), files_before)
                self.assertTrue(audio.evaluate("element => element.paused && element.readyState === 0 && element.currentTime === 0"))
                self.assertEqual(page.evaluate("__realMediaProbe.contexts.length"), 0, "The audio context must also wait for a gesture.")
                page.locator("#entryBtn").click()
                page.wait_for_function("__fullBackground.duration > 280 && !__fullBackground.paused", timeout=20000)
                self.assertAlmostEqual(audio.evaluate("element => element.duration"), 290.325, delta=1)
                page.wait_for_function("__realMediaProbe.firstPlayingTime !== null")
                self.assertLess(page.evaluate("__realMediaProbe.firstPlayingTime"), 0.5, "The full song must begin at its beginning.")
                page.wait_for_function("__realMediaProbe.gainSamples.some(value => value >= 0.45)")
                self.assertTrue(page.evaluate("__realMediaProbe.gainSamples.some(value => value > 0 && value < 0.4)"),
                                "The native Web Audio fade must remain gradual, including iPhone emulation.")
                page.evaluate("__fullBackground.currentTime = 31")
                page.wait_for_function("!__fullBackground.seeking && !__fullBackground.paused && !__fullBackground.ended && __fullBackground.currentTime > 31.2", timeout=15000)
                page.locator('.shot-button:has(img[data-track-id="445019772"])').click()
                expect(page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
                self.assertTrue(page.locator("#photoTrackLink").evaluate("link => link.href === __fullBackground.src"))
                page.locator("#photoListenBtn").click()
                page.wait_for_function("__fullBackground.paused")
                paused_at = audio.evaluate("element => element.currentTime")
                self.assertGreater(paused_at, 31)
                page.locator("#photoListenBtn").click()
                page.wait_for_function("!__fullBackground.paused && __fullBackground.currentTime > " + str(paused_at + 0.2))
                page.keyboard.press("ArrowRight")
                page.keyboard.press("Escape")
                self.assertTrue(audio.evaluate("element => element === __fullBackground && !element.paused && element.currentTime > 31 && !element.ended && !element.loop"))
                self.assertEqual(page.evaluate("__realMediaProbe.createdAudio"), 0)
                self.assertTrue(page.evaluate("__realMediaProbe.sourceElements.length === 1 && __realMediaProbe.sourceElements[0] === __fullBackground"))
                self.assertGreater(len(self.local_audio_requests), files_before)
                page.close()
        previews = any(urlparse(url).hostname == "api.deezer.com" or (urlparse(url).hostname or "").endswith(".dzcdn.net")
                       for url in self.external_requests)
        self.assertFalse(previews, "The full local song must not request a Deezer preview.")
        self.assert_no_runtime_errors()

    def test_background_fades_progressively_and_resumes_its_saved_position(self):
        self.enter_with_mocked_music()
        self.page.wait_for_function("document.getElementById('bgMusic').volume >= 0.45")
        values = [sample["value"] for sample in self.background_snapshot()["volumeSamples"]]
        self.assertTrue(any(0 < value < 0.4 for value in values), "Starting music must include intermediate volumes.")
        self.assertTrue(all(left <= right + 0.001 for left, right in zip(values, values[1:])),
                        "The fade-in must increase volume smoothly.")
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 14.25)")
        toggle = self.page.locator("#soundToggle")
        toggle.click()
        expect(toggle).to_have_attribute("aria-pressed", "false")
        self.page.wait_for_function("document.getElementById('bgMusic').paused")
        paused = self.background_snapshot()
        self.assertEqual(paused["currentTime"], 14.25, "Pausing must preserve the playback position.")
        self.assertLessEqual(paused["volume"], 0.01, "Pausing must finish its fade-out before stopping.")
        toggle.click()
        expect(toggle).to_have_attribute("aria-pressed", "true")
        self.page.wait_for_function("document.getElementById('bgMusic').volume >= 0.45")
        resumed = self.background_snapshot()
        self.assertEqual(resumed["currentTime"], 14.25, "Resuming must continue from the saved position.")
        self.assertEqual(resumed["playCalls"], paused["playCalls"] + 1)
        self.assert_no_runtime_errors()

    def test_finished_background_stays_finished_until_an_explicit_replay(self):
        self.enter_with_mocked_music()
        self.page.evaluate("__mediaMock.finish(__mediaMock.background())")
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        finished = self.background_snapshot()
        self.assertTrue(finished["ended"])
        self.page.locator(".shot-button").first.click()
        self.page.keyboard.press("ArrowRight")
        self.page.keyboard.press("Escape")
        self.page.evaluate("__mediaMock.setHidden(true); __mediaMock.setHidden(false)")
        after_browsing = self.background_snapshot()
        self.assertTrue(after_browsing["paused"], "Browsing and returning to the page must not replay an ended track.")
        self.assertTrue(after_browsing["ended"])
        self.assertEqual(after_browsing["currentTime"], finished["currentTime"])
        self.assertEqual(after_browsing["playCalls"], finished["playCalls"])
        self.page.locator("#musicPlayBtn").click()
        expect(self.page.locator("#musicPlayBtn")).to_have_attribute("aria-pressed", "true")
        replayed = self.background_snapshot()
        self.assertEqual(replayed["currentTime"], 0, "An explicit replay may start the ended track from the beginning.")
        self.assertEqual(replayed["playCalls"], finished["playCalls"] + 1)
        self.assertFalse(replayed["ended"])
        self.assert_no_runtime_errors()

    def test_photo_music_continues_during_navigation_and_closing_restores_background_position(self):
        requested_tracks = self.mock_available_previews()
        self.enter_with_mocked_music()
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 16.75)")
        self.page.locator(".shot-button").first.click()
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
        track = self.page.locator(".shot img").first.get_attribute("data-track-id")
        self.page.evaluate("track => { window.__activePhoto = __mediaMock.photo(track); }", track)
        self.page.wait_for_function("document.getElementById('bgMusic').paused && __activePhoto.volume >= 0.6")
        background = self.background_snapshot()
        self.assertEqual(background["currentTime"], 16.75)
        photo_values = self.page.evaluate("__mediaMock.snapshot(__activePhoto).volumeSamples.map(sample => sample.value)")
        self.assertTrue(any(0 < value < 0.5 for value in photo_values), "Photo music must fade in rather than jump in volume.")
        self.page.evaluate("__mediaMock.setTime(__activePhoto, 6.5)")
        photo = self.page.evaluate("__mediaMock.snapshot(__activePhoto)")
        self.page.locator("#photoNext").click()
        self.assertFalse(self.page.evaluate("__activePhoto.paused"), "Navigation must preserve the currently chosen photo music.")
        self.assertEqual(self.page.evaluate("__mediaMock.snapshot(__activePhoto).playCalls"), photo["playCalls"])
        self.assertEqual(self.page.evaluate("__activePhoto.currentTime"), 6.5)
        self.assertEqual(requested_tracks, [track], "Navigation must not fetch or play the next photo track.")
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "false")
        self.page.locator("#photoSoundToggle").click()
        self.page.wait_for_function("__activePhoto.paused")
        self.page.locator("#photoSoundToggle").click()
        self.page.wait_for_function("!__activePhoto.paused && __activePhoto.volume > 0")
        self.assertEqual(self.page.evaluate("__activePhoto.currentTime"), 6.5)
        self.assertTrue(self.page.locator("#bgMusic").evaluate("audio => audio.paused"))
        self.page.keyboard.press("Escape")
        self.page.wait_for_function("__activePhoto.paused && !document.getElementById('bgMusic').paused")
        restored = self.background_snapshot()
        self.assertEqual(restored["currentTime"], 16.75, "Closing a photo must resume the original background position.")
        self.assert_no_runtime_errors()

    def test_closing_photo_respects_an_explicitly_paused_background(self):
        self.mock_available_previews()
        self.enter_with_mocked_music()
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 11.25)")
        self.page.locator("#musicPlayBtn").click()
        self.page.wait_for_function("document.getElementById('bgMusic').paused")
        paused_background = self.background_snapshot()
        self.page.locator(".shot-button").first.click()
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
        self.page.keyboard.press("Escape")
        self.page.wait_for_function("__mediaMock.allPaused()")
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        after_closing = self.background_snapshot()
        self.assertEqual(after_closing["playCalls"], paused_background["playCalls"],
                         "Closing a photo must respect the user's paused background choice.")
        self.assertEqual(after_closing["currentTime"], 11.25)
        self.assert_no_runtime_errors()

    def test_finished_photo_does_not_loop_or_restart_the_background_on_its_own(self):
        self.mock_available_previews()
        self.enter_with_mocked_music()
        self.page.locator(".shot-button").first.click()
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
        track = self.page.locator(".shot img").first.get_attribute("data-track-id")
        self.page.evaluate("track => { window.__finishedPhoto = __mediaMock.photo(track); }", track)
        self.page.wait_for_function("document.getElementById('bgMusic').paused")
        background = self.background_snapshot()
        self.page.evaluate("__mediaMock.finish(__finishedPhoto)")
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "false")
        self.page.wait_for_timeout(150)
        self.assertTrue(self.page.evaluate("__finishedPhoto.paused && __finishedPhoto.ended && !__finishedPhoto.loop"))
        self.assertTrue(self.background_snapshot()["paused"], "The end of a photo excerpt must stay quiet.")
        self.assertEqual(self.background_snapshot()["playCalls"], background["playCalls"])
        self.page.locator("#photoListenBtn").click()
        expect(self.page.locator("#photoListenBtn")).to_have_attribute("aria-pressed", "true")
        self.assertEqual(self.page.evaluate("__finishedPhoto.currentTime"), 0,
                         "An explicit listen action may replay an ended photo excerpt.")
        self.assert_no_runtime_errors()

    def test_hidden_page_pauses_immediately_and_cancels_unfinished_fades(self):
        self.enter_with_mocked_music()
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 9.5)")
        paused_immediately = self.page.evaluate("""() => {
            __mediaMock.setHidden(true);
            return __mediaMock.background().paused;
        }""")
        self.assertTrue(paused_immediately, "An inactive page must pause before another animation frame.")
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "false")
        hidden = self.background_snapshot()
        self.page.wait_for_timeout(1000)
        still_hidden = self.background_snapshot()
        self.assertTrue(still_hidden["paused"])
        self.assertEqual(still_hidden["volume"], hidden["volume"], "A canceled fade must not keep changing volume.")
        self.assertEqual(still_hidden["currentTime"], 9.5)
        self.page.evaluate("__mediaMock.setHidden(false)")
        expect(self.page.locator("#soundToggle")).to_have_attribute("aria-pressed", "true")
        self.assertEqual(self.background_snapshot()["currentTime"], 9.5)
        self.page.evaluate("__mediaMock.setHidden(true)")
        self.page.locator("#soundToggle").click()
        muted = self.background_snapshot()
        self.page.evaluate("__mediaMock.setHidden(false)")
        self.page.wait_for_timeout(100)
        self.assertTrue(self.background_snapshot()["paused"], "The last mute intention must survive a visibility change.")
        self.assertEqual(self.background_snapshot()["playCalls"], muted["playCalls"])
        self.assert_no_runtime_errors()

    def test_an_older_play_promise_cannot_pause_a_newer_resume(self):
        self.mock_immediate_playback(deferred=True)
        self.enter_quietly()
        toggle = self.page.locator("#soundToggle")
        toggle.click()
        self.page.wait_for_function("window.__pendingPlayback.length === 1")
        toggle.click()
        toggle.click()
        self.page.wait_for_function("window.__pendingPlayback.length === 2")
        self.page.evaluate("window.__pendingPlayback[1]()")
        expect(toggle).to_have_attribute("aria-pressed", "true")
        self.page.evaluate("window.__pendingPlayback[0]()")
        self.page.wait_for_timeout(100)
        self.assertFalse(self.background_snapshot()["paused"], "An older play completion must leave the newer request playing.")
        expect(toggle).to_have_attribute("aria-pressed", "true")
        toggle.click()
        self.page.wait_for_function("document.getElementById('bgMusic').paused")
        expect(toggle).to_have_attribute("aria-pressed", "false")
        self.assert_no_runtime_errors()

    def test_late_photo_preview_cannot_replace_music_after_the_dialog_closes(self):
        def delayed_preview(route):
            self.external_requests.append(route.request.url)
            track = urlparse(route.request.url).path.rsplit("/", 1)[-1]
            callback = parse_qs(urlparse(route.request.url).query).get("callback", [""])[0]
            self.assertRegex(callback, r"^surprisePreview_[A-Za-z0-9_]+$")
            route.fulfill(
                content_type="application/javascript",
                body=f'window.__deliverLatePreview = () => {callback}({{"preview":"https://cdnt-preview.dzcdn.net/preview-{track}.mp3"}});',
            )

        self.page.route("https://api.deezer.com/**", delayed_preview)
        self.enter_with_mocked_music()
        before = self.background_snapshot()
        track = self.page.locator(".shot img").first.get_attribute("data-track-id")
        self.page.locator(".shot-button").first.click()
        self.page.locator("#photoListenBtn").click()
        self.page.wait_for_function("typeof window.__deliverLatePreview === 'function'")
        self.page.keyboard.press("Escape")
        self.page.evaluate("window.__deliverLatePreview()")
        self.page.wait_for_timeout(100)
        no_photo_started = self.page.evaluate("track => !__mediaMock.photo(track)", track)
        self.assertTrue(no_photo_started, "A canceled photo request must not start playback after closing.")
        after = self.background_snapshot()
        self.assertFalse(after["paused"])
        self.assertEqual(after["playCalls"], before["playCalls"])
        expect(self.page.locator(".shot").first).not_to_have_class(re.compile(r"\bplaying\b"))
        self.assert_no_runtime_errors()

    def test_keepsake_quotes_are_accessible_and_do_not_repeat_immediately(self):
        self.enter_quietly()
        button = self.page.locator("#keepsakeBtn")
        quote = self.page.locator("#keepsakeText")
        expect(button).to_have_attribute("aria-controls", "keepsakeText")
        expect(quote).to_have_attribute("role", "status")
        expect(quote).to_have_attribute("aria-live", "polite")
        quote.evaluate("el => { window.__previousKeepsake = el.textContent.trim(); }")
        button.focus()
        for _ in range(10):
            button.press("Enter")
            changed = quote.evaluate("""el => {
                const text = el.textContent.trim();
                const changed = text.length > 0 && text !== window.__previousKeepsake;
                window.__previousKeepsake = text;
                return changed;
            }""")
            self.assertTrue(changed, "Each keepsake action must show a nonempty quote different from the previous one.")
        expect(button).to_be_focused()
        self.assert_no_runtime_errors()

    def test_back_to_top_restores_focus_and_reading_progress_is_only_visual(self):
        self.enter_quietly()
        self.page.locator("#final").evaluate("el => el.scrollIntoView({behavior: 'instant'})")
        self.page.wait_for_function("window.scrollY > 0")
        top_link = self.page.locator("#backToTop")
        expect(top_link).to_have_attribute("href", "#inicio")
        top_link.click()
        self.page.wait_for_function("window.scrollY <= 1")
        expect(self.page.locator("h1")).to_be_focused()
        progress = self.page.locator(".experience-progress")
        expect(progress).to_have_attribute("aria-hidden", "true")
        self.assertIsNone(progress.get_attribute("role"), "The decoration must not announce changing progress.")
        self.assertIsNone(self.page.locator("#experienceProgress").get_attribute("role"))
        self.assert_no_runtime_errors()

    def test_new_letters_vouchers_and_quiz_answers_work_without_javascript(self):
        page = self.new_page(java_script_enabled=False)
        page.goto(self.base_url + "/", wait_until="load")
        for section_id, count in (("abra-quando", 4), ("vales", 4), ("quiz-do-casal", 5)):
            with self.subTest(section=section_id):
                section = page.locator(f"#{section_id}")
                expect(section).to_be_visible()
                details = section.locator("details")
                expect(details).to_have_count(count)
                for index in range(count):
                    detail = details.nth(index)
                    self.assertTrue(detail.evaluate("element => element instanceof HTMLDetailsElement"))
                    summary = detail.locator(":scope > summary")
                    summary.focus()
                    summary.press("Enter")
                    expect(detail).to_have_attribute("open", "")
                    expect(detail.locator(":scope > :not(summary)").first).to_be_visible()
                    summary.press("Enter")
                    self.assertFalse(detail.evaluate("element => element.open"))
        expect(page.locator("#coupleQuiz .quiz-question")).to_have_count(5)
        expect(page.locator("#coupleQuiz input[type=radio]")).to_have_count(15)
        expect(page.locator("#quizControls")).not_to_be_visible()
        plans = page.locator("#proximos-destinos")
        expect(plans).to_be_visible()
        self.assertTrue(plans.evaluate("element => element.textContent.includes('Eiffel')"),
                        "The future chapter must remain readable without JavaScript.")
        expect(plans.locator("input[type=checkbox][data-wish-id]")).to_have_count(4)
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_couple_quiz_scores_each_answer_once_and_restarts_with_focus(self):
        self.enter_quietly()
        questions = self.page.locator("#coupleQuiz .quiz-question")
        expect(questions).to_have_count(5)
        check = self.page.locator("#quizCheck")
        next_button = self.page.locator("#quizNext")
        feedback = self.page.locator("#quizFeedback")
        # These choices include two misses and three facts established by the page.
        choices = (("may12", False), ("oct15", True), ("partilhar", False),
                   ("may12", True), ("eiffel", True))
        for index, (choice, correct) in enumerate(choices):
            with self.subTest(question=index + 1):
                question = questions.nth(index)
                expect(self.page.locator("#coupleQuiz .quiz-question:not([hidden])")).to_have_count(1)
                expect(question).to_be_visible()
                expect(check).to_be_disabled()
                expect(next_button).not_to_be_visible()
                expect(feedback).not_to_be_visible()
                expect(self.page.locator("#quizProgress")).to_have_text(f"Pergunta {index + 1} de 5")
                radios = question.locator("input[type=radio]")
                expect(radios).to_have_count(3)
                question.locator(f'input[type=radio][value="{choice}"]').check()
                expect(check).to_be_enabled()
                if index == 1:
                    check.dblclick()
                else:
                    check.click()
                expect(check).to_be_disabled()
                expect(question.locator("input[type=radio]:disabled")).to_have_count(3)
                expect(feedback).to_be_visible()
                expect(feedback).to_have_class(re.compile(r"\bis-correct\b" if correct else r"\bis-incorrect\b"))
                if index != 1:
                    expect(next_button).to_be_focused()
                next_button.click()
                if index < 4:
                    expect(questions.nth(index + 1).locator("legend")).to_be_focused()
        expect(self.page.locator("#quizResult")).to_be_visible()
        expect(self.page.locator("#quizControls")).not_to_be_visible()
        expect(self.page.locator("#quizResultTitle")).to_be_focused()
        expect(self.page.locator("#coupleQuiz .quiz-question:not([hidden])")).to_have_count(0)
        score_correct = self.page.locator("#quizResultText").evaluate(
            r"element => /^Você acertou 3 de 5(?:\.|\s|$)/.test(element.textContent)"
        )
        self.assertTrue(score_correct, "A double check must count each answer only once.")
        self.page.locator("#quizRestart").click()
        expect(questions.first.locator("legend")).to_be_focused()
        expect(self.page.locator("#coupleQuiz input[type=radio]:checked")).to_have_count(0)
        expect(self.page.locator("#coupleQuiz input[type=radio]:disabled")).to_have_count(0)
        expect(self.page.locator("#quizResult")).not_to_be_visible()
        expect(check).to_be_disabled()
        expect(next_button).not_to_be_visible()
        expect(feedback).not_to_be_visible()
        expect(self.page.locator("#quizProgress")).to_have_text("Pergunta 1 de 5")
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_future_wishes_restore_after_reload_and_recover_from_corrupt_storage(self):
        backend_requests = []
        self.page.on("request", lambda request: backend_requests.append(True)
                     if request.resource_type in ("fetch", "xhr") or request.method not in ("GET", "HEAD") else None)
        self.enter_quietly()
        wishes = self.page.locator("input[type=checkbox][data-wish-id]")
        expect(wishes).to_have_count(4)
        wishes.nth(0).check()
        wishes.nth(1).check()
        expect(self.page.locator("#wishStatus")).to_contain_text("Escolhas salvas só neste navegador")
        saved = self.page.evaluate("""() => {
            const expected = [...document.querySelectorAll('input[data-wish-id]:checked')]
                .map(input => input.dataset.wishId).sort();
            const stored = JSON.parse(localStorage.getItem('surprise:wishes:v1'));
            return Array.isArray(stored) && JSON.stringify([...stored].sort()) === JSON.stringify(expected);
        }""")
        self.assertTrue(saved, "The wishlist must save the selected plans locally.")
        self.page.reload(wait_until="load")
        self.page.locator("#entryQuietBtn").click()
        expect(wishes.nth(0)).to_be_checked()
        expect(wishes.nth(1)).to_be_checked()
        expect(wishes.nth(2)).not_to_be_checked()
        expect(wishes.nth(3)).not_to_be_checked()
        expect(self.page.locator("#wishStatus")).to_contain_text("guardados só neste navegador")
        self.page.evaluate("localStorage.setItem('surprise:wishes:v1', '{invalid JSON')")
        self.page.reload(wait_until="load")
        self.page.locator("#entryQuietBtn").click()
        expect(self.page.locator("input[data-wish-id]:checked")).to_have_count(0)
        expect(self.page.locator("#wishStatus")).to_contain_text("não puderam ser recuperadas")
        wishes.nth(2).check()
        expect(wishes.nth(2)).to_be_checked()
        expect(self.page.locator("#wishStatus")).to_contain_text("Escolhas salvas só neste navegador")
        repaired = self.page.evaluate("""() => {
            const stored = JSON.parse(localStorage.getItem('surprise:wishes:v1'));
            const selected = document.querySelector('input[data-wish-id]:checked').dataset.wishId;
            return Array.isArray(stored) && stored.length === 1 && stored[0] === selected;
        }""")
        self.assertTrue(repaired, "A new choice must replace malformed saved data.")
        self.assertEqual(len(backend_requests), 0, "Choosing future plans must not contact a backend.")
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_future_wishes_remain_usable_when_storage_read_or_write_is_unavailable(self):
        for operation in ("getItem", "setItem"):
            with self.subTest(storage_operation=operation):
                page = self.new_page()
                script = """(() => {
                    const operation = '__OPERATION__';
                    const original = Storage.prototype[operation];
                    Storage.prototype[operation] = function (...args) {
                        if (args[0] === 'surprise:wishes:v1')
                            throw new DOMException('Storage unavailable for this check', 'SecurityError');
                        return original.apply(this, args);
                    };
                })();"""
                page.add_init_script(script.replace("__OPERATION__", operation))
                self.enter_quietly(page)
                status = page.locator("#wishStatus")
                if operation == "getItem":
                    expect(status).to_contain_text("Não consegui acessar as escolhas salvas")
                wish = page.locator("input[type=checkbox][data-wish-id]").first
                wish.check()
                expect(wish).to_be_checked()
                if operation == "setItem":
                    expect(status).to_contain_text("Não consegui salvar neste navegador")
                wish.uncheck()
                expect(wish).not_to_be_checked()
                page.close()
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_new_chapters_fit_a_phone_and_keyboard_actions_keep_music_playing(self):
        self.page.set_viewport_size({"width": 320, "height": 720})
        self.enter_with_mocked_music(background_duration=290.325)
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 44.25)")
        before = self.background_snapshot()
        for section_id in ("abra-quando", "vales"):
            detail = self.page.locator(f"#{section_id} details").first
            summary = detail.locator(":scope > summary")
            summary.focus()
            summary.press("Enter")
            expect(detail).to_have_attribute("open", "")
            expect(detail.locator(":scope > :not(summary)").first).to_be_visible()
        wish = self.page.locator("input[type=checkbox][data-wish-id]").first
        wish.focus()
        wish.press("Space")
        expect(wish).to_be_checked()
        question = self.page.locator("#coupleQuiz .quiz-question:not([hidden])")
        answer = question.locator('input[type=radio][value="may08"]')
        answer.focus()
        answer.press("Space")
        expect(answer).to_be_checked()
        self.page.locator("#quizCheck").press("Enter")
        expect(self.page.locator("#quizFeedback")).to_be_visible()
        self.page.locator("#quizNext").press("Enter")
        expect(self.page.locator("#coupleQuiz .quiz-question").nth(1).locator("legend")).to_be_focused()
        for section_id in ("abra-quando", "vales", "quiz-do-casal", "proximos-destinos"):
            fits = self.page.locator(f"#{section_id}").evaluate("""element => {
                const {left, right} = element.getBoundingClientRect();
                return left >= -1 && right <= innerWidth + 1 && element.scrollWidth <= element.clientWidth + 1;
            }""")
            self.assertTrue(fits, "The new chapter must fit a 320 px screen with its content expanded.")
        self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth - innerWidth"), 1)
        after = self.background_snapshot()
        self.assertFalse(after["paused"], "Reading, planning and answering must keep the selected music playing.")
        self.assertEqual(after["currentTime"], before["currentTime"])
        self.assertEqual(after["playCalls"], before["playCalls"])
        self.assertEqual(after["pauseCalls"], before["pauseCalls"])
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()


    def test_final_surprise_envelope_toggles_by_keyboard_and_preserves_photo_order(self):
        self.enter_quietly()
        envelope = self.page.locator("#finalSurpriseEnvelope")
        summary = envelope.locator(":scope > summary")
        body = envelope.locator(":scope > .final-surprise-body")
        self.assertTrue(envelope.evaluate("element => element instanceof HTMLDetailsElement"))
        self.assertFalse(envelope.evaluate("element => element.open"))
        expect(body).not_to_be_visible()
        self.assertTrue(envelope.evaluate("""element => {
            const final = document.querySelector('#final');
            return Boolean(final && final.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
        }"""), "The extra envelope must appear after the existing final chapter.")
        summary.focus()
        summary.press("Enter")
        expect(envelope).to_have_attribute("open", "")
        expect(body).to_be_visible()
        images = envelope.locator(".final-surprise-photo > img")
        expect(images).to_have_count(3)
        filenames = images.evaluate_all(r"""elements => elements.map(image => {
            const pathname = new URL(image.currentSrc || image.src).pathname;
            return pathname.split('/').pop().replace(/\.[^.]+$/, '');
        })""")
        self.assertEqual(filenames, ["final-surprise-01", "final-surprise-02", "final-surprise-03"])
        summary.focus()
        summary.press("Space")
        self.assertFalse(envelope.evaluate("element => element.open"))
        expect(body).not_to_be_visible()
        expect(summary).to_be_focused()
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_final_surprise_photos_open_and_load_without_javascript(self):
        page = self.new_page(java_script_enabled=False)
        page.goto(self.base_url + "/", wait_until="load")
        envelope = page.locator("#finalSurpriseEnvelope")
        summary = envelope.locator(":scope > summary")
        body = envelope.locator(":scope > .final-surprise-body")
        self.assertFalse(envelope.evaluate("element => element.open"))
        expect(body).not_to_be_visible()
        summary.focus()
        summary.press("Enter")
        expect(envelope).to_have_attribute("open", "")
        expect(body).to_be_visible()
        images = envelope.locator(".final-surprise-photo > img")
        expect(images).to_have_count(3)
        for index in range(3):
            with self.subTest(photo=index + 1):
                image = images.nth(index)
                image.scroll_into_view_if_needed()
                page.wait_for_function(
                    "image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0",
                    arg=image.element_handle(),
                )
                expect(image).to_be_visible()
        summary.click()
        self.assertFalse(envelope.evaluate("element => element.open"))
        expect(body).not_to_be_visible()
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()

    def test_final_surprise_fits_a_phone_without_cropping_or_interrupting_music(self):
        self.page.set_viewport_size({"width": 320, "height": 720})
        self.enter_with_mocked_music(background_duration=290.325)
        self.page.evaluate("__mediaMock.setTime(__mediaMock.background(), 52.5)")
        before = self.background_snapshot()
        envelope = self.page.locator("#finalSurpriseEnvelope")
        summary = envelope.locator(":scope > summary")
        summary.focus()
        summary.press("Enter")
        expect(envelope).to_have_attribute("open", "")
        images = envelope.locator(".final-surprise-photo > img")
        expect(images).to_have_count(3)
        for index in range(3):
            with self.subTest(photo=index + 1):
                image = images.nth(index)
                image.scroll_into_view_if_needed()
                self.page.wait_for_function(
                    "image => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0",
                    arg=image.element_handle(),
                )
                fully_shown = image.evaluate("""image => {
                    const rect = image.getBoundingClientRect();
                    const intrinsicHeight = rect.width * image.naturalHeight / image.naturalWidth;
                    if (rect.width <= 0 || rect.height <= 0 || rect.left < -1 || rect.right > innerWidth + 1
                        || Math.abs(rect.height - intrinsicHeight) > 1.5) return false;
                    for (let parent = image.parentElement; parent; parent = parent.parentElement) {
                        const style = getComputedStyle(parent);
                        const bounds = parent.getBoundingClientRect();
                        if (['hidden', 'clip'].includes(style.overflowX)
                            && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1)) return false;
                        if (['hidden', 'clip'].includes(style.overflowY)
                            && (rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1)) return false;
                        if (parent.id === 'finalSurpriseEnvelope') break;
                    }
                    return true;
                }""")
                self.assertTrue(fully_shown, "Each final photo must load in its full proportions without clipping at 320 px.")
        self.assertLessEqual(self.page.evaluate("document.documentElement.scrollWidth - innerWidth"), 1)
        summary.click()
        self.assertFalse(envelope.evaluate("element => element.open"))
        expect(envelope.locator(":scope > .final-surprise-body")).not_to_be_visible()
        after = self.background_snapshot()
        self.assertFalse(after["paused"], "Opening and closing the final envelope must keep the music playing.")
        self.assertEqual(after["currentTime"], before["currentTime"])
        self.assertEqual(after["playCalls"], before["playCalls"])
        self.assertEqual(after["pauseCalls"], before["pauseCalls"])
        self.assert_no_media_requests()
        self.assert_no_runtime_errors()


if __name__ == "__main__":
    unittest.main()
