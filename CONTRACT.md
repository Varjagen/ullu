# CONTRACT.md — developer guide & data contract

A single reference for how this app is put together: its identity, the data
shapes that flow between the DM and players (the "contract"), and the
conventions that keep changes safe. Read this before adding a feature.

---

## 1. Identity & codenames

This codebase has worn three names. They coexist in the source, so knowing
the mapping prevents confusion:

| Name | Where it shows up | Meaning |
| --- | --- | --- |
| **Burrows and Badgers** | UI title, zip name | The current public brand. |
| **The Plague's Call** | `STORAGE_KEY` etc. (`plagues-call.*`), file comments | The internal/original product name. Storage keys and most code comments use this. |
| **Shadowquill** | `LEGACY_*` keys (`shadowquill.*`) | The first name; only referenced for backward-compatible session loading. |
| **Weekend_Wonders-main** | repo folder name | The on-disk folder / zip root. |

Treat "Plague's Call" as the canonical internal name (it's what the storage
namespace and migration code key on). Don't rename storage keys without a
migration path in `migrateState()`.

---

## 2. Architecture at a glance

- **Single-file React app.** All logic lives in `app.js` (~14k lines) as
  classic JSX. It is compiled ahead-of-time to `app.compiled.js`, which is
  what the browser actually loads.
- **`index.html`** loads `app.compiled.js` and contains the **entire CSS**
  in one `<style>` block. There is no CSS build step.
- **`build.sh`** runs Babel over `app.js` → `app.compiled.js`. It pins the
  **classic** JSX runtime (`runtime: 'classic'`) so the output uses
  `React.createElement` and never emits `import` statements — required
  because the bundle is loaded as a plain `<script>`, not a module.
- **Stack:** React 18 + ReactDOM (UMD globals), **PeerJS** (WebRTC sync, no
  backend), **IndexedDB** (large assets), `localStorage` (small prefs).
- **`assets/tokens/`** holds optional standard token images named after
  presets (see that folder's README).

### Build & deploy

```sh
# edit app.js, then:
./build.sh                 # regenerates app.compiled.js (needs @babel/core + @babel/preset-react)
```

Deploy needs **`index.html` + `app.compiled.js` + `assets/`**. `app.js` is
source only. After every build, sanity-check:

```sh
head -1 app.compiled.js            # must be the file comment, NOT "import …"
grep -c jsx-runtime app.compiled.js  # must be 0
```

---

## 3. The two-mode model (authority)

The app runs in one of two modes, chosen on the auth screen:

- **DM mode** (`DMInterface`) — the **host** and the single source of truth.
  Holds the authoritative reducer state, owns all writes, and broadcasts a
  per-player **filtered** view to each connected peer.
- **Player mode** (`PlayerInterface`) — a **client**. Never mutates shared
  state directly. It *requests* changes by sending **player actions** to the
  DM, and renders whatever filtered state the DM broadcasts back.

> **Golden rule:** players propose, the DM disposes. Any new player-driven
> change must go through a player action that the DM validates, never a
> direct `dispatch` on the player side.

---

## 4. Data contract — the shared state

`state` is one plain object, produced by the reducer and run through
`migrateState()` on load/import for forward-compat. Top-level keys:

| Key | Shape | Notes |
| --- | --- | --- |
| `entities` | `{ id → entity }` | The cast: PCs, NPCs, Monsters, Familiars, Objects, Labels. See §5. |
| `entityOrder` | `[id, …]` | Sidebar ordering. |
| `tokens` | `{ id → { id, entityId, mapId, x, y, visible, scale? } }` | Placed instances of entities on maps. |
| `maps` | `{ id → { id, name, imageUrl, gridSize, … } }` | Battle maps. Image bytes are offloaded to IDB (sentinel `__idb__`). |
| `currentMapId` | `string` | DM's active map. |
| `claims` | `{ peerId → claim }` | Who controls what. See §6. |
| `initiative` | `{ entries: [...], active, round }` | Turn order. |
| `presets` | encounter snapshots | DM-saved token layouts. |
| `tokenPresets` | `{ id → { id, name, entity } }` | DM-defined bestiary presets. |
| `reminders` | `{ peerId → [reminder] }` | **Per-viewer** private map pins (DM key = `'dm'`). |
| `playerThemes` | `{ peerId → { theme, ts } }` | DM-pushed UI theme per player (applied once per `ts`). |
| `chat` | `[{ id, ts, senderId, senderName, text, whisperTo, whisperToName }]` | Synced log, capped at `CHAT_MAX`. Whispers filtered per viewer. |
| `forcedView` / `forcedViewPerPeer` | view push | DM forces players to a map/region (global or per-peer). |
| `blockZones` | `{ mapId → [zone] }` | Movement-blocking rectangles. |
| `drawings` | `{ mapId → [drawing] }` | Shared freehand overlay. |
| `hazards` | `{ mapId → [hazard] }` | Environmental hazard polygons. |
| `layers` | `{ mapId → [layer] }` | Image overlays per map (above the map, below tokens). Each: `{id, mapId, name, imageUrl, x, y, w, h, rotation, mode:'locked'|'move'|'rotate', dmOnly}`. Image bytes offloaded to IDB and synced via the image envelope (keyed `layer:<id>`), exactly like map images. `dmOnly` restricts *editing* to the DM; players still see the layer. |
| `pendingRequests` | `{ id → request }` | Player→DM approval queue. Each: `{id, peerId, playerName, kind:'new_character'|'stat_change'|'level_change', payload, ts, status:'pending'|'accepted'|'rejected', resolvedTs}`. Players see only their *own* requests (filtered). The DM surfaces pending ones as accept/reject popups; unresolved ones auto-decline after 2 min. A `new_character` grant gates the multi-phase character creator. |
| `lockOffTurn` | `boolean` | DM toggle (Initiative panel). When true, during active combat a player may only move the token whose initiative turn it currently is; off-turn drags are blocked client-side (`canDragToken`) and rejected server-side (`move_token`). The DM is never restricted (DM moves use `TOKEN_MOVE`). |
| `tokenGroups` | `{ mapId → [group] }` | DM encounter grouping (hidden from players). |
| `diceLog` | `[roll]` | Shared dice results. |
| `sounds` / `soundEvents` | registry + play/stop events | Soundboard. |
| `timeOfDay` | `0..1` | Day→night scalar (drives lighting). |
| `mapScale` | number | Global DM-controlled grid scale. |

### Player-visible subset

`filterStateForPlayer(state, peerId)` is the **read contract**: it returns
the version of state a given player may see. It spreads `...state` then
**overrides** sensitive slices. Crucially, `entities` is **rebuilt from only
the IDs the peer may know about** — never the whole roster — so hidden
monsters, unrevealed NPCs, and staged encounter creatures never enter the
payload (not just hidden in the UI). The allowed set is: all PCs/Familiars
(party-class), any entity behind a token that survived visibility + vision
filtering, any entity in the player-facing initiative, and everything the peer
owns. Each surviving entity is then run through `sanitizeEntityForPlayer`
(strips DM notes/abilities, zeroes death saves). It also hides non-visible and
out-of-vision tokens, filters initiative to those same visible entities,
narrows `reminders`/`forcedViewPerPeer` to that peer, strips `tokenGroups`, and
filters `chat` via `chatForViewer` (public + their own whispers only).
**Spectators** get a parallel branch with the same entity-set gating (no vision
cutoff; party + visible tokens + visible initiative). When you add a DM-only
field to state, decide whether it must be stripped here — by default
`...state` would leak it.

---

## 5. The entity model

`makeEntity(overrides)` is the single constructor. Core fields: `id`, `type`
(`PC|NPC|Monster|Familiar|Object|Label`), `name`, `color`, `imageUrl`,
`hp:{current,max}`, `ac`, `speed`, `initBonus`, `stats:{str,dex,con,int,wis,cha}`,
`conditions:[]`, `passivePerception`, `passiveHiding`, `sickness`, plus the
full D&D sheet: `class`, `level`, `race`, `background`, `alignment`,
`proficiencyBonus`, `hitDice`, `xp`, `money:{pp,gp,ep,sp,cp}`, `attacks`,
`spells`, `features`, `proficiencies`, `inventory`, `traits`, `ideals`,
`bonds`, `flaws`, `backstory`, `notes` (DM-only), `playerDescription`.

When adding an entity field that players may edit, add it to
`PLAYER_FIELD_WHITELIST` (or `PLAYER_STATS_WHITELIST` for ability scores).

---

## 6. The claims model

A **claim** records what a connected peer controls:

```js
{ pc: entityId|null, familiars: [entityId, …], playerName: string, spectator: bool }
```

`state.claims[peerId]` is keyed by the player's PeerJS id. The DM's own
pseudo-id for per-viewer data (reminders, chat sender) is the literal
`'dm'` (`DM_KEY`). `displayNameForPeer(state, peerId)` resolves a peer's
chat/label name: claimed PC name → playerName → `'Spectator'`/`'Player'`.

---

## 7. Sync protocol (the write contract)

```
Player UI  ──player action──▶  sync.sendPlayerAction({type, payload, peerId})
                                         │  (WebRTC)
                                         ▼
DM: handlePlayerAction(action, peerId)   ── validates & authorizes ──▶ dispatch(reducerAction)
                                         │
                          state changes ─┤
                                         ▼
        broadcast filterStateForPlayer(state, peerId) to every peer  ──▶  Player renders
```

- **Player actions** (lowercase types) are *requests*. The DM resolves
  identity from the connection's `peerId` — never trusts a name/id in the
  payload (prevents spoofing). Catalog: `claim_pc`, `claim_familiar`,
  `claim_spectator`, `create_and_claim_pc`, `unclaim_pc`, `unclaim_familiar`,
  `patch_own_entity`, `move_token`, `dice_roll`, `chat_send`,
  `reminder_upsert`, `reminder_delete`, `drawing_upsert`, `drawing_delete`,
  `drawing_clear_owner`, `sound_play`, `sound_stop`, `layer_transform`,
  `submit_request`, `creation_roll`, `roll_levelup_hp`.
- **Reducer actions** (UPPER_CASE types) are *authoritative mutations*, only
  ever dispatched on the DM side (or locally in solo mode). They are pure;
  see the reducer for the full ~80-case catalog (`ENTITY_UPSERT`,
  `TOKEN_MOVE`, `CLAIM_PC`, `CHAT_ADD`, `SET_PLAYER_THEME`, …).
- **Idempotency:** player actions may be re-sent (the onboarding gate retries
  until a claim confirms). Handlers must be safe to run twice — e.g.
  `create_and_claim_pc` ignores the request if the peer already holds a PC.
- **Character creation & approvals (v7.8):** a player who wants a new PC sends
  `submit_request {kind:'new_character'}`; the DM accepts via the popup, which
  flips the request to `accepted` and opens the 4-phase creator
  (`NewCharacterBuilder`). The builder logs each rolled value to a DM-only chat
  line (`creation_roll`) and persists to localStorage so a reload can't re-roll.
  Finishing sends `create_and_claim_pc`, which *requires* the accepted grant and
  consumes it. On the sheet, players don't edit `level` or ability scores
  directly (both removed from the player write-whitelist) — they send
  `submit_request {kind:'stat_change'|'level_change'}` (level is ±1 only,
  validated server-side). When the DM accepts, the change is applied via
  `ENTITY_PATCH`; a level-*up* sets `awaitingHpRoll`, after which the player
  rolls the new die (`roll_levelup_hp`). Unresolved requests auto-decline after
  2 minutes; the player is toasted on every resolution.
- **`pushSoon()`** sends a fresh filtered snapshot to the acting player
  ~`TUNING.pushSoonMs` after a state-changing action, so claims/edits feel
  instant instead of waiting for the next idle broadcast.

---

## 8. Component map

`app.js` is organized in banner-delimited sections. The big ones:

- **CONSTANTS / TUNING** — storage keys, `DM_PASSWORD`, themes, `TUNING`,
  condition tables, the bestiary presets (BnB + builtins), `PRESET_ITEMS`,
  `DND_CLASSES`, `CLASS_HIT_DIE`.
- **IDB STORAGE / UTILITIES** — persistence and helpers (`uid`, `clamp`, …).
- **DEFAULT STATE / MIGRATION / REDUCER / VISIBILITY FILTER** — the data core.
- **Shared UI** — `TokenComponent`, `MapCanvas`, `EntityForm`, `CharacterSheet`,
  `ClassSelect`, `InventoryItemPicker`, `LiveInput`, `useDraggable`, `ChatPanel`.
- **DM panels** — `EntitySidebar`, `InitiativeTracker`, `MapManager`,
  `BestiaryMenu`, `PresetsPanel`, `DMWorldPanel`, `HazardsPanel`, `ToolsMenu`,
  `TokenGroupsPanel`, `SoundboardPanel`, `DMClaimsPanel`, `TokenContextMenu`.
- **Player surfaces** — `PlayerOnboardingGate`, `NewCharacterBuilder`,
  `PartySidebar`, `RevealedMonstersSidebar`, `EditMySheetModal`.
- **`DMInterface` / `PlayerInterface` / `Root`** — the two mode shells.
- **PLAYER ACTION VALIDATION HELPERS** — the `handlePlayerAction` switch and
  whitelists, at the bottom (module-level, closure-free where possible).

---

## 9. Tuning & configuration

All behavioural "knobs" live in the **`TUNING`** object at the top of
`app.js`. The previously-loose constants now derive from it, so this is the
single place to adjust the table's feel:

| `TUNING` key | Default | Effect |
| --- | --- | --- |
| `pushSoonMs` | 60 | Delay before a targeted post-action push to one player. |
| `claimResendMs` | 2500 | Onboarding: re-send a pending claim until confirmed. |
| `claimGiveUpMs` | 12000 | Onboarding: stop the spinner if a claim never confirms. |
| `connectTimeoutMs` | 20000 | Peer connection attempt timeout (`CONNECT_TIMEOUT_MS`). |
| `chatMaxMessages` | 250 | Synced chat history cap (`CHAT_MAX`). |
| `chatMaxChars` | 600 | Per-message character cap. |
| `measureLingerMs` | 10000 | Lifetime of a lingering on-map measurement. |
| `reminderSizeMin/Max` | 0.6 / 2.4 | Reminder pin scale bounds. |

Other notable config: `DM_PASSWORD` (auth passphrase), `STORAGE_KEY` family
(§1), `THEMES` (the 8 UI themes), `CONDITION_GROUPS`/`CONDITION_COLORS`,
`CLASS_HIT_DIE` (level-1 HP rules).

---

## 10. Storage

- **IndexedDB** (`IDB_STORES`): `session` (lean state JSON), `mapImages`
  (`mapId → data URL`), `sounds`. Large base64 is kept out of the state blob;
  the JSON carries an `__idb__` sentinel that is re-inflated on load.
- **Image sync (DM → peers):** map/layer image bytes travel in a separate
  `map_image` envelope, not the lean `state_update`. The DM remembers what it
  has sent each peer as `imageKey → content fingerprint` (`imageFingerprint`,
  a cyrb53 hash + length). Keying by id alone would treat a *replaced* image
  (same id, new bytes) as already-delivered and never resend it, stranding
  players on stale art; keying by fingerprint resends whenever the bytes
  change. On receipt the player overwrites both its rendered state
  (`MAP_IMAGE_RECEIVED`/`LAYER_IMAGE_RECEIVED`) and its IDB cache. When a peer
  disconnects or is kicked, the DM drops that peer's fingerprint + sound caches
  (keyed off `peerList`), so a fresh reconnect re-receives the current map and
  sound library even if the client cleared its own IDB while away.
- **localStorage**: `AUTH_KEY`, `SETTINGS_KEY`, `PLAYER_ID_KEY` (stable
  per-device identity) — all small. Legacy `shadowquill.*` keys are read on
  migration only.

---

## 11. Conventions & gotchas

- **Build runtime:** keep `build.sh` on the **classic** JSX runtime. A fresh
  Babel 8 defaults to *automatic*, which injects `import react/jsx-runtime`
  and breaks the script load.
- **`grep -c` returns exit code 1 when the count is 0** — don't chain
  `grep -c … && cp …`; the `&&` short-circuits and leaves a stale bundle.
  Use `cp -f` unconditionally.
- **Adding state that's DM-only:** remember `filterStateForPlayer` spreads
  `...state`; override/strip the new field in both the spectator and main
  return, or it leaks to players.
- **Player writes:** route through a `handlePlayerAction` case + a whitelist;
  resolve identity from `peerId`, not the payload.
- **Controlled inputs:** use `LiveInput`/`LiveTextarea`/`LiveNumberInput`,
  which keep a local draft while focused and re-sync to the external value on
  blur — important so synced updates don't fight the user's typing.
- **Reducers are pure;** side effects (broadcast, IDB, toasts) live in the
  interfaces, not the reducer.

---

## 12. Recipe: adding a player-driven feature

1. **State:** add the field to DEFAULT STATE; default-guard it in the reducer
   (`state.x || …`) so old sessions migrate cleanly.
2. **Reducer:** add an UPPER_CASE action that applies the mutation purely.
3. **Visibility:** decide what players may see; override it in
   `filterStateForPlayer` if it isn't safe to broadcast verbatim.
4. **Player action:** add a lowercase `handlePlayerAction` case that
   validates, resolves identity from `peerId`, sanitizes the payload, and
   dispatches the reducer action (+ `pushSoon()` for snappiness).
5. **UI:** build the component; players call `playerActionSender(...)`, the DM
   calls `dispatch(...)` directly.
6. **CSS** goes in `index.html`. **Tunables** go in `TUNING`.
7. **Build** (`./build.sh`), verify the bundle (classic runtime, no imports),
   test, ship `index.html` + `app.compiled.js` + `assets/`.
