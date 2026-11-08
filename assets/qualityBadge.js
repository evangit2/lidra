/**
 * Delivered-quality indicator.
 *
 * Apple's player bar names a quality; Lidra's job is to make the name true. The
 * pill shows the tier the audio pipeline actually measured in the stream's own
 * codec configuration — read from the initialisation segment, not from the
 * manifest — and opens a popover with the full breakdown.
 *
 * The pill lives inside Apple's own LCD, in the after-metadata slot where the
 * PREVIEW badge sits, and borrows that badge's design tokens (--systemTertiary,
 * --pageBG, --footnote-emphasized) so it follows Apple's light and dark schemes
 * and Lidra's themes without a colour of its own. The popover uses the material,
 * border and shadow of Apple's own popovers. Svelte can rebuild the LCD on a
 * track change, so an observer puts the pill back when it is dropped.
 */
(() => {
  if (window.__lidraQualityInstalled) return;
  window.__lidraQualityInstalled = true;

  const STYLE_ID = "lidra-quality-style";
  const BADGE_ID = "lidra-quality-badge";
  const PANEL_ID = "lidra-quality-panel";
  const SLOT_SELECTORS = [
    '[data-testid="player-lcd-after-metadata"] .after-metadata',
    ".player-lcd__after-metadata .after-metadata",
    '[data-testid="player-lcd-after-metadata"]',
  ];

  const TIER_TITLES = {
    "hi-res": "Hi-Res Lossless",
    lossless: "Lossless",
    atmos: "Dolby Atmos",
    "dolby-audio": "Dolby Audio",
    aac: "High Quality",
  };

  // Apple's lossless glyph: a waveform of rounded bars.
  const WAVE_ICON =
    '<svg viewBox="0 0 16 10" aria-hidden="true"><path d="M1 4.2v1.6M4 2.6v4.8M7 .9v8.2M10 2.6v4.8M13 3.6v2.8M15 4.4v1.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';

  const FONT_STACK =
    '-apple-system, BlinkMacSystemFont, "SF Pro", "Helvetica Neue", Helvetica, Arial, sans-serif';

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        all: unset;
        box-sizing: border-box;
        display: none;
        align-items: center;
        gap: 3px;
        flex: 0 0 auto;
        padding: 2px 6px 2px 5px;
        border-radius: 1000px;
        background: var(--systemTertiary, rgba(255,255,255,0.4));
        color: var(--pageBG, #1f1f1f);
        font: var(--footnote-emphasized, 600 10px/1.3 ${FONT_STACK});
        white-space: nowrap;
        cursor: pointer;
        transition: background-color 120ms ease, opacity 120ms ease;
      }
      #${BADGE_ID}[data-visible="true"] { display: inline-flex; }
      #${BADGE_ID}:hover { background: var(--systemSecondary, rgba(255,255,255,0.64)); }
      #${BADGE_ID}:active { opacity: 0.75; }
      #${BADGE_ID}:focus-visible { outline: 2px solid var(--keyColor, #fa2d48); outline-offset: 1px; }
      #${BADGE_ID}[data-verdict="mismatch"] { background: var(--systemOrange, #ff9f0a); color: #1f1f1f; }
      #${BADGE_ID} svg { width: 11px; height: 8px; flex: 0 0 auto; }

      #${PANEL_ID} {
        position: fixed;
        z-index: 2147483647;
        width: 260px;
        box-sizing: border-box;
        padding: 14px 0 6px;
        border: 0.5px solid rgba(0,0,0,0.2);
        border-radius: 10px;
        background-color: var(--systemStandardThickMaterialSover-default_IC, rgba(40,40,40,0.96));
        box-shadow: inset 0 0 0 1px rgba(255,255,255,0.2), 0 8px 40px var(--dialogShadowColor, rgba(0,0,0,0.4));
        color: var(--systemPrimary, rgba(255,255,255,0.92));
        font: var(--body, 400 13px/1.23 ${FONT_STACK});
        transform-origin: bottom center;
        animation: lidra-quality-in 140ms ease-out;
      }
      @supports ((-webkit-backdrop-filter: blur(10px)) or (backdrop-filter: blur(10px))) {
        #${PANEL_ID} {
          background-color: var(--systemStandardThickMaterialSover, rgba(40,40,40,0.72));
          -webkit-backdrop-filter: blur(60px) saturate(210%);
          backdrop-filter: blur(60px) saturate(210%);
        }
      }
      @keyframes lidra-quality-in {
        from { opacity: 0; transform: translateY(4px) scale(0.98); }
        to { opacity: 1; transform: none; }
      }
      #${PANEL_ID} .lidra-head { display: flex; align-items: center; gap: 10px; padding: 0 14px 12px; }
      #${PANEL_ID} .lidra-glyph {
        display: grid; place-items: center; flex: 0 0 auto;
        width: 30px; height: 30px; border-radius: 7px;
        background: var(--systemQuaternary, rgba(255,255,255,0.1));
        color: var(--systemPrimary, rgba(255,255,255,0.92));
      }
      #${PANEL_ID} .lidra-glyph svg { width: 17px; height: 11px; }
      #${PANEL_ID}[data-verdict="mismatch"] .lidra-glyph { color: var(--systemOrange, #ff9f0a); }
      #${PANEL_ID} .lidra-title { font: var(--title-3-emphasized, 600 15px/1.33 ${FONT_STACK}); }
      #${PANEL_ID} .lidra-subtitle { font: var(--subhead, 400 11px/1.27 ${FONT_STACK}); color: var(--systemSecondary, rgba(255,255,255,0.64)); }
      #${PANEL_ID} dl {
        display: grid; grid-template-columns: auto 1fr; gap: 5px 12px;
        margin: 0; padding: 10px 14px;
        border-top: 1px solid var(--labelDivider, rgba(255,255,255,0.1));
        font: var(--callout, 400 12px/1.25 ${FONT_STACK});
      }
      #${PANEL_ID} dt { color: var(--systemSecondary, rgba(255,255,255,0.64)); }
      #${PANEL_ID} dd { margin: 0; text-align: end; font-variant-numeric: tabular-nums; }
      #${PANEL_ID} .lidra-note {
        margin: 0; padding: 0 14px 10px;
        font: var(--footnote, 400 10px/1.3 ${FONT_STACK});
        color: var(--systemSecondary, rgba(255,255,255,0.64));
      }
      #${PANEL_ID}[data-verdict="mismatch"] .lidra-note { color: var(--systemOrange, #ff9f0a); }
      #${PANEL_ID} .lidra-menu-item {
        all: unset; box-sizing: border-box; display: flex; justify-content: space-between;
        width: calc(100% - 12px); margin: 0 6px; padding: 6px 8px; border-radius: 5px;
        border-top: 1px solid transparent;
        font: var(--body, 400 13px/1.23 ${FONT_STACK});
        color: var(--systemPrimary, rgba(255,255,255,0.92));
        cursor: pointer;
      }
      #${PANEL_ID} .lidra-sep { height: 1px; margin: 0 14px 5px; background: var(--labelDivider, rgba(255,255,255,0.1)); }
      #${PANEL_ID} .lidra-menu-item:hover,
      #${PANEL_ID} .lidra-menu-item:focus-visible { background: var(--keyColorBG, #fa2d48); color: #fff; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function findSlot() {
    for (const selector of SLOT_SELECTORS) {
      const slot = document.querySelector(selector);
      if (slot) return slot;
    }
    return null;
  }

  function badge() {
    let node = document.getElementById(BADGE_ID);
    if (node) return node;
    node = document.createElement("button");
    node.id = BADGE_ID;
    node.type = "button";
    node.setAttribute("data-verdict", "ok");
    node.setAttribute("aria-haspopup", "dialog");
    node.innerHTML = `${WAVE_ICON}<span class="lidra-text"></span>`;
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (document.getElementById(PANEL_ID)) closePanel();
      else openPanel();
    });
    return node;
  }

  /** Put the pill in Apple's LCD, before the PREVIEW badge. */
  function mount() {
    const node = document.getElementById(BADGE_ID) || (window.__lidraQualityLast ? badge() : null);
    if (!node) return;
    const slot = findSlot();
    if (!slot) {
      if (node.parentNode) node.parentNode.removeChild(node);
      return;
    }
    if (node.parentNode !== slot || slot.firstChild !== node) slot.insertBefore(node, slot.firstChild);
  }

  let mountQueued = false;
  function queueMount() {
    if (mountQueued) return;
    mountQueued = true;
    requestAnimationFrame(() => {
      mountQueued = false;
      mount();
    });
  }

  function escapeText(value) {
    return String(value).replace(/[<>&"]/g, "");
  }

  function row(label, value) {
    if (value === null || value === undefined || value === "") return "";
    return `<dt>${label}</dt><dd>${escapeText(value)}</dd>`;
  }

  let teardown = null;
  function closePanel() {
    if (teardown) teardown();
  }

  function openPanel() {
    const data = window.__lidraQualityLast;
    const anchor = document.getElementById(BADGE_ID);
    if (!data || !anchor) return;
    ensureStyle();
    closePanel();

    const tier = data.tier || (data.verdict === "mismatch" ? "aac" : "lossless");
    const title = TIER_TITLES[tier] || "Audio";
    const detail = data.detail || data.label || "";
    const verified = data.verified !== false && data.verdict !== "mismatch";

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "Audio quality");
    panel.setAttribute("data-verdict", verified ? "ok" : "mismatch");
    panel.innerHTML = `
      <div class="lidra-head">
        <div class="lidra-glyph">${WAVE_ICON}</div>
        <div>
          <div class="lidra-title">${escapeText(title)}</div>
          <div class="lidra-subtitle">${escapeText(detail)}</div>
        </div>
      </div>
      <dl>
        ${row("Codec", (data.codec || "").toUpperCase())}
        ${row("Bit depth", data.bitDepth ? `${data.bitDepth}-bit` : "—")}
        ${row("Sample rate", data.sampleRate ? `${(data.sampleRate / 1000).toFixed(1)} kHz` : "—")}
        ${row("Channels", data.channels ? (data.channels === 2 ? "Stereo" : `${data.channels} channels`) : "—")}
        ${row("Bitrate", data.bitrateKbps ? `${data.bitrateKbps} kbps` : "—")}
        ${row("Source", data.transport || "—")}
      </dl>
      <p class="lidra-note">${
        verified
          ? "Verified by Lidra from the stream's codec configuration."
          : escapeText(
              data.mismatches && data.mismatches.length
                ? `Not the requested tier: ${data.mismatches.join("; ")}`
                : "This stream does not match the requested tier.",
            )
      }</p>
      <div class="lidra-sep"></div>
      <button type="button" class="lidra-menu-item" id="lidra-quality-settings">Audio Quality Settings…</button>
    `;
    (document.documentElement || document.body).appendChild(panel);

    // Sit above the pill, centred on it, kept inside the window.
    const place = () => {
      const rect = anchor.getBoundingClientRect();
      const width = panel.offsetWidth;
      const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), innerWidth - width - 8);
      panel.style.left = `${Math.round(left)}px`;
      panel.style.bottom = `${Math.round(innerHeight - rect.top + 10)}px`;
    };
    place();

    const onPointer = (event) => {
      if (!panel.contains(event.target) && !anchor.contains(event.target)) closePanel();
    };
    const onKey = (event) => {
      if (event.key === "Escape") closePanel();
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", place);
    anchor.setAttribute("aria-expanded", "true");

    teardown = () => {
      teardown = null;
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", place);
      anchor.setAttribute("aria-expanded", "false");
      if (panel.parentNode) panel.parentNode.removeChild(panel);
    };

    panel.querySelector("#lidra-quality-settings").addEventListener("click", () => {
      closePanel();
      try {
        window.AMWrapper?.ipcRenderer?.send("nav:settings");
      } catch (_) {
        /* the settings window is a convenience, not a requirement */
      }
    });
  }

  new MutationObserver(queueMount).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  /**
   * payload: { label, verdict, requested?, mismatches?, tier?, codec?,
   *            sampleRate?, bitDepth?, channels?, bitrateKbps?, transport?,
   *            detail?, verified? }
   */
  window.__lidraQuality = (payload) => {
    if (!payload || typeof payload.label !== "string") return;
    window.__lidraQualityLast = payload;
    ensureStyle();
    const node = badge();
    const text = node.querySelector(".lidra-text");
    const title = TIER_TITLES[payload.tier] || payload.label;
    if (text) text.textContent = payload.verdict === "mismatch" ? `${title} ⚠︎` : title;
    node.setAttribute("data-verdict", payload.verdict === "mismatch" ? "mismatch" : "ok");
    node.setAttribute("data-visible", "true");
    node.title = payload.detail || payload.label;
    node.setAttribute("aria-label", `${title}, ${payload.detail || payload.label}. Show audio quality details`);
    mount();
  };

  /** Replay the last measurement after an in-page navigation. */
  window.__lidraQualityReplay = () => {
    if (window.__lidraQualityLast) window.__lidraQuality(window.__lidraQualityLast);
  };
})();
