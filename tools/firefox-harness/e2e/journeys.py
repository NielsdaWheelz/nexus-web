"""temporary live journeys for firefox capture v1 (plan: acceptance table).

run one journey: ./venv/bin/python journeys.py <name> [--keep]
each journey drives the real installed extension through geckodriver and asserts
database/storage truth. the popup is queried by accessible text, never by test ids.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sys
import tempfile
import time

import db
from driver import Harness, PopupError
from selenium.webdriver.common.by import By

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
DIST = os.path.join(ROOT, "apps", "extension", "dist")
NEXUS = "http://localhost:3000"
FIXTURE = "http://fixtures.nexus-capture.test:8899"
OTHER = "http://other.nexus-capture.test:8899"
EMAIL = "firefox-capture-v1@example.com"
PASSWORD = "firefox-capture-v1-password-2026"
sys.path.insert(0, os.path.dirname(__file__))
import fixtures  # noqa: E402

PDF_SHA = hashlib.sha256(fixtures.PDF).hexdigest()
EPUB_SHA = hashlib.sha256(fixtures.EPUB).hexdigest()


class Journey:
    def __init__(self, name: str, profile_dir: str | None = None):
        self.name = name
        self.profile_dir = profile_dir or tempfile.mkdtemp(prefix="nexus-capture-profile-")
        self.h = Harness(DIST, profile_dir=self.profile_dir, log_path=os.path.join(self.profile_dir, "geckodriver.log"))
        self.d = self.h.driver

    # -- popup queries -------------------------------------------------------------------
    def text(self) -> str:
        return self.h.popup_text()

    def has(self, needle: str) -> bool:
        try:
            return needle in self.text()
        except PopupError:
            return False

    def wait_text(self, needle: str, seconds: float = 20):
        """wait for popup text; a popup that closed meanwhile is reopened (the draft
        lives in the background) and the closure is logged."""
        def probe():
            if not self.h.popup_open():
                log("popup closed while waiting; reopening", needle)
                self.h.open_popup()
            return needle in self.text()
        return self.h.wait(probe, seconds, f"popup text {needle!r}")

    def wait_gone(self, needle: str, seconds: float = 10):
        """wait until the popup no longer shows `needle`; a closed popup is reopened first."""
        def probe():
            if not self.h.popup_open():
                log("popup closed while waiting; reopening", needle)
                self.h.open_popup()
            return needle not in self.text()
        return self.h.wait(probe, seconds, f"popup text {needle!r} gone")

    def click_button(self, label: str) -> None:
        """activate a button with real input: focus it, then press enter at chrome level
        (a synthetic click is not a user-input handler for permissions.request)."""
        from selenium.webdriver.common.keys import Keys

        self.h.popup(
            """
            const label = arguments[0];
            const el = Array.from(document.querySelectorAll('button, a, [role=button]')).find(e => (e.innerText || e.textContent || '').trim() === label || (e.getAttribute('aria-label') || '') === label);
            if (!el) throw new Error('no button ' + label + ' in: ' + document.body.innerText.slice(0, 400));
            el.focus();
            if (document.activeElement !== el) throw new Error('could not focus ' + label);
            return true;
            """,
            label,
        )
        self.h.popup_keys(Keys.ENTER)

    def buttons(self) -> list[str]:
        return self.h.popup("return Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim()).filter(Boolean)")

    # -- doorhangers ---------------------------------------------------------------------------
    def answer_permission_prompt(self, allow: bool, seconds: float = 10) -> None:
        def find():
            return self.h.chrome(
                """
                const allow = arguments[0];
                const n = document.getElementById('addon-webext-permissions-notification') || Array.from(document.querySelectorAll('popupnotification')).find(p => !p.hidden && p.id.includes('permissions'));
                if (!n || n.hidden) return false;
                const btn = allow ? n.button : n.secondaryButton;
                if (!btn) return false;
                btn.click();
                return true;
                """,
                allow,
            )
        self.h.wait(find, seconds, "permission prompt")

    # -- login -----------------------------------------------------------------------------
    def login_through_hosted_flow(self) -> None:
        before = set(self.h.windows())
        self.click_button("Sign in to Nexus")
        # the popup requests the nexus/storage origins synchronously before login
        try:
            self.answer_permission_prompt(True, seconds=6)
            log("permission prompt", "allowed")
        except TimeoutError:
            log("permission prompt", "none shown")
        log("popup open after prompt", self.h.popup_open())
        handle = self.h.wait(lambda: next(iter(set(self.h.windows()) - before), None), 30, "auth window")
        self.d.switch_to.window(handle)
        summary = self.h.wait(lambda: self.d.find_element(By.XPATH, "//summary[contains(., 'Use email and password')]"), 20, "email summary")
        summary.click()
        email = self.h.wait(lambda: (el := self.d.find_element(By.CSS_SELECTOR, "input[name=email]")) and el.is_displayed() and el, 10, "email field visible")
        time.sleep(0.4)
        email.click()
        email.send_keys(EMAIL)
        password = self.d.find_element(By.CSS_SELECTOR, "input[name=password]")
        password.click()
        password.send_keys(PASSWORD)
        self.h.wait(lambda: self.d.execute_script("return document.querySelector('input[name=password]').value.length") == len(PASSWORD), 5, "password typed")
        self.d.find_element(By.XPATH, "//form[@aria-label='Sign in with email and password']//button[@type='submit']").click()
        self.h.wait(lambda: handle not in self.h.windows(), 40, "auth window closes")
        self.d.switch_to.window(self.h.content_handle)

    # -- chooser --------------------------------------------------------------------------------
    def choose_destinations(self, names: list[str]) -> None:
        """keyboard-only: open the trigger, type each name, arrow to it, enter; escape returns focus."""
        from selenium.webdriver.common.keys import Keys

        self.click_button_containing("librar")
        self.h.wait(lambda: self.h.popup("return !!document.querySelector('[role=combobox]')"), 10, "chooser combobox")
        self.h.popup("document.querySelector('[role=combobox]').focus(); return document.activeElement.getAttribute('role')")
        for name in names:
            self.h.popup_keys(Keys.CONTROL, "a")
            self.h.popup("const i=document.querySelector('[role=combobox]'); const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; setter.call(i,''); i.dispatchEvent(new Event('input',{bubbles:true})); return 1")
            self.h.popup_keys(name)
            options = lambda: self.h.popup("return Array.from(document.querySelectorAll('[role=option]')).map(o => o.innerText.trim())")
            self.h.wait(lambda: any(name in o for o in options()), 15, f"option {name}")
            for _ in range(30):
                active = self.h.popup("const i=document.querySelector('[role=combobox]'); const id=i.getAttribute('aria-activedescendant'); const el=id&&document.getElementById(id); return el ? el.innerText.trim() : ''")
                if name in active:
                    break
                self.h.popup_keys(Keys.ARROW_DOWN)
            self.h.popup_keys(Keys.ENTER)
            self.h.wait(lambda: self.h.popup("return Array.from(document.querySelectorAll('[role=option][aria-selected=true]')).map(o => o.innerText.trim())"), 10, "selection")
        # firefox owns escape in a browser-action popup (a native escape closes the
        # panel before content sees it), so the chooser closes through its trigger.
        self.h.popup("""
            const trigger = Array.from(document.querySelectorAll('button')).find(b => (b.getAttribute('aria-label') || b.innerText || '').toLowerCase().startsWith('libraries'));
            trigger.focus(); return document.activeElement === trigger;
        """)
        self.h.popup_keys(Keys.ENTER)
        self.h.wait(lambda: not self.h.popup("return !!document.querySelector('[role=combobox]')"), 5, "chooser closed")
        focused = self.h.popup("return (document.activeElement && (document.activeElement.getAttribute('aria-label') || document.activeElement.innerText || document.activeElement.tagName)) || ''")
        log("focus after closing the chooser", focused)

    def click_button_containing(self, fragment: str) -> None:
        from selenium.webdriver.common.keys import Keys

        self.h.popup(
            """
            const el = Array.from(document.querySelectorAll('button')).find(b => (b.innerText||'').toLowerCase().includes(arguments[0].toLowerCase()) || (b.getAttribute('aria-label')||'').toLowerCase().includes(arguments[0].toLowerCase()));
            if (!el) throw new Error('no button containing ' + arguments[0] + ' in: ' + Array.from(document.querySelectorAll('button')).map(b=>b.innerText.trim()).join('|'));
            el.focus();
            if (document.activeElement !== el) throw new Error('could not focus ' + arguments[0]);
            return true;
            """,
            fragment,
        )
        self.h.popup_keys(Keys.ENTER)


    def save(self, label: str = "Save") -> None:
        """press the primary action with real input; answer the permission prompt only
        when the popup announced that firefox will ask."""
        announced = "Firefox will ask" in self.text()
        self.click_button_containing(label)
        if announced:
            self.answer_permission_prompt(True, seconds=10)
            log("permission prompt", "allowed")

    def close(self, keep: bool = False) -> None:
        self.h.quit()
        if not keep:
            shutil.rmtree(self.profile_dir, ignore_errors=True)


def log(label: str, value=None) -> None:
    text = "" if value is None else (json.dumps(value, default=str)[:900] if not isinstance(value, str) else value[:900])
    print(f"[{label}]", text.replace("\n", " | "), flush=True)


# =============================================================================
# journeys
# =============================================================================


def journey_login_identity(j: Journey) -> None:
    """signed-out toolbar capture resumes the pinned document; navigation cannot substitute the source."""
    db.reset_user_content()
    j.d.get(f"{FIXTURE}/articles/green-knight")
    time.sleep(1)
    j.h.open_popup()
    j.wait_text("The Green Knight")
    log("signed-out popup", j.text())
    assert "Sign in to Nexus" in j.text(), "expected sign-in affordance"
    # substitution attempt: navigate the tab away before login
    j.login_through_hosted_flow()
    j.h.wait(j.h.popup_open, 20, "popup reopened by background after login")
    j.wait_text("The Green Knight")
    log("post-login popup", j.text())
    j.d.switch_to.window(j.h.content_handle)
    j.d.get(f"{FIXTURE}/links")
    time.sleep(1)
    j.h.open_popup()
    j.wait_text("The Green Knight")
    assert "Links" not in j.text().split("Sign")[0], "navigation substituted the pinned source"
    j.save()
    j.wait_text("Saved", 60)
    media = db.media_for_user()
    log("media", media)
    assert len(media) == 1 and media[0]["kind"] == "web_article"
    assert media[0]["canonical_source_url"].startswith("http://fixtures.nexus-capture.test:8899/articles/green-knight")
    sessions = db.sessions_for_user()
    assert len(sessions) == 1 and sessions[0]["published_media_id"] == media[0]["id"]
    assert sessions[0]["input_origin"]["kind"] == "BrowserCapture"


def journey_article_libraries(j: Journey) -> None:
    db.reset_user_content()
    lib_a = db.create_library("Arthuriana")
    lib_b = db.create_library("Bestiary")
    try:
        j.d.get(f"{FIXTURE}/articles/green-knight")
        time.sleep(1)
        j.h.open_popup()
        j.wait_text("The Green Knight")
        if "Sign in to Nexus" in j.text():
            j.login_through_hosted_flow()
            j.h.wait(j.h.popup_open, 20, "popup reopened")
            j.wait_text("The Green Knight")
        j.choose_destinations(["Arthuriana", "Bestiary"])
        log("after chooser", j.text())
        j.save()
        j.wait_text("Saved", 60)
        media = db.media_for_user()
        assert len(media) == 1
        entries = db.entries_for_media(media[0]["id"])
        log("entries", entries)
        names = {e["name"] for e in entries if not e["is_default"]}
        assert names == {"Arthuriana", "Bestiary"}, names
        assert any(e["is_default"] for e in entries)
        attempt = db.attempts_for_media(media[0]["id"])[0]
        packet = json.loads(db.get_object(attempt["source_payload"]["storage_path"]))
        log("packet keys", list(packet.keys()))
        content = packet["content_html"]
        for sentinel in ("BEGIN-SENTINEL-8a1f", "END-SENTINEL-c2d9", 'href="http://fixtures.nexus-capture.test:8899/notes/green.html"', 'id="fn1"', "fnref1"):
            assert sentinel in content, f"missing {sentinel}"
        for secret in ("SCRIPT-SECRET", "ACCOUNT-SECRET", "DATA-SECRET", "FORM-SECRET", "HIDDEN-SECRET", "data-private-token", "onclick"):
            assert secret not in json.dumps(packet), f"leaked {secret}"
        assert "youtube.com/embed/dQw4w9WgXcQ" in packet["content_html"] + packet["source_html"], "embed evidence lost"
        assert "twitter.com/gawain/status/1234567890" in packet["content_html"] + packet["source_html"], "quote evidence lost"
        assert hashlib.sha256(db.get_object(attempt["source_payload"]["storage_path"])).hexdigest() == media[0]["browser_capture_sha256"]
        # zero additional libraries: a second, different capture
        j.h.close_popup()
        j.d.get(f"{FIXTURE}/links")
    finally:
        pass


def journey_document_entry(j: Journey) -> None:
    db.reset_user_content()
    j.d.get(f"{FIXTURE}/links")
    time.sleep(1)
    link = j.d.find_element(By.ID, "epub-link")
    j.h.context_menu_link(link, "Add link to Nexus…")
    j.h.wait(j.h.popup_open, 20, "popup after menu")
    j.wait_text("the fixture book (epub)")
    log("menu popup", j.text())
    if "Sign in to Nexus" in j.text():
        j.login_through_hosted_flow()
        j.h.wait(j.h.popup_open, 20, "popup reopened")
    j.save()
    j.wait_text("Saved", 60)
    media = db.media_for_user()
    assert len(media) == 1 and media[0]["kind"] == "epub", media
    mf = db.one("select storage_path, source_sha256, size_bytes from media_file where media_id = %s", media[0]["id"])
    assert mf["source_sha256"] == EPUB_SHA and mf["size_bytes"] == len(fixtures.EPUB), mf
    assert hashlib.sha256(db.get_object(mf["storage_path"])).hexdigest() == EPUB_SHA
    assert media[0]["browser_capture_sha256"] == EPUB_SHA
    log("epub ok", mf)


JOURNEYS = {
    "login": journey_login_identity,
    "article": journey_article_libraries,
    "document": journey_document_entry,
}

# -----------------------------------------------------------------------------------------------
# refusal / lifetime / authority / cutover
# -----------------------------------------------------------------------------------------------


def _open_menu_target(j: Journey, link_id: str, label_fragment: str) -> None:
    j.d.get(f"{FIXTURE}/links")
    time.sleep(1)
    j.h.context_menu_link(j.d.find_element(By.ID, link_id), "Add link to Nexus…")
    j.h.wait(j.h.popup_open, 20, "popup after menu")
    j.wait_text(label_fragment)
    if "Sign in to Nexus" in j.text():
        j.login_through_hosted_flow()
        j.h.wait(j.h.popup_open, 20, "popup reopened")
        j.wait_text(EMAIL)


def journey_denial(j: Journey) -> None:
    """denying the origin prompt keeps the draft and starts nothing; allowing later proceeds."""
    db.reset_user_content()
    j.d.get(f"{FIXTURE}/links")
    time.sleep(1)
    j.h.context_menu_link(j.d.find_element(By.ID, "pdf-link"), "Add link to Nexus…")
    j.h.wait(j.h.popup_open, 20, "popup after menu")
    j.wait_text("the fixture paper (pdf)")
    assert "Firefox will ask" in j.text(), "the popup must announce the origin prompt"
    j.click_button("Sign in to Nexus")
    j.answer_permission_prompt(False)
    j.h.wait(lambda: "the fixture paper (pdf)" in j.text() and "Sign in to Nexus" in j.text(), 10, "draft retained, still signed out")
    log("after denial", j.text())
    assert db.sessions_for_user() == [] and db.media_for_user() == [], "denied permission created work"
    assert len(j.h.windows()) == 1, "denied permission must not start the login"
    j.login_through_hosted_flow()
    j.h.wait(j.h.popup_open, 20, "popup reopened")
    j.wait_text(EMAIL)
    log("after allow", j.text())


def journey_refusal(j: Journey) -> None:
    db.reset_user_content()
    # html-as-document fails explicitly without another acquisition
    _open_menu_target(j, "login-link", "a pdf link that returns a login page")
    j.save()
    j.h.wait(lambda: any(w in j.text().lower() for w in ("not a pdf", "not a pdf or epub", "html", "unsupported", "couldn")), 30, "html refusal")
    log("html refusal", j.text())
    assert db.media_for_user() == [], "html document produced media"
    j.click_button("Discard")
    j.wait_gone("a pdf link that returns a login page")
    # oversized stream stops without media
    j.h.close_popup()
    _open_menu_target(j, "huge-link", "oversized stream")
    j.save()
    j.h.wait(lambda: any(w in j.text().lower() for w in ("too large", "larger than", "limit", "exceed")), 60, "size refusal")
    log("size refusal", j.text())
    assert db.media_for_user() == [], "oversized stream produced media"
    j.click_button("Discard")
    j.wait_gone("oversized stream")
    # blocked cross-origin redirect fails without switching context
    j.h.close_popup()
    _open_menu_target(j, "redirect-cross-link", "cross-origin redirect to paper")
    j.save()
    j.h.wait(lambda: "saved" in j.text().lower() or any(w in j.text().lower() for w in ("couldn", "failed", "blocked", "redirect")), 40, "cross redirect outcome")
    log("cross redirect outcome", j.text())
    assert db.media_for_user() == [], "cross-origin redirect was followed in another context"


def journey_same_origin_redirect_and_extensionless(j: Journey) -> None:
    db.reset_user_content()
    for link_id, label in (("redirect-same-link", "same-origin redirect to paper"), ("extensionless-link", "extensionless paper"), ("signed-link", "signed paper")):
        _open_menu_target(j, link_id, label)
        text = j.text()
        assert "SIGNED-SECRET" not in text, "signed query parameter displayed"
        j.save()
        j.wait_text("Saved", 60)
        j.h.close_popup()
    media = db.media_for_user()
    log("media", media)
    assert len(media) == 1, "identical bytes must reuse one media"
    sessions = db.sessions_for_user()
    assert len(sessions) == 3 and all(s["published_media_id"] == media[0]["id"] for s in sessions), sessions
    urls = {s["input_origin"]["source_url"] for s in sessions}
    assert any("sig=SIGNED-SECRET-ab12" in u for u in urls), "signed query parameters must be retained as source data"
    mf = db.one("select source_sha256 from media_file where media_id = %s", media[0]["id"])
    assert mf["source_sha256"] == PDF_SHA


def journey_lifetime(j: Journey) -> None:
    """close the popup during a delayed transfer; restart firefox; explicit resume; discard."""
    db.reset_user_content()
    _open_menu_target(j, "epub-link", "the fixture book (epub)")
    j.save()
    j.h.wait(lambda: any(w in j.text().lower() for w in ("uploading", "transferring", "saving")), 20, "transfer started")
    j.h.close_popup()
    time.sleep(12)  # the delay proxy holds the PUT for 8s; the background must finish alone
    j.h.open_popup()
    j.wait_text("Saved", 30)
    log("saved after popup closure", j.text())
    assert len(db.media_for_user()) == 1
    # restart with a fresh capture mid-transfer: quit firefox while transferring
    db.reset_user_content()
    j.h.close_popup()
    _open_menu_target(j, "pdf-link", "the fixture paper (pdf)")
    j.save()
    j.h.wait(lambda: any(w in j.text().lower() for w in ("uploading", "transferring", "saving")), 20, "transfer started")
    profile = j.profile_dir
    j.h.quit()
    time.sleep(2)
    j.h = Harness(DIST, profile_dir=profile, log_path=os.path.join(profile, "geckodriver-2.log"))
    j.d = j.h.driver
    j.d.get(f"{FIXTURE}/links")
    time.sleep(1)
    j.h.open_popup()
    j.wait_text("Resume", 20)
    log("restart popup", j.text())
    assert "the fixture paper (pdf)" in j.text(), "restart lost the immutable target"
    j.click_button("Resume")
    j.wait_text("Saved", 60)
    media = db.media_for_user()
    assert len(media) == 1 and media[0]["kind"] == "pdf"
    # discard then new capture: the slot is free
    j.h.close_popup()
    _open_menu_target(j, "epub-link", "the fixture book (epub)")
    j.click_button("Discard")
    j.wait_gone("the fixture book (epub)")
    j.h.close_popup()
    _open_menu_target(j, "epub-link", "the fixture book (epub)")
    j.save()
    j.wait_text("Saved", 60)
    assert len(db.media_for_user()) == 2


def journey_authority(j: Journey) -> None:
    db.reset_user_content()
    lib = db.create_library("Ephemera")
    j.d.get(f"{FIXTURE}/articles/green-knight")
    time.sleep(1)
    j.h.open_popup()
    j.wait_text("The Green Knight")
    if "Sign in to Nexus" in j.text():
        j.login_through_hosted_flow()
        j.h.wait(j.h.popup_open, 20, "popup reopened")
        j.wait_text("The Green Knight")
    j.choose_destinations(["Ephemera"])
    db.delete_library(lib)  # revoked between selection and save
    j.click_button("Save")
    try:
        j.answer_permission_prompt(True, seconds=5)
    except TimeoutError:
        pass
    j.h.wait(lambda: any(w in j.text().lower() for w in ("librar", "forbidden", "no longer", "couldn")), 40, "revoked destination refusal")
    log("revoked destination", j.text())
    assert db.media_for_user() == [], "revoked destination published media"


def journey_disconnect_failure(j: Journey, stop_api, start_api) -> None:
    j.d.get(f"{FIXTURE}/articles/green-knight")
    time.sleep(1)
    j.h.open_popup()
    if "Sign in to Nexus" in j.text():
        j.login_through_hosted_flow()
        j.h.wait(j.h.popup_open, 20, "popup reopened")
    stop_api()
    try:
        j.click_button("Disconnect")
        j.h.wait(lambda: any(w in j.text().lower() for w in ("couldn", "failed", "retry")), 30, "revocation failure visible")
        log("failed disconnect", j.text())
        assert "Sign in to Nexus" not in j.text(), "credential forgotten before confirmed revocation"
    finally:
        start_api()
    j.click_button_containing("Retry")
    j.h.wait(lambda: "Sign in to Nexus" in j.text(), 30, "signed out after confirmed revocation")
    log("confirmed disconnect", j.text())


JOURNEYS.update({
    "denial": journey_denial,
    "refusal": journey_refusal,
    "redirects": journey_same_origin_redirect_and_extensionless,
    "lifetime": journey_lifetime,
    "authority": journey_authority,
})


if __name__ == "__main__":
    name = sys.argv[1]
    keep = "--keep" in sys.argv
    j = Journey(name)
    try:
        JOURNEYS[name](j)
        log("PASS", name)
    except Exception:
        log("FAIL", name)
        try:
            log("popup text at failure", j.text())
            log("buttons at failure", j.h.popup("return Array.from(document.querySelectorAll('button')).map(b => (b.innerText||'').trim() + (b.disabled ? ' [disabled]' : ''))"))
        except Exception:
            pass
        raise
    finally:
        j.close(keep=keep)
