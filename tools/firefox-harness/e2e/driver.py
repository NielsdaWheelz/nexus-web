"""temporary geckodriver plumbing for the firefox capture v1 journeys.

it operates the installed extension's real toolbar button, context menu and popup:
the popup document is reached through marionette's own window actor for the popup
browser (the popup is not a tab, so ordinary frame switching cannot see it).
"""

from __future__ import annotations

import json
import os
import time

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service

FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
ADDON_ID = "capture@nexus.local"
WIDGET_ID = "capture_nexus_local-browser-action"
LOCAL_DOMAINS = "fixtures.nexus-capture.test,other.nexus-capture.test"

POPUP_EXEC = """
const done = arguments[arguments.length - 1];
const b = document.querySelector('browser[webextension-view-type="popup"]');
if (!b) { done({error: "no popup browser"}); return; }
const actor = b.browsingContext.currentWindowGlobal.getActor("MarionetteCommands");
actor.executeScript(arguments[0], arguments[1] || [], {timeout: arguments[2] || 10000})
  .then(v => done({value: v}), e => done({error: String(e)}));
"""

BACKGROUND_EXEC = """
const done = arguments[arguments.length - 1];
const {ExtensionParent} = ChromeUtils.importESModule("resource://gre/modules/ExtensionParent.sys.mjs");
const ext = ExtensionParent.GlobalManager.getExtension(arguments[0]);
if (!ext) { done({error: "extension not found"}); return; }
const view = ext.backgroundContext;
if (!view) { done({error: "no background context"}); return; }
const bc = view.browsingContext || (view.xulBrowser && view.xulBrowser.browsingContext) || (view.contentWindow && view.contentWindow.browsingContext);
if (!bc) { done({error: "no background browsing context"}); return; }
const actor = bc.currentWindowGlobal.getActor("MarionetteCommands");
actor.executeScript(arguments[1], arguments[2] || [], {timeout: 10000}).then(v => done({value: v}), e => done({error: String(e)}));
"""


class PopupError(RuntimeError):
    pass


class Harness:
    def __init__(self, dist_dir: str, profile_dir: str | None = None, log_path: str = "geckodriver.log"):
        opts = Options()
        opts.binary_location = FIREFOX
        opts.set_preference("network.dns.localDomains", LOCAL_DOMAINS)
        opts.set_preference("browser.startup.homepage", "about:blank")
        opts.set_preference("browser.startup.page", 0)
        opts.set_preference("extensions.webextensions.remote", True)
        if profile_dir:
            # geckodriver uses the directory itself when -profile is an argument, so
            # indexeddb and extension storage survive a firefox restart.
            os.makedirs(profile_dir, exist_ok=True)
            opts.add_argument("-profile")
            opts.add_argument(profile_dir)
        self.driver = webdriver.Firefox(
            options=opts, service=Service(service_args=["--allow-system-access"], log_output=log_path)
        )
        self.dist_dir = dist_dir
        self.addon_id = self.driver.install_addon(dist_dir, temporary=True)
        self.content_handle = self.driver.current_window_handle
        self.wait(self._pin_toolbar_button, 10, "toolbar button")

    def _pin_toolbar_button(self) -> bool:
        return bool(
            self.chrome(
                """
                const CustomizableUI = window.CustomizableUI || ChromeUtils.importESModule("moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs").CustomizableUI;
                if (!CustomizableUI.getWidget(arguments[0]) || !CustomizableUI.getWidget(arguments[0]).provider) return false;
                if (!CustomizableUI.getPlacementOfWidget(arguments[0])) CustomizableUI.addWidgetToArea(arguments[0], CustomizableUI.AREA_NAVBAR);
                return !!document.getElementById(arguments[0]);
                """,
                WIDGET_ID,
            )
        )

    # -- contexts ---------------------------------------------------------------------
    def chrome(self, script: str, *args):
        self.driver.set_context("chrome")
        try:
            return self.driver.execute_script(script, *args)
        finally:
            self.driver.set_context("content")

    def chrome_async(self, script: str, *args):
        self.driver.set_context("chrome")
        try:
            return self.driver.execute_async_script(script, *args)
        finally:
            self.driver.set_context("content")

    # -- toolbar / popup ------------------------------------------------------------------
    def click_toolbar(self) -> None:
        self.chrome(
            "const el = document.getElementById(arguments[0]); (el.querySelector('toolbarbutton') || el).click();",
            WIDGET_ID,
        )

    def popup_open(self) -> bool:
        return bool(self.chrome("return !!document.querySelector('browser[webextension-view-type=\"popup\"]')"))

    def close_popup(self) -> None:
        # a native escape is what a user presses; firefox closes the panel with it.
        self.chrome("""
            document.querySelector('browser[webextension-view-type="popup"]').focus();
            window.windowUtils.sendNativeKeyEvent(0, 53, 0, "", "", null);
        """)
        try:
            self.wait(lambda: not self.popup_open(), 3, "popup close")
        except TimeoutError:
            self.chrome("for (const p of document.querySelectorAll('panel')) if (p.state === 'open') p.hidePopup();")
            self.wait(lambda: not self.popup_open(), 5, "popup close")

    def popup(self, script: str, *args, timeout_ms: int = 10000):
        result = self.chrome_async(POPUP_EXEC, script, list(args), timeout_ms)
        if "error" in result:
            raise PopupError(result["error"])
        return result["value"]

    def popup_text(self) -> str:
        return self.popup("return document.body.innerText")

    def popup_click(self, selector: str) -> None:
        self.popup(
            "const el = document.querySelector(arguments[0]); if (!el) throw new Error('missing ' + arguments[0]); el.click(); return true",
            selector,
        )

    def popup_key(self, selector: str, key: str, **init) -> None:
        self.popup(
            """
            const el = arguments[0] ? document.querySelector(arguments[0]) : document.activeElement;
            if (!el) throw new Error('missing ' + arguments[0]);
            const init = Object.assign({key: arguments[1], bubbles: true, cancelable: true}, arguments[2] || {});
            el.dispatchEvent(new KeyboardEvent('keydown', init));
            el.dispatchEvent(new KeyboardEvent('keyup', init));
            return document.activeElement && (document.activeElement.id || document.activeElement.tagName);
            """,
            selector,
            key,
            init,
        )

    def focus_popup(self) -> None:
        self.chrome("document.querySelector('browser[webextension-view-type=\"popup\"]').focus()")

    def popup_keys(self, *keys: str) -> None:
        """real keyboard input: focus the popup browser at chrome level, then send keys."""
        from selenium.webdriver.common.action_chains import ActionChains

        self.driver.set_context("chrome")
        try:
            self.driver.execute_script("document.querySelector('browser[webextension-view-type=\"popup\"]').focus()")
            chain = ActionChains(self.driver)
            for key in keys:
                chain = chain.send_keys(key)
            chain.perform()
        finally:
            self.driver.set_context("content")

    def open_popup(self) -> None:
        if not self.popup_open():
            self.click_toolbar()
        self.wait(self.popup_open, 5, "popup open")
        time.sleep(0.4)

    # -- background -------------------------------------------------------------------------
    def background(self, script: str, *args):
        result = self.chrome_async(BACKGROUND_EXEC, ADDON_ID, script, list(args))
        if "error" in result:
            raise PopupError(result["error"])
        return result["value"]

    # -- context menu -------------------------------------------------------------------
    def context_menu_link(self, element, label: str) -> None:
        from selenium.webdriver.common.action_chains import ActionChains

        ActionChains(self.driver).context_click(element).perform()
        time.sleep(0.8)
        outcome = self.chrome(
            """
            const m = document.getElementById('contentAreaContextMenu');
            const it = Array.from(m.querySelectorAll('menuitem')).find(i => i.label === arguments[0]);
            if (!it) return {labels: Array.from(m.querySelectorAll('menuitem')).filter(i => !i.hidden).map(i => i.label)};
            it.doCommand ? it.doCommand() : it.click();
            m.hidePopup();
            return {clicked: true};
            """,
            label,
        )
        if not outcome.get("clicked"):
            raise PopupError(f"menu item {label!r} missing; visible: {outcome.get('labels')}")

    # -- windows ---------------------------------------------------------------------------
    def windows(self) -> list[str]:
        return list(self.driver.window_handles)

    def wait(self, predicate, seconds: float, what: str):
        deadline = time.monotonic() + seconds
        last = None
        while time.monotonic() < deadline:
            try:
                last = predicate()
                if last:
                    return last
            except Exception as exc:  # noqa: BLE001 - polling
                last = exc
            time.sleep(0.25)
        raise TimeoutError(f"timed out waiting for {what}: {last!r}")

    def quit(self) -> None:
        self.driver.quit()
