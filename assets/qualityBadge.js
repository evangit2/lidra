/**
 * Delivered-quality badge.
 *
 * Apple's player bar names a quality, and the whole point of Lidra is that the
 * name is true. This pill shows what the audio pipeline actually measured in the
 * stream's own codec configuration — read from the initialisation segment, not
 * from the manifest — so a mismatch is visible instead of silent.
 *
 * It is fixed-position and pointer-events:none so it can never shift or block
 * the page's own layout.
 */
(() => {
  if (window.__lidraQualityInstalled) return;
  window.__lidraQualityInstalled = true;

  const STYLE_ID = "lidra-quality-style";
  const BADGE_ID = "lidra-quality-badge";
  const FADE_MS = 260;
  const HOLD_MS = 7000;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${BADGE_ID} {
        position: fixed;
        left: 16px;
        bottom: 92px;
        z-index: 2147483647;
        display: flex;
        align-items: center;
        gap: 8px;
        max-width: 46vw;
        padding: 7px 12px;
        border-radius: 999px;
        background: rgba(20, 20, 22, 0.82);
        color: #f5f5f7;
        font: 500 12px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        letter-spacing: 0.01em;
        box-shadow: 0 4px 18px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        pointer-events: none;
        opacity: 0;
        transform: translateY(6px);
        transition: opacity ${FADE_MS}ms ease, transform ${FADE_MS}ms ease;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${BADGE_ID}[data-visible="true"] { opacity: 1; transform: translateY(0); }
      #${BADGE_ID}[data-verdict="mismatch"] { background: rgba(72, 45, 12, 0.9); color: #ffd899; }
      #${BADGE_ID} .lidra-dot {
        width: 7px; height: 7px; border-radius: 50%;
        background: #34d399; flex: 0 0 auto;
      }
      #${BADGE_ID}[data-verdict="mismatch"] .lidra-dot { background: #f59e0b; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  let hideTimer = null;

  function badge() {
    let node = document.getElementById(BADGE_ID);
    if (node) return node;
    node = document.createElement("div");
    node.id = BADGE_ID;
    node.setAttribute("data-visible", "false");
    node.innerHTML = '<span class="lidra-dot"></span><span class="lidra-text"></span>';
    // Mount on the document element so a page-level stacking context cannot
    // cover it; the player bar lives inside body.
    (document.documentElement || document.body).appendChild(node);
    return node;
  }

  /**
   * payload: { label, verdict, requested?, tier? }
   * `label` is the measured stream description, e.g. "ALAC 24-bit/192 kHz stereo".
   */
  window.__lidraQuality = (payload) => {
    if (!payload || typeof payload.label !== "string") return;
    ensureStyle();
    const node = badge();
    const text = node.querySelector(".lidra-text");
    if (text) {
      text.textContent =
        payload.verdict === "mismatch"
          ? `Lidra: ${payload.label} — not the ${payload.requested ?? "requested"} tier`
          : `Lidra · ${payload.label}`;
    }
    node.setAttribute("data-verdict", payload.verdict === "mismatch" ? "mismatch" : "ok");
    node.setAttribute("data-visible", "true");
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => node.setAttribute("data-visible", "false"), HOLD_MS);
  };

  /** Replay the last measurement after an in-page navigation. */
  window.__lidraQualityReplay = () => {
    if (window.__lidraQualityLast) window.__lidraQuality(window.__lidraQualityLast);
  };

  const original = window.__lidraQuality;
  window.__lidraQuality = (payload) => {
    window.__lidraQualityLast = payload;
    original(payload);
  };
})();
