# Countdown Studio — Letters, Numbers & Conundrum

A complete, offline-capable web recreation of the classic TV game show **Countdown**, built with **vanilla HTML5, CSS3, and ES2022+ JavaScript modules** with zero external client runtime dependencies, plus a lightweight **Node.js / TypeScript WebSocket backend** (`server.ts`) for multi-device live stage synchronization.

---

## 1. Quick Start & Running Locally

Countdown Studio offers two running modes: **Full-Stack Mode** (recommended, enables cross-device WebSocket remote stage rooms) and **Static Zero-Build Mode** (uses native browser ES modules, suitable for single-device or offline practice).

### Option A: Full-Stack Mode (Recommended)

Requires Node.js 18+. Runs the Express + WebSocket server (`server.ts`) integrated with Vite for fast local development and remote room synchronization.

```bash
# 1. Install dependencies
npm install

# 2. Start the development server (runs tsx server.ts at http://localhost:3000)
npm run dev

# 3. (Optional) Run TypeScript type checks or build production bundles
npm run lint         # tsc --noEmit
npm run build        # vite build (outputs to dist/)
npm run build:server # compile server.ts to dist-server/
npm run build:all    # run both build and build:server
npm run preview      # vite preview
npm run clean        # rm -rf dist dist-server
```

### Option B: Static Mode (No Build Step Required)

Because Countdown Studio uses native browser ES modules (`<script type="module">`), CSS custom properties, and static assets, you can also serve the root directory over any static HTTP server. Local stage sync works seamlessly across tabs or windows on the same machine via `BroadcastChannel` and `localStorage` without any backend.

```bash
# Python 3 built-in HTTP server
python3 -m http.server 8000

# or Node.js npx serve
npx serve . -l 8000
```

### Application URLs

Once running, navigate to:
- **Studio Hub & Mode Picker:** `http://localhost:3000/index.html`
- **Solo Practice Mode:** `http://localhost:3000/solo.html`
- **Live Versus Host Console:** `http://localhost:3000/versus-host.html`
- **16:9 Stage Display:** `http://localhost:3000/versus-display.html`
- **Unit Test Suite:** `http://localhost:3000/tests/index.html`
- **Server Health Endpoint:** `http://localhost:3000/api/health`
- **Room Inspection Endpoint:** `http://localhost:3000/api/room/:roomId`
- **Versus History API:** `GET /api/versus/history` and `GET /api/versus/history/:archiveId`

### Authentication & roles

The backend exposes `/api/auth/register`, `/api/auth/login`, and `/api/auth/me`. Run `database/auth-rbac.sql` to add the application roles and permissions. Public registration accepts `individual`
(Solo Practice) and `admin` (requires `ADMIN_REGISTRATION_CODE`); `organization` accounts are provisioned by an administrator and can use Stage Display and Host Operations. Admin accounts can use all three features.

Copy `.env.example` to `.env` and set the Supabase PostgreSQL `DATABASE_URL`
and a long random `AUTH_TOKEN_SECRET` before starting
the server. The frontend stores the signed session token locally and sends it
to the REST and WebSocket APIs.

For Google Sign-In, also set `GOOGLE_CLIENT_ID` in the backend environment. On
Render, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in the service's
Environment settings; `render.yaml` declares both as secret values. Add the
production frontend origin (for example `https://countdown-studio.id.vn`) to
the OAuth client's Authorized JavaScript origins in Google Cloud Console.

---

## 2. Modes & Feature Highlights

### 🎮 Game Rounds
- **Letters Round:** Contestants pick 9 tiles from separate Vowel (67 tiles) and Consonant (74 tiles) stacks following official TV frequency distributions and constraints (minimum 3 vowels, minimum 4 consonants). Players form the longest valid word within 30 seconds.
- **Numbers Round:** Contestants choose a combination of Large numbers (`25, 50, 75, 100`) and Small numbers (`1–10` twice). A 3-digit target between `101` and `999` is randomly generated. Players use basic arithmetic operations (`+`, `−`, `×`, `÷`) where intermediate results must be positive integers.
- **Countdown Conundrum:** Contestants are shown two or three source words totalling nine letters and buzz in to form the single nine-letter answer using every letter.

### 🧑‍💻 Solo Practice Mode (`solo.html`)
- Interactive word-building tray supporting keyboard typing (`A–Z`), Backspace, and tile clicks.
- Built-in scratchpad and interactive arithmetic expression validator for the Numbers round.
- Post-round breakdown featuring Trie-based word solver hints and closest numbers calculations.
- Comprehensive Individual-account session statistics: win rates, average word lengths, target accuracy, and streak tracking saved in PostgreSQL.
- Dictionary definition lookups powered by the Free Dictionary API with local caching.

### 🎙️ Live Versus Host Console (`versus-host.html`)
- Dual-contestant scoring and round management.
- Real-time 30-second studio clock with Start, Pause, Resume, and Reset controls.
- Declaration and score adjudication: enter words or numeric solutions, view automatic point calculations, and make manual score adjustments.
- Built-in solver assistance to instantly see the maximum possible word lengths and exact arithmetic solutions.
- Match schedule selector supporting standard presets or the visual **Custom Schedule Editor** (1 to 25 rounds).
- Alternating tile picker tracking (automatically indicates whether Contestant 1 or 2 chooses the tiles).
- Remote Room management: create password-protected rooms, monitor connected display count, display QR codes and direct links, or terminate rooms via the **Close Room** panel.

### 📺 16:9 Stage Display (`versus-display.html`)
- Designed for projection on secondary monitors, TVs, and auditorium displays.
- Responsive 16:9 presentation container with full-bleed fullscreen mode (`F`).
- **Interactive Audio Splash (`🔊`):** Overcomes modern browser autoplay restrictions on secondary screens; click once to unlock Web Audio API output through TV/projector speakers.
- **Projector Calibration Grid (`B` / `L`):** Toggle an on-screen alignment pattern and safe-zone margin guides to adjust projector zoom and keystone.
- **Panic Blank Screen:** One-click blackout for the stage display during breaks or confidential setup, dismissed via screen button or `Escape`.
- **Single-Screen Host Drawer (`H`):** Toggle an embedded Host Control drawer directly on top of the stage view when running on a single screen without a secondary monitor.

---

## 3. Real-Time Synchronization Architecture

Countdown Studio provides two complementary synchronization transports:

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Local Transport (Zero-Backend)                  │
│                                                                        │
│   Host Console  ◄── BroadcastChannel API / localStorage ──►   Stage    │
│  (versus-host)  ◄── window.postMessage (iframes/opener) ──►  Display   │
└────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────┐
│                       Remote Transport (WebSocket /ws)                 │
│                                                                        │
│   Host Console  ──── ws.send('host:broadcast') ────►   Node Server     │
│  (versus-host)                                        (server.ts)      │
│                                                            │           │
│   Stage Display ◄─── ws.send('stage:sync') ────────────────┘           │
│ (versus-display)                                                       │
└────────────────────────────────────────────────────────────────────────┘
```

### Local Transport (Same Device / Dual-Screen)
- Communicates across windows, tabs, or popouts using the `BroadcastChannel` API (`countdown_studio_stage_sync_v1`), direct `window.postMessage`, and `localStorage` storage event fallbacks.
- Requires zero backend servers; runs fully client-side on static hosts (e.g., GitHub Pages).
- State is persisted across browser refreshes. Open `versus-display.html` without a `?room=` parameter to use local sync.

### Remote Transport (Cross-Device via WebSocket)
- Connects host laptops and remote display devices (smart TVs, iPads, secondary computers) over WebSockets at `/ws`.
- **Room Authentication:** Host specifies a Room Code (3–32 alphanumeric characters) and a 4-digit PIN. Displays join read-only without requiring a password.
- **Direct Joining & QR Codes:** Host Console generates a direct link (`versus-display.html?room=ROOMCODE`) and dynamic QR code for quick scanning.
- **Decoupled Backend Support (`?ws=` parameter):** If the frontend is hosted statically (e.g., GitHub Pages) while the WebSocket backend is hosted separately (e.g., Cloud Run or a VPS), pass the backend endpoint via `?ws=`:
  ```text
  https://your-static-site.example/versus-host.html?ws=wss%3A%2F%2Fyour-ws-server.example%2Fws
  ```
  Generated Display links and QR codes carry the `ws` parameter automatically.
- **Runtime Backend Configuration:** A static deployment may set `window.__COUNTDOWN_STAGE_WS_URL__` before loading the application modules. The value should be the complete `wss://.../ws` endpoint. This avoids hard-coding a provider-specific URL in the source bundle.
- **Production Full-Stack Deployment:** `Dockerfile` and `render.yaml` are included for deploying the Node server that serves both the pages and `/ws` from one origin. Point the production domain at that service; GitHub Pages alone cannot provide a WebSocket server.
- **Configurable Display Limits:** The server limits displays per room via the `MAX_DISPLAYS_PER_ROOM` environment variable (default: `20`).
- **Lifecycle & Cleanup:** 
  - Host can explicitly terminate the room via the **Close Room** panel, which notifies and disconnects all displays.
  - Orphaned rooms (host disconnected for > 30 seconds) and idle rooms (> 12 hours) are automatically reaped.
  - Second host connection attempts with the same room ID while an active host is connected are safely rejected (`ROOM_OCCUPIED`).

---

## 4. Keyboard Shortcut Map

| Key | Context | Action |
| :--- | :--- | :--- |
| **`C`** | Letters Picking (Solo & Host) | Pick a **Consonant** tile |
| **`V`** | Letters Picking (Solo & Host) | Pick a **Vowel** tile |
| **`R`** | Letters Picking (Solo & Host) | Fill remaining slots with a valid **Random** mix |
| **`SPACE`** | Host Console | **Start / Pause / Resume** the 30-second studio clock |
| **`D`** | Host Console | Focus Contestant 1 **Declaration** input field |
| **`N`** | Host Console | Advance to the **Next Round** |
| **`Q` / `Left Shift`** | Conundrum (Host & Display) | **Contestant 1 Buzzer** (also supports Gamepad 1 button 0) |
| **`P` / `Right Shift`** | Conundrum (Host & Display) | **Contestant 2 Buzzer** (also supports Gamepad 2 button 0) |
| **`H`** | Stage Display | Toggle single-window **Host Control Overlay** drawer |
| **`F`** | Stage Display | Toggle **Fullscreen** 16:9 stage projection |
| **`B` / `L`** | Stage Display | Toggle **Projector Calibration Grid** & alignment toolbar |
| **`C`** | Stage Display | Toggle stage controls & toolbar visibility |
| **`Escape`** | Stage Display | Dismiss **Panic Blank Screen** |
| **`A–Z`** | Solo Letters Round | Type letters into the word tray |
| **`Backspace`** | Solo Letters Round | Remove the last letter tile from word tray |
| **`Enter`** | Solo Letters Round | Submit word answer |
| **`Enter`** | Solo Conundrum Round | Submit conundrum guess |
| **`Enter`** | Solo Reveal Phase | Advance to next round |

---

## 5. Match Formats & Custom Schedule

Countdown Studio supports official and custom round configurations:

- **TV Format (15 Rounds):** Standard Channel 4 broadcast structure:
  `L - L - N - L - L - N - L - L - N - L - L - N - L - L - C` (11 Letters, 3 Numbers, 1 Conundrum).
- **Quick Match (5 Rounds):** `L - N - L - N - C`.
- **Letters Only (6 Rounds):** `L - L - L - L - L - L`.
- **Numbers Only (6 Rounds):** `N - N - N - N - N - N`.
- **Conundrum Sprint (5 Rounds):** `C - C - C - C - C`.
- **Custom Schedule Editor:** An interactive visual builder in the Host Console allowing event organizers to configure between 1 and 25 rounds in any custom sequence, complete with drag-and-drop or click-to-reorder, add, and remove controls.
- **Alternating Pickers:** In multi-round matches, the system tracks and visually indicates which contestant has the honor of picking tiles for each Letters and Numbers round.

---

## 6. Audio Engine & Sound Design

Countdown Studio features a 100% synthesized audio engine built on the browser **Web Audio API** (`js/core/audio.js`), requiring zero external audio assets:

- **Studio Clock Tick:** Analog-modeled woodblock/rimshot tick on every elapsed second.
- **30-Second Think Music:** Original melodic chime composition that builds suspense toward zero; dynamically pauses and resumes with clock state, and automatically halts on round submission via `stopClockMusic()`.
- **Warning Chime:** Distinctive 10-second warning bell alerting contestants of impending time.
- **Time's Up Buzzer:** Dual-tone studio finish buzzer.
- **Conundrum Buzzer:** Low-latency buzz sound for contestant buzzer lockouts.
- **Victory Fanfare:** Harmonized arpeggiated fanfare for match conclusions.

---

## 7. Built-in Solvers & Lexicon

- **Letters Word Solver (`js/solver/wordSolver.js`):** High-performance Trie implementation loaded with the bundled 106,899-word lexicon (`data/words.txt`). Finds all possible anagram words of lengths 2 through 9 in under 15ms.
- **Numbers Solver (`js/solver/numbersSolver.js`):** Exhaustive recursive arithmetic solver that finds exact solutions or the closest reachable approximations using standard arithmetic rules (no negative numbers, no fractions).
- **Conundrum Engine (`js/game/conundrum.js`):** Builds a two/three-word nine-letter source phrase from the dictionary and pairs it with a curated single-answer conundrum (`data/conundrums.json`).
- **Dictionary Corner (`js/net/dictionaryApi.js`):** Queries definitions, parts of speech, and etymology from the public Free Dictionary API with a 10-second timeout, falling back gracefully to offline word validity checks when disconnected.

---

## 8. Deployment Options

### Deploying to GitHub Pages (Static Hosting)

1. Push this repository to GitHub.
2. In your repository, go to **Settings → Pages**.
3. Under **Build and deployment**, select **Deploy from a branch**, choose `main` (or `master`) and `/ (root)` or `/dist`, and click **Save**.
4. Custom domain support for the static frontend is preconfigured via the included [`CNAME`](file:///d:/drive-download-20240827T165320Z-001/GSA-project/countdown-studio-app/CNAME) file (`www.countdown-studio.id.vn`).
5. All assets, modules, and stylesheets use relative paths, ensuring compatibility both at the root domain and under repository subpaths.
6. The Service Worker (`sw.js`) caches the core application shell, styles, scripts, and lexicon for offline use and PWA installation.

GitHub Pages supports the local same-device Stage Display flow, but it cannot
serve the `/ws` WebSocket endpoint. For cross-device rooms, deploy the
full-stack service below and point the production domain to that service (or
keep Pages as the frontend and provide a separate `?ws=wss://.../ws` backend).

GitHub Pages is also a static host: it cannot vary the homepage body or
`Content-Type` based on `Accept`. The agent-readiness Markdown negotiation and
Markdown 404 requirements therefore require the public domain to point at the
Node/Docker/Render service (the Express routes in `server.ts`), not only at
the Pages artifact. After changing DNS, verify the public origin with
`npm run test:agent` and `SERVER_URL=https://your-domain.example npm run test:agent`.

When the authentication API is hosted separately from the static frontend,
provide its origin with `?api=https://api.example.com` (or set
`VITE_API_URL=https://api.example.com` at build time, or set
`window.__COUNTDOWN_API_URL__` before the application modules load). For
example, open `https://www.example.com/login.html?api=https%3A%2F%2Fapi.example.com`.
The same-origin default is used automatically by the full-stack deployment.

### Deploying to Node.js / Docker / Cloud Run

To support cross-device remote WebSocket rooms without an external WebSocket service:

```bash
# 1. Build the frontend bundles and server output
npm run build:all

# 2. Start the production server
NODE_ENV=production npm start
```

The included `Dockerfile` can be used by Docker/Cloud Run, and `render.yaml`
can be used to create a Render web service. The service must be reachable over
HTTPS/WSS from the browser and must expose `/ws` on the same public service
origin when the frontend uses the default endpoint.

#### Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | HTTP/WebSocket listening port | `3000` |
| `MAX_DISPLAYS_PER_ROOM` | Maximum connected stage displays allowed per live room | `20` |
| `CORS_ORIGINS` | Additional comma-separated browser origins allowed for HTTP/WebSocket access | Built-in localhost and `countdown-studio.id.vn` origins |
| `APP_URL` | Public canonical URL for QR codes and self-referential links | `http://localhost:3000` |
| `GEMINI_API_KEY` | Optional API key for Google Gemini AI features | — |

---

## 9. Codebase Architecture

```
countdown-studio-app/
├── index.html                  # Studio Hub & Mode Picker
├── solo.html                   # Solo Practice interface
├── versus-host.html            # Live Versus Host Operator Console
├── versus-display.html         # 16:9 Stage Presentation Display
├── server.ts                   # Express & WebSocket server (Node.js/TypeScript)
├── vite.config.ts              # Vite multi-page build configuration
├── package.json                # Dependencies and npm scripts
├── tsconfig.json               # TypeScript compiler configuration (client)
├── tsconfig.server.json        # TypeScript compiler configuration (server)
├── sw.js                       # Service Worker for offline PWA caching
├── manifest.webmanifest        # Progressive Web App manifest
├── CNAME                       # Custom domain definition
├── Dockerfile                  # Container build specification
├── render.yaml                 # Render cloud deployment blueprint
├── .env.example                # Sample environment configuration
│
├── css/                        # Modular Vanilla CSS System
│   ├── theme.css               # Design tokens, color palettes, and themes
│   ├── base.css                # CSS resets, typography, and container layout
│   ├── components.css          # Buttons, forms, panels, badges, modal dialogs
│   ├── display.css             # 16:9 stage layout, tiles, clock, and calibration
│   └── animations.css          # Clock hand animations, tile flips, and transitions
│
├── js/                         # ES2022+ Application Logic
│   ├── app-home.js             # Studio Hub logic and settings modal
│   ├── app-solo.js             # Solo Practice state machine and UI controller
│   ├── app-host.js             # Host Console match orchestration and controls
│   ├── app-display.js          # Stage Display receiver, calibration, and audio splash
│   ├── i18n.js                 # English and Vietnamese UI localisation
│   │
│   ├── core/                   # Platform & Infrastructure
│   │   ├── audio.js            # Web Audio API sound synthesizer
│   │   ├── clock.js            # Precise 30-second countdown timer
│   │   ├── events.js           # Lightweight Pub/Sub event bus
│   │   ├── rng.js              # Seeded pseudo-random number generator
│   │   ├── state.js            # Finite state machine and match store
│   │   └── storage.js          # LocalStorage persistence layer
│   │
│   ├── game/                   # Rules, Mechanics & Scoring
│   │   ├── letters.js          # Vowel/consonant distribution & validation
│   │   ├── numbers.js          # Numbers draw mechanics and arithmetic checks
│   │   ├── conundrum.js        # Anagram scrambling and buzzer adjudication
│   │   ├── schedule.js         # Match presets and custom schedule resolver
│   │   └── scoring.js          # Official Countdown scoring algorithms
│   │
│   ├── net/                    # Networking & Synchronization
│   │   ├── sync.js             # Dual-transport sync (BroadcastChannel & WebSocket)
│   │   └── dictionaryApi.js    # External dictionary definition fetcher
│   │
│   ├── solver/                 # Algorithmic Solvers
│   │   ├── trie.js             # Prefix tree data structure
│   │   ├── wordSolver.js       # High-speed Trie word searcher
│   │   └── numbersSolver.js    # Exhaustive recursive arithmetic solver
│   │
│   └── ui/                     # UI Helpers & Components
│       ├── a11y.js             # Screen reader announcements and focus management
│       ├── board.js            # Board rendering helpers
│       ├── modal.js            # Accessible modal dialog controllers
│       ├── scoreboard.js       # Scoreboard DOM updater
│       ├── tiles.js            # Flip tile animation and rendering
│       └── toast.js            # Non-blocking notification toasts
│
├── data/                       # Dictionaries and Game Assets
│   ├── words.txt               # Offline lexicon (106,899 words, 2–9 letters)
│   ├── conundrums.json         # Curated 9-letter anagram database
│   ├── letterDistribution.json # Official tile weights and frequencies
│   └── LICENSE-words.txt       # Lexicon public-domain licence details
│
└── tests/
    └── index.html              # Zero-dependency browser-based unit test suite
```

---

## 10. Testing & Quality Assurance

Countdown Studio includes an authoritative, self-contained unit test suite at `tests/index.html`. It tests game logic, FSM transitions, constraint enforcement, and algorithmic solvers without requiring external testing libraries.

### Verified Test Categories
- **Letter Stacks & Constraints:** Validates tile frequencies (67 vowels, 74 consonants), minimum 3 vowels / 4 consonants selection constraints, and random pick distribution.
- **Word Validation & Multiset Checks:** Ensures word submissions only use available board tiles and match the dictionary.
- **Numbers Generation & Arithmetic Sequences:** Validates large/small tile drawing rules and order of operations.
- **Conundrum Scrambling & Buzzer Adjudication:** Verifies anagram validity and timestamp-based buzzer prioritization.
- **Scoring Rules:** Tests standard rules, 9-letter word double bonuses (18 points), and proximity scoring for numbers.
- **Algorithmic Solvers:** Benchmarks Trie lookup and recursive numbers solver accuracy against edge cases.

To run the unit tests, open `http://localhost:3000/tests/index.html` in any browser.

---

## 11. Internationalisation (i18n)

The interface supports bilingual operation out of the box via `js/i18n.js`:
- **English (`en`):** Default studio interface.
- **Vietnamese (`vi`):** Complete UI translations for menus, round titles, button labels, and system status notices.

Language preferences are persisted in `localStorage` and can be toggled via the Settings modal.

---

## Persistent Versus rooms and match archive

Run `database/versus-room-history.sql` after the authentication schema to enable persistent
rooms and archived match snapshots. Active rooms survive a server restart with their latest state,
stage configuration, and hashed Host PIN. Closing a room, an orphan timeout, or an idle timeout
archives the final state exactly once in `versus_match_archive`.

Organization users can list and inspect their own archived matches; admins can inspect all archived
matches. The Host Console exposes the same history through its Archived Match History panel.

For controlled production/staging test users, set `TEST_INDIVIDUAL_PASSWORD`,
`TEST_ORGANIZATION_PASSWORD`, and `TEST_ADMIN_PASSWORD` as deployment secrets, then run:

```bash
npm run seed:test-accounts
```

The script is idempotent, updates password hashes, and never stores plaintext passwords in the
repository. Test usernames are `test-individual`, `test-organization`, and `test-admin`.

## 12. Licence & Attribution

- **Educational Fan Project Disclaimer:** Countdown Studio is an independent, open-source educational project developed for classrooms, language clubs, math enthusiasts, and quiz organizers. It is **not** affiliated with, endorsed by, or connected to Channel 4 Television Corporation, ITV Studios, or the creators of *Countdown*. No copyrighted broadcast logos, trademarks, or recorded audio assets are used; all visual designs and Web Audio API compositions are original creations.
- **Word List Licence:** `data/words.txt` and `data/conundrums.json` are derived from the public-domain ENABLE lexicon (CC0 / Public Domain). See [`data/LICENSE-words.txt`](file:///d:/drive-download-20240827T165320Z-001/GSA-project/countdown-studio-app/data/LICENSE-words.txt) for details.
