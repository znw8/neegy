// ---- Neegy Clicker: Discord webhook tracker ----
// Your Render server URL (you'll get it after deploying), ending in /track
const ENDPOINT = "https://YOUR-APP-NAME.onrender.com/track";

// Edit this to match your game's variables.
// Add a line for anything else you want in the message.
function getStats() {
  try {
    const fmt = (x) => Math.floor(x).toLocaleString("en-US");
    return {
      "neegies now": fmt(S.n),
      "total earned": fmt(S.all),
      clicks: fmt(S.k),
      "golden neegies clicked": S.gc,
      buildings: S.b.reduce((a, b) => a + b, 0),
      skin: SK[S.sel][0],
      rebirths: S.reb || 0,
      "golden statues": S.chips,
    };
  } catch (e) {
    return {};
  }
}

// ---- you shouldn't need to touch anything below ----
let activeMs = 0;
let lastTick = document.visibilityState === "visible" ? Date.now() : null;

function formatTime(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m ${s % 60}s` : `${s}s`;
}

function send(content) {
  if (ENDPOINT.includes("YOUR-APP-NAME")) return;
  try {
    fetch(ENDPOINT, {
      method: "POST",
      // text/plain avoids a CORS preflight, which can fail while a tab is closing
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({ content }),
      keepalive: true, // lets the request finish while the page closes
    }).catch(() => {});
  } catch (e) {}
}

function statLines() {
  return Object.entries(getStats())
    .map(([k, v]) => `> ${k}: ${v}`)
    .join("\n");
}

// Arrival message
let isNew = false;
try {
  isNew = !localStorage.getItem("neegy_seen");
  localStorage.setItem("neegy_seen", "1");
} catch (e) {}

const device = /Mobi|Android|iPhone/i.test(navigator.userAgent) ? "Mobile" : "Desktop";
send(
  `-_-_-_-_-${isNew ? "New Player" : "Returning Player"} ! -_-_-_-_-\n` +
    `> device: ${device}\n${statLines()}`
);

// Leave message (fires when they close the tab or switch away)
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") {
    if (lastTick) activeMs += Date.now() - lastTick;
    lastTick = null;
    if (activeMs > 3000) {
      send(
        `-_-_-_-_-Player Left ! -_-_-_-_-\n` +
          `> playtime: ${formatTime(activeMs)}\n${statLines()}`
      );
    }
  } else {
    lastTick = Date.now();
  }
});
