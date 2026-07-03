# Burrows and Badgers

A lightweight, single-page **virtual tabletop** for D&D and other tabletop RPGs.
Static web app, **no backend** — the DM and players sync peer-to-peer over
WebRTC (PeerJS). Deploys to GitHub Pages in minutes.

*Internally codenamed **The Plague's Call** (storage keys & comments use
`plagues-call.*`); originally Shadowquill.*

> **Developing it?** See **[CONTRACT.md](CONTRACT.md)** for the architecture,
> the DM↔player data contract, the action catalog, and the `TUNING` knobs.

---

## Features

**Table & maps**
- Dual-mode interface: an authoritative **DM** view and a restricted **Player** view.
- Battle maps with grid, pan/zoom, per-map viewport memory, and breadcrumb navigation.
- Day↔night scalar with darkvision, light radius, and flickering flame sources.
- Shared freehand **drawings**, **hazard** zones, and movement **block zones**.

**Cast & combat**
- Full D&D 5e entities (PC / NPC / Monster / Familiar / Object / Label) with stat
  blocks, ability scores, conditions, money, inventory, and a tabbed character sheet.
- **Bestiary carousel** with search and faceted filters (World / Kind / Type /
  Habitat) across a large built-in roster — D&D, Plague's Call, and the full
  Burrows & Badgers compendium — plus homebrew inventory items.
- Standard token art: drop image files in `assets/tokens/` to auto-skin presets.
- Initiative tracker (auto-roll, hidden combatants), short/long rest, status
  conditions, token groups, and saveable encounter presets.

**Players**
- Claim an available PC — or **build a new one**: ability scores auto-rolled
  (4d6, drop lowest), level 1, and class-based starting HP.
- Self-service sheet (HP, conditions, whitelisted fields), a party sidebar, and a
  revealed-monsters panel that shows narrative HP labels, never exact numbers.
- Private per-viewer **reminder pins** (adjustable size + colour).

**Communication**
- Collapsible **chat**, synced to the table. Players speak as their character; the
  DM can speak as any token or custom name and **/whisper** a single player.
- Shared **dice roller** and a **soundboard** (DM uploads audio to play for all).

**DM controls & polish**
- Reveal/hide tokens, push players to a map, set each player's UI **theme**, and
  obfuscate monster HP.
- 8 UI themes, full-session JSON export/import, IndexedDB persistence,
  mobile-friendly layout, dark-fantasy aesthetic.

---

## Deploy to GitHub Pages

1. Build the bundle (only after editing `app.js`):
   ```sh
   ./build.sh        # regenerates app.compiled.js
   ```
2. Put these in the repo root: **`index.html`**, **`app.compiled.js`**, the
   **`assets/`** folder, and **`.nojekyll`** (rename the included `nojekyll.txt`).
   `app.js`, `build.sh`, and the docs are source/dev-only.
3. **Settings → Pages → Deploy from a branch → `main` / root.**

No server, no bundler. `.nojekyll` stops GitHub from hiding the `assets/` folder.

---

## Usage

**DM:** open the site → **Dungeon Master** tab → enter the passphrase → optional
room code → **Open the Session** → share the room code.

**Player:** same URL → **Player** tab → your name + the room code → join.

**Solo / prep:** **Local-only mode (no sync)** runs the app without peers.

During play the DM builds maps, creates and places entities, and reveals them;
players see only revealed tokens plus their own character.

---

## Configuration

- **DM passphrase** — edit the `DM_PASSWORD` constant near the top of `app.js`,
  then rebuild and redeploy. It's a client-side gate, **not real security** (the
  source is public); fine for a trusted group, not for public hosting.
- **PeerJS broker** — defaults to the free public cloud broker. To self-host,
  adjust the `new Peer(...)` / `ICE_SERVERS` config in `app.js`
  (see [peerjs-server](https://github.com/peers/peerjs-server)).
- **Behavioural knobs** — timings and limits live in the `TUNING` object at the
  top of `app.js` (see CONTRACT.md).

---

## How sync works

The DM's browser is authoritative. Players connect over WebRTC and send **action
requests** (move my PC, claim, chat, …); the DM validates each against the
sender's identity, applies it, and broadcasts a **per-player filtered** state
back — each player only receives what they're allowed to see. Room codes map to
peer IDs via the `plagues-call-` prefix. Full protocol in CONTRACT.md.

**Limitations:** if the DM closes the tab, players must rejoin; multi-MB map
images sync slowly (keep maps light or host them externally); the public broker
occasionally rate-limits.

---

## Local testing

`file://` won't work (IndexedDB/WebRTC need a real origin). Serve statically:

```sh
python -m http.server 8080   # then open http://localhost:8080
```

---

## Tech stack

React 18 + ReactDOM (UMD globals) · PeerJS (WebRTC) · IndexedDB (state + map
images) with `localStorage` for auth/settings · pure CSS with custom-property
theming. JSX is pre-compiled by Babel (`./build.sh`) into `app.compiled.js`; the
browser loads the compiled bundle, never raw JSX. No bundler, no backend.

---

## Security notes

- The DM passphrase is a soft, client-side gate — not authentication.
- WebRTC traffic is encrypted in transit (DTLS); the signaling broker sees only
  connection metadata.
- State lives in each device's browser (IndexedDB); use Export/Import to back up.

---

## Version history

- **v7** — synced chat with whispers, a four-phase player character creator
  (DM-approved, animated stat & HP rolls), DM-approved sheet stat/level
  requests, combat movement ranges (max + remaining, enforced on a player's
  turn), class dropdown, per-map image layers (move/rotate/lock + DM-only),
  asset token images, DM-pushed player themes, bestiary carousel + World
  filters, homebrew inventory items, soundboard, token groups, IndexedDB.
- **v6** — shared drawings, hazard zones, durable storage, annotation overhaul.
- **v5** — worldbuilding + visibility overhaul, bestiary, block zones.
- **v3–v4** — *The Plague's Call* rebrand; themes, forced onboarding, day/night,
  vision/light, reminder pins, plus a stability + polish pass.
- **v2** — Shadowquill foundation: entities, claims, initiative.

---

## License

MIT — do what you want; attribution appreciated but not required.
