# Countdown Studio — Letters, Numbers & Conundrum

A complete, offline-capable web recreation of the British TV game show **Countdown**, built with **vanilla HTML5, CSS3, and ES2022+ JavaScript modules** with zero external runtime dependencies.

---

## 1. Running Locally (No Build Step Required)

Because Countdown Studio uses native browser ES modules (`<script type="module">`), CSS custom properties, and static JSON/text datasets, no bundler or build step is required. Serve the root folder over any static HTTP server:

```bash
# Option A: Python 3 built-in HTTP server
python3 -m http.server 8000

# Option B: Node.js npx serve
npx serve . -l 8000
```

Then open:
- **Home & Mode Picker:** `http://localhost:8000/index.html`
- **Solo Practice Mode:** `http://localhost:8000/solo.html`
- **Live Versus Host Console:** `http://localhost:8000/versus-host.html`
- **16:9 Stage Display:** `http://localhost:8000/versus-display.html`
- **Unit Test Suite:** `http://localhost:8000/tests/index.html`

---

## 2. Deploying to GitHub Pages

1. Push this repository to GitHub.
2. Go to **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**, choose `main` (or `master`) and `/ (root)`, and click **Save**.
4. All asset and module paths use relative URLs (`./js/...`, `./css/...`, `./data/...`), so the app works both at a root domain and under a project subpath (e.g. `https://<username>.github.io/countdown/`). This includes the **Versus Host** display link and QR-room link.
5. On first visit, the Service Worker (`sw.js`) caches the application shell and the 106,800-word offline lexicon for full offline play and PWA installation.

---

## 3. Running Live Versus (Stage Mode) with a Projector or TV

1. Open `/versus-host.html` on the operator's laptop.
2. Click **Open 16:9 Stage Display ↗** in the top navigation bar (or **Pop Out Stage Window ↗** above the live monitor).
3. Drag the newly opened `/versus-display.html` window onto your extended projector or TV screen and press **`F`** to enter full-bleed 16:9 Fullscreen.
4. Click anywhere once on the Stage Display if you want audio to play from the projector's speakers, or keep audio enabled on the Host laptop.
5. The Host Console and Stage Display synchronise in real time via the `BroadcastChannel` API (with automatic `localStorage` event fallback) and persist match state across page refreshes.
6. **Single-Screen Setup:** If you only have one screen, open `/versus-display.html` and press **`H`** to toggle the embedded Host Control Overlay drawer directly on top of the stage!

For Host and Display opened in tabs/windows of the same browser/device, the local stage sync works without a backend. Open `versus-display.html` without a `?room=` parameter for this mode. The Display no longer re-joins a stale room saved in the browser automatically.

The optional **Remote Room** feature (Host and Display on separate devices) requires a WebSocket backend. Static hosts such as GitHub Pages cannot provide the `/ws` WebSocket endpoint. Deploy the included Node server with `npm run build`, then `NODE_ENV=production npm start`, and serve the Host and Display from that same server.

If the frontend and backend are hosted separately, start the Host page with the backend endpoint in the URL, for example:

```text
https://your-static-site.example/versus-host.html?ws=wss%3A%2F%2Fyour-websocket-server.example%2Fws
```

The generated Display link and QR code carry this `ws` setting automatically. Use `wss://` when the website is served over HTTPS; otherwise browsers will block the connection as mixed content.

---

## 4. Keyboard Shortcut Map

| Key | Context | Action |
| :--- | :--- | :--- |
| **`C`** | Letters Picking (Solo & Host) | Pick a **Consonant** tile |
| **`V`** | Letters Picking (Solo & Host) | Pick a **Vowel** tile |
| **`R`** | Letters Picking (Solo & Host) | Fill remaining tiles with a valid **Random** mix |
| **`SPACE`** | Host Console | **Start / Pause / Resume** the 30-second studio clock |
| **`D`** | Host Console | Focus Contestant 1 **Declaration** input field |
| **`N`** | Host Console | Advance to the **Next Round** |
| **`Q` / `Left Shift`** | Conundrum (Host & Display) | **Contestant 1 Buzzer** (also supports Gamepad 1) |
| **`P` / `Right Shift`** | Conundrum (Host & Display) | **Contestant 2 Buzzer** (also supports Gamepad 2) |
| **`H`** | Stage Display | Toggle single-window **Host Control Overlay** |
| **`F`** | Stage Display | Toggle **Fullscreen** stage projection |
| **`A–Z` / `Backspace` / `Enter`** | Solo Letters Round | Type letters into the word tray, delete, or submit |

---

## 5. Swapping or Customising the Dictionary

- The primary offline word list lives at `/data/words.txt` (one lowercase word per line, `a–z` only, 2 to 9 letters).
- To replace the dictionary (for example, with an official club lexicon or another language's word list), overwrite `/data/words.txt` with your newline-separated word list and bump `CACHE_NAME` in `/sw.js`.
- Curated 9-letter Conundrum words live in `/data/conundrums.json` as a JSON array of 9-letter uppercase strings.
- Tile frequency weights live in `/js/game/letters.js` (`LETTER_DISTRIBUTION`) and `/data/letterDistribution.json`.

---

## 6. Known Limitations & Next Steps

- **Inflected Forms & Proper Nouns:** The offline lexicon (`/data/words.txt`) is derived from the public-domain ENABLE1 word list (106,899 words of length 2–9). While comprehensive, minor differences exist between North American scrabble/ENABLE word lists and the Oxford Dictionary of English used on TV; a "Strict UK Approximation" mode is available in Settings.
- **Online Definitions:** Word definitions in Dictionary Corner are fetched from the public Free Dictionary API (`api.dictionaryapi.dev`) with a 4-second timeout and cached locally. When offline, words are validated using the bundled offline lexicon without definition prose.
- **Next Steps:** Future enhancements include WebRTC peer-to-peer remote multiplayer across separate devices and full Vietnamese (`vi`) dictionary pack support via `/js/i18n.js`.

---

## 7. Licence & Attribution

- **Educational Fan Project Disclaimer:** Countdown Studio is an independent, fan-made educational project built for students, language/maths clubs, teachers, and quiz organisers. It is **not** affiliated with, endorsed by, or connected to Channel 4 Television Corporation, ITV Studios, or the producers of *Countdown*. No official logos, trademarks, or copyrighted broadcast audio are used; all visual assets and Web Audio API "think music" compositions are 100% original creations.
- **Word List Licence:** `/data/words.txt` and `/data/conundrums.json` are derived from the public-domain ENABLE lexicon (CC0 / Public Domain). See `/data/LICENSE-words.txt`.
