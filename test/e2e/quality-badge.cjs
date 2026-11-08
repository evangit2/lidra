/**
 * Quality badge rendering check.
 *
 * Loads the real music.apple.com page, injects assets/qualityBadge.js exactly as
 * the app does, feeds it a measured payload and captures the window. The pill
 * mounts in Apple's LCD beside the PREVIEW badge, so a track must be loaded
 * first; the check asserts it landed in that slot, stays inside the viewport
 * and does not change the document's layout metrics.
 *
 * Run with:  xvfb-run -a npx electron --no-sandbox test/e2e/quality-badge.cjs
 */
const { app, BrowserWindow, session } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const root = path.dirname(path.dirname(__dirname));
const shot = "/tmp/lidra-badge.png";

app.setName("Lidra");
app.setPath("userData", path.join(os.homedir(), ".config", "Lidra"));

app.whenReady().then(async () => {
  const ses = session.fromPartition("persist:lidra");
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { session: ses },
  });
  await win.loadURL("https://music.apple.com/us/album/kind-of-blue/268443092");
  await new Promise((resolve) => setTimeout(resolve, 4000));
  // Load a preview so the LCD has its after-metadata slot, then pause it.
  await win.webContents.executeJavaScript(`(async () => {
    document.querySelector('button[aria-label^="Play So What"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    try { MusicKit.getInstance().pause(); } catch (_) {}
  })()`);

  const script = fs.readFileSync(path.join(root, "assets", "qualityBadge.js"), "utf-8");
  await win.webContents.executeJavaScript(script);

  const before = await win.webContents.executeJavaScript(
    "({ h: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth })",
  );
  await win.webContents.executeJavaScript(
    `window.__lidraQuality(${JSON.stringify({
      label: "ALAC 24-bit/192 kHz stereo",
      verdict: "ok",
      requested: "hi-res",
      tier: "hi-res",
      detail: "ALAC 24-bit/192 kHz stereo",
    })})`,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));

  const after = await win.webContents.executeJavaScript(`(() => {
    const node = document.getElementById("lidra-quality-badge");
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return {
      text: node.textContent.trim(),
      inLcd: !!node.closest('[data-testid="player-lcd-after-metadata"]'),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.width), h: Math.round(rect.height),
      opacity: style.opacity,
      pointerEvents: style.pointerEvents,
      visible: node.getAttribute("data-visible"),
      scrollH: document.documentElement.scrollHeight,
      scrollW: document.documentElement.scrollWidth,
      inViewport: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      // Does the pill sit on top of anything interactive?
      overInteractive: (() => {
        const el = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return { tag: el ? el.tagName : "none", id: el ? el.id : "", isBadge: !!(el && node.contains(el)) };
      })(),
    };
  })()`);

  // Amber mismatch variant, to prove the second state renders too.
  await win.webContents.executeJavaScript(
    `window.__lidraQuality(${JSON.stringify({
      label: "ALAC 16-bit/44.1 kHz stereo",
      verdict: "mismatch",
      requested: "hi-res",
    })})`,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  const mismatch = await win.webContents.executeJavaScript(
    `(() => {
      const node = document.getElementById("lidra-quality-badge");
      return { text: node.textContent.trim(), verdict: node.getAttribute("data-verdict") };
    })()`,
  );

  const image = await win.capturePage();
  fs.writeFileSync(shot, image.toPNG());

  console.log(
    "RESULT " +
      JSON.stringify({
        before,
        after,
        layoutStable: before.h === after.scrollH && before.w === after.scrollW,
        mismatch,
        screenshot: shot,
      }),
  );
  app.exit(0);
}).catch((error) => {
  console.log("ERROR " + (error && error.stack ? error.stack : String(error)));
  app.exit(1);
});
