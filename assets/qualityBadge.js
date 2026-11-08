/**
 * Delivered-quality indicator.
 *
 * Apple's player bar names a quality; Lidra's job is to make the name true. The
 * pill shows the tier the audio pipeline actually measured in the stream's own
 * codec configuration — read from the initialisation segment, not from the
 * manifest — and opens a panel with the full breakdown, mirroring Apple's own
 * "Lossless · 24-bit/192 kHz ALAC" sheet.
 *
 * Everything is namespaced and fixed-position so it cannot shift or block the
 * page's own layout.
 */
(() => {
  if (window.__lidraQualityInstalled) return;
  window.__lidraQualityInstalled = true;

  const STYLE_ID = "lidra-quality-style";
  const BADGE_ID = "lidra-quality-badge";
  const PANEL_ID = "lidra-quality-panel";

  const TIER_TITLES = {
    "hi-res": "Hi-Res Lossless",
    lossless: "Lossless",
    atmos: "Dolby Atmos",
    "dolby-audio": "Dolby Audio",
    aac: "High Quality",
  };

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        position: fixed;
        left: 16px;
        bottom: 92px;
        z-index: 2147483646;
        display: none;
        align-items: center;
        gap: 8px;
        max-width: 46vw;
        padding: 6px 12px 6px 10px;
        border: 1px solid rgba(255,255,255,0.12);
        border-radius: 999px;
        background: rgba(18,18,20,0.86);
        color: #f5f5f7;
        font: 500 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        letter-spacing: 0.01em;
        box-shadow: 0 4px 18px rgba(0,0,0,0.35);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 140ms ease, border-color 140ms ease;
      }
      #${BADGE_ID}:hover { background: rgba(28,28,31,0.94); border-color: rgba(255,255,255,0.22); }
      #${BADGE_ID}[data-verdict="mismatch"] { background: rgba(72,45,12,0.92); color: #ffd899; }
      #${BADGE_ID} .lidra-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #34d399; flex: 0 0 auto;
      }
      #${BADGE_ID}[data-verdict="mismatch"] .lidra-dot { background: #f59e0b; }

      #${PANEL_ID} {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0,0,0,0.55);
        backdrop-filter: blur(6px);
        -webkit-backdrop-filter: blur(6px);
        font: 400 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      }
      #${PANEL_ID}[data-open="true"] { display: flex; }
      #${PANEL_ID} .lidra-card {
        width: 360px;
        max-width: 86vw;
        border-radius: 16px;
        background: #1c1c1e;
        color: #f5f5f7;
        box-shadow: 0 24px 64px rgba(0,0,0,0.55);
        padding: 22px 22px 16px;
      }
      #${PANEL_ID} .lidra-title {
        text-align: center; margin: 2px 0 2px;
        font: 600 17px/1.3 inherit;
      }
      #${PANEL_ID} .lidra-subtitle {
        text-align: center; color: #a1a1a6; margin: 0 0 16px; font-size: 13px;
      }
      #${PANEL_ID} .lidra-logo { display: flex; justify-content: center; margin-bottom: 10px; }
      #${PANEL_ID} dl {
        margin: 0 0 14px; display: grid; grid-template-columns: auto 1fr;
        gap: 6px 14px; font-size: 12.5px;
      }
      #${PANEL_ID} dt { color: #a1a1a6; }
      #${PANEL_ID} dd { margin: 0; text-align: right; color: #f5f5f7; }
      #${PANEL_ID} .lidra-note {
        color: #a1a1a6; font-size: 11.5px; text-align: center; margin: 0 0 14px;
      }
      #${PANEL_ID} .lidra-actions { display: flex; flex-direction: column; gap: 8px; }
      #${PANEL_ID} button {
        font: inherit; padding: 9px 14px; border-radius: 9px; border: none; cursor: pointer;
      }
      #${PANEL_ID} button.secondary { background: #2c2c2e; color: #f5f5f7; }
      #${PANEL_ID} button.primary { background: #0a84ff; color: #fff; font-weight: 600; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function badge() {
    let node = document.getElementById(BADGE_ID);
    if (node) return node;
    node = document.createElement("div");
    node.id = BADGE_ID;
    node.setAttribute("data-verdict", "ok");
    node.innerHTML = '<span class="lidra-dot"></span><span class="lidra-text"></span>';
    node.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openPanel();
    });
    // Mount on the document element so a page-level stacking context cannot
    // cover it; the player bar lives inside body.
    (document.documentElement || document.body).appendChild(node);
    return node;
  }

  function row(label, value) {
    if (value === null || value === undefined || value === "") return "";
    const safe = String(value).replace(/[<>&]/g, "");
    return `<dt>${label}</dt><dd>${safe}</dd>`;
  }

  function openPanel() {
    const data = window.__lidraQualityLast;
    if (!data) return;
    ensureStyle();
    const tier = data.tier || (data.verdict === "mismatch" ? "aac" : "lossless");
    const title = TIER_TITLES[tier] || "Audio";
    const detail = data.detail || data.label || "";
    const verified = data.verified !== false;

    let panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.setAttribute("data-open", "true");
    panel.innerHTML = `
      <div class="lidra-card">
        <div class="lidra-logo">
          <svg width="34" height="34" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="11" fill="#fa2d48"/>
            <path d="M15.6 6.4v7.1a2.1 2.1 0 1 1-1.3-1.9V8.2l-4.2.9v5.3a2.1 2.1 0 1 1-1.3-1.9V8.1c0-.3.2-.5.5-.6l6-1.3c.2 0 .3 0 .3.2z" fill="#fff"/>
          </svg>
        </div>
        <div class="lidra-title">${title}</div>
        <div class="lidra-subtitle">${detail}</div>
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
            ? "Measured from the stream's own codec configuration."
            : (data.mismatches && data.mismatches.length
                ? `Not the requested tier: ${data.mismatches.join("; ")}`
                : "This stream does not match the requested tier.")
        }</p>
        <div class="lidra-actions">
          <button class="secondary" id="lidra-quality-settings">Audio Quality Settings</button>
          <button class="primary" id="lidra-quality-ok">OK</button>
        </div>
      </div>
    `;
    (document.documentElement || document.body).appendChild(panel);

    const close = () => {
      if (panel && panel.parentNode) panel.parentNode.removeChild(panel);
    };
    panel.addEventListener("click", (event) => {
      if (event.target === panel) close();
    });
    panel.querySelector("#lidra-quality-ok").addEventListener("click", close);
    panel.querySelector("#lidra-quality-settings").addEventListener("click", () => {
      close();
      try {
        window.AMWrapper?.ipcRenderer?.send("nav:settings");
      } catch (_) {
        /* the settings window is a convenience, not a requirement */
      }
    });
    const onKey = (event) => {
      if (event.key === "Escape") {
        close();
        document.removeEventListener("keydown", onKey, true);
      }
    };
    document.addEventListener("keydown", onKey, true);
  }

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
    const title = TIER_TITLES[payload.tier] || "";
    if (text) {
      text.textContent =
        payload.verdict === "mismatch"
          ? `Lidra · ${payload.label}`
          : `Lidra · ${title || payload.label}${payload.detail ? ` · ${payload.detail}` : ""}`;
    }
    node.setAttribute("data-verdict", payload.verdict === "mismatch" ? "mismatch" : "ok");
    node.style.display = "inline-flex";
    node.title = "Click for audio quality details";
  };

  /** Replay the last measurement after an in-page navigation. */
  window.__lidraQualityReplay = () => {
    if (window.__lidraQualityLast) window.__lidraQuality(window.__lidraQualityLast);
  };
})();
