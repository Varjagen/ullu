/* The Plague's Call - single-file React app (formerly "Shadowquill" v1)
 * - Dual-mode (DM / Player) with strict permission separation
 * - PeerJS WebRTC sync (free public broker - no backend required)
 * - IndexedDB persistence (v7) + Export/Import JSON
 */
const { useState, useEffect, useRef, useReducer, useMemo, useCallback, createContext, useContext } = React;

// ====================================================================
// CONSTANTS
// ====================================================================
// Storage keys bumped to v2 for the Plague's Call rebrand. Older
// 'shadowquill.*' sessions are still readable - see migrateState() below,
// which checks both namespaces for legacy compatibility.
const STORAGE_KEY  = 'plagues-call.session.v2';
const AUTH_KEY     = 'plagues-call.auth.v2';
const SETTINGS_KEY = 'plagues-call.settings.v2';
const PLAYER_ID_KEY = 'plagues-call.player-id.v4'; // v4: stable per-device identity
const PEER_PREFIX  = 'plagues-call-';
const LEGACY_STORAGE_KEY = 'shadowquill.session.v1';
const LEGACY_AUTH_KEY    = 'shadowquill.auth.v1';

// ====================================================================
// IDB STORAGE  (v7 fix #1)
// ====================================================================
// v6 wrote everything to localStorage as one giant JSON blob. Once map
// images (base64 data URLs, often 0.5-3 MB each) accumulated, the total
// quickly exceeded the ~5 MB localStorage quota and saves started
// throwing QuotaExceededError - silently losing state.
//
// v7 splits storage:
//   IDB store 'session'   → the lean state JSON (no map image bytes)
//   IDB store 'mapImages' → { mapId → base64-data-url }
//   IDB store 'sounds'    → { soundId → { name, dataUrl } } for v7 #10
//
// On save, map images are extracted from state.maps[*].imageUrl into
// the mapImages store; the state JSON gets a sentinel ("__idb__") marker
// in their place. On load, the sentinels get re-inflated.
//
// localStorage retains only:
//   - auth, settings, player-id (small, fine where they were)
//   - a tiny "session metadata" stub for legacy code paths
//
// IndexedDB has effectively no quota for this kind of usage (per-origin
// allowance is hundreds of MB to GB), and writes are async + transactional.

const IDB_NAME = 'plagues-call';
const IDB_VERSION = 1;
const IDB_STORES = { session: 'session', mapImages: 'mapImages', sounds: 'sounds' };
const IMG_SENTINEL = '__idb_image__';

// v8.9: debug logging is off in production. Several traces carried peer IDs
// and claim JSON; gate them all behind a flag you can flip at the console with
//   localStorage.setItem('plagues-call.debug','1')
const DEBUG = (() => { try { return localStorage.getItem('plagues-call.debug') === '1'; } catch { return false; } })();
const dlog = (...a) => { if (DEBUG) console.log(...a); };

// v7.8: cheap content fingerprint for an image dataURL (cyrb53 hash + length).
// The DM uses this to decide whether a map/layer image still needs sending to
// a peer: keying the "already sent" cache by id alone meant that *replacing* an
// image (same id, new bytes) was treated as already-delivered, leaving players
// on stale art. Keying by id+fingerprint resends whenever the bytes change.
function imageFingerprint(str) {
  if (!str) return '0';
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + str.length;
}

// In-memory cache for sound audio data (soundId → dataUrl).
// Populated by onSoundData and by useSoundPlayback when it reads from IDB.
// This avoids the IDB read-write race: when a sound_data envelope arrives
// and updates the cache, the next render of useSoundPlayback can find the
// bytes synchronously without waiting for an async IDB lookup to complete.
// Never serialised or broadcast - lives only for the current page session.
const _soundDataCache = new Map();

let _idbPromise = null;
function openIDB() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB not supported'));
      return;
    }
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORES.session))    db.createObjectStore(IDB_STORES.session);
      if (!db.objectStoreNames.contains(IDB_STORES.mapImages))  db.createObjectStore(IDB_STORES.mapImages);
      if (!db.objectStoreNames.contains(IDB_STORES.sounds))     db.createObjectStore(IDB_STORES.sounds);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return _idbPromise;
}

function idbGet(storeName, key) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}
function idbSet(storeName, key, value) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}
function idbDelete(storeName, key) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  }));
}
function idbAllKeys(storeName) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAllKeys();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  }));
}
function idbAllEntries(storeName) {
  return openIDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const keysReq = store.getAllKeys();
    const valsReq = store.getAll();
    keysReq.onsuccess = () => {
      valsReq.onsuccess = () => {
        const out = {};
        keysReq.result.forEach((k, i) => { out[k] = valsReq.result[i]; });
        resolve(out);
      };
      valsReq.onerror = () => reject(valsReq.error);
    };
    keysReq.onerror = () => reject(keysReq.error);
  }));
}

// Strip map images from the state for serialization. Returns
//   { lean, images } where lean has IMG_SENTINEL in place of imageUrl
//   bytes, and images is { mapId → dataUrl } for IDB persistence.
// Also strips inline audio dataUrls from soundEvents - those live in
// the IDB sounds store, no need to duplicate them in state.
function splitStateForPersist(state) {
  const images = {};
  const leanMaps = {};
  for (const [id, m] of Object.entries(state.maps || {})) {
    if (m.imageUrl && typeof m.imageUrl === 'string' && m.imageUrl.startsWith('data:')) {
      images[id] = m.imageUrl;
      leanMaps[id] = { ...m, imageUrl: IMG_SENTINEL };
    } else {
      // External URLs and missing images stay in the JSON
      leanMaps[id] = m;
    }
  }
  // v7 #10: drop dataUrls from soundEvents so they don't bloat the
  // session JSON. Players cache the bytes in IDB on first receipt.
  const leanSoundEvents = (state.soundEvents || []).map(e => {
    const { dataUrl, ...rest } = e;
    return rest;
  });
  // v7.7: extract per-map layer images too, keyed 'layer:<layerId>' in the
  // same mapImages store (keys never collide with raw map ids).
  const leanLayers = {};
  for (const [mid, list] of Object.entries(state.layers || {})) {
    leanLayers[mid] = (Array.isArray(list) ? list : []).map(l => {
      if (l?.imageUrl && typeof l.imageUrl === 'string' && l.imageUrl.startsWith('data:')) {
        images['layer:' + l.id] = l.imageUrl;
        return { ...l, imageUrl: IMG_SENTINEL };
      }
      return l;
    });
  }
  return {
    lean: { ...state, maps: leanMaps, soundEvents: leanSoundEvents, layers: leanLayers },
    images,
  };
}

// Inverse: take a lean state + an images dict and rehydrate.
function rejoinStateImages(lean, images) {
  const maps = {};
  for (const [id, m] of Object.entries(lean.maps || {})) {
    if (m.imageUrl === IMG_SENTINEL && images[id]) {
      maps[id] = { ...m, imageUrl: images[id] };
    } else if (m.imageUrl === IMG_SENTINEL) {
      // Image missing from IDB - leave it null so the map can still load.
      console.warn(`[plagues-call] map ${id} image missing from IDB`);
      maps[id] = { ...m, imageUrl: null };
    } else {
      maps[id] = m;
    }
  }
  // v7.7: rehydrate per-map layer images from the same store.
  const layers = {};
  for (const [mid, list] of Object.entries(lean.layers || {})) {
    layers[mid] = (Array.isArray(list) ? list : []).map(l => {
      if (l?.imageUrl === IMG_SENTINEL) {
        const bytes = images['layer:' + l.id];
        return { ...l, imageUrl: bytes || null };
      }
      return l;
    });
  }
  return { ...lean, maps, layers };
}

// Save: writes the lean state JSON + each map image to IDB. Removes
// IDB images for maps that no longer exist (so deletion frees space).
async function persistSessionToIDB(state) {
  const { lean, images } = splitStateForPersist(state);
  const json = JSON.stringify(lean);
  await idbSet(IDB_STORES.session, 'main', json);
  // Sync map images with IDB: write current ones, delete orphans.
  const existingKeys = await idbAllKeys(IDB_STORES.mapImages);
  const wantKeys = new Set(Object.keys(images));
  for (const k of existingKeys) {
    if (!wantKeys.has(k)) await idbDelete(IDB_STORES.mapImages, k);
  }
  for (const [id, dataUrl] of Object.entries(images)) {
    await idbSet(IDB_STORES.mapImages, id, dataUrl);
  }
  return { jsonBytes: json.length, imageCount: Object.keys(images).length };
}

async function loadSessionFromIDB() {
  const json = await idbGet(IDB_STORES.session, 'main');
  if (!json) return null;
  const lean = JSON.parse(json);
  const images = await idbAllEntries(IDB_STORES.mapImages);
  return rejoinStateImages(lean, images);
}

// One-time migration from localStorage v6 blob → IDB. Reads the old
// blob, splits it, writes to IDB, and deletes the localStorage entries.
// Idempotent: once IDB has a session, this is a no-op.
async function migrateLocalStorageToIDB() {
  try {
    const existingIDB = await idbGet(IDB_STORES.session, 'main');
    if (existingIDB) return { migrated: false, reason: 'idb-already-has-data' };
    // Try v6 keys
    let raw = null, source = null;
    try { raw = localStorage.getItem(STORAGE_KEY); source = STORAGE_KEY; } catch {}
    if (!raw) { try { raw = localStorage.getItem(STORAGE_KEY + '.backup'); source = STORAGE_KEY + '.backup'; } catch {} }
    if (!raw) { try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); source = LEGACY_STORAGE_KEY; } catch {} }
    if (!raw) return { migrated: false, reason: 'no-localstorage-data' };
    const parsed = JSON.parse(raw);
    await persistSessionToIDB(parsed);
    // Now safe to remove the bloated localStorage entries
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
    try { localStorage.removeItem(STORAGE_KEY + '.backup'); } catch {}
    return { migrated: true, source, bytes: raw.length };
  } catch (err) {
    console.warn('[plagues-call] localStorage→IDB migration failed:', err?.message || err);
    return { migrated: false, reason: 'error', error: err?.message };
  }
}

// v4: Stable per-device player identity. Persists across refresh/reconnect
// so that DM can re-link a returning player to their previous claim even
// though PeerJS gives them a brand-new peer ID on each session.
function getOrCreatePlayerId() {
  try {
    const existing = localStorage.getItem(PLAYER_ID_KEY);
    if (existing) return existing;
    const id = 'pid_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    localStorage.setItem(PLAYER_ID_KEY, id);
    return id;
  } catch {
    return 'pid_anon_' + Math.random().toString(36).slice(2, 12);
  }
}

// Simple password for DM mode (placeholder - swap with real auth for production)
const DM_PASSWORD = 'Hellfire';
if (DM_PASSWORD === 'dragon') {
  console.warn("[plagues-call] Default DM password 'dragon' is in use. Change DM_PASSWORD in app.js before public deployment.");
}

const APP_NAME = "Burrows and Badgers";

// v7.6: status effects grouped by valence. CONDITIONS stays a flat list
// (negative → positive → neutral) so all existing lookups/validation work;
// the picker UI renders the three groups as labelled sections.
const CONDITION_GROUPS = {
  negative: [
    'Blinded', 'Charmed', 'Deafened', 'Frightened', 'Grappled', 'Incapacitated',
    'Paralyzed', 'Petrified', 'Poisoned', 'Prone', 'Restrained', 'Slowed', 'Stunned',
    'Unconscious', 'Exhausted', 'On Fire', 'Bleeding', 'Cursed', 'Marked', 'Diseased',
  ],
  positive: [
    'Blessed', 'Hasted', 'Raging', 'Guidance', 'Inspired', 'Shielded', 'Resistant', 'Invisible',
  ],
  neutral: [
    'Concentrating', 'Hidden', 'Dead', 'Broken',
  ],
};
const CONDITIONS = [
  ...CONDITION_GROUPS.negative,
  ...CONDITION_GROUPS.positive,
  ...CONDITION_GROUPS.neutral,
];

// v7.9: standard D&D damage types for the player attack-request builder. The
// builder also allows a free-typed custom type for homebrew.
const DAMAGE_TYPES = [
  'Slashing', 'Piercing', 'Bludgeoning', 'Fire', 'Cold', 'Acid', 'Lightning',
  'Thunder', 'Poison', 'Necrotic', 'Radiant', 'Psychic', 'Force',
];

const CONDITION_COLORS = {
  'Poisoned': '#6b8e3f', 'Stunned': '#c9b03a', 'Blinded': '#444',
  'Paralyzed': '#7a4bc4', 'Charmed': '#c46ab8', 'Frightened': '#b56a3a',
  'Prone': '#6b7280', 'Restrained': '#8b5a2b', 'Unconscious': '#4a4a6a',
  'Dead': '#8b2020', 'Invisible': '#4a7cbd', 'Blessed': '#d4a574',
  'Concentrating': '#9b6ac4', 'Raging': '#c43e3e', 'Hasted': '#4ab0c4',
  // v5: "Broken" gets a dusty grey-brown to distinguish from Dead's blood red
  'Broken': '#7a6455',
  // v7.6: new status effects
  'On Fire': '#e2632a', 'Bleeding': '#a82828', 'Cursed': '#6a2a8a',
  'Slowed': '#5f74a0', 'Marked': '#c43e7a', 'Guidance': '#d9c36a',
  'Inspired': '#b46ad0', 'Shielded': '#5a8ec9', 'Resistant': '#3fa3a0',
  'Hidden': '#5a5a66',
};

// Entity types. Added in v2: Familiar, Neutral Beast, Object.
//  - Familiar      : player-claimable, possibly multiple per player, HP visible to players
//  - Neutral Beast : environmental / non-hostile, visibility-gated like monsters
//  - Object        : static/interactable, no initiative by default, HP hidden from players
const ENTITY_TYPES = ['PC', 'Monster', 'NPC', 'Familiar', 'Neutral Beast', 'Object', 'Label'];

const DEFAULT_COLORS = {
  'PC': '#4a7cbd',
  'Monster': '#8b2020',
  'NPC': '#d4a574',
  'Familiar': '#5fb58a',
  'Neutral Beast': '#7a9274',
  'Object': '#8a7f6e',
  'Label': '#c9a34a',
};

// Entity types whose HP bars/numbers players can see. Everything else is
// abstracted to a Strong/Rough/Waning status label for players.
const PLAYER_HP_VISIBLE_TYPES = new Set(['PC', 'Familiar']);

// Entity types that are player-claimable.
const CLAIMABLE_TYPES = new Set(['PC', 'Familiar']);

// Player-visible descriptors for the DM-set Sickness stat (0-3).
const SICKNESS_DESCRIPTORS = [
  '',                       // 0 - nothing
  'A bit pale',             // 1
  'Sluggish and pale',      // 2
  'Sick',                   // 3
];

const DEFAULT_SETTINGS = {
  theme: 'dark',
  mapScale: 1.0,
  sicknessEffects: true,
  obfuscateHp: false, // DM: show health estimates instead of exact numbers to players
  moveRangeOpacity: 0.55, // v7.8: opacity of the combat movement-range markers
  grain: true, // v7.8: subtle film-grain texture on menu/panel surfaces
  physicalDice: false, // v8.3: enter real-life dice results instead of auto-rolling
  approveNewPlayers: false, // v8.9: DM must approve each new player before they enter
};

// v7.6: the selectable UI themes (id + label), shared by the Settings modal
// and the DM's per-player theme control.
const THEMES = [
  { id: 'dark', label: 'Dark Sanctum' },
  { id: 'forest', label: 'Dark Forest' },
  { id: 'darkcherry', label: 'Dark Cherry' },
  { id: 'ocean', label: 'Deep Ocean' },
  { id: 'light', label: 'Warm Tavern' },
  { id: 'cherry', label: 'Cherry Blossom' },
  { id: 'river', label: 'River Blue' },
  { id: 'meadow', label: 'Flowery Meadow' },
];

// ====================================================================
// TUNING - the table's behavioural "knobs" in one place. These were
// previously magic numbers scattered through component bodies; grouping
// them here makes the feel of the app easy to adjust and the existing
// named constants below (CHAT_MAX, CONNECT_TIMEOUT_MS, REMINDER_SIZE_*)
// now derive from this single source. All *Ms values are milliseconds.
// See CONTRACT.md → "Tuning & configuration" for the full reference.
// ====================================================================
const TUNING = {
  // Sync & authority
  pushSoonMs: 60,           // delay before a targeted post-action state push to one player
  claimResendMs: 2500,      // onboarding: re-send a pending claim until the DM confirms it
  claimGiveUpMs: 12000,     // onboarding: stop the spinner if a claim never confirms
  connectTimeoutMs: 20000,  // player↔DM peer connection attempt timeout
  // Chat
  chatMaxMessages: 250,     // most-recent messages retained in synced state
  chatMaxChars: 600,        // per-message character cap
  // On-map measurement
  measureLingerMs: 10000,   // total life of a lingering measurement (full-visible + fade-out)
  // Reminders (per-viewer map pins)
  reminderSizeMin: 0.6,
  reminderSizeMax: 2.4,
};

// v7.6: maximum number of chat messages retained in synced state.
const CHAT_MAX = TUNING.chatMaxMessages;

// Burrows & Badgers - Creature Compendium presets (auto-generated from
// BnB_Creature_Compendium_v2.md). Typed as 'Monster' so the full
// stat-block (Abilities + player-visible flavor) renders. Grouped by
// 'B&B: <section>' category in the bestiary browser.
const BNB_TOKEN_PRESETS = [
  {
    "id": "bnb:robin",
    "name": "Robin",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Robin",
      "color": "#b9935a",
      "hp": {
        "current": 7,
        "max": 7
      },
      "ac": 12,
      "speed": 30,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 4,
        "dex": 16,
        "con": 8,
        "int": 2,
        "wis": 12,
        "cha": 6
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 10 ft., Fly 30 ft.\n\n• Territorial Song. The Robin can be trained to alert its owner when an unfamiliar creature enters a marked territory (30 ft. radius). Intruders have disadvantage on Stealth checks against the Robin's owner.\n• Dive Peck. Melee Attack: +4 to hit, reach 5 ft. - 1d4 piercing.",
      "playerDescription": "In every grovetown there is at least one Robin perched like a small smug lord, utterly certain the whole canopy belongs to it. Badgermen smiths adore them, for nothing announces a stranger faster than a Robin who feels its borders have been insulted. Trespass within its thirty feet and you will earn a song, a scolding, and very likely a peck on the nose.",
      "notes": "Flying | Medium | CR 1/4"
    }
  },
  {
    "id": "bnb:blue_tit",
    "name": "Blue Tit",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Blue Tit",
      "color": "#b9935a",
      "hp": {
        "current": 11,
        "max": 11
      },
      "ac": 12,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 4,
        "dex": 16,
        "con": 10,
        "int": 2,
        "wis": 12,
        "cha": 6
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 10 ft., Fly 35 ft.\n\n• Acrobatic Flight. The Blue Tit can fly through difficult terrain without movement penalty.\n• Peck. Melee Attack: +3 to hit, reach 5 ft. - 1d6 piercing.",
      "playerDescription": "Quick, clever, and forever in a hurry, the Blue Tit treats a grovetown's maze of rope bridges and pulleys as its own private obstacle course. It will loop a swinging lantern, thread a gap no sensible bird would attempt, and land looking faintly disappointed that you were impressed. Little wonder the messenger children adore them.",
      "notes": "Flying | Medium | CR 1/2"
    }
  },
  {
    "id": "bnb:great_tit",
    "name": "Great Tit",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Great Tit",
      "color": "#b9935a",
      "hp": {
        "current": 11,
        "max": 11
      },
      "ac": 12,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 6,
        "dex": 16,
        "con": 10,
        "int": 2,
        "wis": 12,
        "cha": 6
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 10 ft., Fly 35 ft.\nCarrying Capacity: 1 Small creature or 75 lbs.\n\n• Sure Perch. When a rider is mounted, the Great Tit can perch on branches, ropes, and ledges without requiring a Dexterity check from the rider to remain seated.\n• Peck. Melee Attack: +3 to hit, reach 5 ft. - 1d6 piercing.",
      "playerDescription": "The Great Tit is the patient schoolmaster of riding birds, steady of foot and endlessly forgiving of a wobbling first-time rider. You will find them in nearly every grovetown and walled grassland village, blinking placidly while some young Harefolk works out which end is the front. Dependable, sure-footed, and entirely unbothered by your inexperience.",
      "notes": "Flying | Rideable | Medium | CR 1/2"
    }
  },
  {
    "id": "bnb:red_wing",
    "name": "Red Wing",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Red Wing",
      "color": "#b9935a",
      "hp": {
        "current": 22,
        "max": 22
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 8,
        "dex": 16,
        "con": 12,
        "int": 3,
        "wis": 14,
        "cha": 6
      },
      "cr": "1",
      "abilities": "Speed: Walk 10 ft., Fly 40 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Migratory Memory. The Red Wing never loses its way between known locations and cannot be magically misdirected while following a route it has flown before.\n• Wing Buffet. Melee Attack: +3 to hit - 1d6 bludgeoning. Target makes DC 11 Strength save or is knocked prone.",
      "playerDescription": "A Red Wing never quite forgets a road it has flown, which makes it the beating heart of news between far-flung clans. Hand one a sealed letter and the vaguest sense of direction, and it will carry both faithfully over hills the maps have given up on. Many a feud has been kindled, and a few quietly mended, by a Red Wing arriving punctually at dusk.",
      "notes": "Flying | Rideable | Medium | CR 1"
    }
  },
  {
    "id": "bnb:sparrow",
    "name": "Sparrow",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Sparrow",
      "color": "#b9935a",
      "hp": {
        "current": 32,
        "max": 32
      },
      "ac": 13,
      "speed": 45,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 10,
        "dex": 18,
        "con": 14,
        "int": 3,
        "wis": 14,
        "cha": 7
      },
      "cr": "2",
      "abilities": "Speed: Walk 15 ft., Fly 45 ft.\nCarrying Capacity: 1 Medium creature or 200 lbs.\n\n• Evasive Flight. When targeted by a ranged attack, the Sparrow can use its reaction to impose disadvantage on the roll.\n• Burst of Speed. Once per short rest, the Sparrow can Dash as a bonus action.\n• Beak Strike. Melee Attack: +4 to hit, reach 5 ft. - 1d8 piercing.",
      "playerDescription": "If the whole continent has a favourite mount, it is the humble Sparrow: fast, hardy, and far too sensible to panic at the first hint of trouble. Warriors prize that sudden burst of speed, which has carried many a rider out of an ambush and straight into a tavern tale. Unglamorous, perhaps, but a Sparrow will see you home long after the prettier birds have lost their nerve.",
      "notes": "Flying | Rideable | Medium | CR 2"
    }
  },
  {
    "id": "bnb:hedgehog",
    "name": "Hedgehog",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Hedgehog",
      "color": "#b9935a",
      "hp": {
        "current": 22,
        "max": 22
      },
      "ac": 14,
      "speed": 25,
      "initBonus": -1,
      "passivePerception": 11,
      "stats": {
        "str": 12,
        "dex": 8,
        "con": 14,
        "int": 2,
        "wis": 12,
        "cha": 5
      },
      "cr": "1",
      "abilities": "Speed: Walk 25 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Spine Coat. Any creature that hits the Hedgehog with an unarmed melee strike takes 1d4 piercing in return.\n• Curl Up. As a bonus action, the Hedgehog curls into a ball, gaining +3 AC until the start of its next turn. While curled it cannot move or attack, and any rider is dismounted.\n• Snuffle. Advantage on Perception checks using smell.\n• Snout Butt. Melee Attack: +3 to hit, reach 5 ft. - 1d4+1 bludgeoning. On a hit against a creature that is surprised or unaware, the Hedgehog also curls defensively, triggering Spine Coat against the target as a free reaction.",
      "playerDescription": "What the Hedgehog lacks in haste it repays in sheer stubborn solidity, plodding over broken ground like a small and very prickly fortress. Harefolk favour them whenever the plan is to hold a line rather than win a race, and few foes relish charging a wall of spines that can simply curl up and wait. Slow to arrive, impossible to budge, and faintly smug about both.",
      "notes": "Rideable | Medium | CR 1"
    }
  },
  {
    "id": "bnb:ferret",
    "name": "Ferret",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Ferret",
      "color": "#b9935a",
      "hp": {
        "current": 27,
        "max": 27
      },
      "ac": 13,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 12,
        "dex": 16,
        "con": 12,
        "int": 4,
        "wis": 12,
        "cha": 6
      },
      "cr": "2",
      "abilities": "Speed: Walk 35 ft., Climb 20 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Slender Build. The Ferret and any mounted rider can move through spaces as small as 1 ft. wide without squeezing.\n• War Ferret Training. When specifically trained for combat, the Ferret can take the Attack action independently of its rider once per round.\n• Ferocious Bite. Melee Attack: +4 to hit - 1d8 piercing. On hit, the Ferret can immediately attempt to grapple the target (escape DC 13).",
      "playerDescription": "All whip-quick sinew and questionable intentions, the Ferret was made for the cramped lanes of the forest floor where larger mounts dare not follow. A war-trained Ferret and its rider can pour into a burrow and spill out behind the enemy, biting first and explaining never. Charming by the hearth, terrifying in a tunnel, and quite unable to tell the two apart.",
      "notes": "Rideable | Medium | CR 2"
    }
  },
  {
    "id": "bnb:smooth_newt",
    "name": "Smooth Newt",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Smooth Newt",
      "color": "#b9935a",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 12,
      "speed": 25,
      "initBonus": 1,
      "passivePerception": 10,
      "stats": {
        "str": 10,
        "dex": 12,
        "con": 12,
        "int": 1,
        "wis": 10,
        "cha": 4
      },
      "cr": "1",
      "abilities": "Speed: Walk 20 ft., Swim 25 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Amphibious. Can breathe both air and water.\n• Sticky Feet. Ignores difficult terrain caused by wet, muddy, or mossy surfaces.\n• Tail Lash. Melee Attack: +3 to hit, reach 10 ft. - 1d6 bludgeoning.",
      "playerDescription": "Raised in the riverlands, the Smooth Newt regards mud, marsh, and rain-soaked root as the only roads truly worth travelling. Its sticky toes cling to slick stone and dripping bark while drier mounts are still skidding about and complaining. Cool, damp, and never in a rush, it will ferry you across a flooded wood with the calm of a creature entirely in its element.",
      "notes": "Rideable | Medium | CR 1"
    }
  },
  {
    "id": "bnb:bank_vole",
    "name": "Bank Vole",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1/8",
    "entity": {
      "type": "Monster",
      "name": "Bank Vole",
      "color": "#b9935a",
      "hp": {
        "current": 3,
        "max": 3
      },
      "ac": 11,
      "speed": 20,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 2,
        "dex": 14,
        "con": 8,
        "int": 2,
        "wis": 10,
        "cha": 4
      },
      "cr": "1/8",
      "abilities": "Speed: Walk 20 ft., Burrow 10 ft.\n\n• Prey Animal. The Bank Vole has disadvantage on attack rolls but advantage on Stealth checks.\n• Harvest. Yields 1d4 units of hide and 1d4 units of meat when harvested.\n• Defensive Bite. Melee Attack: +2 to hit, reach 5 ft. - 1 piercing. Used only when cornered or grappled.",
      "playerDescription": "Plump, fretful, and endlessly busy, the Bank Vole is farmed across the grovetowns for hides so soft they end up gracing a noble's gloves. They live in a state of permanent mild alarm, which is only fair given how many neighbours regard them as supper. Gentle company all the same, so long as you make no sudden moves near the pantry.",
      "notes": "Small | CR 1/8"
    }
  },
  {
    "id": "bnb:house_spider",
    "name": "House Spider",
    "builtin": true,
    "category": "B&B: Domesticated",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "House Spider",
      "color": "#b9935a",
      "hp": {
        "current": 7,
        "max": 7
      },
      "ac": 12,
      "speed": 25,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 4,
        "dex": 14,
        "con": 10,
        "int": 1,
        "wis": 10,
        "cha": 2
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 25 ft., Climb 25 ft.\n\n• Silk Production. Produces 5 ft. of silk thread per day - 1 unit of raw silk per week, 1 unit of moult chitin per month.\n• Web Trap. As an action, creates a sticky web in one 5 ft. square. Creatures passing through make DC 11 Strength or Dexterity save or are restrained until they use an action to break free.\n• Spider Climb. Ignores difficult terrain from vertical or overhanging surfaces.\n• Bite. Melee Attack: +3 to hit, reach 5 ft. - 1d4 piercing + 1d4 poison.",
      "playerDescription": "Tucked in the rafters of Mousefolk kitchens and Badgermen workshops, the House Spider spins quietly through the night and asks for nothing but a warm corner and the odd passing fly. Its silk binds parcels, mends nets, and now and then snares a burglar who badly underestimated the cobwebs. Unsettling to some, indispensable to all, and the most patient worker a household will ever keep.",
      "notes": "Small | CR 1/4"
    }
  },
  {
    "id": "bnb:bullfinch",
    "name": "Bullfinch",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Bullfinch",
      "color": "#8a6a3a",
      "hp": {
        "current": 32,
        "max": 32
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 10,
        "dex": 16,
        "con": 14,
        "int": 3,
        "wis": 14,
        "cha": 10
      },
      "cr": "2",
      "abilities": "Speed: Walk 10 ft., Fly 40 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Vivid Plumage. Advantage on Persuasion and Presence checks while visibly mounted on a Bullfinch in social situations.\n• Powerful Beak. Melee Attack: +4 to hit - 2d6 piercing.",
      "playerDescription": "Striking birds favoured as status mounts by Vixenspawn merchants and Grovetowns chieftains.",
      "notes": "Flying | Rideable | Medium | CR 2"
    }
  },
  {
    "id": "bnb:starling",
    "name": "Starling",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Starling",
      "color": "#8a6a3a",
      "hp": {
        "current": 27,
        "max": 27
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 8,
        "dex": 18,
        "con": 12,
        "int": 5,
        "wis": 14,
        "cha": 8
      },
      "cr": "2",
      "abilities": "Speed: Walk 10 ft., Fly 40 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Murmuration. If 5+ Starlings move together on the same turn, creatures within 30 ft. make DC 13 Wisdom save or are disoriented, suffering disadvantage on attacks until the end of their next turn.\n• Mimicry. A tamed Starling can replicate any sound heard in the last 24 hours.\n• Wing Strike. Melee Attack: +4 to hit - 1d8 bludgeoning.",
      "playerDescription": "Popular as message carriers and scouts. A Starling cavalry formation using Murmuration has scattered far larger forces.",
      "notes": "Flying | Rideable | Medium | CR 2"
    }
  },
  {
    "id": "bnb:house_martin",
    "name": "House Martin",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "House Martin",
      "color": "#8a6a3a",
      "hp": {
        "current": 38,
        "max": 38
      },
      "ac": 14,
      "speed": 50,
      "initBonus": 5,
      "passivePerception": 12,
      "stats": {
        "str": 10,
        "dex": 20,
        "con": 12,
        "int": 3,
        "wis": 14,
        "cha": 7
      },
      "cr": "3",
      "abilities": "Speed: Walk 10 ft., Fly 50 ft.\nCarrying Capacity: 1 Medium creature or 175 lbs.\n\n• Aerial Agility. Can make sharp turns mid-flight without reducing speed. Advantage on Dexterity checks to avoid aerial hazards.\n• Insect Snatch. If a Flying Insect is within 10 ft. at the start of the Martin's turn, it may make one free bite attack against it.\n• Dive Strike. Melee Attack (after diving 20+ ft. in a straight line): +5 to hit - 2d6+2 piercing.",
      "playerDescription": "One of the fastest rideable birds on the continent. Favoured by Weaslie raiders and Harefolk scouts.",
      "notes": "Flying | Rideable | Medium | CR 3"
    }
  },
  {
    "id": "bnb:swallow",
    "name": "Swallow",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Swallow",
      "color": "#8a6a3a",
      "hp": {
        "current": 52,
        "max": 52
      },
      "ac": 14,
      "speed": 60,
      "initBonus": 6,
      "passivePerception": 12,
      "stats": {
        "str": 12,
        "dex": 22,
        "con": 14,
        "int": 3,
        "wis": 14,
        "cha": 8
      },
      "cr": "4",
      "abilities": "Speed: Walk 10 ft., Fly 60 ft.\nCarrying Capacity: 1 Medium creature or 200 lbs.\n\n• Speed Burst. Once per short rest, moves at double speed for one turn.\n• Hairpin Turn. Opportunity attacks against the Swallow while flying are made with disadvantage.\n• Razor Dive. Melee Attack: +6 to hit, reach 5 ft. - 2d8+3 piercing. After diving 30+ ft., target makes DC 14 Strength save or is knocked prone.",
      "playerDescription": "The apex riding bird. A Swallow-mounted rider is the fastest thing in the sky below the Ravenfolk.",
      "notes": "Flying | Rideable | Medium | CR 4"
    }
  },
  {
    "id": "bnb:owl",
    "name": "Owl",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "6",
    "entity": {
      "type": "Monster",
      "name": "Owl",
      "color": "#8a6a3a",
      "hp": {
        "current": 91,
        "max": 91
      },
      "ac": 15,
      "speed": 50,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 16,
        "dex": 17,
        "con": 13,
        "int": 8,
        "wis": 15,
        "cha": 10
      },
      "cr": "6",
      "abilities": "Speed: Walk 10 ft., Fly 50 ft.\nCarrying Capacity: 2 Medium creatures or 400 lbs.\n\n• Flyby. Does not provoke opportunity attacks when flying out of an enemy's reach.\n• Keen Hearing and Sight. Advantage on all Perception checks.\n• Silent Wings. Advantage on Stealth checks while flying.\n• Talons. Melee Attack: +7 to hit - 2d10+4 slashing. Target grappled on hit (escape DC 15).\n• Beak. Melee Attack: +7 to hit - 2d8+4 piercing.",
      "playerDescription": "Ancient and rare. Only the most experienced riders attempt to tame an Owl. They are war mounts and a declaration of absolute authority in the sky.",
      "notes": "Flying | Rideable | Large | CR 6"
    }
  },
  {
    "id": "bnb:mink",
    "name": "Mink",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "Mink",
      "color": "#8a6a3a",
      "hp": {
        "current": 45,
        "max": 45
      },
      "ac": 13,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 14,
        "dex": 16,
        "con": 14,
        "int": 4,
        "wis": 12,
        "cha": 6
      },
      "cr": "3",
      "abilities": "Speed: Walk 35 ft., Swim 25 ft.\nCarrying Capacity: 2 Medium creatures or 350 lbs.\n\n• Slick Coat. No speed penalty while swimming. Can hold breath for 3 minutes.\n• River Ambush. If attacking from underwater, the Mink has advantage on its first attack roll that turn.\n• Ferocious Bite. Melee Attack: +5 to hit - 2d8+3 piercing. Grappled on hit (escape DC 14).",
      "playerDescription": "The river cavalry mount of Ottermen long-riders and Castormen canal guards.",
      "notes": "Rideable | Large | CR 3"
    }
  },
  {
    "id": "bnb:polecat",
    "name": "Polecat",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Polecat",
      "color": "#8a6a3a",
      "hp": {
        "current": 59,
        "max": 59
      },
      "ac": 14,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 16,
        "dex": 16,
        "con": 16,
        "int": 4,
        "wis": 12,
        "cha": 7
      },
      "cr": "4",
      "abilities": "Speed: Walk 40 ft., Climb 25 ft.\nCarrying Capacity: 2 Medium creatures or 350 lbs.\n\n• Musk Burst. Once per short rest as a bonus action, spray a 10 ft. cone. DC 14 Constitution save or poisoned for 1 hour with disadvantage on Charisma checks for the rest of the day.\n• Slender Frame. The Polecat and mounted rider can squeeze through gaps as small as 2 ft. wide.\n• Vicious Bite. Melee Attack: +6 to hit - 2d10+3 piercing. On a critical hit, the target is also grappled (escape DC 15) until the Polecat releases.",
      "playerDescription": "Fierce and independent. Used as forest-floor cavalry and feared in tunnel fighting.",
      "notes": "Rideable | Large | CR 4"
    }
  },
  {
    "id": "bnb:great_crested_newt",
    "name": "Great Crested Newt",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Great Crested Newt",
      "color": "#8a6a3a",
      "hp": {
        "current": 32,
        "max": 32
      },
      "ac": 13,
      "speed": 30,
      "initBonus": 1,
      "passivePerception": 10,
      "stats": {
        "str": 14,
        "dex": 12,
        "con": 12,
        "int": 2,
        "wis": 10,
        "cha": 8
      },
      "cr": "2",
      "abilities": "Speed: Walk 25 ft., Swim 30 ft.\nCarrying Capacity: 2 Medium creatures or 300 lbs.\n\n• Amphibious. Breathes air and water.\n• Crest Display. Once per short rest as a bonus action, raises its spectacular crest. Creatures within 15 ft. make DC 13 Wisdom save or are frightened for 1 round.\n• Tail Sweep. Melee Attack: +4 to hit, reach 10 ft. - 1d10+2 bludgeoning. Target makes DC 13 Strength save or is knocked prone.",
      "playerDescription": "Impressive war mounts for swamp and riverland campaigns.",
      "notes": "Rideable | Large | CR 2"
    }
  },
  {
    "id": "bnb:rhinoceros_beetle",
    "name": "Rhinoceros Beetle",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Rhinoceros Beetle",
      "color": "#8a6a3a",
      "hp": {
        "current": 32,
        "max": 32
      },
      "ac": 16,
      "speed": 25,
      "initBonus": 0,
      "passivePerception": 9,
      "stats": {
        "str": 16,
        "dex": 10,
        "con": 16,
        "int": 1,
        "wis": 8,
        "cha": 2
      },
      "cr": "2",
      "abilities": "Speed: Walk 25 ft., Fly 20 ft.\nCarrying Capacity: 1 Medium creature or 200 lbs.\n\n• Armoured Shell. Bludgeoning and piercing damage dealt to the Rhinoceros Beetle is reduced by 2.\n• Horn Charge. After moving 20 ft. toward a target: target makes DC 13 Strength save or takes an extra 1d8 piercing and is knocked prone.\n• Horn Strike. Melee Attack: +4 to hit - 1d8+2 piercing.",
      "playerDescription": "Prized as heavy infantry mounts. Their shell makes them practically immune to terrain hazards.",
      "notes": "Neutral | Rideable | Medium | CR 2"
    }
  },
  {
    "id": "bnb:stag_beetle",
    "name": "Stag Beetle",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "Stag Beetle",
      "color": "#8a6a3a",
      "hp": {
        "current": 45,
        "max": 45
      },
      "ac": 15,
      "speed": 20,
      "initBonus": -1,
      "passivePerception": 9,
      "stats": {
        "str": 18,
        "dex": 8,
        "con": 18,
        "int": 1,
        "wis": 8,
        "cha": 2
      },
      "cr": "3",
      "abilities": "Speed: Walk 20 ft., Fly 20 ft.\nCarrying Capacity: 1 Medium creature or 225 lbs.\n\n• Armoured Shell. As Rhinoceros Beetle.\n• Territorial Charge. Advantage on attack rolls if an allied creature is grappling the same target.\n• Mandible Clamp. Melee Attack: +5 to hit - 2d6+3 piercing. Target grappled on hit (escape DC 14). While grappled, the target takes 1d6 piercing at the start of each of its turns.",
      "playerDescription": "A prestige mount. Their gleaming black carapace and enormous mandibles make them powerful symbols of military strength.",
      "notes": "Neutral | Rideable | Medium | CR 3"
    }
  },
  {
    "id": "bnb:bushcricket",
    "name": "Bushcricket",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Bushcricket",
      "color": "#8a6a3a",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 12,
      "speed": 40,
      "initBonus": 4,
      "passivePerception": 10,
      "stats": {
        "str": 8,
        "dex": 18,
        "con": 10,
        "int": 1,
        "wis": 10,
        "cha": 3
      },
      "cr": "1",
      "abilities": "Speed: Walk 30 ft., Jump 40 ft., Fly 20 ft.\nCarrying Capacity: 1 Medium creature or 150 lbs.\n\n• Long Jump. Can leap 40 ft. horizontally or 20 ft. vertically with no running start.\n• Night Song. Emits a chirp audible up to 300 ft. away. Trained riders can use this to relay coded signals.\n• Bite. Melee Attack: +3 to hit - 1d6+1 piercing.",
      "playerDescription": "Common in grassland settlements. Cheap to feed, easy to train, and fast across open meadows.",
      "notes": "Neutral | Rideable | Medium | CR 1"
    }
  },
  {
    "id": "bnb:rose_chafer",
    "name": "Rose Chafer",
    "builtin": true,
    "category": "B&B: Tameable",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Rose Chafer",
      "color": "#8a6a3a",
      "hp": {
        "current": 9,
        "max": 9
      },
      "ac": 13,
      "speed": 25,
      "initBonus": 2,
      "passivePerception": 9,
      "stats": {
        "str": 4,
        "dex": 14,
        "con": 10,
        "int": 1,
        "wis": 8,
        "cha": 6
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 15 ft., Fly 25 ft.\n\n• Pollinator. In areas where Rose Chafers are present, cultivated plants grow at twice the normal rate.\n• Shell Gleam. Yields 1 unit of decorative metallic chitin when harvested.\n• Common in Grasslands. Encountered in swarms of 2d6 in grassland regions.\n• Mandible Nip. Melee Attack: +2 to hit, reach 5 ft. - 1d4 piercing. Used only in self-defence.",
      "playerDescription": "Abundant in the meadows. Their green-gold shimmer is a defining motif in Harefolk art and textile work.",
      "notes": "Neutral | Small | CR 1/2"
    }
  },
  {
    "id": "bnb:common_pipistrelle",
    "name": "Common Pipistrelle",
    "builtin": true,
    "category": "B&B: Bats",
    "cr": "1/8",
    "entity": {
      "type": "Monster",
      "name": "Common Pipistrelle",
      "color": "#5a4a66",
      "hp": {
        "current": 2,
        "max": 2
      },
      "ac": 12,
      "speed": 30,
      "initBonus": 2,
      "passivePerception": 11,
      "stats": {
        "str": 3,
        "dex": 15,
        "con": 8,
        "int": 2,
        "wis": 12,
        "cha": 4
      },
      "cr": "1/8",
      "abilities": "Speed: Walk 5 ft., Fly 30 ft.\n\n• Echolocation. Blindsight 60 ft. Cannot use echolocation while deafened.\n• Keen Hearing. Advantage on Perception checks using hearing.\n• Bite. Melee Attack: +2 to hit, reach 5 ft. - 1d3 piercing.",
      "playerDescription": "",
      "notes": "Flying | Small | CR 1/8"
    }
  },
  {
    "id": "bnb:notch_eared_bat",
    "name": "Notch-Eared Bat",
    "builtin": true,
    "category": "B&B: Bats",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Notch-Eared Bat",
      "color": "#5a4a66",
      "hp": {
        "current": 5,
        "max": 5
      },
      "ac": 12,
      "speed": 30,
      "initBonus": 2,
      "passivePerception": 11,
      "stats": {
        "str": 4,
        "dex": 15,
        "con": 8,
        "int": 2,
        "wis": 12,
        "cha": 4
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 5 ft., Fly 30 ft.\n\n• Echolocation. Blindsight 60 ft.\n• Keen Hearing. Advantage on Perception checks using hearing.\n• Dive Bite. Melee Attack: +3 to hit - 1d4 piercing.",
      "playerDescription": "",
      "notes": "Flying | Small | CR 1/4"
    }
  },
  {
    "id": "bnb:soprano_pipistrelle",
    "name": "Soprano Pipistrelle",
    "builtin": true,
    "category": "B&B: Bats",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Soprano Pipistrelle",
      "color": "#5a4a66",
      "hp": {
        "current": 9,
        "max": 9
      },
      "ac": 12,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 6,
        "dex": 16,
        "con": 10,
        "int": 2,
        "wis": 12,
        "cha": 5
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 5 ft., Fly 35 ft.\n\n• Echolocation. Blindsight 60 ft.\n• Shriek. Once per short rest, emit a high-frequency shriek. Creatures within 20 ft. with hearing make DC 12 Constitution save or are deafened for 1 minute.\n• Bite. Melee Attack: +3 to hit, reach 5 ft. - 1d4 piercing.",
      "playerDescription": "",
      "notes": "Flying | Medium | CR 1/2"
    }
  },
  {
    "id": "bnb:lesser_noctule",
    "name": "Lesser Noctule",
    "builtin": true,
    "category": "B&B: Bats",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Lesser Noctule",
      "color": "#5a4a66",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 8,
        "dex": 16,
        "con": 12,
        "int": 2,
        "wis": 12,
        "cha": 5
      },
      "cr": "1",
      "abilities": "Speed: Walk 5 ft., Fly 40 ft.\n\n• Echolocation. Blindsight 60 ft.\n• Night Hunter. Advantage on attack rolls against flying insects and birds in darkness or dim light.\n• Bite. Melee Attack: +3 to hit - 1d6 piercing.",
      "playerDescription": "",
      "notes": "Flying | Medium | CR 1"
    }
  },
  {
    "id": "bnb:common_noctule",
    "name": "Common Noctule",
    "builtin": true,
    "category": "B&B: Bats",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Common Noctule",
      "color": "#5a4a66",
      "hp": {
        "current": 22,
        "max": 22
      },
      "ac": 13,
      "speed": 45,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 10,
        "dex": 17,
        "con": 12,
        "int": 2,
        "wis": 13,
        "cha": 5
      },
      "cr": "2",
      "abilities": "Speed: Walk 5 ft., Fly 45 ft.\n\n• Echolocation. Blindsight 60 ft.\n• Sonar Pulse. Once per short rest, reveals the exact position of all creatures and objects within 100 ft., including those behind full cover (excluding magical or lead barriers).\n• Bite. Melee Attack: +4 to hit - 1d8+2 piercing.",
      "playerDescription": "",
      "notes": "Flying | Medium | CR 2"
    }
  },
  {
    "id": "bnb:greater_noctule",
    "name": "Greater Noctule",
    "builtin": true,
    "category": "B&B: Bats",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Greater Noctule",
      "color": "#5a4a66",
      "hp": {
        "current": 52,
        "max": 52
      },
      "ac": 14,
      "speed": 50,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 14,
        "dex": 18,
        "con": 14,
        "int": 3,
        "wis": 14,
        "cha": 6
      },
      "cr": "4",
      "abilities": "Speed: Walk 5 ft., Fly 50 ft.\n\n• Echolocation. Blindsight 60 ft.\n• Sonar Pulse. As Common Noctule, range extended to 150 ft.\n• Predatory Swoop. If the Greater Noctule dives 20+ ft. and hits with its bite, the target makes DC 14 Strength save or is grappled and lifted up to 20 ft. into the air.\n• Bite. Melee Attack: +6 to hit - 2d8+4 piercing.",
      "playerDescription": "",
      "notes": "Flying | Medium | CR 4"
    }
  },
  {
    "id": "bnb:garden_spider",
    "name": "Garden Spider",
    "builtin": true,
    "category": "B&B: Spiders",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Garden Spider",
      "color": "#454553",
      "hp": {
        "current": 5,
        "max": 5
      },
      "ac": 12,
      "speed": 25,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 6,
        "dex": 14,
        "con": 8,
        "int": 1,
        "wis": 10,
        "cha": 2
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 25 ft., Climb 25 ft.\n\n• Spider Climb.\n• Web. Ranged Attack (30 ft.): target makes DC 12 Strength save or is restrained. Escape DC 12.\n• Bite. Melee Attack: +3 to hit - 1d4 piercing + 1d4 poison.",
      "playerDescription": "",
      "notes": "Small | CR 1/4"
    }
  },
  {
    "id": "bnb:ladybird_spider",
    "name": "Ladybird Spider",
    "builtin": true,
    "category": "B&B: Spiders",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Ladybird Spider",
      "color": "#454553",
      "hp": {
        "current": 9,
        "max": 9
      },
      "ac": 13,
      "speed": 25,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 6,
        "dex": 15,
        "con": 10,
        "int": 1,
        "wis": 10,
        "cha": 3
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 25 ft., Climb 25 ft.\n\n• Spider Climb.\n• Warning Colouration. Creatures damaged by the bite have disadvantage on Perception checks to notice other Ladybird Spiders within 60 ft. for 1 minute.\n• Venomous Bite. Melee Attack: +3 to hit - 1d4 piercing + 2d4 poison. DC 12 Constitution save or poisoned for 1 hour.",
      "playerDescription": "",
      "notes": "Small | CR 1/2"
    }
  },
  {
    "id": "bnb:wasp_spider",
    "name": "Wasp Spider",
    "builtin": true,
    "category": "B&B: Spiders",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Wasp Spider",
      "color": "#454553",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 13,
      "speed": 30,
      "initBonus": 3,
      "passivePerception": 10,
      "stats": {
        "str": 10,
        "dex": 16,
        "con": 10,
        "int": 1,
        "wis": 10,
        "cha": 2
      },
      "cr": "1",
      "abilities": "Speed: Walk 30 ft., Climb 30 ft.\n\n• Spider Climb.\n• Ambush Web. Creates nearly invisible webs (Perception DC 16). Creatures entering the web are restrained (escape DC 14), and the Wasp Spider has advantage on attacks against restrained targets.\n• Venom Bite. Melee Attack: +4 to hit - 1d6 piercing + 2d6 poison. DC 13 Constitution save or poisoned for 1 hour with speed halved.",
      "playerDescription": "",
      "notes": "Medium | CR 1"
    }
  },
  {
    "id": "bnb:tubeweb_spider",
    "name": "Tubeweb Spider",
    "builtin": true,
    "category": "B&B: Spiders",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Tubeweb Spider",
      "color": "#454553",
      "hp": {
        "current": 27,
        "max": 27
      },
      "ac": 13,
      "speed": 30,
      "initBonus": 3,
      "passivePerception": 10,
      "stats": {
        "str": 12,
        "dex": 16,
        "con": 12,
        "int": 1,
        "wis": 10,
        "cha": 2
      },
      "cr": "2",
      "abilities": "Speed: Walk 30 ft., Climb 30 ft.\n\n• Spider Climb.\n• Tube Ambush. Lurks inside a silk tube. Disturbing the tube entrance triggers an automatic reaction attack with advantage.\n• Venomous Bite. Melee Attack: +5 to hit - 1d8+2 piercing + 3d6 poison. DC 14 Constitution save or incapacitated for 1 minute.",
      "playerDescription": "",
      "notes": "Medium | CR 2"
    }
  },
  {
    "id": "bnb:wolf_spider",
    "name": "Wolf Spider",
    "builtin": true,
    "category": "B&B: Spiders",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "Wolf Spider",
      "color": "#454553",
      "hp": {
        "current": 38,
        "max": 38
      },
      "ac": 14,
      "speed": 40,
      "initBonus": 4,
      "passivePerception": 11,
      "stats": {
        "str": 14,
        "dex": 18,
        "con": 12,
        "int": 2,
        "wis": 12,
        "cha": 3
      },
      "cr": "3",
      "abilities": "Speed: Walk 40 ft., Climb 30 ft.\n\n• Spider Climb.\n• Pounce. After moving 20 ft. toward a target and hitting with its bite, the target makes DC 14 Strength save or is knocked prone. If prone, the Spider makes one additional bite attack as a bonus action.\n• Keen Eyes. Advantage on Perception checks using sight.\n• Bite. Melee Attack: +6 to hit - 2d6+3 piercing + 3d6 poison. DC 14 Constitution save or paralyzed for 1 minute.",
      "playerDescription": "",
      "notes": "Medium | CR 3"
    }
  },
  {
    "id": "bnb:cave_spider",
    "name": "Cave Spider",
    "builtin": true,
    "category": "B&B: Spiders",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Cave Spider",
      "color": "#454553",
      "hp": {
        "current": 75,
        "max": 75
      },
      "ac": 15,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 11,
      "stats": {
        "str": 18,
        "dex": 16,
        "con": 14,
        "int": 3,
        "wis": 12,
        "cha": 4
      },
      "cr": "5",
      "abilities": "Speed: Walk 40 ft., Climb 40 ft.\n\n• Spider Climb.\n• Tremorsense 60 ft.\n• Web Shot. Ranged Attack (60 ft.): DC 15 Strength save or restrained. Web is nearly invisible (Perception DC 18).\n• Cocoon. As an action against a restrained target, wraps it in silk (Strength DC 16 to break free). A cocooned creature falls unconscious after 1 minute without air.\n• Massive Bite. Melee Attack: +7 to hit - 2d10+5 piercing + 4d6 poison. DC 15 Constitution save or paralyzed for 1 hour.",
      "playerDescription": "Cave Spiders hunt deep below Harefolk walls and in root caverns. Their size means a single one can carry away a full-grown Badgerman.",
      "notes": "Large | CR 5"
    }
  },
  {
    "id": "bnb:ladybug",
    "name": "Ladybug",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Ladybug",
      "color": "#6f8a3a",
      "hp": {
        "current": 5,
        "max": 5
      },
      "ac": 13,
      "speed": 20,
      "initBonus": 2,
      "passivePerception": 9,
      "stats": {
        "str": 4,
        "dex": 14,
        "con": 8,
        "int": 1,
        "wis": 8,
        "cha": 3
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 15 ft., Fly 20 ft.\n\n• Warning Colouration. When hit with a melee attack, the attacker makes DC 11 Constitution save or is poisoned (nausea) for 1 round.\n• Mandible Bite. Melee Attack: +3 to hit - 1d4 piercing.",
      "playerDescription": "",
      "notes": "Small | Flying | CR 1/4"
    }
  },
  {
    "id": "bnb:pillbug",
    "name": "Pillbug",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/8",
    "entity": {
      "type": "Monster",
      "name": "Pillbug",
      "color": "#6f8a3a",
      "hp": {
        "current": 3,
        "max": 3
      },
      "ac": 15,
      "speed": 10,
      "initBonus": -1,
      "passivePerception": 8,
      "stats": {
        "str": 4,
        "dex": 8,
        "con": 12,
        "int": 1,
        "wis": 6,
        "cha": 2
      },
      "cr": "1/8",
      "abilities": "Speed: Walk 10 ft.\n\n• Roll Up. As a reaction to taking damage, the Pillbug rolls into a ball, gaining +4 AC until the start of its next turn. While rolled it cannot move or attack.\n• Bite. Melee Attack: +2 to hit - 1d4 piercing.",
      "playerDescription": "",
      "notes": "Small | CR 1/8"
    }
  },
  {
    "id": "bnb:waterscorpion",
    "name": "Waterscorpion",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Waterscorpion",
      "color": "#6f8a3a",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 14,
      "speed": 25,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 10,
        "dex": 14,
        "con": 14,
        "int": 1,
        "wis": 10,
        "cha": 2
      },
      "cr": "1",
      "abilities": "Speed: Walk 10 ft., Swim 25 ft.\n\n• Amphibious.\n• Breathing Siphon. Can remain submerged indefinitely using its natural air tube.\n• Grasping Claws. On hit, target is grappled (escape DC 13).\n• Piercing Beak. Melee Attack: +4 to hit - 1d8+2 piercing + 1d6 poison. DC 13 Constitution save or poisoned for 1 minute.",
      "playerDescription": "",
      "notes": "Small | CR 1"
    }
  },
  {
    "id": "bnb:praying_mantis",
    "name": "Praying Mantis",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "Praying Mantis",
      "color": "#6f8a3a",
      "hp": {
        "current": 45,
        "max": 45
      },
      "ac": 14,
      "speed": 30,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 14,
        "dex": 18,
        "con": 14,
        "int": 2,
        "wis": 14,
        "cha": 4
      },
      "cr": "3",
      "abilities": "Speed: Walk 30 ft., Fly 20 ft.\n\n• Ambush Predator. If the Mantis has not moved this turn, it has advantage on its first attack roll.\n• Devour. Against a grappled target, deals 2d10+3 piercing damage automatically as a bonus action.\n• Lightning Grab. Melee Attack (reach 10 ft.): +5 to hit - 2d6+3 piercing. Target grappled on hit (escape DC 14).",
      "playerDescription": "One of the most feared predators of the forest floor. A Mantis near a grovetowns path is cause for a road closure.",
      "notes": "Monster | Medium | CR 3"
    }
  },
  {
    "id": "bnb:emperor_dragonfly",
    "name": "Emperor Dragonfly",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Emperor Dragonfly",
      "color": "#6f8a3a",
      "hp": {
        "current": 68,
        "max": 68
      },
      "ac": 15,
      "speed": 60,
      "initBonus": 6,
      "passivePerception": 13,
      "stats": {
        "str": 16,
        "dex": 22,
        "con": 18,
        "int": 2,
        "wis": 16,
        "cha": 5
      },
      "cr": "5",
      "abilities": "Speed: Walk 5 ft., Fly 60 ft.\n\n• 360° Vision. Cannot be flanked. Advantage on all Perception checks.\n• Aerial Hunter. Advantage on attack rolls against airborne targets.\n• Compound Burst. Once per short rest, move in a straight line up to full flying speed. Each creature in the path makes DC 15 Dexterity save or takes 3d8 bludgeoning damage.\n• Mandible Strike. Melee Attack: +7 to hit - 2d8+4 piercing.",
      "playerDescription": "An Emperor Dragonfly clearing the air above a settlement is treated as a serious threat requiring immediate mobilisation.",
      "notes": "Monster | Flying | Medium | CR 5"
    }
  },
  {
    "id": "bnb:bumblebee",
    "name": "Bumblebee",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Bumblebee",
      "color": "#6f8a3a",
      "hp": {
        "current": 5,
        "max": 5
      },
      "ac": 12,
      "speed": 30,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 4,
        "dex": 14,
        "con": 8,
        "int": 1,
        "wis": 10,
        "cha": 4
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 10 ft., Fly 30 ft.\n\n• Hive Alarm. If within 60 ft. of a hive and threatened, releases alarm pheromone. 2d6 additional Bumblebees arrive at the start of its next turn.\n• Sting. Melee Attack: +3 to hit - 1d4 piercing + 1d4 poison. DC 11 Constitution save or poisoned for 1 minute. Can sting multiple times.",
      "playerDescription": "",
      "notes": "Small | Flying | CR 1/4"
    }
  },
  {
    "id": "bnb:honeybee",
    "name": "Honeybee",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/8",
    "entity": {
      "type": "Monster",
      "name": "Honeybee",
      "color": "#6f8a3a",
      "hp": {
        "current": 2,
        "max": 2
      },
      "ac": 12,
      "speed": 30,
      "initBonus": 1,
      "passivePerception": 10,
      "stats": {
        "str": 2,
        "dex": 13,
        "con": 6,
        "int": 1,
        "wis": 10,
        "cha": 4
      },
      "cr": "1/8",
      "abilities": "Speed: Walk 10 ft., Fly 30 ft.\n\n• Sting and Die. The Honeybee can only sting once, then dies at the start of its next turn.\n• Hive Alarm. As Bumblebee.\n• Sting. Melee Attack: +2 to hit - 1d4 piercing + 1d6 poison. DC 12 Constitution save or poisoned, taking 1d4 poison damage each turn (DC 12 each turn to end).",
      "playerDescription": "",
      "notes": "Small | Flying | CR 1/8"
    }
  },
  {
    "id": "bnb:yellow_jacket",
    "name": "Yellow Jacket",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Yellow Jacket",
      "color": "#6f8a3a",
      "hp": {
        "current": 9,
        "max": 9
      },
      "ac": 13,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 10,
      "stats": {
        "str": 4,
        "dex": 16,
        "con": 8,
        "int": 1,
        "wis": 10,
        "cha": 3
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 10 ft., Fly 35 ft.\n\n• Aggressive. Attacks any creature that enters 30 ft. of its nest and pursues until the creature leaves or the Yellow Jacket is killed.\n• Nest Swarm. If killed near a nest, 1d6 Yellow Jackets emerge immediately.\n• Multi-Sting. Can sting up to 3 times in one action (+3 to hit each; 1d4 piercing + 1d6 poison per sting).",
      "playerDescription": "",
      "notes": "Small | Flying | CR 1/2"
    }
  },
  {
    "id": "bnb:hornet",
    "name": "Hornet",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Hornet",
      "color": "#6f8a3a",
      "hp": {
        "current": 27,
        "max": 27
      },
      "ac": 14,
      "speed": 40,
      "initBonus": 4,
      "passivePerception": 11,
      "stats": {
        "str": 8,
        "dex": 18,
        "con": 10,
        "int": 1,
        "wis": 12,
        "cha": 4
      },
      "cr": "2",
      "abilities": "Speed: Walk 10 ft., Fly 40 ft.\n\n• Nest Fury. Hornets within 60 ft. of their nest deal an extra 1d6 poison on all sting attacks.\n• Aerial Assault. If two or more Hornets attack the same target in one round, the target has disadvantage on Constitution saves against their venom.\n• Venom Sting. Melee Attack: +4 to hit - 1d8+2 piercing + 2d6 poison. DC 13 Constitution save or poisoned for 1 hour. On a save failure by 5 or more, the target takes 1d6 poison at the start of each turn until a save is made.",
      "playerDescription": "A Hornet nest above a grovetowns pathway can close the route for an entire season.",
      "notes": "Monster | Flying | Medium | CR 2"
    }
  },
  {
    "id": "bnb:mole_cricket",
    "name": "Mole Cricket",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Mole Cricket",
      "color": "#6f8a3a",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 13,
      "speed": 25,
      "initBonus": 2,
      "passivePerception": 10,
      "stats": {
        "str": 10,
        "dex": 14,
        "con": 12,
        "int": 1,
        "wis": 10,
        "cha": 3
      },
      "cr": "1",
      "abilities": "Speed: Walk 25 ft., Burrow 15 ft., Fly 20 ft.\n\n• Burrow Ambush. Can burrow as a bonus action and resurface adjacent to a target, making one attack with advantage.\n• Chirp Alarm. Emits a chirp audible 300 ft. away when threatened.\n• Forelegs Strike. Melee Attack: +3 to hit - 1d6+1 slashing.",
      "playerDescription": "Prefers grassland environments.",
      "notes": "Medium | CR 1"
    }
  },
  {
    "id": "bnb:six_spot_burnet",
    "name": "Six-Spot Burnet",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Six-Spot Burnet",
      "color": "#6f8a3a",
      "hp": {
        "current": 5,
        "max": 5
      },
      "ac": 12,
      "speed": 25,
      "initBonus": 1,
      "passivePerception": 9,
      "stats": {
        "str": 2,
        "dex": 12,
        "con": 8,
        "int": 1,
        "wis": 8,
        "cha": 4
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 10 ft., Fly 25 ft.\n\n• Warning Colouration. Any creature that kills or eats a Six-Spot Burnet makes DC 12 Constitution save or is poisoned for 1 hour.\n• Iridescent Wings. Advantage on Stealth checks in bright, sunny meadow environments.\n• Proboscis Bite. Melee Attack: +2 to hit, reach 5 ft. - 1 piercing. Used only in desperation. On hit, target makes DC 11 Constitution save or is sickened (disadvantage on one attack of your choice before end of their next turn).",
      "playerDescription": "",
      "notes": "Flying | Small | CR 1/4"
    }
  },
  {
    "id": "bnb:mimic_hoverfly",
    "name": "Mimic Hoverfly",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/8",
    "entity": {
      "type": "Monster",
      "name": "Mimic Hoverfly",
      "color": "#6f8a3a",
      "hp": {
        "current": 2,
        "max": 2
      },
      "ac": 12,
      "speed": 30,
      "initBonus": 2,
      "passivePerception": 9,
      "stats": {
        "str": 2,
        "dex": 14,
        "con": 6,
        "int": 1,
        "wis": 8,
        "cha": 6
      },
      "cr": "1/8",
      "abilities": "Speed: Walk 5 ft., Fly 30 ft.\n\n• Wasp Mimic. Creatures with Intelligence 6 or lower treat the Mimic Hoverfly as a Yellow Jacket and will not approach within 10 ft. Creatures with Intelligence 7+ may make DC 13 Nature check to identify it as harmless.\n• Desperate Nip. Melee Attack: +2 to hit, reach 5 ft. - 1 piercing. The Mimic Hoverfly only attacks as a last resort when cornered and has exhausted all escape options. It immediately attempts to flee after attacking.",
      "playerDescription": "",
      "notes": "Flying | Small | CR 1/8"
    }
  },
  {
    "id": "bnb:pine_weevil",
    "name": "Pine Weevil",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "1/4",
    "entity": {
      "type": "Monster",
      "name": "Pine Weevil",
      "color": "#6f8a3a",
      "hp": {
        "current": 1,
        "max": 1
      },
      "ac": 10,
      "speed": 20,
      "initBonus": 1,
      "passivePerception": 9,
      "stats": {
        "str": 6,
        "dex": 12,
        "con": 10,
        "int": 1,
        "wis": 8,
        "cha": 2
      },
      "cr": "1/4",
      "abilities": "Speed: Walk 20 ft., Climb 20 ft.\n\n• Swarm Behaviour. Always encountered in groups of 2d6+2. If more than half are killed, the remainder scatter and flee.\n• Wood Scent. Advantage on Perception checks to locate living wood, processed timber, or wooden structures.\n• Gnaw. Melee Attack: +2 to hit - 1d4 piercing. Against wooden objects or structures, this damage bypasses hardness.",
      "playerDescription": "A catastrophic pest. A Pine Weevil infestation in a family tree can condemn an entire home.",
      "notes": "Small | CR 1/4"
    }
  },
  {
    "id": "bnb:leech",
    "name": "Leech",
    "builtin": true,
    "category": "B&B: Insects",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Leech",
      "color": "#6f8a3a",
      "hp": {
        "current": 22,
        "max": 22
      },
      "ac": 11,
      "speed": 25,
      "initBonus": -1,
      "passivePerception": 9,
      "stats": {
        "str": 12,
        "dex": 8,
        "con": 14,
        "int": 1,
        "wis": 8,
        "cha": 2
      },
      "cr": "2",
      "abilities": "Speed: Walk 10 ft., Swim 25 ft.\n\n• Blood Drain. While attached (grappling), drains 1d6 HP from the target at the start of each of its turns, healing itself by the same amount.\n• Numbing Saliva. The initial bite target must make DC 13 Perception check to notice the attachment - pain is suppressed for 1 minute.\n• Latch On. Melee Attack: +4 to hit - 1d4 piercing. On hit, the Leech latches on (grapple; escape DC 13). While latched, it cannot be targeted separately without also hitting the host.",
      "playerDescription": "A particular menace in the riverlands. Ottermen and Castormen check each other thoroughly after any time in the water.",
      "notes": "Medium | CR 2"
    }
  },
  {
    "id": "bnb:jay",
    "name": "Jay",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Jay",
      "color": "#5a7fa6",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 12,
      "speed": 35,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 8,
        "dex": 16,
        "con": 10,
        "int": 6,
        "wis": 14,
        "cha": 8
      },
      "cr": "1",
      "abilities": "Speed: Walk 15 ft., Fly 35 ft.\n\n• Alarm Call. When a Jay spots a threat, it emits a shrieking alarm call audible 500 ft. away. No surprise is possible in the vicinity for 10 minutes.\n• Acorn Memory. A Jay knows the precise location of every food cache it has made within 1 mile.\n• Beak Strike. Melee Attack: +3 to hit - 1d6 piercing.",
      "playerDescription": "",
      "notes": "Medium | Flying | CR 1"
    }
  },
  {
    "id": "bnb:jackdaw",
    "name": "Jackdaw",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Jackdaw",
      "color": "#5a7fa6",
      "hp": {
        "current": 27,
        "max": 27
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 8,
        "dex": 16,
        "con": 10,
        "int": 8,
        "wis": 14,
        "cha": 9
      },
      "cr": "2",
      "abilities": "Speed: Walk 15 ft., Fly 40 ft.\n\n• Shiny Thief. Steals any small unattended metal or reflective object it can see (Sleight of Hand +5 vs. passive Perception of the nearest observer).\n• Mob Attack. A Jackdaw within 60 ft. of another Jackdaw deals an extra 1d6 damage on all attacks.\n• Beak Strike. Melee Attack: +4 to hit - 1d8+2 piercing.",
      "playerDescription": "Jackdaws have stolen a Grovetowns chieftain's ceremonial brooch mid-ceremony. This is widely reported as fact.",
      "notes": "Medium | Flying | CR 2"
    }
  },
  {
    "id": "bnb:magpie",
    "name": "Magpie",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "Magpie",
      "color": "#5a7fa6",
      "hp": {
        "current": 38,
        "max": 38
      },
      "ac": 14,
      "speed": 40,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 10,
        "dex": 18,
        "con": 12,
        "int": 10,
        "wis": 14,
        "cha": 11
      },
      "cr": "3",
      "abilities": "Speed: Walk 15 ft., Fly 40 ft.\n\n• Cunning Action. Can Dash, Disengage, or Hide as a bonus action.\n• Mirror Trick. Once per short rest, uses its reflective plumage as a distraction. One creature within 30 ft. makes DC 14 Wisdom save or has disadvantage on Perception checks until the end of its next turn.\n• Beak and Claw. Melee Attack: +5 to hit - 2d6+3 piercing/slashing.",
      "playerDescription": "",
      "notes": "Medium | Flying | CR 3"
    }
  },
  {
    "id": "bnb:crow",
    "name": "Crow",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Crow",
      "color": "#5a7fa6",
      "hp": {
        "current": 52,
        "max": 52
      },
      "ac": 14,
      "speed": 45,
      "initBonus": 4,
      "passivePerception": 13,
      "stats": {
        "str": 12,
        "dex": 18,
        "con": 14,
        "int": 12,
        "wis": 16,
        "cha": 12
      },
      "cr": "4",
      "abilities": "Speed: Walk 15 ft., Fly 45 ft.\n\n• Tool Use. Wields simple objects as improvised weapons (+4 to hit, 1d6 bludgeoning).\n• Problem Solver. Advantage on Intelligence checks involving puzzles, locks, or mechanical devices.\n• Vengeful Memory. Never forgets a creature that harmed it. Advantage on attacks against remembered targets.\n• Beak and Claw. Melee Attack: +6 to hit - 2d8+4 piercing/slashing.",
      "playerDescription": "",
      "notes": "Medium | Flying | CR 4"
    }
  },
  {
    "id": "bnb:raven_wild",
    "name": "Raven (Wild)",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "8",
    "entity": {
      "type": "Monster",
      "name": "Raven (Wild)",
      "color": "#5a7fa6",
      "hp": {
        "current": 120,
        "max": 120
      },
      "ac": 16,
      "speed": 50,
      "initBonus": 3,
      "passivePerception": 14,
      "stats": {
        "str": 20,
        "dex": 16,
        "con": 18,
        "int": 14,
        "wis": 18,
        "cha": 16
      },
      "cr": "8",
      "abilities": "Speed: Walk 10 ft., Fly 50 ft.\n\n• Hinterland Aura. Creatures within 30 ft. of a Wild Raven have disadvantage on saves against fear effects.\n• Omen Call. Once per day, emits a call that functions as a bane spell (DC 16, up to 3 creatures within 60 ft.).\n• Beak Strike. Melee Attack: +10 to hit - 3d10+6 piercing.\n• Wing Slam. Melee Attack: +10 to hit, reach 10 ft. - 2d8+6 bludgeoning. Target makes DC 16 Strength save or is knocked prone.",
      "playerDescription": "Wild Ravens are dangerous, deeply unsettling, and poorly understood. The Ravenfolk refuse to discuss their relationship to them.",
      "notes": "Large | Flying | CR 8"
    }
  },
  {
    "id": "bnb:sparrowhawk",
    "name": "Sparrowhawk",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Sparrowhawk",
      "color": "#5a7fa6",
      "hp": {
        "current": 68,
        "max": 68
      },
      "ac": 15,
      "speed": 55,
      "initBonus": 5,
      "passivePerception": 13,
      "stats": {
        "str": 14,
        "dex": 20,
        "con": 18,
        "int": 4,
        "wis": 16,
        "cha": 8
      },
      "cr": "5",
      "abilities": "Speed: Walk 10 ft., Fly 55 ft.\n\n• Keen Sight. Advantage on Perception checks using sight.\n• Flyby. Does not provoke opportunity attacks when flying out of reach.\n• Stoop. After diving 30+ ft. in a straight line, deals 3d8+4 piercing and target makes DC 15 Strength save or is knocked prone and grappled.\n• Talon Strike. Melee Attack: +7 to hit - 2d8+4 piercing.",
      "playerDescription": "",
      "notes": "Medium | Flying | CR 5"
    }
  },
  {
    "id": "bnb:red_kite",
    "name": "Red Kite",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "6",
    "entity": {
      "type": "Monster",
      "name": "Red Kite",
      "color": "#5a7fa6",
      "hp": {
        "current": 91,
        "max": 91
      },
      "ac": 15,
      "speed": 55,
      "initBonus": 5,
      "passivePerception": 13,
      "stats": {
        "str": 16,
        "dex": 20,
        "con": 18,
        "int": 5,
        "wis": 16,
        "cha": 8
      },
      "cr": "6",
      "abilities": "Speed: Walk 10 ft., Fly 55 ft.\n\n• Thermal Rider. Can hover without spending movement. Advantage on Perception checks while airborne.\n• Screech. Once per short rest, emit a piercing cry. Creatures within 40 ft. make DC 15 Wisdom save or are frightened for 1 minute.\n• Talon Strike. Melee Attack: +8 to hit - 2d10+5 slashing. Grappled on hit (escape DC 16).",
      "playerDescription": "",
      "notes": "Medium | Flying | CR 6"
    }
  },
  {
    "id": "bnb:kestrel",
    "name": "Kestrel",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "7",
    "entity": {
      "type": "Monster",
      "name": "Kestrel",
      "color": "#5a7fa6",
      "hp": {
        "current": 110,
        "max": 110
      },
      "ac": 16,
      "speed": 60,
      "initBonus": 6,
      "passivePerception": 14,
      "stats": {
        "str": 18,
        "dex": 22,
        "con": 18,
        "int": 5,
        "wis": 18,
        "cha": 8
      },
      "cr": "7",
      "abilities": "Speed: Walk 10 ft., Fly 60 ft.\n\n• Hover. Can remain in place in the air without altitude loss or movement cost.\n• UV Vision. Can see ultraviolet light - tracks urine trails of prey. Advantage on Perception and Survival checks to track living creatures.\n• Devastating Stoop. Once per short rest, after hovering for at least 1 full round: dive in a 5 ft. wide, 60 ft. long line. Creatures in the path make DC 16 Dexterity save or take 4d10+5 piercing damage (half on save).\n• Talon Strike. Melee Attack: +9 to hit - 3d8+5 piercing.",
      "playerDescription": "",
      "notes": "Large | Flying | CR 7"
    }
  },
  {
    "id": "bnb:pine_marten",
    "name": "Pine Marten",
    "builtin": true,
    "category": "B&B: Wild Birds",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Pine Marten",
      "color": "#5a7fa6",
      "hp": {
        "current": 68,
        "max": 68
      },
      "ac": 14,
      "speed": 40,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 18,
        "dex": 18,
        "con": 16,
        "int": 5,
        "wis": 14,
        "cha": 8
      },
      "cr": "5",
      "abilities": "Speed: Walk 40 ft., Climb 40 ft.\n\n• Tree Runner. No movement penalty while climbing. Runs along branches as open terrain.\n• Drop Pounce. If dropping onto a target from 10 ft. or higher, attacks with advantage. Target makes DC 15 Strength save or is knocked prone and grappled.\n• Ferocious Bite. Melee Attack: +7 to hit - 2d10+4 piercing.",
      "playerDescription": "A single Pine Marten near a Weaslie pod village can force full relocation of 200 folk overnight.",
      "notes": "Large | CR 5"
    }
  },
  {
    "id": "bnb:adder",
    "name": "Adder",
    "builtin": true,
    "category": "B&B: Reptiles",
    "cr": "3",
    "entity": {
      "type": "Monster",
      "name": "Adder",
      "color": "#4f8a5a",
      "hp": {
        "current": 38,
        "max": 38
      },
      "ac": 14,
      "speed": 30,
      "initBonus": 4,
      "passivePerception": 12,
      "stats": {
        "str": 10,
        "dex": 18,
        "con": 14,
        "int": 2,
        "wis": 14,
        "cha": 4
      },
      "cr": "3",
      "abilities": "Speed: Walk 30 ft., Swim 20 ft.\n\n• Heat Sense. Blindsight 30 ft. based on body heat.\n• Camouflage. Advantage on Stealth checks in natural environments.\n• Venomous Bite. Melee Attack: +5 to hit - 1d6+2 piercing + 3d6 poison. DC 14 Constitution save or poisoned for 1 hour, taking 1d6 poison at the start of each turn (DC 14 each turn to end).",
      "playerDescription": "",
      "notes": "Medium | CR 3"
    }
  },
  {
    "id": "bnb:natterjack_toad",
    "name": "Natterjack Toad",
    "builtin": true,
    "category": "B&B: Reptiles",
    "cr": "1/2",
    "entity": {
      "type": "Monster",
      "name": "Natterjack Toad",
      "color": "#4f8a5a",
      "hp": {
        "current": 9,
        "max": 9
      },
      "ac": 12,
      "speed": 20,
      "initBonus": 0,
      "passivePerception": 10,
      "stats": {
        "str": 8,
        "dex": 10,
        "con": 12,
        "int": 1,
        "wis": 10,
        "cha": 5
      },
      "cr": "1/2",
      "abilities": "Speed: Walk 20 ft., Swim 15 ft.\n\n• Amphibious.\n• Toxic Skin. Any creature that bites or grapples a Natterjack makes DC 12 Constitution save or is poisoned for 1 hour.\n• Croak Alarm. Emits an unusually loud croak audible 300 ft. away.\n• Tongue Lash. Melee Attack: +2 to hit, reach 10 ft. - 1d4 bludgeoning. On hit, the target is pulled 5 ft. closer to the Natterjack.",
      "playerDescription": "",
      "notes": "Medium | CR 1/2"
    }
  },
  {
    "id": "bnb:sand_lizard",
    "name": "Sand Lizard",
    "builtin": true,
    "category": "B&B: Reptiles",
    "cr": "1",
    "entity": {
      "type": "Monster",
      "name": "Sand Lizard",
      "color": "#4f8a5a",
      "hp": {
        "current": 16,
        "max": 16
      },
      "ac": 13,
      "speed": 30,
      "initBonus": 2,
      "passivePerception": 11,
      "stats": {
        "str": 8,
        "dex": 14,
        "con": 12,
        "int": 2,
        "wis": 12,
        "cha": 4
      },
      "cr": "1",
      "abilities": "Speed: Walk 30 ft., Burrow 15 ft.\n\n• Burrowing Retreat. Can burrow into sand or loose soil as a bonus action, becoming fully hidden (Stealth +8 while burrowed).\n• Territorial Display. Once per short rest, perform a threat display. Creatures within 15 ft. make DC 12 Wisdom save or are frightened for 1 round.\n• Bite. Melee Attack: +3 to hit - 1d6+1 piercing.\n• Tail Slam. Melee Attack: +3 to hit, reach 10 ft. - 1d6 bludgeoning. DC 12 Strength save or knocked prone.",
      "playerDescription": "Earth and land-based attacks.",
      "notes": "Medium | CR 1"
    }
  },
  {
    "id": "bnb:fire_salamander",
    "name": "Fire Salamander",
    "builtin": true,
    "category": "B&B: Reptiles",
    "cr": "2",
    "entity": {
      "type": "Monster",
      "name": "Fire Salamander",
      "color": "#4f8a5a",
      "hp": {
        "current": 27,
        "max": 27
      },
      "ac": 13,
      "speed": 25,
      "initBonus": 1,
      "passivePerception": 10,
      "stats": {
        "str": 10,
        "dex": 12,
        "con": 14,
        "int": 2,
        "wis": 10,
        "cha": 6
      },
      "cr": "2",
      "abilities": "Speed: Walk 25 ft., Swim 20 ft.\n\n• Amphibious.\n• Immune to Fire.\n• Toxin Burst. Once per short rest, secretes toxin in a 10 ft. burst. DC 13 Constitution save or take 2d8 poison damage and be poisoned for 1 minute.\n• Fire Spit. Ranged Attack (30 ft.): +4 to hit - 2d8+2 fire damage.",
      "playerDescription": "Fire-based attacks.",
      "notes": "Medium | CR 2"
    }
  },
  {
    "id": "bnb:roe_deer",
    "name": "Roe Deer",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Roe Deer",
      "color": "#9a7b4f",
      "hp": {
        "current": 95,
        "max": 95
      },
      "ac": 13,
      "speed": 50,
      "initBonus": 2,
      "passivePerception": 11,
      "stats": {
        "str": 22,
        "dex": 14,
        "con": 16,
        "int": 2,
        "wis": 12,
        "cha": 6
      },
      "cr": "4",
      "abilities": "Speed: Walk 50 ft.\n\n• Skittish. When taking damage from an unseen source, makes DC 14 Wisdom save or spends its next turn dashing away.\n• Antler Charge (Males only). After moving 30 ft. straight toward a target: DC 14 Strength save or take 2d8+6 bludgeoning and be knocked prone.\n• Hooves. Melee Attack: +8 to hit - 2d8+6 bludgeoning.",
      "playerDescription": "",
      "notes": "Huge | Rideable | CR 4"
    }
  },
  {
    "id": "bnb:fallow_deer",
    "name": "Fallow Deer",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Fallow Deer",
      "color": "#9a7b4f",
      "hp": {
        "current": 126,
        "max": 126
      },
      "ac": 13,
      "speed": 50,
      "initBonus": 2,
      "passivePerception": 11,
      "stats": {
        "str": 24,
        "dex": 14,
        "con": 18,
        "int": 2,
        "wis": 12,
        "cha": 6
      },
      "cr": "5",
      "abilities": "Speed: Walk 50 ft.\n\n• Broad Antlers (Males only). Antler attacks have reach 10 ft.\n• Skittish.\n• Antler Sweep. Melee Attack (reach 10 ft.): +9 to hit - 3d8+7 bludgeoning. DC 15 Strength save or knocked prone.\n• Hooves. Melee Attack: +9 to hit - 2d10+7 bludgeoning.",
      "playerDescription": "",
      "notes": "Huge | Rideable | CR 5"
    }
  },
  {
    "id": "bnb:red_deer",
    "name": "Red Deer",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "8",
    "entity": {
      "type": "Monster",
      "name": "Red Deer",
      "color": "#9a7b4f",
      "hp": {
        "current": 198,
        "max": 198
      },
      "ac": 14,
      "speed": 50,
      "initBonus": 1,
      "passivePerception": 11,
      "stats": {
        "str": 28,
        "dex": 12,
        "con": 22,
        "int": 2,
        "wis": 12,
        "cha": 8
      },
      "cr": "8",
      "abilities": "Speed: Walk 50 ft.\n\n• Canopy Rake. When the Red Deer passes beneath forest cover, creatures and objects in the 15 ft. above it are struck by its antlers. Any creature caught makes DC 17 Dexterity save or takes 2d10+9 bludgeoning damage.\n• Thundering Charge. Move 40 ft. in a line. All creatures in the path make DC 17 Strength save or take 3d12+9 bludgeoning and be knocked prone and stunned until the end of their next turn.\n• Antler Sweep. Melee Attack (reach 15 ft.): +11 to hit - 4d8+9 bludgeoning. DC 17 Strength save or knocked prone.\n• Hooves. Melee Attack: +11 to hit - 3d10+9 bludgeoning.",
      "playerDescription": "A Red Deer's antlers are visible from half a mile away. The sight of one moving with purpose is said to be the last thing many settlements ever remember clearly.",
      "notes": "Gargantuan | Rideable | CR 8"
    }
  },
  {
    "id": "bnb:feral_goat",
    "name": "Feral Goat",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Feral Goat",
      "color": "#9a7b4f",
      "hp": {
        "current": 105,
        "max": 105
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 20,
        "dex": 16,
        "con": 18,
        "int": 3,
        "wis": 14,
        "cha": 6
      },
      "cr": "4",
      "abilities": "Speed: Walk 40 ft., Climb 35 ft.\n\n• Mountain Footing. Ignores difficult terrain caused by rocky, uneven, or steep surfaces.\n• Headbutt Charge. Move 20 ft. then attack: DC 14 Strength save or take 2d8+5 bludgeoning and be knocked prone.\n• Hooves. Melee Attack: +7 to hit - 2d6+5 bludgeoning.",
      "playerDescription": "",
      "notes": "Huge | Rideable | CR 4"
    }
  },
  {
    "id": "bnb:ibex",
    "name": "Ibex",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Ibex",
      "color": "#9a7b4f",
      "hp": {
        "current": 126,
        "max": 126
      },
      "ac": 14,
      "speed": 40,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 22,
        "dex": 16,
        "con": 20,
        "int": 3,
        "wis": 14,
        "cha": 7
      },
      "cr": "5",
      "abilities": "Speed: Walk 40 ft., Climb 40 ft.\n\n• Mountain Footing.\n• Pin. On a critical hit with its horn attack, the target is also grappled (pinned to the ground if prone).\n• Horn Charge. Move 30 ft. in a line: DC 15 Strength save or take 3d8+6 piercing and be knocked prone.\n• Hooves. Melee Attack: +8 to hit - 2d8+6 bludgeoning.",
      "playerDescription": "",
      "notes": "Huge | Rideable | CR 5"
    }
  },
  {
    "id": "bnb:reindeer",
    "name": "Reindeer",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "5",
    "entity": {
      "type": "Monster",
      "name": "Reindeer",
      "color": "#9a7b4f",
      "hp": {
        "current": 126,
        "max": 126
      },
      "ac": 13,
      "speed": 50,
      "initBonus": 2,
      "passivePerception": 12,
      "stats": {
        "str": 22,
        "dex": 14,
        "con": 20,
        "int": 3,
        "wis": 14,
        "cha": 8
      },
      "cr": "5",
      "abilities": "Speed: Walk 50 ft., Swim 25 ft.\n\n• Cold Endurance. Resistance to cold damage. Advantage on Constitution saves against cold weather exhaustion.\n• Both Sexes Antlered. Both males and females can use antler attacks.\n• Antler Charge. Move 30 ft. in a line: DC 15 Strength save or take 2d12+6 bludgeoning and be knocked prone.\n• Hooves. Melee Attack: +8 to hit - 2d10+6 bludgeoning.",
      "playerDescription": "",
      "notes": "Huge | Rideable | CR 5"
    }
  },
  {
    "id": "bnb:swine",
    "name": "Swine",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "6",
    "entity": {
      "type": "Monster",
      "name": "Swine",
      "color": "#9a7b4f",
      "hp": {
        "current": 150,
        "max": 150
      },
      "ac": 13,
      "speed": 40,
      "initBonus": 1,
      "passivePerception": 10,
      "stats": {
        "str": 24,
        "dex": 12,
        "con": 22,
        "int": 3,
        "wis": 10,
        "cha": 5
      },
      "cr": "6",
      "abilities": "Speed: Walk 40 ft.\n\n• Relentless (Recharges on Short/Long Rest). When reduced to 0 HP but not killed outright, drops to 1 HP instead.\n• Keen Smell. Advantage on Perception checks using smell.\n• Tusk Charge. Move 20 ft. in a line: DC 16 Strength save or take 3d8+7 piercing and be knocked prone.\n• Tusks. Melee Attack: +9 to hit - 3d8+7 piercing.",
      "playerDescription": "Of all the ungulates, Swine are the most likely to investigate rather than flee. This makes them uniquely terrifying. At least a Deer runs away.",
      "notes": "Huge | CR 6"
    }
  },
  {
    "id": "bnb:horse",
    "name": "Horse",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "7",
    "entity": {
      "type": "Monster",
      "name": "Horse",
      "color": "#9a7b4f",
      "hp": {
        "current": 165,
        "max": 165
      },
      "ac": 14,
      "speed": 60,
      "initBonus": 2,
      "passivePerception": 11,
      "stats": {
        "str": 26,
        "dex": 14,
        "con": 22,
        "int": 3,
        "wis": 12,
        "cha": 8
      },
      "cr": "7",
      "abilities": "Speed: Walk 60 ft.\n\n• Hooves of Thunder. When the Horse takes the Dash action, all creatures within 10 ft. of its path make DC 17 Strength save or take 3d8+8 bludgeoning and be knocked prone.\n• Warhorse Training (if tamed and trained). No longer makes Wisdom saves when entering combat.\n• Hooves. Melee Attack: +10 to hit, reach 5 ft. - 3d10+8 bludgeoning.",
      "playerDescription": "A Horse at full gallop is audible from two miles away. The ground shakes. There is no wall built by the folk that has ever successfully stopped one.",
      "notes": "Gargantuan | Rideable | CR 7"
    }
  },
  {
    "id": "bnb:bison",
    "name": "Bison",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "11",
    "entity": {
      "type": "Monster",
      "name": "Bison",
      "color": "#9a7b4f",
      "hp": {
        "current": 234,
        "max": 234
      },
      "ac": 15,
      "speed": 50,
      "initBonus": 0,
      "passivePerception": 10,
      "stats": {
        "str": 30,
        "dex": 10,
        "con": 28,
        "int": 2,
        "wis": 10,
        "cha": 6
      },
      "cr": "11",
      "abilities": "Speed: Walk 50 ft.\n\n• Stampede. Once per short rest, charges in a straight line up to 50 ft. Every creature in its path makes DC 20 Strength save or takes 4d12+10 bludgeoning and is knocked prone and stunned until the end of its next turn.\n• Massive Frame. Attempts to push, shove, or knock the Bison prone are made with disadvantage. The Bison cannot be moved by any effect that would move a creature of its size or smaller.\n• Gore. Melee Attack: +12 to hit, reach 5 ft. - 4d10+10 piercing.\n• Trample. Against a prone target: +12 to hit - 4d12+10 bludgeoning.",
      "playerDescription": "The Skantz keep full memorial songs dedicated to the last time a Bison walked through a settlement. There are seventeen such songs. The settlements in question are no longer on any map.",
      "notes": "Gargantuan | CR 11"
    }
  },
  {
    "id": "bnb:brown_bear",
    "name": "Brown Bear",
    "builtin": true,
    "category": "B&B: Ungulates",
    "cr": "10",
    "entity": {
      "type": "Monster",
      "name": "Brown Bear",
      "color": "#9a7b4f",
      "hp": {
        "current": 210,
        "max": 210
      },
      "ac": 15,
      "speed": 40,
      "initBonus": 1,
      "passivePerception": 12,
      "stats": {
        "str": 28,
        "dex": 12,
        "con": 24,
        "int": 4,
        "wis": 14,
        "cha": 8
      },
      "cr": "10",
      "abilities": "Speed: Walk 40 ft., Swim 30 ft., Climb 30 ft.\n\n• Keen Smell. Advantage on Perception checks using smell.\n• Frightful Presence. Any creature of Medium size or smaller that starts its turn within 60 ft. of the Bear and can see it makes DC 18 Wisdom save or is frightened until the start of its next turn. On a success, the creature is immune to this effect for 24 hours.\n• Multiattack. Makes one Bite and two Claw attacks per turn.\n• Bite. Melee Attack: +11 to hit - 3d10+9 piercing.\n• Claws. Melee Attack: +11 to hit - 2d12+9 slashing. On a critical hit, the target is grappled (escape DC 19).",
      "playerDescription": "The most feared creature outside the Hinterlands. A Brown Bear's approach is treated as a catastrophe requiring total mobilisation. The Ravenfolk are said to track Bear movements carefully - and not for the folk's protection.",
      "notes": "Gargantuan | CR 10"
    }
  },
  {
    "id": "bnb:lupulella_wolf",
    "name": "Lupulella (Wolf)",
    "builtin": true,
    "category": "B&B: Carnivores",
    "cr": "4",
    "entity": {
      "type": "Monster",
      "name": "Lupulella (Wolf)",
      "color": "#8a5236",
      "hp": {
        "current": 52,
        "max": 52
      },
      "ac": 14,
      "speed": 50,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 18,
        "dex": 16,
        "con": 14,
        "int": 4,
        "wis": 14,
        "cha": 8
      },
      "cr": "4",
      "abilities": "Speed: Walk 50 ft.\n\n• Pack Tactics. Advantage on attack rolls if an ally is adjacent to the target.\n• Keen Senses. Advantage on Perception checks using hearing and smell.\n• Rallying Howl. Once per short rest, emit a howl audible 1 mile away. All allied wolves within 500 ft. converge on this location over the next 1d4 rounds.\n• Bite. Melee Attack: +6 to hit - 2d10+4 piercing. Target makes DC 14 Strength save or is knocked prone.",
      "playerDescription": "Lupulella packs are one of the primary threats to settled life in the borderlands between biomes.",
      "notes": "Monster | Large | CR 4"
    }
  },
  {
    "id": "bnb:lupus_wolf",
    "name": "Lupus (Wolf)",
    "builtin": true,
    "category": "B&B: Carnivores",
    "cr": "6",
    "entity": {
      "type": "Monster",
      "name": "Lupus (Wolf)",
      "color": "#8a5236",
      "hp": {
        "current": 91,
        "max": 91
      },
      "ac": 15,
      "speed": 50,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 20,
        "dex": 16,
        "con": 16,
        "int": 5,
        "wis": 14,
        "cha": 8
      },
      "cr": "6",
      "abilities": "Speed: Walk 50 ft.\n\n• Pack Tactics.\n• Keen Senses.\n• Coordinated Takedown. If two or more Lupus wolves attack the same target in one round, the target makes DC 16 Strength save at the end of the round or is knocked prone and grappled by one of the wolves.\n• Dreadful Howl. Once per short rest, all creatures within 60 ft. make DC 15 Wisdom save or are frightened for 1 minute.\n• Bite. Melee Attack: +8 to hit - 3d10+5 piercing. Target DC 16 Strength save or knocked prone.",
      "playerDescription": "",
      "notes": "Monster | Large | CR 6"
    }
  },
  {
    "id": "bnb:aenocyon_wolf",
    "name": "Aenocyon (Wolf)",
    "builtin": true,
    "category": "B&B: Carnivores",
    "cr": "8",
    "entity": {
      "type": "Monster",
      "name": "Aenocyon (Wolf)",
      "color": "#8a5236",
      "hp": {
        "current": 120,
        "max": 120
      },
      "ac": 16,
      "speed": 60,
      "initBonus": 3,
      "passivePerception": 12,
      "stats": {
        "str": 24,
        "dex": 16,
        "con": 20,
        "int": 6,
        "wis": 14,
        "cha": 10
      },
      "cr": "8",
      "abilities": "Speed: Walk 60 ft.\n\n• Pack Tactics.\n• Keen Senses.\n• Titanic Presence. Creatures of Medium size or smaller within 60 ft. make DC 17 Wisdom save at the start of each of their turns or are frightened.\n• Catastrophic Howl. Once per long rest, release a howl that functions as a fear spell (DC 17, affects all creatures within 120 ft. the Aenocyon can see).\n• Pounce. After moving 30 ft. toward a target, all creatures in its path make DC 17 Dexterity save or take 3d10 bludgeoning damage and be knocked prone.\n• Titanic Bite. Melee Attack: +10 to hit, reach 10 ft. - 4d12+8 piercing. On hit, Medium and smaller creatures are grappled and restrained (escape DC 18).",
      "playerDescription": "When an Aenocyon is sighted near a settlement, the protocol is simple: send to your neighbours for help, and begin evacuating the young.",
      "notes": "Monster | Gigantic | CR 8"
    }
  }
];

// v3: built-in token presets. DM can add custom ones on top; these are merged
// in at read time (never saved to state so they always reflect code updates).
const BUILTIN_TOKEN_PRESETS = [
  ...BNB_TOKEN_PRESETS,
  { id: 'builtin:goblin',   name: 'Goblin',     builtin: true,
    entity: { type: 'Monster', name: 'Goblin',  color: '#6b8e3f',
              hp: { current: 7, max: 7 }, ac: 15, speed: 30, initBonus: 2,
              stats: { str: 8, dex: 14, con: 10, int: 10, wis: 8, cha: 8 },
              cr: '1/4', passivePerception: 9,
              playerDescription: 'A wiry, sharp-toothed creature in scavenged leather.' } },
  { id: 'builtin:commoner', name: 'Commoner',   builtin: true,
    entity: { type: 'NPC', name: 'Commoner',    color: '#9b8b7a',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              role: 'villager', passivePerception: 10 } },
  { id: 'builtin:guard',    name: 'Guard',      builtin: true,
    entity: { type: 'NPC', name: 'Guard',       color: '#5a7088',
              hp: { current: 11, max: 11 }, ac: 16, speed: 30, initBonus: 1,
              stats: { str: 13, dex: 12, con: 12, int: 10, wis: 11, cha: 10 },
              role: 'town guard', passivePerception: 12 } },
  { id: 'builtin:bandit',   name: 'Bandit',     builtin: true,
    entity: { type: 'Monster', name: 'Bandit',  color: '#6b4a2b',
              hp: { current: 11, max: 11 }, ac: 12, speed: 30, initBonus: 1,
              stats: { str: 11, dex: 12, con: 12, int: 10, wis: 10, cha: 10 },
              cr: '1/8', passivePerception: 10,
              playerDescription: 'A rough-looking brigand with a weathered blade.' } },
  { id: 'builtin:wolf',     name: 'Wolf',       builtin: true,
    entity: { type: 'Neutral Beast', name: 'Wolf', color: '#6a6358',
              hp: { current: 11, max: 11 }, ac: 13, speed: 40, initBonus: 2,
              stats: { str: 12, dex: 15, con: 12, int: 3, wis: 12, cha: 6 },
              role: 'wolf', passivePerception: 13,
              playerDescription: 'A lean grey wolf, ribs visible under matted fur.' } },
  { id: 'builtin:skeleton', name: 'Skeleton',   builtin: true,
    entity: { type: 'Monster', name: 'Skeleton', color: '#c9c3a8',
              hp: { current: 13, max: 13 }, ac: 13, speed: 30, initBonus: 2,
              stats: { str: 10, dex: 14, con: 15, int: 6, wis: 8, cha: 5 },
              cr: '1/4', passivePerception: 9,
              playerDescription: 'Yellowed bones bound together by a foul animating will.' } },
  { id: 'builtin:chest',    name: 'Chest',      builtin: true,
    entity: { type: 'Object', name: 'Chest', color: '#8b6540',
              hp: { current: 0, max: 0 }, ac: 12, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'container',
              playerDescription: 'An iron-bound chest, latched.' } },
  { id: 'builtin:torch',    name: 'Torch / Brazier', builtin: true,
    entity: { type: 'Object', name: 'Torch', color: '#d4a52e',
              hp: { current: 0, max: 0 }, ac: 10, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'light source',
              lightRadius: 20,
              playerDescription: 'A flickering flame casting long shadows.' } },

  // v4 fix #19: Object presets
  { id: 'builtin:candle', name: 'Candle', builtin: true,
    entity: { type: 'Object', name: 'Candle', color: '#f0d77a',
              hp: { current: 0, max: 0 }, ac: 8, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'light source',
              lightRadius: 5,
              playerDescription: 'A lone candle, its flame thin and nervous.' } },
  { id: 'builtin:pouch', name: 'Pouch', builtin: true,
    entity: { type: 'Object', name: 'Pouch', color: '#704a28',
              hp: { current: 0, max: 0 }, ac: 8, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'container',
              playerDescription: 'A small leather pouch, drawstring pulled tight.' } },
  { id: 'builtin:lever', name: 'Lever', builtin: true,
    entity: { type: 'Object', name: 'Lever', color: '#6a6a6a',
              hp: { current: 0, max: 0 }, ac: 15, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'mechanism',
              playerDescription: 'An iron lever set into the wall.' } },
  { id: 'builtin:key', name: 'Key', builtin: true,
    entity: { type: 'Object', name: 'Key', color: '#b8965a',
              hp: { current: 0, max: 0 }, ac: 10, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'key',
              playerDescription: 'An ornate brass key.' } },
  { id: 'builtin:book', name: 'Book', builtin: true,
    entity: { type: 'Object', name: 'Book', color: '#5c3a2e',
              hp: { current: 2, max: 2 }, ac: 8, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'tome',
              playerDescription: 'A weathered tome, spine cracked, pages yellow.' } },
  { id: 'builtin:door', name: 'Door', builtin: true,
    entity: { type: 'Object', name: 'Door', color: '#6e4a28',
              hp: { current: 10, max: 10 }, ac: 15, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'door',
              playerDescription: 'A wooden door, weather-beaten.' } },
  { id: 'builtin:reinforced_door', name: 'Reinforced Door', builtin: true,
    entity: { type: 'Object', name: 'Reinforced Door', color: '#3a2e22',
              hp: { current: 25, max: 25 }, ac: 18, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'door',
              playerDescription: 'A heavy door banded with iron.' } },
  { id: 'builtin:trap_door', name: 'Trap Door', builtin: true,
    entity: { type: 'Object', name: 'Trap Door', color: '#5a3a22',
              hp: { current: 8, max: 8 }, ac: 12, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'hatch',
              playerDescription: 'A wooden hatch set into the floor.' } },
  { id: 'builtin:reinforced_trap_door', name: 'Reinforced Trap Door', builtin: true,
    entity: { type: 'Object', name: 'Reinforced Trap Door', color: '#2c2016',
              hp: { current: 20, max: 20 }, ac: 17, speed: 0, initBonus: 0,
              rollsInitiative: false, role: 'hatch',
              playerDescription: 'An iron-bound hatch, heavy and barred.' } },
  // Campaign-specific: The Plague's Call - Unfinished Puppet
  { id: 'builtin:unfinished_puppet', name: 'Unfinished Puppet', builtin: true,
    entity: { type: 'Monster', name: 'Unfinished Puppet', color: '#7a6a55',
              hp: { current: 58, max: 58 }, ac: 13, speed: 30, initBonus: 1,
              darkvision: 60,
              stats: { str: 15, dex: 12, con: 14, int: 8, wis: 10, cha: 6 },
              cr: '2', passivePerception: 10,
              playerDescription: 'A lurching humanoid figure of pale, badly jointed wood. It moves with horrible purpose, its jaw working soundlessly.',
              notes: `Medium Humanoid (Unfinished Construct) | AC 13 | HP 58 | Speed 30 ft
Saves: CON +4
Resistances: Poison, Cold, Necrotic, Piercing
Weaknesses: Fire, Bludgeoning
Immunities: Poisoned, Charmed
Senses: Darkvision 60 ft | Languages: Common (slurred, fragmented)

TRAIT: SPLINTERED NERVES
Start of each turn, roll 1d6:
  1-2: Agony Surge - advantage on first attack this turn
  3-4: Disoriented - disadvantage on all attacks this turn
  5-6: Lucid Flash - speaks clearly (see Dialogue Table)

ACTIONS
Multiattack: two melee attacks.
Claw / Improvised Weapon: +5 to hit, 1d8+3 slashing or bludgeoning.
  On hit: DC 12 CON save or Splinter Pain (disadvantage on next attack roll).

REACTION: WOODEN RESISTANCE (2/round)
When hit by slashing or piercing, reduce damage by 5.

PHASE TWO - below 30 HP: both twins gain PANIC FEEDBACK.
  When one takes damage, the other may:
    • Move up to 15 ft as a reaction
    • Make a single attack against the same target

DIALOGUE (Lucid Flash turns or when hit hard):
  "He said it would stop the pain-"
  "I can feel the wood in my chest-"
  "He told us not to scream-"
  "It doesn't let you die-"
  "The girl didn't wake up-"
  "THIS BODY IS WRONG"
  "The boy must run"` } },


  // Campaign-specific: The Plague's Call - Jake (Commoner Elite)
  { id: 'builtin:jake', name: 'Jake', builtin: true,
    entity: { type: 'NPC', name: 'Jake', color: '#6b5a3e',
              hp: { current: 24, max: 24 }, ac: 12, speed: 30, initBonus: 0,
              stats: { str: 17, dex: 10, con: 14, int: 9, wis: 11, cha: 10 },
              passivePerception: 10,
              playerDescription: 'A tall, broad-shouldered man with scarred hands and permanently tired eyes. He wears a heavy wool coat and carpenter\'s suspenders dusted with sawdust. He speaks softly, and seems deeply reluctant to be here.',
              notes: `Jake (Commoner Elite) | Medium Humanoid | AC 12 | HP 24 | Speed 30 ft
STR 17 (+3) | DEX 10 | CON 14 (+2) | INT 9 (−1) | WIS 11 | CHA 10
Skills: Athletics +5, Carpenter's Tools +4, Insight +2

Appearance: 6'5", broad shoulders, scarred hands, permanently tired eyes.
Heavy wool coat, carpenter suspenders dusted with sawdust.

Personality: Speaks softly. Slow to anger. Deeply protective of Tully.
Avoids conflict. Quietly insecure about being "the dumb one."
Secret fear: Being left alone.

Current State: Recently learned he is infected after Tully became symptomatic.

ACTIONS
Heavy Swing: +5 to hit, 1d8+3 bludgeoning.
Lift & Brace: Can move a heavy object or barricade a doorway instantly.

SPECIAL TRAIT: PROTECTIVE REFLEX
If an ally within 5 ft is attacked, Jake may impose disadvantage on that attack once per round.` } },

  // Campaign-specific: The Plague's Call - Tully (Before Full Breakdown)
  { id: 'builtin:tully', name: 'Tully', builtin: true,
    entity: { type: 'NPC', name: 'Tully', color: '#c07a3a',
              hp: { current: 18, max: 18 }, ac: 13, speed: 35, initBonus: 3,
              stats: { str: 10, dex: 16, con: 12, int: 12, wis: 10, cha: 14 },
              passivePerception: 10,
              playerDescription: 'Shorter than Jake by half a foot - wiry, bright-eyed, fingers stained from paints and oils. Wears a scarf dramatically. Never quite holds still.',
              notes: `Tully (Before Full Breakdown) | Medium Humanoid | AC 13 | HP 18 | Speed 35 ft
STR 10 | DEX 16 (+3) | CON 12 (+1) | INT 12 (+1) | WIS 10 | CHA 14 (+2)
Skills: Acrobatics +5, Persuasion +4, Sleight of Hand +5, Painter's Tools +4

Appearance: 5'8", wiry, bright eyes, stained fingers (paints/oils).
Scarf worn dramatically. Moves constantly.

Personality: Vain but warm. Flirts with everyone. Jokes when nervous. Hates silence.
Secretly admires Jake deeply.
Talents: decorating tavern interiors, carpentry finish work, furniture design, signage.
Worked with: Herold the Tinkerer, Ivar the Tavern Keeper.

Current State: Infected first.

ACTIONS
Knife Jab: +5 to hit, 1d4+3 piercing.
Scatter Objects: Throws nearby clutter - 10 ft radius becomes difficult terrain.

SPECIAL TRAIT: QUICK ESCAPE
Tully can Disengage as a bonus action.` } },

  // Campaign-specific NPCs: The Plague's Call
  { id: 'builtin:coalan', name: 'Coalan the Physician', builtin: true,
    entity: { type: 'NPC', name: 'Coalan', color: '#8ab4c2',
              hp: { current: 27, max: 27 }, ac: 13, speed: 30, initBonus: 1,
              darkvision: 0,
              stats: { str: 10, dex: 12, con: 14, int: 15, wis: 16, cha: 11 },
              passivePerception: 13,
              playerDescription: 'A finished puppet wearing a physician\'s coat that was once white. His movements are careful and deliberate, almost reassuring - but midway through sentences he sometimes stops and stares at nothing, as though a page has been torn out of a book.',
              notes: `Coalan the Physician | Finished Puppet (Level 4 Cleric) | AC 13 | HP 27 | Speed 30 ft
STR 10 | DEX 12 (+1) | CON 14 (+2) | INT 15 (+2) | WIS 16 (+3) | CHA 11
Skills: Medicine +7, Religion +4, History +4, Insight +5
Spell Save DC 13 | Spell Attack +5 | Prepared Spells: Healing Word, Cure Wounds, Bless, Shield of Faith, Spiritual Weapon, Hold Person

DISPOSITION: Helpful. He genuinely tries to assist the party. Not hostile.

TRAIT: LACUNAE
His memory has literal gaps - not metaphorical ones. Midway through sharing information, he may stop, blink slowly, and say "I had something important to tell you about that" before going quiet for a full minute. Roll d6 at key moments:
  1-2: Memory hole - he loses the thread entirely, visibly distressed.
  3-4: Partial recall - he gives incomplete but useful information.
  5-6: Clear window - he speaks with alarming coherence before it closes.

ACTIONS
Healing Touch: Cures 1d8+3 HP as an action. Reflexive - does not require the target to consent.
Staff Strike: +3 to hit, 1d6 bludgeoning.
Spiritual Weapon (2nd slot): Bonus action, 1d8+3 force, 60 ft.
Hold Person (2nd slot): DC 13 WIS save.

NOTES
He does not know what he is. He believes himself to be recovering from illness.
He calls the Puppetmaster "the doctor who helped me" and will not hear otherwise.` } },

  { id: 'builtin:yevgeny', name: 'Yevgeny the Priest', builtin: true,
    entity: { type: 'NPC', name: 'Yevgeny', color: '#5c3d6e',
              hp: { current: 49, max: 49 }, ac: 13, speed: 30, initBonus: 2,
              darkvision: 60,
              stats: { str: 10, dex: 14, con: 14, int: 13, wis: 12, cha: 18 },
              passivePerception: 11,
              playerDescription: 'A tall puppet in priest\'s vestments, face a mask of carved wood lacquered smooth. He watches the party with an unreadable expression. He has not moved to greet you.',
              notes: `Yevgeny the Priest | Finished Puppet (Level 7 Warlock) | AC 13 | HP 49 | Speed 30 ft
STR 10 | DEX 14 (+2) | CON 14 (+2) | INT 13 (+1) | WIS 12 (+1) | CHA 18 (+4)
Skills: Arcana +4, Deception +7, Intimidation +7, Religion +4
Darkvision 60 ft | Spell Save DC 15 | Spell Attack +7
Pact Slots: 4th level (x2, recover on short rest)
Invocations: Agonizing Blast, Devil's Sight, Repelling Blast
Eldritch Blast: 2 beams, +7 to hit, 1d10+4 force each (repel 10 ft on hit).
Prepared: Hunger of Hadar, Hypnotic Pattern, Counterspell, Fly, Banishment, Dimension Door

DISPOSITION: Hostile to outsiders. Will not attack unprovoked.
Provocation threshold: threatening him, entering his sanctum, or naming the Puppetmaster approvingly.
Once provoked: uses Repelling Blast to create space, then Hunger of Hadar.

TRAIT: PUPPETED FAITH
He still speaks of his god. Whether his god still hears him is unclear.
He responds to sincere theological discussion with something like genuine interest - this is a soft point.

ACTIONS
Eldritch Blast: +7 to hit, 2 beams, 1d10+4 force + push 10 ft.
Toll the Dead (Cantrip): DC 15 WIS save, 2d12 necrotic if target is damaged.
Hunger of Hadar (4th slot): 20 ft sphere, blindness, difficult terrain, 2d6 cold + 2d6 acid/round.
Counterspell (3rd slot): Reaction, auto-counters ≤3rd level spells.

NOTES
He knows more than he says. He knew the Puppetmaster before the infection.
He has not tried to leave. Ask him why.` } },

  { id: 'builtin:ernest_broken', name: 'Ernest the Broken Puppet', builtin: true,
    entity: { type: 'Monster', name: 'Ernest', color: '#4a3a28',
              hp: { current: 104, max: 104 }, ac: 14, speed: 30, initBonus: -1,
              darkvision: 60,
              stats: { str: 18, dex: 8, con: 16, int: 4, wis: 8, cha: 3 },
              cr: '5',
              passivePerception: 9,
              playerDescription: 'Something moves at the treeline. The shape is wrong - limbs bending the wrong way, torso rotating further than a torso should, a face that might once have been a man\'s. It is looking directly at you.',
              notes: `Ernest the Broken Puppet | CR 5 | Medium Monstrosity (Broken Construct) | AC 14 (natural armor) | HP 104 | Speed 30 ft (Unnatural Gait)
STR 18 (+4) | DEX 8 (−1) | CON 16 (+3) | INT 4 (−3) | WIS 8 (−1) | CHA 3 (−4)
Darkvision 60 ft | Passive Perception 9
Damage Resistances: Bludgeoning, Piercing
Condition Immunities: Charmed, Frightened, Poisoned

LORE: Once a policeman. Name: Ernest. The Puppetmaster's first failed experiment - too much was changed.
He stalks the forest at night. He has no agenda beyond proximity. He used to know people.

TRAIT: WRONG DIRECTIONS
Ernest's limbs are attached in incorrect orientations. His attacks cannot be predicted from his body language.
Creatures that attempt to use reactions against his attacks do so at disadvantage.

TRAIT: CALMED, NOT CURED
If the party succeeds on a DC 14 CHA (Persuasion) check using his real name, or presents an object he recognises, Ernest stops attacking. He does not leave. He sits down and begins to cry - a faint wooden creak, rhythmic, continuous. He cannot be healed or restored.

ACTIONS (Multiattack: 2 strikes)
Broken Fist: +7 to hit, 1d10+4 bludgeoning. On a hit: target makes DC 14 STR save or is knocked prone.
Wrenching Grab: +7 to hit, 1d6+4 bludgeoning + grappled (escape DC 15). While grappled, target is restrained.

REACTION: WRONG WAY
When hit by a melee attack, Ernest lurches unpredictably. Attacker must succeed DC 13 DEX save or their attack hits an adjacent creature instead.

STALKER BEHAVIOUR
Appears at night only. Will track one PC between sessions if they fled rather than resolved the encounter.
Does not open doors. Does not cross running water. Does not stop moving.` } },

  { id: 'builtin:laughing_puppet', name: 'The Laughing Puppet', builtin: true,
    entity: { type: 'Monster', name: 'The Laughing Puppet', color: '#2e4a3a',
              hp: { current: 78, max: 78 }, ac: 15, speed: 35, initBonus: 4,
              darkvision: 120,
              stats: { str: 12, dex: 18, con: 14, int: 14, wis: 12, cha: 16 },
              cr: '6',
              passivePerception: 14,
              playerDescription: 'You hear it before you see it - a sound like laughter that has been running for too long, turned thin and hollow. Then the ceiling moves.',
              notes: `The Laughing Puppet | CR 6 | Small Monstrosity (Sewer Predator) | AC 15 | HP 78 | Speed 35 ft (climb 35 ft)
STR 12 (+1) | DEX 18 (+4) | CON 14 (+2) | INT 14 (+2) | WIS 12 (+1) | CHA 16 (+3)
Darkvision 120 ft | Passive Perception 14
Skills: Stealth +8, Perception +4, Acrobatics +7, Deception +6
Condition Immunities: Frightened

TRAIT: UNNATURAL SQUEEZE
Can move through any space large enough for a Small creature without penalty. Does not suffer movement reduction in tight spaces. Ignores difficult terrain caused by cramped environments.

TRAIT: GIBBERING PRESENCE
Any creature that starts its turn within 20 ft of the Laughing Puppet must succeed on a DC 14 WIS save or become Frightened until the start of its next turn.
On a failed save by 5 or more: the creature also uses its reaction to move directly away from her.

TRAIT: SHADOW OF THE PIPE
While in dim light or darkness, the Laughing Puppet has advantage on Stealth checks and cannot be tracked by non-magical means.

ACTIONS
Multiattack: Two Rake attacks, or one Rake and one Mind Splinter.
Rake: +7 to hit, 1d8+4 slashing + 1d6 psychic.
Mind Splinter (Recharge 5-6): One target within 30 ft, DC 14 WIS save.
  Failure: 3d8 psychic damage, target is Stunned until end of its next turn.
  Success: Half damage, not Stunned.
Lure (Bonus Action): One creature within 60 ft that can hear her must succeed DC 13 WIS save or move up to its speed toward her.

REACTION: SLIP
When targeted by an attack, the Laughing Puppet may move up to 10 ft without provoking opportunity attacks (1/round).

ENCOUNTER DESIGN
She never fights in the open. She uses pipe junctions to close and retreat.
She will kill the isolated, and observe the group. She finds fear amusing.
She has a name she no longer answers to.` } },

  { id: 'builtin:angmar', name: 'Angmar the Hunter', builtin: true,
    entity: { type: 'NPC', name: 'Angmar', color: '#6b4c1e',
              hp: { current: 58, max: 58 }, ac: 15, speed: 30, initBonus: 3,
              darkvision: 0,
              stats: { str: 16, dex: 16, con: 14, int: 11, wis: 14, cha: 10 },
              passivePerception: 16,
              playerDescription: 'He is a large man - broad and loud, with a cloak assembled from at least a hundred different pieces of bear pelt. He smells like woodsmoke and blood, and he is grinning.',
              notes: `Angmar the Hunter | Level 7 Ranger (Hunter Conclave) | AC 15 (studded leather) | HP 58 | Speed 30 ft
STR 16 (+3) | DEX 16 (+3) | CON 14 (+2) | INT 11 | WIS 14 (+2) | CHA 10
Skills: Perception +6 (Expertise), Athletics +6, Stealth +6, Survival +8, Nature +3
Passive Perception 16 | No darkvision (doesn't need it, he says)

APPEARANCE
Potbellied but powerful. The bulk is deceptive. Cloak of patchwork bear pelts - hundred stitched pieces.
Loud by default. Laughs at his own stories. Does not whisper in the woods on principle.

PERSONALITY
Warm to those who prove themselves useful. Contemptuous of people who are squeamish.
He has been hunting this forest for twenty years. He knows about what walks it at night.
He will not say its name. He calls it "the creaking one."

RANGER FEATURES
Favoured Enemy: Constructs, Undead
Natural Explorer: Forest (no difficult terrain penalty, cannot be surprised while alert)
Extra Attack: Makes two attacks per Attack action.
Hunter: Colossus Slayer - once per turn, +1d8 on a hit against a creature below max HP.
Multiattack Defence: +4 AC against further attacks from any creature that hits him.

ACTIONS
Longbow: +6 to hit, 1d8+3 piercing, 150/600 ft. Colossus Slayer +1d8 once per turn.
Handaxe: +6 to hit, 1d6+3 slashing (two attacks).
Volley (once per short rest): Attack every creature in 10 ft radius with the longbow.

SPELLS (2nd level slots x3)
Hunter's Mark (1st) | Ensnaring Strike (1st) | Spike Growth (2nd) | Silence (2nd)

INFORMATION HE HAS
Knows Ernest's name. Watched him from a distance once.
Knows there are things in the sewer he has not hunted. Will not go in.
Can identify puppet wounds on sight.` } },

  { id: 'builtin:barry', name: 'Barry the Guard', builtin: true,
    entity: { type: 'NPC', name: 'Barry', color: '#b22222',
              hp: { current: 38, max: 38 }, ac: 18, speed: 30, initBonus: 0,
              darkvision: 0,
              stats: { str: 16, dex: 10, con: 16, int: 11, wis: 12, cha: 14 },
              passivePerception: 11,
              playerDescription: 'A young man in a spotless red coat with polished brass buttons. He has the posture of someone who has been told to stand straight their entire life. He is trying very hard to look like he has everything under control.',
              notes: `Barry the Guard | Level 4 Paladin (Oath of Devotion) | AC 18 (plate) | HP 38 | Speed 30 ft
STR 16 (+3) | DEX 10 | CON 16 (+3) | INT 11 | WIS 12 (+1) | CHA 14 (+2)
Skills: Athletics +5, Intimidation +4, Persuasion +4, Religion +2
Passive Perception 11 | Spell Save DC 12 | Spell Attack +4

APPEARANCE
Red coat - the old town guard uniform. Cleaned obsessively. Brass buttons polished to mirrors.
Younger than he should be for the job. Carries his father's baton.

BACKGROUND
Son of Ernest - the police chief who went missing thirteen years ago.
Barry was nine years old. He joined the guard the day he turned sixteen.
He does not talk about his father unprompted. He will talk about him if you ask once, directly.
He does not know what Ernest became.

PERSONALITY
Formal by training, earnest underneath it. Wants to do right by the town.
Anxious about losing control of situations. Hides it under procedure.
Will cite regulations he has half-memorised. They're usually close to accurate.

PALADIN FEATURES
Divine Sense: Detects celestials, fiends, undead within 60 ft (4/day).
Lay on Hands: 20 HP pool, cure disease/poison.
Divine Smite: Expend spell slot on a hit, +2d8 radiant (3d8 vs undead/fiends).
Channel Divinity (1/rest): Sacred Weapon (+2 attack for 1 min) or Turn the Unholy.

ACTIONS
Longsword: +5 to hit, 1d8+3 slashing (1d10+3 versatile). + Divine Smite.
Shield Bash: +5 to hit, 1d4+3 bludgeoning, target knocked prone DC 13 STR.

SPELLS (1st: ×4, 2nd: ×2)
Bless | Cure Wounds | Shield of Faith | Thunderous Smite | Lesser Restoration | Zone of Truth

WHAT HE KNOWS
He knows his father disappeared investigating reports of strange illness in the outer wards.
He has a box of his father's effects. Inside: a badge, a baton, and a photograph of a street he doesn't recognise.
He has never shown it to anyone.` } },

  // Campaign-specific townspeople: The Plague's Call
  { id: 'builtin:ivar', name: 'Ivar the Tavernkeeper', builtin: true,
    entity: { type: 'NPC', name: 'Ivar', color: '#7a5c3e',
              hp: { current: 10, max: 10 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 12, dex: 10, con: 12, int: 13, wis: 14, cha: 11 },
              passivePerception: 12,
              playerDescription: 'The tavernkeeper. He polishes the same glass he was polishing when you walked in. He nodded when you entered. That was the greeting.',
              notes: `Ivar the Tavernkeeper | Human Commoner | AC 10 | HP 10 | Speed 30 ft
STR 12 (+1) | DEX 10 | CON 12 (+1) | INT 13 (+1) | WIS 14 (+2) | CHA 11
Skills: Insight +4, Persuasion +2, History +3

APPEARANCE
Late 50s. Thick forearms. A beard he stopped trimming when business slowed.
The tavern is clean - he keeps it clean - but the candles are cheaper than they used to be.

PERSONALITY
Reserved. Not cold exactly, just economical. Speaks when spoken to, answers what is asked.
Business is slow. He does not complain about it. He has noticed things he does not discuss.
Still entirely human. Still watching.

WHAT HE KNOWS (if asked carefully)
Tully worked the taproom some evenings, helped with the interior.
He last saw Tully three weeks ago looking pale.
He has heard sounds from the cellar at night. He has not gone to check.
He does not serve anyone who comes in after the third bell anymore. He doesn't say why.

ACTIONS
Heavy Mug: +3 to hit, 1d4+1 bludgeoning. (He keeps one behind the bar.)` } },

  { id: 'builtin:charles', name: 'Charles', builtin: true,
    entity: { type: 'NPC', name: 'Charles', color: '#4a6e8a',
              hp: { current: 8, max: 8 }, ac: 10, speed: 30, initBonus: 1,
              stats: { str: 11, dex: 12, con: 10, int: 11, wis: 10, cha: 13 },
              passivePerception: 10,
              playerDescription: 'A young man who looks like he has not slept properly in some time. He smiles when he notices you looking, which makes it worse.',
              notes: `Charles | Human Commoner | AC 10 | HP 8 | Speed 30 ft
STR 11 | DEX 12 (+1) | CON 10 | INT 11 | WIS 10 | CHA 13 (+1)
Skills: Persuasion +3, Sleight of Hand +3

APPEARANCE
Mid-20s. Keeps his clothes neat even though they are wearing thin at the elbows.
Married to Elisia. They share a small house near the mill.

PERSONALITY
Optimistic by default, working hard to remain so. Deflects worry with small talk.
Fiercely protective of Elisia without quite knowing how to show it.
Trusts people until they give him a reason not to. Usually gives them one more chance after that.

WHAT HE KNOWS
Elisia has been unwell. He says it is just a winter chill.
He found something in the yard two mornings ago. He threw it away before Elisia could see it.
He would very much like someone to tell him everything is fine.

ACTIONS
Fists: +2 to hit, 1d4 bludgeoning. (He would rather not.)` } },

  { id: 'builtin:elisia', name: 'Elisia', builtin: true,
    entity: { type: 'NPC', name: 'Elisia', color: '#8a5e6e',
              hp: { current: 7, max: 7 }, ac: 10, speed: 30, initBonus: 1,
              stats: { str: 8, dex: 13, con: 10, int: 12, wis: 12, cha: 14 },
              passivePerception: 11,
              playerDescription: 'A young woman with clever eyes and ink-stained fingers. She is watching you with the particular attention of someone who has already decided several things about you.',
              notes: `Elisia | Human Commoner | AC 10 | HP 7 | Speed 30 ft
STR 8 (−1) | DEX 13 (+1) | CON 10 | INT 12 (+1) | WIS 12 (+1) | CHA 14 (+2)
Skills: Insight +3, Persuasion +4, Medicine +3, Investigation +3

APPEARANCE
Mid-20s. Keeps a small journal on her at all times.
Married to Charles. Ink stains on her right hand - she writes letters for hire, handles accounts.

PERSONALITY
Sharp. Reads people quickly and accurately. Tends to know she's right.
Loves Charles and shows it more easily than he does.
Does not panic. Gets very quiet when frightened, which can be mistaken for calm.

CURRENT STATE
She has been unwell. She knows it is not a winter chill.
She has not told Charles what she suspects because she does not want to be right.
She has been writing something. She has not finished it yet.

WHAT SHE KNOWS
She noticed the streets are quieter than they should be for the season.
She knows who used to live in two of the houses that are now empty.
She has been keeping a list.

ACTIONS
Penknife: +3 to hit, 1d4+1 piercing. (She carries it for sharpening quills. Mostly.)` } },

  { id: 'builtin:marta', name: 'Marta the Seamstress', builtin: true,
    entity: { type: 'NPC', name: 'Marta', color: '#9e6b8a',
              hp: { current: 7, max: 7 }, ac: 10, speed: 30, initBonus: 1,
              stats: { str: 8, dex: 15, con: 10, int: 12, wis: 13, cha: 11 },
              passivePerception: 11,
              playerDescription: 'A woman of perhaps forty with needle-straight posture and fingers that are always moving - tucking thread, checking hems, or tapping a rhythm only she can hear.',
              notes: `Marta the Seamstress | Human Commoner | AC 10 | HP 7 | Speed 30 ft
STR 8 (−1) | DEX 15 (+2) | CON 10 | INT 12 (+1) | WIS 13 (+1) | CHA 11
Skills: Perception +3, Insight +3, Sleight of Hand +4, History +3

APPEARANCE
~40. Wiry. Posture like a person who has been told to sit up straight so often it became permanent.
Always has thread somewhere on her person. Her hands never quite stop moving.
The shop smells of cedar and lanolin.

PERSONALITY
Precise. Believes in doing things correctly or not at all.
Not unfriendly, but economical with warmth. Warms to people who appreciate quality.
Has an excellent memory for faces and a very long memory for slights.

WHAT SHE KNOWS
She made the coats for most of the town guard. She knows which ones aren't coming to pick up their orders.
She's been altering more black garments lately. She hasn't asked why.
She once saw something cross the yard between the tannery and the mill at night. It didn't walk right.
She finished her alterations early that night and went home.

ACTIONS
Shears: +4 to hit, 1d6+2 piercing. (Fabric shears. Large ones.)` } },

  { id: 'builtin:oswin', name: 'Oswin the Baker', builtin: true,
    entity: { type: 'NPC', name: 'Oswin', color: '#c49a3a',
              hp: { current: 12, max: 12 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 13, dex: 10, con: 13, int: 10, wis: 12, cha: 12 },
              passivePerception: 11,
              playerDescription: 'A round-faced man with flour in his hair and an expression of someone who is working very hard to remain cheerful. He waves when he sees you.',
              notes: `Oswin the Baker | Human Commoner | AC 10 | HP 12 | Speed 30 ft
STR 13 (+1) | DEX 10 | CON 13 (+1) | INT 10 | WIS 12 (+1) | CHA 12 (+1)
Skills: Athletics +3, Persuasion +3, Insight +3

APPEARANCE
~35. Round-faced. Built like a man who has been lifting flour sacks his whole life.
Almost always has flour somewhere on him. Wears an apron even when not baking.

PERSONALITY
Warm. Genuinely warm, not performatively so.
Feeds people as a reflex. Will offer you something without being asked.
Worries. Talks when worried. Is currently worried.

CURRENT CONCERNS
Fewer people are buying. He has baked the same amount. He doesn't know what to do with the rest.
He leaves loaves by the door of the house where the Alderand family used to live. No one has taken them in four days.
He starts work at four in the morning. He has heard things in the dark that he has not been able to account for.

WHAT HE KNOWS
Knows everyone in town. Can tell you who is not coming in anymore and roughly when they stopped.
He thinks the water might be wrong somehow. He has no evidence. He switched to river water two weeks ago.

ACTIONS
Rolling Pin: +3 to hit, 1d6+1 bludgeoning. (He would apologise the whole time.)` } },

  { id: 'builtin:gerrit', name: 'Gerrit the Blacksmith', builtin: true,
    entity: { type: 'NPC', name: 'Gerrit', color: '#4a4a4a',
              hp: { current: 16, max: 16 }, ac: 12, speed: 30, initBonus: 0,
              stats: { str: 17, dex: 10, con: 14, int: 10, wis: 12, cha: 9 },
              passivePerception: 11,
              playerDescription: 'A broad man who looks like he was built rather than born. He squints at you the way a person squints at a horseshoe they\'re not yet sure about.',
              notes: `Gerrit the Blacksmith | Human Commoner (Strong) | AC 12 (work leathers) | HP 16 | Speed 30 ft
STR 17 (+3) | DEX 10 | CON 14 (+2) | INT 10 | WIS 12 (+1) | CHA 9 (−1)
Skills: Athletics +5, Perception +3, Smith's Tools +5

APPEARANCE
~50. Broad-shouldered. Burn scars on both forearms, the left worse than the right.
Does not fill silences. Lets them sit there until someone else cracks.

PERSONALITY
Laconic. Practical. Respects competence above everything.
Takes a long time to trust someone but once he does, will not waver.
Has no time for stories unless they get to the point.
Has a dry sense of humour that appears without warning.

WHAT HE KNOWS
Several people have asked him about reinforcing doors and window shutters recently. He's done the work without asking why.
He was asked to make something unusual six weeks ago. He declined. He doesn't say by whom.
He keeps a hammer behind the door of his house. Not the workshop door. The house door.
He has been sleeping poorly. He doesn't say why.

ACTIONS
Hammer: +5 to hit, 1d6+3 bludgeoning.
Tongs (improvised): +5 to hit, 1d4+3 bludgeoning, target makes DC 13 STR save or drops held item.` } },

  { id: 'builtin:pip', name: 'Pip (The Happy Boy)', builtin: true,
    entity: { type: 'NPC', name: 'Pip', color: '#e8c84a',
              hp: { current: 4, max: 4 }, ac: 10, speed: 35, initBonus: 2,
              stats: { str: 6, dex: 14, con: 10, int: 10, wis: 10, cha: 15 },
              passivePerception: 10,
              playerDescription: 'A boy of perhaps eight with muddy knees and an expression of total confidence in the world. He is looking at you like you are the most interesting thing that has happened to him all week, which may be true.',
              notes: `Pip | Human Child | AC 10 | HP 4 | Speed 35 ft
STR 6 (−2) | DEX 14 (+2) | CON 10 | INT 10 | WIS 10 | CHA 15 (+2)
Skills: Acrobatics +4, Perception +2, Persuasion +4

APPEARANCE
~8 years old. Perpetually muddy knees. Gap-toothed grin. Moves at only two speeds: running and asleep.

PERSONALITY
Genuinely, effortlessly happy. Not naive - he notices things - but catastrophe has not touched him yet and so he defaults to delight.
Talks to strangers without hesitation. Asks questions adults would not ask.
Has a dog he calls Marshal. Marshal is not here right now. He has explained where Marshal is at length.

WHAT HE KNOWS (without knowing he knows it)
He plays in parts of town that adults have stopped going to.
He found something interesting near the sewer grate three days ago. He put it in his pocket.
He knows which houses on his street have had their curtains closed for more than a week.
He will tell you any of this if you ask him about his day.
He is not afraid. This is either a gift or a warning.

NOTES FOR DM
Do not harm Pip. If you harm Pip you will have made a mistake.
His continued happiness is a resource. Use it carefully.` } },

  { id: 'builtin:npc_male_commoner', name: 'Male Commoner', builtin: true,
    entity: { type: 'NPC', name: 'Commoner (m)', color: '#9b8b7a',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              role: 'villager', passivePerception: 10,
              playerDescription: 'A weathered man in plain working clothes.' } },
  { id: 'builtin:npc_female_commoner', name: 'Female Commoner', builtin: true,
    entity: { type: 'NPC', name: 'Commoner (f)', color: '#a08b7d',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
              role: 'villager', passivePerception: 10,
              playerDescription: 'A weathered woman in plain working clothes.' } },
  { id: 'builtin:npc_local_elite', name: 'Local Elite', builtin: true,
    entity: { type: 'NPC', name: 'Local Elite', color: '#7a5a88',
              hp: { current: 18, max: 18 }, ac: 13, speed: 30, initBonus: 1,
              stats: { str: 11, dex: 12, con: 12, int: 13, wis: 12, cha: 14 },
              role: 'noble / merchant / patron', passivePerception: 12,
              playerDescription: 'Finely dressed and carrying themself with easy authority.' } },
  { id: 'builtin:npc_fighter_guard', name: 'Fighter Guard', builtin: true,
    entity: { type: 'NPC', name: 'Fighter Guard', color: '#4a5f82',
              hp: { current: 22, max: 22 }, ac: 17, speed: 30, initBonus: 1,
              stats: { str: 14, dex: 12, con: 14, int: 10, wis: 11, cha: 10 },
              role: 'guard (heavy)', passivePerception: 12,
              playerDescription: 'Chain shirt, sword at hip, watchful eyes.' } },
  { id: 'builtin:npc_ranger_guard', name: 'Ranger Guard', builtin: true,
    entity: { type: 'NPC', name: 'Ranger Guard', color: '#3f6a4a',
              hp: { current: 19, max: 19 }, ac: 14, speed: 30, initBonus: 3,
              stats: { str: 11, dex: 16, con: 12, int: 11, wis: 14, cha: 10 },
              role: 'guard (scout)', passivePerception: 14,
              darkvision: 30,
              playerDescription: 'Leather armor, longbow slung, alert to every shadow.' } },

  // ==========================================================
  // v5 #11 - BESTIARY: humanoids
  // ==========================================================
  { id: 'builtin:young_child', name: 'Young Child', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Young Child', color: '#c9a380',
              hp: { current: 2, max: 2 }, ac: 9, speed: 25, initBonus: 0,
              stats: { str: 6, dex: 10, con: 8, int: 8, wis: 8, cha: 10 },
              role: 'young child', passivePerception: 9,
              playerDescription: 'A small child, barely old enough to know fear.' } },
  { id: 'builtin:child', name: 'Child', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Child', color: '#b79270',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 8, dex: 12, con: 10, int: 10, wis: 9, cha: 10 },
              role: 'child', passivePerception: 10,
              playerDescription: 'A child, eyes wide, all elbows and quick feet.' } },
  { id: 'builtin:teen', name: 'Teen', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Teen', color: '#a88568',
              hp: { current: 6, max: 6 }, ac: 10, speed: 30, initBonus: 1,
              stats: { str: 10, dex: 12, con: 10, int: 10, wis: 10, cha: 11 },
              role: 'adolescent', passivePerception: 11,
              playerDescription: 'A lanky adolescent, caught between child and adult.' } },
  { id: 'builtin:blacksmith', name: 'Blacksmith', builtin: true, category: 'Humanoid', cr: '1/4',
    entity: { type: 'NPC', name: 'Blacksmith', color: '#5a4238',
              hp: { current: 16, max: 16 }, ac: 11, speed: 30, initBonus: 0,
              stats: { str: 16, dex: 10, con: 14, int: 10, wis: 11, cha: 10 },
              role: 'blacksmith', passivePerception: 10,
              playerDescription: 'Scarred forearms, leather apron, a hammer always within reach.' } },
  { id: 'builtin:sick_village_guard', name: 'Sick Village Guard', builtin: true, category: 'Humanoid', cr: '1/2',
    entity: { type: 'NPC', name: 'Sick Village Guard', color: '#6a7a5a',
              hp: { current: 9, max: 15 }, ac: 13, speed: 25, initBonus: 1,
              stats: { str: 12, dex: 12, con: 10, int: 10, wis: 11, cha: 9 },
              role: 'village guard (ailing)', passivePerception: 11,
              sickness: 2,
              playerDescription: 'A guard in dented chain, pale and sweating, leaning on their spear.' } },
  { id: 'builtin:village_guard', name: 'Village Guard', builtin: true, category: 'Humanoid', cr: '1',
    entity: { type: 'NPC', name: 'Village Guard', color: '#4a5a6a',
              hp: { current: 22, max: 22 }, ac: 14, speed: 30, initBonus: 1,
              stats: { str: 13, dex: 12, con: 13, int: 10, wis: 11, cha: 10 },
              role: 'village guard', passivePerception: 12,
              playerDescription: 'A dutiful village guard in studded leather, spear in hand.' } },
  { id: 'builtin:priest', name: 'Priest', builtin: true, category: 'Humanoid', cr: '4',
    entity: { type: 'NPC', name: 'Priest', color: '#c9b37a',
              hp: { current: 44, max: 44 }, ac: 15, speed: 30, initBonus: 0,
              stats: { str: 10, dex: 10, con: 12, int: 13, wis: 16, cha: 13 },
              role: 'priest / cleric', passivePerception: 15,
              playerDescription: 'Robed in ceremonial vestments, holy symbol held before them.' } },
  { id: 'builtin:tavernkeeper', name: 'Tavernkeeper', builtin: true, category: 'Humanoid', cr: '1/8',
    entity: { type: 'NPC', name: 'Tavernkeeper', color: '#8b6a4a',
              hp: { current: 10, max: 10 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 11, dex: 10, con: 12, int: 11, wis: 11, cha: 13 },
              role: 'tavernkeeper', passivePerception: 11,
              playerDescription: 'Rag in one hand, tankard in the other, always listening.' } },
  { id: 'builtin:tinkerer', name: 'Tinkerer (Artificer)', builtin: true, category: 'Humanoid', cr: '9',
    entity: { type: 'NPC', name: 'Tinkerer', color: '#6a4a7c',
              hp: { current: 91, max: 91 }, ac: 17, speed: 30, initBonus: 2,
              stats: { str: 10, dex: 14, con: 14, int: 18, wis: 12, cha: 11 },
              role: 'artificer', passivePerception: 14,
              darkvision: 60,
              playerDescription: 'Goggles, a bandolier of strange tools, fingers stained with oil and arcane residue.' } },
  { id: 'builtin:fisherman', name: 'Fisherman', builtin: true, category: 'Humanoid', cr: '0',
    entity: { type: 'NPC', name: 'Fisherman', color: '#5a7090',
              hp: { current: 4, max: 4 }, ac: 10, speed: 30, initBonus: 0,
              stats: { str: 11, dex: 10, con: 11, int: 10, wis: 11, cha: 10 },
              role: 'fisherman', passivePerception: 11,
              playerDescription: 'Salt-cracked hands, a coiled net over their shoulder, smell of the sea.' } },
  { id: 'builtin:orc', name: 'Orc', builtin: true, category: 'Humanoid', cr: '1/2',
    entity: { type: 'Monster', name: 'Orc', color: '#5a6a3a',
              hp: { current: 15, max: 15 }, ac: 13, speed: 30, initBonus: 1,
              stats: { str: 16, dex: 12, con: 16, int: 7, wis: 11, cha: 10 },
              role: 'orc warrior', passivePerception: 10,
              darkvision: 60,
              playerDescription: 'Tusked, scarred, greataxe gripped in calloused hands.' } },

  // ==========================================================
  // v5 #11 - BESTIARY: animals
  // ==========================================================
  { id: 'builtin:dog', name: 'Dog', builtin: true, category: 'Animal', cr: '1/8',
    entity: { type: 'Neutral Beast', name: 'Dog', color: '#8a6a3a',
              hp: { current: 5, max: 5 }, ac: 12, speed: 40, initBonus: 2,
              stats: { str: 10, dex: 14, con: 12, int: 3, wis: 12, cha: 6 },
              role: 'hound', passivePerception: 13,
              playerDescription: 'A loyal hound, ears pricked, tail low and alert.' } },
  { id: 'builtin:cat', name: 'Cat', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Cat', color: '#8b7355',
              hp: { current: 2, max: 2 }, ac: 12, speed: 40, initBonus: 2,
              stats: { str: 3, dex: 15, con: 10, int: 3, wis: 12, cha: 7 },
              role: 'house cat', passivePerception: 13,
              darkvision: 60,
              playerDescription: 'A sleek cat, unbothered by you, slipping through shadow.' } },
  { id: 'builtin:pigeon', name: 'Pigeon', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Pigeon', color: '#8e8e8e',
              hp: { current: 1, max: 1 }, ac: 11, speed: 10, initBonus: 1,
              stats: { str: 2, dex: 13, con: 8, int: 2, wis: 12, cha: 6 },
              role: 'city bird', passivePerception: 11,
              playerDescription: 'A scruffy grey pigeon, head bobbing.' } },
  { id: 'builtin:large_toad', name: 'Large Toad', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Large Toad', color: '#5a7a3a',
              hp: { current: 11, max: 11 }, ac: 11, speed: 20, initBonus: 1,
              stats: { str: 12, dex: 13, con: 13, int: 2, wis: 10, cha: 3 },
              role: 'large toad', passivePerception: 10,
              darkvision: 30,
              playerDescription: 'A bloated, dinner-plate-sized toad, damp and staring.' } },
  { id: 'builtin:eagle', name: 'Eagle', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Eagle', color: '#6a4a2a',
              hp: { current: 3, max: 3 }, ac: 12, speed: 10, initBonus: 2,
              stats: { str: 6, dex: 15, con: 10, int: 2, wis: 14, cha: 7 },
              role: 'raptor', passivePerception: 14,
              playerDescription: 'A sharp-eyed eagle, wings spread, circling high.' } },
  { id: 'builtin:boar', name: 'Boar', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Boar', color: '#4a3a2a',
              hp: { current: 11, max: 11 }, ac: 11, speed: 40, initBonus: 0,
              stats: { str: 13, dex: 11, con: 12, int: 2, wis: 9, cha: 5 },
              role: 'boar', passivePerception: 9,
              playerDescription: 'A tusked wild boar, shaggy and furious.' } },
  { id: 'builtin:elk', name: 'Elk', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Elk', color: '#6a4e2a',
              hp: { current: 13, max: 13 }, ac: 10, speed: 50, initBonus: 0,
              stats: { str: 16, dex: 10, con: 12, int: 2, wis: 10, cha: 6 },
              role: 'elk', passivePerception: 12,
              playerDescription: 'A tall elk, antlers crowning its head, eyes wary.' } },
  { id: 'builtin:horse', name: 'Horse', builtin: true, category: 'Animal', cr: '1/4',
    entity: { type: 'Neutral Beast', name: 'Horse', color: '#5a3a2a',
              hp: { current: 19, max: 19 }, ac: 10, speed: 60, initBonus: 0,
              stats: { str: 18, dex: 12, con: 13, int: 2, wis: 11, cha: 7 },
              role: 'riding horse', passivePerception: 10,
              playerDescription: 'A riding horse, broad-chested, breath misting in the morning air.' } },
  { id: 'builtin:chicken', name: 'Chicken', builtin: true, category: 'Animal', cr: '0',
    entity: { type: 'Neutral Beast', name: 'Chicken', color: '#c9a374',
              hp: { current: 1, max: 1 }, ac: 10, speed: 10, initBonus: 0,
              stats: { str: 2, dex: 10, con: 8, int: 2, wis: 10, cha: 4 },
              role: 'chicken', passivePerception: 10,
              playerDescription: 'A scrawny chicken, picking at the dirt.' } },
  { id: 'builtin:donkey', name: 'Donkey', builtin: true, category: 'Animal', cr: '1/8',
    entity: { type: 'Neutral Beast', name: 'Donkey', color: '#8b7355',
              hp: { current: 11, max: 11 }, ac: 10, speed: 40, initBonus: 0,
              stats: { str: 12, dex: 10, con: 11, int: 2, wis: 10, cha: 5 },
              role: 'donkey', passivePerception: 10,
              playerDescription: 'A patient donkey, head down, ears twitching at flies.' } },
  { id: 'builtin:mule', name: 'Mule', builtin: true, category: 'Animal', cr: '1/8',
    entity: { type: 'Neutral Beast', name: 'Mule', color: '#6a5a42',
              hp: { current: 13, max: 13 }, ac: 10, speed: 40, initBonus: 0,
              stats: { str: 14, dex: 10, con: 13, int: 2, wis: 10, cha: 5 },
              role: 'mule', passivePerception: 10,
              playerDescription: 'A sturdy mule, laden and unimpressed.' } },

  // ==========================================================
  // v5 #11 - BESTIARY: other
  // ==========================================================
  { id: 'builtin:slime', name: 'Slime', builtin: true, category: 'Ooze', cr: '1/2',
    entity: { type: 'Monster', name: 'Slime', color: '#5a8a5a',
              hp: { current: 22, max: 22 }, ac: 8, speed: 10, initBonus: -2,
              stats: { str: 12, dex: 6, con: 13, int: 1, wis: 6, cha: 1 },
              role: 'ooze', passivePerception: 8,
              darkvision: 60,
              playerDescription: 'A translucent, shuddering mass of acidic green.' } },
];

// ====================================================================
// UTILITIES
// ====================================================================
const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

// v7 #9 / v7.2: dice roll utilities. Two shapes:
//
//   rollDice(die, qty, peerId, peerName)
//     - legacy single-die roll; returns an entry with a flat `dice`
//       array. Kept for backward compatibility with any call sites
//       that still use it.
//
//   rollDiceMixed(counts, peerId, peerName)
//     - v7.2 mixed-expression roll. `counts` is `{ 4: n, 6: n, ... }`
//       mapping die sides to quantity (0 or more, unlimited). Returns
//       an entry with a `groups` array (one per non-zero die type),
//       each containing `{ die, results: [...] }`, plus an
//       `expression` string ("4d6 + 2d8") and a `total`.
//
// Both entries sync through the same DICE_ROLL reducer which caps the
// log at 50. The renderer detects which shape by the presence of
// `groups` vs `dice`.
//
// Safety: clamps individual quantities at 100 and total dice at 200
// so a malicious or runaway client can't produce a 10,000-entry
// result that bloats the synced state.
function rollDice(die, qty, peerId, peerName) {
  const n = Math.max(1, Math.min(100, qty | 0));
  const sides = die | 0;
  const dice = [];
  for (let i = 0; i < n; i++) {
    dice.push({ die: sides, result: 1 + Math.floor(Math.random() * sides) });
  }
  const total = dice.reduce((s, d) => s + d.result, 0);
  return {
    id: uid('roll_'),
    ts: Date.now(),
    peerId,
    peerName: peerName || (peerId === 'dm' ? 'DM' : 'Player'),
    dice,
    total,
    expression: `${n}d${sides}`,
  };
}

const ALLOWED_DIE_SIDES = [4, 6, 8, 10, 12, 20];

function rollDiceMixed(counts, peerId, peerName) {
  const groups = [];
  let totalDice = 0;
  for (const s of ALLOWED_DIE_SIDES) {
    const q = Math.max(0, Math.min(100, (counts?.[s] | 0)));
    if (q <= 0) continue;
    if (totalDice + q > 200) break; // global safety cap
    const results = [];
    for (let i = 0; i < q; i++) {
      results.push(1 + Math.floor(Math.random() * s));
    }
    groups.push({ die: s, results });
    totalDice += q;
  }
  if (groups.length === 0) {
    // No dice requested - roll a single d20 as a convenience fallback
    // so a click on "Roll" with an empty tray still does something.
    groups.push({ die: 20, results: [1 + Math.floor(Math.random() * 20)] });
  }
  const total = groups.reduce(
    (s, g) => s + g.results.reduce((a, r) => a + r, 0), 0
  );
  const expression = groups
    .map(g => `${g.results.length}d${g.die}`)
    .join(' + ');
  return {
    id: uid('roll_'),
    ts: Date.now(),
    peerId,
    peerName: peerName || (peerId === 'dm' ? 'DM' : 'Player'),
    groups,
    total,
    expression,
  };
}

// v7 #7: Even-odd ray-cast point-in-polygon test. Used by both the
// block eraser hit-test and the polygon-cut commit logic. Module-level
// so it's available to all hooks regardless of declaration order.
function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1];
    const xj = pts[j][0], yj = pts[j][1];
    const intersect = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// v7.5: Distance from point (px,py) to the segment (x0,y0)-(x1,y1), in
// world units. Used by the per-drawing eraser hit-test below.
function distToSegment(px, py, x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x0, py - y0);
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy));
}

// v7.5: Hit-test a single drawing against a world-space point with a
// tolerance (also in world units). Returns true when the cursor is
// close enough to the stroke to count as "clicking on" it.
//   free   → near any segment of the polyline
//   line   → near the segment
//   circle → near the ring (the shape is a stroked outline, fill:none)
function hitTestDrawing(wx, wy, d, tol) {
  if (!d) return false;
  if (d.type === 'free' && Array.isArray(d.points)) {
    for (let i = 1; i < d.points.length; i++) {
      const a = d.points[i - 1], b = d.points[i];
      if (distToSegment(wx, wy, a[0], a[1], b[0], b[1]) <= tol) return true;
    }
    // single-point degenerate freehand
    if (d.points.length === 1) {
      return Math.hypot(wx - d.points[0][0], wy - d.points[0][1]) <= tol;
    }
    return false;
  }
  if (d.type === 'line') {
    return distToSegment(wx, wy, d.x0, d.y0, d.x1, d.y1) <= tol;
  }
  if (d.type === 'circle') {
    return Math.abs(Math.hypot(wx - d.cx, wy - d.cy) - d.r) <= tol;
  }
  return false;
}

// v7.1 #4: Polygon clipping for the freeform-polygon eraser.
// The v7 eraser deleted a block only if the entire block fell inside
// the cut polygon - not useful in practice. v7.1 implements a true
// polygon-difference (subtract) operation so partial overlaps are
// carved out of the block, leaving the remaining piece(s) intact.
//
// Strategy: convert every block shape to a polygon (rect → 4 pts,
// circle → 32 pts, poly → already one). Then compute subject - clip
// as an array of polygons using a line-by-line Sutherland-Hodgman
// approach that handles concave subjects via polygon splitting.
//
// This is not a full industrial CSG implementation - it handles the
// common case of drawing a cut across a wall well, and for overlapping
// or very concave shapes it degrades gracefully (may return the
// unclipped block rather than a malformed result). Good enough for
// a TTRPG VTT's eraser.
//
// Approach:
//   1. Clip the subject against each edge of the clip polygon
//      (Sutherland-Hodgman gives us subject ∩ clip).
//   2. For the difference we instead clip against the *reverse* of
//      each clip edge AND keep the outside half-plane.
//   3. Because the clip polygon may be concave, we subdivide it into
//      convex fans first.
//
// An even simpler, good-enough alternative is what we do here:
// APPROXIMATE THE DIFFERENCE BY RASTERIZING THE OVERLAP IN TILES.
// Way too coarse. Instead we use actual polygon math via the
// polygonClip library-free Greiner-Hormann-style routine below.

// Convert a block zone to a polygon (array of [x,y]).
function blockToPolygon(z) {
  if (z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3) {
    return z.points.map(p => [p[0], p[1]]);
  }
  if (z.type === 'circle' && typeof z.cx === 'number') {
    const pts = [];
    const N = 40;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push([z.cx + Math.cos(a) * z.r, z.cy + Math.sin(a) * z.r]);
    }
    return pts;
  }
  // Legacy rect
  return [
    [z.x, z.y],
    [z.x + z.w, z.y],
    [z.x + z.w, z.y + z.h],
    [z.x, z.y + z.h],
  ];
}

// Line-segment intersection used in fast-reject overlap testing.
function segIntersect(p1, p2, p3, p4) {
  const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
  const den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  if (Math.abs(den) < 1e-9) return null;
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den;
  const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t, u };
}

// Shoelace-area; positive if CCW.
function polyArea2(pts) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length;
    a += pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1];
  }
  return a / 2;
}

// Force CCW orientation (positive area).
function ensureCCW(pts) {
  return polyArea2(pts) < 0 ? [...pts].reverse() : pts.slice();
}

// Clip a polygon against a single half-plane: points are on the
// "inside" side of the directed edge (a → b) if cross product sign is
// positive (for CCW convention). Returns new polygon.
function clipAgainstHalfPlane(subject, a, b) {
  if (!subject.length) return [];
  const inside = (p) => {
    // Positive cross = left of edge = inside for CCW
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-9;
  };
  const intersect = (p, q) => {
    const rx = q[0] - p[0], ry = q[1] - p[1];
    const sx = b[0] - a[0], sy = b[1] - a[1];
    const denom = rx * sy - ry * sx;
    if (Math.abs(denom) < 1e-12) return p.slice();
    const t = ((a[0] - p[0]) * sy - (a[1] - p[1]) * sx) / denom;
    return [p[0] + t * rx, p[1] + t * ry];
  };
  const out = [];
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i];
    const prev = subject[(i - 1 + subject.length) % subject.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}

// Subtract a CONVEX polygon B from a polygon A. Returns array of
// resulting polygons. For each edge of B (in CCW order), we clip A
// against the OUTSIDE half-plane of that edge, yielding one piece.
// The union of those N pieces is A - B.
//
// NOTE: the returned pieces can overlap each other - their union,
// not their sum, is the mathematically correct A − B. In practice
// for a VTT eraser this is fine: blocks occlude vision regardless of
// overlap, and users draw simple cuts that don't produce pathological
// overlap. Degenerate (near-zero-area) pieces are filtered out.
function subtractConvex(subject, clip) {
  const sub = ensureCCW(subject);
  const cl = ensureCCW(clip);
  const results = [];
  for (let i = 0; i < cl.length; i++) {
    const a = cl[i], b = cl[(i + 1) % cl.length];
    // Flip the edge direction to get the OUTSIDE half-plane
    const piece = clipAgainstHalfPlane(sub, b, a);
    if (piece.length >= 3 && Math.abs(polyArea2(piece)) > 0.5) {
      results.push(piece);
    }
  }
  return results;
}

// Ear-clipping triangulation of a simple polygon (CCW).
// Returns array of triangles (each a 3-vertex polygon).
function triangulate(pts) {
  const poly = ensureCCW(pts);
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return [poly];
  const indices = poly.map((_, i) => i);
  const triangles = [];
  let safety = n * 3;
  while (indices.length > 3 && safety-- > 0) {
    let earFound = false;
    for (let i = 0; i < indices.length; i++) {
      const i0 = indices[(i - 1 + indices.length) % indices.length];
      const i1 = indices[i];
      const i2 = indices[(i + 1) % indices.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      // Convex corner check (CCW)
      const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
      if (cross <= 0) continue;
      // No other vertex inside triangle abc
      let anyInside = false;
      for (let j = 0; j < indices.length; j++) {
        const ij = indices[j];
        if (ij === i0 || ij === i1 || ij === i2) continue;
        if (pointInPoly(poly[ij][0], poly[ij][1], [a, b, c])) {
          anyInside = true; break;
        }
      }
      if (anyInside) continue;
      triangles.push([a, b, c]);
      indices.splice(i, 1);
      earFound = true;
      break;
    }
    if (!earFound) break; // degenerate; bail
  }
  if (indices.length === 3) {
    triangles.push([poly[indices[0]], poly[indices[1]], poly[indices[2]]]);
  }
  return triangles;
}

// Subtract an arbitrary (possibly concave) polygon B from A.
// Triangulate B, then subtract each triangle from all remaining pieces
// in sequence. Since triangles are convex, subtractConvex is correct.
function polygonSubtract(subject, clip) {
  if (!subject || subject.length < 3 || !clip || clip.length < 3) return [subject];

  // Exact-match check: identical polygons → empty result.
  // Handles the common case where the user draws a cut over the whole
  // block, which otherwise hits pointInPoly edge cases and degenerates.
  if (subject.length === clip.length) {
    let allSame = true;
    for (let i = 0; i < subject.length; i++) {
      if (Math.abs(subject[i][0] - clip[i][0]) > 1e-4 ||
          Math.abs(subject[i][1] - clip[i][1]) > 1e-4) { allSame = false; break; }
    }
    if (allSame) return [];
  }

  // Fast reject: no overlap → return subject
  let anyCross = false, anySubjectInClip = false;
  for (const p of subject) {
    if (pointInPoly(p[0], p[1], clip)) { anySubjectInClip = true; break; }
  }
  outer:
  for (let i = 0; i < subject.length; i++) {
    const a = subject[i], b = subject[(i + 1) % subject.length];
    for (let j = 0; j < clip.length; j++) {
      const c = clip[j], d = clip[(j + 1) % clip.length];
      if (segIntersect(a, b, c, d)) { anyCross = true; break outer; }
    }
  }
  if (!anySubjectInClip && !anyCross) return [subject];
  // Full containment check
  if (!anyCross) {
    const allIn = subject.every(p => pointInPoly(p[0], p[1], clip));
    if (allIn) return [];
  }
  const triangles = triangulate(clip);
  if (triangles.length === 0) return [subject];
  // Iterative subtraction: start with [subject], subtract each triangle
  const originalArea = Math.abs(polyArea2(subject));
  let pieces = [ensureCCW(subject)];
  for (const tri of triangles) {
    const next = [];
    for (const piece of pieces) {
      const diff = subtractConvex(piece, tri);
      for (const d of diff) if (d.length >= 3 && Math.abs(polyArea2(d)) > 0.5) next.push(d);
    }
    pieces = next;
    if (pieces.length === 0) break;
    // Safety: if pieces are exploding exponentially, bail to
    // "delete the whole block" to avoid pathological geometry.
    if (pieces.length > 64) {
      // Too many shards → treat cut as complete removal
      return [];
    }
  }
  // Sanity check: if final total area is nearly identical to original,
  // the cut didn't actually carve anything meaningful (e.g. cut
  // polygon is concave in a way our simple half-plane algorithm
  // mishandles). Fall back to "delete the block" if the cut visibly
  // overlaps the block's bounding box - it's better to delete a block
  // the user aimed at than to leave it unchanged.
  if (pieces.length > 0) {
    const totalArea = pieces.reduce((s, p) => s + Math.abs(polyArea2(p)), 0);
    if (Math.abs(totalArea - originalArea) < 0.5) {
      // Bounding-box overlap test
      let sxMin = Infinity, syMin = Infinity, sxMax = -Infinity, syMax = -Infinity;
      for (const p of subject) {
        if (p[0] < sxMin) sxMin = p[0]; if (p[0] > sxMax) sxMax = p[0];
        if (p[1] < syMin) syMin = p[1]; if (p[1] > syMax) syMax = p[1];
      }
      let cxMin = Infinity, cyMin = Infinity, cxMax = -Infinity, cyMax = -Infinity;
      for (const p of clip) {
        if (p[0] < cxMin) cxMin = p[0]; if (p[0] > cxMax) cxMax = p[0];
        if (p[1] < cyMin) cyMin = p[1]; if (p[1] > cyMax) cyMax = p[1];
      }
      const bboxOverlap = !(cxMax < sxMin || cxMin > sxMax || cyMax < syMin || cyMin > syMax);
      if (bboxOverlap) {
        // Concave cut covers subject → treat as a full delete
        // so the user sees a result instead of "nothing happened".
        return [];
      }
    }
  }
  return pieces;
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const roll = (sides) => 1 + Math.floor(Math.random() * sides);
const modFor = (stat) => Math.floor((stat - 10) / 2);

// v7.6: insert an entity into an ACTIVE initiative order, rolling its
// initiative (d20 + initBonus) unless an explicit roll is supplied. The
// entry list is re-sorted, but the turn pointer is re-anchored to whoever
// was acting so inserting mid-combat never skips or repeats a turn. No-op
// if initiative isn't active, the entity is missing, or it's already in.
function initiativeWithEntity(initiative, entities, entityId, rollValue) {
  if (!initiative || !initiative.active) return initiative;
  if (initiative.entries.some(e => e.entityId === entityId)) return initiative;
  const ent = entities[entityId];
  if (!ent) return initiative;
  const currentEntityId = initiative.entries[initiative.turn]?.entityId;
  const r = (typeof rollValue === 'number' && isFinite(rollValue))
    ? rollValue
    : roll(20) + (ent.initBonus || 0);
  const entries = [...initiative.entries, { entityId, roll: r }];
  entries.sort((a, b) =>
    b.roll - a.roll ||
    (entities[b.entityId]?.initBonus || 0) - (entities[a.entityId]?.initBonus || 0) ||
    (entities[a.entityId]?.name || '').localeCompare(entities[b.entityId]?.name || '')
  );
  let turn = initiative.turn;
  if (currentEntityId) {
    const idx = entries.findIndex(e => e.entityId === currentEntityId);
    if (idx >= 0) turn = idx;
  }
  return { ...initiative, entries, turn };
}

// v7.8: recompute the movement budget for whoever's turn it now is. Captures
// the active combatant's token position on the current map as the turn-start
// point and zeroes the used distance. Returns an empty record when combat
// v8.3: structured movement speeds. Entities may carry speeds:{walk,fly,jump};
// legacy entities have a single `speed` number (treated as the walk speed).
function walkSpeedOf(e) { const w = e?.speeds?.walk; return (w != null && w !== '') ? (Number(w) || 0) : (e?.speed > 0 ? e.speed : 30); }
function flySpeedOf(e) { return Math.max(0, Number(e?.speeds?.fly) || 0); }
function jumpSpeedOf(e) { return Math.max(0, Number(e?.speeds?.jump) || 0); }
function swimSpeedOf(e) { return Math.max(0, Number(e?.speeds?.swim) || 0); }
function climbSpeedOf(e) { return Math.max(0, Number(e?.speeds?.climb) || 0); }
// v8.10: creature presets carry fly/climb/swim only in their free-text ability
// block ("Speed: Walk 10 ft., Fly 35 ft.") and the "Flying" note - never in the
// structured `speeds` the movement system reads. Parse them out so a placed
// preset actually gets its Fly / Climb / Swim movement modes.
function deriveSpeeds(entity) {
  const text = `${entity?.abilities || ''} ${entity?.notes || ''}`;
  const speeds = { ...(entity?.speeds || {}) };
  const grab = (re) => { const m = text.match(re); return m ? Math.max(0, parseInt(m[1], 10) || 0) : 0; };
  const walk = grab(/walk\s+(\d+)\s*ft/i);
  const fly = grab(/fly\s+(\d+)\s*ft/i);
  const climb = grab(/climb\s+(\d+)\s*ft/i);
  const swim = grab(/swim\s+(\d+)\s*ft/i);
  const jump = grab(/jump\s+(\d+)\s*ft/i);
  const base = Number(entity?.speed) || walk || speeds.walk || 30;
  speeds.walk = walk || speeds.walk || base;
  if (fly) speeds.fly = fly;
  if (climb) speeds.climb = climb;
  if (swim) speeds.swim = swim;
  if (jump) speeds.jump = jump;
  // A creature flagged "Flying" with only one listed speed flies at that speed.
  if (!speeds.fly && /\bflying\b/i.test(entity?.notes || '') && base) speeds.fly = base;
  return speeds;
}

// v8.3: hazards on `mapId` whose polygon contains (x,y) and that deal damage.
function damagingHazardsAt(state, mapId, x, y) {
  const list = state.hazards?.[mapId] || [];
  return list.filter(h => h && h.damage && (h.damage.perTurn || h.damage.onEntry)
    && Array.isArray(h.points) && pointInPoly(x, y, h.points));
}
// v8.3: roll a hazard's damage payload into a flat number.
function rollHazardDamage(d) {
  if (!d) return 0;
  let total = Math.max(0, Number(d.flat) || 0);
  const count = Math.max(0, Math.min(50, Number(d.count) || 0));
  const sides = Math.max(2, Math.min(100, Number(d.sides) || 6));
  for (let i = 0; i < count; i++) total += 1 + Math.floor(Math.random() * sides);
  return total;
}
function hazardDamageLabel(d) {
  if (!d) return '';
  const dice = (d.count > 0) ? `${d.count}d${d.sides}` : '';
  const flat = (d.flat > 0) ? `${dice ? ' + ' : ''}${d.flat}` : '';
  return `${dice}${flat}${d.type ? ' ' + d.type : ''}` || '0';
}

// isn't active or the active entity has no token on the current map.
function movementReset(state, initiative) {
  const init = initiative || state.initiative;
  const empty = { entityId: null, startX: 0, startY: 0, usedFt: 0, mode: 'walk', dashed: false, jumpPending: false, budgetFt: 30 };
  if (!init || !init.active || !init.entries.length) return empty;
  const eid = init.entries[init.turn % init.entries.length]?.entityId;
  if (!eid) return empty;
  const walk = walkSpeedOf(state.entities?.[eid]);
  const tok = Object.values(state.tokens || {}).find(
    t => t.entityId === eid && t.mapId === state.currentMapId);
  const base = { entityId: eid, usedFt: 0, mode: 'walk', dashed: false, jumpPending: false, budgetFt: walk };
  if (!tok) return { ...base, startX: 0, startY: 0 };
  return { ...base, startX: tok.x, startY: tok.y };
}

const deepClone = (obj) => structuredClone(obj);

const downloadJson = (data, filename) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

// Pick a file from disk. `accept` controls the file filter (e.g. 'application/json' or 'image/*').
// `readAs` controls how the FileReader reads it: 'text' returns { file, content: string };
// 'dataUrl' returns the data URL string directly.
function pickFile(accept, readAs = 'text') {
  return new Promise((res) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return res(null);
      const reader = new FileReader();
      if (readAs === 'dataUrl') {
        reader.onload = () => res(reader.result);
        reader.readAsDataURL(file);
      } else {
        reader.onload = () => res({ file, content: reader.result });
        reader.readAsText(file);
      }
    };
    input.click();
  });
}

const pickImage = () => pickFile('image/*', 'dataUrl');

// v7.6: pick an image and downscale/compress to a ~256px JPEG data URL.
// Returns the data URL (or null if cancelled).
const pickCompressedImage = () => new Promise(async (resolve) => {
  try {
    const dataUrl = await pickImage();
    if (!dataUrl) return resolve(null);
    const img = new Image();
    img.onload = () => {
      const maxSide = 256;
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL('image/jpeg', 0.82));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  } catch { resolve(null); }
});

// ====================================================================
// DEFAULT STATE
// ====================================================================
const makeDefaultState = () => {
  const mapId = uid('map_');
  return {
    entities: {},
    maps: {
      [mapId]: {
        id: mapId,
        name: 'The World',
        type: 'world',
        parentId: null,
        imageUrl: null,
        notes: '',
        viewport: { x: 0, y: 0, zoom: 1 }
      }
    },
    tokens: {},
    initiative: { active: false, entries: [], turn: 0, round: 1 },
    // v7.8: combat movement budget for the active combatant. startX/Y is the
    // token position at the start of its turn; usedFt accumulates as it moves.
    // Reset whenever the initiative turn changes. The DM moving a token does
    // NOT touch usedFt (only player move_token on its own turn does).
    movement: { entityId: null, startX: 0, startY: 0, usedFt: 0 },
    // v7.8: when true, during active combat a player can only move the token
    // whose turn it currently is (off-turn movement is locked). DM-controlled.
    lockOffTurn: false,
    presets: {},
    currentMapId: mapId,
    forcedView: null,            // legacy (global push-view) - kept for back-compat
    forcedViewPerPeer: {},       // v3: per-peer push (peerId -> { mapId })
    claims: {},                  // v2 claim record
    entityOrder: [],
    reminders: {},               // per-user private reminder tokens
    playerThemes: {},            // v7.6: DM-pushed UI theme per peerId -> { theme, ts }
    chat: [],                    // v7.6: synced chat log [{id,ts,senderId,senderName,text,whisperTo,whisperToName}]
    mapScale: 1.0,               // global DM-controlled scale
    // v3 additions:
    timeOfDay: 0,                // 0 = bright day, 1 = deep night; smooth scalar
    blockZones: {},              // mapId -> [{id, x, y, w, h}]
    tokenPresets: {},            // DM-defined presets keyed by id: { id, name, entity: partial }
    // v6 #10: drawings - per-map shared overlay. {mapId: [drawing, ...]}
    //   freehand: {id, type:'freehand', points:[[x,y],...], color, width, owner}
    //   line    : {id, type:'line', x0,y0,x1,y1, color, width, owner}
    //   circle  : {id, type:'circle', cx,cy,r, color, width, owner}
    drawings: {},
    // v6 #9: hazard polygons - {mapId: [hazard, ...]}
    //   {id, type:'polygon', hazardKind:'fire|flood|cold|acid|fog|difficult',
    //    points:[[x,y],...], visible:true|false, label?}
    hazards: {},
    // v8.4: queue of hazard-damage events awaiting the DM's resolution.
    // Each: {id, entityId, entityName, entityColor, tokenId, hazardKind,
    //   dmgType, rolled, reason:'entry'|'turn', ts}
    hazardPending: [],
    // v7.7: per-map image layers. Each layer is an image that overlays the
    // base map (above the map image, below tokens), with its own transform
    // and interaction mode. Image bytes are offloaded to IDB and synced via
    // the same envelope as map images (keyed 'layer:<id>').
    //   layers: { [mapId]: [ {
    //     id, mapId, name,
    //     imageUrl,                 // data URL (or IMG_SENTINEL on the wire)
    //     x, y, w, h, rotation,     // world-space transform (deg)
    //     mode: 'locked'|'move'|'rotate',
    //     dmOnly,                   // true → only the DM may move/change it
    //   } ] }
    layers: {},
    // v7 #9: shared dice rolls. Capped at 50 most-recent entries.
    //   {id, ts, peerName, peerId, dice:[{die:6, result:4}, ...], total}
    diceLog: [],
    // v7 #10: DM-controlled sound playback events. The sounds themselves
    // live in IDB (sounds store); this array holds metadata + play events.
    //   sounds: { [id]: { id, name, ts } }  - registry (no audio bytes)
    //   soundEvents: [{ id, soundId, ts, action: 'play' | 'stop' }, ...]
    sounds: {},
    soundEvents: [],
    // v7.3: Token groups. DM creates named groups of placed tokens (by
    // tokenId) and can hide/reveal the whole group with one click.
    // Groups are SCOPED to a specific map - a group lives where its
    // tokens live. Moving a token to another map doesn't drag the
    // group membership with it; the DM intentionally regroups.
    //   tokenGroups: { [groupId]: {
    //     id,
    //     mapId,          // map this group belongs to
    //     name,           // user-visible label
    //     memberIds: [],  // tokenIds on that map
    //     notes?,
    //     createdTs,
    //   } }
    tokenGroups: {},
    // v7.8: player→DM approval requests. Generic queue used by the
    // new-character grant gate and (later) sheet stat/level-change asks.
    //   pendingRequests: { [id]: {
    //     id, peerId, playerName,
    //     kind: 'new_character' | 'stat_change' | 'level_change',
    //     payload, ts, status: 'pending'|'accepted'|'rejected', resolvedTs,
    //   } }
    pendingRequests: {},
    // v8.0: the one in-flight attack cinematic everyone watches. Holds the
    // pre-rolled d20 to-hit and damage dice so every client animates to the
    // same result. null when no attack is playing.
    activeAttack: null,
  };
};

const makeEntity = (overrides = {}) => ({
  id: uid('ent_'),
  name: 'Unnamed',
  type: 'PC',
  color: DEFAULT_COLORS['PC'],
  ac: 10,
  hp: { current: 10, max: 10 },
  speed: 30,
  initBonus: 0,
  passivePerception: 10,
  passiveHiding: 0,            // v7.5: stealth threshold; players see this token only if their passive perception >= this (0 = always visible)
  conditions: [],
  notes: '',
  playerDescription: '',
  imageUrl: null,
  sickness: 0,
  stats: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
  class: '', level: 1, playerName: '',
  cr: '1/4', abilities: '',
  faction: '', role: '',
  rollsInitiative: true,
  // v3 additions:
  darkvision: 0,               // feet; 0 = none
  lightRadius: 0,              // feet; 0 = no light carried
  // Bonded familiars:
  //  - bondedPeerId (v3, legacy): direct peer-id bond (fragile on reconnect)
  //  - bondedPcId (v5): bond to a PC entity id; whoever claims that PC
  //    automatically gets movement rights. Preferred going forward.
  bondedPeerId: null,
  bondedPcId: null,
  // Death save tracking (DM-only). PCs only in practice.
  deathSaves: { successes: 0, failures: 0 },
  // v7.6: expanded D&D character-sheet fields (mostly free text). money is
  // a coin purse; the rest are free-form so they fit any system/edition.
  money: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
  xp: 0,
  proficiencyBonus: 2,
  hitDice: '',
  race: '',
  background: '',
  alignment: '',
  attacks: '',         // weapons & attacks (free text - legacy)
  weapons: [],         // v7.9: structured weapons [{id,name,equipped,attacks:[{id,name,toHit,range,damage:[{count,sides,modifier,type}]}]}]
  spells: '',          // spell list / spellcasting notes
  features: '',        // features & traits
  proficiencies: '',   // proficiencies & languages
  inventory: '',       // equipment / inventory
  traits: '',          // personality traits
  ideals: '',
  bonds: '',
  flaws: '',
  backstory: '',
  ...overrides,
});

// v7.6: standard token images. Drop files in assets/tokens/ named after a
// preset (e.g. goblin.png) and they become that preset's default token
// portrait. Because there's no server-side directory listing on a static
// host, we resolve a match by probing the conventional paths with an
// <img> load and using the first one that exists. Results are cached per
// preset for the session.
const ASSET_TOKEN_DIR = 'assets/tokens';
const ASSET_TOKEN_EXTS = ['png', 'webp', 'jpg', 'jpeg', 'gif'];
const _presetImageCache = new Map(); // preset key -> Promise<string|null>
function presetAssetSlugs(preset) {
  const slugs = [];
  const suffix = String(preset.id || '').replace(/^(?:builtin|bnb):/, '');
  const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  // v7.8: also try a case-PRESERVING variant (spaces/punctuation → "_", but
  // keep the original letters) so a file named after the displayed preset
  // name, e.g. "Robin.jpg" or "Blue_Tit.png", matches on case-sensitive
  // hosts, not just the all-lowercase "robin.jpg".
  const cased = (s) => String(s || '').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const cands = [
    suffix, slugify(suffix),
    slugify(preset.name), slugify(preset.entity?.name),
    cased(preset.name), cased(preset.entity?.name),
  ];
  for (const cand of cands) {
    if (cand && !slugs.includes(cand)) slugs.push(cand);
  }
  return slugs;
}
function probeImageExists(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img.naturalWidth > 0);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}
function resolvePresetImage(preset) {
  if (!preset) return Promise.resolve(null);
  const key = preset.id || preset.name || '';
  if (_presetImageCache.has(key)) return _presetImageCache.get(key);
  const job = (async () => {
    for (const slug of presetAssetSlugs(preset)) {
      for (const ext of ASSET_TOKEN_EXTS) {
        const url = `${ASSET_TOKEN_DIR}/${slug}.${ext}`;
        if (await probeImageExists(url)) return url;
      }
    }
    return null;
  })();
  _presetImageCache.set(key, job);
  return job;
}
// v8.10: resolve a token image by the ENTITY's own name, so a plain creature
// named "Robin" (not created from a preset) still picks up assets/tokens/
// Robin.jpg. Cached per name for the session.
const _entityImageCache = new Map();
function resolveEntityImage(name) {
  const n = String(name || '').trim();
  if (!n) return Promise.resolve(null);
  if (_entityImageCache.has(n)) return _entityImageCache.get(n);
  const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const cased = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const slugs = [];
  for (const c of [cased(n), slugify(n)]) if (c && !slugs.includes(c)) slugs.push(c);
  const job = (async () => {
    for (const slug of slugs) {
      for (const ext of ASSET_TOKEN_EXTS) {
        const url = `${ASSET_TOKEN_DIR}/${slug}.${ext}`;
        if (await probeImageExists(url)) return url;
      }
    }
    return null;
  })();
  _entityImageCache.set(n, job);
  return job;
}

// Reminder tokens are per-user and live outside the synced token model.
const makeReminder = (overrides = {}) => ({
  id: uid('rem_'),
  mapId: null,
  x: 0, y: 0,
  label: '',
  color: '#c9a34a',
  size: 1,
  ...overrides,
});
// v7.6: swatches + size bounds for the per-viewer reminder editor.
const REMINDER_PALETTE = ['#c9a34a', '#d9534f', '#e08e3c', '#e8d44d', '#5cb85c', '#3aa6a0', '#5a8ec9', '#9b59b6', '#e57fb0', '#e8e8e8'];
const REMINDER_SIZE_MIN = TUNING.reminderSizeMin;
const REMINDER_SIZE_MAX = TUNING.reminderSizeMax;

// v3: block zones - DM-drawn rectangles that hide a portion of the map from
// players. Overlaid in screen space on the player map render. Also
// participates in the vision system as a line-of-sight blocker.
const makeBlockZone = (overrides = {}) => ({
  id: uid('blk_'),
  x: 0, y: 0, w: 100, h: 100,
  ...overrides,
});

// ====================================================================
// STATE MIGRATION (keeps older saved sessions forward-compatible)
// ====================================================================
function migrateState(raw) {
  if (!raw || typeof raw !== 'object') return makeDefaultState();
  const state = { ...raw };

  // Ensure entities object
  state.entities = state.entities || {};

  // Backfill missing fields on every entity. Spread order: existing values win.
  const entities = {};
  for (const [id, e] of Object.entries(state.entities)) {
    entities[id] = {
      playerDescription: '',
      imageUrl: null,
      sickness: 0,
      rollsInitiative: true,
      darkvision: 0,
      lightRadius: 0,
      bondedPeerId: null,
      bondedPcId: null,
      deathSaves: { successes: 0, failures: 0 },
      ...e,
    };
    // deathSaves might exist but be malformed
    const ds = entities[id].deathSaves;
    if (!ds || typeof ds !== 'object') {
      entities[id].deathSaves = { successes: 0, failures: 0 };
    }
  }
  state.entities = entities;

  // Build/repair entityOrder - must contain every current entity id exactly once
  const existingIds = Object.keys(state.entities);
  const prevOrder = Array.isArray(state.entityOrder) ? state.entityOrder : [];
  const seen = new Set();
  const orderedIds = [];
  for (const id of prevOrder) {
    if (state.entities[id] && !seen.has(id)) {
      orderedIds.push(id);
      seen.add(id);
    }
  }
  // Append any new entities not yet in order (alphabetical fallback)
  const missing = existingIds
    .filter(id => !seen.has(id))
    .sort((a, b) => (state.entities[a].name || '').localeCompare(state.entities[b].name || ''));
  state.entityOrder = [...orderedIds, ...missing];

  // Ensure other expected top-level keys
  state.tokens = state.tokens || {};
  state.maps = state.maps || {};
  state.presets = state.presets || {};
  state.initiative = state.initiative || { active: false, entries: [], turn: 0, round: 1 };
  // v7.8: combat movement budget
  state.movement = (state.movement && typeof state.movement === 'object')
    ? state.movement : { entityId: null, startX: 0, startY: 0, usedFt: 0 };
  state.lockOffTurn = state.lockOffTurn === true;
  if (state.forcedView === undefined) state.forcedView = null;
  if (typeof state.mapScale !== 'number' || !isFinite(state.mapScale) || state.mapScale <= 0) state.mapScale = 1.0;
  state.reminders = state.reminders && typeof state.reminders === 'object' ? state.reminders : {};
  // v3 additions
  if (typeof state.timeOfDay !== 'number' || !isFinite(state.timeOfDay)) state.timeOfDay = 0;
  state.timeOfDay = clamp(state.timeOfDay, 0, 1);
  state.forcedViewPerPeer = state.forcedViewPerPeer && typeof state.forcedViewPerPeer === 'object' ? state.forcedViewPerPeer : {};
  state.blockZones = state.blockZones && typeof state.blockZones === 'object' ? state.blockZones : {};
  // v6: drawings and hazards - both keyed by mapId, arrays of shapes.
  state.drawings = state.drawings && typeof state.drawings === 'object' ? state.drawings : {};
  state.hazards = state.hazards && typeof state.hazards === 'object' ? state.hazards : {};
  state.hazardPending = Array.isArray(state.hazardPending) ? state.hazardPending : [];
  // v7.7: per-map image layers
  state.layers = state.layers && typeof state.layers === 'object' ? state.layers : {};
  // v7.8: player→DM request queue
  state.pendingRequests = state.pendingRequests && typeof state.pendingRequests === 'object' ? state.pendingRequests : {};
  // v7: dice + sounds backfills
  state.diceLog = Array.isArray(state.diceLog) ? state.diceLog : [];
  state.sounds = state.sounds && typeof state.sounds === 'object' ? state.sounds : {};
  state.soundEvents = Array.isArray(state.soundEvents) ? state.soundEvents : [];
  // v7.3: token groups. Sanitize: group must have id, mapId, name,
  // and a memberIds array. Prune references to tokens that no longer
  // exist on this map.
  {
    const cleanGroups = {};
    const incoming = (state.tokenGroups && typeof state.tokenGroups === 'object')
      ? state.tokenGroups : {};
    for (const [id, g] of Object.entries(incoming)) {
      if (!g || typeof g !== 'object') continue;
      if (!g.id || !g.mapId || typeof g.name !== 'string') continue;
      const validMembers = Array.isArray(g.memberIds)
        ? g.memberIds.filter(tid => {
            const t = state.tokens?.[tid];
            return t && t.mapId === g.mapId;
          })
        : [];
      cleanGroups[id] = {
        id: g.id,
        mapId: g.mapId,
        name: g.name.slice(0, 80),
        memberIds: validMembers,
        notes: typeof g.notes === 'string' ? g.notes.slice(0, 400) : '',
        createdTs: g.createdTs || Date.now(),
      };
    }
    state.tokenGroups = cleanGroups;
  }
  state.tokenPresets = state.tokenPresets && typeof state.tokenPresets === 'object' ? state.tokenPresets : {};

  // v2 claim model migration: `claimedPCs` (peerId -> entityId) becomes
  // `claims` (peerId -> { pc, familiars, playerName, spectator }).
  if (!state.claims || typeof state.claims !== 'object') state.claims = {};
  if (state.claimedPCs && typeof state.claimedPCs === 'object') {
    for (const [peerId, entId] of Object.entries(state.claimedPCs)) {
      if (!state.claims[peerId]) {
        state.claims[peerId] = { pc: entId || null, familiars: [], playerName: '', spectator: false };
      } else if (!state.claims[peerId].pc) {
        state.claims[peerId].pc = entId || null;
      }
    }
  }
  // Normalize every claim record so downstream code can trust its shape.
  const normalizedClaims = {};
  for (const [peerId, claim] of Object.entries(state.claims)) {
    const c = claim && typeof claim === 'object' ? claim : {};
    normalizedClaims[peerId] = {
      pc: c.pc || null,
      familiars: Array.isArray(c.familiars) ? c.familiars.filter(id => state.entities[id]) : [],
      playerName: typeof c.playerName === 'string' ? c.playerName : '',
      spectator: !!c.spectator,
      // v4 fix #7: preserve stable per-device identity on the claim
      playerId: typeof c.playerId === 'string' ? c.playerId : null,
    };
  }
  state.claims = normalizedClaims;
  delete state.claimedPCs; // stop storing the legacy shape

  // Ensure every token has visibility + scale
  const tokens = {};
  for (const [id, t] of Object.entries(state.tokens)) {
    tokens[id] = { visible: false, scale: 1.0, ...t };
    if (typeof tokens[id].scale !== 'number' || !isFinite(tokens[id].scale) || tokens[id].scale <= 0) {
      tokens[id].scale = 1.0;
    }
  }
  state.tokens = tokens;

  return state;
}

// ====================================================================
// STATE REDUCER
// ====================================================================
function reducer(state, action) {
  switch (action.type) {
    case 'HYDRATE': return action.state || state;
    case 'REPLACE': {
      // v7.2: the player receives broadcasts with imageUrl stripped to
      // IMG_SENTINEL. If we have hydrated bytes for a map locally
      // (from an earlier map_image envelope or IDB cache), we preserve
      // them instead of replacing with the sentinel marker. This is
      // what makes the map layer continue rendering after every
      // subsequent state_update.
      const incoming = action.payload || {};
      const currentMaps = state.maps || {};
      const incomingMaps = incoming.maps || {};
      const mergedMaps = {};
      for (const [id, m] of Object.entries(incomingMaps)) {
        if (m?.imageUrl === IMG_SENTINEL && currentMaps[id]?.imageUrl
            && currentMaps[id].imageUrl !== IMG_SENTINEL) {
          mergedMaps[id] = { ...m, imageUrl: currentMaps[id].imageUrl };
        } else {
          mergedMaps[id] = m;
        }
      }
      // v7.7: same preservation for per-map layer images.
      const currentLayers = state.layers || {};
      const incomingLayers = incoming.layers || {};
      const mergedLayers = {};
      for (const [mid, list] of Object.entries(incomingLayers)) {
        const curList = currentLayers[mid] || [];
        const curById = {};
        for (const cl of curList) curById[cl.id] = cl;
        mergedLayers[mid] = (Array.isArray(list) ? list : []).map(l => {
          if (l?.imageUrl === IMG_SENTINEL && curById[l.id]?.imageUrl
              && curById[l.id].imageUrl !== IMG_SENTINEL) {
            return { ...l, imageUrl: curById[l.id].imageUrl };
          }
          return l;
        });
      }
      return migrateState({ ...incoming, maps: mergedMaps, layers: mergedLayers });
    }

    // v7.7: layer image bytes arrived via the image envelope (layerId set).
    case 'LAYER_IMAGE_RECEIVED': {
      const list = state.layers?.[action.mapId];
      if (!Array.isArray(list)) return state;
      return {
        ...state,
        layers: {
          ...state.layers,
          [action.mapId]: list.map(l => l.id === action.layerId ? { ...l, imageUrl: action.dataUrl } : l),
        },
      };
    }
    // v7.7: add a new layer to a map.
    case 'LAYER_ADD': {
      const mid = action.layer.mapId;
      const list = state.layers?.[mid] || [];
      return { ...state, layers: { ...(state.layers || {}), [mid]: [...list, action.layer] } };
    }
    // v7.7: patch a layer's transform / mode / dmOnly.
    case 'LAYER_UPDATE': {
      const mid = action.mapId;
      const list = state.layers?.[mid];
      if (!Array.isArray(list)) return state;
      return {
        ...state,
        layers: {
          ...state.layers,
          [mid]: list.map(l => l.id === action.id ? { ...l, ...action.patch } : l),
        },
      };
    }
    // v7.7: remove a layer.
    case 'LAYER_DELETE': {
      const mid = action.mapId;
      const list = state.layers?.[mid];
      if (!Array.isArray(list)) return state;
      return { ...state, layers: { ...state.layers, [mid]: list.filter(l => l.id !== action.id) } };
    }
    // v7.8: player→DM approval requests.
    case 'REQUEST_ADD': {
      return { ...state, pendingRequests: { ...(state.pendingRequests || {}), [action.request.id]: action.request } };
    }
    case 'REQUEST_RESOLVE': {
      const r = state.pendingRequests?.[action.id];
      if (!r) return state;
      return {
        ...state,
        pendingRequests: { ...state.pendingRequests, [action.id]: { ...r, status: action.status, resolvedTs: Date.now() } },
      };
    }
    case 'REQUEST_REMOVE': {
      if (!state.pendingRequests?.[action.id]) return state;
      const next = { ...state.pendingRequests };
      delete next[action.id];
      return { ...state, pendingRequests: next };
    }
    // v8.0: shared attack cinematic. ATTACK_SET starts it (everyone watches),
    // ATTACK_CLEAR ends it once the DM resolves or it misses.
    case 'ATTACK_SET': {
      return { ...state, activeAttack: action.attack };
    }
    case 'ATTACK_CLEAR': {
      if (!state.activeAttack) return state;
      if (action.id && state.activeAttack.id !== action.id) return state;
      return { ...state, activeAttack: null };
    }
    // v8.2: merge a patch into the live attack (DM toggling advantage, recording
    // the saving-throw result, etc.). Ignored if no attack is playing.
    case 'ATTACK_UPDATE': {
      if (!state.activeAttack) return state;
      if (action.id && state.activeAttack.id !== action.id) return state;
      return { ...state, activeAttack: { ...state.activeAttack, ...action.patch } };
    }

    // v7.2: map image bytes arrived via map_image envelope - merge into
    // the named map slot. Dispatched by Session on receipt of a
    // map_image from the DM.
    case 'MAP_IMAGE_RECEIVED': {
      const m = state.maps?.[action.mapId];
      if (!m) return state;
      return {
        ...state,
        maps: { ...state.maps, [action.mapId]: { ...m, imageUrl: action.dataUrl } },
      };
    }

    // v7.2: ephemeral token move. Updates just this one token's
    // coordinates without any of the full-state side effects. Used by
    // players to render remote drag motion in real time without
    // waiting for the debounced state_update.
    case 'TOKEN_MOVE_EPHEMERAL': {
      const t = state.tokens?.[action.tokenId];
      if (!t) return state;
      if (action.mapId && t.mapId !== action.mapId) return state;
      return {
        ...state,
        tokens: { ...state.tokens, [action.tokenId]: { ...t, x: action.x, y: action.y } },
      };
    }

    // Entities
    case 'ENTITY_UPSERT': {
      const isNew = !state.entities[action.entity.id];
      const entities = { ...state.entities, [action.entity.id]: action.entity };
      const entityOrder = isNew
        ? [...(state.entityOrder || []), action.entity.id]
        : (state.entityOrder || []);
      return { ...state, entities, entityOrder };
    }
    case 'ENTITY_DELETE': {
      const { [action.id]: _removed, ...rest } = state.entities;
      const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([_, t]) => t.entityId !== action.id));
      const initEntries = state.initiative.entries.filter(e => e.entityId !== action.id);
      // Clear this entity from every peer's claim (pc and familiars)
      const claims = {};
      for (const [peerId, c] of Object.entries(state.claims || {})) {
        claims[peerId] = {
          ...c,
          pc: c.pc === action.id ? null : c.pc,
          familiars: (c.familiars || []).filter(fid => fid !== action.id),
        };
      }
      const entityOrder = (state.entityOrder || []).filter(id => id !== action.id);
      return {
        ...state,
        entities: rest,
        tokens,
        initiative: { ...state.initiative, entries: initEntries },
        claims,
        entityOrder,
      };
    }
    case 'ENTITY_REORDER': {
      // action.order: array of entity ids (DM's new explicit ordering)
      // Re-sync with current entities to avoid ghosts
      const existing = new Set(Object.keys(state.entities));
      const seen = new Set();
      const next = [];
      for (const id of action.order) {
        if (existing.has(id) && !seen.has(id)) { next.push(id); seen.add(id); }
      }
      // Append any entities not yet in order (safety)
      for (const id of Object.keys(state.entities)) {
        if (!seen.has(id)) next.push(id);
      }
      return { ...state, entityOrder: next };
    }
    case 'ENTITY_HP_ADJUST': {
      const e = state.entities[action.id];
      if (!e) return state;
      const cur = clamp(e.hp.current + action.delta, 0, e.hp.max);
      const updated = { ...e, hp: { ...e.hp, current: cur } };
      if (cur === 0) {
        // v4 fix #17: PCs go Unconscious (so they can roll death saves).
        // v5 fix #9: Objects get "Broken", not "Dead" - they aren't alive.
        // Everything else (Monster, NPC, Familiar, Neutral Beast) goes Dead.
        let targetCond;
        if (e.type === 'PC') targetCond = 'Unconscious';
        else if (e.type === 'Object') targetCond = 'Broken';
        else targetCond = 'Dead';
        if (!updated.conditions.includes(targetCond)) {
          updated.conditions = [...updated.conditions, targetCond];
        }
      } else {
        // Healed back above 0 - clear auto-applied status so repair or
        // healing just works. Unconscious stays unless explicitly cleared,
        // matching D&D RAW.
        if (updated.conditions.includes('Dead')) {
          updated.conditions = updated.conditions.filter(c => c !== 'Dead');
        }
        if (updated.conditions.includes('Broken')) {
          updated.conditions = updated.conditions.filter(c => c !== 'Broken');
        }
      }
      return { ...state, entities: { ...state.entities, [action.id]: updated } };
    }
    case 'ENTITY_TOGGLE_CONDITION': {
      const e = state.entities[action.id];
      if (!e) return state;
      const has = e.conditions.includes(action.condition);
      return {
        ...state,
        entities: {
          ...state.entities,
          [action.id]: {
            ...e,
            conditions: has
              ? e.conditions.filter(c => c !== action.condition)
              : [...e.conditions, action.condition]
          }
        }
      };
    }

    // Maps
    case 'MAP_UPSERT':
      return { ...state, maps: { ...state.maps, [action.map.id]: action.map } };
    case 'MAP_DELETE': {
      if (Object.keys(state.maps).length <= 1) return state;
      const { [action.id]: _r, ...rest } = state.maps;
      const tokens = Object.fromEntries(Object.entries(state.tokens).filter(([_, t]) => t.mapId !== action.id));
      let currentMapId = state.currentMapId;
      if (currentMapId === action.id) currentMapId = Object.keys(rest)[0];
      // reparent children
      const maps = Object.fromEntries(Object.entries(rest).map(([k, v]) => [
        k, v.parentId === action.id ? { ...v, parentId: null } : v
      ]));
      return { ...state, maps, tokens, currentMapId };
    }
    case 'MAP_SWITCH':
      return { ...state, currentMapId: action.id };
    case 'MAP_VIEWPORT':
      return {
        ...state,
        maps: {
          ...state.maps,
          [action.id]: { ...state.maps[action.id], viewport: action.viewport }
        }
      };

    // Tokens
    case 'TOKEN_PLACE': {
      // prevent duplicate placement per map per entity
      const existing = Object.values(state.tokens).find(
        t => t.entityId === action.token.entityId && t.mapId === action.token.mapId
      );
      if (existing) return state;
      const tokens = { ...state.tokens, [action.token.id]: action.token };
      // v7.6: if combat is underway on this map, a freshly-placed token
      // immediately rolls and joins the initiative order.
      let initiative = state.initiative;
      if (initiative?.active && action.token.mapId === state.currentMapId) {
        initiative = initiativeWithEntity(initiative, state.entities, action.token.entityId);
      }
      return { ...state, tokens, initiative };
    }
    case 'TOKEN_MOVE': {
      const t = state.tokens[action.id];
      if (!t) return state;
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, x: action.x, y: action.y } } };
    }
    // v6 #12: batched token move for group-drag. Takes an array of
    // { id, x, y } moves, applies them all atomically so persist and
    // sync broadcast run once.
    case 'TOKEN_MOVE_MANY': {
      const moves = action.moves || [];
      if (!moves.length) return state;
      const tokens = { ...state.tokens };
      for (const m of moves) {
        const t = tokens[m.id];
        if (!t) continue;
        tokens[m.id] = { ...t, x: m.x, y: m.y };
      }
      return { ...state, tokens };
    }
    case 'TOKEN_REMOVE': {
      const { [action.id]: _r, ...rest } = state.tokens;
      // v7.3: prune this tokenId from any group that listed it.
      // Keeps groups tidy without needing a separate sweep.
      let groups = state.tokenGroups;
      if (groups && typeof groups === 'object') {
        let groupsChanged = false;
        const nextGroups = {};
        for (const [gid, g] of Object.entries(groups)) {
          if ((g.memberIds || []).includes(action.id)) {
            nextGroups[gid] = { ...g, memberIds: g.memberIds.filter(x => x !== action.id) };
            groupsChanged = true;
          } else {
            nextGroups[gid] = g;
          }
        }
        if (groupsChanged) groups = nextGroups;
      }
      return { ...state, tokens: rest, tokenGroups: groups };
    }
    case 'TOKEN_VISIBILITY': {
      const t = state.tokens[action.id];
      if (!t) return state;
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, visible: action.visible } } };
    }
    case 'TOKEN_REVEAL_ALL_ON_MAP': {
      const tokens = Object.fromEntries(Object.entries(state.tokens).map(([k, t]) => [
        k, t.mapId === action.mapId ? { ...t, visible: action.visible } : t
      ]));
      return { ...state, tokens };
    }

    // Initiative
    case 'INIT_SET': {
      const initiative = action.initiative;
      return { ...state, initiative, movement: movementReset(state, initiative) };
    }
    // v7.6: add (or re-add) a single entity to the active order, rolling
    // its initiative. Used by the "add back to initiative" UI.
    case 'INIT_ADD':
      return { ...state, initiative: initiativeWithEntity(state.initiative, state.entities, action.entityId, action.roll) };
    case 'INIT_ADVANCE': {
      const { entries } = state.initiative;
      if (!entries.length) return state;
      const nextTurn = (state.initiative.turn + 1) % entries.length;
      const round = nextTurn === 0 ? state.initiative.round + 1 : state.initiative.round;
      const initiative = { ...state.initiative, turn: nextTurn, round };
      // v7.8: a new turn begins -> the active combatant's movement resets.
      return { ...state, initiative, movement: movementReset(state, initiative) };
    }
    // v7.8: a player spent movement on its turn (DM-authoritative). The DM
    // moving a token goes through plain TOKEN_MOVE and never lands here.
    case 'MOVEMENT_USE': {
      const mv = state.movement;
      if (!mv || !mv.entityId) return state;
      // v8.3: a jump burst is a one-move action that does NOT consume walk
      // movement; right after it lands the mover reverts to their remaining
      // walk (or fly) budget, even if they jumped less than their full range.
      if (mv.jumpPending) {
        const ent = state.entities[mv.entityId];
        const base = (mv.preMode === 'fly') ? flySpeedOf(ent) : (mv.preMode === 'swim') ? swimSpeedOf(ent) : (mv.preMode === 'climb') ? climbSpeedOf(ent) : walkSpeedOf(ent);
        return { ...state, movement: {
          ...mv, jumpPending: false, mode: mv.preMode || 'walk',
          usedFt: (mv.preJumpUsedFt != null) ? mv.preJumpUsedFt : (mv.usedFt || 0),
          budgetFt: base * (mv.dashed ? 2 : 1),
        } };
      }
      return { ...state, movement: { ...mv, usedFt: (mv.usedFt || 0) + Math.max(0, action.addFt || 0) } };
    }
    // v8.3: change the active mover's movement mode for this turn (dash / fly /
    // walk / jump). Only the current mover may change it. Keeps usedFt so a
    // partial move already spent still counts.
    case 'MOVEMENT_MODE': {
      const mv = state.movement;
      if (!mv || !mv.entityId || mv.entityId !== action.entityId) return state;
      const ent = state.entities[mv.entityId];
      const walk = walkSpeedOf(ent), fly = flySpeedOf(ent), jump = jumpSpeedOf(ent);
      if (action.mode === 'dash') {
        const base = (mv.mode === 'fly') ? fly : (mv.mode === 'swim') ? swimSpeedOf(ent) : (mv.mode === 'climb') ? climbSpeedOf(ent) : walk;
        return { ...state, movement: { ...mv, dashed: true, jumpPending: false, budgetFt: base * 2 } };
      }
      if (action.mode === 'fly') {
        if (fly <= 0) return state;
        return { ...state, movement: { ...mv, mode: 'fly', jumpPending: false, budgetFt: fly * (mv.dashed ? 2 : 1) } };
      }
      if (action.mode === 'swim') {
        const swim = swimSpeedOf(ent);
        if (swim <= 0) return state;
        return { ...state, movement: { ...mv, mode: 'swim', jumpPending: false, budgetFt: swim * (mv.dashed ? 2 : 1) } };
      }
      if (action.mode === 'climb') {
        const climb = climbSpeedOf(ent);
        if (climb <= 0) return state;
        return { ...state, movement: { ...mv, mode: 'climb', jumpPending: false, budgetFt: climb * (mv.dashed ? 2 : 1) } };
      }
      if (action.mode === 'walk') {
        return { ...state, movement: { ...mv, mode: 'walk', jumpPending: false, budgetFt: walk * (mv.dashed ? 2 : 1) } };
      }
      if (action.mode === 'jump') {
        if (jump <= 0) return state;
        // arm a one-move jump burst: allow up to jumpSpeed beyond the spent walk.
        return { ...state, movement: { ...mv, jumpPending: true, preMode: mv.mode, preJumpUsedFt: (mv.usedFt || 0), budgetFt: (mv.usedFt || 0) + jump } };
      }
      return state;
    }
    // v7.8: toggle the off-turn movement lock.
    case 'SET_LOCK_OFF_TURN':
      return { ...state, lockOffTurn: action.value === true };

    // Presets
    case 'PRESET_SAVE':
      return { ...state, presets: { ...state.presets, [action.preset.id]: action.preset } };
    case 'PRESET_DELETE': {
      const { [action.id]: _r, ...rest } = state.presets;
      return { ...state, presets: rest };
    }

    // Forced view
    case 'FORCED_VIEW': return { ...state, forcedView: action.forcedView };

    // Player map override

    // v2: unified claim model
    case 'CLAIM_PC': {
      // Atomic: any other peer that claims this PC loses it first.
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = (p !== action.peerId && c.pc === action.entityId)
          ? { ...c, pc: null }
          : c;
      }
      const prev = nextClaims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      nextClaims[action.peerId] = {
        ...prev,
        pc: action.entityId,
        playerName: action.playerName || prev.playerName || '',
        spectator: false,
      };
      return { ...state, claims: nextClaims };
    }
    case 'UNCLAIM_PC': {
      const prev = state.claims[action.peerId];
      if (!prev) return state;
      return {
        ...state,
        claims: { ...state.claims, [action.peerId]: { ...prev, pc: null } }
      };
    }
    case 'DM_UNCLAIM_PC': {
      // DM-initiated removal of a claim. Scans every peer and clears matching PC.
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = c.pc === action.entityId ? { ...c, pc: null } : c;
      }
      return { ...state, claims: nextClaims };
    }
    case 'CLAIM_FAMILIAR': {
      // Familiars can be claimed by multiple peers? No - one peer per familiar,
      // but a single peer can claim multiple familiars. Transfer semantics.
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = (p !== action.peerId && c.familiars.includes(action.entityId))
          ? { ...c, familiars: c.familiars.filter(id => id !== action.entityId) }
          : c;
      }
      const prev = nextClaims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      const nextFamiliars = prev.familiars.includes(action.entityId)
        ? prev.familiars
        : [...prev.familiars, action.entityId];
      nextClaims[action.peerId] = { ...prev, familiars: nextFamiliars, spectator: false };
      return { ...state, claims: nextClaims };
    }
    case 'UNCLAIM_FAMILIAR': {
      const prev = state.claims[action.peerId];
      if (!prev) return state;
      return {
        ...state,
        claims: {
          ...state.claims,
          [action.peerId]: { ...prev, familiars: prev.familiars.filter(id => id !== action.entityId) }
        }
      };
    }
    case 'DM_UNCLAIM_FAMILIAR': {
      const nextClaims = {};
      for (const [p, c] of Object.entries(state.claims)) {
        nextClaims[p] = c.familiars.includes(action.entityId)
          ? { ...c, familiars: c.familiars.filter(id => id !== action.entityId) }
          : c;
      }
      return { ...state, claims: nextClaims };
    }
    // v7.9: temporary control - the DM lends another PC to a player. The player
    // can then move and act as that PC (e.g. cover for an absent friend). This
    // is separate from claiming: the PC's real claim is untouched.
    case 'GRANT_PC_CONTROL': {
      const prev = state.claims[action.peerId];
      if (!prev) return state;
      const list = prev.controlledPcs || [];
      if (list.includes(action.entityId)) return state;
      return { ...state, claims: { ...state.claims, [action.peerId]: { ...prev, controlledPcs: [...list, action.entityId] } } };
    }
    case 'REVOKE_PC_CONTROL': {
      const prev = state.claims[action.peerId];
      if (!prev) return state;
      return { ...state, claims: { ...state.claims, [action.peerId]: { ...prev, controlledPcs: (prev.controlledPcs || []).filter(id => id !== action.entityId) } } };
    }
    case 'CLAIM_SPECTATOR': {
      const prev = state.claims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      return {
        ...state,
        claims: {
          ...state.claims,
          [action.peerId]: { ...prev, spectator: true, pc: null, familiars: [], playerName: action.playerName || prev.playerName }
        }
      };
    }
    case 'SET_PLAYER_NAME': {
      const prev = state.claims[action.peerId] || { pc: null, familiars: [], playerName: '', spectator: false };
      return {
        ...state,
        claims: { ...state.claims, [action.peerId]: { ...prev, playerName: action.playerName || '' } }
      };
    }

    // v2: Sickness (DM-only write path, enforced at action sites not reducer)
    case 'SET_SICKNESS': {
      const e = state.entities[action.id];
      if (!e) return state;
      const lvl = clamp(Number(action.level) || 0, 0, 3);
      return { ...state, entities: { ...state.entities, [action.id]: { ...e, sickness: lvl } } };
    }

    // v2: Token scale
    case 'TOKEN_SCALE': {
      const t = state.tokens[action.id];
      if (!t) return state;
      const s = clamp(Number(action.scale) || 1, 0.3, 4);
      return { ...state, tokens: { ...state.tokens, [action.id]: { ...t, scale: s } } };
    }

    // v2: global map-vs-token scale
    case 'MAP_SCALE_SET': {
      const s = clamp(Number(action.scale) || 1, 0.3, 3);
      return { ...state, mapScale: s };
    }

    // v2: reminder tokens (per-peer, DM treated as a peer too via its own key)
    case 'REMINDER_UPSERT': {
      const peerId = action.peerId;
      const list = state.reminders[peerId] || [];
      const idx = list.findIndex(r => r.id === action.reminder.id);
      const nextList = idx === -1 ? [...list, action.reminder] : list.map(r => r.id === action.reminder.id ? action.reminder : r);
      return { ...state, reminders: { ...state.reminders, [peerId]: nextList } };
    }
    case 'REMINDER_DELETE': {
      const peerId = action.peerId;
      const list = state.reminders[peerId] || [];
      return { ...state, reminders: { ...state.reminders, [peerId]: list.filter(r => r.id !== action.id) } };
    }

    // v7.6: DM pushes a UI theme to one or more players. `targets` is a list
    // of peerIds; `theme` is a theme id (or '' to release). `ts` is a
    // monotonic stamp so each push is applied exactly once on the client.
    case 'SET_PLAYER_THEME': {
      const targets = action.targets || [];
      const next = { ...(state.playerThemes || {}) };
      for (const pid of targets) {
        if (!pid) continue;
        if (action.theme) next[pid] = { theme: action.theme, ts: action.ts || Date.now() };
        else delete next[pid];
      }
      return { ...state, playerThemes: next };
    }

    // v7.6: chat. Append a message, keeping the most recent CHAT_MAX.
    case 'CHAT_ADD': {
      const m = action.message;
      if (!m || typeof m.text !== 'string') return state;
      const text = m.text.trim().slice(0, 2000); // v8.9: cap here so it's structural, not just enforced at the player action site
      if (!text) return state;
      const next = [...(state.chat || []), { ...m, text }];
      if (next.length > CHAT_MAX) next.splice(0, next.length - CHAT_MAX);
      return { ...state, chat: next };
    }
    case 'CHAT_CLEAR':
      return { ...state, chat: [] };

    // v3: generic safe patch on an entity (whitelist enforced at the
    // ACTION site, not here - reducer just applies the given field set).
    case 'ENTITY_PATCH': {
      const e = state.entities[action.id];
      if (!e) return state;
      const patch = action.patch || {};
      // Deep-merge hp and stats when partially specified
      const next = { ...e, ...patch };
      if (patch.hp) next.hp = { ...e.hp, ...patch.hp };
      if (patch.stats) next.stats = { ...e.stats, ...patch.stats };
      if (patch.money) next.money = { ...(e.money || {}), ...patch.money };
      if (patch.deathSaves) next.deathSaves = { ...e.deathSaves, ...patch.deathSaves };
      // Re-clamp hp.current to [0, hp.max] if either changed
      if (patch.hp || patch.hp === 0) {
        next.hp.current = clamp(next.hp.current || 0, 0, next.hp.max || 0);
      }
      return { ...state, entities: { ...state.entities, [action.id]: next } };
    }

    // v3: death save counters (DM-only writes; action-site enforced)
    case 'DEATH_SAVE_SET': {
      const e = state.entities[action.id];
      if (!e) return state;
      const ds = {
        successes: clamp(Number(action.successes ?? e.deathSaves.successes), 0, 3),
        failures:  clamp(Number(action.failures  ?? e.deathSaves.failures),  0, 3),
      };
      return { ...state, entities: { ...state.entities, [action.id]: { ...e, deathSaves: ds } } };
    }
    case 'DEATH_SAVE_CLEAR': {
      const e = state.entities[action.id];
      if (!e) return state;
      return { ...state, entities: { ...state.entities, [action.id]: { ...e, deathSaves: { successes: 0, failures: 0 } } } };
    }

    // v3: Long rest - restore HP to max for target entities, clear specific
    // recoverable conditions, reset sickness to 0, reset death saves.
    case 'LONG_REST': {
      // action.entityIds may be an array (rest these specific ones) or
      // omitted (rest all PCs + Familiars).
      const targetIds = Array.isArray(action.entityIds)
        ? action.entityIds
        : Object.values(state.entities).filter(e => e.type === 'PC' || e.type === 'Familiar').map(e => e.id);
      const CLEARED = new Set(['Unconscious','Exhausted','Poisoned','Frightened','Blinded','Deafened','Charmed','Stunned','Paralyzed','Prone','Restrained','Incapacitated','Grappled','On Fire','Bleeding','Slowed']);
      const entities = { ...state.entities };
      for (const id of targetIds) {
        const e = entities[id];
        if (!e) continue;
        // v7 fix #8: Long rest no longer resets sickness. Sickness is a
        // long-arc condition that the DM controls explicitly via the
        // sickness controls in the World panel - a night's rest doesn't
        // clear it.
        entities[id] = {
          ...e,
          hp: { ...e.hp, current: e.hp.max },
          conditions: e.conditions.filter(c => !CLEARED.has(c)),
          deathSaves: { successes: 0, failures: 0 },
        };
      }
      return { ...state, entities };
    }

    // v7.5: Short rest - restore half of MAX HP (rounded up), capped at
    // max. Deliberately lighter than a long rest: conditions and sickness
    // are NOT cleared. If the heal lifts a downed creature above 0 HP, we
    // clear Unconscious and reset death saves so they're no longer dying.
    case 'SHORT_REST': {
      const targetIds = Array.isArray(action.entityIds)
        ? action.entityIds
        : Object.values(state.entities).filter(e => e.type === 'PC' || e.type === 'Familiar').map(e => e.id);
      const entities = { ...state.entities };
      for (const id of targetIds) {
        const e = entities[id];
        if (!e) continue;
        const max = e.hp?.max ?? 0;
        const heal = Math.ceil(max / 2);
        const current = Math.min(max, (e.hp?.current ?? 0) + heal);
        const patch = { ...e, hp: { ...e.hp, current } };
        if (current > 0) {
          patch.conditions = e.conditions.filter(c => c !== 'Unconscious');
          patch.deathSaves = { successes: 0, failures: 0 };
        }
        entities[id] = patch;
      }
      return { ...state, entities };
    }

    // v3: Time of day (scalar, 0=day, 1=deep night)
    case 'TIME_OF_DAY_SET':
      return { ...state, timeOfDay: clamp(Number(action.value) || 0, 0, 1) };

    // v3: Per-peer push-view. Works alongside legacy global `forcedView`.
    case 'FORCED_VIEW_PEER_SET': {
      const next = { ...(state.forcedViewPerPeer || {}) };
      if (action.mapId == null) delete next[action.peerId];
      else next[action.peerId] = { mapId: action.mapId };
      return { ...state, forcedViewPerPeer: next };
    }
    case 'FORCED_VIEW_PEER_CLEAR_ALL':
      return { ...state, forcedViewPerPeer: {} };

    // v3: Block zones per map
    case 'BLOCK_ZONE_UPSERT': {
      const mapId = action.mapId;
      const list = state.blockZones[mapId] || [];
      const idx = list.findIndex(z => z.id === action.zone.id);
      const next = idx === -1 ? [...list, action.zone] : list.map(z => z.id === action.zone.id ? action.zone : z);
      return { ...state, blockZones: { ...state.blockZones, [mapId]: next } };
    }
    case 'BLOCK_ZONE_DELETE': {
      const mapId = action.mapId;
      const list = state.blockZones[mapId] || [];
      return { ...state, blockZones: { ...state.blockZones, [mapId]: list.filter(z => z.id !== action.id) } };
    }
    case 'BLOCK_ZONE_CLEAR_MAP':
      return { ...state, blockZones: { ...state.blockZones, [action.mapId]: [] } };

    // v6 #10: Drawing overlays - freehand + line + circle.
    //   DRAWING_UPSERT: add or replace a drawing on a map
    //   DRAWING_DELETE: remove one by id
    //   DRAWING_CLEAR_MAP: wipe all drawings on a map
    //   DRAWING_CLEAR_OWNER: wipe all drawings by one owner on a map
    case 'DRAWING_UPSERT': {
      const { mapId, drawing } = action;
      if (!mapId || !drawing?.id) return state;
      const list = state.drawings?.[mapId] || [];
      const i = list.findIndex(d => d.id === drawing.id);
      const next = i === -1 ? [...list, drawing] : list.map(d => d.id === drawing.id ? drawing : d);
      return { ...state, drawings: { ...(state.drawings || {}), [mapId]: next } };
    }
    case 'DRAWING_DELETE': {
      const { mapId, id } = action;
      const list = state.drawings?.[mapId] || [];
      return { ...state, drawings: { ...(state.drawings || {}), [mapId]: list.filter(d => d.id !== id) } };
    }
    case 'DRAWING_CLEAR_MAP':
      return { ...state, drawings: { ...(state.drawings || {}), [action.mapId]: [] } };
    case 'DRAWING_CLEAR_OWNER': {
      const list = state.drawings?.[action.mapId] || [];
      return { ...state, drawings: { ...(state.drawings || {}), [action.mapId]: list.filter(d => d.owner !== action.owner) } };
    }

    // v6 #9: Hazard polygons - environmental effects on a map.
    case 'HAZARD_UPSERT': {
      const { mapId, hazard } = action;
      if (!mapId || !hazard?.id) return state;
      const list = state.hazards?.[mapId] || [];
      const i = list.findIndex(h => h.id === hazard.id);
      const next = i === -1 ? [...list, hazard] : list.map(h => h.id === hazard.id ? hazard : h);
      return { ...state, hazards: { ...(state.hazards || {}), [mapId]: next } };
    }
    case 'HAZARD_DELETE': {
      const list = state.hazards?.[action.mapId] || [];
      return { ...state, hazards: { ...(state.hazards || {}), [action.mapId]: list.filter(h => h.id !== action.id) } };
    }
    case 'HAZARD_CLEAR_MAP':
      return { ...state, hazards: { ...(state.hazards || {}), [action.mapId]: [] } };

    // v8.4: hazard-damage resolution queue. Events are enqueued by the
    // per-turn / on-entry detectors, then the DM resolves each (apply with a
    // weakness/resistance/immunity multiplier, or skip).
    case 'HAZARD_QUEUE': {
      if (!action.event?.id) return state;
      // de-dupe: don't stack an identical unresolved event for the same
      // token+hazard+reason (guards double-fires within a render batch).
      const exists = (state.hazardPending || []).some(e =>
        e.tokenId === action.event.tokenId && e.hazardId === action.event.hazardId && e.reason === action.event.reason);
      if (exists) return state;
      return { ...state, hazardPending: [...(state.hazardPending || []), action.event] };
    }
    case 'HAZARD_PENDING_REMOVE':
      return { ...state, hazardPending: (state.hazardPending || []).filter(e => e.id !== action.id) };
    case 'HAZARD_PENDING_CLEAR':
      return { ...state, hazardPending: [] };

    // v7 #9: dice rolling. ROLL adds to log + caps at 50 entries.
    // CLEAR wipes the log (DM only via UI gating).
    case 'DICE_ROLL': {
      const entry = action.entry;
      if (!entry || !entry.id) return state;
      const log = [entry, ...(state.diceLog || [])].slice(0, 50);
      return { ...state, diceLog: log };
    }
    case 'DICE_LOG_CLEAR':
      return { ...state, diceLog: [] };

    // v7 #10: DM sound playback. SOUND_REGISTER adds metadata to the
    // shared registry (audio bytes live in IDB sounds store). SOUND_EVENT
    // appends a play/stop event so connected players see it and trigger
    // local audio playback. Events capped at 20 to keep the buffer small.
    case 'SOUND_REGISTER': {
      const { id, name } = action;
      if (!id) return state;
      return { ...state, sounds: { ...(state.sounds || {}), [id]: { id, name: String(name || id), ts: Date.now() } } };
    }
    case 'SOUND_DEREGISTER': {
      const { [action.id]: _r, ...rest } = (state.sounds || {});
      return { ...state, sounds: rest };
    }
    case 'SOUND_EVENT': {
      const ev = action.event;
      if (!ev || !ev.id) return state;
      // v7 #10: keep the FIRST entry (most recent) with its dataUrl so it
      // reaches peers via state broadcast; older entries are stripped of
      // their bytes since players have already cached them in IDB. This
      // keeps state.soundEvents tiny across sessions while still letting
      // newcomers play a fresh sound the DM just triggered.
      const lean = (state.soundEvents || []).map(e => {
        const { dataUrl, ...rest } = e;
        return rest;
      });
      const evs = [ev, ...lean].slice(0, 20);
      return { ...state, soundEvents: evs };
    }

    // v3: DM-defined custom token presets
    case 'TOKEN_PRESET_UPSERT':
      return { ...state, tokenPresets: { ...state.tokenPresets, [action.preset.id]: action.preset } };
    case 'TOKEN_PRESET_DELETE': {
      const { [action.id]: _r, ...rest } = state.tokenPresets;
      return { ...state, tokenPresets: rest };
    }

    // v4: Identity migration - a returning player reconnects with a new
    // peer ID but the same persistent playerId. Move their claim (PC,
    // familiars, name, spectator flag) from the old peer key to the new.
    // Also updates bondedPeerId on any familiars that were bonded to
    // the old peer id so familiar movement rights carry over.
    case 'CLAIM_MIGRATE': {
      const { fromPeerId, toPeerId, playerName, playerId } = action;
      if (!toPeerId) return state;
      const claims = { ...(state.claims || {}) };
      const oldClaim = fromPeerId && claims[fromPeerId];
      if (oldClaim) {
        claims[toPeerId] = {
          ...oldClaim,
          playerName: playerName || oldClaim.playerName,
          playerId: playerId || oldClaim.playerId || null,
        };
        if (fromPeerId !== toPeerId) delete claims[fromPeerId];
      } else if (!claims[toPeerId]) {
        // First hello from this peer id - record a blank claim with the
        // playerId stamped so a future reconnect can migrate back.
        claims[toPeerId] = { pc: null, familiars: [], playerName: playerName || '', spectator: false, playerId: playerId || null };
      } else {
        // Existing peer-key claim - just stamp the playerId
        claims[toPeerId] = { ...claims[toPeerId], playerId: playerId || claims[toPeerId].playerId || null };
        if (playerName) claims[toPeerId].playerName = playerName;
      }
      const entities = { ...state.entities };
      if (fromPeerId && fromPeerId !== toPeerId) {
        for (const [id, e] of Object.entries(entities)) {
          if (e && e.type === 'Familiar' && e.bondedPeerId === fromPeerId) {
            entities[id] = { ...e, bondedPeerId: toPeerId };
          }
        }
      }
      const fvpp = { ...(state.forcedViewPerPeer || {}) };
      if (fromPeerId && fvpp[fromPeerId] && fromPeerId !== toPeerId) { fvpp[toPeerId] = fvpp[fromPeerId]; delete fvpp[fromPeerId]; }
      const reminders = { ...(state.reminders || {}) };
      if (fromPeerId && reminders[fromPeerId] && fromPeerId !== toPeerId) { reminders[toPeerId] = reminders[fromPeerId]; delete reminders[fromPeerId]; }
      return { ...state, claims, entities, forcedViewPerPeer: fvpp, reminders };
    }

    // v4: DM kicks a peer. Clears their claim and any per-peer overlays.
    case 'DM_KICK_PEER': {
      const peerId = action.peerId;
      const claims = { ...(state.claims || {}) };
      delete claims[peerId];
      const fvpp = { ...(state.forcedViewPerPeer || {}) };
      delete fvpp[peerId];
      const reminders = { ...(state.reminders || {}) };
      delete reminders[peerId];
      // Unbond any familiars held by this peer
      const entities = { ...state.entities };
      for (const [id, e] of Object.entries(entities)) {
        if (e && e.type === 'Familiar' && e.bondedPeerId === peerId) {
          entities[id] = { ...e, bondedPeerId: null };
        }
      }
      return { ...state, claims, entities, forcedViewPerPeer: fvpp, reminders };
    }

    // v4: Entity duplication. Produces a new entity with a fresh ID and
    // " (copy)" suffix. Inserted just after the source in entityOrder.
    case 'ENTITY_DUPLICATE': {
      const src = state.entities[action.id];
      if (!src) return state;
      const newId = uid('ent_');
      const copy = {
        ...src,
        id: newId,
        name: (src.name || 'Unnamed') + ' (copy)',
        deathSaves: { successes: 0, failures: 0 },
        bondedPeerId: null,
      };
      const order = [...(state.entityOrder || [])];
      const idx = order.indexOf(action.id);
      if (idx === -1) order.push(newId);
      else order.splice(idx + 1, 0, newId);
      return {
        ...state,
        entities: { ...state.entities, [newId]: copy },
        entityOrder: order,
      };
    }

    // v4: Partial patch on a map (used for "alwaysDark" flag and other settings)
    case 'MAP_PATCH': {
      const m = state.maps[action.id];
      if (!m) return state;
      return { ...state, maps: { ...state.maps, [action.id]: { ...m, ...action.patch } } };
    }

    // v4: Move a reminder (user drag). Peer may only move their own.
    case 'REMINDER_MOVE': {
      const peerId = action.peerId;
      const list = state.reminders[peerId] || [];
      const nextList = list.map(r =>
        r.id === action.id ? { ...r, x: action.x, y: action.y } : r
      );
      return { ...state, reminders: { ...state.reminders, [peerId]: nextList } };
    }

    // ===== v7.3: Token groups (DM-only encounter clustering) =====
    // Groups live in state.tokenGroups keyed by id. Each group is
    // scoped to a single map and holds an array of tokenIds. Hiding
    // or revealing a group updates the .visible flag on every member
    // in a single reducer pass so the sync layer emits one payload.
    case 'TOKEN_GROUP_CREATE': {
      const { id, mapId, name, memberIds } = action;
      if (!id || !mapId || !name) return state;
      // Filter memberIds to tokens that actually exist on this map
      const validMembers = (Array.isArray(memberIds) ? memberIds : [])
        .filter(tid => state.tokens?.[tid]?.mapId === mapId);
      const group = {
        id,
        mapId,
        name: String(name).slice(0, 80),
        memberIds: validMembers,
        notes: '',
        createdTs: Date.now(),
      };
      return {
        ...state,
        tokenGroups: { ...(state.tokenGroups || {}), [id]: group },
      };
    }

    case 'TOKEN_GROUP_UPDATE': {
      const { id, patch } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const next = { ...g };
      if (typeof patch?.name === 'string') next.name = patch.name.slice(0, 80);
      if (typeof patch?.notes === 'string') next.notes = patch.notes.slice(0, 400);
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: next },
      };
    }

    case 'TOKEN_GROUP_DELETE': {
      const { id } = action;
      if (!state.tokenGroups?.[id]) return state;
      const { [id]: _removed, ...rest } = state.tokenGroups;
      return { ...state, tokenGroups: rest };
    }

    // Replace membership wholesale. Keeps the reducer simple and
    // avoids diff logic on the DM side. Filters for valid members
    // on this map before writing.
    case 'TOKEN_GROUP_SET_MEMBERS': {
      const { id, memberIds } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const valid = (Array.isArray(memberIds) ? memberIds : [])
        .filter(tid => state.tokens?.[tid]?.mapId === g.mapId);
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: { ...g, memberIds: valid } },
      };
    }

    // Add one or more members to an existing group.
    case 'TOKEN_GROUP_ADD_MEMBERS': {
      const { id, tokenIds } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const toAdd = (Array.isArray(tokenIds) ? tokenIds : [])
        .filter(tid => state.tokens?.[tid]?.mapId === g.mapId);
      if (toAdd.length === 0) return state;
      const merged = Array.from(new Set([...(g.memberIds || []), ...toAdd]));
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: { ...g, memberIds: merged } },
      };
    }

    case 'TOKEN_GROUP_REMOVE_MEMBERS': {
      const { id, tokenIds } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const drop = new Set(Array.isArray(tokenIds) ? tokenIds : []);
      const kept = (g.memberIds || []).filter(tid => !drop.has(tid));
      return {
        ...state,
        tokenGroups: { ...state.tokenGroups, [id]: { ...g, memberIds: kept } },
      };
    }

    // Set .visible on every token in the group in one shot. This is
    // the encounter-flow action - hide the goblin ambush, then reveal
    // them all when they spring the trap.
    case 'TOKEN_GROUP_SET_VISIBLE': {
      const { id, visible } = action;
      const g = state.tokenGroups?.[id];
      if (!g) return state;
      const memberSet = new Set(g.memberIds || []);
      if (memberSet.size === 0) return state;
      const tokens = { ...state.tokens };
      let changed = false;
      for (const tid of memberSet) {
        const t = tokens[tid];
        if (!t) continue;
        if (!!t.visible === !!visible) continue;
        tokens[tid] = { ...t, visible: !!visible };
        changed = true;
      }
      if (!changed) return state;
      return { ...state, tokens };
    }

    default: return state;
  }
}

// ICE server config shared by both host and join.
// STUN alone fails on mobile cellular (symmetric NAT / CGNAT).
// The Open Relay Project provides free public TURN servers that cover
// those cases - no registration required.
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:443',
      'turn:openrelay.metered.ca:443?transport=tcp',
    ], username: 'openrelayproject', credential: 'openrelayproject' },
  ],
};

// How long to wait for the PeerJS broker WebSocket + WebRTC handshake
// before giving up and showing an error. Without this, mobile users on
// poor connections see an infinite orange dot with no feedback.
const CONNECT_TIMEOUT_MS = TUNING.connectTimeoutMs;

class SyncManager {
  constructor({ mode, onStateUpdate, onPlayerAction, onPlayerHello, onStatusChange, onPeerListChange, onPeerId, onError, onMapImage, onTokenPos, onSoundData, onAwaitingApproval }) {
    this.mode = mode;
    this.peer = null;
    this.roomCode = null;
    this.connections = new Map(); // for DM
    this.dmConnection = null; // for Player
    this.myPeerId = null;
    this.onStateUpdate = onStateUpdate;
    this.onPlayerAction = onPlayerAction;
    this.onPlayerHello = onPlayerHello;
    this.onStatusChange = onStatusChange;
    this.onPeerListChange = onPeerListChange;
    this.onPeerId = onPeerId;
    this.onError = onError;
    this.onMapImage = onMapImage;
    this.onTokenPos = onTokenPos;
    this.onSoundData = onSoundData;
    this.onAwaitingApproval = onAwaitingApproval;
    this.status = 'offline';
  }
  setStatus(s) {
    this.status = s;
    this.onStatusChange?.(s);
  }
  async hostSession(roomCode) {
    this.setStatus('connecting');
    this.roomCode = roomCode;
    const timeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.setStatus('error');
        this.onError?.('Could not reach the PeerJS broker. Check your connection and try again.');
      }
    }, CONNECT_TIMEOUT_MS);
    try {
      this.peer = new Peer(PEER_PREFIX + roomCode, { config: ICE_SERVERS });
      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        this.myPeerId = id;
        this.onPeerId?.(id);
        this.setStatus('live');
      });
      this.peer.on('connection', (conn) => {
        conn.on('open', () => {
          this.connections.set(conn.peer, conn);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
        conn.on('data', (data) => {
          // v8.9: one malformed envelope (a primitive, a null, a message with
          // a bad shape) must not throw inside the host's handler and kill the
          // connection. Guard the shape and swallow handler errors.
          try {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'player_action') this.onPlayerAction?.(data.payload, conn.peer);
            else if (data.type === 'hello') this.onPlayerHello?.(data, conn.peer);
          } catch (e) { console.warn('[plagues-call] dropped malformed message', e?.message); }
        });
        conn.on('close', () => {
          this.connections.delete(conn.peer);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
        conn.on('error', () => {
          this.connections.delete(conn.peer);
          this.onPeerListChange?.(Array.from(this.connections.keys()));
        });
      });
      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        if (err.type === 'unavailable-id') {
          this.onError?.('Room code already in use. Pick another.');
          this.setStatus('error');
        } else {
          this.setStatus('error');
          this.onError?.(err.message || 'Connection error');
        }
      });
    } catch (err) {
      clearTimeout(timeout);
      this.setStatus('error');
      this.onError?.(err.message);
    }
  }
  async joinSession(roomCode, playerId, playerName) {
    this.setStatus('connecting');
    this.roomCode = roomCode;
    this.playerId = playerId;
    this.playerName = playerName;
    const timeout = setTimeout(() => {
      if (this.status === 'connecting') {
        this.setStatus('error');
        this.onError?.('Could not connect to the table. Check your connection - mobile data may need a moment, or try WiFi.');
      }
    }, CONNECT_TIMEOUT_MS);
    try {
      this.peer = new Peer(undefined, { config: ICE_SERVERS });
      this.peer.on('open', (id) => {
        clearTimeout(timeout);
        this.myPeerId = id;
        this.onPeerId?.(id);
        const conn = this.peer.connect(PEER_PREFIX + roomCode, { reliable: true });
        this.dmConnection = conn;
        conn.on('open', () => {
          this.setStatus('live');
          conn.send({ type: 'hello', peerId: id, playerId, playerName });
        });
        conn.on('data', (data) => {
          try {
            if (!data || typeof data !== 'object') return;
            if (data.type === 'state_update') this.onStateUpdate?.(data.payload);
            else if (data.type === 'awaiting_approval') this.onAwaitingApproval?.();
            else if (data.type === 'map_image') this.onMapImage?.(data.mapId, data.dataUrl, data.layerId);
            else if (data.type === 'token_pos') this.onTokenPos?.(data.tokenId, data.x, data.y, data.mapId);
            else if (data.type === 'sound_data') this.onSoundData?.(data.soundId, data.name, data.dataUrl);
            else if (data.type === 'kicked') {
              this.onError?.(data.reason || 'You were removed from the session.');
              try { conn.close(); } catch {}
              this.setStatus('offline');
            }
          } catch (e) { console.warn('[plagues-call] dropped malformed message', e?.message); }
        });
        conn.on('close', () => this.setStatus('offline'));
        conn.on('error', () => this.setStatus('error'));
      });
      this.peer.on('error', (err) => {
        clearTimeout(timeout);
        this.setStatus('error');
        this.onError?.(err.message || 'Could not connect');
      });
    } catch (err) {
      clearTimeout(timeout);
      this.setStatus('error');
      this.onError?.(err.message);
    }
  }
  sendPlayerAction(action) {
    if (this.mode !== 'player' || !this.dmConnection?.open) return false;
    try {
      this.dmConnection.send({ type: 'player_action', payload: action });
      return true;
    } catch { return false; }
  }
  // Send raw audio bytes to all connected peers so they can play the
  // sound immediately without waiting for a future state broadcast.
  // The state broadcast strips dataUrls; this is the only delivery path.
  sendSoundData(soundId, name, dataUrl) {
    if (this.mode !== 'dm' || !soundId || !dataUrl) return;
    for (const conn of this.connections.values()) {
      try {
        if (conn.open) conn.send({ type: 'sound_data', soundId, name, dataUrl });
      } catch {}
    }
  }
  sendSoundDataTo(peerId, soundId, name, dataUrl) {
    if (this.mode !== 'dm' || !soundId || !dataUrl) return;
    const conn = this.connections.get(peerId);
    try {
      if (conn?.open) conn.send({ type: 'sound_data', soundId, name, dataUrl });
    } catch {}
  }
  // v4: DM boots a player. Sends a goodbye message so their client can
  // show a friendly explanation, then closes the connection.
  kickPeer(peerId, reason) {
    if (this.mode !== 'dm') return;
    const conn = this.connections.get(peerId);
    if (!conn) return;
    try { conn.send({ type: 'kicked', reason: reason || 'The DM has removed you from the session.' }); } catch {}
    // Small delay so the message has a chance to land before the close
    setTimeout(() => {
      try { conn.close(); } catch {}
      this.connections.delete(peerId);
      this.onPeerListChange?.(Array.from(this.connections.keys()));
    }, 150);
  }
  destroy() {
    try { this.peer?.destroy(); } catch {}
    this.peer = null;
    this.connections.clear();
    this.dmConnection = null;
    this.setStatus('offline');
  }
}

// ====================================================================
// VISIBILITY FILTER (what player can see)
// ====================================================================

// Strip DM-only fields from an entity for player-facing consumption.
// v8.4 SECURITY: when the DM obfuscates HP, players must not receive exact
// numbers at all (they were previously only hidden in the UI but present in
// the payload, readable via DevTools). Replace the real pool with a coarse
// band that still lets the client render the same "healthy / bloodied / down"
// estimate without leaking the true value.
function bandHpForPlayer(hp) {
  const cur = hp?.current ?? 0, max = hp?.max ?? 0;
  const pct = max > 0 ? cur / max : 0;
  let c;
  if (cur <= 0) c = 0;
  else if (pct < 0.30) c = 15;
  else if (pct <= 0.70) c = 50;
  else c = 85;
  return { current: c, max: 100 };
}
function sanitizeEntityForPlayer(e, opts = {}) {
  if (!e) return e;
  const { obfuscateHp = false, isOwned = false } = opts;
  const isMonsterOrBeast = e.type === 'Monster' || e.type === 'Neutral Beast';
  const isNpcOrObject = e.type === 'NPC' || e.type === 'Object';
  // Own party keeps exact HP so players can manage themselves; everyone else
  // gets banded numbers whenever obfuscation is enabled.
  const hideHp = obfuscateHp && !isOwned && e.hp;
  return {
    ...e,
    ...(hideHp && { hp: bandHpForPlayer(e.hp) }),
    deathSaves: { successes: 0, failures: 0 },
    // v8.9 SECURITY: `notes` is DM-only prep. Previously it was stripped only
    // for Monster/Beast/NPC/Object, so DM notes on a PC or Familiar were
    // broadcast to the whole table. Strip for everyone the peer doesn't own;
    // an owner keeps their own notes (which they can also edit).
    ...(!isOwned && { notes: '' }),
    ...(isMonsterOrBeast && { notes: '', abilities: '' }),
    ...(isNpcOrObject    && { notes: '' }),
  };
}

// v3: Vision system - convert feet to world-pixels using a fixed scale.
// 10 px/ft is a common VTT default (1" hex on a 72dpi 5-ft grid) but this
// lives in one constant so it can be tuned. Darkness system reads token
// positions + entity.darkvision + entity.lightRadius to compute the list
// of { x, y, radius } holes to punch in the dark overlay.
const PX_PER_FOOT = 10;

// DM helper: returns vision sources (as dashed outlines on the DM map) for
// every PC/Familiar with darkvision OR every entity of any type with
// lightRadius on the current map. Each gets a unique color keyed to its
// claimant (so the DM can eyeball "that's Ana's sight, that's Jonas's").
function computeVisionSources(state, mapId) {
  const sources = [];
  for (const t of Object.values(state.tokens)) {
    if (t.mapId !== mapId) continue;
    const e = state.entities[t.entityId];
    if (!e) continue;
    const sicknessPenalty = 1 - Math.min((e.sickness || 0) * 0.25, 1);
    const dv = (e.darkvision || 0) * PX_PER_FOOT * sicknessPenalty;
    const lr = (e.lightRadius || 0) * PX_PER_FOOT;
    if (dv <= 0 && lr <= 0) continue;
    const radius = Math.max(dv, lr);
    // v7.1: mark as a flame emitter if the token contributes any light.
    // Pure darkvision sources don't flicker - magical sight is steady.
    sources.push({ x: t.x, y: t.y, radius, color: e.color, isLight: lr > 0 });
  }
  return sources;
}

// Player helper: vision sources this specific player benefits from.
// Includes all owned entities' darkvision + lightRadius plus any torch
// objects (lightRadius > 0) placed on the map as they illuminate everyone.
//
// v5 fix #7: carried-light radii scale with time of day. Dusk/dawn light
// travels further than deep night (the sky still has some glow), so:
//   day     (tod < 0.5)    : doesn't matter - vision system not active
//   dusk    (0.5 ≤ tod < 0.7) : lightRadius × 1.75
//   night   (0.7 ≤ tod < 0.95): lightRadius × 1.25
//   deepest (tod ≥ 0.95)   : lightRadius × 1.0 (unmodified)
// Darkvision is magical and unaffected by ambient light.
function computePlayerVisionSources(state, mapId, ownedEntityIds, timeOfDay = 0, alwaysDark = false) {
  const sources = [];
  const owned = ownedEntityIds || new Set();
  const BASE_VISIBILITY_FT = 10;
  const baseRadius = BASE_VISIBILITY_FT * PX_PER_FOOT;

  // alwaysDark maps behave like "deepest" night regardless of TOD
  const effectiveTod = alwaysDark ? 1.0 : timeOfDay;
  let lightMul;
  if (effectiveTod >= 0.95) lightMul = 1.0;
  else if (effectiveTod >= 0.70) lightMul = 1.25;
  else lightMul = 1.75; // dusk/dawn band

  for (const t of Object.values(state.tokens)) {
    if (t.mapId !== mapId) continue;
    const e = state.entities[t.entityId];
    if (!e) continue;
    const sicknessPenalty = 1 - Math.min((e.sickness || 0) * 0.25, 1);
    const dv = (e.darkvision || 0) * PX_PER_FOOT * (owned.has(e.id) ? sicknessPenalty : 1);
    const lr = (e.lightRadius || 0) * PX_PER_FOOT * lightMul;

    if (owned.has(e.id)) {
      const radius = Math.max(baseRadius, dv, lr);
      // v7.1: flicker if any portion of this source is from flame
      // (held torch/lantern). Base ambient vision + pure darkvision stay steady.
      sources.push({ x: t.x, y: t.y, radius, owned: true, entityId: e.id, isLight: lr > 0 });
      continue;
    }
    if (lr > 0) {
      // Non-owned flame (torch objects, candles, etc.) always flicker.
      sources.push({ x: t.x, y: t.y, radius: lr, owned: false, entityId: e.id, isLight: true });
    }
  }
  return sources;
}

// v7.6: the chat display name for a peer - their claimed character's name,
// else the player name they joined with, else a generic fallback.
function displayNameForPeer(state, peerId) {
  const claim = state.claims?.[peerId];
  if (claim) {
    if (claim.pc && state.entities?.[claim.pc]?.name) return state.entities[claim.pc].name;
    if (claim.playerName) return claim.playerName;
    if (claim.spectator) return 'Spectator';
  }
  return 'Player';
}
// v7.6: chat visible to a given viewer - public messages plus whispers to or
// from them. The DM (not run through this filter) sees everything.
function chatForViewer(chat, peerId) {
  return (chat || []).filter(m => !m.whisperTo || m.whisperTo === peerId || m.senderId === peerId);
}

// v8.9 SECURITY: strip the secret, unverified `playerId` from every claim
// before broadcasting. The party UI only needs pc / familiars / playerName /
// spectator; leaking playerId let any peer migrate (steal) another's claim.
function sanitizeClaimsForWire(claims) {
  const out = {};
  for (const [pid, c] of Object.entries(claims || {})) {
    out[pid] = {
      pc: c.pc || null,
      familiars: Array.isArray(c.familiars) ? c.familiars : [],
      controlledPcs: Array.isArray(c.controlledPcs) ? c.controlledPcs : [],
      playerName: c.playerName || '',
      spectator: !!c.spectator,
    };
  }
  return out;
}

function filterStateForPlayer(state, peerId, obfuscateHp = false) {
  // Lookup claim record for this peer
  const claim = state.claims?.[peerId] || { pc: null, familiars: [], playerName: '', spectator: false };

  // Spectators get all visible tokens but no DM-only data (notes, deathSaves, etc.)
  if (claim.spectator) {
    const visibleTokens = {};
    Object.entries(state.tokens).forEach(([k, t]) => {
      const entity = state.entities[t.entityId];
      if (!entity) return;
      if (entity.type === 'PC' || entity.type === 'Familiar' || t.visible) {
        visibleTokens[k] = t;
      }
    });
    // v7.8 SECURITY: spectators, like players, only receive entities they can
    // actually see - party-class creatures, anything behind a visible token,
    // and whatever appears in the (now also filtered) initiative order. Hidden
    // monsters/NPCs no longer ship in the payload.
    const specInitEntries = state.initiative.entries.filter(e => {
      const ent = state.entities[e.entityId];
      if (!ent) return false;
      if (ent.type === 'PC' || ent.type === 'Familiar') return true;
      return Object.values(state.tokens).some(t => t.entityId === ent.id && t.visible);
    });
    const specVisibleIds = new Set();
    for (const [id, e] of Object.entries(state.entities)) {
      if (e && (e.type === 'PC' || e.type === 'Familiar')) specVisibleIds.add(id);
    }
    for (const t of Object.values(visibleTokens)) specVisibleIds.add(t.entityId);
    for (const e of specInitEntries) specVisibleIds.add(e.entityId);
    const sanitizedEntities = {};
    for (const id of specVisibleIds) {
      const e = state.entities[id];
      if (e) sanitizedEntities[id] = sanitizeEntityForPlayer(e, { obfuscateHp, isOwned: false });
    }
    const peerForced = state.forcedViewPerPeer?.[peerId];
    const effectiveForcedView = peerForced || state.forcedView || null;
    const visibleHazards = {};
    for (const [mapId, list] of Object.entries(state.hazards || {})) {
      visibleHazards[mapId] = (list || []).filter(h => h.visible !== false);
    }
    return {
      ...state,
      entities: sanitizedEntities,
      tokens: visibleTokens,
      initiative: { ...state.initiative, entries: specInitEntries },
      reminders: { [peerId]: state.reminders?.[peerId] || [] },
      chat: chatForViewer(state.chat, peerId),
      forcedView: effectiveForcedView,
      forcedViewPerPeer: peerForced ? { [peerId]: peerForced } : {},
      hazards: visibleHazards,
      tokenGroups: {},
      claims: sanitizeClaimsForWire(state.claims),
      presets: {},
      tokenPresets: {},
      hazardPending: [],
      pendingRequests: Object.fromEntries(Object.entries(state.pendingRequests || {}).filter(([, r]) => r.peerId === peerId)),
    };
  }

  const ownedIds = new Set();
  if (claim.pc) ownedIds.add(claim.pc);
  for (const id of claim.familiars) ownedIds.add(id);
  // v7.9: PCs temporarily lent to this player by the DM.
  for (const id of (claim.controlledPcs || [])) ownedIds.add(id);
  // v3: peers also "own" familiars whose bondedPeerId points at them.
  // v5 fix #10: ALSO own familiars bonded to a PC we currently claim.
  for (const [id, ent] of Object.entries(state.entities)) {
    if (!ent || ent.type !== 'Familiar') continue;
    if (ent.bondedPeerId === peerId) ownedIds.add(id);
    if (ent.bondedPcId && ent.bondedPcId === claim.pc) ownedIds.add(id);
  }

  // Token visibility: always show PCs/Familiars + owned; else DM must reveal.
  // v6 fix #4: Labels no longer get an "always visible" exemption - they
  // now follow the same vision rules as creatures. They still default to
  // visible (t.visible = true on place) so the DM doesn't need to click
  // to reveal each one, but at night / in alwaysDark maps they'll be
  // cut off if out of range.
  const visibleTokens = {};
  Object.entries(state.tokens).forEach(([k, t]) => {
    const entity = state.entities[t.entityId];
    if (!entity) return;
    const alwaysVisible = entity.type === 'PC' || entity.type === 'Familiar';
    const isOwned = ownedIds.has(entity.id);
    if (alwaysVisible || isOwned || t.visible) {
      visibleTokens[k] = t;
    }
  });

  // v5 fix #4: Hard vision-based cutoff. If vision is active on the current
  // map (night, or alwaysDark), any token whose position falls OUTSIDE every
  // owned vision radius is stripped entirely - not rendered, not listed in
  // sidebars, not known to the player client at all.
  //
  // We scope this to the CURRENT map (tokens on other maps aren't affected,
  // since the player isn't looking at those). Vision sources are computed
  // from the owned entity positions on that same map, mirroring what the
  // client would see.
  //
  // Note: this runs on top of the existing visibility gate. Owned PCs and
  // Familiars are always included regardless of distance so a player never
  // loses their own party's positions.
  const effectiveMapId = (state.forcedViewPerPeer?.[peerId]?.mapId)
    || (state.forcedView?.mapId)
    || state.currentMapId;
  const activeMap = state.maps?.[effectiveMapId];
  const mapAlwaysDark = !!activeMap?.alwaysDark;
  const tod = typeof state.timeOfDay === 'number' ? state.timeOfDay : 0;
  const visionActive = mapAlwaysDark || tod >= 0.5;

  let finalTokens = visibleTokens;

  if (visionActive) {
    const sources = computePlayerVisionSources(state, effectiveMapId, ownedIds, tod, mapAlwaysDark);
    const cutTokens = {};
    for (const [k, t] of Object.entries(visibleTokens)) {
      if (t.mapId !== effectiveMapId) { cutTokens[k] = t; continue; }
      const ent = state.entities[t.entityId];
      if (!ent) continue;
      if (ownedIds.has(ent.id)) { cutTokens[k] = t; continue; }
      let visible = false;
      for (const s of sources) {
        const dx = t.x - s.x, dy = t.y - s.y;
        if (dx * dx + dy * dy <= s.radius * s.radius) { visible = true; break; }
      }
      if (visible) cutTokens[k] = t;
    }
    finalTokens = cutTokens;
  }

  // v8.9 SECURITY: a player only ever renders their effective map, but tokens
  // on *other* maps were still shipping in full - positions and (via the entity
  // allowlist) stat blocks of revealed creatures elsewhere in the world, all
  // readable in DevTools. Drop them from the payload entirely.
  finalTokens = Object.fromEntries(
    Object.entries(finalTokens).filter(([, t]) => t.mapId === effectiveMapId));

  // Filter initiative entries - show PCs/Familiars (always) and entities with a visible token
  const filteredInitEntries = state.initiative.entries.filter(e => {
    const entity = state.entities[e.entityId];
    if (!entity) return false;
    if (entity.type === 'PC' || entity.type === 'Familiar') return true;
    // v8.9 SECURITY: gate on the vision-filtered token set (finalTokens), not
    // raw t.visible. Previously an out-of-vision monster stayed in the player's
    // initiative order and its full entity was re-added to the payload, making
    // the vision cutoff decorative during night combat.
    return Object.values(finalTokens).some(t => t.entityId === entity.id);
  });

  // Sanitize entities. Own PC keeps sickness; everyone else gets sickness=0
  // (v3: but players now DO see sickness as a diegetic condition on their own
  // PC - the EditMySheet renders it from this preserved value).
  // v5 fix #6: sickness is now shown to all players on all visible tokens
  // (previously stripped for non-owned entities). Only the narrative
  // descriptor label ever reaches the UI - the numeric level is an
  // implementation detail that the chip uses purely for styling.
  //
  // v7.8 SECURITY: build the player's entity dictionary from ONLY the entities
  // they are permitted to know about, instead of sanitizing the whole roster.
  // Previously every entity (hidden monsters, unrevealed NPCs, staged
  // encounter creatures) was serialized and shipped to the client - invisible
  // in the UI but trivially readable in DevTools, contradicting the vision
  // contract above. The allowed set is:
  //   - PCs and Familiars: party-class, always known to the table (matches the
  //     "always visible" token rule and the party/bond panels);
  //   - any entity behind a token that survived visibility + vision filtering;
  //   - any entity shown in the player-facing initiative order;
  //   - everything this peer owns (redundant with PC/Familiar, kept explicit).
  // Hidden monsters/NPCs/objects never enter the payload at all.
  const visibleEntityIds = new Set(ownedIds);
  for (const [id, e] of Object.entries(state.entities)) {
    if (e && (e.type === 'PC' || e.type === 'Familiar')) visibleEntityIds.add(id);
  }
  for (const t of Object.values(finalTokens)) visibleEntityIds.add(t.entityId);
  for (const e of filteredInitEntries) visibleEntityIds.add(e.entityId);
  const sanitizedEntities = {};
  for (const id of visibleEntityIds) {
    const e = state.entities[id];
    if (e) sanitizedEntities[id] = sanitizeEntityForPlayer(e, { obfuscateHp, isOwned: ownedIds.has(id) });
  }

  // Reminders are strictly private
  const myReminders = state.reminders?.[peerId] || [];
  const reminders = { [peerId]: myReminders };

  // v3: per-peer forced view. If this peer has a specific push, apply it.
  // Otherwise fall back to the legacy global forcedView (applies to all).
  const peerForced = state.forcedViewPerPeer?.[peerId];
  const effectiveForcedView = peerForced || state.forcedView || null;

  // v6 #9: Strip invisible hazards from the player-facing payload.
  // Hazards with visible === false are DM-only (e.g., hidden traps).
  // Also strip any drawings whose map doesn't exist (defensive cleanup).
  const visibleHazards = {};
  for (const [mapId, list] of Object.entries(state.hazards || {})) {
    visibleHazards[mapId] = (list || []).filter(h => h.visible !== false);
  }

  return {
    ...state,
    entities: sanitizedEntities,
    tokens: finalTokens,
    initiative: { ...state.initiative, entries: filteredInitEntries },
    reminders,
    chat: chatForViewer(state.chat, peerId),
    forcedView: effectiveForcedView,
    // Strip other peers' private forced-view map. Only keep this peer's own.
    forcedViewPerPeer: peerForced ? { [peerId]: peerForced } : {},
    hazards: visibleHazards,
    // v7.3: Token groups are DM-only encounter metadata. Players see
    // only the EFFECT of group operations (tokens appearing /
    // disappearing), never the group roster itself. Strip entirely.
    tokenGroups: {},
    claims: sanitizeClaimsForWire(state.claims),
    presets: {},
    tokenPresets: {},
    hazardPending: [],
    pendingRequests: Object.fromEntries(Object.entries(state.pendingRequests || {}).filter(([, r]) => r.peerId === peerId)),
  };
}

// v7.2 PERFORMANCE FIX: strip heavy binary assets from broadcast
// payloads. In v7, every state_update included all map image dataUrls
// inline (often multiple MB) and every sound event's dataUrl. A fresh
// join or a single token drag would push megabytes through WebRTC on
// each broadcast, producing the reported 10-second join and 3-4 second
// lighting-update lag.
//
// New strategy: the broadcast payload carries only lean metadata.
// Players fetch map image bytes on demand via a separate 'map_image'
// envelope (sent once per map, cached locally in IDB).
//
// Sound events already had their dataUrls stripped in the reducer
// (v7 fix) but we belt-and-suspenders that here too.
function stripHeavyAssetsForWire(state) {
  const leanMaps = {};
  for (const [id, m] of Object.entries(state.maps || {})) {
    if (m?.imageUrl && typeof m.imageUrl === 'string' && m.imageUrl.startsWith('data:')) {
      leanMaps[id] = { ...m, imageUrl: IMG_SENTINEL };
    } else {
      leanMaps[id] = m;
    }
  }
  const leanSoundEvents = (state.soundEvents || []).map(e => {
    if (e?.dataUrl) {
      const { dataUrl, ...rest } = e;
      return rest;
    }
    return e;
  });
  // v7.7: strip per-map layer image bytes too; players fetch them via the
  // same image envelope (with a layerId) and the REPLACE reducer preserves
  // hydrated bytes across subsequent updates.
  const leanLayers = {};
  for (const [mid, list] of Object.entries(state.layers || {})) {
    leanLayers[mid] = (Array.isArray(list) ? list : []).map(l =>
      (l?.imageUrl && typeof l.imageUrl === 'string' && l.imageUrl.startsWith('data:'))
        ? { ...l, imageUrl: IMG_SENTINEL }
        : l);
  }
  return { ...state, maps: leanMaps, soundEvents: leanSoundEvents, layers: leanLayers };
}

// ====================================================================
// TOAST SYSTEM
// ====================================================================
const ToastContext = createContext(null);

function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, type = 'info', duration = 3000) => {
    const id = uid('t');
    setToasts((curr) => [...curr, { id, message, type }]);
    setTimeout(() => setToasts((curr) => curr.filter(t => t.id !== id)), duration);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
const useToast = () => useContext(ToastContext);

// Maps a sync status string to the CSS modifier class used on .conn-dot.
// Used in both DMInterface and PlayerInterface topbars.
const syncStatusClass = (status) =>
  status === 'live' ? 'live' : status === 'connecting' ? 'connecting' : status === 'error' ? 'error' : '';

// ====================================================================
// AUTH SCREEN
// ====================================================================
function AuthScreen({ onAuth }) {
  const [tab, setTab] = useState('dm');
  const [password, setPassword] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [playerName, setPlayerName] = useState('');
  const [error, setError] = useState('');

  const handleDM = () => {
    if (password !== DM_PASSWORD) {
      setError('Incorrect passphrase.');
      return;
    }
    // v8.9: the auto code is appended to a public, known broker prefix and
    // grants immediate entry, so 4 base36 chars were trivially enumerable.
    // Use ~10 chars of entropy from two random draws.
    const randCode = () => (Math.random().toString(36).slice(2, 8) + Math.random().toString(36).slice(2, 6));
    const code = roomCode.trim().toLowerCase().replace(/[^a-z0-9-]/g, '') || 'table-' + randCode();
    onAuth({ mode: 'dm', roomCode: code });
  };

  const handlePlayer = () => {
    if (!roomCode.trim()) { setError('Enter a room code.'); return; }
    if (!playerName.trim()) { setError('Choose a display name.'); return; }
    onAuth({
      mode: 'player',
      roomCode: roomCode.trim().toLowerCase(),
      playerName: playerName.trim(),
      // v4 fix #7: stable per-device identity so the DM can restore
      // this player's claim after a refresh/reconnect.
      playerId: getOrCreatePlayerId(),
    });
  };

  const handleLocal = () => {
    onAuth({ mode: 'dm', roomCode: null, local: true });
  };

  return (
    <div className="auth-screen">
      <div className="auth-card slide-up">
        <div className="auth-title">Burrows and Badgers</div>

        <div className="auth-tab-row">
          <div className={`auth-tab ${tab === 'dm' ? 'active' : ''}`} onClick={() => { setTab('dm'); setError(''); }}>
            ⚔ Dungeon Master
          </div>
          <div className={`auth-tab ${tab === 'player' ? 'active' : ''}`} onClick={() => { setTab('player'); setError(''); }}>
            ⌂ Player
          </div>
        </div>

        {tab === 'dm' ? (
          <>
            <div className="auth-field">
              <label>Passphrase</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Enter the arcane word…" autoFocus
                onKeyDown={e => e.key === 'Enter' && handleDM()} />
            </div>
            <div className="auth-field">
              <label>Room Code (optional)</label>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="e.g. curse-of-strahd"
                onKeyDown={e => e.key === 'Enter' && handleDM()} />
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>
                Share with players so they may join.
              </div>
            </div>
            {error && <div style={{ color: 'var(--blood-bright)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={handleDM}>
              Open the Session
            </button>
            <div className="hr" />
            <button className="btn ghost" style={{ width: '100%', justifyContent: 'center' }} onClick={handleLocal}>
              ⚐ Local-only mode (no sync)
            </button>
          </>
        ) : (
          <>
            <div className="auth-field">
              <label>Room Code</label>
              <input value={roomCode} onChange={e => setRoomCode(e.target.value)} placeholder="e.g. curse-of-strahd" autoFocus
                onKeyDown={e => e.key === 'Enter' && handlePlayer()} />
            </div>
            <div className="auth-field">
              <label>Your Name</label>
              <input value={playerName} onChange={e => setPlayerName(e.target.value)} placeholder="e.g. Elara"
                onKeyDown={e => e.key === 'Enter' && handlePlayer()} />
            </div>
            {error && <div style={{ color: 'var(--blood-bright)', fontSize: 12, marginBottom: 12 }}>{error}</div>}
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center', padding: '12px' }} onClick={handlePlayer}>
              Join the Table
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// TOKEN COMPONENT
// ====================================================================
// Map entity.type → CSS shape class on `.token-shape`. New v2 types use
// distinct silhouettes so the map stays readable at a glance.
const TOKEN_SHAPE_CLASS = {
  'PC': 'pc',
  'Monster': 'monster',
  'NPC': 'npc',
  'Familiar': 'familiar',
  'Neutral Beast': 'neutral-beast',
  'Object': 'object',
  'Label': 'label',
};

function TokenView({
  token, entity, isCurrent, isSelected, canDrag,
  onStartDrag, onDoubleClick, onContextMenu,
  showLabel, isDraggingLocal,
  onHoverChange, mode,
  // v6 #12:
  isMultiSelected, onSingleClick,
  // v7 #3: token-to-token measurement - first-clicked token gets a halo
  isMeasureStart,
  // v7.5: DM-only marker that this token is hidden from low-perception players
  passivelyHidden, hideThreshold,
}) {
  // v7.8: brief on-token feedback when HP changes or a status is applied.
  // Each viewer detects the change locally by diffing the entity it renders,
  // so the flash fires for everyone regardless of who caused it (DM or player).
  const [flashes, setFlashes] = useState([]);
  const [reaction, setReaction] = useState(null); // v7.9: token-body shake/pulse
  const reactionTimer = useRef(null);
  useEffect(() => () => clearTimeout(reactionTimer.current), []);
  const prevFxRef = useRef(null);
  const fxIdRef = useRef(0);
  const condKey = (entity?.conditions || []).join('|');
  const curHpFx = entity?.hp?.current;
  useEffect(() => {
    if (!entity) return;
    const curConds = entity.conditions || [];
    const prev = prevFxRef.current;
    if (prev === null) { prevFxRef.current = { hp: curHpFx, conds: curConds }; return; }
    const adds = [];
    if (typeof prev.hp === 'number' && typeof curHpFx === 'number' && curHpFx !== prev.hp) {
      adds.push(curHpFx < prev.hp
        ? { kind: 'damage', color: '#e0463c' }
        : { kind: 'heal', color: '#3fb84f' });
    }
    const prevSet = new Set(prev.conds || []);
    for (const c of curConds) {
      if (!prevSet.has(c)) adds.push({ kind: 'status', color: CONDITION_COLORS[c] || '#9b6ac4' });
    }
    if (adds.length) {
      setFlashes(f => [...f, ...adds.map(a => ({ ...a, id: ++fxIdRef.current }))]);
      // v7.9: jolt/pulse the token body. Damage shakes; heal pulses up;
      // a pure status change gives a quick pop. Re-arm the clear each hit.
      const rtype = adds.some(a => a.kind === 'damage') ? 'hit'
        : adds.some(a => a.kind === 'heal') ? 'heal' : 'buff';
      setReaction(null);
      // force the animation to restart even on rapid repeat hits
      requestAnimationFrame(() => setReaction(rtype));
      clearTimeout(reactionTimer.current);
      reactionTimer.current = setTimeout(() => setReaction(null), 600);
    }
    prevFxRef.current = { hp: curHpFx, conds: curConds };
  }, [curHpFx, condKey]);

  // v8.10: when an entity has no explicit portrait, try to match one by name
  // from assets/tokens/ (e.g. a creature called "Robin" -> Robin.jpg).
  const [nameImg, setNameImg] = useState(null);
  useEffect(() => {
    let live = true;
    if (entity && !entity.imageUrl && entity.name) {
      resolveEntityImage(entity.name).then(url => { if (live && url) setNameImg(url); });
    } else {
      setNameImg(null);
    }
    return () => { live = false; };
  }, [entity?.name, entity?.imageUrl]);

  if (!entity) return null;
  const portraitUrl = entity.imageUrl || nameImg;
  const typeClass = TOKEN_SHAPE_CLASS[entity.type] || 'npc';
  const hpPct = entity.hp.max > 0 ? (entity.hp.current / entity.hp.max) * 100 : 0;
  const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
  const initial = (entity.name || '?').slice(0, 1).toUpperCase();
  // v2: per-token scale factor. Applied as a CSS scale so hitboxes remain
  // centered on token.x/y (we compensate the offset with transform-origin).
  const scale = clamp(Number(token.scale) || 1, 0.3, 4);

  // v2: player-facing HP bar gating. DM sees everything; players only see
  // HP bars for PCs + Familiars (the "party" types).
  const showHpBar = entity.hp.max > 0 && (
    mode === 'dm' || PLAYER_HP_VISIBLE_TYPES.has(entity.type)
  );

  // v3: every status effect renders BELOW the token name, wrapped into a list.
  // Conditions with distinct colors still use CONDITION_COLORS; sickness
  // (player-facing descriptor) also appears here as a small italic tag.
  const statusItems = [...entity.conditions];
  const sicknessLabel = SICKNESS_DESCRIPTORS[entity.sickness || 0] || '';

  const onPointerDown = (e) => {
    if (e.button === 2) return;
    if (canDrag) {
      e.stopPropagation();
      onStartDrag?.(e);
    }
  };
  const onContext = (e) => {
    if (onContextMenu) { e.preventDefault(); onContextMenu(e); }
  };

  const classes = [
    'token',
    !token.visible ? 'hidden-token' : '',
    isCurrent ? 'current-turn' : '',
    isSelected ? 'selected' : '',
    isMultiSelected ? 'multi-selected' : '',
    isMeasureStart ? 'measure-start' : '',
    isDraggingLocal ? 'dragging' : '',
  ].filter(Boolean).join(' ');

  // v6 #12: pass click events to the parent so shift-click can toggle
  // multi-selection. The click fires after pointer-up, separately from
  // drag, so this doesn't interfere with drag-to-move.
  const onClick = (e) => {
    if (onSingleClick) {
      e.stopPropagation();
      onSingleClick(e);
    }
  };

  // v5 #3: Labels render as stylized text - no shape, no HP bar, no
  // conditions stack. Used for map annotations like "Butcher", "Church".
  // They still participate in selection/drag so the DM can reposition them.
  if (entity.type === 'Label') {
    return (
      <div
        className={classes + ' token-label-text'}
        data-tok={token.id}
        style={{
          left: token.x,
          top: token.y,
          '--token-scale': scale,
          color: entity.color || '#c9a34a',
        }}
        onPointerDown={onPointerDown}
        onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(e); }}
        onClick={onClick}
        onContextMenu={onContext}
        onMouseEnter={() => onHoverChange?.({ tokenId: token.id, entityId: entity.id })}
        onMouseLeave={() => onHoverChange?.(null)}
      >
        <div className="token-label-inner">{entity.name || 'Label'}</div>
      </div>
    );
  }

  return (
    <div
      className={classes}
      data-tok={token.id}
      style={{ left: token.x - 18, top: token.y - 18, '--token-scale': scale }}
      onPointerDown={onPointerDown}
      onDoubleClick={(e) => { e.stopPropagation(); onDoubleClick?.(e); }}
      onClick={onClick}
      onContextMenu={onContext}
      onMouseEnter={() => onHoverChange?.({ tokenId: token.id, entityId: entity.id })}
      onMouseLeave={() => onHoverChange?.(null)}
    >
      <div className={`token-inner ${reaction ? 'tok-react-' + reaction : ''}`}>
        {showHpBar && (
          <div className="token-hp-bar">
            <div className={`token-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
          </div>
        )}
        <div className={`token-shape ${typeClass}`} style={{ '--color': entity.color }}>
          {portraitUrl ? (
            <img src={portraitUrl} alt="" className="token-portrait" draggable="false"
              onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          ) : (
            <span>{initial}</span>
          )}
          {flashes.map(f => (
            <div key={f.id} className={`token-fx token-fx-${f.kind}`} style={{ '--fx-color': f.color }}
              onAnimationEnd={() => setFlashes(cur => cur.filter(x => x.id !== f.id))} />
          ))}
        </div>
        {passivelyHidden && (
          <div className="token-hiding-badge" title={`Hidden from players with passive perception below ${hideThreshold}`}>
            <span className="thb-glyph">◐</span>{hideThreshold}
          </div>
        )}
        {showLabel && <div className="token-label">{entity.name}</div>}
        {showLabel && (statusItems.length > 0 || sicknessLabel) && (
          <div className="token-status-stack">
            {statusItems.map(c => (
              <span key={c} className="token-status-chip" title={c}
                style={{ background: CONDITION_COLORS[c] || 'rgba(120,120,120,0.85)' }}>
                {c}
              </span>
            ))}
            {sicknessLabel && (
              <span className="token-status-chip sickness" title="Sickness">
                <em>{sicknessLabel.toLowerCase()}</em>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// MAP CANVAS
// ====================================================================
// v7.8: the currently-mounted MapCanvas registers itself here so the bestiary's
// touch drag-to-place (pointer-based, since native DnD is mouse-only) can hand
// off a drop. { test(clientX,clientY)->bool, drop(clientX,clientY,entityId) }.
let _touchDropTarget = null;
function MapCanvas({
  map, entities, tokens, initiative, mode, peerId, claimedEntityId, ownedEntityIds,
  onTokenMove, onTokenDoubleClick, onTokenContextMenu,
  onPlaceEntity, onPlaceRequest, onViewportChange, selectedTokenId,
  hiddenLayers = null,
  // v6 #12: multi-select
  selectedTokenIds, onTokenSingleClick, onSelectTokens,
  mapScale = 1.0,
  // v7.8: combat movement budget + marker opacity
  movement = null, moveRangeOpacity = 0.55, lockOffTurn = false,
  reminders = [], onReminderUpsert, onReminderDelete,
  placingReminder = false, onPlaceReminderDone,
  hoveredTokenId, onTokenHoverChange,
  // v3:
  visionEnabled = false,      // whether to dim the map where nothing sees
  visionSources = [],         // [{ x, y, radius }] - in world pixels
  blockZones = [],            // [{ id, x, y, w, h }] - in world pixels
  placingBlock = false, onPlaceBlockDone, onBlockUpsert, onBlockDelete,
  placingFreeBlock = false, onPlaceFreeBlockDone,
  // v6 #8 + #13: two new block modes - circle draw + eraser.
  placingCircleBlock = false, onPlaceCircleBlockDone,
  erasingBlock = false, onPlaceEraseBlockDone,
  // v6 #11: measuring tools (line + radius). Available to DM and players.
  measureMode = null,         // null | 'line' | 'radius'
  onMeasureModeDone,
  // v6 #10: drawing tool - free / line / circle with color + width.
  drawings = [],              // [{id, type, ..., color, width, owner}]
  drawMode = null,            // null | 'free' | 'line' | 'circle'
  drawColor = '#c9a34a',
  drawWidth = 3,
  drawOwner = null,           // peerId or 'dm' - tags the drawing
  onDrawingUpsert,
  onDrawingDelete,            // v7.5: (drawingId) - erase one drawing
  // v6 #9: hazard polygons. Rendered with per-type styling. Hazards
  // with visible === false are already stripped for players in the
  // sync filter; DM sees all.
  hazards = [],
  placingHazard = null,       // null | 'fire' | 'flood' | 'cold' | 'acid' | 'fog' | 'difficult'
  hazardVisibleDefault = true,
  onHazardUpsert,
  onHazardDelete,
  onPlaceHazardDone,
  // v7.7: per-map image layers + a single commit callback. The DM wires
  // this to a LAYER_UPDATE dispatch; players wire it to a layer_transform
  // action. Editability is decided per-layer below (mode + dmOnly + role).
  layers = [],
  onLayerTransform,
}) {
  const wrapRef = useRef(null);
  const stageRef = useRef(null);
  const [viewport, setViewport] = useState(map?.viewport || { x: 0, y: 0, zoom: 1 });
  const [panning, setPanning] = useState(false);
  const panRef = useRef(null);
  // v7.8: active touch/pen pointers on the backdrop + current pinch session,
  // for two-finger pinch-zoom (and two-finger pan) on touchscreens.
  const pointersRef = useRef(new Map());
  const pinchRef = useRef(null);
  // v7.8: touch niceties - double-tap-to-recenter + flick inertia on pan.
  const lastTapRef = useRef(null);   // { t, x, y } of the previous tap
  const panVelRef = useRef(null);    // running pan velocity (px/ms) for inertia
  const inertiaRef = useRef(null);   // requestAnimationFrame handle
  const dragTokenRef = useRef(null);
  const [, forceRender] = useState(0);
  const [dragOver, setDragOver] = useState(false);

  // v7.4 LIGHTING FIX: the vision mask, block-zone layer, drawing
  // layer, hazard layer, and measuring layer were all hardcoded to a
  // -4000 → +4000 (8000 square) bounding box. Maps larger than that
  // had their outer edges permanently light (or permanently dark on
  // the player side) because the dark-fill rectangle of the vision
  // mask simply didn't extend over them.
  //
  // Fix: measure the map image's natural size on load and compute a
  // bounding box that covers it with 4000px of padding on every side
  // (so tokens can light outside the map edge without clipping the
  // mask). Minimum 8000 to preserve old behavior on unmapped canvases.
  // One useState so all five layers re-render cohesively.
  const [mapBounds, setMapBounds] = useState({ W: 8000, H: 8000, OFF: 4000 });
  const onMapImageLoad = (e) => {
    const img = e?.target;
    if (!img) return;
    // Natural dimensions in world pixels (tokens and all overlays use
    // world pixels; the stage transform handles screen-space scaling).
    // Pad each axis with 4000 world-px so tokens can illuminate beyond
    // the map edge without clipping the mask.
    const nw = img.naturalWidth || 0;
    const nh = img.naturalHeight || 0;
    const W = Math.max(8000, Math.ceil(nw + 8000));
    const H = Math.max(8000, Math.ceil(nh + 8000));
    const OFF = 4000;
    setMapBounds(prev => (prev.W === W && prev.H === H && prev.OFF === OFF) ? prev : { W, H, OFF });
  };
  // v3: in-progress block zone rectangle while DM is dragging to draw.
  // Lives locally; committed to state on pointer-up via onBlockUpsert.
  const [drawingBlock, setDrawingBlock] = useState(null);
  // v4 #16: freeform polygon-in-progress as pointer is being dragged.
  // Stored as [[x,y], ...] in world coordinates.
  const [drawingPoly, setDrawingPoly] = useState(null);
  // v6 #8: circle-in-progress {cx, cy, r}
  const [drawingCircle, setDrawingCircle] = useState(null);
  // v6 #13: eraser active while pointer is down
  const [erasingActive, setErasingActive] = useState(false);
  // v6 #12: drag-to-select box in world coordinates (DM only).
  //   null → no box in progress; {x0,y0,x1,y1} → currently dragging
  const [selectionBox, setSelectionBox] = useState(null);
  // v6 #11: in-progress measurement - {x0,y0,x1,y1} in world coords.
  // Applies to 'line' and 'radius' modes; v7 also supports 'tokenToToken'.
  const [measuring, setMeasuring] = useState(null);
  // v7 #3: token-to-token measurement. Holds the first-clicked token id
  // while we wait for a second click. On the second click, commit a
  // one-shot line measure between the two token centers and clear.
  const [t2tStartId, setT2tStartId] = useState(null);
  // v6 #10: in-progress drawing. For free mode it's {type:'free', points:[[x,y]...]};
  // for line/circle it's {type, x0,y0,x1,y1 | cx,cy,r}.
  const [drawingNow, setDrawingNow] = useState(null);
  const drawRef = useRef(null);

  // v7.6: reminder customisation (per-viewer). `reminderDefault` is the
  // colour + size applied to newly-dropped pins (last-used wins, so
  // adjusting a pin updates the default). `editingReminder` holds the pin
  // currently open in the editor popover, with screen coords for placement.
  const [reminderDefault, setReminderDefault] = useState({ color: '#c9a34a', size: 1 });
  const [editingReminder, setEditingReminder] = useState(null); // { id, sx, sy }

  // Update viewport when map changes
  useEffect(() => {
    setViewport(map?.viewport || { x: 0, y: 0, zoom: 1 });
  }, [map?.id]);

  // persist viewport debounced
  useEffect(() => {
    const handle = setTimeout(() => {
      if (mode === 'dm' && map) {
        onViewportChange?.(map.id, viewport);
      }
    }, 500);
    return () => clearTimeout(handle);
  }, [viewport.x, viewport.y, viewport.zoom]);

  const screenToWorld = useCallback((sx, sy) => {
    const rect = wrapRef.current.getBoundingClientRect();
    // The stage is transformed with translate(viewport) then
    // scale(viewport.zoom * mapScale), so the inverse must divide by the
    // SAME combined scale - omitting mapScale here is what caused drawings
    // and measurements to land offset from the cursor whenever the DM had
    // set a map scale other than 100%.
    const scale = viewport.zoom * (mapScale || 1);
    return {
      x: (sx - rect.left - viewport.x) / scale,
      y: (sy - rect.top - viewport.y) / scale,
    };
  }, [viewport, mapScale]);

  // --- Panning + placement ---
  const onWrapPointerDown = (e) => {
    // v7.8: any new touch halts an in-flight inertia glide.
    cancelInertia();
    // Only react to pointer-downs on the canvas backdrop, not on tokens/pins.
    if (e.target !== wrapRef.current
        && !e.target.classList.contains('canvas-stage')
        && !e.target.classList.contains('map-image')) return;

    // v3: Block-zone rectangle draw mode (DM only).
    if (placingBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      drawRef.current = { startX: world.x, startY: world.y };
      setDrawingBlock({ x: world.x, y: world.y, w: 0, h: 0 });
      return;
    }

    // v7 #2: Freeform polygon block draw (DM only). Pointer-down starts
    // a polyline; pointer-move appends; pointer-up commits as polygon.
    if (placingFreeBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly([[world.x, world.y]]);
      setPolySession(s => s + 1);
      return;
    }

    // v7 #2: Hazard polygon draw (DM only). Same lifecycle as freeform
    // block polygons, but commits as a hazard instead.
    if (placingHazard && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly([[world.x, world.y]]);
      setPolySession(s => s + 1);
      return;
    }

    // v7 #2: Circle block draw (DM only). Pointer-down anchors the center,
    // drag expands the radius, pointer-up commits as { type: 'circle', cx, cy, r }.
    if (placingCircleBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      drawRef.current = { cx: world.x, cy: world.y };
      setDrawingCircle({ cx: world.x, cy: world.y, r: 0 });
      setCircleSession(s => s + 1);
      return;
    }

    // v7 #7: Polygon-cut eraser (DM only). The eraser is now a polygon
    // tool: drag out a freeform polygon, on release every block whose
    // centroid (or all vertices) falls inside the cut is removed.
    // Reuses the same polygon pointer lifecycle as block / hazard,
    // dispatching to the cut handler on commit.
    if (erasingBlock && mode === 'dm') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly([[world.x, world.y]]);
      setPolySession(s => s + 1);
      return;
    }

    // Reminder placement is handled by onStagePointerClick below, so a
    // click is committed on pointer-up (lets panning still work if the
    // user changes their mind).
    if (placingReminder) return;

    // v7 #11: Measuring mode - start a line/radius from this point.
    // Cancels any lingering hold timer from a prior measurement.
    if (measureMode) {
      e.preventDefault();
      if (measureTimerRef.current) {
        clearTimeout(measureTimerRef.current);
        measureTimerRef.current = null;
      }
      // v7.6: starting a new measurement drops any lingering/fading one.
      if (lingerTimerRef.current) { clearTimeout(lingerTimerRef.current); lingerTimerRef.current = null; }
      setLingerMeasure(null);
      const world = screenToWorld(e.clientX, e.clientY);
      setMeasuring({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      setMeasureSession(s => s + 1);
      return;
    }

    // v7.5: Drawing eraser - click a drawing to remove it. Handled
    // before the free/line/circle branch so 'erase' never starts a new
    // stroke. Hit-tests every drawing on this map (topmost first) and
    // deletes the first one the cursor lands on. Permission is enforced
    // here for players (own drawings only) and again on the DM side.
    if (drawMode === 'erase') {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      // Tolerance scales with the stroke width and the current zoom so
      // thin lines stay clickable when zoomed out.
      for (let i = drawings.length - 1; i >= 0; i--) {
        const d = drawings[i];
        // Players may only erase their own drawings; the DM erases any.
        if (mode !== 'dm' && d.owner !== drawOwner) continue;
        const tol = Math.max(d.width || 3, 8) + 10 / (viewport.zoom || 1);
        if (hitTestDrawing(world.x, world.y, d, tol)) {
          onDrawingDelete?.(d.id);
          break;
        }
      }
      return;
    }

    // v7 #2: Drawing mode - free / line / circle.
    // Bump the session counter so the lifecycle effect re-arms exactly
    // once for this drawing.
    if (drawMode) {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      if (drawMode === 'free') {
        setDrawingNow({ type: 'free', points: [[world.x, world.y]] });
      } else if (drawMode === 'line') {
        setDrawingNow({ type: 'line', x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      } else if (drawMode === 'circle') {
        setDrawingNow({ type: 'circle', cx: world.x, cy: world.y, r: 0 });
      }
      setDrawSession(s => s + 1);
      return;
    }

    // v6 #12: Shift-drag on empty canvas = marquee select (DM only).
    // Holds the shift key while pressing down on the backdrop.
    if (mode === 'dm' && e.shiftKey) {
      e.preventDefault();
      const world = screenToWorld(e.clientX, e.clientY);
      drawRef.current = { startX: world.x, startY: world.y };
      setSelectionBox({ x0: world.x, y0: world.y, x1: world.x, y1: world.y });
      return;
    }

    // v7.8: track this backdrop pointer. A second concurrent finger turns the
    // gesture into a pinch (zoom + pan) instead of a single-finger pan.
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size >= 2) {
      setPanning(false); // cancel any single-finger pan in progress
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const rect = wrapRef.current.getBoundingClientRect();
      pinchRef.current = {
        startDist: dist,
        startZoom: viewport.zoom,
        startVx: viewport.x,
        startVy: viewport.y,
        startMidX: (pts[0].x + pts[1].x) / 2 - rect.left,
        startMidY: (pts[0].y + pts[1].y) / 2 - rect.top,
      };
      return;
    }

    setPanning(true);
    panRef.current = { startX: e.clientX, startY: e.clientY, vx: viewport.x, vy: viewport.y };
    panVelRef.current = null; // fresh velocity sampling for this pan
  };

  // v3: block-zone rectangle pointer-move / pointer-up lifecycle
  useEffect(() => {
    if (!drawingBlock) return;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      const sx = drawRef.current.startX, sy = drawRef.current.startY;
      setDrawingBlock({
        x: Math.min(sx, world.x),
        y: Math.min(sy, world.y),
        w: Math.abs(world.x - sx),
        h: Math.abs(world.y - sy),
      });
    };
    const onUp = () => {
      const rect = drawingBlock;
      setDrawingBlock(null);
      drawRef.current = null;
      if (rect && rect.w > 8 && rect.h > 8) {
        onBlockUpsert?.({ id: uid('blk_'), x: rect.x, y: rect.y, w: rect.w, h: rect.h });
      }
      onPlaceBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drawingBlock, onBlockUpsert, onPlaceBlockDone, screenToWorld]);

  // v4 #16: freeform polygon pointer-move / pointer-up lifecycle
  // v7 #2: Polygon (freeform block + hazard) lifecycle.
  // Same single-attach pattern as drawings + circle blocks.
  const drawingPolyRef = useRef(null);
  drawingPolyRef.current = drawingPoly;
  const polyCommittedRef = useRef(true);
  const [polySession, setPolySession] = useState(0);
  // Keep latest hazard config in refs so the listener reads current values
  // without needing to re-attach when the DM toggles the visibility default
  // mid-session.
  const placingHazardRef = useRef(placingHazard);
  placingHazardRef.current = placingHazard;
  const hazardVisibleDefaultRef = useRef(hazardVisibleDefault);
  hazardVisibleDefaultRef.current = hazardVisibleDefault;
  // v7 #7: erasing flag in a ref so the polygon commit can route to
  // the cut handler instead of creating a new block.
  const erasingBlockRef = useRef(erasingBlock);
  erasingBlockRef.current = erasingBlock;
  const blockZonesRef = useRef(blockZones);
  blockZonesRef.current = blockZones;
  useEffect(() => {
    if (polySession === 0) return;
    polyCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingPoly(prev => {
        if (!prev) return prev;
        const last = prev[prev.length - 1];
        const dx = world.x - last[0], dy = world.y - last[1];
        if (dx * dx + dy * dy < 25) return prev;
        return [...prev, [world.x, world.y]];
      });
    };
    const onUp = () => {
      if (polyCommittedRef.current) return;
      polyCommittedRef.current = true;
      const poly = drawingPolyRef.current;
      setDrawingPoly(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (poly && poly.length >= 3) {
        if (erasingBlockRef.current) {
          // v7.1 fix: true polygon-clip eraser. Instead of deleting a
          // block only if entirely contained, we now compute each
          // block's shape MINUS the cut polygon and replace the block
          // with its remaining piece(s). Rects and circles are
          // converted to polygons first.
          //
          //   cut fully contains block  → block removed (empty result)
          //   cut partially overlaps    → block replaced by the
          //                               non-overlapping piece(s)
          //   cut doesn't touch block   → block unchanged
          //
          // polygonSubtract returns [] when fully consumed, [originalPoly]
          // when untouched, or [piece1, piece2, ...] when carved.
          for (const z of (blockZonesRef.current || [])) {
            const subjectPoly = blockToPolygon(z);
            const pieces = polygonSubtract(subjectPoly, poly);
            // If pieces === [original subject], the block was untouched.
            const untouched = pieces.length === 1
              && pieces[0].length === subjectPoly.length
              && pieces[0].every((p, i) => Math.abs(p[0] - subjectPoly[i][0]) < 1e-3 && Math.abs(p[1] - subjectPoly[i][1]) < 1e-3);
            if (untouched) continue;
            // Otherwise delete the original and upsert the remaining
            // pieces as new poly-type blocks.
            onBlockDelete?.(z.id);
            for (const piece of pieces) {
              if (piece.length < 3) continue;
              onBlockUpsert?.({ id: uid('blk_'), type: 'poly', points: piece });
            }
          }
        } else if (placingHazardRef.current && onHazardUpsert) {
          onHazardUpsert({
            id: uid('hz_'),
            type: 'polygon',
            hazardKind: placingHazardRef.current,
            points: poly,
            visible: hazardVisibleDefaultRef.current,
          });
        } else if (onBlockUpsert) {
          onBlockUpsert({ id: uid('blk_'), type: 'poly', points: poly });
        }
      }
      onPlaceFreeBlockDone?.();
      onPlaceHazardDone?.();
      onPlaceEraseBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [polySession, onBlockUpsert, onPlaceFreeBlockDone, onHazardUpsert, onPlaceHazardDone, onBlockDelete, onPlaceEraseBlockDone, screenToWorld]);

  // v7 #2: Selection-box (marquee) lifecycle - session-keyed.
  const selectionBoxRef = useRef(null);
  selectionBoxRef.current = selectionBox;
  const selectionCommittedRef = useRef(true);
  const [selectionSession, setSelectionSession] = useState(0);
  useEffect(() => {
    if (selectionSession === 0) return;
    selectionCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setSelectionBox(prev => prev ? { ...prev, x1: world.x, y1: world.y } : prev);
    };
    const onUp = () => {
      if (selectionCommittedRef.current) return;
      selectionCommittedRef.current = true;
      const box = selectionBoxRef.current;
      setSelectionBox(null);
      drawRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!box || !onSelectTokens) return;
      const x0 = Math.min(box.x0, box.x1), x1 = Math.max(box.x0, box.x1);
      const y0 = Math.min(box.y0, box.y1), y1 = Math.max(box.y0, box.y1);
      if (x1 - x0 < 4 && y1 - y0 < 4) return;
      const ids = [];
      for (const t of Object.values(tokens)) {
        if (t.mapId !== map?.id) continue;
        if (t.x >= x0 && t.x <= x1 && t.y >= y0 && t.y <= y1) ids.push(t.id);
      }
      onSelectTokens(ids);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [selectionSession, tokens, map?.id, screenToWorld, onSelectTokens]);

  // v7 #4 + #11: Measuring lifecycle.
  // The v6 version had three problems:
  //   (a) effect re-attached on every state change → multiple pointerup
  //       listeners stacked → double-commit / lingering preview
  //   (b) the 1.2s hold timer was never cleared on mode switch, so a
  //       line measure could leak into a fresh radius measure
  //   (c) cleanup didn't remove pointerup
  // Fix: session counter (single attach), commit-once guard, the 1.2s
  // hold timer is stored in a ref + cleared on mode change, and
  // switching mode forces measuring to null.
  const measuringRef = useRef(null);
  measuringRef.current = measuring;
  const measureModeRef = useRef(measureMode);
  measureModeRef.current = measureMode;
  const measureCommittedRef = useRef(true);
  const measureTimerRef = useRef(null);
  const [measureSession, setMeasureSession] = useState(0);
  // v7.6: a committed measurement lingers on screen - fully visible for 5s,
  // then fades out over a further 5s - before clearing. It's tracked
  // separately from the in-progress `measuring` so it survives the tool
  // auto-exiting (which resets measureMode and clears `measuring`).
  const [lingerMeasure, setLingerMeasure] = useState(null);
  const lingerTimerRef = useRef(null);
  const lingerMeasurement = (m, isRadius) => {
    if (!m) return;
    if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current);
    setLingerMeasure({ x0: m.x0, y0: m.y0, x1: m.x1, y1: m.y1, isRadius: !!isRadius, key: Date.now() });
    lingerTimerRef.current = setTimeout(() => { setLingerMeasure(null); lingerTimerRef.current = null; }, TUNING.measureLingerMs);
  };
  useEffect(() => () => { if (lingerTimerRef.current) clearTimeout(lingerTimerRef.current); }, []);
  // Shared renderer for the line / radius / token-to-token measurement
  // overlay. `fading` adds the 5s-hold-then-5s-fade animation class.
  const renderMeasureSvg = (m, fading, keyId) => {
    const { x0, y0, x1, y1, isRadius } = m;
    const dx = x1 - x0, dy = y1 - y0;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const distFt = Math.round(distPx / PX_PER_FOOT);
    const midX = (x0 + x1) / 2, midY = (y0 + y1) / 2;
    return (
      <svg key={keyId} className={`measure-overlay${fading ? ' measure-fade' : ''}`}
        xmlns="http://www.w3.org/2000/svg"
        style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: 9, overflow: 'visible' }}
        viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}>
        {isRadius ? (
          <>
            <circle cx={x0} cy={y0} r={distPx}
              fill="rgba(212,165,116,0.08)" stroke="rgba(212,165,116,0.85)" strokeWidth="1.5" strokeDasharray="4 3" />
            <circle cx={x0} cy={y0} r={3} fill="rgba(212,165,116,0.95)" />
          </>
        ) : (
          <>
            <line x1={x0} y1={y0} x2={x1} y2={y1}
              stroke="rgba(212,165,116,0.95)" strokeWidth="2" strokeDasharray="5 3" />
            <circle cx={x0} cy={y0} r={3} fill="rgba(212,165,116,0.95)" />
            <circle cx={x1} cy={y1} r={3} fill="rgba(212,165,116,0.95)" />
          </>
        )}
        <foreignObject x={isRadius ? x0 : midX} y={isRadius ? y0 : midY} width="80" height="26" style={{ overflow: 'visible' }}>
          <div className="measure-label" style={{ transform: 'translate(-50%, -50%)' }}>
            {distFt} ft{isRadius ? ' radius' : ''}
          </div>
        </foreignObject>
      </svg>
    );
  };
  // Whenever the active mode changes (or clears), kill any lingering
  // preview + clear the hold timer so we never see a phantom line/circle
  // from a previous measurement. Also resets t2t pending start.
  useEffect(() => {
    if (measureTimerRef.current) {
      clearTimeout(measureTimerRef.current);
      measureTimerRef.current = null;
    }
    setMeasuring(null);
    setT2tStartId(null);
  }, [measureMode]);
  useEffect(() => {
    if (measureSession === 0) return;
    measureCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setMeasuring(prev => prev ? { ...prev, x1: world.x, y1: world.y } : prev);
    };
    const onUp = () => {
      if (measureCommittedRef.current) return;
      measureCommittedRef.current = true;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      // v7.6: hand the final reading to the lingering layer (5s hold + 5s
      // fade), then clear the in-progress preview and exit the tool.
      lingerMeasurement(measuringRef.current, measureModeRef.current === 'radius');
      setMeasuring(null);
      if (measureTimerRef.current) { clearTimeout(measureTimerRef.current); measureTimerRef.current = null; }
      onMeasureModeDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [measureSession, screenToWorld, onMeasureModeDone]);

  // v7 fix #2: Drawing pointer-move / pointer-up lifecycle.
  // The v6 implementation had `useEffect` depend on `drawingNow`, which
  // meant every pointermove → setDrawingNow → effect cleanup + re-attach,
  // and the `pointerup` listener (registered with `{ once: true }`) was
  // never removed by cleanup. Result: N listeners stacked → N copies of
  // every shape committed on release.
  //
  // The fix: depend only on a session counter that increments on each
  // pointer-down. The effect attaches its listeners exactly once per
  // session and uses a ref to read the latest drawing state. A
  // commit-once guard prevents double-commit even if duplicate up events
  // sneak through (touchscreens occasionally do this).
  const drawingNowRef = useRef(null);
  drawingNowRef.current = drawingNow;
  const drawCommittedRef = useRef(true); // start as "committed" so no listener fires
  const [drawSession, setDrawSession] = useState(0);
  useEffect(() => {
    if (drawSession === 0) return;
    drawCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      setDrawingNow(prev => {
        if (!prev) return prev;
        if (prev.type === 'free') {
          const last = prev.points[prev.points.length - 1];
          const dx = world.x - last[0], dy = world.y - last[1];
          if (dx * dx + dy * dy < 9) return prev;
          return { ...prev, points: [...prev.points, [world.x, world.y]] };
        }
        if (prev.type === 'line') return { ...prev, x1: world.x, y1: world.y };
        if (prev.type === 'circle') {
          const dx = world.x - prev.cx, dy = world.y - prev.cy;
          return { ...prev, r: Math.sqrt(dx * dx + dy * dy) };
        }
        return prev;
      });
    };
    const onUp = () => {
      // Commit-once guard: a single pointerup must produce a single shape.
      if (drawCommittedRef.current) return;
      drawCommittedRef.current = true;
      const d = drawingNowRef.current;
      setDrawingNow(null);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (!d || !onDrawingUpsert) return;
      // Size guards prevent click-blob commits.
      if (d.type === 'free' && d.points.length < 2) return;
      if (d.type === 'line' && Math.hypot(d.x1 - d.x0, d.y1 - d.y0) < 6) return;
      if (d.type === 'circle' && d.r < 4) return;
      onDrawingUpsert({
        ...d,
        id: uid('draw_'),
        color: drawColor,
        width: drawWidth,
        owner: drawOwner,
      });
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [drawSession, screenToWorld, onDrawingUpsert, drawColor, drawWidth, drawOwner]);
  // v7 #2: Circle block lifecycle. Same fix as freehand drawings -
  // session counter so the effect attaches listeners exactly once per
  // drag, ref-based reads, commit-once guard.
  const drawingCircleRef = useRef(null);
  drawingCircleRef.current = drawingCircle;
  const circleCommittedRef = useRef(true);
  const [circleSession, setCircleSession] = useState(0);
  useEffect(() => {
    if (circleSession === 0) return;
    circleCommittedRef.current = false;
    const onMove = (e) => {
      const world = screenToWorld(e.clientX, e.clientY);
      const cx = drawRef.current?.cx, cy = drawRef.current?.cy;
      if (cx === undefined || cy === undefined) return;
      const dx = world.x - cx, dy = world.y - cy;
      const r = Math.sqrt(dx * dx + dy * dy);
      setDrawingCircle({ cx, cy, r });
    };
    const onUp = () => {
      if (circleCommittedRef.current) return;
      circleCommittedRef.current = true;
      const c = drawingCircleRef.current;
      setDrawingCircle(null);
      drawRef.current = null;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (c && c.r > 8) {
        onBlockUpsert?.({ id: uid('blk_'), type: 'circle', cx: c.cx, cy: c.cy, r: c.r });
      }
      onPlaceCircleBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [circleSession, onBlockUpsert, onPlaceCircleBlockDone, screenToWorld]);

  // v6 #13: Block eraser. While the pointer is pressed, any block zone
  // whose hit-test shape contains the cursor's world position gets deleted.
  //   rect:   point-in-rect test (x,y,w,h)
  //   circle: distance ≤ r
  //   poly:   ray-casting (even-odd) point-in-polygon
  // pointInPoly is defined at module level (above) so it's hoisted and
  // usable in earlier hooks too.
  const eraseAtClient = useCallback((clientX, clientY) => {
    const world = screenToWorld(clientX, clientY);
    for (const z of blockZones) {
      let hit = false;
      if (z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3) {
        hit = pointInPoly(world.x, world.y, z.points);
      } else if (z.type === 'circle' && typeof z.cx === 'number') {
        const dx = world.x - z.cx, dy = world.y - z.cy;
        hit = (dx * dx + dy * dy) <= (z.r * z.r);
      } else {
        // Rect (legacy shape)
        hit = world.x >= z.x && world.x <= z.x + z.w
           && world.y >= z.y && world.y <= z.y + z.h;
      }
      if (hit) onBlockDelete?.(z.id);
    }
  }, [blockZones, onBlockDelete, screenToWorld]);

  useEffect(() => {
    if (!erasingActive) return;
    const onMove = (e) => eraseAtClient(e.clientX, e.clientY);
    const onUp = () => {
      setErasingActive(false);
      onPlaceEraseBlockDone?.();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [erasingActive, eraseAtClient, onPlaceEraseBlockDone]);

  // v7.8: flick inertia. Glides the viewport after a touch pan-flick and
  // decays to a stop; cancelled the instant a new pointer touches down.
  const cancelInertia = useCallback(() => {
    if (inertiaRef.current) { cancelAnimationFrame(inertiaRef.current); inertiaRef.current = null; }
  }, []);
  const startInertia = useCallback((vx, vy) => {
    cancelInertia();
    // cap launch speed so a hard flick glides briskly, not endlessly
    const sp = Math.hypot(vx, vy);
    const MAXV = 2.5; // px/ms
    if (sp > MAXV) { vx = vx / sp * MAXV; vy = vy / sp * MAXV; }
    let last = performance.now();
    const step = (nowT) => {
      const dt = Math.min(64, nowT - last); last = nowT;
      setViewport(v => ({ ...v, x: v.x + vx * dt, y: v.y + vy * dt }));
      const decay = Math.pow(0.90, dt / 16); // ~10%/frame at 60fps - settles in ~0.6s
      vx *= decay; vy *= decay;
      if (Math.hypot(vx, vy) > 0.02) inertiaRef.current = requestAnimationFrame(step);
      else inertiaRef.current = null;
    };
    inertiaRef.current = requestAnimationFrame(step);
  }, [cancelInertia]);
  useEffect(() => () => cancelInertia(), [cancelInertia]);

  useEffect(() => {
    if (!panning) return;
    const onMove = (e) => {
      const now = performance.now();
      const dx = e.clientX - panRef.current.startX;
      const dy = e.clientY - panRef.current.startY;
      setViewport(v => ({ ...v, x: panRef.current.vx + dx, y: panRef.current.vy + dy }));
      // track a lightly-smoothed pointer velocity (px/ms) for flick inertia
      const last = panVelRef.current;
      if (last && now > last.t) {
        const dtv = now - last.t;
        const ivx = (e.clientX - last.x) / dtv, ivy = (e.clientY - last.y) / dtv;
        panVelRef.current = {
          x: e.clientX, y: e.clientY, t: now,
          vx: 0.6 * ivx + 0.4 * (last.vx || 0),
          vy: 0.6 * ivy + 0.4 * (last.vy || 0),
        };
      } else {
        panVelRef.current = { x: e.clientX, y: e.clientY, t: now, vx: 0, vy: 0 };
      }
    };
    const onUp = (e) => {
      setPanning(false);
      const start = panRef.current;
      const moved = start ? Math.hypot(e.clientX - start.startX, e.clientY - start.startY) : 0;
      // double-tap to recenter (touch only): two quick taps in the same spot
      if (e.pointerType === 'touch' && moved < 8) {
        const now = Date.now();
        const lt = lastTapRef.current;
        if (lt && now - lt.t < 300 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 40) {
          lastTapRef.current = null;
          resetView();
        } else {
          lastTapRef.current = { t: now, x: e.clientX, y: e.clientY };
        }
        return;
      }
      // flick inertia (touch only): glide if released while still moving
      const vel = panVelRef.current;
      if (e.pointerType === 'touch' && vel && moved >= 8
          && (performance.now() - vel.t) < 80
          && Math.hypot(vel.vx, vel.vy) > 0.05) {
        startInertia(vel.vx, vel.vy);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, [panning, startInertia]);

  // v7.8: two-finger pinch-zoom + pan for touchscreens. Tracks the two
  // backdrop pointers and maps their spread to zoom (anchored on the initial
  // midpoint, like the wheel zoom keeps the cursor stable) and their midpoint
  // drift to a pan. Inert unless a pinch session is active. Uses refs so the
  // window listeners can stay mounted with stable deps.
  useEffect(() => {
    const onMove = (e) => {
      if (!pointersRef.current.has(e.pointerId)) return;
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const pinch = pinchRef.current;
      if (!pinch || pointersRef.current.size < 2) return;
      const pts = [...pointersRef.current.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      const rect = wrapRef.current.getBoundingClientRect();
      const curMidX = (pts[0].x + pts[1].x) / 2 - rect.left;
      const curMidY = (pts[0].y + pts[1].y) / 2 - rect.top;
      const nextZoom = clamp(pinch.startZoom * (dist / pinch.startDist), 0.15, 4);
      const ratio = nextZoom / pinch.startZoom;
      // zoom about the starting midpoint, then translate by midpoint drift
      let nx = pinch.startMidX - (pinch.startMidX - pinch.startVx) * ratio;
      let ny = pinch.startMidY - (pinch.startMidY - pinch.startVy) * ratio;
      nx += (curMidX - pinch.startMidX);
      ny += (curMidY - pinch.startMidY);
      setViewport({ x: nx, y: ny, zoom: nextZoom });
    };
    const onRelease = (e) => {
      pointersRef.current.delete(e.pointerId);
      if (pointersRef.current.size < 2) pinchRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onRelease);
    window.addEventListener('pointercancel', onRelease);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onRelease);
      window.removeEventListener('pointercancel', onRelease);
    };
  }, []);

  // --- Wheel zoom ---
  const onWheel = (e) => {
    e.preventDefault();
    const delta = -e.deltaY * 0.0015;
    const nextZoom = clamp(viewport.zoom * (1 + delta), 0.15, 4);
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    // keep mouse position stable
    const ratio = nextZoom / viewport.zoom;
    const nx = mx - (mx - viewport.x) * ratio;
    const ny = my - (my - viewport.y) * ratio;
    setViewport({ x: nx, y: ny, zoom: nextZoom });
  };
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [viewport]);

  // --- Token dragging ---
  //
  // v7.4 drag rewrite (replaces the buggy v7.3 rewrite).
  //
  // The v7.3 version froze closure state: its effect had `[]` deps so
  // `screenToWorld` was captured at mount and went stale the moment the
  // user panned or zoomed. It also removed the `forceRender` that was
  // applying the `.dragging` class during drag, so the CSS transition
  // `transition: left 220ms` kept interpolating every DOM write - the
  // token crawled behind the cursor by a fifth of a second.
  //
  // v7.4 fixes:
  //   - use refs for everything the handlers need to read, so the
  //     effect can still have `[]` deps AND read fresh values
  //     (screenToWorld, tokens, onTokenMove all via refs)
  //   - stamp `.dragging` directly on the token DOM node at drag
  //     start and strip it at drag end - no React re-render needed
  //     during drag, and more importantly the CSS transition is
  //     actually suppressed so the token follows the cursor 1:1
  //   - pointercancel / blur / visibilitychange still abort without
  //     committing (carries forward v7.3's mobile hardening)
  //   - pointerId still tracked so a second finger can't tear down
  //     the primary drag
  //   - before calling onTokenMove, we clear the DOM inline position
  //     so React's next render is authoritative
  const screenToWorldRef = useRef(screenToWorld);
  screenToWorldRef.current = screenToWorld;
  const tokensRef = useRef(tokens);
  tokensRef.current = tokens;
  const onTokenMoveRef = useRef(onTokenMove);
  onTokenMoveRef.current = onTokenMove;
  const onPlaceEntityRef = useRef(onPlaceEntity);
  onPlaceEntityRef.current = onPlaceEntity;

  // v7.8: register this canvas as the touch drag-to-place target. Native HTML5
  // drag-and-drop never fires on touchscreens, so the bestiary runs its own
  // pointer drag and hands the drop here (we own the screen->world transform).
  useEffect(() => {
    const target = {
      test: (x, y) => {
        const r = wrapRef.current?.getBoundingClientRect();
        return !!r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      },
      drop: (x, y, entityId) => {
        if (!entityId) return;
        const w = screenToWorldRef.current(x, y);
        onPlaceEntityRef.current?.(entityId, w.x, w.y);
      },
    };
    _touchDropTarget = target;
    return () => { if (_touchDropTarget === target) _touchDropTarget = null; };
  }, []);

  const startTokenDrag = (tokenId, e) => {
    cancelInertia(); // a token grab also halts any inertia glide
    const token = tokensRef.current[tokenId];
    if (!token) return;
    const point = e.touches ? e.touches[0] : e;
    const world = screenToWorldRef.current(point.clientX, point.clientY);
    // v7.8: if this is the player moving their own token on its initiative
    // turn, constrain the drag to the remaining movement range so they can
    // SEE the limit and never overshoot. No clamp for the DM or off-turn.
    let clamp = null;
    const ent = entities[token.entityId];
    const isMyActiveTurn = mode === 'player' && initiative?.active
      && initiative.entries[initiative.turn]?.entityId === token.entityId
      && (ownedEntityIds ? ownedEntityIds.has(token.entityId) : claimedEntityId === token.entityId);
    // v8.4: the DM is likewise budget-limited when moving the creature whose
    // turn it currently is, as long as that creature is DM-run (not a PC or a
    // player's familiar - those are moved by their owners).
    const isDmActiveTurn = mode === 'dm' && initiative?.active
      && initiative.entries[initiative.turn]?.entityId === token.entityId
      && ent && ent.type !== 'PC' && ent.type !== 'Familiar';
    if ((isMyActiveTurn || isDmActiveTurn) && ent) {
      const isMover = movement && movement.entityId === token.entityId;
      const speedFt = (isMover && movement.budgetFt != null) ? movement.budgetFt : walkSpeedOf(ent);
      const usedFt = isMover ? (movement.usedFt || 0) : 0;
      const remainingPx = Math.max(0, speedFt - usedFt) * PX_PER_FOOT;
      clamp = { originX: token.x, originY: token.y, remainingPx };
    }
    dragTokenRef.current = {
      tokenId,
      offsetX: world.x - token.x,
      offsetY: world.y - token.y,
      lastX: token.x, lastY: token.y,
      pointerId: (e.pointerId != null) ? e.pointerId : null,
      clamp,
    };
    // Stamp the .dragging class directly on the DOM so:
    //  1. CSS suppresses the `transition: left/top 220ms` so the token
    //     follows the cursor 1:1 rather than easing into position
    //  2. z-index bumps above peers so the dragged token sits on top
    // No React re-render needed - we avoid touching React's render
    // cycle during drag entirely.
    const el = document.querySelector(`[data-tok="${tokenId}"]`);
    if (el) el.classList.add('dragging');
  };

  useEffect(() => {
    // End-of-drag helper. `commit` controls whether the move is sent
    // upstream. On pointerup: commit. On pointercancel / blur: abort.
    // Always clears dragTokenRef BEFORE calling onTokenMove so a
    // synchronous dispatch can't re-enter this code with a stale ref.
    const endDrag = (commit) => {
      const ref = dragTokenRef.current;
      if (!ref) return;
      dragTokenRef.current = null;
      const tokenEl = document.querySelector(`[data-tok="${ref.tokenId}"]`);
      if (tokenEl) {
        tokenEl.classList.remove('dragging');
        if (!commit) {
          // Abort path (pointercancel / blur / visibilitychange): clear
          // the inline style so React's next render snaps the token
          // back to its committed (unchanged) position.
          tokenEl.style.left = '';
          tokenEl.style.top = '';
        }
        // On commit: LEAVE the inline style in place. The token is
        // sitting at its final drop position. We're about to dispatch
        // TOKEN_MOVE which will re-render with the same coordinates;
        // React will reconcile the style prop and things stay put.
        // Clearing the inline style here would cause a 1-frame flash
        // back to the pre-drag position before React re-renders.
      }
      if (commit) {
        // v7.5: log the commit so we can trace the full chain when
        // propagation fails.
        dlog(`[plagues-call] drag end → commit token=${ref.tokenId.slice(-6)} x=${ref.lastX.toFixed(0)} y=${ref.lastY.toFixed(0)} cb=${typeof onTokenMoveRef.current === 'function'}`);
        onTokenMoveRef.current?.(ref.tokenId, ref.lastX, ref.lastY);
      } else {
        dlog(`[plagues-call] drag end → abort token=${ref.tokenId.slice(-6)}`);
      }
    };
    const matchesPointer = (e) => {
      const ref = dragTokenRef.current;
      if (!ref || ref.pointerId == null) return true;
      if (e?.pointerId == null) return true;
      return e.pointerId === ref.pointerId;
    };
    const onMove = (e) => {
      const ref = dragTokenRef.current;
      if (!ref) return;
      if (!matchesPointer(e)) return;
      const world = screenToWorldRef.current(e.clientX, e.clientY);
      let x = world.x - ref.offsetX;
      let y = world.y - ref.offsetY;
      // v7.8: clamp onto the remaining-movement circle when on-turn.
      if (ref.clamp) {
        const dx = x - ref.clamp.originX, dy = y - ref.clamp.originY;
        const d = Math.hypot(dx, dy);
        if (d > ref.clamp.remainingPx && d > 0) {
          const k = ref.clamp.remainingPx / d;
          x = ref.clamp.originX + dx * k;
          y = ref.clamp.originY + dy * k;
        }
      }
      ref.lastX = x;
      ref.lastY = y;
      const tokenEl = document.querySelector(`[data-tok="${ref.tokenId}"]`);
      if (tokenEl) {
        if (tokenEl.classList.contains('token-label-text')) {
          tokenEl.style.left = x + 'px';
          tokenEl.style.top = y + 'px';
        } else {
          tokenEl.style.left = (x - 18) + 'px';
          tokenEl.style.top = (y - 18) + 'px';
        }
      }
    };
    const onUp = (e) => {
      if (!matchesPointer(e)) return;
      endDrag(true);
    };
    const onCancel = (e) => {
      if (!matchesPointer(e)) return;
      endDrag(false);
    };
    const onBlur = () => endDrag(false);
    const onVisibilityChange = () => {
      if (document.hidden) endDrag(false);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (dragTokenRef.current) {
        const ref = dragTokenRef.current;
        dragTokenRef.current = null;
        const tokenEl = document.querySelector(`[data-tok="${ref.tokenId}"]`);
        if (tokenEl) {
          tokenEl.classList.remove('dragging');
          tokenEl.style.left = '';
          tokenEl.style.top = '';
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- HTML5 drag & drop from sidebar ---
  const layerHidden = (k) => !!(hiddenLayers && hiddenLayers.has && hiddenLayers.has(k));
  const onDragOver = (e) => {
    if (mode !== 'dm' && mode !== 'player') return;
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    const entityId = e.dataTransfer.getData('text/entity-id');
    if (!entityId) return;
    const world = screenToWorld(e.clientX, e.clientY);
    if (mode === 'dm') {
      onPlaceEntity?.(entityId, world.x, world.y);
    } else if (mode === 'player') {
      // v8.5: players can't place directly - they request placement and the
      // DM approves it (centered popup on the DM screen).
      onPlaceRequest?.(entityId, world.x, world.y);
    }
  };

  const zoomBy = (factor) => {
    const rect = wrapRef.current.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    const nextZoom = clamp(viewport.zoom * factor, 0.15, 4);
    const ratio = nextZoom / viewport.zoom;
    const nx = mx - (mx - viewport.x) * ratio;
    const ny = my - (my - viewport.y) * ratio;
    setViewport({ x: nx, y: ny, zoom: nextZoom });
  };
  const resetView = () => setViewport({ x: 0, y: 0, zoom: 1 });

  const canDragToken = (t) => {
    if (mode === 'dm') return true;
    const ent = entities[t.entityId];
    if (!ent) return false;
    const owns = (ownedEntityIds && ownedEntityIds.has(ent.id)) || claimedEntityId === ent.id;
    if (!owns) return false;
    // v7.8: off-turn lock: during combat, players may only drag the token
    // whose initiative turn it currently is.
    if (lockOffTurn && initiative?.active && initiative.entries.length) {
      const activeId = initiative.entries[initiative.turn]?.entityId;
      if (activeId !== ent.id) return false;
    }
    return true;
  };

  const currentInitEntityId = initiative.active && initiative.entries[initiative.turn]?.entityId;

  // v7.8: movement-range markers for the active combatant (PC/Familiar only,
  // so monster speeds aren't leaked to players). A faded max-range ring sits
  // at the turn-start point; a brighter remaining-range ring follows the
  // token's current position. Hidden when its token isn't on this map.
  const moveMarker = (() => {
    if (!initiative.active || !currentInitEntityId) return null;
    const ent = entities[currentInitEntityId];
    if (!ent || (ent.type !== 'PC' && ent.type !== 'Familiar')) return null;
    const tok = (tokens ? Object.values(tokens) : []).find(
      t => t.entityId === currentInitEntityId && t.mapId === map?.id);
    if (!tok) return null;
    const isMover = movement && movement.entityId === currentInitEntityId;
    const speedFt = (isMover && movement.budgetFt != null) ? movement.budgetFt : walkSpeedOf(ent);
    const usedFt = isMover ? (movement.usedFt || 0) : 0;
    const remFt = Math.max(0, speedFt - usedFt);
    const maxR = speedFt * PX_PER_FOOT;
    const remR = remFt * PX_PER_FOOT;
    const startX = isMover ? movement.startX : tok.x;
    const startY = isMover ? movement.startY : tok.y;
    const mode = isMover ? (movement.jumpPending ? 'jump' : (movement.mode || 'walk')) : 'walk';
    const dashed = isMover ? !!movement.dashed : false;
    return { maxR, remR, startX, startY, curX: tok.x, curY: tok.y, remFt, speedFt, mode, dashed };
  })();

  // v7.5: a viewer's effective passive perception = the best among the
  // characters they control. The DM perceives everything.
  const viewerPassivePerception = useMemo(() => {
    if (mode === 'dm') return Infinity;
    const ids = ownedEntityIds ? Array.from(ownedEntityIds) : (claimedEntityId ? [claimedEntityId] : []);
    let pp = 0;
    for (const id of ids) {
      const e = entities[id];
      if (e && typeof e.passivePerception === 'number') pp = Math.max(pp, e.passivePerception);
    }
    return pp;
  }, [mode, ownedEntityIds, claimedEntityId, entities]);

  // --- Tokens visible on this map ---
  // v7.5: also applies the passive-hiding rule for players - a token whose
  // entity has passiveHiding > 0 is only shown to a player whose passive
  // perception meets it (their own tokens are always visible to them).
  const visibleTokens = useMemo(
    () => Object.values(tokens).filter(t => {
      if (t.mapId !== map?.id) return false;
      if (mode === 'dm') return true;
      const ent = entities[t.entityId];
      const hide = ent?.passiveHiding || 0;
      if (hide <= 0) return true;
      const owned = ownedEntityIds ? ownedEntityIds.has(t.entityId) : claimedEntityId === t.entityId;
      if (owned) return true;
      return viewerPassivePerception >= hide;
    }),
    [tokens, map?.id, mode, entities, ownedEntityIds, claimedEntityId, viewerPassivePerception]
  );

  // Click-on-empty-canvas while in "placing reminder" mode → drops a reminder.
  const onStagePointerClick = (e) => {
    if (!placingReminder) return;
    // Ignore clicks on actual tokens (they have their own handlers)
    if (e.target.closest('.token')) return;
    if (e.target.closest('.reminder-pin')) return;
    const world = screenToWorld(e.clientX, e.clientY);
    const label = prompt('Reminder label (shown only to you)');
    if (!label) { onPlaceReminderDone?.(); return; }
    onReminderUpsert?.({
      id: uid('rem_'),
      mapId: map?.id || null,
      x: world.x,
      y: world.y,
      label: label.slice(0, 200),
      color: reminderDefault.color,
      size: reminderDefault.size,
    });
    onPlaceReminderDone?.();
  };

  // v7.7: on-canvas layer manipulation. A layer is editable when its mode
  // is move/rotate, it isn't locked, and (if dmOnly) the viewer is the DM.
  // Drag updates a local "live" override for smoothness; the final value is
  // committed once on pointer-up via onLayerTransform.
  const [liveLayer, setLiveLayer] = useState(null);
  const layerDragRef = useRef(null);
  // v7.9 FIX: hold the optimistic position after release until the
  // authoritative layer catches up, so a map object never snaps back to its
  // old spot during the DM round-trip (the same lag tokens used to have).
  const liveLayerRef = useRef(null);
  const pendingLayerRef = useRef(null);
  useEffect(() => () => clearTimeout(pendingLayerRef.current?.timer), []);
  useEffect(() => {
    const p = pendingLayerRef.current;
    if (!p) return;
    const auth = (layers || []).find(l => l.id === p.id);
    const near = (a, b) => Math.abs((a || 0) - (b || 0)) < 0.6;
    if (!auth || (near(auth.x, p.x) && near(auth.y, p.y) && near(auth.rotation, p.rotation))) {
      clearTimeout(p.timer);
      pendingLayerRef.current = null;
      if (liveLayerRef.current && liveLayerRef.current.id === p.id) liveLayerRef.current = null;
      setLiveLayer(c => (c && c.id === p.id) ? null : c);
    }
  }, [layers]);
  const layerEditable = useCallback((l) => {
    if (!l || l.mode === 'locked') return false;
    if (l.dmOnly && mode !== 'dm') return false;
    return l.mode === 'move' || l.mode === 'rotate';
  }, [mode]);
  const startLayerDrag = useCallback((layer, e) => {
    if (!layerEditable(layer) || e.button === 2) return;
    e.stopPropagation();
    e.preventDefault();
    const sw = screenToWorld(e.clientX, e.clientY);
    const cx = layer.x + layer.w / 2, cy = layer.y + layer.h / 2;
    const startAngle = Math.atan2(sw.y - cy, sw.x - cx) * 180 / Math.PI;
    layerDragRef.current = {
      id: layer.id, mode: layer.mode, x: layer.x, y: layer.y, w: layer.w, h: layer.h,
      swx: sw.x, swy: sw.y, cx, cy, startAngle, startRot: layer.rotation || 0,
    };
    const onMove = (ev) => {
      const d = layerDragRef.current; if (!d) return;
      const w = screenToWorld(ev.clientX, ev.clientY);
      let next;
      if (d.mode === 'move') {
        next = { id: d.id, x: d.x + (w.x - d.swx), y: d.y + (w.y - d.swy), w: d.w, h: d.h, rotation: d.startRot };
      } else {
        const ang = Math.atan2(w.y - d.cy, w.x - d.cx) * 180 / Math.PI;
        next = { id: d.id, x: d.x, y: d.y, w: d.w, h: d.h, rotation: d.startRot + (ang - d.startAngle) };
      }
      liveLayerRef.current = next;
      setLiveLayer(next);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const d = layerDragRef.current;
      layerDragRef.current = null;
      const cur = liveLayerRef.current;
      if (!(cur && d && cur.id === d.id && onLayerTransform)) {
        liveLayerRef.current = null; setLiveLayer(null); return;
      }
      const target = { id: d.id, x: Math.round(cur.x), y: Math.round(cur.y), rotation: Math.round(cur.rotation), w: cur.w, h: cur.h };
      // commit (DM applies instantly; a player's commit round-trips to the DM)
      if (d.mode === 'move') onLayerTransform(d.id, { x: target.x, y: target.y });
      else onLayerTransform(d.id, { rotation: target.rotation });
      // v7.9: keep showing the new position until the authoritative state
      // reflects it (see the reconciliation effect above), so it never snaps
      // back. A safety timeout releases the hold if the move is never echoed.
      clearTimeout(pendingLayerRef.current?.timer);
      const timer = setTimeout(() => {
        pendingLayerRef.current = null;
        if (liveLayerRef.current && liveLayerRef.current.id === target.id) liveLayerRef.current = null;
        setLiveLayer(c => (c && c.id === target.id) ? null : c);
      }, 6000);
      pendingLayerRef.current = { id: target.id, x: target.x, y: target.y, rotation: target.rotation, timer };
      const held = { id: target.id, x: target.x, y: target.y, w: target.w, h: target.h, rotation: target.rotation };
      liveLayerRef.current = held;
      setLiveLayer(held);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [layerEditable, screenToWorld, onLayerTransform]);

  return (
    <div
      ref={wrapRef}
      className={`canvas-wrap ${panning ? 'panning' : ''} ${dragOver ? 'can-drop' : ''} ${placingReminder ? 'placing-reminder' : ''} ${placingBlock ? 'placing-block' : ''} ${placingFreeBlock ? 'placing-free-block' : ''} ${placingCircleBlock ? 'placing-circle-block' : ''} ${erasingBlock ? 'erasing-block' : ''} ${measureMode ? 'measuring' : ''} ${drawMode && drawMode !== 'erase' ? 'drawing' : ''} ${drawMode === 'erase' ? 'erasing-drawing' : ''} ${placingHazard ? 'placing-hazard' : ''}`}
      onPointerDown={onWrapPointerDown}
      onClick={onStagePointerClick}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{ height: '100%', width: '100%' }}
    >
      <div
        ref={stageRef}
        className="canvas-stage"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.zoom * (mapScale || 1)})`,
        }}
      >
        {map?.imageUrl ? (
          <img src={map.imageUrl} alt={map.name} className="map-image" draggable="false"
            onLoad={onMapImageLoad} />
        ) : null}

        {/* v7.7: image layers - overlay the base map, sit below tokens, no
            outline. Hidden until their bytes hydrate (sentinel → real). */}
        {layers.map(l => {
          if (!l.imageUrl || l.imageUrl === IMG_SENTINEL) return null;
          const live = (liveLayer && liveLayer.id === l.id) ? liveLayer : l;
          const editable = layerEditable(l);
          return (
            <img
              key={l.id}
              src={l.imageUrl}
              alt={l.name || ''}
              className={`map-layer ${editable ? 'editable' : ''} layer-${l.mode}`}
              draggable="false"
              onPointerDown={(e) => startLayerDrag(l, e)}
              style={{
                position: 'absolute',
                left: live.x, top: live.y,
                width: live.w, height: live.h,
                transform: `rotate(${live.rotation || 0}deg)`,
                transformOrigin: 'center center',
                pointerEvents: editable ? 'auto' : 'none',
                cursor: editable ? (l.mode === 'rotate' ? 'grab' : 'move') : 'default',
              }}
            />
          );
        })}

        {/* v7.8: combat movement-range markers (below tokens). Two rings in
            world coords: faded max reach from the turn-start point, and a
            brighter remaining-reach ring tracking the token now. Opacity is
            player-adjustable via moveRangeOpacity. */}
        {moveMarker && moveRangeOpacity > 0.01 && (
          <div className="move-range-group" style={{ opacity: moveRangeOpacity }}>
            <div className="move-range move-range-max" style={{
              left: moveMarker.startX - moveMarker.maxR, top: moveMarker.startY - moveMarker.maxR,
              width: moveMarker.maxR * 2, height: moveMarker.maxR * 2,
            }} />
            {moveMarker.remR > 0 && (
              <div className="move-range move-range-rem" style={{
                left: moveMarker.curX - moveMarker.remR, top: moveMarker.curY - moveMarker.remR,
                width: moveMarker.remR * 2, height: moveMarker.remR * 2,
              }}>
                <span className="move-range-label">{Math.round(moveMarker.remFt)} ft{moveMarker.mode === 'fly' ? ' · fly' : moveMarker.mode === 'swim' ? ' · swim' : moveMarker.mode === 'climb' ? ' · climb' : moveMarker.mode === 'jump' ? ' · jump' : moveMarker.dashed ? ' · dash' : ''}</span>
              </div>
            )}
          </div>
        )}

        {!layerHidden('tokens') && visibleTokens.map(t => {
          const ent = entities[t.entityId];
          if (!ent) return null;
          const isOwned = ownedEntityIds ? ownedEntityIds.has(ent.id) : claimedEntityId === ent.id;
          return (
            <TokenView
              key={t.id}
              token={t}
              entity={ent}
              isCurrent={currentInitEntityId === ent.id}
              isSelected={selectedTokenId === t.id}
              isMultiSelected={selectedTokenIds ? selectedTokenIds.has(t.id) : false}
              isMeasureStart={t2tStartId === t.id}
              canDrag={canDragToken(t)}
              isDraggingLocal={dragTokenRef.current?.tokenId === t.id}
              showLabel={mode === 'dm' || t.visible || isOwned}
              onStartDrag={(e) => startTokenDrag(t.id, e)}
              onDoubleClick={() => onTokenDoubleClick?.(t.id)}
              onSingleClick={(e) => {
                // v7 #3: token-to-token mode intercepts the click.
                // First click → record start. Second click → commit
                // measurement between the two token centers and clear.
                if (measureMode === 'tokenToToken') {
                  if (!t2tStartId) {
                    setT2tStartId(t.id);
                    return;
                  }
                  if (t2tStartId === t.id) {
                    // Same token clicked twice - cancel
                    setT2tStartId(null);
                    return;
                  }
                  const start = tokens[t2tStartId];
                  if (start && start.mapId === t.mapId) {
                    // v7.6: linger between the two token centres (5s hold + 5s fade)
                    lingerMeasurement({ x0: start.x, y0: start.y, x1: t.x, y1: t.y }, false);
                  }
                  setT2tStartId(null);
                  onMeasureModeDone?.();
                  return;
                }
                if (onTokenSingleClick) onTokenSingleClick(t.id, e);
              }}
              onContextMenu={mode === 'dm' ? (e) => onTokenContextMenu?.(t.id, e) : undefined}
              onHoverChange={onTokenHoverChange}
              mode={mode}
              passivelyHidden={mode === 'dm' && (ent.passiveHiding || 0) > 0}
              hideThreshold={ent.passiveHiding || 0}
            />
          );
        })}

        {/* Reminder pins - private to this viewer.
            v4 fix #2: pointer-drag to move, right-click to delete.
            v7.6: click (no drag) opens an editor for colour + size; the
            pin scales with r.size. */}
        {!layerHidden('reminders') && reminders.filter(r => r.mapId === map?.id).map(r => {
          const rsize = r.size || 1;
          return (
          <div
            key={r.id}
            className="reminder-pin"
            style={{ left: r.x - 10, top: r.y - 26, color: r.color, transform: `scale(${rsize})`, transformOrigin: 'top center' }}
            title={r.label + ' - drag to move, click to edit, right-click to delete'}
            onPointerDown={(e) => {
              if (e.button !== 0) return; // only primary button starts a drag
              e.stopPropagation();
              e.preventDefault();
              const start = screenToWorld(e.clientX, e.clientY);
              const startRx = r.x, startRy = r.y;
              const downX = e.clientX, downY = e.clientY;
              let dragged = false;
              const onMove = (ev) => {
                const world = screenToWorld(ev.clientX, ev.clientY);
                const dx = world.x - start.x;
                const dy = world.y - start.y;
                if (!dragged && Math.abs(dx) + Math.abs(dy) < 3) return;
                dragged = true;
                onReminderUpsert?.({ ...r, x: startRx + dx, y: startRy + dy });
              };
              const onUp = (ev) => {
                window.removeEventListener('pointermove', onMove);
                window.removeEventListener('pointerup', onUp);
                // A click without a drag opens the editor popover.
                if (!dragged) setEditingReminder({ id: r.id, sx: downX, sy: downY });
              };
              window.addEventListener('pointermove', onMove);
              window.addEventListener('pointerup', onUp);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              if (confirm(`Delete reminder "${r.label}"?`)) onReminderDelete?.(r.id);
            }}
          >
            <div className="reminder-pin-body">◆</div>
            <div className="reminder-pin-label">{r.label}</div>
          </div>
          );
        })}

        {/* v7.6: reminder editor popover (colour + size + label, per viewer).
            Portaled to body so it isn't clipped/scaled by the map stage. */}
        {editingReminder && (() => {
          const er = reminders.find(r => r.id === editingReminder.id);
          if (!er) return null;
          const rsize = er.size || 1;
          const patch = (p) => onReminderUpsert?.({ ...er, ...p });
          const setColor = (c) => { patch({ color: c }); setReminderDefault(d => ({ ...d, color: c })); };
          const setSize = (s) => { const v = clamp(Number(s) || 1, REMINDER_SIZE_MIN, REMINDER_SIZE_MAX); patch({ size: v }); setReminderDefault(d => ({ ...d, size: v })); };
          const vw = window.innerWidth, vh = window.innerHeight;
          const left = Math.min(Math.max(8, editingReminder.sx - 110), vw - 240);
          const top = Math.min(Math.max(8, editingReminder.sy + 14), vh - 220);
          return ReactDOM.createPortal(
            <>
              <div className="reminder-edit-backdrop" onPointerDown={() => setEditingReminder(null)} />
              <div className="reminder-edit-pop" style={{ left, top }} onPointerDown={(e) => e.stopPropagation()}>
                <div className="reminder-edit-head">
                  <span style={{ color: er.color }}>◆</span> Reminder
                  <button className="reminder-edit-x" onClick={() => setEditingReminder(null)}>×</button>
                </div>
                <input className="reminder-edit-label" value={er.label}
                  placeholder="Label (only you see this)"
                  onChange={(e) => patch({ label: e.target.value.slice(0, 200) })} />
                <div className="reminder-edit-row-label">Colour</div>
                <div className="reminder-swatches">
                  {REMINDER_PALETTE.map(c => (
                    <button key={c} className={`reminder-swatch ${er.color === c ? 'active' : ''}`}
                      style={{ background: c }} onClick={() => setColor(c)} title={c} />
                  ))}
                </div>
                <div className="reminder-edit-row-label">Size <span className="reminder-size-val">{Math.round(rsize * 100)}%</span></div>
                <input className="reminder-size-slider" type="range"
                  min={REMINDER_SIZE_MIN} max={REMINDER_SIZE_MAX} step="0.1"
                  value={rsize} onChange={(e) => setSize(e.target.value)} />
                <div className="reminder-edit-actions">
                  <button className="btn sm ghost danger" onClick={() => { onReminderDelete?.(er.id); setEditingReminder(null); }}>Delete</button>
                  <button className="btn sm" onClick={() => setEditingReminder(null)}>Done</button>
                </div>
                <div className="reminder-edit-hint">New pins use this colour &amp; size.</div>
              </div>
            </>,
            document.body
          );
        })()}

        {/* v3/v4 #16: Block zones - now SVG-based with feathered edges and
            support for both rectangles and freeform polygon shapes.
            Rect zones: { id, x, y, w, h }
            Poly zones: { id, type: 'poly', points: [[x,y],...] }
            Rendered through a single SVG layer for both DM (editable dashed
            outlines) and player (solid occluders with blur feather). */}
        {!layerHidden('walls') && (blockZones.length > 0 || drawingBlock || drawingPoly || drawingCircle) && (
          <svg className="block-zone-layer"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: mode === 'dm' ? 3 : 5, overflow: 'visible' }}
            viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}>
            <defs>
              {/* Gaussian blur = feathered edge on player-side occluders */}
              <filter id="block-feather" x="-10%" y="-10%" width="120%" height="120%">
                <feGaussianBlur in="SourceGraphic" stdDeviation="3" />
              </filter>
            </defs>
            {blockZones.map(z => {
              const isPoly = z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3;
              const isCircle = z.type === 'circle' && typeof z.cx === 'number';
              if (mode === 'player') {
                // Solid near-black, feathered edges. pointer-events: none.
                const props = {
                  fill: '#040608',
                  stroke: '#040608',
                  strokeWidth: 2,
                  strokeLinejoin: 'round',
                  filter: 'url(#block-feather)',
                };
                if (isPoly) {
                  return <polygon key={z.id}
                    points={z.points.map(([x,y]) => `${x},${y}`).join(' ')}
                    {...props} />;
                }
                if (isCircle) {
                  return <circle key={z.id} cx={z.cx} cy={z.cy} r={z.r} {...props} />;
                }
                return <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} {...props} />;
              }
              // DM view - translucent dashed outline, clickable for delete
              const dmProps = {
                fill: 'rgba(160,60,60,0.18)',
                stroke: 'rgba(200,80,80,0.55)',
                strokeWidth: 2,
                strokeDasharray: '6 5',
                style: { pointerEvents: 'auto', cursor: 'pointer' },
                onDoubleClick: (e) => {
                  e.stopPropagation();
                  if (confirm('Delete this block zone?')) onBlockDelete?.(z.id);
                },
              };
              if (isPoly) {
                return <polygon key={z.id}
                  points={z.points.map(([x,y]) => `${x},${y}`).join(' ')}
                  {...dmProps}><title>Double-click to delete</title></polygon>;
              }
              if (isCircle) {
                return <circle key={z.id} cx={z.cx} cy={z.cy} r={z.r} {...dmProps}><title>Double-click to delete</title></circle>;
              }
              return <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} {...dmProps}><title>Double-click to delete</title></rect>;
            })}

            {/* In-progress rectangle preview */}
            {drawingBlock && mode === 'dm' && (
              <rect
                x={drawingBlock.x} y={drawingBlock.y}
                width={drawingBlock.w} height={drawingBlock.h}
                fill="rgba(200,80,80,0.22)"
                stroke="rgba(255,120,120,0.85)"
                strokeWidth="2"
                strokeDasharray="4 4" />
            )}

            {/* In-progress freeform polyline preview */}
            {drawingPoly && mode === 'dm' && drawingPoly.length >= 2 && (
              <polyline
                points={drawingPoly.map(([x,y]) => `${x},${y}`).join(' ')}
                fill="rgba(200,80,80,0.15)"
                stroke="rgba(255,120,120,0.85)"
                strokeWidth="2"
                strokeDasharray="4 4"
                strokeLinejoin="round"
                strokeLinecap="round" />
            )}

            {/* v6 #8: In-progress circle preview */}
            {drawingCircle && mode === 'dm' && drawingCircle.r > 2 && (
              <circle
                cx={drawingCircle.cx} cy={drawingCircle.cy} r={drawingCircle.r}
                fill="rgba(200,80,80,0.18)"
                stroke="rgba(255,120,120,0.9)"
                strokeWidth="2"
                strokeDasharray="4 4" />
            )}
          </svg>
        )}

        {/* v6 #10: Drawing overlay - freehand, line, and circle shapes
            stored per-map. Semi-transparent so map details are still
            visible underneath. Rendered at z-index 7 (above map, below
            token UI). Pointer-events: none so it never intercepts clicks. */}
        {!layerHidden('drawings') && (drawings.length > 0 || drawingNow) && (
          <svg className="drawing-layer"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: 7, overflow: 'visible' }}
            viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}>
            {drawings.map(d => {
              const stroke = d.color || '#c9a34a';
              const w = Math.max(1, d.width || 3);
              const commonProps = {
                stroke, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round',
                fill: 'none', opacity: 0.75,
              };
              if (d.type === 'free' && Array.isArray(d.points) && d.points.length >= 2) {
                return <polyline key={d.id}
                  points={d.points.map(([x,y]) => `${x},${y}`).join(' ')}
                  {...commonProps} />;
              }
              if (d.type === 'line' && typeof d.x0 === 'number') {
                return <line key={d.id} x1={d.x0} y1={d.y0} x2={d.x1} y2={d.y1} {...commonProps} />;
              }
              if (d.type === 'circle' && typeof d.cx === 'number') {
                return <circle key={d.id} cx={d.cx} cy={d.cy} r={d.r} {...commonProps} />;
              }
              return null;
            })}
            {/* In-progress preview */}
            {drawingNow && (() => {
              const stroke = drawColor || '#c9a34a';
              const w = Math.max(1, drawWidth || 3);
              const p = { stroke, strokeWidth: w, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none', opacity: 0.9 };
              if (drawingNow.type === 'free' && drawingNow.points.length >= 2) {
                return <polyline points={drawingNow.points.map(([x,y]) => `${x},${y}`).join(' ')} {...p} />;
              }
              if (drawingNow.type === 'line') {
                return <line x1={drawingNow.x0} y1={drawingNow.y0} x2={drawingNow.x1} y2={drawingNow.y1} {...p} />;
              }
              if (drawingNow.type === 'circle') {
                return <circle cx={drawingNow.cx} cy={drawingNow.cy} r={drawingNow.r} {...p} />;
              }
              return null;
            })()}
          </svg>
        )}

        {/* v6 #9: Hazard polygon overlay - per-kind styling.
            Hidden hazards are filtered out for players in the sync layer,
            so this map sees only what the viewer should see. DM sees
            everything and gets an additional "HIDDEN" outline treatment
            for invisible hazards.
            v7.1 fix: dropped z-index from 6 to 3 (below the vision mask
            at z=4 and below the darkening overlay). Now hazards are
            obscured by darkness AND by block zones just like the map
            image is. The DM still sees everything because there's no
            vision mask in DM mode. Players in bright daylight see all
            visible hazards because no vision mask renders either. */}
        {!layerHidden('hazards') && hazards.length > 0 && (
          <svg className="hazard-layer"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: -mapBounds.OFF, top: -mapBounds.OFF, width: mapBounds.W, height: mapBounds.H, pointerEvents: 'none', zIndex: 3, overflow: 'visible' }}
            viewBox={`${-mapBounds.OFF} ${-mapBounds.OFF} ${mapBounds.W} ${mapBounds.H}`}><defs>
              <pattern id="hz-hatch-difficult" x="0" y="0" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="10" height="10" fill="rgba(140,100,60,0.18)" />
                <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(180,130,70,0.6)" strokeWidth="1.5" />
              </pattern>
              <pattern id="hz-stipple-cold" x="0" y="0" width="6" height="6" patternUnits="userSpaceOnUse">
                <rect width="6" height="6" fill="rgba(180,220,240,0.25)" />
                <circle cx="3" cy="3" r="0.8" fill="rgba(230,245,255,0.85)" />
              </pattern>
              <filter id="hz-fog-blur"><feGaussianBlur stdDeviation="3" /></filter>
            </defs>
            {hazards.filter(h => h.type === 'polygon' && Array.isArray(h.points) && h.points.length >= 3).map(h => {
              const pts = h.points.map(([x,y]) => `${x},${y}`).join(' ');
              const hiddenDM = mode === 'dm' && h.visible === false;
              const baseProps = { points: pts, strokeLinejoin: 'round' };
              let style;
              switch (h.hazardKind) {
                case 'fire':
                  style = { fill: 'rgba(230,80,40,0.28)', stroke: 'rgba(255,120,60,0.85)', strokeWidth: 2 };
                  break;
                case 'flood':
                  style = { fill: 'rgba(60,120,200,0.28)', stroke: 'rgba(100,160,230,0.8)', strokeWidth: 2 };
                  break;
                case 'cold':
                  style = { fill: 'url(#hz-stipple-cold)', stroke: 'rgba(200,230,245,0.85)', strokeWidth: 1.5 };
                  break;
                case 'acid':
                  style = { fill: 'rgba(110,180,70,0.3)', stroke: 'rgba(150,210,90,0.85)', strokeWidth: 2 };
                  break;
                case 'fog':
                  style = { fill: 'rgba(180,180,190,0.45)', stroke: 'rgba(200,200,210,0.55)', strokeWidth: 1.5, filter: 'url(#hz-fog-blur)' };
                  break;
                case 'difficult':
                  style = { fill: 'url(#hz-hatch-difficult)', stroke: 'rgba(160,110,50,0.75)', strokeWidth: 1.5 };
                  break;
                default:
                  style = { fill: 'rgba(180,80,80,0.25)', stroke: 'rgba(220,100,100,0.8)', strokeWidth: 2 };
              }
              if (hiddenDM) {
                // DM view of an invisible hazard: dashed, lower opacity
                style = { ...style, fill: 'rgba(100,100,100,0.12)', stroke: 'rgba(180,180,180,0.7)', strokeWidth: 1.5, strokeDasharray: '6 4' };
              }
              const dmHandlers = mode === 'dm' ? {
                style: { pointerEvents: 'auto', cursor: 'pointer' },
                onDoubleClick: (e) => {
                  e.stopPropagation();
                  if (confirm(`Delete this ${h.hazardKind} hazard?`)) {
                    onHazardDelete?.(h.id);
                  }
                },
              } : {};
              return <polygon key={h.id} {...baseProps} {...style} {...dmHandlers}>
                <title>{h.hazardKind}{h.visible === false ? ' (hidden)' : ''}{h.label ? ` - ${h.label}` : ''}</title>
              </polygon>;
            })}
          </svg>
        )}

        {/* v6 #12: Selection box marquee (DM only, shift-drag) */}
        {selectionBox && mode === 'dm' && (() => {
          const x = Math.min(selectionBox.x0, selectionBox.x1);
          const y = Math.min(selectionBox.y0, selectionBox.y1);
          const w = Math.abs(selectionBox.x1 - selectionBox.x0);
          const h = Math.abs(selectionBox.y1 - selectionBox.y0);
          return (
            <div
              className="selection-marquee"
              style={{ left: x, top: y, width: w, height: h }}
            />
          );
        })()}

        {/* v6 #11: Measurement overlay - line or radius. Renders distance
            in feet using PX_PER_FOOT. Lives at the stage level so it
            scales with the map viewport. */}
        {measuring && renderMeasureSvg({ ...measuring, isRadius: measureMode === 'radius' }, false, 'live')}
        {lingerMeasure && renderMeasureSvg(lingerMeasure, true, lingerMeasure.key)}

        {/* v3: Vision mask (player only). SVG layer at the world-stage level
            so it scales with zoom. A dark rectangle covers the whole map,
            and each vision source punches a soft-edged hole through it.
            v4 FIX: inverted the mask. In SVG masks, white = show, black = hide.
            We want the dark rect to BE HIDDEN where vision reaches (so the map
            is visible) and SHOWN everywhere else (so unlit areas stay dark).
            Correct mask: start WHITE (show the dark everywhere), then paint
            BLACK circles at each vision source (hide the dark → map visible). */}
        {mode === 'player' && visionEnabled && visionSources.length > 0 && (() => {
          const maskId = `vis-mask-${map.id}`;
          const { W, H, OFF } = mapBounds;
          return (
            <svg
              className="vision-mask"
              xmlns="http://www.w3.org/2000/svg"
              style={{ position: 'absolute', left: -OFF, top: -OFF, width: W, height: H, pointerEvents: 'none', zIndex: 4 }}
              viewBox={`${-OFF} ${-OFF} ${W} ${H}`}
            >
              <defs>
                {/* Radial gradients: black center (hide dark → reveal map)
                    fading to white at edge (show dark → hide map).
                    v7.1: slight "flame flicker" - the 70% stop position
                    is animated within a small range. Each source gets a
                    different phase (via begin offset and duration) so
                    they flicker asynchronously. The effect is subtle:
                    the vision circle's soft edge gently breathes. Only
                    sources that emit light (not pure darkvision) get
                    the flicker - clean darkvision stays stable. */}
                {visionSources.map((s, i) => {
                  const flickers = !!s.isLight; // set by compute*VisionSources when this is a light emitter
                  const phase = (i * 0.37) % 1;  // pseudo-random phase per source
                  const dur = 0.9 + ((i * 0.17) % 0.7); // 0.9-1.6s each
                  return (
                    <radialGradient key={i} id={`vg-${maskId}-${i}`}
                      cx={s.x} cy={s.y} r={s.radius}
                      gradientUnits="userSpaceOnUse">
                      <stop offset="0%"   stopColor="black" stopOpacity="1" />
                      <stop offset="70%"  stopColor="black" stopOpacity="1">
                        {flickers && (
                          <animate attributeName="offset"
                            values="68%;73%;69%;71%;70%;72%;70%"
                            dur={`${dur}s`}
                            begin={`-${phase * dur}s`}
                            repeatCount="indefinite" />
                        )}
                      </stop>
                      <stop offset="100%" stopColor="black" stopOpacity="0" />
                    </radialGradient>
                  );
                })}
                <mask id={maskId} maskUnits="userSpaceOnUse">
                  {/* Start WHITE - show the dark fill everywhere by default. */}
                  <rect x={-OFF} y={-OFF} width={W} height={H} fill="white" />
                  {/* Punch BLACK circles at vision sources - hides the dark
                      fill there, making the map visible underneath. */}
                  {visionSources.map((s, i) => (
                    <circle key={i}
                      cx={s.x} cy={s.y} r={s.radius}
                      fill={`url(#vg-${maskId}-${i})`} />
                  ))}
                  {/* Block zones paint WHITE on top → force dark fill to
                      show there even if vision would otherwise reveal them.
                      v4 #16: poly support. v6 #8: circle support. */}
                  {blockZones.map(z => {
                    if (z.type === 'poly' && Array.isArray(z.points) && z.points.length >= 3) {
                      return <polygon key={z.id}
                        points={z.points.map(([x,y]) => `${x},${y}`).join(' ')}
                        fill="white" />;
                    }
                    if (z.type === 'circle' && typeof z.cx === 'number') {
                      return <circle key={z.id} cx={z.cx} cy={z.cy} r={z.r} fill="white" />;
                    }
                    return <rect key={z.id} x={z.x} y={z.y} width={z.w} height={z.h} fill="white" />;
                  })}
                </mask>
              </defs>
              <rect x={-OFF} y={-OFF} width={W} height={H}
                fill="rgba(4,6,10,0.96)"
                mask={`url(#${maskId})`} />
            </svg>
          );
        })()}

        {/* v3: DM vision outlines - dashed circles per character so DM sees
            what each player can see. Rendered above the map, below tokens. */}
        {mode === 'dm' && visionSources.length > 0 && (
          <svg className="vision-outlines"
            xmlns="http://www.w3.org/2000/svg"
            style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible', zIndex: 2 }}>
            {visionSources.map((s, i) => (
              <circle key={i}
                cx={s.x} cy={s.y} r={s.radius}
                fill="none"
                stroke={s.color || '#4a7cbd'}
                strokeWidth="2"
                strokeDasharray="6 6"
                opacity="0.55" />
            ))}
          </svg>
        )}
      </div>

      {!map?.imageUrl && (
        <div className="map-empty">
          <div className="glyph">⚜</div>
          <div style={{ fontFamily: 'Cormorant Garamond, serif', fontStyle: 'italic', fontSize: 18 }}>
            {mode === 'dm'
              ? 'The canvas awaits. Upload a map image to begin.'
              : 'The realm is shrouded in mist.'}
          </div>
        </div>
      )}

      <div className="canvas-overlay top-right">
        <div className="zoom-controls">
          <button className="zoom-btn" title="Zoom in" onClick={() => zoomBy(1.2)}>＋</button>
          <button className="zoom-btn" title="Reset" onClick={resetView}>⌂</button>
          <button className="zoom-btn" title="Zoom out" onClick={() => zoomBy(1 / 1.2)}>－</button>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// ENTITY FORM (create / edit entity)
// ====================================================================

// v7.6: status-effect picker, grouped into Negative / Positive / Neutral
// collapsible sections. Each header shows a count of active effects and can
// be expanded/collapsed. Shared by the entity editor, token detail, sheet.
function ConditionPicker({ active = [], onToggle, canEdit = true }) {
  const sections = [['Negative', 'negative'], ['Positive', 'positive'], ['Neutral', 'neutral']];
  const [open, setOpen] = useState({});
  const toggleOpen = (k) => setOpen(o => ({ ...o, [k]: !o[k] }));
  return (
    <div className="cond-sections">
      {sections.map(([label, key]) => {
        const items = CONDITION_GROUPS[key];
        const activeCount = items.filter(c => active.includes(c)).length;
        const isOpen = !!open[key];
        return (
          <div key={key} className="cond-section">
            <button type="button" className={`cond-section-head cond-sec-${key} ${isOpen ? 'open' : ''}`} onClick={() => toggleOpen(key)}>
              <span className="cond-sec-chevron">{isOpen ? '▾' : '▸'}</span>
              <span className="cond-section-label">{label}</span>
              {activeCount > 0 && <span className="cond-sec-count">{activeCount}</span>}
            </button>
            {isOpen && (
              <div className="cond-grid">
                {items.map(c => (
                  <div
                    key={c}
                    className={`cond-chip ${active.includes(c) ? 'active' : ''}`}
                    onClick={canEdit ? () => onToggle(c) : undefined}
                    style={{ cursor: canEdit ? 'pointer' : 'default' }}
                  >{c}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// v7.5: a controlled <textarea> that auto-grows to fit its content, so
// long descriptions / notes / stat-blocks are fully readable without an
// inner scrollbar. The surrounding panel scrolls instead.
function AutoTextarea({ value, onChange, minHeight = 64, style, ...rest }) {
  const ref = useRef(null);
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight + 2, minHeight) + 'px';
  };
  useEffect(() => { resize(); }, [value]);
  return (
    <textarea
      ref={ref}
      value={value}
      onChange={onChange}
      onInput={resize}
      style={{ overflow: 'hidden', resize: 'none', minHeight, ...style }}
      {...rest}
    />
  );
}

function EntityForm({ initial, onSave, onCancel }) {
  const [entity, setEntity] = useState(() => initial || makeEntity());

  const update = (patch) => setEntity(e => ({ ...e, ...patch }));
  const updateStat = (stat, value) => setEntity(e => ({ ...e, stats: { ...e.stats, [stat]: Number(value) || 0 } }));
  const updateHp = (key, value) => setEntity(e => ({ ...e, hp: { ...e.hp, [key]: Number(value) || 0 } }));

  useEffect(() => {
    // if type changes, reset color if default
    if (Object.values(DEFAULT_COLORS).includes(entity.color)) {
      setEntity(e => ({ ...e, color: DEFAULT_COLORS[e.type] }));
    }
  }, [entity.type]);

  // Simple in-browser image upload. We downscale to at most 256×256 and
  // re-encode as JPEG (~0.8 quality) to keep the base64 sync payload small.
  const uploadImage = async () => {
    try {
      const dataUrl = await pickImage();
      if (!dataUrl) return;
      const img = new Image();
      img.onload = () => {
        const maxSide = 256;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const compressed = canvas.toDataURL('image/jpeg', 0.82);
        update({ imageUrl: compressed });
      };
      img.onerror = () => update({ imageUrl: dataUrl }); // fall back to raw
      img.src = dataUrl;
    } catch {}
  };

  // Shorthands
  const isHpType = entity.type !== 'Object';
  const isPlayerFacing = ['Monster','NPC','Neutral Beast','Object'].includes(entity.type);

  return (
    <div className="form-grid">
      <div className="form-row-2">
        <div>
          <label>Name</label>
          <input value={entity.name} onChange={e => update({ name: e.target.value })} />
        </div>
        <div>
          <label>Type</label>
          <select value={entity.type} onChange={e => update({ type: e.target.value })}>
            {ENTITY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
      </div>

      {/* Portrait / token image */}
      <div>
        <label>Token Image <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- optional; falls back to colored token</span></label>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <div className="portrait-preview" style={{ background: entity.color }}>
            {entity.imageUrl ? <img src={entity.imageUrl} alt="" draggable="false" /> : <span>{(entity.name || '?').slice(0,1).toUpperCase()}</span>}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button className="btn sm" type="button" onClick={uploadImage}>⇧ Upload image</button>
            {entity.imageUrl && (
              <button className="btn sm ghost" type="button" onClick={() => update({ imageUrl: null })}>Remove image</button>
            )}
          </div>
        </div>
      </div>

      <div className="form-row-3">
        <div>
          <label>Color</label>
          <input type="color" value={entity.color} onChange={e => update({ color: e.target.value })} />
        </div>
        <div>
          <label>AC</label>
          <input type="number" value={entity.ac} onChange={e => update({ ac: Number(e.target.value) || 0 })} />
        </div>
        <div>
          <label>Walk speed</label>
          <input type="number" value={walkSpeedOf(entity)} onChange={e => { const n = Number(e.target.value) || 0; update({ speed: n, speeds: { ...(entity.speeds || {}), walk: n } }); }} />
        </div>
      </div>
      <div className="form-row-3">
        <div>
          <label>Fly speed</label>
          <input type="number" value={entity.speeds?.fly ?? 0} onChange={e => update({ speeds: { ...(entity.speeds || {}), fly: Number(e.target.value) || 0 } })} />
        </div>
        <div>
          <label>Jump speed</label>
          <input type="number" value={entity.speeds?.jump ?? 0} onChange={e => update({ speeds: { ...(entity.speeds || {}), jump: Number(e.target.value) || 0 } })} />
        </div>
        <div>
          <label>Swim speed</label>
          <input type="number" value={entity.speeds?.swim ?? 0} onChange={e => update({ speeds: { ...(entity.speeds || {}), swim: Number(e.target.value) || 0 } })} />
        </div>
        <div>
          <label>Climb speed</label>
          <input type="number" value={entity.speeds?.climb ?? 0} onChange={e => update({ speeds: { ...(entity.speeds || {}), climb: Number(e.target.value) || 0 } })} />
        </div>
      </div>

      {isHpType && (
        <div className="form-row-3">
          <div>
            <label>HP Current</label>
            <input type="number" value={entity.hp.current} onChange={e => updateHp('current', e.target.value)} />
          </div>
          <div>
            <label>HP Max</label>
            <input type="number" value={entity.hp.max} onChange={e => updateHp('max', e.target.value)} />
          </div>
          <div>
            <label>Init Bonus</label>
            <input type="number" value={entity.initBonus} onChange={e => update({ initBonus: Number(e.target.value) || 0 })} />
          </div>
        </div>
      )}

      {/* Objects don't need a stat block but may still roll init if DM wants */}
      {entity.type === 'Object' && (
        <div className="form-row-2">
          <div>
            <label>Rolls Initiative?</label>
            <label className="toggle-row">
              <input type="checkbox"
                checked={!!entity.rollsInitiative}
                onChange={e => update({ rollsInitiative: e.target.checked })} />
              <span>{entity.rollsInitiative ? 'Included in initiative' : 'Static object - skipped'}</span>
            </label>
          </div>
          <div>
            <label>Init Bonus</label>
            <input type="number" value={entity.initBonus} disabled={!entity.rollsInitiative}
              onChange={e => update({ initBonus: Number(e.target.value) || 0 })} />
          </div>
        </div>
      )}

      {['PC','Monster','NPC','Familiar','Neutral Beast'].includes(entity.type) && (
        <div>
          <label>Ability Scores</label>
          <div className="form-row-6">
            {['str','dex','con','int','wis','cha'].map(s => (
              <div key={s} className="stat-box">
                <label>{s.toUpperCase()}</label>
                <input type="number" value={entity.stats[s]} onChange={e => updateStat(s, e.target.value)} />
                <div style={{ fontSize: 9, color: 'var(--ink-mute)', fontFamily: 'JetBrains Mono, monospace' }}>
                  {modFor(entity.stats[s]) >= 0 ? `+${modFor(entity.stats[s])}` : modFor(entity.stats[s])}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="form-row-2">
        <div>
          <label>Passive Perception</label>
          <input type="number" value={entity.passivePerception} onChange={e => update({ passivePerception: Number(e.target.value) || 0 })} />
        </div>
        {entity.type === 'PC' && (
          <div>
            <label>Level</label>
            <input type="number" value={entity.level} onChange={e => update({ level: Number(e.target.value) || 1 })} />
          </div>
        )}
        {entity.type === 'Monster' && (
          <div>
            <label>Challenge Rating</label>
            <input value={entity.cr} onChange={e => update({ cr: e.target.value })} />
          </div>
        )}
        {entity.type === 'NPC' && (
          <div>
            <label>Faction</label>
            <input value={entity.faction} onChange={e => update({ faction: e.target.value })} />
          </div>
        )}
        {entity.type === 'Familiar' && (
          <div>
            <label>Bonded To <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- the master PC name, if any</span></label>
            <input value={entity.faction} onChange={e => update({ faction: e.target.value })} placeholder="e.g. Caelum the wizard" />
          </div>
        )}
        {entity.type === 'Neutral Beast' && (
          <div>
            <label>Nature</label>
            <input value={entity.role} onChange={e => update({ role: e.target.value })} placeholder="e.g. deer, forest spirit" />
          </div>
        )}
        {entity.type === 'Object' && (
          <div>
            <label>Kind</label>
            <input value={entity.role} onChange={e => update({ role: e.target.value })} placeholder="e.g. altar, chest, rune" />
          </div>
        )}
      </div>

      {/* v7.5: Passive Hiding - a stealth threshold. A token with passive
          hiding > 0 is only visible to players whose controlled character's
          passive perception is at least this value. The DM always sees it. */}
      {['PC','Familiar','Monster','Neutral Beast','NPC'].includes(entity.type) && (
        <div>
          <label>Passive Hiding <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- 0 = always seen; otherwise hidden from players whose passive perception is below this</span></label>
          <input type="number" min="0" value={entity.passiveHiding || 0}
            onChange={e => update({ passiveHiding: Math.max(0, Number(e.target.value) || 0) })}
            placeholder="0" />
        </div>
      )}

      {entity.type === 'PC' && (
        <div className="form-row-2">
          <div>
            <label>Class</label>
            <ClassSelect value={entity.class || ''} onCommit={(v) => update({ class: v })} />
          </div>
          <div>
            <label>Player Name</label>
            <input value={entity.playerName} onChange={e => update({ playerName: e.target.value })} />
          </div>
        </div>
      )}

      {/* v5 fix #6: Sickness applies to any creature (not just PCs). */}
      {['PC','NPC','Monster','Neutral Beast','Familiar'].includes(entity.type) && (
        <div>
          <label>Sickness <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- DM-only setting; descriptor appears on tooltips and under the token</span></label>
          <div className="sickness-picker">
            {[0,1,2,3].map(lvl => (
              <button
                key={lvl}
                type="button"
                className={`sickness-btn ${entity.sickness === lvl ? 'active' : ''} sick-level-${lvl}`}
                onClick={() => update({ sickness: lvl })}
              >
                <span className="sickness-num">{lvl}</span>
                <span className="sickness-label">{lvl === 0 ? 'Healthy' : SICKNESS_DESCRIPTORS[lvl]}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {(entity.type === 'Monster' || entity.type === 'Neutral Beast') && (
        <div>
          <label>Abilities / DM Notes</label>
          <AutoTextarea value={entity.abilities} onChange={e => update({ abilities: e.target.value })}
            placeholder="Multiattack, breath weapon, legendary actions…" />
        </div>
      )}

      {isPlayerFacing && (
        <div>
          <label>Player-Visible Description <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- shown to players when revealed / on hover</span></label>
          <AutoTextarea value={entity.playerDescription || ''} onChange={e => update({ playerDescription: e.target.value })}
            placeholder="A hulking brute draped in rusted chains. Its breath reeks of rot." />
        </div>
      )}

      {/* v3: Vision - darkvision and light-radius in feet. Used by the
          darkness / vision rendering system.
          v6 fix #7: Objects get a lightRadius input too (candles, torches,
          braziers, magical beacons). They don't see, so darkvision is
          hidden for objects. */}
      {['PC','Familiar','Monster','Neutral Beast','NPC'].includes(entity.type) && (
        <div>
          <label>Vision <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- darkvision + carried light (feet)</span></label>
          <div className="form-row-2">
            <div>
              <label style={{ fontSize: 9 }}>Darkvision</label>
              <input type="number" min="0" step="5" value={entity.darkvision || 0}
                onChange={e => update({ darkvision: Number(e.target.value) || 0 })} />
            </div>
            <div>
              <label style={{ fontSize: 9 }}>Light Radius</label>
              <input type="number" min="0" step="5" value={entity.lightRadius || 0}
                onChange={e => update({ lightRadius: Number(e.target.value) || 0 })} />
            </div>
          </div>
        </div>
      )}
      {entity.type === 'Object' && (
        <div>
          <label>Light Source <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- objects may emit light (feet)</span></label>
          <input type="number" min="0" step="5" value={entity.lightRadius || 0}
            onChange={e => update({ lightRadius: Number(e.target.value) || 0 })}
            placeholder="0 = no light" />
        </div>
      )}

      <div>
        <label>Conditions</label>
        <ConditionPicker
          active={entity.conditions}
          onToggle={(c) => update({
            conditions: entity.conditions.includes(c)
              ? entity.conditions.filter(x => x !== c)
              : [...entity.conditions, c]
          })}
        />
      </div>

      <div>
        <label>DM Notes <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- never shown to players</span></label>
        <AutoTextarea value={entity.notes} onChange={e => update({ notes: e.target.value })} />
      </div>

      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn primary" onClick={() => onSave(entity)}>Save</button>
      </div>
    </div>
  );
}

// ====================================================================
// ENTITY SIDEBAR (DM)
// ====================================================================
function EntitySidebar({ state, dispatch, onEditEntity, onSelectEntity, selectedEntityId, onOpenSheet }) {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('All');
  const [showDead, setShowDead] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [dragOverId, setDragOverId] = useState(null);

  const order = state.entityOrder || [];
  const entitiesByOrder = order.map(id => state.entities[id]).filter(Boolean);
  // include any entity not yet in entityOrder (should be migrated but defensive)
  for (const e of Object.values(state.entities)) {
    if (!order.includes(e.id)) entitiesByOrder.push(e);
  }

  // Filtering preserves order. We never mutate master order based on filter.
  const filtered = entitiesByOrder.filter(e => {
    if (filter !== 'All' && e.type !== filter) return false;
    if (!showDead && e.hp.current <= 0) return false;
    if (search && !e.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const newEntity = () => onEditEntity(makeEntity());
  const adjustHp = (id, delta) => dispatch({ type: 'ENTITY_HP_ADJUST', id, delta });

  // v3: Token preset shortcut. Creates a new entity pre-filled from a built-in
  // preset or a DM-saved custom preset, then opens the edit form so the DM
  // can tweak before saving.
  const newFromPreset = async (preset) => {
    if (!preset) return;
    const ent = makeEntity({ ...preset.entity });
    // v8.10: populate structured fly/climb/swim speeds from the preset's text.
    ent.speeds = deriveSpeeds(ent);
    // v7.6: if a standard image exists in assets/tokens/ for this preset and
    // the preset doesn't already carry its own image, use it as the portrait.
    if (!ent.imageUrl) {
      try { const img = await resolvePresetImage(preset); if (img) ent.imageUrl = img; } catch {}
    }
    onEditEntity(ent);
    setShowPresetMenu(false);
  };
  const [showPresetMenu, setShowPresetMenu] = useState(false);
  // Allow DM to save any entity as a custom preset via ENTITY_REORDER, stored
  // inside state.tokenPresets keyed by uid. Expose save/delete here.
  const saveAsPreset = (entity) => {
    const name = prompt('Preset name:', entity.name);
    if (!name) return;
    const id = uid('preset_');
    dispatch({
      type: 'TOKEN_PRESET_UPSERT',
      preset: {
        id, name,
        entity: { ...entity, id: undefined, imageUrl: entity.imageUrl || null },
      },
    });
  };
  const deletePreset = (id) => {
    if (!confirm('Delete this preset?')) return;
    dispatch({ type: 'TOKEN_PRESET_DELETE', id });
  };
  const allPresets = [
    ...BUILTIN_TOKEN_PRESETS,
    ...Object.values(state.tokenPresets || {}),
  ];

  const tokensByEntity = useMemo(() => {
    const m = {};
    Object.values(state.tokens).forEach(t => {
      if (t.mapId === state.currentMapId) m[t.entityId] = t;
    });
    return m;
  }, [state.tokens, state.currentMapId]);

  const toggleVisibility = (token) => {
    dispatch({ type: 'TOKEN_VISIBILITY', id: token.id, visible: !token.visible });
  };

  const handleCardClick = (e, entity) => {
    // Expand/collapse. Also notify parent for selection wiring (token highlight).
    setExpandedId(prev => prev === entity.id ? null : entity.id);
    onSelectEntity?.(entity.id);
  };

  // --- Drag-to-reorder logic ---
  // We use the same drag that places on map (dataTransfer entity-id),
  // but let the sidebar cards act as drop targets to reorder.
  const onCardDragStart = (ev, entity) => {
    ev.dataTransfer.setData('text/entity-id', entity.id);
    ev.dataTransfer.effectAllowed = 'copyMove';
    // Use the parent card element as the drag ghost so it doesn't look
    // like the user is dragging just a 12px handle grip.
    const card = ev.currentTarget.closest('.entity-card');
    if (card) {
      try { ev.dataTransfer.setDragImage(card, 20, 20); } catch {}
    }
  };
  // v7.8: touchscreen drag-to-place. Native HTML5 DnD (above) never fires on
  // touch, so for touch pointers we run a manual pointer drag: a finger-follow
  // ghost, and on release over the map we hand the drop to the registered
  // MapCanvas. Mouse/pen keep the native path untouched.
  const onHandlePointerDown = (ev, entity) => {
    if (ev.pointerType !== 'touch') return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX, startY = ev.clientY;
    let ghost = null;
    const makeGhost = () => {
      const g = document.createElement('div');
      g.className = 'touch-place-ghost';
      if (entity.imageUrl) {
        g.style.backgroundImage = `url(${entity.imageUrl})`;
        g.style.backgroundSize = 'cover';
      } else {
        g.textContent = (entity.name || '?').slice(0, 1).toUpperCase();
        g.style.background = entity.color || 'var(--gold)';
      }
      document.body.appendChild(g);
      return g;
    };
    const move = (e) => {
      if (!ghost) {
        if (Math.hypot(e.clientX - startX, e.clientY - startY) < 6) return;
        ghost = makeGhost();
      }
      ghost.style.left = e.clientX + 'px';
      ghost.style.top = e.clientY + 'px';
      ghost.classList.toggle('over', !!(_touchDropTarget && _touchDropTarget.test(e.clientX, e.clientY)));
    };
    const up = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (ghost) ghost.remove();
      // a real drag (ghost shown) that ends over the map places the token
      if (ghost && _touchDropTarget && _touchDropTarget.test(e.clientX, e.clientY)) {
        _touchDropTarget.drop(e.clientX, e.clientY, entity.id);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  const onCardDragOver = (ev, overEntity) => {
    // Only treat as reorder when no search filter differs from master - we still
    // allow it, but reorder maps to the master list.
    const draggingId = ev.dataTransfer.types.includes('text/entity-id');
    if (!draggingId) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    setDragOverId(overEntity.id);
  };
  const onCardDragLeave = () => setDragOverId(null);
  const onCardDrop = (ev, overEntity) => {
    ev.preventDefault();
    ev.stopPropagation(); // prevent canvas drop
    setDragOverId(null);
    const srcId = ev.dataTransfer.getData('text/entity-id');
    if (!srcId || srcId === overEntity.id) return;
    const base = state.entityOrder || [];
    const srcIdx = base.indexOf(srcId);
    const dstIdx = base.indexOf(overEntity.id);
    if (srcIdx === -1 || dstIdx === -1) return;
    // Drop-before-target semantics: remove src, then insert at the target's
    // index. Target shifts left by 1 if src was originally before it.
    const next = [...base];
    next.splice(srcIdx, 1);
    const insertAt = srcIdx < dstIdx ? dstIdx - 1 : dstIdx;
    next.splice(insertAt, 0, srcId);
    dispatch({ type: 'ENTITY_REORDER', order: next });
  };

  return (
    <>
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>Bestiary</span>
          <div style={{ display: 'flex', gap: 4, position: 'relative' }}>
            <button className="btn sm" onClick={() => setShowPresetMenu(v => !v)}
              title="Quick-create from a preset">
              ❈ Preset
            </button>
            <button className="btn sm primary" onClick={newEntity}>＋ New</button>
            {showPresetMenu && (
              <BestiaryMenu
                builtins={BUILTIN_TOKEN_PRESETS}
                custom={Object.values(state.tokenPresets || {})}
                onPick={newFromPreset}
                onDelete={deletePreset}
                onClose={() => setShowPresetMenu(false)}
              />
            )}
          </div>
        </div>
        <div className="search-row">
          <input placeholder="Search by name…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="filter-pills">
          {['All','PC','Monster','NPC','Familiar','Object','Label'].map(f => (
            <div key={f} className={`pill ${filter === f ? 'active' : ''}`} onClick={() => setFilter(f)}>{f}</div>
          ))}
          <div className={`pill ${!showDead ? 'active' : ''}`} onClick={() => setShowDead(!showDead)}>
            {showDead ? 'Hide dead' : 'Show dead'}
          </div>
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="entity-list">
          {filtered.length === 0 && (
            <div className="empty-state">
              <span className="glyph">✦</span>
              {entitiesByOrder.length === 0 ? 'No entities yet. Forge one.' : 'No matching entities.'}
            </div>
          )}
          {filtered.map(e => {
            const onMap = tokensByEntity[e.id];
            const hpPct = e.hp.max > 0 ? e.hp.current / e.hp.max : 0;
            const hpClass = hpPct <= 0.25 ? 'critical' : hpPct <= 0.5 ? 'low' : '';
            const isDead = e.hp.current <= 0;
            const swatchClass = e.type === 'Monster' ? 'monster' : e.type === 'NPC' ? 'npc' : '';
            const expanded = expandedId === e.id;
            const selected = selectedEntityId === e.id;
            const dropping = dragOverId === e.id;
            return (
              <div
                key={e.id}
                className={`entity-card ${selected ? 'selected' : ''} ${isDead ? 'dead' : ''} ${expanded ? 'expanded' : ''} ${dropping ? 'drop-target' : ''}`}
                onDragOver={(ev) => onCardDragOver(ev, e)}
                onDragLeave={onCardDragLeave}
                onDrop={(ev) => onCardDrop(ev, e)}
              >
                <div
                  className="entity-card-row"
                  onClick={(ev) => handleCardClick(ev, e)}
                >
                  {/* Drag handle - draggable, used for reorder AND map placement */}
                  <div
                    className="drag-handle"
                    draggable
                    onDragStart={(ev) => { ev.stopPropagation(); onCardDragStart(ev, e); }}
                    onPointerDown={(ev) => onHandlePointerDown(ev, e)}
                    onClick={(ev) => ev.stopPropagation()}
                    title="Drag to reorder or to place on map"
                  >⋮⋮</div>
                  <div className={`entity-swatch ${swatchClass}`} style={{ background: e.color }} />
                  <div className="entity-info">
                    <div className="entity-name">{e.name}</div>
                    <div className="entity-meta">
                      <span className="mono">{e.type === 'PC' ? `L${e.level} ${e.class||''}` : e.type === 'Monster' ? `CR ${e.cr}` : e.role || 'NPC'}</span>
                      <span className={`entity-hp ${hpClass} mono`}>{e.hp.current}/{e.hp.max}</span>
                      <span className="mono" style={{ color: 'var(--ink-mute)' }}>AC {e.ac}</span>
                    </div>
                  </div>
                  {/* Eye toggle - only shown when entity has a token on current map */}
                  {onMap && (
                    <button
                      className={`eye-btn ${onMap.visible ? 'on' : 'off'}`}
                      onClick={(ev) => { ev.stopPropagation(); toggleVisibility(onMap); }}
                      title={onMap.visible ? 'Visible to players - click to hide' : 'Hidden from players - click to reveal'}
                    >
                      {onMap.visible ? '👁' : '⦿'}
                    </button>
                  )}
                  <div className="entity-actions" onClick={ev => ev.stopPropagation()}>
                    <button className="btn sm danger" onClick={() => adjustHp(e.id, -1)} title="-1 HP">−</button>
                    <button className="btn sm" onClick={() => adjustHp(e.id, +1)} title="+1 HP">+</button>
                    <button className="btn sm" onClick={() => onEditEntity(e)} title="Edit full sheet">✎</button>
                    {onOpenSheet && <button className="btn sm" onClick={() => onOpenSheet(e)} title="Open character sheet">📜</button>}
                  </div>
                </div>
                {expanded && <EntityStatBlock entity={e} onMap={onMap} />}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}

// Inline, expandable stat block shown when a DM clicks an entity card.
function EntityStatBlock({ entity, onMap }) {
  const e = entity;
  const hpPct = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
  const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
  return (
    <div className="entity-expanded">
      <div className="statblock-row">
        <div className="statblock-cell">
          <div className="statblock-label">AC</div>
          <div className="statblock-value mono">{e.ac}</div>
        </div>
        <div className="statblock-cell">
          <div className="statblock-label">HP</div>
          <div className="statblock-value mono">
            {e.hp.current}<span style={{ color: 'var(--ink-mute)' }}>/{e.hp.max}</span>
          </div>
        </div>
        <div className="statblock-cell">
          <div className="statblock-label">Speed</div>
          <div className="statblock-value mono">{e.speed}</div>
        </div>
        <div className="statblock-cell">
          <div className="statblock-label">Init</div>
          <div className="statblock-value mono">{e.initBonus >= 0 ? `+${e.initBonus}` : e.initBonus}</div>
        </div>
      </div>
      <div className="statblock-hp-bar">
        <div className={`statblock-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
      </div>
      <div className="statblock-stats">
        {['str','dex','con','int','wis','cha'].map(s => (
          <div key={s} className="statblock-stat">
            <div className="statblock-stat-label">{s.toUpperCase()}</div>
            <div className="statblock-stat-value mono">{e.stats[s]}</div>
            <div className="statblock-stat-mod mono">
              {modFor(e.stats[s]) >= 0 ? `+${modFor(e.stats[s])}` : modFor(e.stats[s])}
            </div>
          </div>
        ))}
      </div>
      {e.conditions.length > 0 && (
        <div className="statblock-conditions">
          {e.conditions.map(c => (
            <div key={c} className="cond-chip active" style={{ cursor: 'default' }}>{c}</div>
          ))}
        </div>
      )}
      {e.type === 'PC' && e.playerName && (
        <div className="statblock-note"><strong>Player:</strong> {e.playerName}</div>
      )}
      {e.type === 'Monster' && e.abilities && (
        <div className="statblock-note"><strong>Abilities:</strong><br />{e.abilities}</div>
      )}
      {e.type === 'Monster' && e.playerDescription && (
        <div className="statblock-note" style={{ borderColor: 'var(--gold-dim)' }}>
          <strong style={{ color: 'var(--gold)' }}>Player-Visible:</strong><br />{e.playerDescription}
        </div>
      )}
      {e.type === 'NPC' && (e.faction || e.role) && (
        <div className="statblock-note">
          {e.role && <><strong>Role:</strong> {e.role}<br /></>}
          {e.faction && <><strong>Faction:</strong> {e.faction}</>}
        </div>
      )}
      {e.notes && (
        <div className="statblock-note"><strong>DM Notes:</strong><br />{e.notes}</div>
      )}
      {onMap && (
        <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 6, fontStyle: 'italic' }}>
          ◆ Placed on current map {onMap.visible ? '- visible to players' : '- hidden from players'}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// INITIATIVE TRACKER
// ====================================================================
function InitiativeTracker({ state, dispatch, mode, onClose }) {
  const { initiative, entities, currentMapId } = state;
  const rollAll = () => {
    // Includes hidden tokens (they roll too); deduped per entity so a
    // creature with several tokens on the map gets a single initiative row.
    const tokensHere = Object.values(state.tokens).filter(t => t.mapId === currentMapId);
    const seen = new Set();
    const entries = [];
    for (const t of tokensHere) {
      const e = entities[t.entityId];
      if (!e || seen.has(e.id)) continue;
      seen.add(e.id);
      entries.push({ entityId: e.id, roll: roll(20) + (e.initBonus || 0) });
    }
    entries.sort((a, b) => b.roll - a.roll || (entities[b.entityId]?.initBonus || 0) - (entities[a.entityId]?.initBonus || 0) || entities[a.entityId].name.localeCompare(entities[b.entityId].name));
    dispatch({ type: 'INIT_SET', initiative: { active: true, entries, turn: 0, round: 1 } });
  };

  const clearInit = () => dispatch({ type: 'INIT_SET', initiative: { active: false, entries: [], turn: 0, round: 1 } });
  const advance = () => dispatch({ type: 'INIT_ADVANCE' });

  const updateRoll = (entityId, newRoll) => {
    const entries = initiative.entries.map(e => e.entityId === entityId ? { ...e, roll: Number(newRoll) || 0 } : e);
    entries.sort((a, b) => b.roll - a.roll);
    dispatch({ type: 'INIT_SET', initiative: { ...initiative, entries } });
  };

  const removeEntry = (entityId) => {
    const entries = initiative.entries.filter(e => e.entityId !== entityId);
    const turn = Math.min(initiative.turn, Math.max(0, entries.length - 1));
    dispatch({ type: 'INIT_SET', initiative: { ...initiative, entries, turn } });
  };

  // v7.6: re-add (or add) an entity to the order - rolls its initiative.
  const addEntry = (entityId) => dispatch({ type: 'INIT_ADD', entityId });

  // Tokens for an entity on the current map (DM state still holds hidden
  // tokens; a player's synced state has the hidden ones stripped already).
  const tokensFor = (entityId) =>
    Object.values(state.tokens).filter(t => t.entityId === entityId && t.mapId === currentMapId);
  // v7.6: hidden-from-players = the creature has token(s) here but every
  // one is set invisible. The DM still sees the roll; players don't.
  const isHiddenFromPlayers = (entityId) => {
    const ts = tokensFor(entityId);
    return ts.length > 0 && ts.every(t => t.visible === false);
  };
  const playerHasToken = (entityId) => tokensFor(entityId).length > 0;

  // v7.6: entities present on the map but not in the order - offered for
  // re-adding (covers tokens the DM previously removed from initiative).
  const missingEntities = useMemo(() => {
    if (!initiative.active) return [];
    const inOrder = new Set(initiative.entries.map(e => e.entityId));
    const seen = new Set();
    const out = [];
    for (const t of Object.values(state.tokens)) {
      if (t.mapId !== currentMapId) continue;
      if (inOrder.has(t.entityId) || seen.has(t.entityId)) continue;
      const e = entities[t.entityId];
      if (!e) continue;
      seen.add(t.entityId);
      out.push(e);
    }
    return out;
  }, [initiative.active, initiative.entries, state.tokens, entities, currentMapId]);

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span>⚔ Initiative · Round {initiative.round}</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {mode === 'dm' && (
          <>
            <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
              <button className="btn primary" onClick={rollAll}>🎲 Roll All</button>
              <button className="btn" onClick={advance} disabled={!initiative.entries.length}>⏭ Next Turn</button>
              <button className="btn danger" onClick={clearInit} disabled={!initiative.entries.length}>Clear</button>
            </div>
            <div style={{ marginBottom: 12 }}>
              <button
                className={`btn sm off-turn-toggle ${state.lockOffTurn ? 'primary' : ''}`}
                style={{ width: '100%' }}
                onClick={() => dispatch({ type: 'SET_LOCK_OFF_TURN', value: !state.lockOffTurn })}
                title="When locked, players can only move the token whose turn it currently is."
              >
                {state.lockOffTurn ? '🔒 Off-turn movement locked' : '🔓 Off-turn movement allowed'}
              </button>
            </div>
          </>
        )}
        <div className="init-list">
          {initiative.entries.length === 0 ? (
            <div className="empty-state"><span className="glyph">⚔</span>Initiative not yet rolled.</div>
          ) : initiative.entries.map((entry, idx) => {
            const e = entities[entry.entityId];
            if (!e) return null;
            // v7.6: players never see a hidden combatant - its roll is
            // revealed only once the DM unhides the token.
            if (mode !== 'dm' && !playerHasToken(entry.entityId)) return null;
            const hiddenFromPlayers = mode === 'dm' && isHiddenFromPlayers(entry.entityId);
            // Players see HP only for PCs; monsters get a descriptor instead of numbers
            const showExactHp = mode === 'dm' || e.type === 'PC';
            const hpPctRaw = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
            const monsterStatus =
              hpPctRaw <= 0 ? 'Down' :
              hpPctRaw < 30 ? 'Waning' :
              hpPctRaw <= 70 ? 'Rough' :
              'Strong';
            return (
              <div key={entry.entityId} className={`init-entry ${idx === initiative.turn ? 'current' : ''} ${hiddenFromPlayers ? 'init-hidden' : ''}`}>
                {mode === 'dm' ? (
                  <input className="mono" type="number" value={entry.roll}
                    onChange={(ev) => updateRoll(entry.entityId, ev.target.value)}
                    style={{ width: 48, padding: 4, textAlign: 'center', fontWeight: 600 }} />
                ) : (
                  <div className="init-roll">{entry.roll}</div>
                )}
                <div className="entity-swatch" style={{ background: e.color, width: 10, height: 10 }} />
                <div className="init-name">{e.name}</div>
                {hiddenFromPlayers && (
                  <span className="init-hidden-flag" title="Hidden from players - they'll see this roll once you reveal the token">hidden</span>
                )}
                {showExactHp ? (
                  <div className="init-hp">{e.hp.current}/{e.hp.max}</div>
                ) : (
                  <div className={`init-status status-${monsterStatus.toLowerCase()}`}>{monsterStatus}</div>
                )}
                {mode === 'dm' && (
                  <button className="btn sm ghost" onClick={() => removeEntry(entry.entityId)} title="Remove from initiative">×</button>
                )}
              </div>
            );
          })}
        </div>
        {mode === 'dm' && initiative.active && missingEntities.length > 0 && (
          <div className="init-add-section">
            <div className="init-add-label">Not in the order - click to roll &amp; add</div>
            {missingEntities.map(e => (
              <div key={e.id} className="init-add-row">
                <div className="entity-swatch" style={{ background: e.color, width: 10, height: 10 }} />
                <div className="init-name">{e.name}</div>
                {isHiddenFromPlayers(e.id) && (
                  <span className="init-hidden-flag" title="Currently hidden from players">hidden</span>
                )}
                <button className="btn sm" onClick={() => addEntry(e.id)} title="Roll initiative and add to the order">+ Add</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// MAP MANAGER
// ====================================================================
function MapManager({ state, dispatch, onClose, toast }) {
  const [editing, setEditing] = useState(null);
  const [layersOpen, setLayersOpen] = useState(null); // mapId whose layers are expanded
  const maps = Object.values(state.maps);

  // v7.7: add an image layer to a map. Reads natural dimensions so the
  // layer starts at a sensible size (capped so huge uploads don't fill the
  // map), positioned at the origin for the DM to move/resize.
  const addLayer = async (mapId) => {
    const data = await pickImage();
    if (!data) return;
    const dims = await new Promise((res) => {
      const img = new Image();
      img.onload = () => res({ w: img.naturalWidth || 400, h: img.naturalHeight || 400 });
      img.onerror = () => res({ w: 400, h: 400 });
      img.src = data;
    });
    const maxSide = Math.max(dims.w, dims.h);
    const scale = maxSide > 800 ? 800 / maxSide : 1;
    const layer = {
      id: uid('layer_'), mapId, name: 'Layer',
      imageUrl: data,
      x: 0, y: 0,
      w: Math.max(20, Math.round(dims.w * scale)),
      h: Math.max(20, Math.round(dims.h * scale)),
      rotation: 0, mode: 'move', dmOnly: false,
    };
    dispatch({ type: 'LAYER_ADD', layer });
    toast('Layer added', 'success');
  };
  const patchLayer = (mapId, id, patch) => dispatch({ type: 'LAYER_UPDATE', mapId, id, patch });
  const deleteLayer = (mapId, id) => dispatch({ type: 'LAYER_DELETE', mapId, id });

  const newMap = () => {
    const id = uid('map_');
    setEditing({ id, name: 'New Map', type: 'region', parentId: null, imageUrl: null, notes: '', viewport: { x: 0, y: 0, zoom: 1 } });
  };

  const uploadImage = async () => {
    const data = await pickImage();
    if (data) setEditing({ ...editing, imageUrl: data });
  };

  const saveMap = () => {
    dispatch({ type: 'MAP_UPSERT', map: editing });
    setEditing(null);
    toast('Map saved', 'success');
  };

  const deleteMap = (id) => {
    if (!confirm('Delete this map and all its tokens?')) return;
    dispatch({ type: 'MAP_DELETE', id });
    toast('Map deleted');
  };

  if (editing) {
    return (
      <FloatPanel style={{ right: 16, top: 80, width: 400 }}>
        <div className="float-panel-header">
          <span>⌖ {state.maps[editing.id] ? 'Edit Map' : 'New Map'}</span>
          <button className="close-x" onClick={() => setEditing(null)}>×</button>
        </div>
        <div className="float-panel-body">
          <div className="form-grid">
            <div>
              <label>Name</label>
              <input value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} />
            </div>
            <div className="form-row-2">
              <div>
                <label>Type</label>
                <select value={editing.type} onChange={e => setEditing({ ...editing, type: e.target.value })}>
                  <option value="world">World</option>
                  <option value="region">Region</option>
                  <option value="city">City</option>
                  <option value="dungeon">Dungeon</option>
                  <option value="interior">Interior</option>
                  <option value="encounter">Encounter</option>
                </select>
              </div>
              <div>
                <label>Parent Map</label>
                <select value={editing.parentId || ''} onChange={e => setEditing({ ...editing, parentId: e.target.value || null })}>
                  <option value="">- None -</option>
                  {maps.filter(m => m.id !== editing.id).map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label>Map Image</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <button className="btn" onClick={uploadImage}>📁 Upload Image</button>
                {editing.imageUrl && (
                  <>
                    <img src={editing.imageUrl} style={{ height: 48, borderRadius: 4, border: '1px solid var(--border)' }} />
                    <button className="btn sm danger" onClick={() => setEditing({ ...editing, imageUrl: null })}>Clear</button>
                  </>
                )}
              </div>
              <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4 }}>Embedded as base64 - stays in session.</div>
            </div>
            <div>
              <label>Notes (DM only)</label>
              <AutoTextarea value={editing.notes} onChange={e => setEditing({ ...editing, notes: e.target.value })} />
            </div>
            {/* v4 fix #14: map-level permanent darkness. Overrides the
                time-of-day system - the map is always treated as night,
                vision rules always apply. Good for dungeons & caves. */}
            <div className="toggle-row">
              <input type="checkbox" id="alwaysDark"
                checked={!!editing.alwaysDark}
                onChange={e => setEditing({ ...editing, alwaysDark: e.target.checked })} />
              <label htmlFor="alwaysDark" style={{ cursor: 'pointer' }}>
                Always dark <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- overrides time of day; vision rules always apply</span>
              </label>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn primary" onClick={saveMap}>Save Map</button>
            </div>
          </div>
        </div>
      </FloatPanel>
    );
  }

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>⌖ Maps & Realms</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <button className="btn primary" onClick={newMap} style={{ marginBottom: 12 }}>＋ New Map</button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {maps.map(m => {
            const parent = m.parentId ? state.maps[m.parentId]?.name : null;
            const isCurrent = state.currentMapId === m.id;
            const mapLayers = state.layers?.[m.id] || [];
            const layersExpanded = layersOpen === m.id;
            return (
              <div key={m.id} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: 10, borderRadius: 5,
                background: isCurrent ? 'rgba(212,165,116,0.1)' : 'var(--bg-0)',
                border: `1px solid ${isCurrent ? 'var(--gold-dim)' : 'var(--border-soft)'}`
              }}>
                {m.imageUrl && <img src={m.imageUrl} style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 3 }} />}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{m.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)' }}>
                    {m.type}{parent ? ` · in ${parent}` : ''}
                  </div>
                </div>
                <button className={`btn sm ghost ${layersExpanded ? 'active' : ''}`} title="Image layers"
                  onClick={() => setLayersOpen(layersExpanded ? null : m.id)}>🗇{mapLayers.length ? ` ${mapLayers.length}` : ''}</button>
                <button className="btn sm" onClick={() => dispatch({ type: 'MAP_SWITCH', id: m.id })} disabled={isCurrent}>Go</button>
                <button className="btn sm ghost" onClick={() => setEditing(deepClone(m))}>✎</button>
                <button className="btn sm ghost" onClick={() => deleteMap(m.id)} disabled={maps.length <= 1}>×</button>
              </div>

              {layersExpanded && (
                <div className="layer-manager">
                  <div className="layer-manager-head">
                    <span>Image layers</span>
                    <button className="btn sm primary" onClick={() => addLayer(m.id)}>＋ Add image</button>
                  </div>
                  {mapLayers.length === 0 ? (
                    <div className="layer-empty">No layers yet. Add an image to overlay this map.</div>
                  ) : mapLayers.map(l => {
                    const aspect = l.h > 0 ? l.w / l.h : 1;
                    return (
                      <div key={l.id} className="layer-row">
                        <div className="layer-thumb">
                          {l.imageUrl && l.imageUrl !== IMG_SENTINEL
                            ? <img src={l.imageUrl} alt="" />
                            : <span>🗇</span>}
                        </div>
                        <div className="layer-controls">
                          <div className="layer-modes">
                            {['locked', 'move', 'rotate'].map(md => (
                              <button key={md}
                                className={`layer-mode-btn ${l.mode === md ? 'on' : ''}`}
                                onClick={() => patchLayer(m.id, l.id, { mode: md })}>
                                {md === 'locked' ? '🔒 Lock' : md === 'move' ? '✥ Move' : '⟳ Rotate'}
                              </button>
                            ))}
                          </div>
                          <div className="layer-size">
                            <span>Size</span>
                            <input type="range" min="40" max="2000" value={Math.round(l.w)}
                              onChange={e => {
                                const w = Number(e.target.value);
                                patchLayer(m.id, l.id, { w, h: Math.max(20, Math.round(w / (aspect || 1))) });
                              }} />
                          </div>
                          <div className="layer-row-actions">
                            <button className={`layer-flag ${l.dmOnly ? 'on' : ''}`}
                              onClick={() => patchLayer(m.id, l.id, { dmOnly: !l.dmOnly })}
                              title="When on, only the DM can move or change this layer">
                              {l.dmOnly ? '👑 DM-only' : '👥 Shared'}
                            </button>
                            {l.rotation ? (
                              <button className="layer-flag" onClick={() => patchLayer(m.id, l.id, { rotation: 0 })} title="Reset rotation">⟲ 0°</button>
                            ) : null}
                            <button className="layer-del" onClick={() => deleteLayer(m.id, l.id)} title="Delete layer">🗑</button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              </div>
            );
          })}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// PRESETS PANEL
// ====================================================================
// v7.6: derive faceted filter tags for a preset across these dimensions:
//   world   - D&D / Plague's Call / Burrows & Badgers / Custom
//   kind    - Character vs Non-character
//   type    - Beast / Humanoid / Monster / Ooze / Object / Undead / Celestial / Fiend
//   habitat - Terrestrial / Aquatic / Flying  (a creature may be several)
// Built-ins are classified heuristically from type, category, and the
// abilities/notes text (which usually states "Speed: Walk/Fly/Swim …").
// The named NPCs/puppets below belong to the original Plague's Call cast;
// the remaining generic built-ins are standard D&D tokens.
const PLAGUE_PRESET_IDS = new Set([
  'unfinished_puppet', 'jake', 'tully', 'coalan', 'yevgeny', 'ernest_broken',
  'laughing_puppet', 'angmar', 'barry', 'ivar', 'charles', 'elisia',
  'marta', 'oswin', 'gerrit', 'pip',
]);
const TAG_DIMENSIONS = [
  { key: 'world', label: 'World', order: ['D&D', "Plague's Call", 'Burrows & Badgers', 'Custom'] },
  { key: 'kind', label: 'Kind', order: ['Character', 'Non-character'] },
  { key: 'type', label: 'Type', order: ['Beast', 'Humanoid', 'Monster', 'Ooze', 'Object', 'Undead', 'Celestial', 'Fiend'] },
  { key: 'habitat', label: 'Habitat', order: ['Terrestrial', 'Aquatic', 'Flying'] },
];
function presetTags(p) {
  const e = p.entity || {};
  const tags = new Set();
  const type = e.type || '';
  const cat = (p.category || '').toLowerCase();
  const id = p.id || '';
  const idSuffix = id.replace(/^builtin:/, '');
  const text = `${p.name || ''} ${e.name || ''} ${e.abilities || ''} ${e.notes || ''} ${e.role || ''}`.toLowerCase();

  // World - which setting a preset belongs to
  if (id.startsWith('bnb:') || cat.startsWith('b&b')) tags.add('world:Burrows & Badgers');
  else if (PLAGUE_PRESET_IDS.has(idSuffix)) tags.add("world:Plague's Call");
  else if (id.startsWith('builtin:')) tags.add('world:D&D');
  else tags.add('world:Custom');

  // Kind
  tags.add((type === 'PC' || type === 'NPC') ? 'kind:Character' : 'kind:Non-character');

  // Creature type (coarse, best-effort)
  if (cat.includes('ooze') || /\booze|slime|jelly|pudding|mold\b/.test(text)) tags.add('type:Ooze');
  else if (/\bcelestial|angelic|seraph|empyrean\b/.test(text)) tags.add('type:Celestial');
  else if (/\bundead|skeleton|zombie|wraith|ghost|spectre|specter|lich|ghoul\b/.test(text)) tags.add('type:Undead');
  else if (/\bfiend|demon|devil\b/.test(text)) tags.add('type:Fiend');
  else if (type === 'Object' || cat.includes('object')) tags.add('type:Object');
  else if (type === 'PC' || type === 'NPC' || cat.includes('humanoid')) tags.add('type:Humanoid');
  else if (type === 'Neutral Beast' || cat.includes('animal') || cat.startsWith('b&b') || /\bbeast\b/.test(text)) tags.add('type:Beast');
  else tags.add('type:Monster');

  // Habitat / locomotion
  const fly = /\bfly|flight|flying|aerial|winged\b/.test(text);
  const swim = /\bswim|aquatic|underwater|amphib|water breathing\b/.test(text);
  const walk = /\bwalk|burrow|climb|land speed\b/.test(text);
  if (fly) tags.add('habitat:Flying');
  if (swim) tags.add('habitat:Aquatic');
  if (walk || (!fly && !swim)) tags.add('habitat:Terrestrial');

  return tags;
}

// ====================================================================
// BESTIARY MENU  (v5 #11)
// ====================================================================
// Preset picker with search and filters. Replaces the older flat
// "Built-in / Custom" list once the preset catalog got large.
//
// Filters: category (Humanoid / Animal / Ooze / Object / …), type
// (PC/Monster/NPC/etc), and a free-text search by name.
// CR is only shown when present on a preset.
// v7.6: the bestiary is now a large full-screen browser with a horizontal
// carousel of big creature cards (one in focus, neighbours peeking), a
// thumbnail filmstrip, search + filters, and keyboard / arrow navigation.
function BestiaryMenu({ builtins, custom, onPick, onDelete, onClose }) {
  const [search, setSearch] = useState('');
  const [filterCategory, setFilterCategory] = useState('All');
  const [activeTags, setActiveTags] = useState(() => new Set()); // "dim:value"
  const [index, setIndex] = useState(0);
  const stripRef = useRef(null);

  const categoryOptions = useMemo(() => {
    const s = new Set(['All']);
    for (const p of builtins) if (p.category) s.add(p.category);
    return Array.from(s);
  }, [builtins]);

  // tag each preset once
  const tagged = useMemo(() => [
    ...builtins.map(p => ({ ...p, _source: 'Built-in', _category: p.category || 'Other', _tags: presetTags(p) })),
    ...custom.map(p => ({ ...p, _source: 'Custom', _category: 'Custom', _tags: presetTags(p) })),
  ], [builtins, custom]);

  // which tags actually exist (to render only meaningful filter chips)
  const availableTags = useMemo(() => {
    const present = new Set();
    for (const p of tagged) for (const t of p._tags) present.add(t);
    return present;
  }, [tagged]);

  const toggleTag = (tag) => setActiveTags(prev => {
    const next = new Set(prev);
    next.has(tag) ? next.delete(tag) : next.add(tag);
    return next;
  });
  const clearTags = () => setActiveTags(new Set());

  // group active tags by dimension for faceted matching (OR within a
  // dimension, AND across dimensions).
  const activeByDim = useMemo(() => {
    const m = {};
    for (const t of activeTags) { const [d] = t.split(':'); (m[d] ||= []).push(t); }
    return m;
  }, [activeTags]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tagged.filter(p => {
      if (filterCategory !== 'All' && p._category !== filterCategory) return false;
      for (const dim of Object.keys(activeByDim)) {
        if (!activeByDim[dim].some(t => p._tags.has(t))) return false;
      }
      if (q) {
        const hay = `${p.name || ''} ${p.entity?.name || ''} ${p.entity?.role || ''} ${p._category}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [tagged, search, filterCategory, activeByDim]);

  const n = filtered.length;
  // reset to the first card whenever the result set changes
  useEffect(() => { setIndex(0); }, [search, filterCategory, activeTags]);
  useEffect(() => { setIndex(i => Math.min(Math.max(0, i), Math.max(0, n - 1))); }, [n]);

  const go = (delta) => setIndex(i => n === 0 ? 0 : Math.min(Math.max(0, i + delta), n - 1));
  const jump = (i) => setIndex(Math.min(Math.max(0, i), Math.max(0, n - 1)));

  // keyboard navigation
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'Escape') { onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [n]);

  // keep the active thumbnail scrolled into view
  useEffect(() => {
    const el = stripRef.current?.querySelector('.bes-thumb.is-active');
    if (el) el.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }, [index]);

  const CARDW = 440, GAP = 28;
  const mod = (v) => { const m = Math.floor((((v ?? 10)) - 10) / 2); return (m >= 0 ? '+' : '') + m; };

  return ReactDOM.createPortal((
    <div className="bestiary-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="bestiary-carousel-modal" onClick={e => e.stopPropagation()}>
        <div className="bes-top">
          <div className="bes-title">⚔ Bestiary</div>
          <input className="bes-search" placeholder="Search by name or role…" autoFocus
            value={search} onChange={e => setSearch(e.target.value)} />
          <select className="bestiary-select" value={filterCategory} onChange={e => setFilterCategory(e.target.value)}>
            {categoryOptions.map(c => <option key={c} value={c}>{c === 'All' ? 'All categories' : c}</option>)}
            {custom.length > 0 && <option value="Custom">Custom</option>}
          </select>
          <div className="bes-counter">{n === 0 ? '0 / 0' : `${index + 1} / ${n}`}</div>
          <button className="bes-close" onClick={onClose} title="Close (Esc)">✕ Close</button>
        </div>

        <div className="bes-filters">
          {TAG_DIMENSIONS.map(dim => {
            const chips = dim.order.filter(v => availableTags.has(`${dim.key}:${v}`));
            if (chips.length === 0) return null;
            return (
              <div key={dim.key} className="bes-filter-group">
                <span className="bes-filter-label">{dim.label}</span>
                {chips.map(v => {
                  const tag = `${dim.key}:${v}`;
                  return (
                    <button key={tag} className={`bes-chip ${activeTags.has(tag) ? 'active' : ''}`} onClick={() => toggleTag(tag)}>{v}</button>
                  );
                })}
              </div>
            );
          })}
          {(activeTags.size > 0 || filterCategory !== 'All') && (
            <button className="bes-chip clear" onClick={() => { clearTags(); setFilterCategory('All'); }}>✕ Clear</button>
          )}
        </div>

        {n === 0 ? (
          <div className="bes-empty">No matches. Try clearing the filters or search.</div>
        ) : (
          <>
            <div className="bes-stage">
              <button className="bes-arrow left" onClick={() => go(-1)} disabled={index === 0} aria-label="Previous">‹</button>
              <div className="bes-carousel">
                <div className="bes-track" style={{ transform: `translateX(calc(-1 * ${index} * (${CARDW}px + ${GAP}px)))` }}>
                  {filtered.map((p, i) => {
                    const e = p.entity || {};
                    const st = e.stats || {};
                    const isA = i === index;
                    return (
                      <div key={p.id} className={`bes-card ${isA ? 'is-active' : ''}`}
                        style={{ '--accent': e.color || '#8a7a55' }}
                        onClick={() => { if (!isA) jump(i); }}>
                        <div className="bes-card-band" />
                        <div className="bes-card-head">
                          <div className="bes-card-name">{p.name}</div>
                          {p.cr && <div className="bes-card-cr">CR {p.cr}</div>}
                        </div>
                        <div className="bes-card-sub">
                          {e.type}{p._category && p._category !== 'Other' ? ` · ${p._category}` : ''}{e.role ? ` · ${e.role}` : ''}
                        </div>
                        <div className="bes-core">
                          <div><b>{e.ac ?? '-'}</b><span>AC</span></div>
                          <div><b>{e.hp?.max ?? '-'}</b><span>HP</span></div>
                          <div><b>{e.speed ?? '-'}</b><span>Speed</span></div>
                          <div><b>{(e.initBonus >= 0 ? '+' : '') + (e.initBonus ?? 0)}</b><span>Init</span></div>
                          <div><b>{e.passivePerception ?? '-'}</b><span>Pass.</span></div>
                        </div>
                        <div className="bes-stats">
                          {['str', 'dex', 'con', 'int', 'wis', 'cha'].map(k => (
                            <div key={k} className="bes-stat">
                              <span className="bes-stat-k">{k.toUpperCase()}</span>
                              <span className="bes-stat-v">{st[k] ?? 10}</span>
                              <span className="bes-stat-m">{mod(st[k])}</span>
                            </div>
                          ))}
                        </div>
                        <div className="bes-scroll">
                          {e.abilities && <div className="bes-abilities">{e.abilities}</div>}
                          {e.playerDescription && <div className="bes-flavor">{e.playerDescription}</div>}
                          {!e.abilities && !e.playerDescription && <div className="bes-noinfo">No description.</div>}
                        </div>
                        <div className="bes-card-actions">
                          <button className="btn primary bes-add" onClick={(ev) => { ev.stopPropagation(); onPick(p); }}>＋ Add to map</button>
                          {p._source === 'Custom' && (
                            <button className="btn danger sm" onClick={(ev) => { ev.stopPropagation(); onDelete?.(p.id); }} title="Delete preset">Delete</button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <button className="bes-arrow right" onClick={() => go(1)} disabled={index === n - 1} aria-label="Next">›</button>
            </div>

            <div className="bes-strip" ref={stripRef}>
              {filtered.map((p, i) => (
                <button key={p.id} className={`bes-thumb ${i === index ? 'is-active' : ''}`}
                  style={{ '--accent': p.entity?.color || '#8a7a55' }}
                  onClick={() => jump(i)} title={`${p.name}${p.cr ? ' · CR ' + p.cr : ''}`}>
                  <span className="bes-thumb-dot" />
                  <span className="bes-thumb-name">{p.name}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="bes-footer">
          Browse with ‹ › or the arrow keys · <b>＋ Add to map</b> opens the creature pre-filled · drag a sidebar card → "Save as preset" to add your own
        </div>
      </div>
    </div>
  ), document.body);
}

// ====================================================================
// PRESETS PANEL  (encounter snapshots)
// ====================================================================
function PresetsPanel({ state, dispatch, onClose, toast }) {
  const [name, setName] = useState('');
  const presets = Object.values(state.presets);

  const savePreset = () => {
    if (!name.trim()) { toast('Enter a name', 'error'); return; }
    const tokensOnMap = Object.values(state.tokens).filter(t => t.mapId === state.currentMapId);
    const preset = {
      id: uid('preset_'),
      name: name.trim(),
      mapId: state.currentMapId,
      tokens: tokensOnMap.map(t => ({ ...t })),
    };
    dispatch({ type: 'PRESET_SAVE', preset });
    setName('');
    toast('Preset saved', 'success');
  };

  const loadPreset = (preset) => {
    if (!confirm(`Load "${preset.name}"? This replaces tokens on the target map.`)) return;
    // Remove current tokens on that map and restore preset tokens
    Object.keys(state.tokens).forEach(tid => {
      if (state.tokens[tid].mapId === preset.mapId) {
        dispatch({ type: 'TOKEN_REMOVE', id: tid });
      }
    });
    preset.tokens.forEach(t => {
      dispatch({ type: 'TOKEN_PLACE', token: { ...t, id: uid('tok_') } });
    });
    dispatch({ type: 'MAP_SWITCH', id: preset.mapId });
    toast('Preset loaded', 'success');
  };

  const overwritePreset = (preset) => {
    if (!confirm(`Overwrite "${preset.name}" with current state?`)) return;
    const tokensOnMap = Object.values(state.tokens).filter(t => t.mapId === state.currentMapId);
    dispatch({
      type: 'PRESET_SAVE',
      preset: { ...preset, mapId: state.currentMapId, tokens: tokensOnMap.map(t => ({ ...t })) }
    });
    toast('Preset overwritten', 'success');
  };

  const deletePreset = (id) => {
    if (!confirm('Delete this preset?')) return;
    dispatch({ type: 'PRESET_DELETE', id });
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>❈ Encounter Presets</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <input placeholder="Name this encounter…" value={name} onChange={e => setName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && savePreset()} />
          <button className="btn primary" onClick={savePreset}>Save</button>
        </div>
        {presets.length === 0 ? (
          <div className="empty-state"><span className="glyph">❈</span>No saved encounters yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {presets.map(p => {
              const map = state.maps[p.mapId];
              return (
                <div key={p.id} style={{
                  padding: 10, borderRadius: 5,
                  background: 'var(--bg-0)', border: '1px solid var(--border-soft)'
                }}>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{p.name}</div>
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginBottom: 6 }}>
                    {p.tokens.length} tokens · {map?.name || 'unknown map'}
                  </div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button className="btn sm primary" onClick={() => loadPreset(p)}>Load</button>
                    <button className="btn sm" onClick={() => overwritePreset(p)}>Overwrite</button>
                    <button className="btn sm danger" onClick={() => deletePreset(p.id)}>×</button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// TOKEN DETAIL PANEL
// ====================================================================
// v7.9: player-side action builder shown when a player double-clicks a token
// that isn't their own. Lets them roll dice (or enter a real-life roll) with a
// modifier and damage type, or pick a condition, then sends it to the DM as a
// request. Nothing is applied locally - the DM resolves it.
function PlayerActionRequest({ sourceOptions, defaultSourceId, targetToken, targetEntity, playerActionSender, dmMode = false, onDmSubmit, attackOnly = false, rangeInfo, physicalDice = false }) {
  const [mode, setMode] = useState('damage'); // damage | heal | condition
  const [sourceId, setSourceId] = useState(defaultSourceId);
  const [weaponSel, setWeaponSel] = useState(''); // '' = custom, else `${wid}|${aid}`
  const [counts, setCounts] = useState({ 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0 });
  const [modifier, setModifier] = useState(0);
  const [flat, setFlat] = useState(0);
  const [dmgType, setDmgType] = useState('Slashing');
  const [customType, setCustomType] = useState('');
  const [advMode, setAdvMode] = useState('normal'); // normal | advantage | disadvantage
  const [manual, setManual] = useState(null); // v8.3 physical dice: { weapon, atk, d20a, d20b, dieVals }
  const [manSel, setManSel] = useState(''); // v8.3 selected maneuver preset key ('' = none/custom)
  const [manCond, setManCond] = useState('Grappled');
  const [manAbil, setManAbil] = useState('STR');
  const [manDc, setManDc] = useState(13);
  const [effCond, setEffCond] = useState((CONDITIONS && CONDITIONS[0]) || 'Poisoned');
  const [effAbil, setEffAbil] = useState('CON');
  const [effDc, setEffDc] = useState(12);
  const [sent, setSent] = useState(null); // confirmation text
  const sentTimer = useRef(null);
  useEffect(() => () => clearTimeout(sentTimer.current), []);
  useEffect(() => {
    if (!sourceOptions.some(e => e.id === sourceId)) setSourceId(defaultSourceId);
  }, [sourceOptions, sourceId, defaultSourceId]);
  const sourceEntity = sourceOptions.find(e => e.id === sourceId) || sourceOptions[0];
  // reset the weapon selection when the acting character changes
  useEffect(() => { setWeaponSel(''); }, [sourceId]);

  // v8.1: combat range. When initiative is active an attack can only reach a
  // target within the weapon's range; out-of-reach options are greyed out.
  const inCombat = !!rangeInfo?.inCombat;
  const dist = rangeInfo?.distanceBySource ? rangeInfo.distanceBySource[sourceId] : null;
  const hasDist = typeof dist === 'number' && isFinite(dist);
  const canReach = (range) => !inCombat || (hasDist && dist <= (range || 0));

  const equippedWeapons = (sourceEntity.weapons || []).filter(w => w.equipped && (w.attacks || []).length);
  const [selWid, selAid] = weaponSel.split('|');
  const selWeapon = equippedWeapons.find(w => w.id === selWid) || null;
  const selAttack = selWeapon ? (selWeapon.attacks.find(a => a.id === selAid) || null) : null;

  const bump = (s, d) => setCounts(c => ({ ...c, [s]: Math.max(0, Math.min(50, (c[s] | 0) + d)) }));
  const totalDice = Object.values(counts).reduce((a, b) => a + b, 0);
  const flash = (msg) => { setSent(msg); clearTimeout(sentTimer.current); sentTimer.current = setTimeout(() => setSent(null), 3000); };

  const submit = (kind, data) => {
    if (dmMode && onDmSubmit) onDmSubmit({ kind, data });
    else playerActionSender({ type: 'submit_request', payload: { kind, data } });
  };
  const sendComponents = (components, opts = {}) => {
    submit(mode === 'heal' ? 'apply_heal' : 'apply_damage', {
      sourceEntityId: sourceEntity.id, targetEntityId: targetEntity.id, targetTokenId: targetToken.id,
      components, toHit: opts.toHit ?? null,
      d20a: opts.d20a ?? null, d20b: opts.d20b ?? null, advMode: opts.advMode ?? 'normal',
      effect: opts.effect || null,
      weaponName: opts.weaponName || '', attackName: opts.attackName || '',
    });
  };
  const sendManual = () => {
    const dice = [];
    for (const s of ALLOWED_DIE_SIDES) for (let i = 0; i < (counts[s] | 0); i++) dice.push({ sides: s, result: 1 + Math.floor(Math.random() * s) });
    const flatN = Math.max(0, Math.round(Number(flat)) || 0);
    if (dice.length === 0 && flatN === 0 && mode === 'damage') { flash('Add some dice or a number first.'); return; }
    const type = mode === 'damage' ? (dmgType === '__custom__' ? (customType.trim() || 'Untyped') : dmgType) : '';
    sendComponents([{ dice, modifier: Math.round(Number(modifier)) || 0, flat: flatN, type }]);
    setCounts({ 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0 }); setFlat(0); setModifier(0);
    flash(dmMode ? 'Attack launched.' : 'Sent to DM - awaiting approval.');
  };
  const sendWeaponAttack = (weapon, atk) => {
    if (!canReach(atk.range)) { flash(`Out of range - ${dist} ft away, reach ${atk.range} ft.`); return; }
    const components = (atk.damage || []).map(c => {
      const dice = [];
      const sides = c.sides || 6;
      for (let i = 0; i < (c.count || 0); i++) dice.push({ sides, result: 1 + Math.floor(Math.random() * sides) });
      return { dice, modifier: c.modifier || 0, flat: 0, type: c.type || '' };
    });
    const d20a = 1 + Math.floor(Math.random() * 20);
    const d20b = 1 + Math.floor(Math.random() * 20);
    sendComponents(components, { toHit: atk.toHit || 0, d20a, d20b, advMode, weaponName: weapon.name, attackName: atk.name, effect: atk.effect || null });
    flash(dmMode ? `${weapon.name} - ${atk.name} launched.` : `${weapon.name} - ${atk.name} sent to DM.`);
  };
  const clampDie = (v, sides) => Math.min(sides, Math.max(1, parseInt(v) || 1));
  // v8.3: physical dice - begin a manual-entry form instead of auto-rolling.
  const beginWeaponAttack = (weapon, atk) => {
    if (!canReach(atk.range)) { flash(`Out of range - ${dist} ft away, reach ${atk.range} ft.`); return; }
    if (!physicalDice) { sendWeaponAttack(weapon, atk); return; }
    const dieVals = (atk.damage || []).map(c => Array.from({ length: c.count || 0 }, () => ''));
    setManual({ weapon, atk, d20a: '', d20b: '', dieVals });
  };
  const confirmManual = () => {
    const { weapon, atk, d20a, d20b, dieVals } = manual;
    const components = (atk.damage || []).map((c, ci) => {
      const sides = c.sides || 6;
      const dice = (dieVals[ci] || []).map(v => ({ sides, result: clampDie(v, sides) }));
      return { dice, modifier: c.modifier || 0, flat: 0, type: c.type || '' };
    });
    const A = clampDie(d20a, 20);
    const B = (advMode !== 'normal') ? clampDie(d20b, 20) : A;
    sendComponents(components, { toHit: atk.toHit || 0, d20a: A, d20b: B, advMode, weaponName: weapon.name, attackName: atk.name, effect: atk.effect || null });
    flash(dmMode ? `${weapon.name} - ${atk.name} launched.` : `${weapon.name} - ${atk.name} sent to DM.`);
    setManual(null);
  };
  const sendCondition = (cond) => {
    submit('apply_condition', { sourceEntityId: sourceEntity.id, targetEntityId: targetEntity.id, targetTokenId: targetToken.id, condition: cond });
    flash(dmMode ? `Applied "${cond}".` : `Requested "${cond}" - awaiting DM.`);
  };
  // v8.3: apply an effect with an accompanying save - routed through the shared
  // cinematic so the target (its owner, or the DM) rolls the save vs the DC.
  const sendEffect = (cond, ability, dc) => {
    submit('apply_damage', {
      sourceEntityId: sourceEntity.id, targetEntityId: targetEntity.id, targetTokenId: targetToken.id,
      components: [], toHit: null, d20a: null, d20b: null, advMode: 'normal',
      weaponName: cond, attackName: '',
      effect: { condition: cond, save: { ability, dc: Number(dc) || 10 } },
    });
    flash(dmMode ? `${cond} launched.` : `${cond} sent to DM.`);
  };
  // v8.3: special interactions (grapple, shove, trip…). Modelled as a no-damage
  // contest: the target rolls the named save; on a failure the condition lands.
  // Routed through the same cinematic pipeline (no to-hit, just the save).
  // v8.3: maneuvers (grapple, shove, trip…) are close-quarters actions, so
  // their reach is enforced whenever we know the distance to the target -
  // unlike weapon attacks, this does not wait for initiative to be active.
  const maneuverReaches = (range) => !hasDist || dist <= (range || 5);
  const sendManeuver = (m) => {
    if (!maneuverReaches(m.range)) { flash(`Out of range - ${dist} ft away, reach ${m.range || 5} ft.`); return; }
    let effect = null;
    if (m.condition) {
      const ability = m.ability;
      if (m.contest) {
        // v8.3: a contested check - roll the attacker's ability now; the target
        // must meet or beat it to resist (so the DC is the attacker's roll).
        const atkD20 = 1 + Math.floor(Math.random() * 20);
        const atkMod = abilityModifier(sourceEntity.stats?.[ability.toLowerCase()]);
        const atkTotal = atkD20 + atkMod;
        effect = { condition: m.condition, contest: { ability, atkD20, atkMod, atkTotal }, save: { ability, dc: atkTotal } };
      } else {
        effect = { condition: m.condition, save: { ability, dc: Number(m.dc) || 10 } };
      }
    }
    submit('apply_damage', {
      sourceEntityId: sourceEntity.id, targetEntityId: targetEntity.id, targetTokenId: targetToken.id,
      components: [], toHit: null, d20a: null, d20b: null, advMode: 'normal',
      weaponName: m.label, attackName: '', effect,
    });
    flash(dmMode ? `${m.label} launched.` : `${m.label} sent to DM.`);
  };

  const showWeapon = mode === 'damage' && selAttack;
  const selReach = selAttack ? canReach(selAttack.range) : true;
  const modes = attackOnly
    ? [['damage', '⚔ Attack'], ['maneuver', '🤼 Maneuver']]
    : [['damage', '⚔ Attack'], ['maneuver', '🤼 Maneuver'], ['heal', '✚ Heal'], ['condition', '✦ Effect']];

  return (
    <div className="par-box">
      <div className="par-head">
        <span className="par-src" style={{ background: sourceEntity.color }}>{(sourceEntity.name[0] || '?').toUpperCase()}</span>
        {sourceOptions.length > 1 ? (
          <select className="par-source-select" value={sourceId} onChange={e => setSourceId(e.target.value)} title="Who is acting">
            {sourceOptions.map(e => (
              <option key={e.id} value={e.id}>{e.name}{e.type === 'Familiar' ? ' (familiar)' : e.type !== 'PC' ? ` (${e.type})` : ''}</option>
            ))}
          </select>
        ) : (
          <span className="par-head-text">{sourceEntity.name}</span>
        )}
        <span className="par-head-arrow">→ <strong>{targetEntity.name}</strong></span>
      </div>
      {inCombat && (
        <div className={`par-range-note ${hasDist ? '' : 'far'}`}>
          {hasDist ? `In combat · ${dist} ft to target` : 'In combat · attacker not on this map'}
        </div>
      )}
      {modes.length > 1 && (
        <div className="par-modes">
          {modes.map(([m, label]) => (
            <button key={m} className={`par-mode ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
      )}

      {mode === 'damage' && equippedWeapons.length > 0 && (
        <div className="par-weapon-pick">
          <button className={`par-wchip ${weaponSel === '' ? 'active' : ''}`} onClick={() => setWeaponSel('')}>✎ Custom</button>
          {equippedWeapons.flatMap(w => w.attacks.map(a => {
            const key = `${w.id}|${a.id}`;
            const reach = canReach(a.range);
            return (
              <button key={key} disabled={!reach} className={`par-wchip ${weaponSel === key ? 'active' : ''} ${reach ? '' : 'out'}`}
                title={reach ? formatAttack(a) : `Out of range: ${dist} ft away, reach ${a.range || 0} ft`} onClick={() => reach && setWeaponSel(key)}>
                {w.name}: {a.name}{!reach && ' ⛌'}
              </button>
            );
          }))}
        </div>
      )}

      {mode === 'damage' && (
        <div className="par-adv">
          <button className={`par-adv-btn adv ${advMode === 'advantage' ? 'on' : ''}`} title="Roll the to-hit twice, keep the highest"
            onClick={() => setAdvMode(m => m === 'advantage' ? 'normal' : 'advantage')}>{advMode === 'advantage' ? '☑' : '☐'} Advantage</button>
          <button className={`par-adv-btn dis ${advMode === 'disadvantage' ? 'on' : ''}`} title="Roll the to-hit twice, keep the lowest"
            onClick={() => setAdvMode(m => m === 'disadvantage' ? 'normal' : 'disadvantage')}>{advMode === 'disadvantage' ? '☑' : '☐'} Disadvantage</button>
        </div>
      )}

      {mode === 'maneuver' ? (
        <div className="par-maneuvers">
          {!inCombat && hasDist && (
            <div className="par-range-note">{dist} ft to target · melee maneuvers reach 5 ft</div>
          )}
          <div className="par-man-grid">
            {MANEUVER_PRESETS.map(m => {
              const reach = maneuverReaches(m.range);
              return (
                <button key={m.key} disabled={!reach} className={`par-man ${manSel === m.key ? 'active' : ''} ${reach ? '' : 'out'}`}
                  title={m.condition ? `${m.ability} save DC ${m.dc} or ${m.condition} · within ${m.range} ft${reach ? '' : ` · ${dist} ft away`}` : `${m.ability} save DC ${m.dc} · within ${m.range} ft${reach ? '' : ` · ${dist} ft away`}`}
                  onClick={() => reach && (setManSel(m.key), setManCond(m.condition || 'Grappled'), setManAbil(m.ability), setManDc(m.dc))}>
                  {m.icon} {m.label}{!reach && ' ⛌'}
                </button>
              );
            })}
            <button className={`par-man ${manSel === 'custom' ? 'active' : ''}`} onClick={() => setManSel('custom')}>✎ Custom</button>
          </div>
          {manSel && (() => {
            const preset = MANEUVER_PRESETS.find(m => m.key === manSel);
            const label = preset ? preset.label : 'Maneuver';
            const range = preset ? preset.range : 5;
            const reach = maneuverReaches(range);
            return (
              <div className="par-man-detail">
                <div className="par-man-row">
                  <label className="par-field" style={{ flex: 1 }}>Effect
                    <select value={manCond} onChange={e => setManCond(e.target.value)}>
                      <option value="">(no condition - DM resolves)</option>
                      {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </label>
                </div>
                <div className="par-man-row">
                  <label className="par-field">Save
                    <select value={manAbil} onChange={e => setManAbil(e.target.value)}>
                      {ABILITIES.map(a => <option key={a} value={a}>{a}</option>)}
                    </select>
                  </label>
                  <label className="par-field">DC
                    <input type="number" min="1" max="40" value={manDc} onChange={e => setManDc(e.target.value)} />
                  </label>
                </div>
                {!reach && <div className="par-oor">Out of range - {dist} ft away, reach {range} ft.</div>}
                <button className="btn primary par-send" disabled={!reach}
                  onClick={() => sendManeuver({ label, condition: manCond, ability: manAbil, dc: manDc, range, contest: preset ? preset.contest : false })}>
                  {dmMode ? '🤼 Launch' : '🤼 Send'} {label}
                </button>
              </div>
            );
          })()}
        </div>
      ) : mode === 'condition' ? (
        <div className="par-man-detail">
          <div className="par-man-row">
            <label className="par-field" style={{ flex: 1 }}>Effect
              <select value={effCond} onChange={e => setEffCond(e.target.value)}>
                {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <div className="par-man-row">
            <label className="par-field">Save
              <select value={effAbil} onChange={e => setEffAbil(e.target.value)}>
                {ABILITIES.map(a => <option key={a} value={a}>{a}</option>)}
              </select>
            </label>
            <label className="par-field">DC
              <input type="number" min="1" max="40" value={effDc} onChange={e => setEffDc(e.target.value)} />
            </label>
          </div>
          <div className="settings-hint" style={{ marginBottom: 6 }}>{targetEntity.name} rolls a {effAbil} save vs DC {effDc} or becomes {effCond}.</div>
          <button className="btn primary par-send" onClick={() => sendEffect(effCond, effAbil, effDc)}>
            {dmMode ? '✦ Launch' : '✦ Send'} {effCond}
          </button>
        </div>
      ) : showWeapon ? (
        <div className="par-wpreview">
          <div className="par-wp-line"><b>{selWeapon.name} - {selAttack.name}</b></div>
          <div className="par-wp-meta">+{selAttack.toHit || 0} to hit · {selAttack.range || 0} ft. range</div>
          {(selAttack.damage || []).map((c, i) => (
            <div key={i} className="par-wp-comp"><span className="par-wp-dice">{formatDamageComp(c)}</span></div>
          ))}
          {selAttack.effect && selAttack.effect.condition && (
            <div className="par-wp-effect">✦ {selAttack.effect.condition}{selAttack.effect.save ? ` (${selAttack.effect.save.ability} save DC ${selAttack.effect.save.dc})` : ' on hit'}</div>
          )}
          {!selReach && <div className="par-oor">Out of range - {dist} ft away, reach {selAttack.range || 0} ft.</div>}
          {manual ? (
            <div className="par-manual">
              <div className="par-manual-title">Enter your rolls</div>
              <div className="par-manual-row">
                <span className="par-manual-lbl">To-hit d20{advMode !== 'normal' ? ' ×2' : ''}</span>
                <input className="par-manual-die" type="number" min="1" max="20" autoFocus value={manual.d20a} onChange={e => setManual(s => ({ ...s, d20a: e.target.value }))} />
                {advMode !== 'normal' && <input className="par-manual-die" type="number" min="1" max="20" value={manual.d20b} onChange={e => setManual(s => ({ ...s, d20b: e.target.value }))} />}
              </div>
              {(manual.atk.damage || []).map((c, ci) => (
                <div key={ci} className="par-manual-row">
                  <span className="par-manual-lbl">{c.count}d{c.sides} {c.type}</span>
                  {manual.dieVals[ci].map((v, di) => (
                    <input key={di} className="par-manual-die" type="number" min="1" max={c.sides} value={v}
                      onChange={e => setManual(s => { const dv = s.dieVals.map(a => a.slice()); dv[ci][di] = e.target.value; return { ...s, dieVals: dv }; })} />
                  ))}
                </div>
              ))}
              <div className="par-manual-actions">
                <button className="btn primary" onClick={confirmManual}>Send with these rolls</button>
                <button className="btn" onClick={() => setManual(null)}>Cancel</button>
              </div>
            </div>
          ) : (
            <button className="btn primary par-send" disabled={!selReach} onClick={() => beginWeaponAttack(selWeapon, selAttack)}>
              {physicalDice ? (dmMode ? '✎ Attack with' : '✎ Enter rolls for') : (dmMode ? '⚔ Roll & attack' : '⚔ Roll & send')} {selAttack.name}
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="par-dice">
            {ALLOWED_DIE_SIDES.map(s => (
              <div key={s} className="par-die">
                <span className="par-die-label">d{s}</span>
                <button className="par-die-btn" onClick={() => bump(s, -1)} disabled={(counts[s] | 0) <= 0}>−</button>
                <span className="par-die-count">{counts[s] | 0}</span>
                <button className="par-die-btn" onClick={() => bump(s, +1)}>+</button>
              </div>
            ))}
          </div>
          <div className="par-row">
            <label className="par-field">Modifier
              <input type="number" value={modifier} onChange={e => setModifier(e.target.value)} />
            </label>
            <label className="par-field">Manual roll
              <input type="number" min="0" value={flat} onChange={e => setFlat(e.target.value)} placeholder="real dice" />
            </label>
          </div>
          {mode === 'damage' && (
            <div className="par-row">
              <label className="par-field" style={{ flex: 1 }}>Damage type
                <select value={dmgType} onChange={e => setDmgType(e.target.value)}>
                  {DAMAGE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                  <option value="__custom__">Custom…</option>
                </select>
              </label>
              {dmgType === '__custom__' && (
                <label className="par-field" style={{ flex: 1 }}>Custom
                  <input type="text" value={customType} maxLength={24} placeholder="e.g. Void"
                    onChange={e => setCustomType(e.target.value)} />
                </label>
              )}
            </div>
          )}
          <button className="btn primary par-send" onClick={sendManual}>
            {mode === 'heal' ? (dmMode ? '✚ Apply heal' : '✚ Send heal to DM') : (dmMode ? '⚔ Launch attack' : '⚔ Send attack to DM')}{totalDice > 0 ? ` (${totalDice} dice)` : ''}
          </button>
        </>
      )}
      {sent && <div className="par-sent">{sent}</div>}
    </div>
  );
}

// v8.7: radial "doughnut" action menu. Opens on double-click, ringing the
// token with category buttons; picking one opens just that section of the
// detail panel, so the old wall-of-controls is broken into clear sub-menus.
function RadialTokenMenu(props) {
  const { state, token, entity, mode, claimedEntityId, myPeerId, onClose } = props;
  const [section, setSection] = useState(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const el = document.querySelector(`[data-tok="${token?.id}"]`);
    if (el) {
      const r = el.getBoundingClientRect();
      setPos({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    } else {
      setPos({ x: window.innerWidth / 2, y: window.innerHeight / 2 });
    }
  }, [token?.id]);
  if (!entity) return null;

  const isDM = mode === 'dm';
  const isOwnPC = entity.id === claimedEntityId;
  const ownedIds = (myPeerId && typeof ownedByPeer === 'function')
    ? ownedByPeer(state, myPeerId)
    : new Set(claimedEntityId ? [claimedEntityId] : []);
  const ownsThis = isDM || ownedIds.has(entity.id);
  const isActiveMover = !!(state.initiative?.active && state.initiative.entries[state.initiative.turn]?.entityId === entity.id);
  const canEditHp = isDM || isOwnPC;
  const canEditConditions = isDM || isOwnPC;
  const hasAttack = isDM
    ? Object.values(state.entities).some(e => e && e.id !== entity.id && ['PC', 'Monster', 'NPC', 'Familiar', 'Neutral Beast'].includes(e.type) && Object.values(state.tokens).some(t => t.entityId === e.id && token && t.mapId === token.mapId))
    : (!isOwnPC && [...ownedIds].some(id => { const e = state.entities[id]; return e && e.id !== entity.id && (e.type === 'PC' || e.type === 'Familiar'); }));

  const cats = [{ key: 'info', icon: 'ⓘ', label: 'Info' }];
  if (isActiveMover && ownsThis) cats.push({ key: 'move', icon: '🏃', label: 'Move' });
  if (hasAttack) cats.push({ key: 'attack', icon: '⚔', label: 'Attack' });
  if (canEditHp) cats.push({ key: 'hp', icon: '✚', label: 'HP' });
  if (canEditConditions) cats.push({ key: 'conditions', icon: '✦', label: 'Status' });

  if (!pos) return null;
  const R = Math.max(78, 54 + cats.length * 8);
  const clampedX = Math.min(Math.max(pos.x, R + 20), window.innerWidth - R - 20);
  const clampedY = Math.min(Math.max(pos.y, R + 20), window.innerHeight - R - 20);

  return ReactDOM.createPortal(
    <>
      <div className="radial-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="radial-ring" style={{ left: clampedX, top: clampedY }}>
          <div className="radial-hub">
            <div className="radial-hub-avatar" style={{ background: entity.color }}>
              {entity.imageUrl ? <img src={entity.imageUrl} alt="" /> : (entity.name[0] || '?').toUpperCase()}
            </div>
            <div className="radial-hub-name">{entity.name}</div>
            <button className="radial-hub-close" onClick={onClose} title="Close">×</button>
          </div>
          {cats.map((c, i) => {
            const ang = (i / cats.length) * 2 * Math.PI - Math.PI / 2;
            const x = Math.cos(ang) * R, y = Math.sin(ang) * R;
            return (
              <button key={c.key} className={`radial-seg ${section === c.key ? 'on' : ''}`}
                style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}
                onClick={() => setSection(s => (s === c.key ? null : c.key))} title={c.label}>
                <span className="radial-seg-ic">{c.icon}</span>
                <span className="radial-seg-lbl">{c.label}</span>
              </button>
            );
          })}
        </div>
      </div>
      {section && (
        <TokenDetailPanel {...props} focusSection={section} onClose={() => setSection(null)} />
      )}
    </>,
    document.body
  );
}

function TokenDetailPanel({ state, token, entity, mode, dispatch, onClose, claimedEntityId, myPeerId, playerActionSender, onLongRest, onShortRest, obfuscateHp, physicalDice, focusSection = null, embedded = false }) {
  const [hpDelta, setHpDelta] = useState(0);
  // v8.7: when opened from the radial menu, only one section is shown at a time.
  const show = (s) => !focusSection || focusSection === s;

  if (!entity) return null;

  const isDM = mode === 'dm';
  const isOwnPC = entity.id === claimedEntityId;
  const isOpaqueForPlayer = !isDM && !PLAYER_HP_VISIBLE_TYPES.has(entity.type);
  // obfuscateHp hides exact HP from players in all panels including this one
  const showExactHp = isDM || (!obfuscateHp && !isOpaqueForPlayer);
  const hpPct = entity.hp.max > 0 ? (entity.hp.current / entity.hp.max) * 100 : 0;

  // DM edits via local dispatch. Own-PC player edits go through playerActionSender
  // which routes through the DM as authority - keeping sync clean.
  const emitHpAdjust = (delta) => {
    if (isDM) {
      dispatch({ type: 'ENTITY_HP_ADJUST', id: entity.id, delta });
    } else if (isOwnPC && playerActionSender) {
      playerActionSender({ type: 'patch_own_entity', payload: { op: 'hp_adjust', delta } });
    }
  };
  const emitToggleCondition = (c) => {
    if (isDM) {
      dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: entity.id, condition: c });
    } else if (isOwnPC && playerActionSender) {
      playerActionSender({ type: 'patch_own_entity', payload: { op: 'toggle_condition', condition: c } });
    }
  };

  const applyHp = (sign) => {
    const d = Math.abs(hpDelta) * sign;
    if (d === 0) return;
    emitHpAdjust(d);
    setHpDelta(0);
  };

  const toggleVisibility = () => {
    dispatch({ type: 'TOKEN_VISIBILITY', id: token.id, visible: !token.visible });
  };

  const removeToken = () => {
    if (!confirm('Remove this token from the map?')) return;
    dispatch({ type: 'TOKEN_REMOVE', id: token.id });
    onClose();
  };

  // HP descriptor for monsters viewed by players
  const hpPctRaw = entity.hp.max > 0 ? (entity.hp.current / entity.hp.max) * 100 : 0;
  const monsterStatus =
    hpPctRaw <= 0 ? 'Down' :
    hpPctRaw < 30 ? 'Waning' :
    hpPctRaw <= 70 ? 'Rough' :
    'Strong';

  // v6 fix #3: Label entities get a simple state descriptor derived
  // from HP percentage. No AC, Speed, Passive Perception, or conditions.
  //    70%+     → no label (pristine)
  //    50-70%   → "Damaged"
  //    20-50%   → "Derelict"
  //    0-20%    → "Ruins"
  // Labels whose max HP is 0 are considered pristine (no damage state).
  const labelState =
    entity.type === 'Label' && entity.hp.max > 0
      ? (hpPctRaw > 70 ? null
        : hpPctRaw > 50 ? 'Damaged'
        : hpPctRaw > 20 ? 'Derelict'
        : 'Ruins')
      : null;

  const canEditHp = isDM || isOwnPC;
  const canEditConditions = isDM || isOwnPC;

  // v8.1: combat range helpers. distance (in feet) from a would-be attacker's
  // token to this target token on the same map; Infinity if off-map.
  const inCombat = !!state.initiative?.active;
  const rangeInfoFor = (opts) => {
    const distanceBySource = {};
    for (const e of opts) {
      const st = Object.values(state.tokens).find(t => t.entityId === e.id && token && t.mapId === token.mapId);
      distanceBySource[e.id] = (st && token) ? Math.round(Math.hypot(st.x - token.x, st.y - token.y) / PX_PER_FOOT) : Infinity;
    }
    return { inCombat, distanceBySource };
  };
  // v8.1: DM-launched attack - fire the shared cinematic directly (no approval).
  const dmLaunch = ({ kind, data }) => {
    if (kind !== 'apply_damage') return;
    const src = state.entities[data.sourceEntityId];
    const ac = (typeof entity.ac === 'number') ? entity.ac : null;
    const advMode = data.advMode || 'normal';
    const d20a = data.d20a ?? data.toHitRoll ?? null;
    const d20b = data.d20b ?? d20a;
    const toHitRoll = (d20a != null) ? effectiveD20(advMode, d20a, d20b) : null;
    const toHitTotal = (toHitRoll != null) ? toHitRoll + (data.toHit || 0) : null;
    const hit = (toHitTotal != null && ac != null) ? toHitTotal >= ac : true;
    const components = (data.components || []).map(c => ({
      dice: c.dice || [], diceSum: (c.dice || []).reduce((x, d) => x + (d.result || 0), 0),
      modifier: c.modifier || 0, flat: c.flat || 0, type: c.type || '',
    }));
    dispatch({ type: 'ATTACK_SET', attack: {
      id: uid('atk_'), attackerId: data.sourceEntityId, attackerName: src?.name || 'Attacker', attackerColor: src?.color || '#888', attackerImg: src?.imageUrl || null,
      targetId: entity.id, targetName: entity.name, targetColor: entity.color, targetImg: entity.imageUrl || null, targetAc: ac,
      weaponName: data.weaponName || '', attackName: data.attackName || '', toHit: data.toHit ?? null, toHitRoll, hit,
      d20a, d20b, advMode, effect: data.effect || null, targetStats: entity.stats || {},
      components, startedTs: Date.now(),
    } });
    onClose?.();
  };

  // v8.3: per-turn movement state for this entity (when it's the active mover).
  const mvWalk = walkSpeedOf(entity), mvFly = flySpeedOf(entity), mvJump = jumpSpeedOf(entity), mvSwim = swimSpeedOf(entity), mvClimb = climbSpeedOf(entity);
  const mvObj = state.movement;
  const isMover = mvObj && mvObj.entityId === entity.id;
  const mvMode = isMover ? (mvObj.jumpPending ? 'jump' : (mvObj.mode || 'walk')) : 'walk';
  const mvDashed = isMover ? !!mvObj.dashed : false;
  const mvBudget = (isMover && mvObj.budgetFt != null) ? mvObj.budgetFt : mvWalk;
  const mvUsed = isMover ? (mvObj.usedFt || 0) : 0;
  const mvRemaining = Math.max(0, Math.round(mvBudget - mvUsed));
  const isActiveMover = !!(state.initiative?.active && state.initiative.entries[state.initiative.turn]?.entityId === entity.id);
  const ownsThis = isDM || isOwnPC || (myPeerId && typeof ownedByPeer === 'function' && ownedByPeer(state, myPeerId).has(entity.id));
  const sendMovementMode = (m) => {
    if (isDM) dispatch({ type: 'MOVEMENT_MODE', entityId: entity.id, mode: m });
    else if (playerActionSender) playerActionSender({ type: 'movement_mode', mode: m, entityId: entity.id });
  };

  // v6 fix #3: Label entities get a dedicated minimal panel - no HP
  // numbers, no AC/Speed/Conditions, just the name + a state descriptor
  // and optional player-visible description (map lore).
  if (entity.type === 'Label') {
    return (
      <FloatPanel style={{ left: 16, top: 80, width: 300, ...(focusSection ? { zIndex: 400 } : {}) }}>
        <div className="float-panel-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="bestiary-role" style={{ fontStyle: 'normal', color: entity.color || '#c9a34a', fontFamily: 'Cinzel, serif', letterSpacing: '0.1em' }}>
              ✦
            </span>
            {entity.name}
          </span>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="float-panel-body">
          <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginBottom: 8, fontStyle: 'italic' }}>
            Map label
          </div>
          {labelState && (
            <div className={`label-state-chip state-${labelState.toLowerCase()}`}>
              {labelState}
            </div>
          )}
          {entity.playerDescription && (
            <div className="statblock-note" style={{ marginTop: 10 }}>
              <em>{entity.playerDescription}</em>
            </div>
          )}
          {isDM && (
            <>
              <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border-soft)' }}>
                <label style={{ fontSize: 10 }}>HP (drives state descriptor)</label>
                <div className="form-row-2">
                  <input type="number" value={entity.hp.current}
                    onChange={e => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { hp: { ...entity.hp, current: Number(e.target.value) || 0 } } })} />
                  <input type="number" value={entity.hp.max}
                    onChange={e => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { hp: { ...entity.hp, max: Number(e.target.value) || 0 } } })} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button className="btn sm" onClick={toggleVisibility}>{token.visible ? '🕶 Hide' : '👁 Reveal'}</button>
                <button className="btn sm danger" onClick={removeToken}>✕ Remove</button>
              </div>
            </>
          )}
        </div>
      </FloatPanel>
    );
  }

  return (
    <FloatPanel style={{ left: 16, top: 80, width: 340, ...(focusSection ? { zIndex: 400 } : {}) }}>
      <div className="float-panel-header">
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div className="entity-swatch" style={{ background: entity.color, width: 12, height: 12 }} />
          {entity.name}
          {isOwnPC && <span className="own-pc-badge">YOU</span>}
        </span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {show('info') && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 12 }}>
          {!isOpaqueForPlayer && (
            <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>AC</div>
              <div className="mono" style={{ fontSize: 20, fontWeight: 600, color: 'var(--gold)' }}>{entity.ac}</div>
            </div>
          )}
          <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
            <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>HP</div>
            {isOpaqueForPlayer ? (
              <div className={`status-label status-${monsterStatus.toLowerCase()}`}>{monsterStatus}</div>
            ) : showExactHp ? (
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{entity.hp.current}<span style={{ color: 'var(--ink-mute)', fontSize: 12 }}>/{entity.hp.max}</span></div>
            ) : (
              <div className={`status-label status-${hpLabel(hpPct).text.toLowerCase()}`}>{hpLabel(hpPct).text}</div>
            )}
          </div>
          {!isOpaqueForPlayer && (
            <div style={{ textAlign: 'center', padding: 8, background: 'var(--bg-0)', borderRadius: 4, border: '1px solid var(--border-soft)' }}>
              <div style={{ fontSize: 10, color: 'var(--ink-dim)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Speed</div>
              <div className="mono" style={{ fontSize: 18, fontWeight: 600 }}>{mvWalk}{mvFly > 0 ? <span style={{ color: 'var(--ink-mute)', fontSize: 11 }} title="Fly speed"> 🪽{mvFly}</span> : null}</div>
            </div>
          )}
        </div>
        )}

        {show('info') && (
        <div style={{ fontSize: 11, color: 'var(--ink-dim)', marginBottom: 8 }}>
          {entity.type === 'PC' && `Level ${entity.level} ${entity.class || ''}${entity.playerName ? ` · ${entity.playerName}` : ''}`}
          {entity.type === 'Monster' && isDM && `CR ${entity.cr}`}
          {entity.type === 'NPC' && (entity.faction ? `${entity.role} · ${entity.faction}` : entity.role || 'NPC')}
        </div>
        )}

        {isOpaqueForPlayer && entity.playerDescription && (
          <div className="statblock-note" style={{ marginBottom: 10 }}>
            {entity.playerDescription}
          </div>
        )}

        {show('hp') && canEditHp && (
          <>
            <label>Adjust HP {isOwnPC && !isDM && <span style={{ color: 'var(--gold-dim)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- your character</span>}</label>
            <div className="hp-adjuster" style={{ marginBottom: 10 }}>
              <button className="btn danger" onClick={() => applyHp(-1)}>− Damage</button>
              <input type="number" value={hpDelta} onChange={e => setHpDelta(Math.abs(Number(e.target.value)) || 0)} />
              <button className="btn" onClick={() => applyHp(+1)}>+ Heal</button>
            </div>
          </>
        )}

        {show('conditions') && canEditConditions && (
          <div style={{ marginBottom: 10 }}>
            <label>Conditions</label>
            <ConditionPicker
              active={entity.conditions}
              onToggle={emitToggleCondition}
              canEdit={canEditConditions}
            />
          </div>
        )}

        {/* v8.3: movement actions for the active combatant on its turn. Dash
            doubles the budget; Fly switches to fly speed; Walk reverts; Jump
            grants a one-move burst up to jump speed then reverts to walk. */}
        {show('move') && isActiveMover && ownsThis && (
          <div className="move-actions" style={{ marginBottom: 10 }}>
            <label>Movement {mvFly > 0 ? `· walk ${mvWalk} / fly ${mvFly} ft` : `· ${mvWalk} ft`}{mvJump > 0 ? ` · jump ${mvJump} ft` : ''}</label>
            <div className="move-actions-row">
              <button className={`move-act ${mvMode === 'walk' && !mvDashed ? 'on' : ''}`} onClick={() => sendMovementMode('walk')} title="Normal walking speed">🥾 Walk</button>
              <button className={`move-act ${mvDashed ? 'on' : ''}`} onClick={() => sendMovementMode('dash')} title="Double your movement for this turn">💨 Dash</button>
              {mvFly > 0 && <button className={`move-act ${mvMode === 'fly' ? 'on' : ''}`} onClick={() => sendMovementMode('fly')} title="Move using your fly speed">🪽 Fly</button>}
              {mvSwim > 0 && <button className={`move-act ${mvMode === 'swim' ? 'on' : ''}`} onClick={() => sendMovementMode('swim')} title="Move using your swim speed">🌊 Swim</button>}
              {mvClimb > 0 && <button className={`move-act ${mvMode === 'climb' ? 'on' : ''}`} onClick={() => sendMovementMode('climb')} title="Move using your climb speed">🧗 Climb</button>}
              {mvJump > 0 && <button className={`move-act ${mvMode === 'jump' ? 'on' : ''}`} onClick={() => sendMovementMode('jump')} title="Leap up to your jump speed, then revert to your remaining walk">🦗 Jump</button>}
            </div>
            <div className="move-actions-rem">
              <b>{mvRemaining} ft</b> remaining{mvMode === 'jump' ? ' · jump armed (next move)' : mvDashed ? ' · dashing' : mvMode === 'fly' ? ' · flying' : mvMode === 'swim' ? ' · swimming' : mvMode === 'climb' ? ' · climbing' : ''}
            </div>
          </div>
        )}

        {/* v7.9: a player viewing someone else's token can request damage,
            healing, or a condition; the DM gets a central popup to approve it.
            The attack's origin can be any creature the player controls - their
            PC, a familiar, or a PC the DM has lent them. */}
        {show('attack') && !isDM && !isOwnPC && (() => {
          const ownedIds = myPeerId ? [...ownedByPeer(state, myPeerId)]
            : (claimedEntityId ? [claimedEntityId] : []);
          const sourceOptions = ownedIds
            .map(id => state.entities[id])
            .filter(e => e && e.id !== entity.id && (e.type === 'PC' || e.type === 'Familiar'));
          if (sourceOptions.length === 0) {
            return (
              <div className="settings-hint" style={{ marginBottom: 10 }}>
                Claim a character to attack, heal, or affect this token.
              </div>
            );
          }
          const defaultSourceId = (claimedEntityId && sourceOptions.some(e => e.id === claimedEntityId))
            ? claimedEntityId : sourceOptions[0].id;
          return (
            <PlayerActionRequest
              sourceOptions={sourceOptions}
              defaultSourceId={defaultSourceId}
              targetToken={token}
              targetEntity={entity}
              playerActionSender={playerActionSender}
              rangeInfo={rangeInfoFor(sourceOptions)}
              physicalDice={physicalDice}
            />
          );
        })()}

        {/* v8.1: the DM can launch an attack on this token from any creature
            with a token on the map (NPCs, monsters, beasts, even a PC). Uses
            the same shared cinematic; in combat, out-of-range options grey out. */}
        {show('attack') && isDM && (() => {
          const sourceOptions = Object.values(state.entities)
            .filter(e => e && e.id !== entity.id
              && ['PC', 'Monster', 'NPC', 'Familiar', 'Neutral Beast'].includes(e.type)
              && Object.values(state.tokens).some(t => t.entityId === e.id && token && t.mapId === token.mapId));
          if (sourceOptions.length === 0) {
            return (
              <div className="settings-hint" style={{ marginBottom: 10 }}>
                Place another creature's token on this map to attack {entity.name} from it.
              </div>
            );
          }
          const activeId = inCombat ? state.initiative.entries[state.initiative.turn]?.entityId : null;
          const defaultSourceId = (activeId && sourceOptions.some(e => e.id === activeId)) ? activeId : sourceOptions[0].id;
          return (
            <div style={{ marginBottom: 10 }}>
              <label>Attack {entity.name} from…</label>
              <PlayerActionRequest
                sourceOptions={sourceOptions}
                defaultSourceId={defaultSourceId}
                targetToken={token}
                targetEntity={entity}
                dmMode
                attackOnly
                onDmSubmit={dmLaunch}
                rangeInfo={rangeInfoFor(sourceOptions)}
                physicalDice={physicalDice}
              />
            </div>
          );
        })()}

        {show('info') && isDM && entity.type === 'Monster' && entity.abilities && (
          <div style={{ marginBottom: 10 }}>
            <label>Abilities</label>
            <div style={{ fontSize: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>{entity.abilities}</div>
          </div>
        )}

        {show('info') && isDM && entity.notes && (
          <div style={{ marginBottom: 10 }}>
            <label>DM Notes</label>
            <div style={{ fontSize: 12, padding: 8, background: 'var(--bg-0)', borderRadius: 4, whiteSpace: 'pre-wrap' }}>{entity.notes}</div>
          </div>
        )}

        {/* v3: DM-only death save tracker (PCs only). Counters clamp 0-3. */}
        {show('info') && isDM && entity.type === 'PC' && (
          <div style={{ marginBottom: 10 }}>
            <label>Death Saves <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- DM only</span></label>
            <div className="death-saves">
              <div className="death-saves-row">
                <span className="death-saves-label good">Successes</span>
                <div className="death-pip-row">
                  {[1,2,3].map(n => {
                    const filled = (entity.deathSaves?.successes || 0) >= n;
                    return (
                      <button key={n} type="button"
                        className={`death-pip success ${filled ? 'filled' : ''}`}
                        onClick={() => dispatch({ type: 'DEATH_SAVE_SET', id: entity.id,
                          successes: filled && (entity.deathSaves?.successes === n) ? n - 1 : n })}
                        title={`Set successes to ${n}`}>✓</button>
                    );
                  })}
                </div>
              </div>
              <div className="death-saves-row">
                <span className="death-saves-label bad">Failures</span>
                <div className="death-pip-row">
                  {[1,2,3].map(n => {
                    const filled = (entity.deathSaves?.failures || 0) >= n;
                    return (
                      <button key={n} type="button"
                        className={`death-pip failure ${filled ? 'filled' : ''}`}
                        onClick={() => dispatch({ type: 'DEATH_SAVE_SET', id: entity.id,
                          failures: filled && (entity.deathSaves?.failures === n) ? n - 1 : n })}
                        title={`Set failures to ${n}`}>✗</button>
                    );
                  })}
                </div>
              </div>
              {(entity.deathSaves?.successes > 0 || entity.deathSaves?.failures > 0) && (
                <button className="btn sm ghost" style={{ marginTop: 4 }}
                  onClick={() => dispatch({ type: 'DEATH_SAVE_CLEAR', id: entity.id })}>
                  Clear death saves
                </button>
              )}
            </div>
          </div>
        )}

        {/* v3/v5: Familiar bonding. v5 refinement - bond by PC *name*
            (entity id) rather than peer id. Whichever player currently
            claims that PC gets movement rights automatically; if the PC
            is unclaimed, the bond is dormant. This keeps the bond stable
            across player reconnects (peer ids change but entity ids are
            permanent). bondedPeerId is derived at permission-check time. */}
        {show('info') && isDM && entity.type === 'Familiar' && state && (
          <div style={{ marginBottom: 10 }}>
            <label>Bonded with <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- grants movement rights to whoever claims this PC</span></label>
            <select
              className="mono"
              value={entity.bondedPcId || ''}
              onChange={(e) => {
                const pcId = e.target.value || null;
                dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { bondedPcId: pcId } });
              }}
              style={{ width: '100%' }}>
              <option value="">- unbonded -</option>
              {Object.values(state.entities)
                .filter(ent => ent.type === 'PC')
                .map(pc => {
                  const claim = Object.values(state.claims || {}).find(c => c.pc === pc.id);
                  return (
                    <option key={pc.id} value={pc.id}>
                      {pc.name}{claim?.playerName ? ` (${claim.playerName})` : ' - unclaimed'}
                    </option>
                  );
                })}
            </select>
            {entity.bondedPcId && (() => {
              const pc = state.entities[entity.bondedPcId];
              const claim = pc && Object.values(state.claims || {}).find(c => c.pc === pc.id);
              if (!pc) return <div className="settings-hint">Bonded PC no longer exists.</div>;
              if (!claim) return <div className="settings-hint">Bond is dormant - no player has claimed {pc.name} yet.</div>;
              return <div className="settings-hint">{claim.playerName || 'A player'} controls this familiar.</div>;
            })()}
          </div>
        )}

        {/* v3: Vision stats - darkvision + light radius (DM-only edit) */}
        {show('info') && isDM && ['PC','Familiar','Monster','Neutral Beast','NPC'].includes(entity.type) && (
          <div style={{ marginBottom: 10 }}>
            <label>Vision <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- used by the darkness system</span></label>
            <div className="form-row-2">
              <div>
                <label style={{ fontSize: 9 }}>Darkvision (ft)</label>
                <input type="number" min="0" step="5" value={entity.darkvision || 0}
                  onChange={(e) => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { darkvision: Number(e.target.value) || 0 } })} />
              </div>
              <div>
                <label style={{ fontSize: 9 }}>Light Radius (ft)</label>
                <input type="number" min="0" step="5" value={entity.lightRadius || 0}
                  onChange={(e) => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch: { lightRadius: Number(e.target.value) || 0 } })} />
              </div>
            </div>
          </div>
        )}

        {/* v2/v5 fix #6: DM sickness editor. v5 widens to NPC/Monster/
            Neutral Beast/Familiar (previously PC-only). The descriptor
            is still the only thing players see - no numeric leak. */}
        {show('info') && isDM && ['PC','NPC','Monster','Neutral Beast','Familiar'].includes(entity.type) && (
          <div style={{ marginBottom: 10 }}>
            <label>Sickness <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- creeping pallor on this player's view</span></label>
            <div className="sickness-picker">
              {[0,1,2,3].map(lvl => (
                <button
                  key={lvl}
                  type="button"
                  className={`sickness-btn ${entity.sickness === lvl ? 'active' : ''} sick-level-${lvl}`}
                  onClick={() => dispatch({ type: 'SET_SICKNESS', id: entity.id, level: lvl })}
                >
                  <span className="sickness-num">{lvl}</span>
                  <span className="sickness-label">{lvl === 0 ? 'Healthy' : SICKNESS_DESCRIPTORS[lvl]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* v2: DM-only per-token scale slider. Lets bosses grow, imps shrink. */}
        {show('info') && isDM && (
          <div style={{ marginBottom: 10 }}>
            <label>Token Size <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- scale on this map</span></label>
            <div className="scale-row">
              <button className="btn sm" onClick={() => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: Math.max(0.3, (token.scale || 1) - 0.1) })}>−</button>
              <input type="range" min="0.3" max="4" step="0.05"
                value={token.scale || 1}
                onChange={(e) => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: Number(e.target.value) })} />
              <button className="btn sm" onClick={() => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: Math.min(4, (token.scale || 1) + 0.1) })}>+</button>
              <span className="mono scale-value">{((token.scale || 1) * 100).toFixed(0)}%</span>
              <button className="btn sm ghost" onClick={() => dispatch({ type: 'TOKEN_SCALE', id: token.id, scale: 1 })}>Reset</button>
            </div>
          </div>
        )}

        {show('info') && isDM && (
          <div style={{ display: 'flex', gap: 6, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={toggleVisibility}>
              {token.visible ? '🕶 Hide from players' : '👁 Reveal to players'}
            </button>
            {onLongRest && (entity.type === 'PC' || entity.type === 'Familiar') && (
              <button className="btn" onClick={() => onLongRest(entity.id)} title="Long rest this character only">⛭ Long Rest</button>
            )}
            {onShortRest && (entity.type === 'PC' || entity.type === 'Familiar') && (
              <button className="btn" onClick={() => onShortRest(entity.id)} title="Short rest - restore half of max HP">◑ Short Rest</button>
            )}
            <button className="btn danger" onClick={removeToken}>Remove</button>
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// TOKEN TOOLTIP  (hover info - DM sees full, player sees public subset)
// ====================================================================
// Small floating chip that follows the cursor. Not a React portal (lives
// inside the canvas container) so its coordinates are viewport-relative.
function TokenTooltip({ hovered, entities, mode, x, y, obfuscateHp, ownedEntityIds }) {
  if (!hovered) return null;
  const ent = entities[hovered.entityId];
  if (!ent) return null;
  const isDM = mode === 'dm';
  const isOwned = ownedEntityIds?.has(ent.id);
  const showExactHp = isDM || (!obfuscateHp && (isOwned || PLAYER_HP_VISIBLE_TYPES.has(ent.type)));
  const hpPct = ent.hp.max > 0 ? (ent.hp.current / ent.hp.max) * 100 : 0;
  const label = hpLabel(hpPct);
  const description = isDM
    ? (ent.notes || ent.playerDescription || '')
    : (ent.playerDescription || '');
  const sicknessLabel = SICKNESS_DESCRIPTORS[ent.sickness || 0] || '';
  return (
    <div className="token-tooltip" style={{ left: x + 16, top: y + 16 }}>
      <div className="token-tooltip-header">
        <span className="token-tooltip-name">{ent.name}</span>
        <span className={`token-tooltip-type type-${TOKEN_SHAPE_CLASS[ent.type] || 'npc'}`}>{ent.type}</span>
      </div>
      {ent.hp.max > 0 && (
        showExactHp
          ? <div className="token-tooltip-hp mono">HP {ent.hp.current}/{ent.hp.max}</div>
          : <div className={`status-label status-${label.text.toLowerCase()}`}>{label.text}</div>
      )}
      {sicknessLabel && (
        <div className={`token-tooltip-sickness sick-level-${ent.sickness}`}>
          <em>{sicknessLabel.toLowerCase()}</em>
        </div>
      )}
      {description && <div className="token-tooltip-desc">{description}</div>}
      {ent.conditions.length > 0 && (
        <div className="token-tooltip-conds">
          {ent.conditions.map(c => (
            <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// SETTINGS MODAL  (theme + global map scale)
// ====================================================================
// Returns a rough health estimate label from an HP percentage.
// Used when the DM enables obfuscateHp - players see these instead of numbers.
function hpLabel(pct) {
  if (pct <= 0)  return { text: 'Down',    cls: 'critical' };
  if (pct <= 25) return { text: 'Waning',  cls: 'critical' };
  if (pct <= 60) return { text: 'Rough',   cls: 'low' };
  return            { text: 'Strong',  cls: '' };
}

function SettingsModal({ settings, onChange, onClose, mode, mapScale, onMapScaleChange }) {
  useEscClose(onClose);
  const [tab, setTab] = useState('aesthetic');
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal slide-up" style={{ maxWidth: 460 }}>
        <div className="float-panel-header">
          <span>⚙ Settings</span>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="float-panel-body">
          <div className="settings-tabs">
            <button className={`settings-tab ${tab === 'aesthetic' ? 'active' : ''}`} onClick={() => setTab('aesthetic')}>🎨 Aesthetic</button>
            <button className={`settings-tab ${tab === 'gameplay' ? 'active' : ''}`} onClick={() => setTab('gameplay')}>🎲 Gameplay</button>
          </div>

          {tab === 'aesthetic' && (<>
          <div className="settings-section">
            <label className="settings-label">Theme</label>
            <div className="theme-switch">
              <button
                className={`theme-option ${settings.theme === 'dark' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'dark' })}
              >
                <span className="theme-swatch dark" />
                <span>Dark Sanctum</span>
                <span className="theme-sub">Navy · gilded</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'forest' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'forest' })}
              >
                <span className="theme-swatch forest" />
                <span>Dark Forest</span>
                <span className="theme-sub">Moss · lichen</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'darkcherry' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'darkcherry' })}
              >
                <span className="theme-swatch darkcherry" />
                <span>Dark Cherry</span>
                <span className="theme-sub">Wine · cherry-red</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'ocean' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'ocean' })}
              >
                <span className="theme-swatch ocean" />
                <span>Deep Ocean</span>
                <span className="theme-sub">Abyss · aqua</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'light' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'light' })}
              >
                <span className="theme-swatch light" />
                <span>Warm Tavern</span>
                <span className="theme-sub">Parchment · oak</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'cherry' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'cherry' })}
              >
                <span className="theme-swatch cherry" />
                <span>Cherry Blossom</span>
                <span className="theme-sub">Petal · plum</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'river' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'river' })}
              >
                <span className="theme-swatch river" />
                <span>River Blue</span>
                <span className="theme-sub">Water · slate</span>
              </button>
              <button
                className={`theme-option ${settings.theme === 'meadow' ? 'active' : ''}`}
                onClick={() => onChange({ theme: 'meadow' })}
              >
                <span className="theme-swatch meadow" />
                <span>Flowery Meadow</span>
                <span className="theme-sub">Grass · bloom</span>
              </button>
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">Movement Range Marker</label>
            <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="range" min="0" max="1" step="0.05"
                value={settings.moveRangeOpacity ?? 0.55}
                onChange={e => onChange({ moveRangeOpacity: Number(e.target.value) })}
                style={{ flex: 1, accentColor: 'var(--gold)', cursor: 'pointer' }}
              />
              <span className="mono" style={{ width: 44, textAlign: 'right' }}>
                {Math.round((settings.moveRangeOpacity ?? 0.55) * 100)}%
              </span>
            </div>
            <div className="settings-hint">
              Opacity of the combat movement rings. Set to 0% to hide them entirely.
            </div>
          </div>

          <div className="settings-section">
            <label className="settings-label">Page Texture</label>
            <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                id="grain-toggle"
                type="checkbox"
                checked={settings.grain !== false}
                onChange={e => onChange({ grain: e.target.checked })}
                style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
              />
              <label htmlFor="grain-toggle" style={{ cursor: 'pointer', fontSize: 13 }}>
                Soft grain on menus and panels
              </label>
            </div>
            <div className="settings-hint">
              A gentle, fading film grain over menu backgrounds. Purely cosmetic.
            </div>
          </div>

          {mode === 'player' && (
            <div className="settings-section">
              <label className="settings-label">Sickness Effects</label>
              <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="sickness-effects-toggle"
                  type="checkbox"
                  checked={settings.sicknessEffects !== false}
                  onChange={e => onChange({ sicknessEffects: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
                />
                <label htmlFor="sickness-effects-toggle" style={{ cursor: 'pointer', fontSize: 13 }}>
                  Screen wobble &amp; vignette when your character is sluggish or sick
                </label>
              </div>
              <div className="settings-hint">
                Disable if you find the motion distracting or experience motion sensitivity.
              </div>
            </div>
          )}
          </>)}

          {tab === 'gameplay' && (<>
          {mode === 'dm' && (
            <div className="settings-section">
              <label className="settings-label">Map Scale <span className="settings-label-sub">- how large the map feels relative to tokens</span></label>
              <div className="scale-row">
                <button className="btn sm" onClick={() => onMapScaleChange(Math.max(0.3, (mapScale || 1) - 0.1))}>−</button>
                <input type="range" min="0.3" max="3" step="0.05"
                  value={mapScale || 1}
                  onChange={(e) => onMapScaleChange(Number(e.target.value))} />
                <button className="btn sm" onClick={() => onMapScaleChange(Math.min(3, (mapScale || 1) + 0.1))}>+</button>
                <span className="mono scale-value">{((mapScale || 1) * 100).toFixed(0)}%</span>
                <button className="btn sm ghost" onClick={() => onMapScaleChange(1)}>Reset</button>
              </div>
              <div className="settings-hint">
                Scales the entire map rendering uniformly. Pan/zoom still works on top.
              </div>
            </div>
          )}

          {mode === 'dm' && (
            <div className="settings-section">
              <label className="settings-label">Player HP Display</label>
              <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="obfuscate-hp-toggle"
                  type="checkbox"
                  checked={settings.obfuscateHp === true}
                  onChange={e => onChange({ obfuscateHp: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
                />
                <label htmlFor="obfuscate-hp-toggle" style={{ cursor: 'pointer', fontSize: 13 }}>
                  Hide exact HP from players
                </label>
              </div>
              <div className="settings-hint">
                Players see <em>Strong / Rough / Waning / Down</em> instead of numbers. You still see exact values.
              </div>
            </div>
          )}

          {mode === 'dm' && (
            <div className="settings-section">
              <label className="settings-label">New Players</label>
              <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <input
                  id="approve-players-toggle"
                  type="checkbox"
                  checked={settings.approveNewPlayers === true}
                  onChange={e => onChange({ approveNewPlayers: e.target.checked })}
                  style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
                />
                <label htmlFor="approve-players-toggle" style={{ cursor: 'pointer', fontSize: 13 }}>
                  Approve each new player before they can join
                </label>
              </div>
              <div className="settings-hint">
                New arrivals wait on a "waiting to be admitted" screen until you accept them. Reconnecting players who already have a character skip the gate.
              </div>
            </div>
          )}

          <div className="settings-section" style={mode === 'dm' ? {} : { display: 'none' }}>
            <label className="settings-label">Physical Dice</label>
            <div className="toggle-row" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                id="physical-dice-toggle"
                type="checkbox"
                checked={settings.physicalDice === true}
                onChange={e => onChange({ physicalDice: e.target.checked })}
                style={{ width: 16, height: 16, accentColor: 'var(--gold)', cursor: 'pointer' }}
              />
              <label htmlFor="physical-dice-toggle" style={{ cursor: 'pointer', fontSize: 13 }}>
                Let the table enter real-life dice results instead of auto-rolling
              </label>
            </div>
            <div className="settings-hint">
              When on, everyone's attacks and saving throws let them type the numbers they rolled at the table. Only you (the DM) can turn this on; players follow this setting automatically.
            </div>
          </div>
          </>)}

          <div className="settings-section">
            <div className="settings-hint" style={{ fontStyle: 'italic', color: 'var(--ink-mute)' }}>
              Preferences are stored on this device only.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// LIVE INPUT  (v4 fix #6)
// ====================================================================
// Controlled input whose draft value is local while the user is typing,
// and only commits to the parent on blur or Enter. Fixes the "mid-typing
// state snaps back" bug on the player sheet - when the DM re-broadcasts
// state on every keystroke, the original input's `value={entity.x}`
// would overwrite the user's in-progress typing.
//
// Usage:
//   <LiveInput value={entity.name} onCommit={v => setField({ name: v })} />
//   <LiveNumberInput value={entity.ac} onCommit={v => setField({ ac: v })} min={0} max={30} />
//
// `value` is only read from props when the input is NOT focused, so server
// updates during typing are ignored until the user leaves the field.
function LiveInput({ value, onCommit, className, placeholder, type = 'text', style }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  // Sync from props when the external value changes AND the user isn't
  // editing right now (otherwise we'd overwrite their in-progress input).
  useEffect(() => {
    if (!focused) setDraft(value ?? '');
  }, [value, focused]);
  const commit = () => {
    const next = draft;
    if (next === (value ?? '')) return; // no-op
    onCommit?.(next);
  };
  return (
    <input
      type={type}
      className={className}
      placeholder={placeholder}
      style={style}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.stopPropagation(); setDraft(value ?? ''); e.currentTarget.blur(); }
      }}
    />
  );
}

// Same pattern but coerces to number, clamps, and commits a numeric value.
function LiveNumberInput({ value, onCommit, className, min, max, step = 1, style }) {
  const [draft, setDraft] = useState(String(value ?? 0));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(String(value ?? 0));
  }, [value, focused]);
  const commit = () => {
    let n = Number(draft);
    if (!isFinite(n)) n = Number(value) || 0;
    if (typeof min === 'number') n = Math.max(min, n);
    if (typeof max === 'number') n = Math.min(max, n);
    // Re-normalize the draft to what we actually committed (handles "5x" → 5)
    setDraft(String(n));
    if (n === Number(value)) return;
    onCommit?.(n);
  };
  return (
    <input
      type="number"
      className={className}
      style={style}
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); }
        if (e.key === 'Escape') { e.stopPropagation(); setDraft(String(value ?? 0)); e.currentTarget.blur(); }
      }}
    />
  );
}

// v7.8 QoL: close a modal/overlay on Escape. Skipped while a text field is
// focused so the field's own Escape (revert/blur) wins first; press Escape
// again (focus now off the field) to dismiss the modal. `active` lets callers
// that live in an always-mounted parent gate the listener to when it's open.
function useEscClose(onClose, active = true) {
  useEffect(() => {
    if (!active || !onClose) return;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, active]);
}

// Same draft-on-focus pattern for multi-line fields. Enter inserts a newline
// (native textarea behavior); commit happens only on blur.
function LiveTextarea({ value, onCommit, placeholder, style, rows }) {
  const [draft, setDraft] = useState(value ?? '');
  const [focused, setFocused] = useState(false);
  const ref = useRef(null);
  const resize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.max(el.scrollHeight + 2, 64) + 'px';
  };
  useEffect(() => {
    if (!focused) setDraft(value ?? '');
  }, [value, focused]);
  useEffect(() => { resize(); }, [draft]);
  const commit = () => {
    if (draft === (value ?? '')) return;
    onCommit?.(draft);
  };
  return (
    <textarea
      ref={ref}
      rows={rows}
      style={{ overflow: 'hidden', resize: 'none', ...style }}
      placeholder={placeholder}
      value={draft}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(); }}
      onChange={(e) => setDraft(e.target.value)}
      onInput={resize}
    />
  );
}

// ====================================================================
// USE DRAGGABLE  (v5 fix #2)
// ====================================================================
// Makes a floating panel (`.float-panel`) draggable by its header
// (`.float-panel-header`). Pass in the ref to the panel root.
//
// Behavior:
//  - Pointer-down on the header grabs the panel.
//  - Pointer-move updates a local offset state, applied via inline
//    transform so React doesn't fight the position.
//  - Pointer-up ends the drag.
//  - Drags on interactive children of the header (buttons, inputs)
//    are ignored so close buttons still work.
//  - Clamps so the header stays partially inside the viewport - you
//    can't fling a panel off the screen and lose it.
//
// Each panel instance has its own drag offset, reset when unmounted.
function useDraggable(ref) {
  const [offset, setOffset] = useState({ dx: 0, dy: 0 });
  const dragState = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const header = el.querySelector('.float-panel-header');
    if (!header) return;

    const onPointerDown = (e) => {
      // Only left-button drags. Ignore drags starting on interactive
      // children (buttons, inputs) so they still fire clicks.
      if (e.button !== 0) return;
      const target = e.target;
      if (target.closest('button, input, select, textarea, a, .close-x')) return;
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        baseDx: offset.dx,
        baseDy: offset.dy,
      };
      header.setPointerCapture?.(e.pointerId);
      header.classList.add('dragging');
      e.preventDefault();
    };
    const onPointerMove = (e) => {
      const s = dragState.current;
      if (!s) return;
      const rawDx = s.baseDx + (e.clientX - s.startX);
      const rawDy = s.baseDy + (e.clientY - s.startY);
      // Clamp so the header (40px tall) stays partially on screen
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const minLeft = -(rect.width - 80); // keep 80px visible on the right
      const maxLeft = vw - 80;
      const minTop = 0;                    // don't let header go above 0
      const maxTop = vh - 40;
      // Translate the raw delta back through the original rect position
      // (rect.left = original left + current dx → we clamp future left).
      const originalLeft = rect.left - s.baseDx;
      const originalTop  = rect.top  - s.baseDy;
      const newLeft = clamp(originalLeft + rawDx, minLeft, maxLeft);
      const newTop  = clamp(originalTop  + rawDy, minTop,  maxTop);
      setOffset({ dx: newLeft - originalLeft, dy: newTop - originalTop });
    };
    const onPointerUp = (e) => {
      if (!dragState.current) return;
      dragState.current = null;
      header.classList.remove('dragging');
      try { header.releasePointerCapture?.(e.pointerId); } catch {}
    };

    header.addEventListener('pointerdown', onPointerDown);
    header.addEventListener('pointermove', onPointerMove);
    header.addEventListener('pointerup', onPointerUp);
    header.addEventListener('pointercancel', onPointerUp);
    return () => {
      header.removeEventListener('pointerdown', onPointerDown);
      header.removeEventListener('pointermove', onPointerMove);
      header.removeEventListener('pointerup', onPointerUp);
      header.removeEventListener('pointercancel', onPointerUp);
    };
  }, [ref, offset.dx, offset.dy]);

  // Style applied by the caller to the panel root. We use transform
  // rather than left/top so we don't conflict with any initial
  // positioning the panel had (e.g. `right: 16px, top: 80px`).
  return {
    style: { transform: `translate(${offset.dx}px, ${offset.dy}px)` },
  };
}

// Wrapper that makes a float panel draggable automatically. Swap
// `<div className="float-panel">` for `<FloatPanel>` at the root of
// each panel component and it inherits the drag behavior.
function FloatPanel({ className = '', style, children, ...rest }) {
  const ref = useRef(null);
  const drag = useDraggable(ref);
  return (
    <div
      ref={ref}
      className={`float-panel ${className}`.trim()}
      style={{ ...style, ...drag.style }}
      {...rest}
    >
      {children}
    </div>
  );
}

// ====================================================================
// EDIT MY SHEET MODAL  (player self-service)
// ====================================================================
// Dedicated surface for a player to manage their own PC (and any
// familiars). Only HP adjustments and condition toggles are permitted;
// all writes are routed through the DM for validation.
// v7.6: a homebrew (Burrows & Badgers) equipment list players can add to
// their inventory from the character sheet's Gear tab. Each item appends a
// readable line to the free-text inventory field.
const PRESET_ITEMS = [
  // Weapons
  { cat: 'Weapons', name: 'Thorn Knife', cost: '2 gp', weight: '1 lb', desc: 'Hardened thorn blade, throwable.' },
  { cat: 'Weapons', name: 'Root Club', cost: '1 sp', weight: '2 lb', desc: 'Knotted root used as a club.' },
  { cat: 'Weapons', name: 'Fallen Branch', cost: '2 sp', weight: '8 lb', desc: 'Heavy limb used as a greatclub.' },
  { cat: 'Weapons', name: 'Bark Cleaver', cost: '5 gp', weight: '2 lb', desc: 'Light axe used for forestry work.' },
  { cat: 'Weapons', name: 'Reed Spear', cost: '1 gp', weight: '3 lb', desc: 'Flexible spear made from giant reeds.' },
  { cat: 'Weapons', name: 'Nutcracker Hammer', cost: '2 gp', weight: '2 lb', desc: 'Small hammer used by scouts and smiths.' },
  { cat: 'Weapons', name: 'Harvest Hook', cost: '1 gp', weight: '2 lb', desc: 'Curved farming blade.' },
  { cat: 'Weapons', name: 'Vine Lash', cost: '2 gp', weight: '2 lb', desc: 'Braided vine whip.' },
  { cat: 'Weapons', name: 'Scout Sword', cost: '10 gp', weight: '2 lb', desc: 'Standard sidearm of Groveclan scouts.' },
  { cat: 'Weapons', name: 'Bannerblade', cost: '15 gp', weight: '3 lb', desc: 'Long sword carried by officers and champions.' },
  { cat: 'Weapons', name: 'Badger Axe', cost: '10 gp', weight: '4 lb', desc: 'Broad-bladed martial axe favored by badgers.' },
  { cat: 'Weapons', name: 'Briar Glaive', cost: '20 gp', weight: '6 lb', desc: 'Polearm tipped with thornsteel.' },
  { cat: 'Weapons', name: 'Root Maul', cost: '10 gp', weight: '10 lb', desc: 'Massive two-handed hammer.' },
  { cat: 'Weapons', name: 'Burr Mace', cost: '15 gp', weight: '4 lb', desc: 'Club crowned with hardened burr clusters.' },
  { cat: 'Weapons', name: 'Hazel Bow', cost: '25 gp', weight: '2 lb', desc: 'Common hunting bow.' },
  { cat: 'Weapons', name: 'Yew Longbow', cost: '50 gp', weight: '2 lb', desc: 'Military bow of exceptional range.' },
  { cat: 'Weapons', name: 'Spring Bow', cost: '25 gp', weight: '5 lb', desc: 'Castorman mechanical crossbow.' },
  { cat: 'Weapons', name: 'Reedpipe', cost: '10 gp', weight: '1 lb', desc: 'Silent dart weapon.' },
  { cat: 'Weapons', name: 'Spider Silk Net', cost: '5 gp', weight: '2 lb', desc: 'Strong net woven from giant spider silk.' },
  // Armor
  { cat: 'Armor', name: 'Moss Armor', cost: '5 gp', weight: '8 lb', desc: 'Layered moss and padding.' },
  { cat: 'Armor', name: 'Tanned Hide', cost: '10 gp', weight: '10 lb', desc: 'Standard light armor.' },
  { cat: 'Armor', name: 'Acorn Plate', cost: '45 gp', weight: '13 lb', desc: 'Reinforced shell armor made from giant acorn segments.' },
  { cat: 'Armor', name: 'Beetle Shell Harness', cost: '10 gp', weight: '12 lb', desc: 'Hardened insect carapace armor.' },
  { cat: 'Armor', name: 'Fish Scale Armor', cost: '50 gp', weight: '45 lb', desc: 'Overlapping river fish scales.' },
  { cat: 'Armor', name: 'Hazelnut Plate', cost: '400 gp', weight: '65 lb', desc: 'Heavy Harefolk military armor.' },
  { cat: 'Armor', name: 'Elder Knight Plate', cost: '1500 gp', weight: '65 lb', desc: 'Rare masterwork armor.' },
  { cat: 'Armor', name: 'Bark Shield', cost: '10 gp', weight: '6 lb', desc: 'Shield carved from spirit oak bark.' },
  // Adventuring Gear
  { cat: 'Gear', name: "Forager's Pack", cost: '2 gp', weight: '5 lb', desc: 'Backpack with many pouches.' },
  { cat: 'Gear', name: 'Moss Roll', cost: '1 gp', weight: '5 lb', desc: 'Waterproof sleeping roll.' },
  { cat: 'Gear', name: 'Acorn Flask', cost: '2 sp', weight: '2 lb', desc: 'Holds water or nectar.' },
  { cat: 'Gear', name: 'Resin Torch', cost: '1 cp', weight: '1 lb', desc: 'Burns for 1 hour.' },
  { cat: 'Gear', name: 'Glowbug Lantern', cost: '5 gp', weight: '2 lb', desc: 'Lantern containing captive glow beetles.' },
  { cat: 'Gear', name: 'Sunflower Oil Flask', cost: '1 sp', weight: '1 lb', desc: 'Fuel for lamps and lanterns.' },
  { cat: 'Gear', name: 'Spider Silk Rope (50 ft)', cost: '2 gp', weight: '5 lb', desc: 'Lightweight climbing rope.' },
  { cat: 'Gear', name: 'Climbing Claw', cost: '2 gp', weight: '3 lb', desc: 'Hooked climbing tool.' },
  { cat: 'Gear', name: 'Root Prybar', cost: '2 gp', weight: '5 lb', desc: 'Used for opening roots and doors.' },
  { cat: 'Gear', name: 'Leaf Shelter', cost: '2 gp', weight: '15 lb', desc: 'One-person field shelter.' },
  { cat: 'Gear', name: "Herbalist's Satchel", cost: '5 gp', weight: '3 lb', desc: 'Used to stabilize and treat wounds.' },
  { cat: 'Gear', name: "Scout's Horn", cost: '3 gp', weight: '2 lb', desc: 'Signal instrument for patrols.' },
  { cat: 'Gear', name: 'Memory Thread Bundle', cost: '1 gp', weight: '1 lb', desc: 'Colored thread used for records and messages.' },
  // Consumables
  { cat: 'Consumables', name: 'Rootbread Loaf', cost: '2 cp', weight: '0.5 lb', desc: 'Dense bread made from root flour.' },
  { cat: 'Consumables', name: 'Hard Cheese', cost: '1 sp', weight: '1 lb', desc: 'Preserved travel food.' },
  { cat: 'Consumables', name: 'Smoked Fish', cost: '3 sp', weight: '1 lb', desc: 'Common preserved protein.' },
  { cat: 'Consumables', name: 'Roasted Sunflower Seeds', cost: '5 cp', weight: '1 lb', desc: 'Staple snack of the grasslands.' },
  { cat: 'Consumables', name: 'Ant Mead (Mug)', cost: '4 cp', weight: '1 lb', desc: 'Sweet alcoholic drink from Dexter ant farms.' },
  { cat: 'Consumables', name: 'Ant Mead (Jug)', cost: '2 sp', weight: '8 lb', desc: 'Common bulk supply.' },
  { cat: 'Consumables', name: 'Berry Wine', cost: '2 sp', weight: '3 lb', desc: 'Everyday wine.' },
  { cat: 'Consumables', name: 'Moonberry Reserve', cost: '10 gp', weight: '3 lb', desc: 'Premium vintage wine.' },
  { cat: 'Consumables', name: 'Scout Rations (1 Day)', cost: '5 sp', weight: '2 lb', desc: 'Dried roots, seeds and smoked fish.' },
  // Medicines & Alchemy
  { cat: 'Medicine', name: 'Golden Sap Elixir', cost: '50 gp', weight: '0.5 lb', desc: 'Restores 2d4+2 hit points.' },
  { cat: 'Medicine', name: 'Blessed Springwater', cost: '25 gp', weight: '1 lb', desc: 'Consecrated water used against spirits and corruption.' },
  { cat: 'Medicine', name: 'Talpa Antidote', cost: '50 gp', weight: '0.5 lb', desc: 'Grants advantage against poison for 1 hour.' },
  { cat: 'Medicine', name: 'Glowcap Poultice', cost: '15 gp', weight: '0.5 lb', desc: 'Removes one level of exhaustion after a rest.' },
  { cat: 'Medicine', name: 'Spore Suppressant', cost: '20 gp', weight: '0.5 lb', desc: 'Protects against fungal spores for 8 hours.' },
  { cat: 'Medicine', name: 'Briarthorn Salve', cost: '5 gp', weight: '0.5 lb', desc: 'Heals cuts and thorn wounds.' },
  // Cultural - Groveclans
  { cat: 'Groveclans', name: 'Banner Needle', cost: '5 sp', weight: '0.2 lb', desc: 'Ceremonial stitching needle.' },
  { cat: 'Groveclans', name: 'Family Patch', cost: 'Priceless', weight: 'Negligible', desc: 'Embroidered family insignia.' },
  { cat: 'Groveclans', name: 'Scout Harness', cost: '3 gp', weight: '2 lb', desc: 'Climbing gear for canopy travel.' },
  // Cultural - Harefolk
  { cat: 'Harefolk', name: 'Hazelnut Helmet', cost: '8 gp', weight: '4 lb', desc: 'Hardened nut-shell military helmet.' },
  { cat: 'Harefolk', name: "Watchman's Horn", cost: '3 gp', weight: '2 lb', desc: 'Used to sound alarms.' },
  { cat: 'Harefolk', name: 'Boundary Marker Kit', cost: '1 gp', weight: '5 lb', desc: 'Used to mark roads and borders.' },
  // Cultural - Castormen
  { cat: 'Castormen', name: 'Gear Key Set', cost: '10 gp', weight: '3 lb', desc: 'Tools for maintaining machinery.' },
  { cat: 'Castormen', name: 'Pressure Gauge', cost: '15 gp', weight: '2 lb', desc: 'Measures hydraulic pressure.' },
  { cat: 'Castormen', name: "Surveyor's Wheel", cost: '5 gp', weight: '4 lb', desc: 'Measures distance and terrain.' },
  // Cultural - Otterfolk
  { cat: 'Otterfolk', name: 'Pearl Knife', cost: '4 gp', weight: '1 lb', desc: 'Utility knife used by oyster farmers.' },
  { cat: 'Otterfolk', name: 'Oyster Hook', cost: '2 gp', weight: '2 lb', desc: 'Harvesting tool for oyster beds.' },
  { cat: 'Otterfolk', name: 'Tide Compass', cost: '20 gp', weight: '1 lb', desc: 'Navigation aid used by seafarers.' },
  // Cultural - Desmanfolk
  { cat: 'Desmanfolk', name: 'Spore Mask', cost: '8 gp', weight: '1 lb', desc: 'Protects against fungal spores.' },
  { cat: 'Desmanfolk', name: 'Mycelial Tablet', cost: '25 gp', weight: '2 lb', desc: 'Living fungal record medium.' },
  { cat: 'Desmanfolk', name: 'Fungus Cultivation Box', cost: '10 gp', weight: '5 lb', desc: 'Portable fungal garden.' },
  // Cultural - Ravenfolk
  { cat: 'Ravenfolk', name: 'Rune Chalk', cost: '5 gp', weight: '0.5 lb', desc: 'Used to draw protective symbols.' },
  { cat: 'Ravenfolk', name: 'Spirit Bell', cost: '15 gp', weight: '1 lb', desc: 'Chimes when spirits are near.' },
  { cat: 'Ravenfolk', name: 'Blackfeather Cloak', cost: '12 gp', weight: '3 lb', desc: 'Traditional Ravenfolk cloak.' },
  // Mounts & Beasts
  { cat: 'Mounts', name: 'Pack Beetle', cost: '8 gp', weight: '-', desc: 'Carries up to 200 lbs of cargo.' },
  { cat: 'Mounts', name: 'Rhinoceros Beetle', cost: '75 gp', weight: '-', desc: 'Armored war mount.' },
  { cat: 'Mounts', name: 'Forest Gecko', cost: '50 gp', weight: '-', desc: 'Agile climbing mount.' },
  { cat: 'Mounts', name: 'Marsh Gecko', cost: '50 gp', weight: '-', desc: 'Swamp-adapted riding animal.' },
  { cat: 'Mounts', name: 'Messenger Crow', cost: '25 gp', weight: '-', desc: 'Carries messages between settlements.' },
  { cat: 'Mounts', name: 'Ant Queen (Young)', cost: '200 gp', weight: '-', desc: 'Extremely valuable Dexter livestock.' },
];

// v7.6: collapsible picker that appends a preset item to the inventory text.
function InventoryItemPicker({ onAdd }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [cat, setCat] = useState('All');
  const cats = useMemo(() => ['All', ...Array.from(new Set(PRESET_ITEMS.map(i => i.cat)))], []);
  const items = useMemo(() => {
    const query = q.trim().toLowerCase();
    return PRESET_ITEMS.filter(i =>
      (cat === 'All' || i.cat === cat) &&
      (!query || i.name.toLowerCase().includes(query) || i.desc.toLowerCase().includes(query))
    );
  }, [q, cat]);
  return (
    <div className="csheet-block">
      <button type="button" className={`item-picker-toggle ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)}>
        <span className="item-picker-chevron">{open ? '▾' : '▸'}</span>
        Add item from list
        <span className="item-picker-count">{PRESET_ITEMS.length}</span>
      </button>
      {open && (
        <div className="item-picker">
          <div className="item-picker-controls">
            <input className="item-picker-search" placeholder="Search items…" value={q} onChange={e => setQ(e.target.value)} />
            <select className="item-picker-cat" value={cat} onChange={e => setCat(e.target.value)}>
              {cats.map(c => <option key={c} value={c}>{c === 'All' ? 'All categories' : c}</option>)}
            </select>
          </div>
          <div className="item-picker-list">
            {items.length === 0 ? (
              <div className="item-picker-empty">No matching items.</div>
            ) : items.map((i, idx) => (
              <div key={idx} className="item-picker-row">
                <div className="item-picker-info">
                  <div className="item-picker-name">
                    {i.name}
                    <span className="item-picker-meta">{i.cost}{i.weight && i.weight !== '-' ? ` · ${i.weight}` : ''}</span>
                  </div>
                  <div className="item-picker-desc">{i.desc}</div>
                </div>
                <button type="button" className="item-picker-add" title={`Add ${i.name} to inventory`} onClick={() => onAdd(i)}>＋</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// v7.6: the classic D&D character classes, offered as a dropdown on the
// sheet. A free-text "Other / homebrew…" escape hatch keeps custom and
// multiclass values (e.g. "Ranger 3 / Cleric 1") working.
const DND_CLASSES = [
  'Barbarian', 'Bard', 'Cleric', 'Druid', 'Fighter', 'Monk',
  'Paladin', 'Ranger', 'Rogue', 'Sorcerer', 'Warlock', 'Wizard',
];
// v7.6: ability-score rolling (4d6 drop lowest) and standard D&D class hit
// dice, used by the player-built new-character flow.
const ABILITY_KEYS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
function rollAbilityScore() {
  const rolls = Array.from({ length: 4 }, () => 1 + Math.floor(Math.random() * 6));
  rolls.sort((a, b) => a - b);
  return rolls[1] + rolls[2] + rolls[3]; // sum the highest three, drop the lowest
}
function rollAbilitySet() {
  const s = {};
  for (const k of ABILITY_KEYS) s[k] = rollAbilityScore();
  return s;
}
const CLASS_HIT_DIE = {
  Barbarian: 12,
  Fighter: 10, Paladin: 10, Ranger: 10,
  Bard: 8, Cleric: 8, Druid: 8, Monk: 8, Rogue: 8, Warlock: 8,
  Sorcerer: 6, Wizard: 6,
};
const abilityMod = (score) => Math.floor((Number(score || 10) - 10) / 2);
// v7.8: standard 5e races. speed (ft), size, a suggested height, and a short
// note of the race's signature bonuses (informational on the sheet).
const DND_RACES = [
  { name: 'Dragonborn', speed: 30, size: 'Medium', height: "5'10\"-6'8\"", bonus: 'Breath weapon, damage resistance by ancestry' },
  { name: 'Dwarf', speed: 25, size: 'Medium', height: "4'0\"-5'0\"", bonus: 'Darkvision, poison resilience, stonecunning' },
  { name: 'Elf', speed: 30, size: 'Medium', height: "5'0\"-6'6\"", bonus: 'Darkvision, Fey Ancestry, Trance, keen senses' },
  { name: 'Gnome', speed: 25, size: 'Small', height: "3'0\"-4'0\"", bonus: 'Darkvision, Gnome Cunning (INT/WIS/CHA saves vs magic)' },
  { name: 'Half-Elf', speed: 30, size: 'Medium', height: "5'0\"-6'2\"", bonus: 'Darkvision, Fey Ancestry, two extra skills' },
  { name: 'Half-Orc', speed: 30, size: 'Medium', height: "5'4\"-6'10\"", bonus: 'Darkvision, Relentless Endurance, Savage Attacks' },
  { name: 'Halfling', speed: 25, size: 'Small', height: "2'7\"-3'5\"", bonus: 'Lucky, Brave, Halfling Nimbleness' },
  { name: 'Human', speed: 30, size: 'Medium', height: "4'8\"-6'2\"", bonus: 'Versatile - +1 to all scores (or a feat, variant)' },
  { name: 'Tiefling', speed: 30, size: 'Medium', height: "5'0\"-6'2\"", bonus: 'Darkvision, Hellish Resistance (fire), innate magic' },
];
// v7.8: per-class level-1 info, transcribed for the class-selection phase.
const CLASS_INFO = {
  Barbarian: { primary: 'STR', saves: 'STR & CON', skills: 'Choose 2: Animal Handling, Athletics, Intimidation, Nature, Perception, Survival', weapons: 'Simple & Martial', tools: 'None', armor: 'Light & Medium armor, Shields', equipment: 'A: Greataxe, 4 Handaxes, Explorer’s Pack, 15 GP  •  B: 75 GP' },
  Bard: { primary: 'CHA', saves: 'DEX & CHA', skills: 'Choose any 3 skills', weapons: 'Simple', tools: 'None', armor: 'Light armor', equipment: 'A: Leather Armor, 2 Daggers, a Musical Instrument, Entertainer’s Pack, 19 GP  •  B: 90 GP' },
  Cleric: { primary: 'WIS', saves: 'WIS & CHA', skills: 'Choose 2: History, Insight, Medicine, Persuasion, Religion', weapons: 'Simple', tools: 'None', armor: 'Light & Medium armor, Shields', equipment: 'A: Chain Shirt, Shield, Mace, Holy Symbol, Priest’s Pack  •  B: 110 GP' },
  Druid: { primary: 'WIS', saves: 'INT & WIS', skills: 'Choose 2: Animal Handling, Arcana, Insight, Medicine, Nature, Perception, Religion, Survival', weapons: 'Simple', tools: 'Herbalism Kit', armor: 'Light armor, Shield', equipment: 'A: Leather Armor, Shield, Sickle, Druidic Focus (Quarterstaff), Explorer’s Pack, Herbalism Kit, 9 GP  •  B: 50 GP' },
  Fighter: { primary: 'STR or DEX', saves: 'STR & CON', skills: 'Choose 2: Acrobatics, Animal Handling, Athletics, History, Insight, Intimidation, Persuasion, Perception, Survival', weapons: 'Simple & Martial', tools: 'None', armor: 'Light, Medium & Heavy armor, Shields', equipment: 'A: Chain Mail, Greatsword, Flail, 8 Javelins, Dungeoneer’s Pack, 4 GP  •  B: Studded Leather, Scimitar, Shortsword, Longbow, 20 Arrows, Quiver, Dungeoneer’s Pack, 11 GP  •  C: 155 GP' },
  Monk: { primary: 'DEX & WIS', saves: 'STR & DEX', skills: 'Choose 2: Acrobatics, Athletics, History, Insight, Religion, Stealth', weapons: 'Simple & Martial weapons with the Light property', tools: 'One Artisan’s Tools or Musical Instrument', armor: 'None', equipment: 'A: Spear, 5 Daggers, Artisan’s Tools or Instrument, Explorer’s Pack, 11 GP  •  B: 50 GP' },
  Paladin: { primary: 'STR & CHA', saves: 'WIS & CHA', skills: 'Choose 2: Athletics, Insight, Intimidation, Medicine, Persuasion, Religion', weapons: 'Simple & Martial', tools: 'None', armor: 'Light, Medium & Heavy armor, Shields', equipment: 'A: Chain Mail, Shield, Longsword, 6 Javelins, Holy Symbol, Priest’s Pack  •  B: 150 GP' },
  Ranger: { primary: 'DEX & WIS', saves: 'STR & DEX', skills: 'Choose 3: Animal Handling, Athletics, Insight, Investigation, Nature, Perception, Stealth, Survival', weapons: 'Simple & Martial', tools: 'None', armor: 'Light & Medium armor, Shields', equipment: 'A: Studded Leather, Scimitar, Shortsword, Longbow, 20 Arrows, Quiver, Druidic Focus (Sprig of Mistletoe), Explorer’s Pack, 7 GP  •  B: 150 GP' },
  Rogue: { primary: 'DEX', saves: 'DEX & INT', skills: 'Choose 4: Acrobatics, Athletics, Deception, Insight, Intimidation, Investigation, Perception, Persuasion, Sleight of Hand, Stealth', weapons: 'Simple & Martial weapons with Finesse or Light', tools: 'Thieves’ Tools', armor: 'Light armor', equipment: 'A: Leather Armor, 2 Daggers, Shortsword, Shortbow, 20 Arrows, Quiver, Thieves’ Tools, Burglar’s Pack, 8 GP  •  B: 100 GP' },
  Sorcerer: { primary: 'CHA', saves: 'CON & CHA', skills: 'Choose 2: Arcana, Deception, Insight, Intimidation, Persuasion, Religion', weapons: 'Simple', tools: 'None', armor: 'None', equipment: 'A: Spear, 2 Daggers, Arcane Focus (crystal), Dungeoneer’s Pack, 28 GP  •  B: 50 GP' },
  Warlock: { primary: 'CHA', saves: 'WIS & CHA', skills: 'Choose 2: Arcana, Deception, History, Intimidation, Investigation, Nature, Religion', weapons: 'Simple', tools: 'None', armor: 'Light armor', equipment: 'A: Leather Armor, Sickle, 2 Daggers, Arcane Focus (orb), Book (occult lore), Scholar’s Pack, 15 GP  •  B: 100 GP' },
  Wizard: { primary: 'INT', saves: 'INT & WIS', skills: 'Choose 2: Arcana, History, Insight, Investigation, Medicine, Nature, Religion', weapons: 'Simple', tools: 'None', armor: 'None', equipment: 'A: 2 Daggers, Arcane Focus (Quarterstaff), Robe, Spellbook, Scholar’s Pack, 5 GP  •  B: 55 GP' },
};
// v7.8: roll one hit die (d-sided) for level-up HP.
function rollHitDie(sides) { return 1 + Math.floor(Math.random() * sides); }
// Standard level-1 HP: max hit die + CON modifier. Returns null for an
// unknown/custom class so callers can keep the 10/10 default.
function level1HpForClass(cls, conScore) {
  const die = CLASS_HIT_DIE[cls];
  if (!die) return null;
  return Math.max(1, die + abilityMod(conScore));
}
function ClassSelect({ value, onCommit, className }) {
  const v = value || '';
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="class-select-wrap">
        <LiveInput value={v} onCommit={onCommit} placeholder="Type a class…" />
        <button type="button" className="class-select-toggle" title="Choose from the list" onClick={() => setEditing(false)}>▾</button>
      </div>
    );
  }
  const known = DND_CLASSES.includes(v);
  return (
    <select className={`class-select ${className || ''}`} value={v}
      onChange={(e) => { const nv = e.target.value; if (nv === '__other') setEditing(true); else onCommit(nv); }}>
      <option value="">- Class -</option>
      {v && !known && <option value={v}>{v}</option>}
      {DND_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
      <option value="__other">✎ Other / homebrew…</option>
    </select>
  );
}

// v7.8: race picker mirroring ClassSelect - the standard 5e races plus a
// homebrew text option. Preserves an existing custom value as its own option.
function RaceSelect({ value, onCommit, className }) {
  const v = value || '';
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <div className="class-select-wrap">
        <LiveInput value={v} onCommit={onCommit} placeholder="Type a race…" />
        <button type="button" className="class-select-toggle" title="Choose from the list" onClick={() => setEditing(false)}>▾</button>
      </div>
    );
  }
  const names = DND_RACES.map(r => r.name);
  const known = names.includes(v);
  return (
    <select className={`class-select ${className || ''}`} value={v}
      onChange={(e) => { const nv = e.target.value; if (nv === '__other') setEditing(true); else onCommit(nv); }}>
      <option value="">- Race -</option>
      {v && !known && <option value={v}>{v}</option>}
      {names.map(c => <option key={c} value={c}>{c}</option>)}
      <option value="__other">✎ Other / homebrew…</option>
    </select>
  );
}

// v7.8: a single hit-die roll for a level-up (animated), used in the player
// sheet after the DM approves a +1 level. Calls onResult(roll) once.
function LevelUpHpRoller({ die, conMod, onResult }) {
  const [face, setFace] = useState(null);
  const [rolling, setRolling] = useState(false);
  const [done, setDone] = useState(false);
  const cyc = useRef(null); const tmr = useRef([]);
  useEffect(() => () => { clearInterval(cyc.current); tmr.current.forEach(clearTimeout); }, []);
  const go = () => {
    if (rolling || done) return;
    setRolling(true);
    const roll = rollHitDie(die);
    cyc.current = setInterval(() => setFace(1 + Math.floor(Math.random() * die)), 70);
    tmr.current.push(setTimeout(() => { clearInterval(cyc.current); setFace(roll); }, 1100));
    tmr.current.push(setTimeout(() => { setDone(true); setRolling(false); onResult(roll); }, 1700));
  };
  return (
    <div className="hp-roller">
      {done ? (
        <div className="hp-final">Rolled <b>{face}</b> {conMod >= 0 ? '+' : ''}{conMod} CON = <b>+{Math.max(1, face + conMod)}</b> HP</div>
      ) : (
        <>
          <button className="btn primary sm" onClick={go} disabled={rolling}>{rolling ? 'Rolling…' : `🎲 Roll d${die} for your new level`}</button>
          {face != null && <div className="hp-cur">{face}</div>}
        </>
      )}
    </div>
  );
}

// v7.6: a full, prettier D&D character sheet, shared by the player's
// "My Sheet" and the DM's sheet view. All writes go through onField /
// onHpAdjust / onToggleCondition so each caller can route them correctly
// (players → DM-authoritative path; DM → direct dispatch).
// v7.9: structured weapons. A weapon has one or more named attacks; each attack
// has a to-hit bonus, a range, and one or more damage components (count dN +mod
// of a damage type). Helpers below format an attack into the familiar shorthand
// "+X to hit; Y ft. range; ZdA +B TYPE damage and ...".
function formatDamageComp(c) {
  const dice = `${c.count || 0}d${c.sides || 6}`;
  const mod = c.modifier ? (c.modifier > 0 ? ` +${c.modifier}` : ` ${c.modifier}`) : '';
  return `${dice}${mod}${c.type ? ' ' + String(c.type).toLowerCase() : ''}`;
}
function formatAttack(a) {
  const dmg = (a.damage || []).map(formatDamageComp).join(' and ');
  let s = `+${a.toHit || 0} to hit; ${a.range || 0} ft. range; ${dmg || '-'} damage`;
  if (a.effect && a.effect.condition) {
    s += a.effect.save ? `; ${a.effect.condition} (${a.effect.save.ability} save DC ${a.effect.save.dc})` : `; ${a.effect.condition} on hit`;
  }
  return s;
}
function newWeaponComp() { return { count: 1, sides: 6, modifier: 0, type: 'Slashing' }; }
function newWeaponAttack() { return { id: uid('atk_'), name: 'Strike', toHit: 0, range: 5, damage: [newWeaponComp()] }; }

// v8.3: special interactions a creature can attempt. Each is a no-damage
// contest: the target makes the named save (DC editable) or suffers the effect.
// Melee maneuvers are gated by range like weapon attacks during combat.
const MANEUVER_PRESETS = [
  { key: 'grapple', label: 'Grapple', condition: 'Grappled',   ability: 'STR', dc: 13, range: 5, icon: '🤼', contest: true },
  { key: 'shove',   label: 'Shove',   condition: 'Prone',      ability: 'STR', dc: 13, range: 5, icon: '👊', contest: true },
  { key: 'push',    label: 'Push',    condition: '',           ability: 'STR', dc: 13, range: 5, icon: '💪', contest: true },
  { key: 'trip',    label: 'Trip',    condition: 'Prone',      ability: 'DEX', dc: 13, range: 5, icon: '🦵', contest: true },
  { key: 'frighten',label: 'Frighten',condition: 'Frightened', ability: 'WIS', dc: 13, range: 30, icon: '😱', contest: false },
  { key: 'restrain',label: 'Restrain',condition: 'Restrained', ability: 'STR', dc: 13, range: 5, icon: '🕸', contest: true },
];

// v7.9: a catalog of ready-made weapons. Picking one inserts a fully statted
// weapon the player can then tweak (set the to-hit, add a fire rider, etc.).
const WEAPON_PRESETS = [
  { name: 'Dagger',         hands: 1, finesse: true,  atk: { name: 'Stab',   range: 5,   dmg: [[1, 4, 0, 'Piercing']] } },
  { name: 'Club',           hands: 1,                 atk: { name: 'Bash',   range: 5,   dmg: [[1, 4, 0, 'Bludgeoning']] } },
  { name: 'Handaxe',        hands: 1,                 atk: { name: 'Chop',   range: 5,   dmg: [[1, 6, 0, 'Slashing']] } },
  { name: 'Shortsword',     hands: 1, finesse: true,  atk: { name: 'Thrust', range: 5,   dmg: [[1, 6, 0, 'Piercing']] } },
  { name: 'Mace',           hands: 1,                 atk: { name: 'Swing',  range: 5,   dmg: [[1, 6, 0, 'Bludgeoning']] } },
  { name: 'Spear',          hands: 1,                 atk: { name: 'Jab',    range: 5,   dmg: [[1, 6, 0, 'Piercing']] } },
  { name: 'Quarterstaff',   hands: 1,                 atk: { name: 'Strike', range: 5,   dmg: [[1, 6, 0, 'Bludgeoning']] } },
  { name: 'Rapier',         hands: 1, finesse: true,  atk: { name: 'Lunge',  range: 5,   dmg: [[1, 8, 0, 'Piercing']] } },
  { name: 'Longsword',      hands: 1,                 atk: { name: 'Slash',  range: 5,   dmg: [[1, 8, 0, 'Slashing']] } },
  { name: 'Battleaxe',      hands: 1,                 atk: { name: 'Cleave', range: 5,   dmg: [[1, 8, 0, 'Slashing']] } },
  { name: 'Warhammer',      hands: 1,                 atk: { name: 'Smash',  range: 5,   dmg: [[1, 8, 0, 'Bludgeoning']] } },
  { name: 'Greatsword',     hands: 2,                 atk: { name: 'Hew',    range: 5,   dmg: [[2, 6, 0, 'Slashing']] } },
  { name: 'Greataxe',       hands: 2,                 atk: { name: 'Cleave', range: 5,   dmg: [[1, 12, 0, 'Slashing']] } },
  { name: 'Maul',           hands: 2,                 atk: { name: 'Crush',  range: 5,   dmg: [[2, 6, 0, 'Bludgeoning']] } },
  { name: 'Halberd',        hands: 2,                 atk: { name: 'Reach',  range: 10,  dmg: [[1, 10, 0, 'Slashing']] } },
  { name: 'Shortbow',       hands: 2, ranged: true,   atk: { name: 'Shoot',  range: 80,  dmg: [[1, 6, 0, 'Piercing']] } },
  { name: 'Longbow',        hands: 2, ranged: true,   atk: { name: 'Shoot',  range: 150, dmg: [[1, 8, 0, 'Piercing']] } },
  { name: 'Light Crossbow', hands: 2, ranged: true,   atk: { name: 'Shoot',  range: 80,  dmg: [[1, 8, 0, 'Piercing']] } },
  { name: 'Sling',          hands: 1, ranged: true,   atk: { name: 'Sling',  range: 30,  dmg: [[1, 4, 0, 'Bludgeoning']] } },
];
// v8.8: compute a proper to-hit (proficiency + best relevant ability mod) and
// fold the ability modifier into the damage, the way a real weapon would.
function weaponFromPreset(p, entity) {
  const prof = Number(entity?.proficiencyBonus) || 2;
  const strMod = abilityMod(entity?.stats?.str ?? 10);
  const dexMod = abilityMod(entity?.stats?.dex ?? 10);
  const useDex = p.ranged || (p.finesse && dexMod > strMod);
  const aMod = entity ? (useDex ? dexMod : strMod) : 0;
  const toHit = entity ? prof + aMod : 0;
  const dmg = p.atk.dmg.map(([count, sides, modifier, type], i) => ({
    count, sides, modifier: modifier + (i === 0 ? aMod : 0), type,
  }));
  return {
    id: uid('wpn_'), name: p.name, equipped: true, hands: p.hands || 1,
    attacks: [{ id: uid('atk_'), name: p.atk.name, toHit, range: p.atk.range, damage: dmg }],
  };
}

// v8.8: armour. Final AC = baseAc + min(dexMod, dexCap). Categories gate on
// class proficiency; some armours hamper Stealth or demand raw Strength.
const ARMOR_PRESETS = [
  { name: 'Padded',          category: 'light',  baseAc: 11, dexCap: 99, stealthDis: true,  strReq: 0 },
  { name: 'Leather',         category: 'light',  baseAc: 11, dexCap: 99, stealthDis: false, strReq: 0 },
  { name: 'Studded Leather', category: 'light',  baseAc: 12, dexCap: 99, stealthDis: false, strReq: 0 },
  { name: 'Hide',            category: 'medium', baseAc: 12, dexCap: 2,  stealthDis: false, strReq: 0 },
  { name: 'Chain Shirt',     category: 'medium', baseAc: 13, dexCap: 2,  stealthDis: false, strReq: 0 },
  { name: 'Scale Mail',      category: 'medium', baseAc: 14, dexCap: 2,  stealthDis: true,  strReq: 0 },
  { name: 'Breastplate',     category: 'medium', baseAc: 14, dexCap: 2,  stealthDis: false, strReq: 0 },
  { name: 'Half Plate',      category: 'medium', baseAc: 15, dexCap: 2,  stealthDis: true,  strReq: 0 },
  { name: 'Ring Mail',       category: 'heavy',  baseAc: 14, dexCap: 0,  stealthDis: true,  strReq: 0 },
  { name: 'Chain Mail',      category: 'heavy',  baseAc: 16, dexCap: 0,  stealthDis: true,  strReq: 13 },
  { name: 'Splint',          category: 'heavy',  baseAc: 17, dexCap: 0,  stealthDis: true,  strReq: 15 },
  { name: 'Plate',           category: 'heavy',  baseAc: 18, dexCap: 0,  stealthDis: true,  strReq: 15 },
];
const SHIELD_PRESETS = [
  { name: 'Shield',       acBonus: 2, stealthDis: false, strReq: 0,  hands: 1 },
  { name: 'Tower Shield', acBonus: 3, stealthDis: true,  strReq: 13, hands: 1 },
];
// Which armour categories (and shields) a class is trained in. Non-PCs, the DM,
// or homebrew classes not in the table are treated as proficient with anything.
function armorProfsFor(entity) {
  const info = entity?.class ? CLASS_INFO[entity.class] : null;
  if (!entity || entity.type !== 'PC' || !info) return { light: true, medium: true, heavy: true, shield: true };
  const s = (info.armor || '').toLowerCase();
  return { light: s.includes('light'), medium: s.includes('medium'), heavy: s.includes('heavy'), shield: s.includes('shield') };
}
function canWearArmor(entity, armor) {
  if (!armor) return true;
  return !!armorProfsFor(entity)[armor.category];
}
function canUseShield(entity) { return !!armorProfsFor(entity).shield; }
// Final AC from equipped armour + shield + Dex. Unarmoured = 10 + Dex.
function computeArmorAc(entity) {
  const dexMod = abilityMod(entity?.stats?.dex ?? 10);
  const a = entity?.armor || null;
  let ac = a ? (a.baseAc + Math.min(dexMod, a.dexCap ?? 99)) : (10 + dexMod);
  if (entity?.shield) ac += (entity.shield.acBonus || 0);
  return ac;
}
function armorStealthDisadvantage(entity) {
  return !!(entity?.armor?.stealthDis || entity?.shield?.stealthDis);
}
// Occupied-hands accounting. Total hands are race-derived (default 2). Equipped
// weapons and a shield consume hands by their `hands` value.
function handsTotalOf(entity) { const n = Number(entity?.handsTotal); return Number.isFinite(n) && n > 0 ? n : 2; }
function occupiedHandsOf(entity) {
  let used = 0;
  for (const w of (entity?.weapons || [])) if (w.equipped) used += (Number(w.hands) || 1);
  if (entity?.shield) used += (Number(entity.shield.hands) || 1);
  return used;
}
function armorFromPreset(p) { return { ...p }; }
function shieldFromPreset(p) { return { ...p }; }

// v8.1: best-effort parse of a creature's free-text stat block into structured
// weapons, e.g. "Ferocious Bite. Melee Attack: +4 to hit - 1d8 piercing" or
// "Hooves. Melee Attack: +10 to hit, reach 5 ft. - 3d10+8 bludgeoning". Each
// matched line becomes an equipped weapon with one attack. Tolerant of hyphen,
// en-dash, em-dash or colon as the damage separator. Never throws.
function parseAttacksFromAbilities(text) {
  if (!text || typeof text !== 'string') return [];
  const out = [];
  const sep = '[\\u002d\\u2013\\u2014:]'; // hyphen / en-dash / em-dash / colon
  const re = new RegExp(
    '([A-Z][A-Za-z\'’ /-]{1,40}?)\\.\\s*(?:Melee|Ranged|Melee or Ranged)\\s+(?:Weapon\\s+)?Attack:\\s*\\+(\\d+)\\s*to hit'
    + '(?:[,;]?\\s*(?:reach|range)\\s*(\\d+)(?:/\\d+)?\\s*ft\\.?)?\\s*' + sep + '\\s*([0-9dD+ ,a-zA-Z]+)', 'g');
  const dmgRe = /(\d+)d(\d+)(?:\s*\+\s*(\d+))?\s+([a-zA-Z]+)/g;
  let m, guard = 0;
  while ((m = re.exec(text)) !== null && guard++ < 40) {
    const name = m[1].trim().replace(/\s+/g, ' ');
    const toHit = Math.min(50, parseInt(m[2]) || 0);
    const range = m[3] ? Math.min(600, parseInt(m[3]) || 5) : 5;
    const damage = [];
    let d, g2 = 0;
    dmgRe.lastIndex = 0;
    while ((d = dmgRe.exec(m[4])) !== null && g2++ < 8) {
      const type = d[4].charAt(0).toUpperCase() + d[4].slice(1).toLowerCase();
      damage.push({ count: Math.min(20, parseInt(d[1]) || 1), sides: parseInt(d[2]) || 6, modifier: d[3] ? parseInt(d[3]) : 0, type });
    }
    if (damage.length === 0) continue;
    out.push({ id: uid('wpn_'), name: name.slice(0, 40), equipped: true,
      attacks: [{ id: uid('atk_'), name: 'Attack', toHit, range, damage }] });
  }
  return out;
}

// v8.8: armour + shield manager for the gear tab. Equipping recomputes the
// entity's AC and enforces class proficiency, Strength requirements, and the
// hand budget (shields take a hand).
function ArmorManager({ entity, canEdit, onField }) {
  const armor = entity?.armor || null;
  const shield = entity?.shield || null;
  const profs = armorProfsFor(entity);
  const strScore = entity?.stats?.str ?? 10;
  const dexMod = abilityMod(entity?.stats?.dex ?? 10);

  const equipArmor = (p) => {
    if (!p) { onField({ armor: null, ac: computeArmorAc({ ...entity, armor: null }) }); return; }
    if (!profs[p.category]) { alert(`Your class is not proficient with ${p.category} armour.`); return; }
    const next = armorFromPreset(p);
    onField({ armor: next, ac: computeArmorAc({ ...entity, armor: next }) });
  };
  const equipShield = (on) => {
    if (on) {
      if (!profs.shield) { alert('Your class is not proficient with shields.'); return; }
      const free = handsTotalOf(entity) - occupiedHandsOf(entity);
      const s = shieldFromPreset(SHIELD_PRESETS[0]);
      if ((s.hands || 1) > free) { alert(`No free hand for a shield (${free} free).`); return; }
      onField({ shield: s, ac: computeArmorAc({ ...entity, shield: s }) });
    } else {
      onField({ shield: null, ac: computeArmorAc({ ...entity, shield: null }) });
    }
  };
  const setShieldPreset = (name) => {
    const p = SHIELD_PRESETS.find(x => x.name === name);
    if (!p) return;
    const s = shieldFromPreset(p);
    onField({ shield: s, ac: computeArmorAc({ ...entity, shield: s }) });
  };

  const finalAc = computeArmorAc(entity);
  const stealthDis = armorStealthDisadvantage(entity);

  if (!canEdit) {
    return (
      <div className="csheet-block">
        <label>Armour &amp; Shield</label>
        <div className="armor-ro">
          <div>Armour: <b>{armor ? armor.name : 'None'}</b>{shield ? <span> · Shield: <b>{shield.name}</b></span> : null}</div>
          <div>AC <b className="mono">{finalAc}</b>{stealthDis ? <span className="armor-warn"> · Stealth disadvantage</span> : null}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="csheet-block">
      <label>Armour &amp; Shield <span className="hands-readout" title="Resulting armour class">🛡 AC {finalAc}{stealthDis ? ' · stealth ▼' : ''}</span></label>

      <div className="armor-row">
        <span className="armor-lbl">Body</span>
        <select className="armor-select" value={armor?.name || ''} onChange={e => {
          const p = ARMOR_PRESETS.find(x => x.name === e.target.value);
          equipArmor(p || null);
        }}>
          <option value="">- Unarmoured (10 + Dex) -</option>
          {['light', 'medium', 'heavy'].map(cat => (
            <optgroup key={cat} label={`${cat[0].toUpperCase() + cat.slice(1)}${profs[cat] ? '' : ' (not proficient)'}`}>
              {ARMOR_PRESETS.filter(a => a.category === cat).map(a => (
                <option key={a.name} value={a.name} disabled={!profs[cat]}>
                  {a.name} - AC {a.baseAc}{a.dexCap > 0 ? `+Dex${a.dexCap < 90 ? ` (max ${a.dexCap})` : ''}` : ''}{a.strReq ? `, STR ${a.strReq}` : ''}{a.stealthDis ? ', stealth ▼' : ''}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {armor && armor.strReq > strScore && (
        <div className="armor-warn">⚠ {armor.name} needs STR {armor.strReq} (you have {strScore}) - your speed would drop by 10 ft.</div>
      )}

      <div className="armor-row">
        <span className="armor-lbl">Shield</span>
        {shield ? (
          <>
            <select className="armor-select" value={shield.name} disabled={!profs.shield} onChange={e => setShieldPreset(e.target.value)}>
              {SHIELD_PRESETS.map(s => <option key={s.name} value={s.name}>{s.name} - +{s.acBonus} AC{s.strReq ? `, STR ${s.strReq}` : ''}{s.stealthDis ? ', stealth ▼' : ''}</option>)}
            </select>
            <button className="btn sm ghost" onClick={() => equipShield(false)}>Remove</button>
          </>
        ) : (
          <button className="btn sm" disabled={!profs.shield} title={profs.shield ? 'Equip a shield' : 'Not proficient with shields'} onClick={() => equipShield(true)}>+ Equip shield</button>
        )}
      </div>

      <div className="armor-hint">
        Proficient: {[profs.light && 'light', profs.medium && 'medium', profs.heavy && 'heavy'].filter(Boolean).join(', ') || 'no armour'}{profs.shield ? ', shields' : ''}. Body armour sets your AC; Dex adds {armor ? (armor.dexCap >= 90 ? 'in full' : `up to +${armor.dexCap}`) : '+' + dexMod}.
      </div>
    </div>
  );
}

function WeaponManager({ initial, onChange, canEdit, abilities, entity = null }) {
  const [weapons, setWeapons] = useState(() => Array.isArray(initial) ? initial : []);
  const [openId, setOpenId] = useState(null);
  // commit the working copy to the entity a beat after the last edit, so we
  // don't broadcast on every keystroke. Local state always drives the UI.
  // CRITICAL: we also flush any pending edit when the sheet closes, so adding
  // a weapon and immediately closing the menu never loses it.
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const weaponsRef = useRef(weapons); weaponsRef.current = weapons;
  const committedRef = useRef(weapons);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => { onChangeRef.current(weaponsRef.current); committedRef.current = weaponsRef.current; }, 300);
    return () => clearTimeout(t);
  }, [weapons]);
  useEffect(() => () => {
    if (weaponsRef.current !== committedRef.current) onChangeRef.current(weaponsRef.current);
  }, []);

  const addWeapon = () => {
    const w = { id: uid('wpn_'), name: 'New Weapon', equipped: true, hands: 1, attacks: [newWeaponAttack()] };
    setWeapons(ws => [...ws, w]); setOpenId(w.id);
  };
  const addPreset = (name) => {
    const p = WEAPON_PRESETS.find(x => x.name === name);
    if (!p) return;
    // v8.8: a freshly-added weapon starts unequipped if there aren't enough
    // free hands, so it never breaks the occupied-hands rule on its own.
    const probe = { ...entity, weapons };
    const free = handsTotalOf(entity) - occupiedHandsOf(probe);
    const w = weaponFromPreset(p, entity);
    if ((w.hands || 1) > free) w.equipped = false;
    setWeapons(ws => [...ws, w]);
  };
  // v8.8: toggling "equipped" respects the hand budget. Un-equipping is always
  // allowed; equipping only if the weapon's hands fit the remaining slots.
  const toggleEquip = (w) => {
    if (w.equipped) { patchWeapon(w.id, { equipped: false }); return; }
    const free = handsTotalOf(entity) - occupiedHandsOf({ ...entity, weapons });
    if ((Number(w.hands) || 1) > free) {
      alert(`Not enough free hands to wield ${w.name} (needs ${w.hands || 1}, ${free} free).`);
      return;
    }
    patchWeapon(w.id, { equipped: true });
  };
  const pullFromStatBlock = () => {
    const parsed = parseAttacksFromAbilities(abilities);
    if (parsed.length === 0) { alert('No attacks found in the stat block to import.'); return; }
    setWeapons(ws => {
      const have = new Set(ws.map(w => w.name.toLowerCase()));
      return [...ws, ...parsed.filter(w => !have.has(w.name.toLowerCase()))];
    });
  };
  const parseable = canEdit && typeof abilities === 'string' && /Attack:\s*\+\d+\s*to hit/.test(abilities);
  const patchWeapon = (id, patch) => setWeapons(ws => ws.map(w => w.id === id ? { ...w, ...patch } : w));
  const removeWeapon = (id) => setWeapons(ws => ws.filter(w => w.id !== id));
  const patchAttack = (wid, aid, patch) => setWeapons(ws => ws.map(w => w.id !== wid ? w
    : { ...w, attacks: w.attacks.map(a => a.id === aid ? { ...a, ...patch } : a) }));
  const addAttack = (wid) => setWeapons(ws => ws.map(w => w.id === wid ? { ...w, attacks: [...w.attacks, newWeaponAttack()] } : w));
  const removeAttack = (wid, aid) => setWeapons(ws => ws.map(w => w.id === wid ? { ...w, attacks: w.attacks.filter(a => a.id !== aid) } : w));
  const patchComp = (wid, aid, ci, patch) => setWeapons(ws => ws.map(w => w.id !== wid ? w
    : { ...w, attacks: w.attacks.map(a => a.id !== aid ? a : { ...a, damage: a.damage.map((c, i) => i === ci ? { ...c, ...patch } : c) }) }));
  const addComp = (wid, aid) => setWeapons(ws => ws.map(w => w.id !== wid ? w
    : { ...w, attacks: w.attacks.map(a => a.id !== aid ? a : { ...a, damage: [...a.damage, newWeaponComp()] }) }));
  const removeComp = (wid, aid, ci) => setWeapons(ws => ws.map(w => w.id !== wid ? w
    : { ...w, attacks: w.attacks.map(a => a.id !== aid ? a : { ...a, damage: a.damage.filter((_, i) => i !== ci) }) }));

  if (!canEdit) {
    if (weapons.length === 0) return null;
    return (
      <div className="csheet-block">
        <label>Weapons</label>
        <div className="wpn-ro-list">
          {weapons.map(w => (
            <div key={w.id} className="wpn-ro">
              <div className="wpn-ro-head">
                <span className="wpn-ro-name">{w.name}</span>
                {w.equipped && <span className="wpn-eq-badge">EQUIPPED</span>}
              </div>
              {(w.attacks || []).map(a => (
                <div key={a.id} className="wpn-ro-atk"><b>{a.name}:</b> {formatAttack(a)}</div>
              ))}
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="csheet-block">
      <label>Weapons <span className="hands-readout" title="Hands in use / total">✋ {occupiedHandsOf({ ...entity, weapons })}/{handsTotalOf(entity)} hands</span></label>
      <div className="wpn-list">
        {weapons.map(w => (
          <div key={w.id} className={`wpn-card ${w.equipped ? 'equipped' : ''}`}>
            <div className="wpn-card-head">
              <button className={`wpn-eq-toggle ${w.equipped ? 'on' : ''}`} title={w.equipped ? 'Equipped' : 'Not equipped'}
                onClick={() => toggleEquip(w)}>{w.equipped ? '★ Equipped' : '☆ Unequipped'}</button>
              <input className="wpn-name" value={w.name} onChange={e => patchWeapon(w.id, { name: e.target.value })} placeholder="Weapon name" />
              <select className="wpn-hands" value={w.hands || 1} title="Hands required" onChange={e => patchWeapon(w.id, { hands: Number(e.target.value) })}>
                <option value={1}>1H</option>
                <option value={2}>2H</option>
              </select>
              <button className="wpn-icon-btn" title={openId === w.id ? 'Collapse' : 'Edit attacks'} onClick={() => setOpenId(openId === w.id ? null : w.id)}>{openId === w.id ? '▾' : '▸'}</button>
              <button className="wpn-icon-btn danger" title="Delete weapon" onClick={() => { if (confirm(`Delete ${w.name}?`)) removeWeapon(w.id); }}>×</button>
            </div>
            {openId !== w.id && (
              <div className="wpn-card-summary">
                {(w.attacks || []).map(a => <div key={a.id} className="wpn-sum-line"><b>{a.name}:</b> {formatAttack(a)}</div>)}
              </div>
            )}
            {openId === w.id && (
              <div className="wpn-atks">
                {(w.attacks || []).map(a => (
                  <div key={a.id} className="wpn-atk">
                    <div className="wpn-atk-top">
                      <input className="wpn-atk-name" value={a.name} onChange={e => patchAttack(w.id, a.id, { name: e.target.value })} placeholder="Attack name" />
                      <label className="wpn-mini">+<input type="number" value={a.toHit} onChange={e => patchAttack(w.id, a.id, { toHit: parseInt(e.target.value) || 0 })} /> hit</label>
                      <label className="wpn-mini"><input type="number" value={a.range} onChange={e => patchAttack(w.id, a.id, { range: parseInt(e.target.value) || 0 })} /> ft</label>
                      {w.attacks.length > 1 && <button className="wpn-icon-btn danger" title="Remove attack" onClick={() => removeAttack(w.id, a.id)}>×</button>}
                    </div>
                    {(a.damage || []).map((c, ci) => (
                      <div key={ci} className="wpn-comp">
                        <input type="number" className="wpn-c-num" value={c.count} min={1} onChange={e => patchComp(w.id, a.id, ci, { count: Math.max(1, parseInt(e.target.value) || 1) })} />
                        <select className="wpn-c-sides" value={c.sides} onChange={e => patchComp(w.id, a.id, ci, { sides: parseInt(e.target.value) })}>
                          {ALLOWED_DIE_SIDES.map(s => <option key={s} value={s}>d{s}</option>)}
                        </select>
                        <span className="wpn-c-plus">+</span>
                        <input type="number" className="wpn-c-num" value={c.modifier} onChange={e => patchComp(w.id, a.id, ci, { modifier: parseInt(e.target.value) || 0 })} />
                        <input className="wpn-c-type" list="dmg-types" value={c.type} onChange={e => patchComp(w.id, a.id, ci, { type: e.target.value })} placeholder="type" />
                        {a.damage.length > 1 && <button className="wpn-icon-btn danger sm" title="Remove damage" onClick={() => removeComp(w.id, a.id, ci)}>×</button>}
                      </div>
                    ))}
                    <button className="wpn-add-comp" onClick={() => addComp(w.id, a.id)}>+ damage type</button>
                    {!a.effect ? (
                      <button className="wpn-add-comp wpn-add-effect" onClick={() => patchAttack(w.id, a.id, { effect: { condition: 'Poisoned', save: { ability: 'CON', dc: 12 } } })}>+ inflict effect (poison, disease…)</button>
                    ) : (
                      <div className="wpn-effect">
                        <div className="wpn-effect-row">
                          <span className="wpn-effect-label">⚠ On hit:</span>
                          <select className="wpn-eff-cond" value={a.effect.condition} onChange={e => patchAttack(w.id, a.id, { effect: { ...a.effect, condition: e.target.value } })}>
                            {CONDITIONS.map(c => <option key={c} value={c}>{c}</option>)}
                          </select>
                          <button className="wpn-icon-btn danger sm" title="Remove effect" onClick={() => patchAttack(w.id, a.id, { effect: null })}>×</button>
                        </div>
                        <div className="wpn-effect-row">
                          <label className="wpn-mini"><input type="checkbox" checked={!!a.effect.save} onChange={e => patchAttack(w.id, a.id, { effect: { ...a.effect, save: e.target.checked ? { ability: 'CON', dc: 12 } : null } })} /> requires save</label>
                          {a.effect.save ? (
                            <>
                              <select className="wpn-eff-abil" value={a.effect.save.ability} onChange={e => patchAttack(w.id, a.id, { effect: { ...a.effect, save: { ...a.effect.save, ability: e.target.value } } })}>
                                {ABILITIES.map(ab => <option key={ab} value={ab}>{ab}</option>)}
                              </select>
                              <label className="wpn-mini">DC <input type="number" className="wpn-c-num" value={a.effect.save.dc} onChange={e => patchAttack(w.id, a.id, { effect: { ...a.effect, save: { ...a.effect.save, dc: parseInt(e.target.value) || 0 } } })} /></label>
                            </>
                          ) : <span className="wpn-eff-auto">always applies on a hit</span>}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <button className="wpn-add-atk" onClick={() => addAttack(w.id)}>+ add attack mode</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <datalist id="dmg-types">{DAMAGE_TYPES.map(t => <option key={t} value={t} />)}</datalist>
      <div className="wpn-add-row">
        <button className="btn sm wpn-add" onClick={addWeapon}>+ Custom weapon</button>
        <select className="wpn-preset-select" value="" onChange={e => { if (e.target.value) { addPreset(e.target.value); e.target.value = ''; } }}>
          <option value="">+ Add from list…</option>
          {WEAPON_PRESETS.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
        </select>
      </div>
      {parseable && (
        <button className="btn sm wpn-pull" onClick={pullFromStatBlock} title="Create weapons from this creature's attack lines">⚔ Pull attacks from stat block</button>
      )}
    </div>
  );
}

function CharacterSheet({ entity, canEdit = true, obfuscateHp = false, onField, onHpAdjust, onToggleCondition, initialTab, requestMode = false, onRequest, ownRequests = [], onRollLevelHp }) {
  const [tab, setTab] = useState(initialTab || 'core');
  const [hpDelta, setHpDelta] = useState(0);
  // v7.6: when opened to a specific section from the HUD, follow the
  // requested tab (and updates to it) even if the sheet is already open.
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);
  if (!entity) return null;
  const isPC = entity.type === 'PC';
  const money = entity.money || { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 };
  const setMoney = (coin, v) => onField({ money: { ...money, [coin]: Math.max(0, Math.floor(Number(v) || 0)) } });
  const uploadPortrait = async () => { const u = await pickCompressedImage(); if (u) onField({ imageUrl: u }); };
  // v7.6: append a preset item as a readable line to the inventory text.
  const addInventoryItem = (it) => {
    const meta = it.weight && it.weight !== '-' ? `${it.cost}, ${it.weight}` : it.cost;
    const line = `${it.name} (${meta})`;
    const cur = entity.inventory || '';
    onField({ inventory: cur.trim() ? cur.replace(/\s+$/, '') + '\n' + line : line });
  };

  // free-text block (label + auto-growing textarea). Called inline so the
  // textarea keeps a stable tree position and never loses focus.
  const textBlock = (label, field, placeholder, hint) => (
    <div className="csheet-block">
      <label>{label}{hint && <span className="csheet-hint"> - {hint}</span>}</label>
      <LiveTextarea value={entity[field] || ''} onCommit={(v) => onField({ [field]: v })} placeholder={placeholder} />
    </div>
  );

  const TABS = isPC
    ? [['core', '◆ Core'], ['combat', '⚔ Combat'], ['spells', '✦ Spells'], ['gear', '🜚 Gear'], ['story', '❧ Story']]
    : [['core', '◆ Core'], ['combat', '⚔ Combat'], ['gear', '🜚 Gear'], ['story', '❧ Story']];

  return (
    <div className="csheet">
      <div className="csheet-tabbar">
        {TABS.map(([k, l]) => (
          <button key={k} className={`csheet-tab ${tab === k ? 'active' : ''}`} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>

      <div className="csheet-body">
        {/* ---------------- CORE ---------------- */}
        {tab === 'core' && (
          <>
            <div className="csheet-identity">
              <div className="csheet-portrait" style={{ background: entity.color }}>
                {entity.imageUrl ? <img src={entity.imageUrl} alt="" draggable="false" /> : <span>{(entity.name || '?').slice(0, 1).toUpperCase()}</span>}
              </div>
              <div className="csheet-id-fields">
                <div className="csheet-row">
                  <div className="csheet-field grow"><label>Name</label><LiveInput value={entity.name} onCommit={(v) => onField({ name: v })} /></div>
                  <div className="csheet-field"><label>Level</label>
                    {requestMode ? (() => {
                      const pend = ownRequests.find(r => r.kind === 'level_change' && r.status === 'pending');
                      return (
                        <div className="req-inline">
                          <span className="req-val mono">{entity.level}</span>
                          {pend ? <span className="req-pending">⏳ → {pend.payload.to}</span> : (
                            <span className="req-btns">
                              <button className="btn xs" type="button" disabled={entity.level <= 1} onClick={() => onRequest({ kind: 'level_change', data: { to: entity.level - 1 } })}>−1</button>
                              <button className="btn xs" type="button" disabled={entity.level >= 20} onClick={() => onRequest({ kind: 'level_change', data: { to: entity.level + 1 } })}>+1</button>
                            </span>
                          )}
                        </div>
                      );
                    })() : (
                      <LiveNumberInput value={entity.level} onCommit={(v) => onField({ level: Math.max(1, v) })} min={1} max={30} />
                    )}
                  </div>
                </div>
                <div className="csheet-row">
                  <div className="csheet-field grow"><label>Class</label><ClassSelect value={entity.class || ''} onCommit={(v) => onField({ class: v })} /></div>
                  <div className="csheet-field grow"><label>Race / Kin</label><RaceSelect value={entity.race || ''} onCommit={(v) => onField({ race: v })} /></div>
                </div>
                <div className="csheet-row">
                  <div className="csheet-field grow"><label>Background</label><LiveInput value={entity.background || ''} onCommit={(v) => onField({ background: v })} /></div>
                  <div className="csheet-field grow"><label>Alignment</label><LiveInput value={entity.alignment || ''} onCommit={(v) => onField({ alignment: v })} placeholder="e.g. NG" /></div>
                </div>
                <div className="csheet-row">
                  <div className="csheet-field grow"><label>Player</label><LiveInput value={entity.playerName || ''} onCommit={(v) => onField({ playerName: v })} /></div>
                  <div className="csheet-field"><label>XP</label><LiveNumberInput value={entity.xp || 0} onCommit={(v) => onField({ xp: Math.max(0, v) })} min={0} max={1e9} step={10} /></div>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 4 }}>
                  <button className="btn sm" type="button" onClick={uploadPortrait}>⇧ Portrait</button>
                  {entity.imageUrl && <button className="btn sm ghost" type="button" onClick={() => onField({ imageUrl: '' })}>Remove</button>}
                  <input type="color" value={entity.color} onChange={(e) => onField({ color: e.target.value })} title="Token color"
                    style={{ width: 44, height: 24, padding: 0, border: 'none', background: 'transparent', cursor: 'pointer' }} />
                </div>
              </div>
            </div>

            <div className="csheet-combatrow">
              {[['AC', 'ac', 0, 40, 1], ['Init', 'initBonus', -10, 20, 1],
                ['Passive', 'passivePerception', 0, 40, 1], ['Prof', 'proficiencyBonus', 0, 20, 1]].map(([lbl, f, mn, mx, st]) => (
                <div key={f} className="csheet-combatbox">
                  <span className="csheet-combatlbl">{lbl}</span>
                  <LiveNumberInput className="mono" value={entity[f] ?? 0} onCommit={(v) => onField({ [f]: v })} min={mn} max={mx} step={st} />
                </div>
              ))}
            </div>

            <div className="csheet-block">
              <label>Movement speeds (ft)</label>
              <div className="csheet-combatrow">
                <div className="csheet-combatbox">
                  <span className="csheet-combatlbl">🥾 Walk</span>
                  <LiveNumberInput className="mono" value={walkSpeedOf(entity)} onCommit={(v) => onField({ speed: v, speeds: { ...(entity.speeds || {}), walk: v } })} min={0} max={300} step={5} />
                </div>
                <div className="csheet-combatbox">
                  <span className="csheet-combatlbl">🪽 Fly</span>
                  <LiveNumberInput className="mono" value={entity.speeds?.fly ?? 0} onCommit={(v) => onField({ speeds: { ...(entity.speeds || {}), fly: v } })} min={0} max={300} step={5} />
                </div>
                <div className="csheet-combatbox">
                  <span className="csheet-combatlbl">🌊 Swim</span>
                  <LiveNumberInput className="mono" value={entity.speeds?.swim ?? 0} onCommit={(v) => onField({ speeds: { ...(entity.speeds || {}), swim: v } })} min={0} max={300} step={5} />
                </div>
                <div className="csheet-combatbox">
                  <span className="csheet-combatlbl">🧗 Climb</span>
                  <LiveNumberInput className="mono" value={entity.speeds?.climb ?? 0} onCommit={(v) => onField({ speeds: { ...(entity.speeds || {}), climb: v } })} min={0} max={300} step={5} />
                </div>
                <div className="csheet-combatbox">
                  <span className="csheet-combatlbl">🦗 Jump</span>
                  <LiveNumberInput className="mono" value={entity.speeds?.jump ?? 0} onCommit={(v) => onField({ speeds: { ...(entity.speeds || {}), jump: v } })} min={0} max={300} step={5} />
                </div>
              </div>
            </div>

            <div className="csheet-block">
              <label>Hit Points</label>
              {obfuscateHp ? (
                <div className="csheet-hp-hidden">HP hidden by DM - {hpLabel(entity.hp.max > 0 ? entity.hp.current / entity.hp.max * 100 : 0).text}</div>
              ) : (
                <div className="csheet-hp">
                  <div className="csheet-field"><label>Current</label><LiveNumberInput value={entity.hp.current} onCommit={(v) => onField({ hp: { current: v, max: entity.hp.max } })} min={0} max={10000} /></div>
                  <div className="csheet-field"><label>Max</label><LiveNumberInput value={entity.hp.max} onCommit={(v) => onField({ hp: { current: entity.hp.current, max: v } })} min={0} max={10000} /></div>
                  <div className="csheet-field"><label>Hit Dice</label><LiveInput value={entity.hitDice || ''} onCommit={(v) => onField({ hitDice: v })} placeholder="3d8" /></div>
                  {onHpAdjust && (
                    <div className="csheet-hpquick">
                      <button className="btn danger sm" onClick={() => { if (hpDelta) onHpAdjust(-Math.abs(hpDelta)); setHpDelta(0); }}>− Dmg</button>
                      <input type="number" value={hpDelta} onChange={e => setHpDelta(Math.abs(Number(e.target.value)) || 0)} />
                      <button className="btn sm" onClick={() => { if (hpDelta) onHpAdjust(Math.abs(hpDelta)); setHpDelta(0); }}>+ Heal</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="csheet-block">
              <label>Ability Scores{requestMode ? <span className="csheet-hint"> - modifiers shown large; ± asks the DM</span> : ''}</label>
              <div className="csheet-abilities">
                {['str', 'dex', 'con', 'int', 'wis', 'cha'].map(s => {
                  const score = entity.stats[s] ?? 10;
                  const m = modFor(score);
                  const pend = requestMode && ownRequests.find(r => r.kind === 'stat_change' && r.payload?.stat === s && r.status === 'pending');
                  return (
                    <div key={s} className={`csheet-ability ${requestMode ? 'req' : ''}`}>
                      <span className="csheet-ability-k">{s.toUpperCase()}</span>
                      <span className="csheet-ability-mod">{m >= 0 ? `+${m}` : m}</span>
                      {requestMode ? (
                        <div className="req-stat">
                          <span className="req-stat-score mono">{score}</span>
                          {pend ? <span className="req-pending">⏳→{pend.payload.to}</span> : (
                            <span className="req-btns">
                              <button className="btn xs" type="button" disabled={score <= 1} onClick={() => onRequest({ kind: 'stat_change', data: { stat: s, to: score - 1 } })}>−</button>
                              <button className="btn xs" type="button" disabled={score >= 30} onClick={() => onRequest({ kind: 'stat_change', data: { stat: s, to: score + 1 } })}>+</button>
                            </span>
                          )}
                        </div>
                      ) : (
                        <LiveNumberInput className="csheet-ability-score mono" value={score} onCommit={(v) => onField({ stats: { [s]: v } })} min={1} max={30} />
                      )}
                    </div>
                  );
                })}
              </div>
              {requestMode && entity.awaitingHpRoll && (
                <div className="levelup-hp">
                  <label>⬆ Level {entity.awaitingHpRoll.level} - roll your new Hit Points</label>
                  <LevelUpHpRoller die={entity.awaitingHpRoll.die} conMod={modFor(entity.stats.con ?? 10)}
                    onResult={(roll) => onRollLevelHp?.(roll)} />
                </div>
              )}
            </div>

            {['PC', 'Familiar'].includes(entity.type) && (
              <div className="csheet-block">
                <label>Vision <span className="csheet-hint">- feet</span></label>
                <div className="csheet-row">
                  <div className="csheet-field grow"><label>Darkvision</label><LiveNumberInput value={entity.darkvision || 0} onCommit={(v) => onField({ darkvision: v })} min={0} max={600} step={5} /></div>
                  <div className="csheet-field grow"><label>Light Radius</label><LiveNumberInput value={entity.lightRadius || 0} onCommit={(v) => onField({ lightRadius: v })} min={0} max={600} step={5} /></div>
                </div>
              </div>
            )}

            <div className="csheet-block">
              <label>Conditions</label>
              <ConditionPicker active={entity.conditions} onToggle={onToggleCondition} canEdit={canEdit && !!onToggleCondition} />
            </div>
          </>
        )}

        {/* ---------------- COMBAT ---------------- */}
        {tab === 'combat' && (
          <>
            {textBlock('Attacks & Weapons', 'attacks', 'Shortbow +5 to hit, 1d6+3 piercing, range 80/320\nShortsword +5, 1d6+3 slashing…')}
            {textBlock('Features & Traits', 'features', 'Class features, racial traits, feats, resistances…')}
          </>
        )}

        {/* ---------------- SPELLS ---------------- */}
        {tab === 'spells' && isPC && (
          <>
            {textBlock('Spellcasting', 'spells',
              'Spellcasting ability, save DC, attack bonus, slots…\n\nCantrips: Guidance, Sacred Flame\n1st (3 slots): Cure Wounds, Bless, Healing Word\n2nd (2 slots): Lesser Restoration…',
              'free text - track your spells, slots, and notes however you like')}
          </>
        )}

        {/* ---------------- GEAR ---------------- */}
        {tab === 'gear' && (
          <>
            <div className="csheet-block">
              <label>Money</label>
              <div className="csheet-coins">
                {[['PP', 'pp'], ['GP', 'gp'], ['EP', 'ep'], ['SP', 'sp'], ['CP', 'cp']].map(([lbl, k]) => (
                  <div key={k} className={`csheet-coin coin-${k}`}>
                    <span className="csheet-coin-lbl">{lbl}</span>
                    <LiveNumberInput className="mono" value={money[k] || 0} onCommit={(v) => setMoney(k, v)} min={0} max={1e9} />
                  </div>
                ))}
              </div>
            </div>
            {textBlock('Inventory & Equipment', 'inventory', 'Backpack, rations (5), rope (50 ft), torches (3)\nChain shirt, shield, healer\'s kit…')}
            {canEdit && <InventoryItemPicker onAdd={addInventoryItem} />}
            <ArmorManager entity={entity} canEdit={canEdit} onField={onField} />
            <WeaponManager key={entity.id} initial={entity.weapons || []} canEdit={canEdit} abilities={entity.abilities} entity={entity} onChange={(w) => onField({ weapons: w })} />
            {textBlock('Proficiencies & Languages', 'proficiencies', 'Armor: light, medium · Weapons: simple, martial\nTools: thieves\' tools · Languages: Common, Sylvan…')}
          </>
        )}

        {/* ---------------- STORY ---------------- */}
        {tab === 'story' && (
          <>
            <div className="csheet-row">
              {textBlock('Personality Traits', 'traits', 'I always have a plan for when things go wrong.')}
              {textBlock('Ideals', 'ideals', 'Freedom. Tyrants must not be allowed to oppress…')}
            </div>
            <div className="csheet-row">
              {textBlock('Bonds', 'bonds', 'I would die to recover an ancient relic of my faith.')}
              {textBlock('Flaws', 'flaws', 'I can\'t resist a pretty face - or a fat purse.')}
            </div>
            {textBlock('Backstory', 'backstory', 'Where your character comes from, who they were before the adventure…')}
            {textBlock('Notes / Description', 'playerDescription', 'A short description others see when your token is revealed…')}
          </>
        )}
      </div>
    </div>
  );
}


function EditMySheetModal({ state, myPeerId, claim, playerActionSender, onClose, obfuscateHp, initialTab }) {
  useEscClose(onClose);
  const [focusedId, setFocusedId] = useState(claim.pc || claim.familiars[0] || null);

  // v3: entity IDs the player may edit. PC + claimed familiars + bonded familiars.
  const myIds = useMemo(() => {
    const s = new Set([...(claim.familiars || [])]);
    if (claim.pc) s.add(claim.pc);
    for (const [id, e] of Object.entries(state.entities)) {
      if (e && e.type === 'Familiar' && e.bondedPeerId === myPeerId) s.add(id);
    }
    return Array.from(s);
  }, [claim.pc, claim.familiars, state.entities, myPeerId]);

  const entity = focusedId && state.entities[focusedId] ? state.entities[focusedId] : null;

  const onField = (patch) => { if (entity) playerActionSender({ type: 'patch_own_entity', payload: { entityId: entity.id, op: 'field_set', patch } }); };
  const onHpAdjust = (delta) => { if (entity && delta) playerActionSender({ type: 'patch_own_entity', payload: { entityId: entity.id, op: 'hp_adjust', delta } }); };
  const onToggleCondition = (c) => { if (entity) playerActionSender({ type: 'patch_own_entity', payload: { entityId: entity.id, op: 'toggle_condition', condition: c } }); };
  // v7.8: stat/level changes are DM-approved requests, not direct edits.
  const onRequest = (req) => playerActionSender({ type: 'submit_request', payload: req });
  const onRollLevelHp = (roll) => playerActionSender({ type: 'roll_levelup_hp', payload: { roll } });
  const ownRequests = Object.values(state.pendingRequests || {}).filter(r => r.peerId === myPeerId);

  if (!entity) {
    return (
      <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
        <div className="modal slide-up" style={{ maxWidth: 420 }}>
          <div className="float-panel-header"><span>&#9672; Edit My Sheet</span><button className="close-x" onClick={onClose}>&times;</button></div>
          <div className="float-panel-body"><div className="empty-state"><span className="glyph">&#9876;</span>You haven't claimed a character yet.</div></div>
        </div>
      </div>
    );
  }

  const sicknessLabel = SICKNESS_DESCRIPTORS[entity.sickness || 0] || '';

  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal slide-up csheet-modal">
        <div className="float-panel-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="entity-swatch" style={{ background: entity.color, width: 12, height: 12 }} />
            &#9672; {entity.name} - Character Sheet
          </span>
          <button className="close-x" onClick={onClose}>&times;</button>
        </div>
        <div className="float-panel-body csheet-scroll">
          {myIds.length > 1 && (
            <div className="sheet-tabs">
              {myIds.map(id => {
                const e = state.entities[id];
                if (!e) return null;
                return (
                  <button key={id} className={`sheet-tab ${focusedId === id ? 'active' : ''}`} onClick={() => setFocusedId(id)}>
                    <div className="entity-swatch" style={{ background: e.color, width: 10, height: 10 }} />
                    {e.name}
                    {id === claim.pc ? <span className="own-pc-badge" style={{ marginLeft: 4 }}>PC</span> : <span className="familiar-badge">FAM</span>}
                  </button>
                );
              })}
            </div>
          )}
          {entity.type === 'PC' && sicknessLabel && (
            <div className={`sickness-note sick-level-${entity.sickness || 0}`}>
              <span className="sickness-glyph">&#10059;</span>
              <span><em>You feel</em> <strong>{sicknessLabel.toLowerCase()}</strong>.</span>
            </div>
          )}
          <CharacterSheet entity={entity} canEdit obfuscateHp={obfuscateHp}
            onField={onField} onHpAdjust={onHpAdjust} onToggleCondition={onToggleCondition}
            initialTab={initialTab}
            requestMode={entity.type === 'PC'} onRequest={onRequest}
            ownRequests={ownRequests} onRollLevelHp={onRollLevelHp} />
          <div className="settings-hint" style={{ marginTop: 12 }}>
            All changes sync in real time through the DM. The DM may override anything at any moment.
          </div>
        </div>
      </div>
    </div>
  );
}

// v7.6: DM-facing wrapper around CharacterSheet - edits dispatch directly.
function DMSheetModal({ state, entityId, dispatch, onClose }) {
  useEscClose(onClose);
  const entity = state.entities[entityId];
  if (!entity) return null;
  const onField = (patch) => dispatch({ type: 'ENTITY_PATCH', id: entity.id, patch });
  const onHpAdjust = (delta) => dispatch({ type: 'ENTITY_HP_ADJUST', id: entity.id, delta });
  const onToggleCondition = (c) => dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: entity.id, condition: c });
  return (
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal slide-up csheet-modal">
        <div className="float-panel-header">
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="entity-swatch" style={{ background: entity.color, width: 12, height: 12 }} />
            📜 {entity.name} - Character Sheet
          </span>
          <button className="close-x" onClick={onClose}>×</button>
        </div>
        <div className="float-panel-body csheet-scroll">
          <CharacterSheet entity={entity} canEdit obfuscateHp={false}
            onField={onField} onHpAdjust={onHpAdjust} onToggleCondition={onToggleCondition} />
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// PLAYER ONBOARDING  (forced character selection on join)
// ====================================================================
// Shown full-screen as a gate before the player can interact with the map.
// The player must pick a PC, request a new one, or choose spectator mode.
// v7.8: creation progress persists per-device so a reload can't re-roll
// values the player already generated.
const CREATION_LS_KEY = 'plagues-call.creation.v1';
function loadCreation() { try { return JSON.parse(localStorage.getItem(CREATION_LS_KEY)) || null; } catch { return null; } }
function saveCreation(d) { try { localStorage.setItem(CREATION_LS_KEY, JSON.stringify(d)); } catch {} }
function clearCreation() { try { localStorage.removeItem(CREATION_LS_KEY); } catch {} }

// v7.8: one ability-roll slot. Clicking rolls 4 hidden d6; the four faces
// cycle then halt one by one (1.5s apart); the lowest is struck through and
// greyed; the remaining three "smash" together into their sum (4d6-drop-low).
// Calls onResult(sum, rawDice) exactly once when the value settles.
function RollSlot({ label, value, onResult, locked }) {
  const [shown, setShown] = useState([value ? '·' : '?', '?', '?', '?']);
  const [halted, setHalted] = useState([false, false, false, false]);
  const [lowIdx, setLowIdx] = useState(-1);
  const [strike, setStrike] = useState(false);
  const [smash, setSmash] = useState(false);
  const [stage, setStage] = useState(value != null ? 'done' : 'idle');
  const [final, setFinal] = useState(value ?? null);
  const cyc = useRef([]); const tmr = useRef([]);
  useEffect(() => () => { cyc.current.forEach(clearInterval); tmr.current.forEach(clearTimeout); }, []);

  const roll = () => {
    if (stage !== 'idle' || locked) return;
    const raw = [0, 1, 2, 3].map(() => 1 + Math.floor(Math.random() * 6));
    setStage('cycling'); setHalted([false, false, false, false]); setLowIdx(-1); setStrike(false); setSmash(false);
    for (let i = 0; i < 4; i++) {
      cyc.current[i] = setInterval(() => setShown(s => { const n = [...s]; n[i] = 1 + Math.floor(Math.random() * 6); return n; }), 70);
    }
    for (let i = 0; i < 4; i++) {
      tmr.current.push(setTimeout(() => {
        clearInterval(cyc.current[i]);
        setShown(s => { const n = [...s]; n[i] = raw[i]; return n; });
        setHalted(h => { const n = [...h]; n[i] = true; return n; });
      }, 700 + i * 1500));
    }
    const allHalted = 700 + 3 * 1500 + 350;
    tmr.current.push(setTimeout(() => { let li = 0; for (let i = 1; i < 4; i++) if (raw[i] < raw[li]) li = i; setLowIdx(li); setStrike(true); }, allHalted));
    tmr.current.push(setTimeout(() => setSmash(true), allHalted + 850));
    tmr.current.push(setTimeout(() => {
      const s = [...raw].sort((a, b) => a - b); const sum = s[1] + s[2] + s[3];
      setFinal(sum); setStage('done'); onResult(sum, raw);
    }, allHalted + 1550));
  };

  return (
    <div className={`roll-slot ${stage}`}>
      <div className="roll-slot-label">{label}</div>
      {stage === 'idle' ? (
        <button className="roll-go" onClick={roll} disabled={locked}>🎲 Roll</button>
      ) : stage === 'done' ? (
        <div className="roll-final" title="4d6, drop lowest">{final}</div>
      ) : (
        <div className="roll-dice">
          {shown.map((d, i) => (
            <span key={i} className={`roll-die ${halted[i] ? 'set' : 'spin'} ${i === lowIdx ? 'low' : ''} ${i === lowIdx && strike ? 'struck' : ''} ${smash && i !== lowIdx ? 'smash' : ''}`}>{d}{i === lowIdx && strike ? <span className="roll-strike" /> : null}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// v7.8: animated HP generation. Level 1 = max hit die + CON; each further
// level rolls the die + CON and adds it. Each step "lands" with a smash.
function HpRoller({ die, conMod, level, value, onResult }) {
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState(value != null ? null : []); // [{lvl, roll, isMax}]
  const [total, setTotal] = useState(value ?? null);
  const [cur, setCur] = useState(null); // currently animating face
  const tmr = useRef([]); const cyc = useRef(null);
  useEffect(() => () => { tmr.current.forEach(clearTimeout); clearInterval(cyc.current); }, []);

  const go = () => {
    if (running || total != null) return;
    setRunning(true); setSteps([]);
    const rolls = [];
    for (let lvl = 1; lvl <= level; lvl++) rolls.push(lvl === 1 ? die : rollHitDie(die));
    let delay = 0;
    rolls.forEach((r, idx) => {
      const lvl = idx + 1;
      const cycleDur = lvl > 1 ? 950 : 500; // spin time before the face lands
      const dwell = 600;                      // how long the landed face is held
      // start spinning this step's die
      tmr.current.push(setTimeout(() => {
        clearInterval(cyc.current);
        if (lvl > 1) cyc.current = setInterval(() => setCur(1 + Math.floor(Math.random() * die)), 80);
        else setCur(die);
      }, delay));
      // land on the rolled value
      tmr.current.push(setTimeout(() => {
        clearInterval(cyc.current); setCur(r);
      }, delay + cycleDur));
      // record the step. We deliberately do NOT clear `cur` here - keeping the
      // last face on screen avoids the panel collapsing and jumping between
      // steps. The next step overwrites it; the final view replaces it wholesale.
      tmr.current.push(setTimeout(() => {
        setSteps(s => [...s, { lvl, roll: r, isMax: lvl === 1, sub: r + conMod }]);
      }, delay + cycleDur + dwell));
      delay += cycleDur + dwell + 220;
    });
    tmr.current.push(setTimeout(() => {
      const t = rolls.reduce((a, r) => a + r + conMod, 0);
      setTotal(Math.max(1, t)); setRunning(false); onResult(Math.max(1, t));
    }, delay + 250));
  };

  return (
    <div className="hp-roller">
      {total != null ? (
        <div className="hp-final">Max HP <b>{total}</b></div>
      ) : (
        <>
          <button className="btn primary" onClick={go} disabled={running}>{running ? 'Rolling…' : '🎲 Generate HP'}</button>
          {/* fixed-height stage so the panel never collapses between rolls */}
          {running && <div className="hp-stage">{cur != null && <div className="hp-cur" key={cur}>{cur}</div>}</div>}
          <div className="hp-steps">
            {(steps || []).map(s => (
              <span key={s.lvl} className="hp-step">L{s.lvl}: {s.isMax ? `max ${s.roll}` : `d${die}→${s.roll}`}{conMod >= 0 ? '+' : ''}{conMod} = {s.sub}</span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// v7.8: the four-phase player character creator. Race+level → animated stat
// roll (logged to the DM, reload-proof) → class+info (locked) → animated HP.
// v8.6: character backgrounds. Each grants an ability-score improvement the
// player distributes: either +2/+1 across two abilities, or +1/+1/+1 across
// three. Thematic to a world of armed and armoured beasts.
const BACKGROUNDS = [
  { name: 'Soldier', blurb: 'Drilled in arms, formation, and discipline.' },
  { name: 'Outlaw', blurb: 'Lived beyond the law - quick, wary, resourceful.' },
  { name: 'Wanderer', blurb: 'Roamed far and wide, at home in the wilds.' },
  { name: 'Artisan', blurb: 'A skilled maker of useful and beautiful things.' },
  { name: 'Scholar', blurb: 'Steeped in old lore, letters, and secrets.' },
  { name: 'Noble', blurb: 'Born to status, courtesy, and expectation.' },
  { name: 'Healer', blurb: 'Tends the wounded and mends the sick.' },
  { name: 'Entertainer', blurb: 'Wins crowds with wit, music, and daring.' },
  { name: 'Guardian', blurb: 'Swore to shield a place, a person, or a people.' },
  { name: 'Forager', blurb: 'Knows every root, track, and hiding place.' },
];

function NewCharacterBuilder({ playerName, busy, onCancel, onCreate, onRoll }) {
  const saved = useRef(loadCreation()).current || {};
  const [phase, setPhase] = useState(saved.phase || 1);
  const [name, setName] = useState(saved.name || '');
  const [race, setRace] = useState(saved.race || '');
  const [level, setLevel] = useState(saved.level || 1);
  const [pool, setPool] = useState(saved.pool || [null, null, null, null, null, null]); // 6 rolled values
  const [assign, setAssign] = useState(saved.assign || {}); // stat -> pool index
  const [cls, setCls] = useState(saved.cls || '');
  const [classLocked, setClassLocked] = useState(saved.classLocked || false);
  const [hp, setHp] = useState(saved.hp ?? null);
  const [hbSpeed, setHbSpeed] = useState(saved.hbSpeed ?? 30); // homebrew-race speed
  const [hbSize, setHbSize] = useState(saved.hbSize || 'Medium');
  const [hbHeight, setHbHeight] = useState(saved.hbHeight || '');
  const [hbTraits, setHbTraits] = useState(saved.hbTraits || '');
  // v8.6: background (ability-score improvement) + story fields
  const [background, setBackground] = useState(saved.background || '');
  const [bgMode, setBgMode] = useState(saved.bgMode || '2-1'); // '2-1' | '1-1-1'
  const [bgPlus2, setBgPlus2] = useState(saved.bgPlus2 || '');   // ability for +2 (2-1 mode)
  const [bgPlus1, setBgPlus1] = useState(saved.bgPlus1 || '');   // ability for +1 (2-1 mode)
  const [bgTriple, setBgTriple] = useState(saved.bgTriple || []); // three abilities (1-1-1)
  const [story, setStory] = useState(saved.story || { traits: '', ideals: '', bonds: '', flaws: '', backstory: '' });

  // persist on every meaningful change
  useEffect(() => { saveCreation({ phase, name, race, level, pool, assign, cls, classLocked, hp, hbSpeed, hbSize, hbHeight, hbTraits, background, bgMode, bgPlus2, bgPlus1, bgTriple, story }); },
    [phase, name, race, level, pool, assign, cls, classLocked, hp, hbSpeed, hbSize, hbHeight, hbTraits, background, bgMode, bgPlus2, bgPlus1, bgTriple, story]);

  const raceData = DND_RACES.find(r => r.name === race);
  const isHomebrewRace = !!race && !raceData;
  const effSpeed = raceData ? raceData.speed : (Number(hbSpeed) || 30);
  // the full descriptor that travels onto the character (matches a stock race)
  const raceDesc = raceData
    ? { size: raceData.size, height: raceData.height, traits: raceData.bonus }
    : { size: hbSize, height: hbHeight, traits: hbTraits };
  const allRolled = pool.every(v => v != null);
  const assignedCount = Object.keys(assign).filter(k => assign[k] != null).length;
  const stats = {};
  for (const k of ABILITY_KEYS) stats[k] = assign[k] != null ? pool[assign[k]] : null;
  // v8.6: background ability-score improvement.
  const bgBonuses = {};
  if (bgMode === '2-1') {
    if (bgPlus2) bgBonuses[bgPlus2] = (bgBonuses[bgPlus2] || 0) + 2;
    if (bgPlus1) bgBonuses[bgPlus1] = (bgBonuses[bgPlus1] || 0) + 1;
  } else {
    for (const a of bgTriple) bgBonuses[a] = (bgBonuses[a] || 0) + 1;
  }
  const bgValid = !!background && (bgMode === '2-1'
    ? (bgPlus2 && bgPlus1 && bgPlus2 !== bgPlus1)
    : (bgTriple.length === 3 && new Set(bgTriple).size === 3));
  const finalStats = {};
  for (const k of ABILITY_KEYS) finalStats[k] = (stats[k] != null ? stats[k] : 10) + (bgBonuses[k] || 0);
  const conMod = finalStats.con != null ? abilityMod(finalStats.con) : 0;
  const die = CLASS_HIT_DIE[cls] || null;

  const onSlotResult = (idx, sum, raw) => {
    setPool(p => { const n = [...p]; n[idx] = sum; return n; });
    onRoll?.(`stat roll ${idx + 1} - rolled [${raw.join(', ')}] → ${sum} (dropped ${Math.min(...raw)})`);
  };
  const assignValue = (stat, poolIdx) => {
    setAssign(a => {
      const n = { ...a };
      for (const k of Object.keys(n)) if (n[k] === poolIdx) delete n[k]; // value used once
      if (poolIdx === '') delete n[stat]; else n[stat] = Number(poolIdx);
      return n;
    });
  };

  const finish = () => {
    if (busy || hp == null) return;
    onCreate({
      name: name.trim() || `${race} ${cls}`, race, class: cls, level, stats: finalStats, hp,
      speed: effSpeed, size: raceDesc.size, raceHeight: raceDesc.height, raceTraits: raceDesc.traits,
      background,
      traits: story.traits, ideals: story.ideals, bonds: story.bonds, flaws: story.flaws, backstory: story.backstory,
      playerName,
    });
  };

  // ---- Phase chrome ----
  const Stepper = (
    <div className="cc-steps">
      {['Class', 'Race', 'Stats', 'Background', 'Health', 'Story'].map((s, i) => (
        <div key={s} className={`cc-step ${phase === i + 1 ? 'on' : ''} ${phase > i + 1 ? 'done' : ''}`}>{i + 1}. {s}</div>
      ))}
    </div>
  );

  return (
    <div className="builder cc">
      <div className="cc-head">
        <div className="onboarding-section-title">Create a character</div>
        <button className="btn sm ghost" onClick={() => { if (confirm('Discard this character and start over?')) { clearCreation(); onCancel(); } }}>Cancel</button>
      </div>
      {Stepper}

      {/* Phase 1 - Class (name + level + class) */}
      {phase === 1 && (
        <div className="cc-body">
          <div className="builder-field grow">
            <label>Name</label>
            <input value={name} maxLength={60} placeholder="Your hero's name" onChange={e => setName(e.target.value)} />
          </div>
          <div className="builder-field grow">
            <label>Class</label>
            <select className="class-select" value={cls} disabled={classLocked}
              onChange={e => setCls(e.target.value)}>
              <option value="">- Choose a class -</option>
              {DND_CLASSES.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          {cls && CLASS_INFO[cls] && (
            <div className="cc-info cc-class">
              <div><b>Primary</b> {CLASS_INFO[cls].primary} · <b>Saves</b> {CLASS_INFO[cls].saves} · <b>Hit die</b> d{CLASS_HIT_DIE[cls]}</div>
              <div><b>Skills</b> {CLASS_INFO[cls].skills}</div>
              <div><b>Weapons</b> {CLASS_INFO[cls].weapons} · <b>Armor</b> {CLASS_INFO[cls].armor}</div>
              {CLASS_INFO[cls].tools !== 'None' && <div><b>Tools</b> {CLASS_INFO[cls].tools}</div>}
              <div><b>Equipment</b> {CLASS_INFO[cls].equipment}</div>
            </div>
          )}
          <div className="builder-field grow">
            <label>Starting level</label>
            <input type="number" min="1" max="20" value={level}
              onChange={e => setLevel(Math.min(20, Math.max(1, Number(e.target.value) || 1)))} />
          </div>
          <div className="builder-actions">
            <span />
            <button className="btn primary" disabled={!cls} onClick={() => setPhase(2)}>Next: Race →</button>
          </div>
        </div>
      )}

      {/* Phase 2 - Race */}
      {phase === 2 && (
        <div className="cc-body">
          <div className="builder-field grow">
            <label>Race</label>
            <RaceSelect value={race} onCommit={setRace} />
          </div>
          {raceData && (
            <div className="cc-info">
              <div><b>Speed</b> {raceData.speed} ft · <b>Size</b> {raceData.size}</div>
              <div><b>Suggested height</b> {raceData.height}</div>
              <div className="cc-info-bonus">{raceData.bonus}</div>
            </div>
          )}
          {isHomebrewRace && (
            <div className="cc-info">
              <div className="cc-info-bonus">Homebrew race - “{race}”. Define the same elements a standard race carries; all of these travel onto your sheet.</div>
              <div className="cc-hb-grid">
                <div className="cc-hb-field">
                  <label>Speed</label>
                  <div className="cc-hb-speed">
                    <input type="number" min="0" max="200" step="5" value={hbSpeed}
                      onChange={e => setHbSpeed(Math.min(200, Math.max(0, Number(e.target.value) || 0)))} />
                    <span>ft</span>
                  </div>
                </div>
                <div className="cc-hb-field">
                  <label>Size</label>
                  <select className="class-select" value={hbSize} onChange={e => setHbSize(e.target.value)}>
                    {['Tiny', 'Small', 'Medium', 'Large', 'Huge'].map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div className="cc-hb-field grow">
                  <label>Suggested height</label>
                  <input type="text" maxLength={40} placeholder={'e.g. 3\'0"-4\'0"'} value={hbHeight}
                    onChange={e => setHbHeight(e.target.value)} />
                </div>
              </div>
              <div className="cc-hb-field">
                <label>Racial traits</label>
                <textarea className="cc-hb-traits" maxLength={500} rows={2}
                  placeholder="Notable traits and bonuses, e.g. Keen senses, glide on the wind, resist cold."
                  value={hbTraits} onChange={e => setHbTraits(e.target.value)} />
              </div>
            </div>
          )}
          <div className="builder-actions">
            <button className="btn ghost" onClick={() => setPhase(1)}>← Class</button>
            <button className="btn primary" disabled={!race} onClick={() => setPhase(3)}>Next: Stats →</button>
          </div>
        </div>
      )}

      {/* Phase 3 - Stats */}
      {phase === 3 && (
        <div className="cc-body">
          <div className="cc-sub">Generate six values. Each is 4d6, dropping the lowest. Values are saved - you can't re-roll by reloading.</div>
          <div className="cc-roll-grid">
            {pool.map((v, i) => (
              <RollSlot key={i} label={`Value ${i + 1}`} value={v} locked={busy}
                onResult={(sum, raw) => onSlotResult(i, sum, raw)} />
            ))}
          </div>
          {allRolled && (
            <div className="cc-assign">
              <div className="cc-sub">Assign your values to the six abilities:</div>
              {ABILITY_KEYS.map(k => {
                const used = new Set(Object.entries(assign).filter(([kk]) => kk !== k).map(([, v]) => v));
                const curIdx = assign[k];
                const m = stats[k] != null ? abilityMod(stats[k]) : null;
                return (
                  <div key={k} className="cc-assign-row">
                    <span className="cc-assign-label">{k.toUpperCase()}</span>
                    <select value={curIdx != null ? curIdx : ''} onChange={e => assignValue(k, e.target.value)} className="class-select">
                      <option value="">-</option>
                      {pool.map((pv, pi) => (used.has(pi) ? null : <option key={pi} value={pi}>{pv}</option>))}
                    </select>
                    <span className="cc-assign-mod">{m != null ? `${m >= 0 ? '+' : ''}${m}` : ''}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="builder-actions">
            <button className="btn ghost" onClick={() => setPhase(2)}>← Race</button>
            <button className="btn primary" disabled={!allRolled || assignedCount < 6} onClick={() => setPhase(4)}>Next: Background →</button>
          </div>
        </div>
      )}

      {/* Phase 4 - Background (ability score improvement) */}
      {phase === 4 && (
        <div className="cc-body">
          <div className="cc-sub">Choose a background. It grants an ability boost you assign yourself.</div>
          <div className="cc-bg-grid">
            {BACKGROUNDS.map(bg => (
              <button key={bg.name} type="button"
                className={`cc-bg-card ${background === bg.name ? 'on' : ''}`}
                onClick={() => setBackground(bg.name)}>
                <span className="cc-bg-name">{bg.name}</span>
                <span className="cc-bg-blurb">{bg.blurb}</span>
              </button>
            ))}
          </div>

          <div className="cc-bg-bonus">
            <div className="cc-sub">Ability boost</div>
            <div className="cc-bg-mode">
              <button type="button" className={`btn sm ${bgMode === '2-1' ? 'primary' : 'ghost'}`} onClick={() => setBgMode('2-1')}>+2 / +1</button>
              <button type="button" className={`btn sm ${bgMode === '1-1-1' ? 'primary' : 'ghost'}`} onClick={() => setBgMode('1-1-1')}>+1 / +1 / +1</button>
            </div>
            {bgMode === '2-1' ? (
              <div className="cc-bg-selects">
                <label>+2 to
                  <select className="class-select" value={bgPlus2} onChange={e => setBgPlus2(e.target.value)}>
                    <option value="">-</option>
                    {ABILITY_KEYS.map(k => <option key={k} value={k} disabled={k === bgPlus1}>{k.toUpperCase()}</option>)}
                  </select>
                </label>
                <label>+1 to
                  <select className="class-select" value={bgPlus1} onChange={e => setBgPlus1(e.target.value)}>
                    <option value="">-</option>
                    {ABILITY_KEYS.map(k => <option key={k} value={k} disabled={k === bgPlus2}>{k.toUpperCase()}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <div className="cc-bg-triple">
                {[0, 1, 2].map(i => (
                  <label key={i}>+1 to
                    <select className="class-select" value={bgTriple[i] || ''} onChange={e => setBgTriple(t => { const n = [...t]; n[i] = e.target.value; return n; })}>
                      <option value="">-</option>
                      {ABILITY_KEYS.map(k => <option key={k} value={k} disabled={bgTriple.includes(k) && bgTriple[i] !== k}>{k.toUpperCase()}</option>)}
                    </select>
                  </label>
                ))}
              </div>
            )}
          </div>

          {bgValid && (
            <div className="cc-summary">
              <div className="cc-summary-stats">
                {ABILITY_KEYS.map(k => (
                  <span key={k}>{k.toUpperCase()} {finalStats[k]} ({abilityMod(finalStats[k]) >= 0 ? '+' : ''}{abilityMod(finalStats[k])}){bgBonuses[k] ? <b style={{ color: 'var(--gold)' }}> +{bgBonuses[k]}</b> : ''}</span>
                ))}
              </div>
            </div>
          )}

          <div className="builder-actions">
            <button className="btn ghost" onClick={() => setPhase(3)}>← Stats</button>
            <button className="btn primary" disabled={!bgValid} onClick={() => setPhase(5)}>Next: Health →</button>
          </div>
        </div>
      )}

      {/* Phase 5 - lock-in warning, then HP roll */}
      {phase === 5 && (
        <div className="cc-body">
          {!classLocked ? (
            <>
              <div className="cc-lockin">
                <div className="cc-lockin-title">🔒 Lock in your character</div>
                <div className="cc-sub">Once you lock in, your <b>class</b>, <b>race</b>, and <b>ability scores</b> are final and cannot be changed. Your hit points are rolled right after.</div>
              </div>
              <div className="cc-summary">
                <b>{name || `${race} ${cls}`}</b> - {race} {cls}, level {level}{background ? `, ${background}` : ''}
                <div className="cc-summary-stats">
                  {ABILITY_KEYS.map(k => <span key={k}>{k.toUpperCase()} {finalStats[k]} ({abilityMod(finalStats[k]) >= 0 ? '+' : ''}{abilityMod(finalStats[k])})</span>)}
                </div>
              </div>
              <div className="builder-actions">
                <button className="btn ghost" onClick={() => setPhase(4)}>← Background</button>
                <button className="btn primary"
                  onClick={() => { if (confirm(`Lock in ${name || cls}? Your class, race, and stats become final - only HP is left to roll.`)) setClassLocked(true); }}>🔒 Lock in &amp; roll HP</button>
              </div>
            </>
          ) : (
            <>
              <div className="cc-sub">
                {level === 1
                  ? `Level 1 ${cls}: maximum hit die (${die}) + your CON modifier (${conMod >= 0 ? '+' : ''}${conMod}).`
                  : `Level ${level} ${cls}: max die at L1, then roll d${die} for each further level - all + CON (${conMod >= 0 ? '+' : ''}${conMod}).`}
              </div>
              <HpRoller die={die} conMod={conMod} level={level} value={hp}
                onResult={(t) => { setHp(t); onRoll?.(`HP generated → ${t} max (level ${level} ${cls}, CON ${conMod >= 0 ? '+' : ''}${conMod})`); }} />
              <div className="cc-summary">
                <span className="cc-locked">🔒 {name || `${race} ${cls}`} locked in</span>
                <div className="cc-summary-stats">
                  {ABILITY_KEYS.map(k => <span key={k}>{k.toUpperCase()} {finalStats[k]} ({abilityMod(finalStats[k]) >= 0 ? '+' : ''}{abilityMod(finalStats[k])})</span>)}
                </div>
              </div>
              <div className="builder-actions">
                <span />
                <button className="btn primary" disabled={hp == null || busy} onClick={() => setPhase(6)}>Next: Story →</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Phase 6 - Story (optional flourish before entering play) */}
      {phase === 6 && (
        <div className="cc-body">
          <div className="cc-sub">Your hero is ready. Take a moment to sketch their story - all optional, and you can edit it later from your sheet.</div>
          <div className="cc-story">
            <div className="builder-field">
              <label>Personality traits</label>
              <textarea rows={2} maxLength={400} placeholder="How do they carry themselves? Quirks, habits, manner…"
                value={story.traits} onChange={e => setStory(s => ({ ...s, traits: e.target.value }))} />
            </div>
            <div className="builder-field">
              <label>Ideals</label>
              <textarea rows={2} maxLength={300} placeholder="What do they believe in or strive for?"
                value={story.ideals} onChange={e => setStory(s => ({ ...s, ideals: e.target.value }))} />
            </div>
            <div className="builder-field">
              <label>Bonds</label>
              <textarea rows={2} maxLength={300} placeholder="Who or what do they hold dear?"
                value={story.bonds} onChange={e => setStory(s => ({ ...s, bonds: e.target.value }))} />
            </div>
            <div className="builder-field">
              <label>Flaws</label>
              <textarea rows={2} maxLength={300} placeholder="A weakness, fear, or vice…"
                value={story.flaws} onChange={e => setStory(s => ({ ...s, flaws: e.target.value }))} />
            </div>
            <div className="builder-field">
              <label>Backstory</label>
              <textarea rows={3} maxLength={1000} placeholder="Where do they come from? What set them on this path?"
                value={story.backstory} onChange={e => setStory(s => ({ ...s, backstory: e.target.value }))} />
            </div>
          </div>
          <div className="builder-actions">
            <button className="btn ghost" onClick={() => setPhase(5)}>← Health</button>
            <button className="btn primary" disabled={hp == null || busy} onClick={finish}>✓ Create &amp; play</button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerOnboardingGate({ state, myPeerId, playerName, playerActionSender, onRequestNewPC, obfuscateHp }) {
  const [search, setSearch] = useState('');
  // v7.6: which choice is being confirmed. Drives the processing spinner
  // and a periodic re-send so the gate never hangs if a sync is missed.
  const [claiming, setClaiming] = useState(null); // { kind, entityId?, label, payload? }
  const allClaimedIds = new Set(Object.values(state.claims || {}).map(c => c.pc).filter(Boolean));
  const availablePCs = Object.values(state.entities)
    .filter(e => e.type === 'PC' && !allClaimedIds.has(e.id))
    .filter(e => !search || e.name.toLowerCase().includes(search.toLowerCase()));

  // v7.8: the new-character grant gate. The player must be approved by the
  // DM before the creator opens. We read our own request out of synced state.
  const myNewCharReq = Object.values(state.pendingRequests || {}).find(
    r => r.peerId === myPeerId && r.kind === 'new_character');
  const grantStatus = myNewCharReq?.status || null; // null | pending | accepted | rejected
  const granted = grantStatus === 'accepted';

  const pickPC = (ent) => {
    if (claiming) return;
    setClaiming({ kind: 'pc', entityId: ent.id, label: ent.name });
    playerActionSender({ type: 'claim_pc', payload: { entityId: ent.id, playerName } });
  };
  const pickSpectator = () => {
    if (claiming) return;
    setClaiming({ kind: 'spectator', label: 'spectator' });
    playerActionSender({ type: 'claim_spectator', payload: { playerName } });
  };
  const requestNewCharacter = () => {
    playerActionSender({ type: 'submit_request', payload: { kind: 'new_character' } });
  };
  const createCharacter = (payload) => {
    if (claiming) return;
    setClaiming({ kind: 'new', label: payload.name, payload });
    clearCreation();
    playerActionSender({ type: 'create_and_claim_pc', payload });
  };
  const logRoll = (text) => playerActionSender({ type: 'creation_roll', payload: { text } });

  // Re-send the pending claim every 2.5s until this gate unmounts (which
  // happens the moment the claim is confirmed in synced state). The DM
  // treats repeat claims idempotently, so this only ever helps.
  useEffect(() => {
    if (!claiming) return;
    const resend = () => {
      if (claiming.kind === 'pc') playerActionSender({ type: 'claim_pc', payload: { entityId: claiming.entityId, playerName } });
      else if (claiming.kind === 'spectator') playerActionSender({ type: 'claim_spectator', payload: { playerName } });
      else if (claiming.kind === 'new') playerActionSender({ type: 'create_and_claim_pc', payload: claiming.payload });
    };
    const iv = setInterval(resend, TUNING.claimResendMs);
    // Safety release: if the choice is never confirmed (e.g. the PC was
    // grabbed by someone else at the same instant), stop spinning so the
    // player can pick again.
    const giveUp = setTimeout(() => setClaiming(null), TUNING.claimGiveUpMs);
    return () => { clearInterval(iv); clearTimeout(giveUp); };
  }, [claiming, playerActionSender, playerName]);

  return (
    <div className="onboarding-overlay">
      <div className="onboarding-card">
        <div className="onboarding-title">Step into the realm</div>
        <div className="onboarding-subtitle">Welcome, {playerName || 'traveler'}. Choose your presence at the table.</div>

        {granted ? (
          <NewCharacterBuilder
            playerName={playerName}
            busy={!!claiming}
            onCancel={() => playerActionSender({ type: 'submit_request', payload: { kind: 'new_character', data: { withdraw: true } } })}
            onCreate={createCharacter}
            onRoll={logRoll}
          />
        ) : (
          <>
            <div className="onboarding-section">
              <div className="onboarding-section-title">Existing Characters</div>
              {availablePCs.length === 0 ? (
                <div className="empty-state" style={{ padding: '20px' }}>
                  <span className="glyph">⚔</span>
                  No unclaimed characters - request a new one below, or join as a spectator.
                </div>
              ) : (
                <>
                  <input className="onboarding-search"
                    placeholder="Search by name…"
                    value={search}
                    onChange={e => setSearch(e.target.value)} />
                  <div className="onboarding-grid">
                    {availablePCs.map(e => (
                      <div
                        key={e.id}
                        className={`onboarding-pc ${claiming && claiming.entityId === e.id ? 'is-claiming' : ''}`}
                        onClick={() => pickPC(e)}
                      >
                        <div className="pc-avatar" style={{ background: e.color, width: 44, height: 44 }}>
                          {e.imageUrl
                            ? <img src={e.imageUrl} alt="" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'50%'}} />
                            : (e.name[0] || '?').toUpperCase()}
                        </div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontWeight: 600, fontFamily: 'Cinzel, serif', fontSize: 14 }}>{e.name}</div>
                          <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                            Level {e.level} {e.class} · {obfuscateHp ? hpLabel(e.hp.max > 0 ? e.hp.current / e.hp.max * 100 : 0).text : `${e.hp.max} HP`} · AC {e.ac}
                          </div>
                        </div>
                        {claiming && claiming.entityId === e.id
                          ? <div className="onboarding-mini-spinner" />
                          : <button className="btn primary sm">Claim</button>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="onboarding-divider">or</div>

            <div className="onboarding-actions">
              {grantStatus === 'pending' ? (
                <div className="grant-status pending">⏳ Waiting for the DM to approve your new character…</div>
              ) : grantStatus === 'rejected' ? (
                <div className="grant-status rejected">
                  ✖ The DM declined your request.
                  <button className="btn sm" onClick={requestNewCharacter} disabled={!!claiming}>Ask again</button>
                </div>
              ) : (
                <button className="btn primary" onClick={requestNewCharacter} disabled={!!claiming}>＋ Request a new character</button>
              )}
              <button className="btn ghost" onClick={pickSpectator} disabled={!!claiming}>👁 Join as spectator</button>
            </div>
          </>
        )}

        <div className="settings-hint" style={{ textAlign: 'center', marginTop: 16 }}>
          You can change this later from the top bar.
        </div>

        {claiming && (
          <div className="onboarding-claiming">
            <div className="onboarding-spinner" />
            <div className="onboarding-claiming-text">
              {claiming.kind === 'spectator' ? 'Joining as spectator…'
                : claiming.kind === 'new' ? `Creating ${claiming.label}…`
                : `Stepping in as ${claiming.label}…`}
            </div>
            <div className="onboarding-claiming-sub">Confirming with the DM</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ====================================================================
// DM WORLD PANEL  (time-of-day, per-peer push, block zones, etc.)
// ====================================================================
// ====================================================================
// HAZARDS PANEL  (v6 #9)
// ====================================================================
// DM-only. Paints environmental hazard polygons on the current map:
// fire / flood / cold / acid / fog / difficult terrain. Each has its
// own visual treatment. Hazards can be marked hidden so they function
// as traps (DM-only visibility).
const HAZARD_KINDS = [
  { key: 'fire',      label: 'Fire',      glyph: '🔥', swatch: 'rgba(230,80,40,0.6)' },
  { key: 'flood',     label: 'Flood',     glyph: '🌊', swatch: 'rgba(60,120,200,0.6)' },
  { key: 'cold',      label: 'Cold',      glyph: '❄',  swatch: 'rgba(200,230,245,0.7)' },
  { key: 'acid',      label: 'Acid',      glyph: '☣',  swatch: 'rgba(110,180,70,0.6)' },
  { key: 'fog',       label: 'Fog',       glyph: '☁',  swatch: 'rgba(180,180,190,0.65)' },
  { key: 'difficult', label: 'Difficult', glyph: '⟁',  swatch: 'rgba(160,110,50,0.55)' },
];
function HazardsPanel({
  state, dispatch, onClose, toast,
  placingHazard, setPlacingHazard,
  hazardVisibleDefault, setHazardVisibleDefault,
}) {
  const currentMapId = state.currentMapId;
  const list = state.hazards?.[currentMapId] || [];
  return (
    <FloatPanel style={{ right: 16, top: 80, width: 280 }}>
      <div className="float-panel-header">
        <span>⚠ Hazards</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <label className="settings-label">Kind <span className="settings-label-sub">- click-drag on map to paint</span></label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 4, marginBottom: 10 }}>
          {HAZARD_KINDS.map(k => (
            <button key={k.key}
              className={`btn sm ${placingHazard === k.key ? 'active' : ''}`}
              onClick={() => setPlacingHazard(placingHazard === k.key ? null : k.key)}
              title={`${k.label} hazard`}>
              <span style={{ display: 'inline-block', width: 8, height: 8, background: k.swatch, borderRadius: 2, marginRight: 4, verticalAlign: 'middle' }} />
              {k.glyph} {k.label}
            </button>
          ))}
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, marginBottom: 10 }}>
          <input type="checkbox" checked={hazardVisibleDefault}
            onChange={e => setHazardVisibleDefault(e.target.checked)} />
          <span>New hazards visible to players</span>
        </label>
        <div className="settings-hint" style={{ marginBottom: 10 }}>
          Uncheck to paint hidden hazards (traps). Hidden hazards only appear on the DM screen.
        </div>

        <label className="settings-label">On this map <span className="settings-label-sub">- {list.length} hazard(s)</span></label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 160, overflowY: 'auto', marginBottom: 8 }}>
          {list.map(h => {
            const dmg = h.damage || null;
            const setDmg = (patch) => {
              const base = dmg || { count: 1, sides: 6, flat: 0, type: 'Fire', onEntry: false, perTurn: true };
              dispatch({ type: 'HAZARD_UPSERT', mapId: currentMapId, hazard: { ...h, damage: { ...base, ...patch } } });
            };
            return (
              <div key={h.id} style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, padding: '5px 6px', background: 'var(--bg-0)', borderRadius: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ flex: 1 }}>
                    {HAZARD_KINDS.find(k => k.key === h.hazardKind)?.glyph || '?'} {h.hazardKind}
                    {h.visible === false && <span style={{ color: 'var(--ink-mute)', marginLeft: 4 }}>(hidden)</span>}
                    {dmg && <span style={{ color: 'var(--danger)', marginLeft: 4 }}>⚔ {hazardDamageLabel(dmg)}</span>}
                  </span>
                  <button className={`btn sm ghost ${dmg ? 'active' : ''}`} title="Toggle hazardous damage"
                    onClick={() => dispatch({ type: 'HAZARD_UPSERT', mapId: currentMapId, hazard: { ...h, damage: dmg ? null : { count: 1, sides: 6, flat: 0, type: h.hazardKind === 'fire' ? 'Fire' : h.hazardKind === 'cold' ? 'Cold' : h.hazardKind === 'acid' ? 'Acid' : 'Bludgeoning', onEntry: false, perTurn: true } } })}>
                    ⚔
                  </button>
                  <button className="btn sm ghost" title="Toggle visibility"
                    onClick={() => dispatch({ type: 'HAZARD_UPSERT', mapId: currentMapId, hazard: { ...h, visible: h.visible === false } })}>
                    {h.visible === false ? '👁' : '🕶'}
                  </button>
                  <button className="btn sm ghost danger"
                    onClick={() => dispatch({ type: 'HAZARD_DELETE', mapId: currentMapId, id: h.id })}>✕</button>
                </div>
                {dmg && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingLeft: 4 }}>
                    <input type="number" min="0" max="50" value={dmg.count} title="dice count" style={{ width: 36 }} onChange={e => setDmg({ count: Math.max(0, Number(e.target.value) || 0) })} />
                    <span>d</span>
                    <select value={dmg.sides} onChange={e => setDmg({ sides: Number(e.target.value) })} style={{ width: 52 }}>
                      {[4, 6, 8, 10, 12, 20].map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <span>+</span>
                    <input type="number" min="0" max="999" value={dmg.flat} title="flat bonus" style={{ width: 40 }} onChange={e => setDmg({ flat: Math.max(0, Number(e.target.value) || 0) })} />
                    <select value={dmg.type} onChange={e => setDmg({ type: e.target.value })} style={{ flex: 1, minWidth: 70 }}>
                      {DAMAGE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="Damage at the start of each turn spent inside">
                      <input type="checkbox" checked={!!dmg.perTurn} onChange={e => setDmg({ perTurn: e.target.checked })} /> per turn
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3 }} title="Also damage the moment a token enters">
                      <input type="checkbox" checked={!!dmg.onEntry} onChange={e => setDmg({ onEntry: e.target.checked })} /> on entry
                    </label>
                  </div>
                )}
              </div>
            );
          })}
          {list.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic' }}>No hazards painted yet.</div>
          )}
        </div>

        <button className="btn sm danger"
          disabled={!list.length}
          onClick={() => {
            if (confirm('Clear all hazards on this map?')) {
              dispatch({ type: 'HAZARD_CLEAR_MAP', mapId: currentMapId });
              toast('Cleared all hazards');
            }
          }}>
          Clear All
        </button>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// TOOLS MENU  (v7 #6)
// ====================================================================
// Single grouped popover replacing the row of toolbar buttons (Reminder,
// Line, Radius, Draw, Hazards, Dice, Sounds, Block modes, Eraser).
// Click the 🧰 Tools button to open; pick a tool; menu closes; the tool
// becomes active. Active mode is shown in the trigger label.
//
// Props are deliberately broad: the tools menu reads & writes a slice
// of the parent component's state so it can offer/cancel any mode and
// open any panel. We accept an `active` summary describing which tool
// is currently engaged so the menu can highlight it.
function ToolsMenu({
  isDM,
  // measure
  measureMode, setMeasureMode,
  // draw
  showDraw, setShowDraw,
  // panels
  showDice, setShowDice,
  showSounds, setShowSounds,
  showHazards, setShowHazards,
  // v7.3: groups panel (DM-only)
  showGroups, setShowGroups,
  // reminder
  placingReminder, setPlacingReminder,
  // DM-only block modes
  placingBlock, setPlacingBlock,
  placingFreeBlock, setPlacingFreeBlock,
  placingCircleBlock, setPlacingCircleBlock,
  erasingBlock, setErasingBlock,
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  // Close on outside click + Esc
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Helper: cancel ALL exclusive map modes. Each mode-toggle below
  // calls this first so only one is active at a time.
  const clearAllModes = () => {
    setMeasureMode?.(null);
    setPlacingReminder?.(false);
    if (isDM) {
      setPlacingBlock?.(false);
      setPlacingFreeBlock?.(false);
      setPlacingCircleBlock?.(false);
      setErasingBlock?.(false);
    }
  };

  // Choose-mode helper: clears, sets the requested one, closes the menu
  const choose = (fn) => () => { clearAllModes(); fn(); setOpen(false); };

  // Active label for the trigger button
  let activeLabel = '';
  if (measureMode === 'line')         activeLabel = '· Measure';
  else if (measureMode === 'radius')  activeLabel = '· Radius';
  else if (measureMode === 'tokenToToken') activeLabel = '· T→T';
  else if (placingReminder)           activeLabel = '· Reminder';
  else if (isDM && placingBlock)      activeLabel = '· Block';
  else if (isDM && placingFreeBlock)  activeLabel = '· Block';
  else if (isDM && placingCircleBlock)activeLabel = '· Block';
  else if (isDM && erasingBlock)      activeLabel = '· Eraser';

  const isActive = !!activeLabel;

  return (
    <div className="tools-menu-wrap" ref={wrapRef} style={{ position: 'relative' }}>
      <button className={`btn ${open || isActive ? 'active' : ''}`}
        onClick={() => setOpen(!open)}
        title="Tools - measure, draw, shapes, dice, sounds">
        🧰 Tools{activeLabel ? <span className="tools-active-suffix"> {activeLabel}</span> : ''}
      </button>
      {open && (
        <div className="tools-menu-pop">
          {/* MEASURE */}
          <div className="tools-section">
            <div className="tools-section-title">Measure</div>
            <button className={`tools-item ${measureMode === 'line' ? 'active' : ''}`}
              onClick={choose(() => setMeasureMode('line'))}>
              📏 Line <span className="tools-hint">click-drag</span>
            </button>
            <button className={`tools-item ${measureMode === 'radius' ? 'active' : ''}`}
              onClick={choose(() => setMeasureMode('radius'))}>
              ◎ Radius <span className="tools-hint">drag from center</span>
            </button>
            <button className={`tools-item ${measureMode === 'tokenToToken' ? 'active' : ''}`}
              onClick={choose(() => setMeasureMode('tokenToToken'))}>
              ⤴ Token → Token <span className="tools-hint">click two tokens</span>
            </button>
          </div>

          {/* DRAW */}
          <div className="tools-section">
            <div className="tools-section-title">Draw</div>
            <button className={`tools-item ${showDraw ? 'active' : ''}`}
              onClick={() => { setShowDraw(true); setOpen(false); }}>
              ✒ Drawing palette <span className="tools-hint">free / line / circle</span>
            </button>
          </div>

          {/* SHAPES & AREAS - DM only */}
          {isDM && (
            <div className="tools-section">
              <div className="tools-section-title">Shapes & Areas <span className="tools-section-sub">DM</span></div>
              <button className={`tools-item ${placingBlock ? 'active' : ''}`}
                onClick={choose(() => setPlacingBlock(true))}>
                ◼ Block - Rect <span className="tools-hint">click-drag</span>
              </button>
              <button className={`tools-item ${placingFreeBlock ? 'active' : ''}`}
                onClick={choose(() => setPlacingFreeBlock(true))}>
                ✎ Block - Freeform <span className="tools-hint">drag a polygon</span>
              </button>
              <button className={`tools-item ${placingCircleBlock ? 'active' : ''}`}
                onClick={choose(() => setPlacingCircleBlock(true))}>
                ⬤ Block - Circle <span className="tools-hint">drag from center</span>
              </button>
              <button className={`tools-item ${showHazards ? 'active' : ''}`}
                onClick={() => { setShowHazards(true); setOpen(false); }}>
                ⚠ Hazards palette <span className="tools-hint">fire / flood / cold / acid / fog / difficult</span>
              </button>
              <button className={`tools-item danger ${erasingBlock ? 'active' : ''}`}
                onClick={choose(() => setErasingBlock(true))}>
                ✕ Cut / Eraser <span className="tools-hint">draw to subtract</span>
              </button>
            </div>
          )}

          {/* v7.3: ENCOUNTER - DM only. Token grouping for fast
              reveal/hide of whole clusters. */}
          {isDM && (
            <div className="tools-section">
              <div className="tools-section-title">Encounter <span className="tools-section-sub">DM</span></div>
              <button className={`tools-item ${showGroups ? 'active' : ''}`}
                onClick={() => { setShowGroups(true); setOpen(false); }}>
                ⋱ Token groups <span className="tools-hint">reveal / hide clusters at once</span>
              </button>
            </div>
          )}

          {/* OTHER */}
          <div className="tools-section">
            <div className="tools-section-title">Other</div>
            <button className={`tools-item ${placingReminder ? 'active' : ''}`}
              onClick={choose(() => setPlacingReminder(true))}>
              ◆ Reminder <span className="tools-hint">private pin</span>
            </button>
            <button className={`tools-item ${showDice ? 'active' : ''}`}
              onClick={() => { setShowDice(true); setOpen(false); }}>
              🎲 Dice <span className="tools-hint">d4 - d20 for the table</span>
            </button>
            {isDM && (
              <button className={`tools-item ${showSounds ? 'active' : ''}`}
                onClick={() => { setShowSounds(true); setOpen(false); }}>
                🔊 Soundboard <span className="tools-hint">play audio for everyone</span>
              </button>
            )}
          </div>

          {isActive && (
            <div className="tools-section">
              <button className="tools-item ghost"
                onClick={() => { clearAllModes(); setOpen(false); }}>
                ⌧ Cancel active tool
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ====================================================================
// TOKEN GROUPS PANEL  (v7.3)
// ====================================================================
// DM-only. Lists token groups for the current map; lets the DM create
// a group from the current selection, rename, edit membership, and -
// the main point of the feature - hide or reveal an entire group with
// one click.
//
// Permissions: players never open or see this panel. Group metadata
// itself is DM-only; only the effect (tokens appearing / disappearing
// via their .visible flag) propagates to players.
function GroupsPanel({
  state, dispatch, onClose, toast,
  currentMapId,
  selectedTokenIds,
  onTokenReveal, // (tokenId, visible) - reuses existing TOKEN_VISIBILITY plumbing if needed
  onHighlightGroupMembers, // (groupId, on) - briefly outline the group's tokens on the map
}) {
  // Groups are keyed globally but scoped to a single map; filter here.
  const groupsById = state.tokenGroups || {};
  const groupsOnMap = useMemo(
    () => Object.values(groupsById)
      .filter(g => g.mapId === currentMapId)
      .sort((a, b) => (a.createdTs || 0) - (b.createdTs || 0)),
    [groupsById, currentMapId]
  );

  // Track which group is currently open (expanded member list)
  const [openGroupId, setOpenGroupId] = useState(null);
  const [editingNameFor, setEditingNameFor] = useState(null);
  const [editingNameValue, setEditingNameValue] = useState('');

  const selectedOnCurrentMap = useMemo(() => {
    const ids = [];
    for (const tid of selectedTokenIds) {
      const t = state.tokens?.[tid];
      if (t && t.mapId === currentMapId) ids.push(tid);
    }
    return ids;
  }, [selectedTokenIds, state.tokens, currentMapId]);

  const createFromSelection = () => {
    if (selectedOnCurrentMap.length === 0) {
      toast('Select one or more tokens on the map first', 'info');
      return;
    }
    const name = prompt('Group name:', '');
    if (!name || !name.trim()) return;
    const id = uid('grp_');
    dispatch({
      type: 'TOKEN_GROUP_CREATE',
      id, mapId: currentMapId,
      name: name.trim(),
      memberIds: selectedOnCurrentMap,
    });
    setOpenGroupId(id);
    toast(`Group "${name.trim()}" created with ${selectedOnCurrentMap.length} token${selectedOnCurrentMap.length === 1 ? '' : 's'}`, 'success');
  };

  const createEmpty = () => {
    const name = prompt('New group name:', '');
    if (!name || !name.trim()) return;
    const id = uid('grp_');
    dispatch({
      type: 'TOKEN_GROUP_CREATE',
      id, mapId: currentMapId,
      name: name.trim(),
      memberIds: [],
    });
    setOpenGroupId(id);
  };

  const addSelectionTo = (groupId) => {
    if (selectedOnCurrentMap.length === 0) {
      toast('Select tokens on the map first', 'info');
      return;
    }
    dispatch({
      type: 'TOKEN_GROUP_ADD_MEMBERS',
      id: groupId,
      tokenIds: selectedOnCurrentMap,
    });
    toast(`Added ${selectedOnCurrentMap.length} to group`, 'success');
  };

  const removeMember = (groupId, tokenId) => {
    dispatch({
      type: 'TOKEN_GROUP_REMOVE_MEMBERS',
      id: groupId,
      tokenIds: [tokenId],
    });
  };

  const renameStart = (g) => {
    setEditingNameFor(g.id);
    setEditingNameValue(g.name);
  };
  const renameCommit = () => {
    if (editingNameFor && editingNameValue.trim()) {
      dispatch({
        type: 'TOKEN_GROUP_UPDATE',
        id: editingNameFor,
        patch: { name: editingNameValue.trim() },
      });
    }
    setEditingNameFor(null);
    setEditingNameValue('');
  };

  const deleteGroup = (g) => {
    if (!confirm(`Delete group "${g.name}"? (Member tokens are NOT deleted.)`)) return;
    dispatch({ type: 'TOKEN_GROUP_DELETE', id: g.id });
    if (openGroupId === g.id) setOpenGroupId(null);
  };

  const setGroupVisible = (g, visible) => {
    const n = (g.memberIds || []).length;
    if (n === 0) {
      toast('Group is empty - add tokens first', 'info');
      return;
    }
    dispatch({ type: 'TOKEN_GROUP_SET_VISIBLE', id: g.id, visible });
    toast(`${visible ? 'Revealed' : 'Hid'} ${n} token${n === 1 ? '' : 's'}`, 'success');
  };

  // Helper: describe a group's current hidden/revealed state
  const visibilitySummary = (g) => {
    const members = (g.memberIds || [])
      .map(tid => state.tokens?.[tid])
      .filter(Boolean);
    if (members.length === 0) return { label: 'empty', mixed: false, visibleCount: 0, total: 0 };
    const vis = members.filter(t => t.visible).length;
    const total = members.length;
    return {
      label: vis === 0 ? `all hidden` : vis === total ? `all revealed` : `${vis} of ${total} revealed`,
      mixed: vis > 0 && vis < total,
      visibleCount: vis,
      total,
    };
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span>⋱ Groups</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <div className="settings-hint" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.4 }}>
          Cluster tokens for faster encounter control - hide or reveal a whole
          ambush at once.
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <button className="btn primary sm" onClick={createFromSelection}
            disabled={selectedOnCurrentMap.length === 0}
            title={selectedOnCurrentMap.length === 0
              ? 'Shift-click tokens on the map to select them first'
              : `Create a group from ${selectedOnCurrentMap.length} selected token${selectedOnCurrentMap.length === 1 ? '' : 's'}`}>
            ＋ From selection ({selectedOnCurrentMap.length})
          </button>
          <button className="btn sm ghost" onClick={createEmpty}
            title="Create an empty group and add members later">
            ＋ Empty
          </button>
        </div>

        <label className="settings-label">
          Groups on this map <span className="settings-label-sub">- {groupsOnMap.length}</span>
        </label>

        {groupsOnMap.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic', padding: 8 }}>
            No groups yet. Select tokens on the map and click "From selection".
          </div>
        )}

        <div className="groups-list">
          {groupsOnMap.map(g => {
            const summary = visibilitySummary(g);
            const isOpen = openGroupId === g.id;
            const isEditing = editingNameFor === g.id;
            return (
              <div key={g.id} className={`group-row ${isOpen ? 'open' : ''}`}>
                <div className="group-row-head">
                  {isEditing ? (
                    <input
                      className="group-row-name-input"
                      type="text"
                      value={editingNameValue}
                      onChange={e => setEditingNameValue(e.target.value)}
                      onBlur={renameCommit}
                      onKeyDown={e => {
                        if (e.key === 'Enter') renameCommit();
                        if (e.key === 'Escape') { setEditingNameFor(null); setEditingNameValue(''); }
                      }}
                      autoFocus
                    />
                  ) : (
                    <button
                      className="group-row-name"
                      onClick={() => setOpenGroupId(isOpen ? null : g.id)}
                      onMouseEnter={() => onHighlightGroupMembers?.(g.id, true)}
                      onMouseLeave={() => onHighlightGroupMembers?.(g.id, false)}
                      title="Click to expand / collapse"
                    >
                      <span className="group-row-caret">{isOpen ? '▾' : '▸'}</span>
                      <span className="group-row-label">{g.name}</span>
                      <span className={`group-row-summary ${summary.mixed ? 'mixed' : ''}`}>
                        {summary.label}
                      </span>
                    </button>
                  )}
                  <div className="group-row-actions">
                    <button className="btn sm"
                      onClick={() => setGroupVisible(g, true)}
                      title="Reveal all members"
                      disabled={summary.total === 0 || summary.visibleCount === summary.total}>
                      👁
                    </button>
                    <button className="btn sm"
                      onClick={() => setGroupVisible(g, false)}
                      title="Hide all members"
                      disabled={summary.total === 0 || summary.visibleCount === 0}>
                      🕶
                    </button>
                    <button className="btn sm ghost"
                      onClick={() => renameStart(g)}
                      title="Rename group">✎</button>
                    <button className="btn sm ghost danger"
                      onClick={() => deleteGroup(g)}
                      title="Delete group (tokens are preserved)">✕</button>
                  </div>
                </div>

                {isOpen && (
                  <div className="group-row-body">
                    <div className="group-row-members">
                      {(g.memberIds || []).length === 0 && (
                        <div style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--ink-dim)', padding: 4 }}>
                          No members. Select tokens on the map and click "Add selection" below.
                        </div>
                      )}
                      {(g.memberIds || []).map(tid => {
                        const t = state.tokens?.[tid];
                        const ent = t ? state.entities?.[t.entityId] : null;
                        if (!t || !ent) return null;
                        return (
                          <div key={tid} className="group-row-member">
                            <div className="entity-swatch"
                              style={{ background: ent.color || 'var(--gold)', width: 10, height: 10 }} />
                            <span className="group-row-member-name">{ent.name || 'Unnamed'}</span>
                            <span className={`group-row-member-vis ${t.visible ? 'visible' : 'hidden'}`}>
                              {t.visible ? 'visible' : 'hidden'}
                            </span>
                            <button className="btn sm ghost danger"
                              onClick={() => removeMember(g.id, tid)}
                              title="Remove from group">−</button>
                          </div>
                        );
                      })}
                    </div>
                    {selectedOnCurrentMap.length > 0 && (
                      <button className="btn sm"
                        onClick={() => addSelectionTo(g.id)}
                        style={{ width: '100%', marginTop: 4 }}>
                        ＋ Add selection ({selectedOnCurrentMap.length}) to this group
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// SOUNDBOARD PANEL  (v7 #10)
// ====================================================================
// DM-only. Upload audio files (mp3/ogg/wav) to play for the table.
// Sounds are stored in IDB (the 'sounds' store) so they don't bloat the
// main session JSON. Each row has Play / Stop / Delete.
//
// When the DM clicks Play, two things happen:
//   1. A SOUND_EVENT is dispatched to state.soundEvents - players see
//      this in their synced state and trigger local audio playback
//   2. The DM's sync layer also pushes the sound's dataUrl directly to
//      every connected peer via a 'sound_data' envelope, so players
//      who don't yet have the bytes can play immediately
//
// Players cache received sound bytes in their own IDB so a sound played
// twice in one session only transmits once.
function SoundboardPanel({
  state, dispatch, onClose, toast,
  onPlay, onStop, isDM, peerList,
}) {
  const [uploading, setUploading] = useState(false);
  const [targetPeerId, setTargetPeerId] = useState(null);
  const [search, setSearch] = useState('');
  const fileRef = useRef(null);
  const sounds = state.sounds || {};
  const allList = Object.values(sounds).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const list = search.trim()
    ? allList.filter(s => s.name.toLowerCase().includes(search.trim().toLowerCase()))
    : allList;

  const connectedPlayers = (peerList || []).map(pid => {
    const claim = state.claims?.[pid];
    return { pid, name: claim?.playerName || pid.slice(-6) };
  });

  const handleUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    try {
      for (const file of files) {
        const dataUrl = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(r.result);
          r.onerror = () => reject(r.error);
          r.readAsDataURL(file);
        });
        const id = uid('snd_');
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 60);
        await idbSet(IDB_STORES.sounds, id, { id, name, dataUrl, ts: Date.now() });
        dispatch({ type: 'SOUND_REGISTER', id, name });
      }
      toast(`Loaded ${files.length} sound${files.length === 1 ? '' : 's'}`, 'success');
    } catch (err) {
      console.error('[plagues-call] sound upload failed:', err);
      toast('Upload failed - see console', 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleDelete = async (id, name) => {
    if (!confirm(`Delete sound "${name}"?`)) return;
    try {
      await idbDelete(IDB_STORES.sounds, id);
      dispatch({ type: 'SOUND_DEREGISTER', id });
    } catch (err) {
      console.error('[plagues-call] sound delete failed:', err);
    }
  };

  const handleDeleteAll = async () => {
    if (!confirm(`Delete all ${allList.length} sounds? This cannot be undone.`)) return;
    try {
      for (const s of allList) {
        await idbDelete(IDB_STORES.sounds, s.id);
        dispatch({ type: 'SOUND_DEREGISTER', id: s.id });
      }
      setSearch('');
      toast('All sounds deleted', 'success');
    } catch (err) {
      console.error('[plagues-call] delete all failed:', err);
      toast('Delete failed - see console', 'error');
    }
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 340 }}>
      <div className="float-panel-header">
        <span>🔊 Soundboard</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">

        <label className="settings-label">Upload <span className="settings-label-sub">- mp3, ogg, wav</span></label>
        <input ref={fileRef} type="file" accept="audio/*" multiple
          onChange={handleUpload} disabled={uploading}
          style={{ marginBottom: 12, fontSize: 11 }} />

        {isDM && connectedPlayers.length > 0 && (
          <div style={{ marginBottom: 10 }}>
            <label className="settings-label">Play for</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              <button className={`btn sm${targetPeerId === null ? ' active' : ' ghost'}`}
                onClick={() => setTargetPeerId(null)} title="Play for all connected players">
                Everyone
              </button>
              {connectedPlayers.map(({ pid, name }) => (
                <button key={pid}
                  className={`btn sm${targetPeerId === pid ? ' active' : ' ghost'}`}
                  onClick={() => setTargetPeerId(t => t === pid ? null : pid)}
                  title={`Play only for ${name}`}>{name}
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
          <label className="settings-label" style={{ flex: 1, marginBottom: 0 }}>
            Library <span className="settings-label-sub">- {allList.length} sound{allList.length === 1 ? '' : 's'}</span>
          </label>
          {isDM && allList.length > 0 && (
            <button className="btn sm ghost danger" onClick={handleDeleteAll} title="Delete all sounds">
              Delete all
            </button>
          )}
        </div>

        {allList.length > 3 && (
          <input type="text" placeholder="Search sounds…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 6, padding: '4px 8px',
              fontSize: 11, background: 'var(--bg-deep)', border: '1px solid var(--border-soft)',
              borderRadius: 3, color: 'var(--ink)' }} />
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 300, overflowY: 'auto' }}>
          {list.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic', padding: 6 }}>
              {allList.length === 0 ? 'No sounds yet. Upload audio files to build your soundboard.' : 'No sounds match your search.'}
            </div>
          )}
          {list.map(s => (
            <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 6px', background: 'var(--bg-0)', borderRadius: 3 }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
              <button className="btn sm" onClick={() => onPlay(s.id, targetPeerId)}
                title={targetPeerId ? `Play for ${connectedPlayers.find(p => p.pid === targetPeerId)?.name}` : 'Play for the table'}>▶</button>
              <button className="btn sm ghost" onClick={() => onStop(s.id)} title="Stop">■</button>
              {isDM && <button className="btn sm ghost danger" onClick={() => handleDelete(s.id, s.name)} title="Delete">✕</button>}
            </div>
          ))}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// AUDIO PLAYBACK MANAGER  (v7 #10)
// ====================================================================
// Watches state.soundEvents. When a new event appears, looks up the
// sound in local IDB (or falls back to a dataUrl provided in the
// event itself) and plays it via a managed pool of <audio> elements.
//
// Browser autoplay restrictions: the first user interaction unlocks
// autoplay; until then, play() promises reject. We catch and ignore
// these so the app doesn't crash, and re-attempt on the next event.
function useSoundPlayback(state) {
  const audioPoolRef = useRef({});           // soundId → HTMLAudioElement
  const localCacheRef = useRef({});          // soundId → dataUrl (in-memory)
  const seenEventsRef = useRef(new Set());   // event ids already processed
  // Trim seen-events set so it doesn't grow forever (cap at 100)
  useEffect(() => {
    const events = state.soundEvents || [];
    for (const ev of events) {
      if (seenEventsRef.current.has(ev.id)) continue;
      seenEventsRef.current.add(ev.id);
      // Cap
      if (seenEventsRef.current.size > 100) {
        const trimmed = Array.from(seenEventsRef.current).slice(-100);
        seenEventsRef.current = new Set(trimmed);
      }
      // Skip events older than 30s (don't replay history on hydrate)
      if (Date.now() - ev.ts > 30000) continue;
      handleEvent(ev);
    }
    function handleEvent(ev) {
      if (ev.action === 'stop') {
        const a = audioPoolRef.current[ev.soundId];
        if (a) { a.pause(); a.currentTime = 0; }
        return;
      }
      if (ev.action !== 'play') return;
      // Try inline dataUrl first; otherwise look up in cache; otherwise IDB
      const tryPlay = (src) => {
        let audio = audioPoolRef.current[ev.soundId];
        if (!audio || audio.src !== src) {
          if (audio) audio.pause();
          audio = new Audio(src);
          audioPoolRef.current[ev.soundId] = audio;
        } else {
          audio.currentTime = 0;
        }
        const p = audio.play();
        if (p && p.catch) p.catch(err => {
          console.warn('[plagues-call] audio play blocked:', err?.message);
        });
      };
      if (ev.dataUrl) {
        localCacheRef.current[ev.soundId] = ev.dataUrl;
        // Persist to IDB for future plays without re-transmit
        idbSet(IDB_STORES.sounds, ev.soundId, {
          id: ev.soundId,
          name: ev.name || ev.soundId,
          dataUrl: ev.dataUrl,
          ts: Date.now(),
        }).catch(() => {});
        tryPlay(ev.dataUrl);
        return;
      }
      const cached = localCacheRef.current[ev.soundId];
      if (cached) { tryPlay(cached); return; }
      // Check the module-level in-memory cache populated by onSoundData.
      // This resolves the race where sound_data arrives and writes to IDB,
      // but the IDB write hasn't committed by the time we try to read it.
      const memCached = _soundDataCache.get(ev.soundId);
      if (memCached) { localCacheRef.current[ev.soundId] = memCached; tryPlay(memCached); return; }
      idbGet(IDB_STORES.sounds, ev.soundId).then(rec => {
        if (rec?.dataUrl) {
          localCacheRef.current[ev.soundId] = rec.dataUrl;
          _soundDataCache.set(ev.soundId, rec.dataUrl);
          tryPlay(rec.dataUrl);
        } else {
          console.warn(`[plagues-call] sound ${ev.soundId} not available locally`);
        }
      }).catch(() => {});
    }
  }, [state.soundEvents]);
}

// ====================================================================
// DICE TRAY  (v7 #9)
// ====================================================================
// Shared dice rolling visible to everyone in the session. Six standard
// dice (D4, D6, D8, D10, D12, D20). Quantity 1-10. Each roll appears in
// a synced log with who rolled, what, and the result. DM and players
// can both roll; player rolls flow through DM authority so the DM sees
// every event.
const DICE_SIDES = [4, 6, 8, 10, 12, 20];
// v7.9: dice-tool roll animation. Reuses the character-creation spinning dice
// (.roll-die: spin -> set) but with NO drop-lowest strike and no smash - every
// die simply tumbles and lands on its actual result. Visualises precomputed
// results, then calls onDone so the tray can commit the entry to the log.
function DiceRollOverlay({ groups, onDone }) {
  const dice = useMemo(() => {
    const arr = [];
    (groups || []).forEach((g, gi) => (g.results || []).forEach((r, ri) =>
      arr.push({ sides: g.die, result: r, key: `${gi}-${ri}` })));
    return arr;
  }, [groups]);
  const [shown, setShown] = useState(() => dice.map(() => 1));
  const [landed, setLanded] = useState(() => dice.map(() => false));
  const cyc = useRef([]);
  const tmr = useRef([]);
  useEffect(() => {
    const n = dice.length;
    dice.forEach((d, i) => {
      cyc.current[i] = setInterval(() => {
        setShown(s => { const x = s.slice(); x[i] = 1 + Math.floor(Math.random() * d.sides); return x; });
      }, 55 + (i % 6) * 7);
    });
    const baseSpin = 600;
    const stagger = Math.min(70, 520 / Math.max(1, n)); // settle wave within ~0.5s
    dice.forEach((d, i) => {
      tmr.current.push(setTimeout(() => {
        clearInterval(cyc.current[i]);
        setShown(s => { const x = s.slice(); x[i] = d.result; return x; });
        setLanded(l => { const x = l.slice(); x[i] = true; return x; });
      }, baseSpin + i * stagger));
    });
    tmr.current.push(setTimeout(() => onDone?.(), baseSpin + n * stagger + 700));
    return () => { cyc.current.forEach(clearInterval); tmr.current.forEach(clearTimeout); };
  }, []); // run once per mount (the tray remounts this via a key per roll)
  const allLanded = landed.length > 0 && landed.every(Boolean);
  const sum = dice.reduce((a, d) => a + d.result, 0);
  return (
    <div className="dice-roll-anim">
      <div className={`dice-roll-dice ${dice.length > 18 ? 'dense' : ''}`}>
        {dice.map((d, i) => (
          <span key={d.key} className={`roll-die ${landed[i] ? 'set' : 'spin'}`}>{shown[i]}</span>
        ))}
      </div>
      <div className={`dice-roll-total ${allLanded ? 'show' : ''}`}>{sum}</div>
    </div>
  );
}

function DiceTray({
  state, onClose, onRoll,
  myPeerId, myName, isDM, dispatch,
}) {
  // v7.2: counts-per-die state. Keys are the 6 allowed sides.
  // Unbounded quantity in practice (clamped at 100 per die in rollDiceMixed).
  const [counts, setCounts] = useState({ 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0 });
  const log = state.diceLog || [];
  // v7.9: in-tray roll animation. We hold the precomputed entry, play the
  // spinning-dice animation, then commit it to the shared log on completion.
  const [rolling, setRolling] = useState(null); // { entry, groups, seq }
  const rollSeqRef = useRef(0);
  const beginRoll = (entry) => {
    const groups = entry.groups || (entry.dice ? [{ die: entry.dice[0]?.die, results: entry.dice.map(d => d.result) }] : []);
    const flat = groups.reduce((a, g) => a + (g.results?.length || 0), 0);
    if (flat === 0 || flat > 80) { onRoll(entry); return; } // skip anim for empty/huge rolls
    setRolling({ entry, groups, seq: ++rollSeqRef.current });
  };
  const finishRoll = () => { setRolling(r => { if (r) onRoll(r.entry); return null; }); };

  const totalDice = Object.values(counts).reduce((a, b) => a + b, 0);
  const expression = ALLOWED_DIE_SIDES
    .filter(s => counts[s] > 0)
    .map(s => `${counts[s]}d${s}`)
    .join(' + ') || '(pick dice)';

  const bump = (sides, delta) => {
    setCounts(c => ({
      ...c,
      [sides]: Math.max(0, Math.min(100, (c[sides] | 0) + delta)),
    }));
  };
  const setExact = (sides, val) => {
    const n = Math.max(0, Math.min(100, Number(val) | 0));
    setCounts(c => ({ ...c, [sides]: n }));
  };
  const clearAll = () => setCounts({ 4: 0, 6: 0, 8: 0, 10: 0, 12: 0, 20: 0 });

  const handleRoll = () => {
    if (totalDice === 0 || rolling) return;
    const entry = rollDiceMixed(counts, myPeerId || (isDM ? 'dm' : 'player'), myName);
    beginRoll(entry);
    // Leave the tray filled so the player can repeat a complex roll
    // with one tap. They can hit Clear to start over.
  };

  // Quick-roll d20 (single) convenience button - the most common D&D
  // use case. Routes through rollDiceMixed with a one-shot counts.
  const quickD20 = () => {
    if (rolling) return;
    const entry = rollDiceMixed({ 20: 1 }, myPeerId || (isDM ? 'dm' : 'player'), myName);
    beginRoll(entry);
  };

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  // Render a single dice log entry. Handles BOTH the new `groups`
  // shape (v7.2) and the legacy `dice` flat array (v7.0/v7.1).
  const renderEntry = (e) => {
    const isMine = e.peerId === myPeerId || (isDM && e.peerId === 'dm');
    // Normalize to groups for consistent rendering
    const groups = e.groups || (e.dice ? [{
      die: e.dice[0]?.die,
      results: e.dice.map(d => d.result),
    }] : []);
    // Crit/fail highlights only apply when the roll is a single d20
    const isSingleD20 = groups.length === 1 && groups[0].die === 20 && groups[0].results.length === 1;
    const isCrit20 = isSingleD20 && groups[0].results[0] === 20;
    const isCrit1 = isSingleD20 && groups[0].results[0] === 1;
    const expr = e.expression
      || groups.map(g => `${g.results.length}d${g.die}`).join(' + ');
    return (
      <div key={e.id} className={`dice-log-entry ${isMine ? 'mine' : ''} ${isCrit20 ? 'crit' : ''} ${isCrit1 ? 'fail' : ''}`}>
        <div className="dice-log-head">
          <span className="dice-log-who">{e.peerName}</span>
          <span className="dice-log-when">{fmtTime(e.ts)}</span>
        </div>
        <div className="dice-log-roll">
          <span className="dice-log-spec">{expr}</span>
          <span className="dice-log-detail">
            = <strong>{e.total}</strong>
          </span>
        </div>
        {/* v7.2: breakdown per die type. Only shown when there are
            multiple dice (one die → the total IS the result). */}
        {groups.some(g => g.results.length > 1 || groups.length > 1) && (
          <div className="dice-log-breakdown">
            {groups.map((g, i) => (
              <div key={i} className="dice-log-breakdown-row">
                <span className="dice-log-breakdown-die">d{g.die}:</span>
                <span className="dice-log-breakdown-vals">{g.results.join(', ')}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <FloatPanel style={{ right: 16, top: 80, width: 320 }}>
      <div className="float-panel-header">
        <span>🎲 Dice</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {rolling && (
          <DiceRollOverlay key={rolling.seq} groups={rolling.groups} onDone={finishRoll} />
        )}
        <label className="settings-label">
          Build your roll
          {totalDice > 0 && (
            <button className="btn sm ghost" style={{ float: 'right', marginTop: -4 }}
              onClick={clearAll}>Clear</button>
          )}
        </label>
        <div className="dice-steppers">
          {ALLOWED_DIE_SIDES.map(s => (
            <div key={s} className="dice-stepper">
              <span className="dice-stepper-label">d{s}</span>
              <button className="dice-stepper-btn"
                onClick={() => bump(s, -1)}
                disabled={counts[s] <= 0}
                aria-label={`Remove a d${s}`}>−</button>
              <input className="dice-stepper-input"
                type="number" min="0" max="100"
                value={counts[s]}
                onChange={e => setExact(s, e.target.value)}
                aria-label={`Number of d${s}`} />
              <button className="dice-stepper-btn"
                onClick={() => bump(s, +1)}
                aria-label={`Add a d${s}`}>+</button>
            </div>
          ))}
        </div>

        <div className="dice-expression">
          <span className="dice-expression-label">Expression</span>
          <span className="dice-expression-value">{expression}</span>
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 12 }}>
          <button className="btn primary"
            onClick={handleRoll}
            disabled={totalDice === 0}
            style={{ flex: 1 }}
            title={totalDice === 0 ? 'Pick some dice first' : `Roll ${expression}`}>
            🎲 Roll
          </button>
          <button className="btn sm"
            onClick={quickD20}
            title="Quick d20 without changing the tray">
            d20
          </button>
        </div>

        <label className="settings-label">
          Recent <span className="settings-label-sub">- {log.length}</span>
          {isDM && log.length > 0 && (
            <button className="btn sm ghost danger" style={{ float: 'right', marginTop: -4 }}
              onClick={() => {
                if (confirm('Clear the dice log for everyone?')) {
                  dispatch({ type: 'DICE_LOG_CLEAR' });
                }
              }}>
              Clear
            </button>
          )}
        </label>
        <div className="dice-log">
          {log.length === 0 && (
            <div style={{ fontSize: 11, color: 'var(--ink-dim)', fontStyle: 'italic' }}>
              No rolls yet. Pick some dice above and tap Roll.
            </div>
          )}
          {log.map(renderEntry)}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// ====================================================================
// ACTIVE TOOL BANNER  (v7.5)
// ====================================================================
// Many map tools (block/shape placement, the cut eraser, reminders,
// measuring, and the drawing modes) work by switching the canvas into a
// "mode" rather than opening a panel. Previously the only feedback was a
// tiny suffix on the Tools button and a cursor change, so clicking e.g.
// "Block - Rect" felt like nothing happened. This banner makes the
// active mode obvious: it names the tool, tells the user what to do, and
// offers a one-click "Done" to exit the mode (Esc also works via the
// Tools menu / parent handlers).
function ActiveToolBanner({
  measureMode, placingReminder,
  placingBlock, placingFreeBlock, placingCircleBlock, erasingBlock,
  placingHazard, drawMode,
  onDone,
}) {
  let glyph = '', title = '', hint = '';
  if (measureMode === 'line')              { glyph = '📏'; title = 'Measuring - line';   hint = 'Click-drag on the map to measure distance.'; }
  else if (measureMode === 'radius')       { glyph = '◎';  title = 'Measuring - radius';  hint = 'Drag out from a center point.'; }
  else if (measureMode === 'tokenToToken') { glyph = '⤴';  title = 'Measuring - token → token'; hint = 'Click two tokens to measure between them.'; }
  else if (placingBlock)        { glyph = '◼'; title = 'Placing block - rectangle'; hint = 'Click-drag on the map to draw a rectangular block.'; }
  else if (placingFreeBlock)    { glyph = '✎'; title = 'Placing block - freeform';  hint = 'Drag out a polygon to block line of sight.'; }
  else if (placingCircleBlock)  { glyph = '⬤'; title = 'Placing block - circle';    hint = 'Drag from the center to set the radius.'; }
  else if (erasingBlock)        { glyph = '✕'; title = 'Cut / eraser';               hint = 'Drag across blocks to subtract them.'; }
  else if (placingHazard)       { glyph = '⚠'; title = `Placing hazard - ${placingHazard}`; hint = 'Drag out a polygon to mark the hazard area.'; }
  else if (placingReminder)     { glyph = '◆'; title = 'Placing reminder';           hint = 'Click on the map to drop a private pin.'; }
  else if (drawMode === 'erase'){ glyph = '⌫'; title = 'Erasing drawings';           hint = 'Click a drawing to remove it.'; }
  else if (drawMode === 'free') { glyph = '✒'; title = 'Drawing - freehand';         hint = 'Click-drag to draw a freehand stroke.'; }
  else if (drawMode === 'line') { glyph = '╱'; title = 'Drawing - line';             hint = 'Click-drag to draw a straight line.'; }
  else if (drawMode === 'circle'){glyph = '◯'; title = 'Drawing - circle';           hint = 'Drag from the center to draw a circle.'; }
  else return null;

  return (
    <div className="canvas-overlay top-center">
      <div className="active-tool-banner">
        <span className="atb-glyph">{glyph}</span>
        <span className="atb-text">
          <span className="atb-title">{title}</span>
          <span className="atb-hint">{hint}</span>
        </span>
        <button className="atb-done" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

// ====================================================================
// DRAWING PANEL  (v6 #10)
// ====================================================================
// Tool palette for the on-map drawing overlay. Both DM and players can
// draw on the shared map surface; the panel lets them pick a color, a
// line width, and the mode (free / line / circle).
//
// Also offers "Clear mine" and (DM only) "Clear all" to wipe the map.
function DrawingPanel({
  state, onClose,
  drawMode, setDrawMode,
  drawColor, setDrawColor,
  drawWidth, setDrawWidth,
  onClearOwn, onClearAll,
  isDM,
}) {
  const palette = ['#c9a34a', '#e05a5a', '#3fa679', '#5a8ec9', '#c46ab8', '#f0d77a', '#ffffff', '#222222'];
  return (
    <FloatPanel style={{ right: 16, top: 80, width: 260 }}>
      <div className="float-panel-header">
        <span>✒ Draw</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        <label className="settings-label">Mode</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 4 }}>
          <button className={`btn sm ${drawMode === 'free' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'free' ? null : 'free')}>✒ Free</button>
          <button className={`btn sm ${drawMode === 'line' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'line' ? null : 'line')}>╱ Line</button>
          <button className={`btn sm ${drawMode === 'circle' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'circle' ? null : 'circle')}>◯ Circle</button>
          {/* v7.5: per-drawing eraser - click a drawing on the map to remove it. */}
          <button className={`btn sm danger ${drawMode === 'erase' ? 'active' : ''}`}
            onClick={() => setDrawMode(drawMode === 'erase' ? null : 'erase')}>⌫ Erase</button>
        </div>
        <div className="settings-label-sub" style={{ marginBottom: 10, minHeight: 14 }}>
          {drawMode === 'erase'
            ? (isDM ? 'Click any drawing to erase it.' : 'Click one of your drawings to erase it.')
            : drawMode
              ? 'Drag on the map to draw.'
              : 'Pick a mode, then draw on the map.'}
        </div>

        <label className="settings-label">Color</label>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {palette.map(c => (
            <button key={c} className="draw-swatch"
              style={{ background: c, outline: drawColor === c ? '2px solid var(--gold-bright)' : '1px solid var(--border-soft)' }}
              onClick={() => setDrawColor(c)}
              title={c} />
          ))}
          <input type="color" value={drawColor} onChange={e => setDrawColor(e.target.value)}
            className="draw-color-input" title="Custom color" />
        </div>

        <label className="settings-label">Width <span className="settings-label-sub">({drawWidth}px)</span></label>
        <input type="range" min="1" max="16" step="1"
          value={drawWidth}
          onChange={e => setDrawWidth(Number(e.target.value))}
          style={{ width: '100%', marginBottom: 12 }} />

        <div style={{ display: 'flex', gap: 6 }}>
          <button className="btn sm" onClick={onClearOwn}>Clear mine</button>
          {isDM && <button className="btn sm danger" onClick={onClearAll}>Clear all</button>}
        </div>
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// DM WORLD PANEL
// ====================================================================
function DMWorldPanel({
  state, dispatch, onClose, toast,
  onToggleBlockPlace, onToggleFreeBlockPlace, onToggleCircleBlockPlace, onToggleEraseBlock,
  placingBlock, placingFreeBlock, placingCircleBlock, erasingBlock,
}) {
  const peers = Object.entries(state.claims || {});
  const currentMapId = state.currentMapId;
  const tod = state.timeOfDay || 0;
  const maps = state.maps || {};

  const setPeerPush = (peerId, mapId) => {
    dispatch({ type: 'FORCED_VIEW_PEER_SET', peerId, mapId });
    if (mapId) toast('Pushed view to player', 'success');
  };
  const clearAllPush = () => {
    dispatch({ type: 'FORCED_VIEW', forcedView: null });
    dispatch({ type: 'FORCED_VIEW_PEER_CLEAR_ALL' });
    toast('All push-views released');
  };
  const pushGlobal = () => {
    if (state.forcedView?.mapId === currentMapId) {
      dispatch({ type: 'FORCED_VIEW', forcedView: null });
      toast('Global push released');
    } else {
      // v4 FIX #13: clear per-peer overrides so the global push actually
      // reaches everyone. Previously, peers with an individual push would
      // keep their override (filter resolves per-peer first).
      dispatch({ type: 'FORCED_VIEW_PEER_CLEAR_ALL' });
      dispatch({ type: 'FORCED_VIEW', forcedView: { mapId: currentMapId } });
      toast('Pushed to all players', 'success');
    }
  };

  return (
    <FloatPanel className="world-panel" style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>🌍 World</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">

        {/* Time of day */}
        <div className="settings-section">
          <label className="settings-label">Time of Day</label>
          <div className="scale-row">
            <span className="mono" style={{ fontSize: 11, color: 'var(--gold-dim)' }}>☀</span>
            <input type="range" min="0" max="1" step="0.02"
              value={tod}
              onChange={(e) => dispatch({ type: 'TIME_OF_DAY_SET', value: Number(e.target.value) })} />
            <span className="mono" style={{ fontSize: 11, color: 'var(--azure)' }}>☾</span>
            <span className="mono scale-value">{Math.round(tod * 100)}%</span>
          </div>
          <div className="settings-hint">
            Shifts the player view from daylight toward deep night. DM view stays unchanged.
          </div>
          <div style={{ display: 'flex', gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
            {[
              { label: 'Day', v: 0 },
              { label: 'Dusk', v: 0.5 },
              { label: 'Night', v: 0.85 },
              { label: 'Deepest', v: 1 },
            ].map(p => (
              <button key={p.label} className={`btn sm ${Math.abs(tod - p.v) < 0.03 ? 'active' : ''}`}
                onClick={() => dispatch({ type: 'TIME_OF_DAY_SET', value: p.v })}>{p.label}</button>
            ))}
          </div>
        </div>

        {/* Block zones */}
        <div className="settings-section">
          <label className="settings-label">Block Zones <span className="settings-label-sub">- hide portions of the current map from players</span></label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className={`btn sm ${placingBlock ? 'active' : ''}`}
              onClick={onToggleBlockPlace}>
              {placingBlock ? '◼ Click-drag…' : '◼ Rectangle'}
            </button>
            <button className={`btn sm ${placingFreeBlock ? 'active' : ''}`}
              onClick={onToggleFreeBlockPlace}>
              {placingFreeBlock ? '✎ Drawing…' : '✎ Freeform'}
            </button>
            <button className={`btn sm ${placingCircleBlock ? 'active' : ''}`}
              onClick={onToggleCircleBlockPlace}>
              {placingCircleBlock ? '⬤ Click-drag…' : '⬤ Circle'}
            </button>
            <button className={`btn sm ${erasingBlock ? 'danger active' : ''}`}
              onClick={onToggleEraseBlock}>
              {erasingBlock ? '✕ Erasing…' : '✕ Eraser'}
            </button>
            <button className="btn sm danger"
              disabled={!(state.blockZones?.[currentMapId] || []).length}
              onClick={() => {
                if (confirm('Clear all block zones on this map?')) {
                  dispatch({ type: 'BLOCK_ZONE_CLEAR_MAP', mapId: currentMapId });
                }
              }}>
              Clear All
            </button>
          </div>
          <div className="settings-hint">
            {(state.blockZones?.[currentMapId] || []).length} block zone(s). Shapes can overlap. The eraser removes any block it touches while held; clear individual shapes by double-clicking them.
          </div>
        </div>

        {/* Push-view */}
        <div className="settings-section">
          <label className="settings-label">Push View</label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            <button className={`btn sm ${state.forcedView?.mapId === currentMapId ? 'danger active' : ''}`}
              onClick={pushGlobal}>
              {state.forcedView?.mapId === currentMapId ? '⚑ Release All' : '⚑ Push to All'}
            </button>
            <button className="btn sm ghost" onClick={clearAllPush}>Clear all pushes</button>
          </div>
          {peers.length === 0 ? (
            <div className="settings-hint">No players connected.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {peers.map(([peerId, claim]) => {
                const pushed = state.forcedViewPerPeer?.[peerId];
                return (
                  <div key={peerId} className="world-peer-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontWeight: 500, fontSize: 12 }}>
                        {claim.playerName || <em style={{ color: 'var(--ink-mute)' }}>unnamed</em>}
                      </div>
                      <div className="mono" style={{ fontSize: 10, color: 'var(--ink-mute)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {pushed ? `locked → ${maps[pushed.mapId]?.name || '?'}` : 'free'}
                      </div>
                    </div>
                    <select className="mono" style={{ padding: '4px 6px', fontSize: 11, maxWidth: 140 }}
                      value={pushed?.mapId || ''}
                      onChange={(e) => setPeerPush(peerId, e.target.value || null)}>
                      <option value="">- free -</option>
                      {Object.values(maps).map(m => (
                        <option key={m.id} value={m.id}>{m.name}</option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
        </div>

      </div>
    </FloatPanel>
  );
}

// ====================================================================
// CHAT  (collapsible, synced; DM can speak as any name and whisper)
// ====================================================================
// v7.6: parse a leading /whisper or /w command. `recipients` is a flat list
// of { peerId, name, display }. Returns { target, message } on success,
// { error } on a malformed/unknown target, or {} if not a whisper.
function parseWhisper(text, recipients) {
  const m = text.match(/^\/(?:w|whisper)\b\s*(.*)$/is);
  if (!m) return {};
  const rest = (m[1] || '').trim();
  if (!rest) return { error: 'Usage: /whisper [name] your message' };
  const low = rest.toLowerCase();
  let best = null;
  for (const r of recipients) {
    const nl = (r.name || '').toLowerCase();
    if (!nl) continue;
    if (low === nl || low.startsWith(nl + ' ')) {
      if (!best || nl.length > best.name.toLowerCase().length) best = r;
    }
  }
  if (!best) {
    const firstWord = rest.split(/\s+/)[0] || '';
    return { error: `No one named "${firstWord}" to whisper to.` };
  }
  const message = rest.slice(best.name.length).trim();
  if (!message) return { error: `Add a message after the name to whisper to ${best.display || best.name}.` };
  return { target: { peerId: best.peerId, name: best.display || best.name }, message };
}

function ChatPanel({ messages, isDM, myPeerId, defaultName, tokensOnMap = [], recipients = [], onSend, embedded = false }) {
  const [collapsed, setCollapsed] = useState(embedded ? false : true);
  const [whisperDm, setWhisperDm] = useState(false); // v8.9: player whisper-to-DM
  const [input, setInput] = useState('');
  const [speakAs, setSpeakAs] = useState('');      // DM only; '' = Dungeon Master
  const [showSpeaker, setShowSpeaker] = useState(false);
  const [customName, setCustomName] = useState('');
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState('');
  const listRef = useRef(null);
  const seenRef = useRef(messages.length);

  const myName = isDM ? (speakAs.trim() || 'Dungeon Master') : (defaultName || 'Player');

  useEffect(() => {
    const added = messages.length - seenRef.current;
    if (added > 0 && collapsed) setUnread(u => u + added);
    seenRef.current = messages.length;
    if (!collapsed && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages.length, collapsed]);
  useEffect(() => { if (!collapsed) setUnread(0); }, [collapsed]);

  const send = () => {
    const raw = input.trim();
    if (!raw) return;
    let text = raw, whisperTo = null, whisperToName = null;
    if (isDM) {
      const w = parseWhisper(raw, recipients);
      if (w.error) { setError(w.error); return; }
      if (w.target) { whisperTo = w.target.peerId; whisperToName = w.target.name; text = w.message; }
    }
    if (!text.trim()) return;
    // v8.9: players can whisper privately to the DM via the 🔒 toggle.
    onSend({ text, senderName: myName, whisperTo, whisperToName, whisperToDm: !isDM && whisperDm });
    setInput(''); setError('');
  };

  const pickSpeaker = (name) => { setSpeakAs(name); setShowSpeaker(false); };

  const effCollapsed = embedded ? false : collapsed;
  return (
    <div className={`chat-panel ${effCollapsed ? 'collapsed' : ''} ${embedded ? 'embedded' : ''}`}>
      {!embedded && (
      <div className="chat-header" onClick={() => setCollapsed(c => !c)}>
        <span className="chat-title">✦ Chat</span>
        {collapsed && unread > 0 && <span className="chat-unread">{unread}</span>}
        <span className="chat-collapse">{collapsed ? '▴' : '▾'}</span>
      </div>
      )}
      {!effCollapsed && (
        <div className="chat-body">
          <div className="chat-list" ref={listRef}>
            {messages.length === 0 ? (
              <div className="chat-empty">No messages yet. Say hello!</div>
            ) : messages.map(m => (
              <div key={m.id} className={`chat-msg ${m.senderId === myPeerId ? 'own' : ''} ${m.whisperTo ? 'whisper' : ''}`}>
                <span className="chat-sender">
                  {m.whisperTo && <span className="chat-lock">🔒</span>}
                  {m.senderName}
                  {m.whisperTo && <span className="chat-whisper-to"> → {m.whisperToName}</span>}
                  <span className="chat-colon">:</span>
                </span>{' '}
                <span className="chat-text">{m.text}</span>
              </div>
            ))}
          </div>
          {error && <div className="chat-error">{error}</div>}
          <div className="chat-input-row">
            {isDM && showSpeaker && (
              <div className="chat-speaker-pop">
                <div className="chat-speaker-head">Speak as…</div>
                <button className={`chat-speaker-opt ${!speakAs ? 'active' : ''}`} onClick={() => pickSpeaker('')}>♛ Dungeon Master</button>
                {tokensOnMap.length > 0 && <div className="chat-speaker-label">Tokens on this map</div>}
                <div className="chat-speaker-tokens">
                  {tokensOnMap.map(n => (
                    <button key={n} className={`chat-speaker-opt ${speakAs === n ? 'active' : ''}`} onClick={() => pickSpeaker(n)}>{n}</button>
                  ))}
                </div>
                <div className="chat-speaker-label">Custom name</div>
                <div className="chat-speaker-custom">
                  <input value={customName} onChange={e => setCustomName(e.target.value)}
                    placeholder="The wind, A whisper…"
                    onKeyDown={e => { if (e.key === 'Enter' && customName.trim()) pickSpeaker(customName.trim()); }} />
                  <button disabled={!customName.trim()} onClick={() => customName.trim() && pickSpeaker(customName.trim())}>Use</button>
                </div>
              </div>
            )}
            {isDM ? (
              <button className="chat-as" title="Click to change who you speak as" onClick={() => setShowSpeaker(s => !s)}>
                <span className="chat-as-name">{myName}</span><span className="chat-as-caret">▾</span>
              </button>
            ) : (
              <button className={`chat-whisper-toggle ${whisperDm ? 'on' : ''}`} title={whisperDm ? 'Whispering to the DM (click for public)' : 'Whisper privately to the DM'} onClick={() => setWhisperDm(v => !v)}>
                {whisperDm ? '🔒 DM' : '🔓 All'}
              </button>
            )}
            <input className="chat-input" value={input} maxLength={TUNING.chatMaxChars}
              placeholder={isDM ? 'Message…   try /whisper Name …' : (whisperDm ? 'Whisper to the DM…' : 'Message…')}
              onChange={e => { setInput(e.target.value); if (error) setError(''); }}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); send(); } }} />
            <button className="chat-send-btn" title="Send" onClick={send}>➤</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ====================================================================
// DM REQUESTS OVERLAY  (player approval popups)
// ====================================================================
// v7.8: pending player requests surface as popup cards for the DM to accept
// or reject. Auto-decline after REQUEST_TTL with a live countdown.
const REQUEST_TTL_MS = 120000; // 2 minutes
function requestSummary(state, r) {
  if (r.kind === 'new_character') return { icon: '✨', title: 'New character', detail: 'wants to create a new PC' };
  if (r.kind === 'join_request') return { icon: '🚪', title: 'Player wants to join', detail: 'is asking to enter your session' };
  if (r.kind === 'place_token') {
    const nm = r.payload?.entityName || state.entities[r.payload?.entityId]?.name || 'a token';
    return { icon: '◍', title: 'Token placement', detail: `wants to place ${nm} on the map` };
  }
  if (r.kind === 'level_change') {
    const ent = state.entities[r.payload?.entityId];
    return { icon: '⬆', title: 'Level change', detail: `${ent?.name || 'PC'}: level ${r.payload?.from} → ${r.payload?.to}` };
  }
  if (r.kind === 'stat_change') {
    const ent = state.entities[r.payload?.entityId];
    return { icon: '✦', title: 'Stat change', detail: `${ent?.name || 'PC'}: ${String(r.payload?.stat || '').toUpperCase()} ${r.payload?.from} → ${r.payload?.to}` };
  }
  return { icon: '?', title: 'Request', detail: '' };
}
// v7.9: central, prominent resolution card for a player's action request
// (damage / heal / condition). Shows both tokens, the action, the dice + sum +
// type, and lets the DM apply with weakness / resistance / immunity, or reject.
function ActionRequestCard({ r, state, onApply, onReject, queued }) {
  const p = r.payload || {};
  const src = state.entities[p.sourceEntityId];
  const tgt = state.entities[p.targetEntityId];
  const isDmg = r.kind === 'apply_damage';
  const isHeal = r.kind === 'apply_heal';
  const isCond = r.kind === 'apply_condition';
  // components (new) with a legacy single-component fallback
  const comps = (Array.isArray(p.components) && p.components.length)
    ? p.components
    : [{ dice: p.dice || [], diceSum: p.diceSum || 0, modifier: p.modifier || 0, flat: p.flat || 0, type: p.damageType || '' }];
  const diceDmg = comps.reduce((a, c) => a + (c.diceSum || 0) + (c.flat || 0), 0);
  const mod = comps.reduce((a, c) => a + (c.modifier || 0), 0);
  const full = Math.max(0, diceDmg + mod);
  const weak = Math.max(0, diceDmg * 2 + mod);
  const resist = Math.max(0, Math.ceil((diceDmg + mod) / 2));
  const toHitTotal = (p.toHitRoll != null) ? p.toHitRoll + (p.toHit || 0) : null;
  const Avatar = ({ e }) => (
    <div className="ar-token">
      <div className="ar-avatar" style={{ background: e?.color || '#888' }}>
        {e?.imageUrl ? <img src={e.imageUrl} alt="" /> : (e?.name?.[0] || '?').toUpperCase()}
      </div>
      <div className="ar-name">{e?.name || 'Unknown'}</div>
    </div>
  );
  const compLabel = (c) => {
    const groups = {};
    for (const d of (c.dice || [])) { (groups[d.sides] = groups[d.sides] || []).push(d.result); }
    const keys = Object.keys(groups);
    return (
      <span className="ar-comp">
        {keys.length === 0 && (c.flat || 0) > 0 && <span className="ar-comp-dice">manual {c.flat}</span>}
        {keys.map(s => <span key={s} className="ar-comp-dice">{groups[s].length}d{s}: <b>{groups[s].join(', ')}</b></span>)}
        {(c.flat || 0) > 0 && keys.length > 0 && <span className="ar-comp-dice">+{c.flat}</span>}
        {(c.modifier || 0) !== 0 && <span className="ar-comp-mod">{c.modifier > 0 ? `+${c.modifier}` : c.modifier}</span>}
        {isDmg && c.type && <span className="ar-dtype">{c.type}</span>}
      </span>
    );
  };
  return (
    <div className="modal-overlay ar-overlay">
      <div className="modal ar-modal">
        <div className="ar-head">
          <span className="ar-head-title">{isHeal ? '✚ Heal Request' : isCond ? '✦ Condition Request' : '⚔ Attack Request'}</span>
          <span className="ar-head-who">from {r.playerName}{p.weaponName ? ` · ${p.weaponName}${p.attackName ? ' - ' + p.attackName : ''}` : ''}</span>
        </div>
        <div className="ar-tokens">
          <Avatar e={src} />
          <div className={`ar-arrow ${isHeal ? 'heal' : ''}`}>{isHeal ? '✚' : '➜'}</div>
          <Avatar e={tgt} />
        </div>
        <div className="ar-body">
          {isCond ? (
            <div className="ar-cond">
              <span className="ar-cond-chip" style={{ background: CONDITION_COLORS[p.condition] || '#9b6ac4' }}>{p.condition}</span>
              <span className="ar-cond-text">to be applied to {tgt?.name || 'the target'}</span>
            </div>
          ) : (
            <>
              {toHitTotal != null && (
                <div className="ar-tohit">
                  To hit: <strong>{toHitTotal}</strong> <span className="ar-tohit-sub">(d20 {p.toHitRoll} {(p.toHit || 0) >= 0 ? '+' : ''}{p.toHit || 0})</span>
                  {tgt?.ac != null && <span className={`ar-vs-ac ${toHitTotal >= tgt.ac ? 'hit' : 'miss'}`}>vs AC {tgt.ac} · {toHitTotal >= tgt.ac ? 'HIT' : 'MISS'}</span>}
                </div>
              )}
              <div className="ar-comps">
                {comps.map((c, i) => <div key={i} className="ar-comp-row">{compLabel(c)}</div>)}
              </div>
              <div className="ar-total">
                = <strong>{full}</strong>
                {isHeal && <span className="ar-dtype heal">healing</span>}
              </div>
            </>
          )}
        </div>
        <div className="ar-actions">
          {isDmg ? (
            <>
              <button className="btn primary" onClick={() => onApply(r, 'full')}>Apply {full}</button>
              <button className="btn" onClick={() => onApply(r, 'weak')} title="Vulnerable: dice damage doubled (modifiers unchanged)">Weak → {weak}</button>
              <button className="btn" onClick={() => onApply(r, 'resist')} title="Resistant: half total, rounded up">Resist → {resist}</button>
              <button className="btn" onClick={() => onApply(r, 'immune')} title="Immune: no damage">Immune 0</button>
            </>
          ) : isHeal ? (
            <button className="btn primary" onClick={() => onApply(r, 'full')}>Apply heal {full}</button>
          ) : (
            <button className="btn primary" onClick={() => onApply(r, 'full')}>Apply {p.condition}</button>
          )}
          <button className="btn danger" onClick={() => onReject(r)}>Reject</button>
        </div>
        {queued > 0 && <div className="ar-queued">+{queued} more request{queued > 1 ? 's' : ''} waiting</div>}
      </div>
    </div>
  );
}

// v8.0: per-component damage value under a weakness/resistance/immunity setting.
// Vulnerable doubles dice (not the flat modifier); resistant halves (round up).
function attackCompValue(c, setting) {
  const dice = (c.diceSum || 0) + (c.flat || 0);
  const mod = c.modifier || 0;
  if (setting === 'immune') return 0;
  if (setting === 'weak') return Math.max(0, dice * 2 + mod);
  if (setting === 'resist') return Math.max(0, Math.ceil((dice + mod) / 2));
  return Math.max(0, dice + mod);
}

// v8.2: pick the effective d20 under advantage (highest), disadvantage (lowest),
// or normal (the first roll). Two d20s are always rolled and stored so the DM
// can switch the mode after the fact without re-rolling.
function effectiveD20(advMode, a, b) {
  if (advMode === 'advantage') return Math.max(a, b);
  if (advMode === 'disadvantage') return Math.min(a, b);
  return a;
}
function abilityModifier(score) { return Math.floor(((Number(score) || 10) - 10) / 2); }
const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

// v8.0: the shared attack cinematic everyone watches. Animates the pre-rolled
// d20 to-hit (vs the target's AC), shows a HIT or MISS verdict, then rolls the
// damage dice. The DM alone gets the per-damage-type resolution controls.
const ACIN_ORDER = ['intro', 'tohit', 'verdict', 'damage', 'await'];
function AttackCinematic({ atk, isDM, onApply, onDismiss, onSetAdv, onSaveResult, onSetDc, physicalDice, canRollSave }) {
  const canRoll = canRollSave != null ? canRollSave : isDM;
  const hasToHit = atk.d20a != null;
  const comps = (atk.components || []).filter(c => (c.dice && c.dice.length) || (c.modifier || 0) !== 0 || (c.flat || 0) !== 0);
  const isManeuver = comps.length === 0 && !!atk.effect; // v8.3: contest, no damage
  const advMode = atk.advMode || 'normal';
  const d20a = atk.d20a, d20b = atk.d20b ?? atk.d20a;
  const effRoll = hasToHit ? effectiveD20(advMode, d20a, d20b) : null;
  const toHitTotal = hasToHit ? effRoll + (atk.toHit || 0) : null;
  const hit = hasToHit ? (atk.targetAc != null ? toHitTotal >= atk.targetAc : true) : true;

  const [phase, setPhase] = useState('intro');
  const [faceA, setFaceA] = useState(d20a || 20);
  const [faceB, setFaceB] = useState(d20b || 20);
  const [diceShown, setDiceShown] = useState(false);
  const [tick, setTick] = useState(0);
  const [settings, setSettings] = useState({});
  const [saveAdv, setSaveAdv] = useState('normal');
  const [saveEntry, setSaveEntry] = useState(null); // physical dice: { a:'', b:'' }
  const tmr = useRef([]); const cyc = useRef(null); const dcyc = useRef(null);
  const done = useRef(false);
  useEffect(() => () => { tmr.current.forEach(clearTimeout); clearInterval(cyc.current); clearInterval(dcyc.current); }, []);

  useEffect(() => {
    const T = (fn, ms) => tmr.current.push(setTimeout(fn, ms));
    const startDamage = (base) => {
      T(() => { setPhase('damage'); dcyc.current = setInterval(() => setTick(t => t + 1), 80); }, base);
      T(() => { clearInterval(dcyc.current); setDiceShown(true); }, base + 1000);
      T(() => setPhase('await'), base + 1550);
    };
    if (hasToHit) {
      T(() => {
        setPhase('tohit');
        cyc.current = setInterval(() => { setFaceA(1 + Math.floor(Math.random() * 20)); setFaceB(1 + Math.floor(Math.random() * 20)); }, 70);
      }, 600);
      T(() => { clearInterval(cyc.current); setFaceA(d20a); setFaceB(d20b); }, 1850);
      T(() => setPhase('verdict'), 2400);
      startDamage(3550);
    } else {
      startDamage(600);
    }
  }, []);

  const pi = ACIN_ORDER.indexOf(phase);
  const types = [...new Set(comps.map(c => c.type || 'Untyped'))];
  const total = comps.reduce((a, c) => a + attackCompValue(c, settings[c.type || 'Untyped'] || 'normal'), 0);
  const setType = (t, v) => setSettings(s => ({ ...s, [t]: v }));
  const eff = atk.effect;
  const sr = atk.saveResult;
  const isContest = !!eff?.contest;
  const applyEffect = !!eff && (eff.save ? !!(sr && !sr.success) : true);

  const rollSave = () => {
    if (!eff?.save) return;
    const a = 1 + Math.floor(Math.random() * 20), b = 1 + Math.floor(Math.random() * 20);
    const roll = effectiveD20(saveAdv, a, b);
    const mod = abilityModifier(atk.targetStats?.[eff.save.ability.toLowerCase()]);
    const total2 = roll + mod;
    onSaveResult?.({ ability: eff.save.ability, dc: eff.save.dc, d20a: a, d20b: b, advMode: saveAdv, roll, mod, total: total2, success: total2 >= eff.save.dc });
  };
  const clampD20 = (v) => Math.min(20, Math.max(1, parseInt(v) || 1));
  const confirmSaveEntry = () => {
    if (!eff?.save) return;
    const a = clampD20(saveEntry.a);
    const b = (saveAdv !== 'normal') ? clampD20(saveEntry.b) : a;
    const roll = effectiveD20(saveAdv, a, b);
    const mod = abilityModifier(atk.targetStats?.[eff.save.ability.toLowerCase()]);
    const total2 = roll + mod;
    onSaveResult?.({ ability: eff.save.ability, dc: eff.save.dc, d20a: a, d20b: b, advMode: saveAdv, roll, mod, total: total2, success: total2 >= eff.save.dc });
    setSaveEntry(null);
  };

  const Avatar = ({ name, color, img }) => (
    <div className="acin-ava" style={{ background: color || '#888' }}>{img ? <img src={img} alt="" /> : (name?.[0] || '?').toUpperCase()}</div>
  );
  const Die = ({ val, face, used, dim }) => (
    <div className={`acin-d20 ${phase === 'tohit' ? 'spin' : 'set'} ${phase !== 'tohit' && used ? (hit ? 'hit' : 'miss') : ''} ${phase !== 'tohit' && dim ? 'dim' : ''}`}>{phase === 'tohit' ? face : val}</div>
  );

  return (
    <div className="acin-overlay">
      <div className={`acin-card ${isManeuver ? 'is-maneuver' : ''} ${pi >= 2 && hasToHit ? (hit ? 'is-hit' : 'is-miss') : ''}`}>
        <div className="acin-head">
          <div className={`acin-side ${isContest ? (atk.saveResult ? 'acin-clash-l' : 'acin-clash-loop-l') : ''}`}>
            <Avatar name={atk.attackerName} color={atk.attackerColor} img={atk.attackerImg} />
            <div className="acin-side-name">{atk.attackerName}</div>
          </div>
          <div className="acin-mid">
            <div className={`acin-swords ${isManeuver ? 'acin-man-static' : ''}`}>{isContest ? '💥' : isManeuver ? '✦' : '⚔'}</div>
            {isManeuver && <div className="acin-man-tag">{isContest ? 'CONTEST' : 'EFFECT'}</div>}
            {(atk.weaponName || atk.attackName) && <div className={`acin-weapon ${isManeuver ? 'acin-man-name' : ''}`}>{atk.weaponName}{atk.attackName ? ` · ${atk.attackName}` : ''}</div>}
          </div>
          <div className={`acin-side ${isContest ? (atk.saveResult ? 'acin-clash-r' : 'acin-clash-loop-r') : ''}`}>
            <Avatar name={atk.targetName} color={atk.targetColor} img={atk.targetImg} />
            <div className="acin-side-name">{atk.targetName}{atk.targetAc != null && <span className="acin-ac">AC {atk.targetAc}</span>}</div>
          </div>
        </div>

        {hasToHit && pi >= 1 && (
          <div className="acin-tohit">
            {advMode !== 'normal' ? (
              <div className="acin-d20-pair">
                <Die val={d20a} face={faceA} used={phase !== 'tohit' && d20a === effRoll} dim={phase !== 'tohit' && d20a !== effRoll} />
                <Die val={d20b} face={faceB} used={phase !== 'tohit' && d20b === effRoll && d20a !== effRoll} dim={phase !== 'tohit' && !(d20b === effRoll && d20a !== effRoll)} />
              </div>
            ) : (
              <Die val={d20a} face={faceA} used={pi >= 2} dim={false} />
            )}
            {advMode !== 'normal' && pi >= 2 && (
              <div className={`acin-adv-badge ${advMode}`}>{advMode === 'advantage' ? '▲ ADVANTAGE - highest kept' : '▼ DISADVANTAGE - lowest kept'}</div>
            )}
            {pi >= 2 && (
              <div className="acin-tohit-calc">
                <span className="acin-calc">{effRoll}<i>{(atk.toHit || 0) >= 0 ? ' + ' : ' - '}{Math.abs(atk.toHit || 0)}</i> = <b className="acin-glow-num">{toHitTotal}</b></span>
                {atk.targetAc != null && <span className="acin-tohit-vs">vs AC {atk.targetAc}</span>}
              </div>
            )}
          </div>
        )}

        {isDM && hasToHit && pi >= 2 && (
          <div className="acin-adv-toggle">
            {[['normal', 'Normal'], ['advantage', 'Advantage'], ['disadvantage', 'Disadvantage']].map(([v, l]) => (
              <button key={v} className={`acin-adv-opt ${v} ${advMode === v ? 'on' : ''}`} onClick={() => onSetAdv?.(v)}>{l}</button>
            ))}
          </div>
        )}

        {hasToHit && pi >= 2 && (
          atk.targetAc != null
            ? <div className={`acin-verdict ${hit ? 'hit' : 'miss'}`}>{hit ? '✦ HIT ✦' : '✕ MISS'}</div>
            : <div className="acin-verdict noac">⚑ Rolled {toHitTotal} · set the target's AC or the DM rules the hit</div>
        )}

        {hit && pi >= 3 && comps.length > 0 && (
          <div className="acin-damage">
            {comps.map((c, i) => (
              <div key={i} className="acin-comp">
                <span className="acin-comp-dice">
                  {(c.dice || []).map((d, j) => (
                    <span key={j} className={`acin-die ${diceShown ? 'set' : 'roll'}`}>{diceShown ? d.result : (1 + ((tick + j) % (d.sides || 6)))}</span>
                  ))}
                </span>
                {(c.modifier || 0) !== 0 && <span className="acin-comp-mod">{c.modifier > 0 ? `+${c.modifier}` : c.modifier}</span>}
                {c.type && <span className="acin-comp-type">{c.type}</span>}
              </div>
            ))}
            {diceShown && (
              <div className="acin-dmg-total">
                <span className="acin-dmg-total-eq">total</span>
                <b key={total} className="acin-glow-num big">{total}</b>
              </div>
            )}
          </div>
        )}

        {/* effect / saving throw */}
        {hit && pi >= 3 && eff && eff.condition && (
          <div className="acin-effect">
            {eff.save ? (
              <>
                <div className="acin-effect-title">⚠ {eff.condition} <span className="acin-effect-sub">{eff.contest ? `${eff.save.ability} contest` : `${eff.save.ability} save DC ${eff.save.dc}`}</span></div>
                {eff.contest && (
                  <div className="acin-contest-atk">{atk.attackerName}'s {eff.contest.ability}: {eff.contest.atkD20}{eff.contest.atkMod >= 0 ? ' + ' : ' - '}{Math.abs(eff.contest.atkMod)} = <b className="acin-glow-num">{eff.contest.atkTotal}</b> · target must meet or beat it</div>
                )}
                {!sr && isDM && !eff.contest && onSetDc && (
                  <div className="acin-dc-edit">
                    <span>DC</span>
                    <button className="acin-dc-btn" onClick={() => onSetDc(Math.max(1, eff.save.dc - 1))}>−</button>
                    <b>{eff.save.dc}</b>
                    <button className="acin-dc-btn" onClick={() => onSetDc(Math.min(40, eff.save.dc + 1))}>+</button>
                  </div>
                )}
                {!sr ? (canRoll ? (
                  <div className="acin-save-roll">
                    <div className="acin-save-roll-who">{isDM ? 'DM rolls for' : 'Roll for'} {atk.targetName}</div>
                    <div className="acin-save-adv">
                      {[['normal', 'Normal'], ['advantage', 'Adv'], ['disadvantage', 'Disadv']].map(([v, l]) => (
                        <button key={v} className={`acin-adv-opt ${v} ${saveAdv === v ? 'on' : ''}`} onClick={() => setSaveAdv(v)}>{l}</button>
                      ))}
                    </div>
                    {physicalDice ? (
                      saveEntry ? (
                        <div className="acin-save-entry">
                          <span className="acin-save-entry-lbl">d20{saveAdv !== 'normal' ? ' ×2' : ''}</span>
                          <input className="acin-die-input" type="number" min="1" max="20" autoFocus value={saveEntry.a} onChange={e => setSaveEntry(s => ({ ...s, a: e.target.value }))} />
                          {saveAdv !== 'normal' && <input className="acin-die-input" type="number" min="1" max="20" value={saveEntry.b} onChange={e => setSaveEntry(s => ({ ...s, b: e.target.value }))} />}
                          <button className="btn sm primary" onClick={confirmSaveEntry}>OK</button>
                        </div>
                      ) : (
                        <button className="btn sm primary" onClick={() => setSaveEntry({ a: '', b: '' })}>✎ Enter {eff.save.ability} {eff.contest ? 'check' : 'save'}</button>
                      )
                    ) : (
                      <button className="btn sm primary" onClick={rollSave}>🎲 Roll {eff.save.ability} {eff.contest ? 'check' : 'save'}</button>
                    )}
                  </div>
                ) : <div className="acin-await">Awaiting {atk.targetName}'s {eff.contest ? 'contest' : 'save'}…</div>) : (
                  <div className={`acin-save-result ${sr.success ? 'pass' : 'fail'}`}>
                    {sr.ability} {eff.contest ? 'check' : 'save'}: {sr.roll}{sr.mod >= 0 ? ' + ' : ' - '}{Math.abs(sr.mod)} = <b key={sr.total} className="acin-glow-num">{sr.total}</b> {eff.contest ? `vs ${eff.save.dc}` : `vs DC ${eff.save.dc}`}
                    <span className="acin-save-verdict">{sr.success ? (eff.contest ? '✦ Wins!' : '✦ Resisted') : `✕ ${eff.condition}!`}</span>
                  </div>
                )}
              </>
            ) : (
              <div className="acin-effect-title">⚠ Inflicts <b>{eff.condition}</b> on hit</div>
            )}
          </div>
        )}

        {phase === 'await' && hit && (isDM ? (
          <div className="acin-resolve">
            {!isManeuver && <div className="acin-resolve-hint">Set weakness / resistance / immunity per damage type:</div>}
            {types.map(t => (
              <div key={t} className="acin-res-row">
                <span className="acin-res-type">{t}</span>
                <div className="acin-res-opts">
                  {[['normal', 'Normal'], ['weak', 'Weak'], ['resist', 'Resist'], ['immune', 'Immune']].map(([v, l]) => (
                    <button key={v} className={`acin-res-opt ${v} ${(settings[t] || 'normal') === v ? 'on' : ''}`} onClick={() => setType(t, v)}>{l}</button>
                  ))}
                </div>
              </div>
            ))}
            <div className="acin-resolve-actions">
              <button className="btn primary" onClick={() => { if (!done.current) { done.current = true; onApply?.(total, settings, applyEffect); } }}>{isManeuver ? (applyEffect ? `Apply ${eff.condition}` : 'Resolve') : `Apply ${total}${applyEffect ? ` + ${eff.condition}` : ''}`}</button>
              <button className="btn danger" onClick={() => { if (!done.current) { done.current = true; onDismiss?.(); } }}>Cancel</button>
            </div>
          </div>
        ) : (
          <div className="acin-await">Awaiting the DM's ruling…</div>
        ))}

        {hasToHit && !hit && pi >= 2 && isDM && (
          <div className="acin-resolve-actions"><button className="btn" onClick={() => { if (!done.current) { done.current = true; onDismiss?.(); } }}>Dismiss</button></div>
        )}
      </div>
    </div>
  );
}

// v8.0: mounts the cinematic for everyone from synced state.activeAttack. On the
// DM it also carries the resolution (apply/dismiss) and promotes queued attacks.
function AttackCinematicLayer({ state, dispatch, isDM, toast, physicalDice, myPeerId, playerActionSender }) {
  const atk = state.activeAttack;
  useEffect(() => {
    if (!isDM || atk) return;
    const next = Object.values(state.pendingRequests || {})
      .filter(r => r.status === 'pending' && r.kind === 'apply_damage')
      .sort((a, b) => a.ts - b.ts)[0];
    if (!next) return;
    const p = next.payload || {};
    const src = state.entities[p.sourceEntityId];
    const tgt = state.entities[p.targetEntityId];
    if (!tgt) { dispatch({ type: 'REQUEST_RESOLVE', id: next.id, status: 'rejected' }); return; }
    const ac = (typeof tgt.ac === 'number') ? tgt.ac : null;
    const toHitTotal = (p.toHitRoll != null) ? p.toHitRoll + (p.toHit || 0) : null;
    const hit = (toHitTotal != null && ac != null) ? toHitTotal >= ac : true;
    dispatch({ type: 'ATTACK_SET', attack: {
      id: next.id, attackerId: p.sourceEntityId, attackerName: src?.name || 'Attacker', attackerColor: src?.color || '#888', attackerImg: src?.imageUrl || null,
      targetId: p.targetEntityId, targetName: tgt.name, targetColor: tgt.color, targetImg: tgt.imageUrl || null, targetAc: ac,
      weaponName: p.weaponName || '', attackName: p.attackName || '', toHit: p.toHit ?? null, toHitRoll: p.toHitRoll ?? null, hit,
      d20a: p.d20a, d20b: p.d20b, advMode: p.advMode, effect: p.effect, targetStats: tgt.stats || {},
      components: p.components, startedTs: Date.now(),
    } });
  }, [isDM, atk, state.pendingRequests, state.entities, dispatch]);

  // Safety: if this attack's request was resolved elsewhere (e.g. the TTL
  // auto-decline sweep), dismiss the cinematic so it can't get stuck on screen.
  useEffect(() => {
    if (!isDM || !atk) return;
    const backing = state.pendingRequests?.[atk.id];
    if (backing && backing.status !== 'pending') dispatch({ type: 'ATTACK_CLEAR', id: atk.id });
  }, [isDM, atk, state.pendingRequests, dispatch]);

  if (!atk) return null;
  const publicLog = (text) => dispatch({ type: 'CHAT_ADD', message: { id: uid('msg_'), ts: Date.now(), senderId: 'dm', senderName: '⚔ Combat', text, whisperTo: null, whisperToName: null } });
  const resolveReq = (status) => { if (state.pendingRequests?.[atk.id]) dispatch({ type: 'REQUEST_RESOLVE', id: atk.id, status }); };
  const onSetAdv = (mode) => {
    const a = atk.d20a, b = atk.d20b ?? atk.d20a;
    const effRoll = (a != null) ? effectiveD20(mode, a, b) : null;
    const hit = (effRoll != null && atk.targetAc != null && atk.toHit != null) ? (effRoll + atk.toHit >= atk.targetAc) : true;
    dispatch({ type: 'ATTACK_UPDATE', id: atk.id, patch: { advMode: mode, toHitRoll: effRoll, hit } });
  };
  const onSaveResult = (result) => dispatch({ type: 'ATTACK_UPDATE', id: atk.id, patch: { saveResult: result } });
  // v8.3: the DM can nudge the save DC before it's rolled.
  const onSetDc = (dc) => {
    if (!atk.effect?.save) return;
    dispatch({ type: 'ATTACK_UPDATE', id: atk.id, patch: { effect: { ...atk.effect, save: { ...atk.effect.save, dc } } } });
  };
  // v8.3: who may roll the save/contest for the target - the DM always, or, if
  // the target is a player's PC, that player (rolling "from the token's view").
  const ownsTarget = !isDM && myPeerId && typeof ownedByPeer === 'function' && ownedByPeer(state, myPeerId).has(atk.targetId);
  const canRollSave = isDM || !!ownsTarget;
  // A player rolling the target's save sends the result to the host to apply.
  const playerSaveRoll = (result) => playerActionSender?.({ type: 'attack_save_roll', attackId: atk.id, saveResult: result });
  const onApply = (total, settings, applyEffect) => {
    const tgt = state.entities[atk.targetId];
    const dmg = Math.max(0, Math.round(total) || 0);
    if (tgt) dispatch({ type: 'ENTITY_HP_ADJUST', id: tgt.id, delta: -dmg });
    let effNote = '';
    if (applyEffect && atk.effect?.condition && tgt) {
      if (!(tgt.conditions || []).includes(atk.effect.condition)) dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: tgt.id, condition: atk.effect.condition });
      effNote = ` and is ${atk.effect.condition}`;
    }
    resolveReq('accepted');
    const mods = Object.entries(settings || {}).filter(([, v]) => v && v !== 'normal').map(([t, v]) => `${t} ${v}`);
    publicLog(`${atk.attackerName} hits ${atk.targetName} for ${dmg} damage${mods.length ? ` (${mods.join(', ')})` : ''}${effNote}.`);
    toast?.(`${atk.targetName} takes ${dmg}${effNote}`, 'success');
    dispatch({ type: 'ATTACK_CLEAR', id: atk.id });
  };
  const onDismiss = () => {
    resolveReq('accepted');
    if (atk.hit === false) publicLog(`${atk.attackerName} attacks ${atk.targetName}... and misses!`);
    dispatch({ type: 'ATTACK_CLEAR', id: atk.id });
  };
  return ReactDOM.createPortal(
    <AttackCinematic key={atk.id} atk={atk} isDM={isDM} physicalDice={physicalDice} canRollSave={canRollSave}
      onApply={isDM ? onApply : null} onDismiss={isDM ? onDismiss : null}
      onSetAdv={isDM ? onSetAdv : null} onSetDc={isDM ? onSetDc : null}
      onSaveResult={isDM ? onSaveResult : (ownsTarget ? playerSaveRoll : null)} />,
    document.body
  );
}

function DMRequestsOverlay({ state, dispatch, toast, onApproveJoin, onRejectJoin }) {
  const pending = Object.values(state.pendingRequests || {})
    .filter(r => r.status === 'pending')
    .sort((a, b) => a.ts - b.ts);
  const [, force] = useState(0);
  useEffect(() => {
    if (pending.length === 0) return;
    const iv = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(iv);
  }, [pending.length]);
  // Auto-decline sweep - runs each render; fires once a request passes its TTL.
  useEffect(() => {
    const now = Date.now();
    for (const r of pending) {
      if (now - r.ts >= REQUEST_TTL_MS) dispatch({ type: 'REQUEST_RESOLVE', id: r.id, status: 'rejected' });
    }
  });
  if (pending.length === 0) return null;
  const resolve = (r, status) => {
    dispatch({ type: 'REQUEST_RESOLVE', id: r.id, status });
    if (r.kind === 'join_request') {
      // v8.9: admitting/kicking runs on the host (needs the live connections
      // and the approved/held peer sets), so defer to the callbacks.
      if (status === 'accepted') onApproveJoin?.(r.peerId);
      else onRejectJoin?.(r.peerId);
      return;
    }
    if (status === 'accepted') {
      const ent = state.entities[r.payload?.entityId];
      if (r.kind === 'place_token') {
        // v8.5: place (or re-place) the player's token where they dropped it.
        const p = r.payload || {};
        const mapId = p.mapId || state.currentMapId;
        const existing = Object.values(state.tokens).find(t => t.entityId === p.entityId && t.mapId === mapId);
        if (existing) {
          dispatch({ type: 'TOKEN_MOVE', id: existing.id, x: p.x, y: p.y });
        } else {
          dispatch({ type: 'TOKEN_PLACE', token: { id: uid('tok_'), entityId: p.entityId, mapId, x: p.x, y: p.y, visible: true, scale: 1.0 } });
        }
        toast(`Placed ${p.entityName || ent?.name || 'token'}`, 'success');
        return;
      }
      if (ent && r.kind === 'stat_change') {
        const patch = { stats: { [r.payload.stat]: r.payload.to } };
        if (r.payload.stat === 'dex') patch.initBonus = Math.floor((r.payload.to - 10) / 2);
        dispatch({ type: 'ENTITY_PATCH', id: ent.id, patch });
      } else if (ent && r.kind === 'level_change') {
        const to = r.payload.to;
        const die = CLASS_HIT_DIE[ent.class];
        const patch = { level: to, proficiencyBonus: 2 + Math.floor((to - 1) / 4) };
        if (die) patch.hitDice = `${to}d${die}`;
        // On a level *up*, flag the PC so they can roll the new level's HP.
        if (to > r.payload.from && die) patch.awaitingHpRoll = { level: to, die };
        else patch.awaitingHpRoll = null;
        dispatch({ type: 'ENTITY_PATCH', id: ent.id, patch });
      }
    }
    toast(status === 'accepted' ? 'Request accepted' : 'Request declined', status === 'accepted' ? 'success' : 'info');
  };

  // v7.9/8.0: heal & condition requests resolve in the central popup; damage
  // requests now play the shared attack cinematic (AttackCinematicLayer).
  const ACTION_KINDS = ['apply_damage', 'apply_heal', 'apply_condition'];
  const otherReqs = pending.filter(r => !ACTION_KINDS.includes(r.kind));
  // v8.5: new-character and token-placement requests get a centered modal so
  // the DM can't miss them; stat/level tweaks stay as corner toasts.
  const CENTERED_KINDS = ['new_character', 'place_token', 'join_request'];
  const centeredReqs = otherReqs.filter(r => CENTERED_KINDS.includes(r.kind));
  const cornerReqs = otherReqs.filter(r => !CENTERED_KINDS.includes(r.kind));
  const popupReqs = pending.filter(r => r.kind === 'apply_heal' || r.kind === 'apply_condition');
  const activeAction = popupReqs[0] || null;
  const publicLog = (text) => dispatch({ type: 'CHAT_ADD', message: {
    id: uid('msg_'), ts: Date.now(), senderId: 'dm', senderName: '⚔ Combat', text, whisperTo: null, whisperToName: null } });
  const rejectAction = (r) => { dispatch({ type: 'REQUEST_RESOLVE', id: r.id, status: 'rejected' }); toast('Request declined', 'info'); };
  const applyAction = (r, variant) => {
    const p = r.payload || {};
    const tgt = state.entities[p.targetEntityId];
    if (!tgt) { dispatch({ type: 'REQUEST_RESOLVE', id: r.id, status: 'rejected' }); return; }
    dispatch({ type: 'REQUEST_RESOLVE', id: r.id, status: 'accepted' });
    if (r.kind === 'apply_condition') {
      if (!(tgt.conditions || []).includes(p.condition)) {
        dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: tgt.id, condition: p.condition });
      }
      publicLog(`${tgt.name} is now ${p.condition}.`);
      toast(`Applied ${p.condition} to ${tgt.name}`, 'success');
      return;
    }
    const comps = (Array.isArray(p.components) && p.components.length)
      ? p.components
      : [{ diceSum: p.diceSum || 0, flat: p.flat || 0, modifier: p.modifier || 0, type: p.damageType || '' }];
    const diceDmg = comps.reduce((a, c) => a + (c.diceSum || 0) + (c.flat || 0), 0);
    const mod = comps.reduce((a, c) => a + (c.modifier || 0), 0);
    if (r.kind === 'apply_heal') {
      const value = Math.max(0, diceDmg + mod);
      dispatch({ type: 'ENTITY_HP_ADJUST', id: tgt.id, delta: value });
      publicLog(`${tgt.name} is healed for ${value}.`);
      toast(`Healed ${tgt.name} for ${value}`, 'success');
      return;
    }
    let value, vlabel = '';
    if (variant === 'immune') { value = 0; vlabel = ' (immune)'; }
    else if (variant === 'weak') { value = Math.max(0, diceDmg * 2 + mod); vlabel = ' (vulnerable)'; }
    else if (variant === 'resist') { value = Math.max(0, Math.ceil((diceDmg + mod) / 2)); vlabel = ' (resisted)'; }
    else value = Math.max(0, diceDmg + mod);
    dispatch({ type: 'ENTITY_HP_ADJUST', id: tgt.id, delta: -value });
    const types = [...new Set(comps.map(c => c.type).filter(Boolean))];
    const tlabel = types.length ? ` ${types.join('/')}` : '';
    publicLog(`${tgt.name} takes ${value}${tlabel} damage${vlabel}.`);
    toast(`${tgt.name} takes ${value}${tlabel} damage`, 'success');
  };

  return ReactDOM.createPortal(
    <>
      {centeredReqs.length > 0 && (
        <div className="req-center-overlay">
          <div className="req-center-card">
            <div className="req-center-title">⚑ Player request{centeredReqs.length > 1 ? `s (${centeredReqs.length})` : ''}</div>
            {centeredReqs.map(r => {
              const s = requestSummary(state, r);
              const left = Math.max(0, Math.ceil((REQUEST_TTL_MS - (Date.now() - r.ts)) / 1000));
              return (
                <div key={r.id} className="req-center-row">
                  <div className="req-center-icon">{s.icon}</div>
                  <div className="req-center-body">
                    <div className="req-center-head">{s.title}</div>
                    <div className="req-center-who">{r.playerName}</div>
                    <div className="req-center-detail">{s.detail}</div>
                    <div className="req-card-timer">Auto-declines in {left}s</div>
                  </div>
                  <div className="req-center-actions">
                    <button className="btn sm primary" onClick={() => resolve(r, 'accepted')}>Accept</button>
                    <button className="btn sm danger" onClick={() => resolve(r, 'rejected')}>Refuse</button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      {cornerReqs.length > 0 && (
        <div className="req-overlay">
          {cornerReqs.map(r => {
            const s = requestSummary(state, r);
            const left = Math.max(0, Math.ceil((REQUEST_TTL_MS - (Date.now() - r.ts)) / 1000));
            return (
              <div key={r.id} className="req-card">
                <div className="req-card-head"><span className="req-icon">{s.icon}</span> {s.title}</div>
                <div className="req-card-who">{r.playerName}</div>
                <div className="req-card-detail">{s.detail}</div>
                <div className="req-card-timer">Auto-declines in {left}s</div>
                <div className="req-card-actions">
                  <button className="btn sm danger" onClick={() => resolve(r, 'rejected')}>Reject</button>
                  <button className="btn sm primary" onClick={() => resolve(r, 'accepted')}>Accept</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {activeAction && (
        <ActionRequestCard r={activeAction} state={state} onApply={applyAction} onReject={rejectAction} queued={popupReqs.length - 1} />
      )}
    </>,
    document.body
  );
}

// ====================================================================
// DM CLAIMS PANEL  (DM view of who has claimed what)
// ====================================================================
function DMClaimsPanel({ state, dispatch, sync, onClose, toast }) {
  const peers = Object.entries(state.claims || {});
  const allPeerIds = peers.map(([pid]) => pid);
  // v7.6: DM pushes a UI theme to a player (or everyone). Carries a stamp so
  // each push applies once on the client; the player can still re-choose.
  const pushTheme = (targets, theme, who) => {
    if (!targets.length) return;
    dispatch({ type: 'SET_PLAYER_THEME', targets, theme, ts: Date.now() });
    const label = theme ? (THEMES.find(t => t.id === theme)?.label || theme) : 'their own choice';
    toast(`Theme set to ${label} for ${who}`, 'success');
  };
  // v4 fix #5: DM kicks a peer. Also dispatches DM_KICK_PEER to clear
  // claims/reminders/bonds in the synced state.
  const kickPeer = (peerId, name) => {
    if (!confirm(`Kick ${name || 'this player'} from the session? This releases their claim and disconnects them.`)) return;
    try { sync?.kickPeer(peerId, 'The DM has removed you from the session.'); } catch {}
    dispatch({ type: 'DM_KICK_PEER', peerId });
    toast('Player removed', 'success');
  };
  return (
    <FloatPanel style={{ right: 16, top: 80, width: 360 }}>
      <div className="float-panel-header">
        <span>⚐ Claimed Characters</span>
        <button className="close-x" onClick={onClose}>×</button>
      </div>
      <div className="float-panel-body">
        {peers.length === 0 ? (
          <div className="empty-state"><span className="glyph">⚔</span>No players have joined yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="claim-theme-all">
              <span className="claim-theme-label">🎨 Set theme for everyone</span>
              <select className="claim-theme-select" value="__pick"
                onChange={(e) => { const v = e.target.value; if (v !== '__pick') pushTheme(allPeerIds, v === '__release' ? '' : v, 'all players'); }}>
                <option value="__pick">Choose…</option>
                {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                <option value="__release">↺ Release (player's choice)</option>
              </select>
            </div>
            {peers.map(([peerId, claim]) => {
              const pc = claim.pc ? state.entities[claim.pc] : null;
              return (
                <div key={peerId} className="claim-row">
                  <div className="claim-row-header">
                    <span className="claim-peer-name">{claim.playerName || <em style={{color:'var(--ink-mute)'}}>Unknown player</em>}</span>
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      {claim.spectator && <span className="claim-badge spectator">Spectator</span>}
                      {sync && (
                        <button className="btn sm danger" title="Kick player"
                          onClick={() => kickPeer(peerId, claim.playerName)}>
                          🚫 Kick
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="claim-peer-id mono">id: {peerId.slice(0, 12)}…</div>
                  <div className="claim-theme-row">
                    <span className="claim-theme-label">🎨 Theme</span>
                    <select className="claim-theme-select"
                      value={state.playerThemes?.[peerId]?.theme || ''}
                      onChange={(e) => pushTheme([peerId], e.target.value, claim.playerName || 'this player')}>
                      <option value="">- Player's choice -</option>
                      {THEMES.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
                    </select>
                  </div>
                  {pc ? (
                    <div className="claim-entity-row">
                      <div className="entity-swatch" style={{ background: pc.color, width: 12, height: 12 }} />
                      <span style={{ flex: 1, fontWeight: 500 }}>{pc.name}</span>
                      <span className="mono" style={{ color: 'var(--ink-mute)', fontSize: 11 }}>{pc.hp.current}/{pc.hp.max}</span>
                      <button className="btn sm danger" onClick={() => {
                        if (confirm(`Release ${pc.name} from this player?`)) {
                          dispatch({ type: 'DM_UNCLAIM_PC', entityId: pc.id });
                          toast('Claim released');
                        }
                      }}>Unclaim</button>
                    </div>
                  ) : !claim.spectator && (
                    <div className="claim-entity-row" style={{ color: 'var(--ink-mute)', fontStyle: 'italic' }}>No character claimed</div>
                  )}
                  {(claim.familiars || []).map(fid => {
                    const fam = state.entities[fid];
                    if (!fam) return null;
                    return (
                      <div key={fid} className="claim-entity-row" style={{ paddingLeft: 20 }}>
                        <div className="entity-swatch" style={{ background: fam.color, width: 10, height: 10 }} />
                        <span style={{ flex: 1, fontSize: 12 }}>{fam.name}</span>
                        <span className="familiar-badge">FAM</span>
                        <button className="btn sm ghost" onClick={() => {
                          if (confirm(`Release ${fam.name} from this player?`)) {
                            dispatch({ type: 'DM_UNCLAIM_FAMILIAR', entityId: fam.id });
                          }
                        }}>×</button>
                      </div>
                    );
                  })}
                  {/* v7.9: temporary control - lend another PC to this player */}
                  {!claim.spectator && (
                    <>
                      {(claim.controlledPcs || []).map(cid => {
                        const cp = state.entities[cid];
                        if (!cp) return null;
                        return (
                          <div key={cid} className="claim-entity-row" style={{ paddingLeft: 20 }}>
                            <div className="entity-swatch" style={{ background: cp.color, width: 10, height: 10 }} />
                            <span style={{ flex: 1, fontSize: 12 }}>{cp.name}</span>
                            <span className="familiar-badge loan-badge">LOAN</span>
                            <button className="btn sm ghost" title="Revoke control"
                              onClick={() => dispatch({ type: 'REVOKE_PC_CONTROL', peerId, entityId: cid })}>×</button>
                          </div>
                        );
                      })}
                      <select className="claim-loan-select" value=""
                        onChange={(e) => { if (e.target.value) { dispatch({ type: 'GRANT_PC_CONTROL', peerId, entityId: e.target.value }); toast('Temporary control granted'); } }}>
                        <option value="">+ Lend a character to control…</option>
                        {Object.values(state.entities)
                          .filter(e => e.type === 'PC' && e.id !== claim.pc && !(claim.controlledPcs || []).includes(e.id))
                          .map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
                      </select>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </FloatPanel>
  );
}

// ====================================================================
// BREADCRUMB
// ====================================================================
function Breadcrumb({ map, maps, onSwitch }) {
  const chain = [];
  let c = map;
  while (c) {
    chain.unshift(c);
    c = c.parentId ? maps[c.parentId] : null;
  }
  return (
    <div className="breadcrumb">
      {chain.map((m, i) => (
        <React.Fragment key={m.id}>
          {i > 0 && <span className="breadcrumb-sep">›</span>}
          <span
            className={`breadcrumb-item ${i === chain.length - 1 ? 'current' : ''}`}
            onClick={i === chain.length - 1 ? undefined : () => onSwitch(m.id)}
          >{m.name}</span>
        </React.Fragment>
      ))}
    </div>
  );
}

// ====================================================================
// TOKEN CONTEXT MENU  (v7.6) - right-click a token (DM) for a quick menu:
// compact damage/heal, hide/reveal, remove, and common status effects.
// ====================================================================
const CTX_QUICK_CONDITIONS = ['Prone', 'Poisoned', 'Stunned', 'Frightened', 'Restrained', 'On Fire', 'Blessed', 'Hasted', 'Concentrating', 'Hidden'];

function TokenContextMenu({ token, entity, x, y, dispatch, onClose, onOpenDetails, onEditEntity, onOpenSheet }) {
  const [amt, setAmt] = useState('');
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  // Clamp into the viewport once measured.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = x, top = y;
    if (left + r.width + pad > window.innerWidth) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height + pad > window.innerHeight) top = Math.max(pad, window.innerHeight - r.height - pad);
    setPos({ left, top });
  }, [x, y]);

  if (!token) return null;
  const conditions = entity?.conditions || [];

  const applyHp = (sign) => {
    const n = Math.abs(parseInt(amt, 10) || 0);
    if (!n || !entity) return;
    dispatch({ type: 'ENTITY_HP_ADJUST', id: entity.id, delta: sign * n });
    setAmt('');
    onClose();
  };
  const toggle = (c) => { if (entity) dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: entity.id, condition: c }); };

  return (
    <div
      ref={ref}
      className="token-ctx-menu"
      style={{ left: pos.left, top: pos.top }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <div className="token-ctx-header">
        <div className="entity-swatch" style={{ background: entity?.color, width: 10, height: 10 }} />
        <span>{entity?.name || 'Token'}</span>
        {entity && <span className="token-ctx-hp">{entity.hp.current}/{entity.hp.max}</span>}
      </div>

      {entity && (
        <div className="token-ctx-hprow">
          <button className="ctx-hp-btn dmg" onClick={() => applyHp(-1)} title="Apply damage">− Dmg</button>
          <input
            className="ctx-hp-input mono"
            type="number"
            value={amt}
            autoFocus
            placeholder="0"
            onChange={(e) => setAmt(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyHp(-1); if (e.key === 'Escape') onClose(); }}
          />
          <button className="ctx-hp-btn heal" onClick={() => applyHp(+1)} title="Apply healing">+ Heal</button>
        </div>
      )}

      {entity && (
        <div className="token-ctx-conds">
          {CTX_QUICK_CONDITIONS.map(c => (
            <button
              key={c}
              className={`ctx-cond ${conditions.includes(c) ? 'active' : ''}`}
              style={conditions.includes(c) ? { '--cc': (CONDITION_COLORS[c] || '#9b6ac4') } : undefined}
              onClick={() => toggle(c)}
              title={conditions.includes(c) ? `Remove ${c}` : `Apply ${c}`}
            >{c}</button>
          ))}
        </div>
      )}

      <div className="token-ctx-sep" />

      <button className="token-ctx-item" onClick={() => { dispatch({ type: 'TOKEN_VISIBILITY', id: token.id, visible: !token.visible }); onClose(); }}>
        <span className="ctx-icon">{token.visible ? '🕶' : '👁'}</span>
        {token.visible ? 'Hide from players' : 'Reveal to players'}
      </button>
      <button className="token-ctx-item" onClick={() => { onOpenDetails?.(token.id); onClose(); }}>
        <span className="ctx-icon">◈</span> Open details
      </button>
      {entity && onOpenSheet && (
        <button className="token-ctx-item" onClick={() => { onOpenSheet(entity.id); onClose(); }}>
          <span className="ctx-icon">📜</span> Character sheet
        </button>
      )}
      {entity && (
        <button className="token-ctx-item" onClick={() => { onEditEntity?.(entity); onClose(); }}>
          <span className="ctx-icon">✎</span> Edit entity
        </button>
      )}

      <div className="token-ctx-sep" />

      <button className="token-ctx-item danger" onClick={() => { if (confirm('Remove this token from the map?')) dispatch({ type: 'TOKEN_REMOVE', id: token.id }); onClose(); }}>
        <span className="ctx-icon">✕</span> Remove token
      </button>
    </div>
  );
}

// ====================================================================
// DM INTERFACE
// ====================================================================
// v8.4: hazard-damage resolution screen (DM). When tokens enter or start a
// turn in a damaging hazard, a rolled event is queued; the DM applies each per
// token with an optional weakness / resistance / immunity multiplier, or skips.
const HAZARD_GLYPHS = { fire: '🔥', flood: '🌊', cold: '❄', acid: '☣', fog: '☁', difficult: '⟁' };
function hazardFinalDamage(rolled, mult) {
  if (mult === 'immune') return 0;
  if (mult === 'weak') return rolled * 2;
  if (mult === 'resist') return Math.floor(rolled / 2);
  return rolled;
}
function HazardResolutionScreen({ state, dispatch, toast }) {
  const pending = state.hazardPending || [];
  const [mults, setMults] = useState({});
  if (!pending.length) return null;
  const applyEvent = (ev) => {
    const m = mults[ev.id] || 'normal';
    const dmg = hazardFinalDamage(ev.rolled, m);
    const target = state.entities[ev.entityId];
    if (target && dmg > 0) dispatch({ type: 'ENTITY_HP_ADJUST', id: ev.entityId, delta: -dmg });
    dispatch({ type: 'CHAT_ADD', message: { id: uid('msg_'), ts: Date.now(), senderId: 'dm', senderName: '⚠ Hazard',
      text: `${ev.entityName} takes ${dmg} ${ev.dmgType} from ${ev.hazardKind}${ev.reason === 'entry' ? ' (on entry)' : ' (turn start)'}${m !== 'normal' ? ` [${m}]` : ''}.`, whisperTo: null, whisperToName: null } });
    dispatch({ type: 'HAZARD_PENDING_REMOVE', id: ev.id });
    toast(`${ev.entityName}: ${dmg} ${ev.dmgType}`, 'warning');
  };
  const skipEvent = (ev) => dispatch({ type: 'HAZARD_PENDING_REMOVE', id: ev.id });
  return ReactDOM.createPortal(
    <div className="hazres-overlay">
      <div className="hazres-card">
        <div className="hazres-head">
          <span className="hazres-title">⚠ Hazard damage</span>
          <span className="hazres-count">{pending.length} pending</span>
        </div>
        <div className="hazres-sub">Resolve each token individually. Set weak / resist / immune, then apply or skip.</div>
        <div className="hazres-list">
          {pending.map(ev => {
            const m = mults[ev.id] || 'normal';
            const dmg = hazardFinalDamage(ev.rolled, m);
            return (
              <div key={ev.id} className="hazres-row">
                <div className="hazres-row-top">
                  <span className="hazres-who"><span className="hazres-dot" style={{ background: ev.entityColor }} />{ev.entityName}</span>
                  <span className="hazres-meta">{HAZARD_GLYPHS[ev.hazardKind] || '⚠'} {ev.hazardKind} · {ev.reason === 'entry' ? 'entered' : 'turn start'}</span>
                </div>
                <div className="hazres-dmg">rolled <b className="acin-glow-num">{ev.rolled}</b> {ev.dmgType} <span className="hazres-arrow">→</span> <b className="hazres-final">{dmg}</b></div>
                <div className="hazres-wri">
                  {[['normal', 'Normal'], ['weak', 'Weak'], ['resist', 'Resist'], ['immune', 'Immune']].map(([v, l]) => (
                    <button key={v} className={`acin-res-opt ${v} ${m === v ? 'on' : ''}`} onClick={() => setMults(s => ({ ...s, [ev.id]: v }))}>{l}</button>
                  ))}
                </div>
                <div className="hazres-actions">
                  <button className="btn sm primary" onClick={() => applyEvent(ev)}>Apply {dmg}</button>
                  <button className="btn sm ghost" onClick={() => skipEvent(ev)}>Skip</button>
                </div>
              </div>
            );
          })}
        </div>
        <div className="hazres-foot">
          <button className="btn sm" onClick={() => pending.forEach(applyEvent)}>Apply all</button>
          <button className="btn sm ghost danger" onClick={() => dispatch({ type: 'HAZARD_PENDING_CLEAR' })}>Skip all</button>
        </div>
      </div>
    </div>, document.body);
}

function DMInterface({ state, dispatch, sync, syncStatus, peerCount, peerList, onLogout, roomCode, toast, settings, onSettingsChange, onOpenSettings, showSettings, onCloseSettings }) {
  // v7 #10: hook into shared sound events so the DM hears what they
  // broadcast (and any sound that arrives via state sync).
  useSoundPlayback(state);
  const [editingEntity, setEditingEntity] = useState(null);
  const [dmSbCollapsed, setDmSbCollapsed] = useState(false); // v8.4: collapsible left panel
  const [hiddenLayers, setHiddenLayers] = useState(() => new Set()); // v8.6: DM layer visibility
  const [showLayers, setShowLayers] = useState(false);
  const toggleLayer = (k) => setHiddenLayers(prev => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [sheetEntityId, setSheetEntityId] = useState(null);
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  // v7.8 QoL: Escape dismisses the entity editor overlay.
  useEscClose(() => setEditingEntity(null), !!editingEntity);
  // v6 #12: multi-select. Shift-click to toggle, or drag-box on empty
  // canvas. Dragging any selected token moves the entire group,
  // preserving relative offsets. Independent from selectedTokenId
  // (single) - the detail panel still tracks that one.
  const [selectedTokenIds, setSelectedTokenIds] = useState(() => new Set());
  const [showInit, setShowInit] = useState(false);
  const [showMaps, setShowMaps] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  const [showClaims, setShowClaims] = useState(false);
  const [showWorld, setShowWorld] = useState(false);
  const [ctxMenu, setCtxMenu] = useState(null); // { tokenId, x, y }
  const [hoveredToken, setHoveredToken] = useState(null); // { tokenId, entityId }
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [placingReminder, setPlacingReminder] = useState(false);
  const [placingBlock, setPlacingBlock] = useState(false);
  const [placingFreeBlock, setPlacingFreeBlock] = useState(false);
  const [placingCircleBlock, setPlacingCircleBlock] = useState(false);
  const [erasingBlock, setErasingBlock] = useState(false);
  // v6 #11: measuring tool mode - null | 'line' | 'radius'
  const [measureMode, setMeasureMode] = useState(null);
  // v6 #10: drawing tool state (DM)
  const [drawMode, setDrawMode] = useState(null);
  const [drawColor, setDrawColor] = useState('#c9a34a');
  const [drawWidth, setDrawWidth] = useState(3);
  const [showDraw, setShowDraw] = useState(false);
  // v6 #9: hazards state (DM)
  const [placingHazard, setPlacingHazard] = useState(null);
  const [hazardVisibleDefault, setHazardVisibleDefault] = useState(true);
  const [showHazards, setShowHazards] = useState(false);
  // v7 #9: dice tray panel
  const [showDice, setShowDice] = useState(false);
  // v7 #10: soundboard panel
  const [showSounds, setShowSounds] = useState(false);
  // v7.3: token groups panel
  const [showGroups, setShowGroups] = useState(false);
  // v7.3: group hover highlight - which groupId is being hovered in
  // the panel. When set, we stamp data-group-highlight on member
  // token DOM elements via a small effect below.
  const [hoveredGroupId, setHoveredGroupId] = useState(null);
  const DM_KEY = 'dm'; // reminders key for DM ("peer id" substitute in local/hosted mode)

  const currentMapId = state.currentMapId;
  const currentMap = state.maps[currentMapId];
  const selectedToken = selectedTokenId ? state.tokens[selectedTokenId] : null;
  const selectedTokenEntity = selectedToken ? state.entities[selectedToken.entityId] : null;
  // v7.6: chat - names of tokens on the current map (DM "speak as" options),
  // the whisper recipient list, and the send handler.
  const chatTokenNames = useMemo(() => {
    const names = [], seen = new Set();
    for (const t of Object.values(state.tokens || {})) {
      if (t.mapId !== currentMapId) continue;
      const e = state.entities[t.entityId];
      // v7.9: the DM may voice NPCs/monsters but NOT player characters - a PC
      // belongs to its player, so it never appears in the DM's "speak as" list.
      if (e && e.name && e.type !== 'Label' && e.type !== 'PC' && !seen.has(e.name)) {
        seen.add(e.name); names.push(e.name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }, [state.tokens, state.entities, currentMapId]);
  const chatRecipients = useMemo(() => {
    const out = [];
    for (const [pid, claim] of Object.entries(state.claims || {})) {
      const display = displayNameForPeer(state, pid);
      const names = new Set();
      if (claim.pc && state.entities[claim.pc]?.name) names.add(state.entities[claim.pc].name);
      if (claim.playerName) names.add(claim.playerName);
      names.add(display);
      for (const n of names) out.push({ peerId: pid, name: n, display });
    }
    return out;
  }, [state.claims, state.entities]);
  const sendChat = useCallback(({ text, senderName, whisperTo, whisperToName }) => {
    dispatch({ type: 'CHAT_ADD', message: {
      id: uid('msg_'), ts: Date.now(), senderId: DM_KEY,
      senderName: senderName || 'Dungeon Master', text,
      whisperTo: whisperTo || null, whisperToName: whisperToName || null,
    } });
  }, [dispatch]);
  // v7.1 perf: memoize vision sources. The v7 code recomputed them on
  // every render of the DM interface - including when the user typed a
  // single character into an entity form. Now the walk only re-runs if
  // entities or tokens changed.
  const dmVisionSources = useMemo(
    () => computeVisionSources(state, currentMapId),
    [state.entities, state.tokens, currentMapId]
  );

  // v7.3 / v7.4: When the DM hovers a group row in the Groups panel,
  // stamp data-group-highlight="1" on each member token's DOM element
  // so the CSS can paint a dashed outline. Cleans up on unhover /
  // unmount.
  //
  // v7.4 fix: DON'T depend on state.tokens - that runs the DOM walk on
  // every token move, producing visible DM lag during drags. The group
  // highlight just needs to reflect the current group's memberIds; if
  // the panel hover state doesn't change and the group roster doesn't
  // change, there's no work to do. Read tokenGroups via a ref and run
  // only when hoveredGroupId changes (or the group is edited).
  const tokenGroupsRef = useRef(state.tokenGroups);
  tokenGroupsRef.current = state.tokenGroups;
  useEffect(() => {
    // Clear any previous stamps
    document.querySelectorAll('.token[data-group-highlight]')
      .forEach(el => el.removeAttribute('data-group-highlight'));
    if (!hoveredGroupId) {
      document.body.classList.remove('map-highlight-group');
      return;
    }
    const g = tokenGroupsRef.current?.[hoveredGroupId];
    if (!g) return;
    document.body.classList.add('map-highlight-group');
    for (const tid of (g.memberIds || [])) {
      const el = document.querySelector(`.token[data-tok="${tid}"]`);
      if (el) el.setAttribute('data-group-highlight', '1');
    }
    return () => {
      document.body.classList.remove('map-highlight-group');
      document.querySelectorAll('.token[data-group-highlight]')
        .forEach(el => el.removeAttribute('data-group-highlight'));
    };
  }, [hoveredGroupId]);

  // Track cursor for tooltip follow. Attached at the app-shell level.
  useEffect(() => {
    const onMove = (e) => setCursorPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const placeEntity = (entityId, x, y) => {
    const existing = Object.values(state.tokens).find(t => t.entityId === entityId && t.mapId === state.currentMapId);
    if (existing) {
      toast('Entity already placed on this map', 'error');
      return;
    }
    dispatch({
      type: 'TOKEN_PLACE',
      token: {
        id: uid('tok_'),
        entityId,
        mapId: state.currentMapId,
        x, y,
        visible: false, // new tokens default hidden
        scale: 1.0,
      }
    });
    toast('Token placed (hidden)', 'success');
  };

  // v6 #12: token move with group-move support. If the dragged token is
  // part of the multi-selection, translate all selected tokens by the
  // same delta (preserving relative offsets). Otherwise single-move.
  //
  // v7.2: ALSO fire an ephemeral 'token_pos' envelope to all connected
  // peers immediately. This bypasses the 120ms debounced state_update
  // so remote viewers see the token follow the cursor in real time.
  // The full state_update still arrives later for persistence + vision
  // recomputation on the peer side.
  const tokenMove = (tokenId, x, y) => {
    const draggedTok = state.tokens[tokenId];
    if (draggedTok && selectedTokenIds.size > 1 && selectedTokenIds.has(tokenId)) {
      const dx = x - draggedTok.x;
      const dy = y - draggedTok.y;
      const moves = [];
      for (const tid of selectedTokenIds) {
        const t = state.tokens[tid];
        if (!t) continue;
        moves.push({ id: tid, x: t.x + dx, y: t.y + dy });
      }
      dispatch({ type: 'TOKEN_MOVE_MANY', moves });
      // Broadcast each moved token. Multi-moves are rare so the
      // N-message burst is acceptable; we throttle per-token at the
      // sender (roughly one per animation frame) below.
      if (sync?.connections) {
        for (const m of moves) {
          const tok = state.tokens[m.id];
          if (!tok) continue;
          broadcastEphemeralMove(m.id, m.x, m.y, tok.mapId);
        }
      }
      return;
    }
    dispatch({ type: 'TOKEN_MOVE', id: tokenId, x, y });
    // v8.4: when the DM drags the creature whose combat turn it currently is
    // (a monster/NPC - PCs and familiars move via their owners), bank the
    // distance so its movement ring and remaining budget shrink like a
    // player's. The MapCanvas drag was already clamped to the remaining range.
    {
      const ent = draggedTok && state.entities[draggedTok.entityId];
      const init = state.initiative, mv = state.movement;
      const isActiveMonster = init?.active && ent && ent.type !== 'PC' && ent.type !== 'Familiar'
        && init.entries[init.turn]?.entityId === ent.id && mv?.entityId === ent.id;
      if (isActiveMonster) {
        const movedFt = Math.hypot(x - draggedTok.x, y - draggedTok.y) / PX_PER_FOOT;
        if (movedFt > 0.01) dispatch({ type: 'MOVEMENT_USE', addFt: movedFt });
      }
    }
    if (draggedTok && sync?.connections) {
      broadcastEphemeralMove(tokenId, x, y, draggedTok.mapId);
    }
  };

  // v7.2: ephemeral broadcast helper with per-token rAF-ish throttling
  // so we don't saturate the WebRTC channel during 60-fps drags. We
  // store the pending move in a ref; a single rAF coalesces multiple
  // moves to the same token within one frame into one send.
  const pendingEphemeralRef = useRef({});
  const broadcastEphemeralMove = useCallback((tokenId, x, y, mapId) => {
    pendingEphemeralRef.current[tokenId] = { x, y, mapId };
    // Drain on next animation frame. rAF coalesces naturally so even a
    // 60-fps pointermove stream produces at most one send per frame.
    if (!pendingEphemeralRef.current.__raf) {
      pendingEphemeralRef.current.__raf = requestAnimationFrame(() => {
        const pending = pendingEphemeralRef.current;
        pendingEphemeralRef.current = {};
        if (!sync?.connections) return;
        for (const [tid, pos] of Object.entries(pending)) {
          if (tid === '__raf') continue;
          for (const [, conn] of sync.connections) {
            if (conn?.open) {
              try {
                conn.send({ type: 'token_pos', tokenId: tid, x: pos.x, y: pos.y, mapId: pos.mapId });
              } catch {}
            }
          }
        }
      });
    }
  }, [sync]);

  // v6 #12: Click a token with shift held → toggle it in the multi-select
  // set. Without shift → clear the set and make that token the sole
  // selection (so you can start a new group from a click).
  const tokenSingleClick = (tokenId, e) => {
    const shift = e && (e.shiftKey || e.metaKey);
    setSelectedTokenIds(prev => {
      const next = new Set(prev);
      if (shift) {
        if (next.has(tokenId)) next.delete(tokenId);
        else next.add(tokenId);
      } else {
        next.clear();
        next.add(tokenId);
      }
      return next;
    });
  };

  // Escape clears the multi-selection. Watches window-level key events.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && selectedTokenIds.size > 0) {
        setSelectedTokenIds(new Set());
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTokenIds.size]);

  const tokenDoubleClick = (tokenId) => setSelectedTokenId(tokenId);
  const tokenContextMenu = (tokenId, e) => {
    setCtxMenu({ tokenId, x: e.clientX, y: e.clientY });
  };
  const closeCtxMenu = () => setCtxMenu(null);
  // Close context menu on any click elsewhere
  useEffect(() => {
    if (!ctxMenu) return;
    const onAny = () => closeCtxMenu();
    window.addEventListener('click', onAny);
    window.addEventListener('contextmenu', onAny);
    return () => {
      window.removeEventListener('click', onAny);
      window.removeEventListener('contextmenu', onAny);
    };
  }, [ctxMenu]);

  const revealAllOnMap = (visible) => {
    dispatch({ type: 'TOKEN_REVEAL_ALL_ON_MAP', mapId: state.currentMapId, visible });
    toast(visible ? 'All tokens revealed' : 'All tokens hidden');
  };

  const saveEntity = (entity) => {
    dispatch({ type: 'ENTITY_UPSERT', entity });
    setEditingEntity(null);
    toast('Entity saved', 'success');
  };

  const deleteCurrentEntity = () => {
    if (!editingEntity || !state.entities[editingEntity.id]) { setEditingEntity(null); return; }
    if (!confirm('Delete this entity? All tokens will be removed.')) return;
    dispatch({ type: 'ENTITY_DELETE', id: editingEntity.id });
    setEditingEntity(null);
    toast('Entity deleted');
  };

  // v4 fix #15: Clone an entity's full stat block. Reducer handles the
  // new id, " (copy)" suffix, order placement, and clears DM-private
  // state (death saves, bond).
  const duplicateCurrentEntity = () => {
    if (!editingEntity || !state.entities[editingEntity.id]) return;
    dispatch({ type: 'ENTITY_DUPLICATE', id: editingEntity.id });
    setEditingEntity(null);
    toast('Entity duplicated', 'success');
  };

  const onViewportChange = (mapId, viewport) => {
    dispatch({ type: 'MAP_VIEWPORT', id: mapId, viewport });
  };

  const pushView = () => {
    if (state.forcedView?.mapId === state.currentMapId) {
      dispatch({ type: 'FORCED_VIEW', forcedView: null });
      toast('Released player view control');
    } else {
      dispatch({ type: 'FORCED_VIEW', forcedView: { mapId: state.currentMapId } });
      toast('Players locked to this map', 'success');
    }
  };

  // v3: Long rest. Restores every PC + Familiar to full HP, clears
  // recoverable conditions, resets sickness to 0, resets death saves.
  const longRestAll = () => {
    if (!confirm('Long rest: restore all PCs + familiars to full HP, clear recoverable conditions, reset sickness and death saves?')) return;
    dispatch({ type: 'LONG_REST' });
    toast('The party rests. Wounds mend, fevers break.', 'success', 4000);
  };
  const longRestOne = (entityId) => {
    dispatch({ type: 'LONG_REST', entityIds: [entityId] });
    const e = state.entities[entityId];
    toast(`${e?.name || 'Character'} has rested.`, 'success');
  };
  // v7.5: Short rest - restores half of max HP only.
  const shortRestAll = () => {
    if (!confirm('Short rest: restore half of max HP to all PCs + familiars?')) return;
    dispatch({ type: 'SHORT_REST' });
    toast('The party catches its breath. Some wounds close.', 'success', 4000);
  };
  const shortRestOne = (entityId) => {
    dispatch({ type: 'SHORT_REST', entityIds: [entityId] });
    const e = state.entities[entityId];
    toast(`${e?.name || 'Character'} catches their breath.`, 'success');
  };

  const exportSession = () => {
    downloadJson(state, `plagues-call-session-${Date.now()}.json`);
    toast('Session exported', 'success');
  };

  const importSession = async () => {
    const result = await pickFile();
    if (!result) return;
    try {
      const data = JSON.parse(result.content);
      if (!confirm('This replaces your current session. Continue?')) return;
      dispatch({ type: 'REPLACE', payload: data });
      toast('Session imported', 'success');
    } catch {
      toast('Invalid session file', 'error');
    }
  };

  const myReminders = state.reminders?.[DM_KEY] || [];
  const reminderUpsert = (r) => dispatch({ type: 'REMINDER_UPSERT', peerId: DM_KEY, reminder: r });
  const reminderDelete = (id) => dispatch({ type: 'REMINDER_DELETE', peerId: DM_KEY, id });

  return (
    <div className="app-shell">
      <div className="topbar">
        <span className="mode-badge dm">⚔ Dungeon Master</span>
        <span className="topbar-title">{APP_NAME}</span>
        <div className="topbar-divider" />
        <button className="btn" onClick={() => setShowMaps(true)}>⌖ Maps</button>
        <button className={`btn ${showInit ? 'active' : ''}`} onClick={() => setShowInit(!showInit)}>⚔ Initiative</button>
        <button className="btn" onClick={() => setShowPresets(true)}>❈ Presets</button>
        <button className={`btn ${showClaims ? 'active' : ''}`} onClick={() => setShowClaims(!showClaims)}>⚐ Claims</button>
        <div className="topbar-divider" />
        <button className="btn" onClick={() => revealAllOnMap(true)}>👁 Reveal All</button>
        <button className="btn" onClick={() => revealAllOnMap(false)}>🕶 Hide All</button>
        <button className={`btn ${hiddenLayers.size > 0 ? 'active' : ''}`} onClick={() => setShowLayers(s => !s)} title="Show or hide whole map layers on your screen">▤ Layers{hiddenLayers.size > 0 ? ` (${hiddenLayers.size})` : ''}</button>
        {/* v7 #6: All map-mode + panel toggles consolidated under one
            🧰 Tools button. Active tool is shown in the trigger label. */}
        <ToolsMenu
          isDM={true}
          measureMode={measureMode} setMeasureMode={setMeasureMode}
          showDraw={showDraw} setShowDraw={setShowDraw}
          showDice={showDice} setShowDice={setShowDice}
          showSounds={showSounds} setShowSounds={setShowSounds}
          showHazards={showHazards} setShowHazards={setShowHazards}
          showGroups={showGroups} setShowGroups={setShowGroups}
          placingReminder={placingReminder} setPlacingReminder={setPlacingReminder}
          placingBlock={placingBlock} setPlacingBlock={setPlacingBlock}
          placingFreeBlock={placingFreeBlock} setPlacingFreeBlock={setPlacingFreeBlock}
          placingCircleBlock={placingCircleBlock} setPlacingCircleBlock={setPlacingCircleBlock}
          erasingBlock={erasingBlock} setErasingBlock={setErasingBlock}
        />
        <button className={`btn world-btn ${showWorld ? 'active' : ''}`}
          onClick={() => setShowWorld(!showWorld)}
          title="World: push view, time of day, block zones">
          {(() => {
            // v4 #1: live time-of-day glyph + label directly on the World btn
            const tod = state.timeOfDay || 0;
            let glyph = '☀', label = 'Day';
            if (tod >= 0.95) { glyph = '☾'; label = 'Deepest'; }
            else if (tod >= 0.70) { glyph = '☾'; label = 'Night'; }
            else if (tod >= 0.40) { glyph = '◐'; label = 'Dusk'; }
            else if (tod >= 0.15) { glyph = '◑'; label = 'Eve'; }
            return <span>🌍 {glyph} <span className="world-btn-label">{label}</span></span>;
          })()}
        </button>
        <button className="btn" onClick={longRestAll}
          title="Restore HP, clear conditions, reset sickness for all party members">
          ⛭ Long Rest
        </button>
        <button className="btn" onClick={shortRestAll}
          title="Restore half of max HP to all party members">
          ◑ Short Rest
        </button>
        <div className="topbar-spacer" />
        {roomCode && (
          <div className="conn-status">
            <div className={`conn-dot ${syncStatusClass(syncStatus)}`} />
            <span className="mono">{roomCode}</span>
            <span style={{ color: 'var(--ink-dim)' }}>· {peerCount} {peerCount === 1 ? 'player' : 'players'}</span>
          </div>
        )}
        <button className="btn" onClick={exportSession}>⇩ Export</button>
        <button className="btn" onClick={importSession}>⇧ Import</button>
        <button className="btn ghost" title="Settings" onClick={onOpenSettings}>⚙</button>
        <button className="btn ghost" onClick={onLogout}>⎋ Exit</button>
      </div>

      <div className={`main ${dmSbCollapsed ? 'dm-sb-collapsed' : ''}`}>
        <button className={`panel-toggle left ${dmSbCollapsed ? 'closed' : ''}`}
          title={dmSbCollapsed ? 'Show panel' : 'Hide panel'} onClick={() => setDmSbCollapsed(c => !c)}>
          {dmSbCollapsed ? '›' : '‹'}
        </button>
        <div className="sidebar">
          <EntitySidebar
            state={state}
            dispatch={dispatch}
            onEditEntity={setEditingEntity}
            onSelectEntity={setSelectedEntityId}
            selectedEntityId={selectedEntityId}
            onOpenSheet={(e) => setSheetEntityId(e.id)}
          />
        </div>

        <div className="canvas-container">
          <MapCanvas
            map={currentMap}
            entities={state.entities}
            tokens={state.tokens}
            initiative={state.initiative}
            mode="dm"
            onTokenMove={tokenMove}
            onTokenDoubleClick={tokenDoubleClick}
            onTokenContextMenu={tokenContextMenu}
            onPlaceEntity={placeEntity}
            hiddenLayers={hiddenLayers}
            onViewportChange={onViewportChange}
            selectedTokenId={selectedTokenId}
            selectedTokenIds={selectedTokenIds}
            onTokenSingleClick={tokenSingleClick}
            onSelectTokens={(ids) => setSelectedTokenIds(new Set(ids))}
            mapScale={state.mapScale || 1}
            movement={state.movement}
            moveRangeOpacity={settings?.moveRangeOpacity ?? 0.55}
            lockOffTurn={state.lockOffTurn}
            reminders={myReminders}
            onReminderUpsert={reminderUpsert}
            onReminderDelete={reminderDelete}
            placingReminder={placingReminder}
            onPlaceReminderDone={() => setPlacingReminder(false)}
            hoveredTokenId={hoveredToken?.tokenId}
            onTokenHoverChange={setHoveredToken}
            blockZones={state.blockZones?.[state.currentMapId] || []}
            placingBlock={placingBlock}
            onPlaceBlockDone={() => setPlacingBlock(false)}
            placingFreeBlock={placingFreeBlock}
            onPlaceFreeBlockDone={() => setPlacingFreeBlock(false)}
            placingCircleBlock={placingCircleBlock}
            onPlaceCircleBlockDone={() => setPlacingCircleBlock(false)}
            erasingBlock={erasingBlock}
            onPlaceEraseBlockDone={() => {/* keep eraser active across drags */}}
            measureMode={measureMode}
            onMeasureModeDone={() => setMeasureMode(null)}
            drawings={state.drawings?.[state.currentMapId] || []}
            drawMode={drawMode}
            drawColor={drawColor}
            drawWidth={drawWidth}
            drawOwner="dm"
            onDrawingUpsert={(d) => dispatch({ type: 'DRAWING_UPSERT', mapId: state.currentMapId, drawing: d })}
            onDrawingDelete={(id) => dispatch({ type: 'DRAWING_DELETE', mapId: state.currentMapId, id })}
            hazards={state.hazards?.[state.currentMapId] || []}
            placingHazard={placingHazard}
            hazardVisibleDefault={hazardVisibleDefault}
            onHazardUpsert={(h) => dispatch({ type: 'HAZARD_UPSERT', mapId: state.currentMapId, hazard: h })}
            onHazardDelete={(id) => dispatch({ type: 'HAZARD_DELETE', mapId: state.currentMapId, id })}
            layers={state.layers?.[state.currentMapId] || []}
            onLayerTransform={(id, patch) => dispatch({ type: 'LAYER_UPDATE', mapId: state.currentMapId, id, patch })}
            onPlaceHazardDone={() => setPlacingHazard(null)}
            onBlockUpsert={(zone) => dispatch({ type: 'BLOCK_ZONE_UPSERT', mapId: state.currentMapId, zone })}
            onBlockDelete={(id) => dispatch({ type: 'BLOCK_ZONE_DELETE', mapId: state.currentMapId, id })}
            visionSources={dmVisionSources}
          />

          <TokenTooltip hovered={hoveredToken} entities={state.entities} mode="dm" x={cursorPos.x} y={cursorPos.y} />

          {/* v7.5: visible feedback whenever a map mode tool is active. */}
          <ActiveToolBanner
            measureMode={measureMode}
            placingReminder={placingReminder}
            placingBlock={placingBlock}
            placingFreeBlock={placingFreeBlock}
            placingCircleBlock={placingCircleBlock}
            erasingBlock={erasingBlock}
            placingHazard={placingHazard}
            drawMode={drawMode}
            onDone={() => {
              setMeasureMode(null);
              setPlacingReminder(false);
              setPlacingBlock(false);
              setPlacingFreeBlock(false);
              setPlacingCircleBlock(false);
              setErasingBlock(false);
              setPlacingHazard(null);
              setDrawMode(null);
            }}
          />

          <div className="canvas-overlay top-left">
            <Breadcrumb map={currentMap} maps={state.maps} onSwitch={(id) => dispatch({ type: 'MAP_SWITCH', id })} />
          </div>

          {showInit && <InitiativeTracker state={state} dispatch={dispatch} mode="dm" onClose={() => setShowInit(false)} />}
          {showMaps && <MapManager state={state} dispatch={dispatch} onClose={() => setShowMaps(false)} toast={toast} />}
          {showPresets && <PresetsPanel state={state} dispatch={dispatch} onClose={() => setShowPresets(false)} toast={toast} />}
          {showLayers && (
            <FloatPanel style={{ right: 16, top: 80, width: 260 }}>
              <div className="float-panel-header">
                <span>▤ Map Layers</span>
                <button className="close-x" onClick={() => setShowLayers(false)}>×</button>
              </div>
              <div className="float-panel-body">
                <div className="settings-hint" style={{ marginBottom: 10 }}>
                  Hide whole layers on your own screen to reduce clutter. This does not change what players see.
                </div>
                {[
                  ['tokens', '♟ Tokens'],
                  ['hazards', '⚠ Hazards'],
                  ['walls', '▦ Walls & blocks'],
                  ['drawings', '✎ Drawings'],
                  ['reminders', '📌 Pins & reminders'],
                ].map(([k, label]) => (
                  <label key={k} className="layer-row">
                    <input type="checkbox" checked={!hiddenLayers.has(k)} onChange={() => toggleLayer(k)} />
                    <span>{label}</span>
                    <span className="layer-state">{hiddenLayers.has(k) ? 'hidden' : 'shown'}</span>
                  </label>
                ))}
              </div>
            </FloatPanel>
          )}
          {showClaims && <DMClaimsPanel state={state} dispatch={dispatch} sync={sync} onClose={() => setShowClaims(false)} toast={toast} />}
          <DMRequestsOverlay state={state} dispatch={dispatch} toast={toast}
            onApproveJoin={(pid) => {
              const held = heldPeersRef.current.get(pid);
              if (held?.playerId) approvedPeersRef.current.add(held.playerId); // v8.9: key on stable playerId
              heldPeersRef.current.delete(pid);
              // push current state to the freshly-admitted peer right away
              try {
                const conn = syncRef.current?.connections.get(pid);
                if (conn?.open) {
                  conn.send({ type: 'state_update', payload: {
                    ...stripHeavyAssetsForWire(filterStateForPlayer(stateRef.current, pid, settingsRef.current?.obfuscateHp === true)),
                    obfuscateHp: settingsRef.current?.obfuscateHp === true,
                physicalDice: settingsRef.current?.physicalDice === true,
                  } });
                }
              } catch {}
              toast('Player admitted', 'success');
            }}
            onRejectJoin={(pid) => {
              heldPeersRef.current.delete(pid);
              try { syncRef.current?.connections.get(pid)?.send({ type: 'kicked', reason: 'The DM did not admit you to this session.' }); } catch {}
              toast('Join request declined', 'info');
            }}
          />
          <AttackCinematicLayer state={state} dispatch={dispatch} isDM={true} toast={toast} physicalDice={settings?.physicalDice === true} />
          <HazardResolutionScreen state={state} dispatch={dispatch} toast={toast} />
          <ChatPanel messages={state.chat || []} isDM={true} myPeerId={DM_KEY}
            defaultName="Dungeon Master" tokensOnMap={chatTokenNames} recipients={chatRecipients} onSend={sendChat} />
          {showWorld && (
            <DMWorldPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowWorld(false)}
              placingBlock={placingBlock}
              placingFreeBlock={placingFreeBlock}
              placingCircleBlock={placingCircleBlock}
              erasingBlock={erasingBlock}
              onToggleBlockPlace={() => {
                setPlacingBlock(p => !p);
                setPlacingFreeBlock(false);
                setPlacingCircleBlock(false);
                setErasingBlock(false);
              }}
              onToggleFreeBlockPlace={() => {
                setPlacingFreeBlock(p => !p);
                setPlacingBlock(false);
                setPlacingCircleBlock(false);
                setErasingBlock(false);
              }}
              onToggleCircleBlockPlace={() => {
                setPlacingCircleBlock(p => !p);
                setPlacingBlock(false);
                setPlacingFreeBlock(false);
                setErasingBlock(false);
              }}
              onToggleEraseBlock={() => {
                setErasingBlock(p => !p);
                setPlacingBlock(false);
                setPlacingFreeBlock(false);
                setPlacingCircleBlock(false);
              }}
            />
          )}

          {showDraw && (
            <DrawingPanel
              state={state}
              onClose={() => setShowDraw(false)}
              drawMode={drawMode} setDrawMode={setDrawMode}
              drawColor={drawColor} setDrawColor={setDrawColor}
              drawWidth={drawWidth} setDrawWidth={setDrawWidth}
              onClearOwn={() => {
                dispatch({ type: 'DRAWING_CLEAR_OWNER', mapId: state.currentMapId, owner: 'dm' });
                toast('Cleared your drawings');
              }}
              onClearAll={() => {
                if (confirm('Clear ALL drawings on this map (including players\')?')) {
                  dispatch({ type: 'DRAWING_CLEAR_MAP', mapId: state.currentMapId });
                  toast('Cleared all drawings');
                }
              }}
              isDM={true}
            />
          )}

          {showHazards && (
            <HazardsPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowHazards(false)}
              placingHazard={placingHazard}
              setPlacingHazard={setPlacingHazard}
              hazardVisibleDefault={hazardVisibleDefault}
              setHazardVisibleDefault={setHazardVisibleDefault}
            />
          )}

          {showDice && (
            <DiceTray
              state={state}
              onClose={() => setShowDice(false)}
              myPeerId="dm"
              myName="DM"
              isDM={true}
              dispatch={dispatch}
              onRoll={(entry) => dispatch({ type: 'DICE_ROLL', entry })}
            />
          )}

          {showSounds && (
            <SoundboardPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowSounds(false)}
              isDM={true}
              peerList={peerList}
              onPlay={async (soundId, targetPeerId) => {
                let dataUrl = null, name = null;
                try {
                  const rec = await idbGet(IDB_STORES.sounds, soundId);
                  if (rec) { dataUrl = rec.dataUrl; name = rec.name; }
                } catch {}
                // Only dispatch a SOUND_EVENT for table-wide plays.
                // When targeting a specific peer, the sound_data envelope
                // is the sole delivery path - dispatching to state would
                // trigger useSoundPlayback on all connected players.
                if (!targetPeerId) {
                  dispatch({ type: 'SOUND_EVENT', event: {
                    id: uid('sev_'), ts: Date.now(), soundId, action: 'play', dataUrl, name,
                  }});
                }
                if (dataUrl) {
                  if (targetPeerId) {
                    sync.sendSoundDataTo(targetPeerId, soundId, name, dataUrl);
                  } else {
                    sync.sendSoundData(soundId, name, dataUrl);
                  }
                }
              }}
              onStop={(soundId) => {
                dispatch({ type: 'SOUND_EVENT', event: {
                  id: uid('sev_'), ts: Date.now(), soundId, action: 'stop',
                }});
              }}
            />
          )}

          {/* v7.3: Token groups panel */}
          {showGroups && (
            <GroupsPanel
              state={state}
              dispatch={dispatch}
              toast={toast}
              onClose={() => setShowGroups(false)}
              currentMapId={currentMapId}
              selectedTokenIds={selectedTokenIds}
              onHighlightGroupMembers={(groupId, on) => {
                setHoveredGroupId(on ? groupId : null);
              }}
            />
          )}

          {selectedToken && selectedTokenEntity && (
            <RadialTokenMenu
              state={state}
              token={selectedToken}
              entity={selectedTokenEntity}
              mode="dm"
              dispatch={dispatch}
              physicalDice={settings?.physicalDice === true}
              onLongRest={longRestOne}
              onShortRest={shortRestOne}
              onClose={() => setSelectedTokenId(null)}
            />
          )}
        </div>{/* /canvas-container */}

        {ctxMenu && (() => {
          const t = state.tokens[ctxMenu.tokenId];
          if (!t) return null;
          const ent = state.entities[t.entityId];
          return (
            <TokenContextMenu
              token={t}
              entity={ent}
              x={ctxMenu.x}
              y={ctxMenu.y}
              dispatch={dispatch}
              onClose={closeCtxMenu}
              onOpenDetails={(id) => setSelectedTokenId(id)}
              onEditEntity={(e) => setEditingEntity(e)}
              onOpenSheet={(id) => setSheetEntityId(id)}
            />
          );
        })()}

        {editingEntity && (
          <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setEditingEntity(null)}>
            <div className="modal slide-up">
              <div className="float-panel-header">
                <span>{state.entities[editingEntity.id] ? '✎ Edit Entity' : '＋ New Entity'}</span>
                <button className="close-x" onClick={() => setEditingEntity(null)}>×</button>
              </div>
              <div className="float-panel-body">
                <EntityForm
                  initial={editingEntity}
                  onSave={saveEntity}
                  onCancel={() => setEditingEntity(null)}
                />
                {state.entities[editingEntity.id] && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 6, justifyContent: 'space-between' }}>
                    <button className="btn" onClick={duplicateCurrentEntity} title="Create a copy of this entity">⎘ Duplicate</button>
                    <button className="btn danger" onClick={deleteCurrentEntity}>Delete Entity</button>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {sheetEntityId && state.entities[sheetEntityId] && (
        <DMSheetModal state={state} entityId={sheetEntityId} dispatch={dispatch} onClose={() => setSheetEntityId(null)} />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={onSettingsChange}
          onClose={onCloseSettings}
          mode="dm"
          mapScale={state.mapScale || 1}
          onMapScaleChange={(v) => dispatch({ type: 'MAP_SCALE_SET', scale: v })}
        />
      )}
    </div>
  );
}

// ====================================================================
// PARTY SIDEBAR (Player - left)
// ====================================================================
// Shows all PCs and Familiars with HP bars and conditions. Player's own
// characters (PC + claimed familiars) are visually distinguished. This
// never leaks hidden-enemy info because it only iterates PC/Familiar types.
function PartySidebar({ state, claimedEntityId, ownedFamiliarIds = [], currentMapId, onSelectPC }) {
  // v3: only include party members who have a token on the current map.
  // Players on other maps are elsewhere in the world and shouldn't clutter
  // the current-scene sidebar.
  const entityIdsOnMap = useMemo(() => {
    const s = new Set();
    for (const t of Object.values(state.tokens)) {
      if (t.mapId === currentMapId) s.add(t.entityId);
    }
    return s;
  }, [state.tokens, currentMapId]);

  const ownedFamiliarSet = new Set(ownedFamiliarIds);
  const isOwnedId = (id) => id === claimedEntityId || ownedFamiliarSet.has(id);

  // Party members on the current map, PLUS the player's own PC/familiars even
  // if they aren't placed yet (so they can be dragged onto the map to request
  // placement from the DM).
  const partyMembers = Object.values(state.entities)
    .filter(e => (e.type === 'PC' || e.type === 'Familiar') && (entityIdsOnMap.has(e.id) || isOwnedId(e.id)))
    // Maintain DM-set order for stable presentation
    .sort((a, b) => {
      const order = state.entityOrder || [];
      const ai = order.indexOf(a.id);
      const bi = order.indexOf(b.id);
      if (ai === -1 && bi === -1) return a.name.localeCompare(b.name);
      if (ai === -1) return 1;
      if (bi === -1) return -1;
      return ai - bi;
    });

  return (
    <div className="sidebar player-sidebar left">
      <div className="sidebar-section">
        <div className="sidebar-title">
          <span>⚜ The Party</span>
        </div>
      </div>
      <div className="sidebar-section grow">
        <div className="party-list">
          {partyMembers.length === 0 ? (
            <div className="empty-state"><span className="glyph">✦</span>No party members yet.</div>
          ) : partyMembers.map(e => {
            const hpPct = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
            const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
            const isYou = e.id === claimedEntityId || ownedFamiliarSet.has(e.id);
            const isFamiliar = e.type === 'Familiar';
            const isDown = e.hp.current <= 0;
            const onMap = entityIdsOnMap.has(e.id);
            const obfuscate = !!state.obfuscateHp;
            const label = obfuscate ? hpLabel(hpPct) : null;
            return (
              <div
                key={e.id}
                className={`party-card ${isYou ? 'you' : ''} ${isDown ? 'down' : ''} ${isFamiliar ? 'familiar-card' : ''} ${isYou ? 'draggable' : ''} ${isYou && !onMap ? 'offmap' : ''}`}
                draggable={isYou}
                onDragStart={isYou ? (ev) => {
                  ev.dataTransfer.setData('text/entity-id', e.id);
                  ev.dataTransfer.effectAllowed = 'copy';
                } : undefined}
                title={isYou ? (onMap ? 'Drag onto the map to request a new position' : 'Drag onto the map to request placement') : undefined}
                onClick={() => onSelectPC?.(e.id)}
              >
                <div className="party-avatar" style={{ background: e.color }}>
                  {e.imageUrl
                    ? <img src={e.imageUrl} alt="" draggable="false" />
                    : (e.name[0] || '?').toUpperCase()}
                </div>
                <div className="party-info">
                  <div className="party-name">
                    {e.name}
                    {isYou && e.id === claimedEntityId && <span className="own-pc-badge">YOU</span>}
                    {isYou && isFamiliar && <span className="familiar-badge">YOURS</span>}
                    {isFamiliar && !isYou && <span className="familiar-badge dim">FAM</span>}
                    {isYou && !onMap && <span className="offmap-badge" title="Not on this map yet">◍ place</span>}
                  </div>
                  <div className="party-meta mono">
                    {isFamiliar ? (e.faction ? `bond: ${e.faction}` : 'Familiar') : `L${e.level} ${e.class || ''}`}
                  </div>
                  <div className="party-hp-row">
                    {obfuscate
                      ? <span className={`party-hp-text mono ${label.cls}`} title="HP hidden by DM">{label.text}</span>
                      : <>
                          <div className="party-hp-bar">
                            <div className={`party-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} />
                          </div>
                          <span className={`party-hp-text mono ${hpClass}`}>{e.hp.current}/{e.hp.max}</span>
                        </>
                    }
                  </div>
                  {e.conditions.length > 0 && (
                    <div className="party-conditions">
                      {e.conditions.slice(0, 6).map(c => (
                        <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>
                          {c}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ====================================================================
// REVEALED MONSTERS SIDEBAR (Player - right)
// ====================================================================
// Lists monsters that have been revealed (visible tokens) to the player,
// showing the player-visible description and an approximate condition label.
// v8.6: a clean, read-focused summary of the player's own character for the
// narrow right dock - big clear numbers instead of the cramped full sheet.
function CompactSheet({ entity, onOpenFull }) {
  if (!entity) return <div className="empty-state"><span className="glyph">📜</span>No character to show.</div>;
  const hp = entity.hp || { current: 0, max: 0 };
  const hpPct = hp.max > 0 ? Math.max(0, Math.min(100, (hp.current / hp.max) * 100)) : 0;
  const hpClass = hpPct <= 25 ? 'critical' : hpPct <= 50 ? 'low' : '';
  const initB = entity.initBonus != null ? entity.initBonus : abilityMod(entity.stats?.dex);
  const fmt = (n) => (n >= 0 ? '+' : '') + n;
  const speeds = entity.speeds || {};
  const extraSpeeds = [['Fly', speeds.fly], ['Swim', speeds.swim], ['Climb', speeds.climb], ['Jump', speeds.jump]].filter(([, v]) => Number(v) > 0);
  return (
    <div className="csheet-compact">
      <div className="csc-name">{entity.name}</div>
      <div className="csc-sub">L{entity.level || 1} {entity.class || ''}{entity.race ? ` · ${entity.race}` : ''}</div>

      <div className="csc-hp">
        <div className="csc-hp-top"><span className="csc-hp-lbl">HIT POINTS</span><span className="csc-hp-num mono">{hp.current}<span className="csc-hp-max">/{hp.max}</span></span></div>
        <div className="csc-hp-bar"><div className={`csc-hp-fill ${hpClass}`} style={{ width: `${hpPct}%` }} /></div>
      </div>

      <div className="csc-vitals">
        <div className="csc-vital"><span className="csc-vital-lbl">AC</span><span className="csc-vital-val">{entity.ac ?? '-'}</span></div>
        <div className="csc-vital"><span className="csc-vital-lbl">INIT</span><span className="csc-vital-val">{fmt(initB)}</span></div>
        <div className="csc-vital"><span className="csc-vital-lbl">SPEED</span><span className="csc-vital-val">{walkSpeedOf(entity)}</span></div>
      </div>

      <div className="csc-ability-grid">
        {ABILITIES.map(a => {
          const score = entity.stats?.[a.toLowerCase()] ?? 10;
          return (
            <div key={a} className="csc-ab">
              <span className="csc-ab-name">{a}</span>
              <span className="csc-ab-mod">{fmt(abilityMod(score))}</span>
              <span className="csc-ab-score">{score}</span>
            </div>
          );
        })}
      </div>

      {extraSpeeds.length > 0 && (
        <div className="csc-speeds">
          {extraSpeeds.map(([lbl, v]) => <span key={lbl} className="csc-speed-chip">{lbl} {v}</span>)}
        </div>
      )}

      {(entity.conditions || []).length > 0 && (
        <div className="csc-conditions">
          {entity.conditions.map(c => (
            <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>{c}</span>
          ))}
        </div>
      )}

      {onOpenFull && <button className="btn sm csc-full-btn" onClick={onOpenFull}>◈ Open full sheet</button>}
    </div>
  );
}

function RevealedMonstersSidebar({ state, currentMapId, ownedEntityIds, view = 'revealed', setView, sheetNode = null, chatNode = null }) {
  // v3: scope to current map - a foe revealed in another scene should not
  // leak into the current scene's right panel.
  // v7.5: also respect passive hiding - a creature whose passiveHiding
  // exceeds the viewer's best passive perception stays off this list too.
  const viewerPP = useMemo(() => {
    let pp = 0;
    const ids = ownedEntityIds ? Array.from(ownedEntityIds) : [];
    for (const id of ids) {
      const e = state.entities[id];
      if (e && typeof e.passivePerception === 'number') pp = Math.max(pp, e.passivePerception);
    }
    return pp;
  }, [ownedEntityIds, state.entities]);

  const revealedFoes = useMemo(() => {
    const byId = new Map();
    for (const t of Object.values(state.tokens)) {
      if (!t.visible) continue;
      if (t.mapId !== currentMapId) continue;
      const ent = state.entities[t.entityId];
      if (!ent) continue;
      if (!['Monster', 'Neutral Beast', 'NPC'].includes(ent.type)) continue;
      const hide = ent.passiveHiding || 0;
      const owned = ownedEntityIds ? ownedEntityIds.has(ent.id) : false;
      if (hide > 0 && !owned && viewerPP < hide) continue;
      if (!byId.has(ent.id)) byId.set(ent.id, { entity: ent, tokens: [] });
      byId.get(ent.id).tokens.push(t);
    }
    return Array.from(byId.values());
  }, [state.tokens, state.entities, currentMapId, ownedEntityIds, viewerPP]);

  // v7.6: the description blurb under each revealed foe is collapsible
  // (default collapsed) so the panel stays compact.
  const [openDescs, setOpenDescs] = useState(() => new Set());
  const toggleDesc = (id) => setOpenDescs(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });

  return (
    <div className="sidebar player-sidebar right">
      <div className="sidebar-section">
        {setView ? (
          <div className="dock-tabs">
            <button className={`dock-tab ${view === 'revealed' ? 'active' : ''}`} onClick={() => setView('revealed')}>❖ Foes</button>
            <button className={`dock-tab ${view === 'sheet' ? 'active' : ''}`} onClick={() => setView('sheet')}>📜 Sheet</button>
            <button className={`dock-tab ${view === 'chat' ? 'active' : ''}`} onClick={() => setView('chat')}>✦ Chat</button>
          </div>
        ) : (
          <div className="sidebar-title"><span>❖ Revealed</span></div>
        )}
      </div>
      {view === 'sheet' ? (
        <div className="sidebar-section grow dock-sheet-scroll" style={{ overflow: 'auto', minHeight: 0 }}>
          {sheetNode || <div className="empty-state"><span className="glyph">📜</span>No character to show.</div>}
        </div>
      ) : view === 'chat' ? (
        <div className="sidebar-section grow" style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {chatNode || <div className="empty-state"><span className="glyph">✦</span>Chat unavailable.</div>}
        </div>
      ) : (
      <div className="sidebar-section grow">
        <div className="revealed-list">
          {revealedFoes.length === 0 ? (
            <div className="empty-state"><span className="glyph">❖</span>Nothing revealed yet.</div>
          ) : revealedFoes.map(({ entity: e, tokens }) => {
            const hpPct = e.hp.max > 0 ? (e.hp.current / e.hp.max) * 100 : 0;
            const status = hpPct <= 0 ? 'Down' : hpPct < 30 ? 'Waning' : hpPct <= 70 ? 'Rough' : 'Strong';
            const swatchClass = TOKEN_SHAPE_CLASS[e.type] || 'monster';
            return (
              <div key={e.id} className={`revealed-card revealed-type-${swatchClass}`}>
                <div className="revealed-header">
                  <div className={`entity-swatch ${swatchClass}`} style={{ background: e.color }} />
                  <div className="revealed-name">{e.name}</div>
                  <div className={`status-label status-${status.toLowerCase()}`}>{status}</div>
                </div>
                <div className="revealed-type-badge">{e.type}</div>
                {(() => {
                  const descOpen = openDescs.has(e.id);
                  const hasDesc = !!e.playerDescription;
                  return (
                    <>
                      <button className="revealed-desc-toggle" onClick={() => toggleDesc(e.id)} aria-expanded={descOpen}>
                        <span className="revealed-desc-chevron">{descOpen ? '▾' : '▸'}</span>
                        {descOpen ? 'Hide description' : 'Description'}
                      </button>
                      {descOpen && (
                        hasDesc ? (
                          <div className="revealed-desc">{e.playerDescription}</div>
                        ) : (
                          <div className="revealed-desc" style={{ fontStyle: 'italic', color: 'var(--ink-mute)' }}>
                            A creature of uncertain nature.
                          </div>
                        )
                      )}
                    </>
                  );
                })()}
                {e.conditions.length > 0 && (
                  <div className="revealed-conditions">
                    {e.conditions.map(c => (
                      <span key={c} className="party-cond-pill" style={{ background: CONDITION_COLORS[c] || '#555' }}>
                        {c}
                      </span>
                    ))}
                  </div>
                )}
                {tokens.length > 1 && (
                  <div style={{ fontSize: 10, color: 'var(--ink-mute)', marginTop: 4, fontStyle: 'italic' }}>
                    {tokens.length} on the field
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
}

// ====================================================================
// PLAYER INTERFACE
// ====================================================================
function PlayerInterface({ state, dispatch, myPeerId, playerName, sync, syncStatus, onLogout, roomCode, toast, settings, onSettingsChange, onOpenSettings, showSettings, onCloseSettings }) {
  // v7 #10: hook into shared sound events so the player hears whatever
  // the DM plays for the table.
  useSoundPlayback(state);
  const [selectedTokenId, setSelectedTokenId] = useState(null);
  const [pLeftCollapsed, setPLeftCollapsed] = useState(false); // v8.4: collapsible party panel
  const [pRightCollapsed, setPRightCollapsed] = useState(false); // v8.4: collapsible revealed panel
  const [rightView, setRightView] = useState('revealed'); // v8.5: right dock - revealed | sheet
  const [showInit, setShowInit] = useState(false);
  const [showClaim, setShowClaim] = useState(false);
  // v7.8 FIX: the new-character builder must also work from the main interface
  // (e.g. for a spectator the DM greenlit), not just the onboarding gate.
  const [builderDismissed, setBuilderDismissed] = useState(false);
  const [creatingChar, setCreatingChar] = useState(false);
  const [creatingPayload, setCreatingPayload] = useState(null);
  const [showSheet, setShowSheet] = useState(false); // dedicated "Edit My Sheet" modal
  // v7.8 QoL: Escape dismisses the claim picker overlay.
  useEscClose(() => setShowClaim(false), showClaim);
  const [sheetTab, setSheetTab] = useState('core'); // which sheet section the HUD opened
  const [hoveredToken, setHoveredToken] = useState(null);
  const [cursorPos, setCursorPos] = useState({ x: 0, y: 0 });
  const [placingReminder, setPlacingReminder] = useState(false);
  // v6 #11: measuring tool mode - null | 'line' | 'radius'
  const [measureMode, setMeasureMode] = useState(null);
  // v6 #10: drawing tool state (player)
  const [drawMode, setDrawMode] = useState(null);
  const [drawColor, setDrawColor] = useState('#5a8ec9');
  const [drawWidth, setDrawWidth] = useState(3);
  const [showDraw, setShowDraw] = useState(false);
  // v7 #9: dice tray (player)
  const [showDice, setShowDice] = useState(false);

  // v2: read claim record (pc + familiars + playerName + spectator)
  const myClaim = state.claims?.[myPeerId] || { pc: null, familiars: [], playerName: '', spectator: false };

  // v7.8: notify the player when the DM resolves one of their requests.
  const notifiedReqs = useRef(new Set());
  useEffect(() => {
    for (const r of Object.values(state.pendingRequests || {})) {
      if (r.peerId !== myPeerId) continue;
      if ((r.status === 'accepted' || r.status === 'rejected') && !notifiedReqs.current.has(r.id + r.status)) {
        notifiedReqs.current.add(r.id + r.status);
        const what = r.kind === 'new_character' ? 'New character'
          : r.kind === 'level_change' ? `Level → ${r.payload?.to}`
          : `${String(r.payload?.stat || '').toUpperCase()} → ${r.payload?.to}`;
        toast(r.status === 'accepted' ? `✓ DM approved: ${what}` : `✗ DM declined: ${what}`,
          r.status === 'accepted' ? 'success' : 'error');
      }
    }
  }, [state.pendingRequests, myPeerId, toast]);
  const claimedEntityId = myClaim.pc || null;
  const claimedEntity = claimedEntityId ? state.entities[claimedEntityId] : null;
  const claimedFamiliarIds = myClaim.familiars || [];
  const hasMadeChoice = !!claimedEntityId || myClaim.spectator || claimedFamiliarIds.length > 0;
  // v7.8 FIX: surface the player's own new-character request/grant so the
  // builder and request controls work outside the onboarding gate too.
  const myNewCharReq = Object.values(state.pendingRequests || {}).find(
    r => r.peerId === myPeerId && r.kind === 'new_character');
  const newCharStatus = myNewCharReq?.status || null; // null|pending|accepted|rejected
  const newCharGranted = newCharStatus === 'accepted';
  const showBuilderOverlay = newCharGranted && !claimedEntityId && !builderDismissed;
  // Set of entity IDs the player is allowed to move/edit
  const ownedEntityIds = useMemo(() => {
    const s = new Set(claimedFamiliarIds);
    if (claimedEntityId) s.add(claimedEntityId);
    return s;
  }, [claimedEntityId, claimedFamiliarIds]);

  // v7.6: the DM can push a UI theme to this player. Each push carries a
  // timestamp; we apply it exactly once (so the player can still change
  // their own theme afterwards, and a fresh push re-applies it).
  const dmThemeTsRef = useRef(0);
  useEffect(() => {
    const pt = state.playerThemes?.[myPeerId];
    if (pt && pt.theme && pt.ts && pt.ts > dmThemeTsRef.current) {
      dmThemeTsRef.current = pt.ts;
      onSettingsChange?.({ theme: pt.theme });
    }
  }, [state.playerThemes, myPeerId, onSettingsChange]);

  // v3: resolve owned entities for the vision-enable check. Derives from
  // ownedEntityIds so it stays consistent with movement permissions and
  // bonded familiars.
  const visionOwned = useMemo(
    () => Array.from(ownedEntityIds).map(id => state.entities[id]).filter(Boolean),
    [ownedEntityIds, state.entities]
  );

  // v2: sickness visual filter. Only the player's own PC's sickness counts.
  const sicknessLevel = claimedEntity?.sickness || 0;

  const currentMapId = state.forcedView?.mapId || state.currentMapId;
  const currentMap = state.maps[currentMapId];
  const isForced = !!state.forcedView;

  const selectedToken = selectedTokenId ? state.tokens[selectedTokenId] : null;
  const selectedTokenEntity = selectedToken ? state.entities[selectedToken.entityId] : null;

  // v7.1 perf: memoize vision sources so they don't recompute on every
  // render (token drag, hover state change, etc.)
  const tod = state.timeOfDay || 0;
  const mapAlwaysDark = !!currentMap?.alwaysDark;
  const playerVisionSources = useMemo(
    () => {
      if (!DEBUG) return computePlayerVisionSources(state, currentMapId, ownedEntityIds, tod, mapAlwaysDark);
      const t0 = performance.now();
      const res = computePlayerVisionSources(state, currentMapId, ownedEntityIds, tod, mapAlwaysDark);
      const elapsed = performance.now() - t0;
      if (elapsed > 16) dlog(`[plagues-call] vision recompute: ${elapsed.toFixed(0)}ms (${res.length} sources)`);
      return res;
    },
    [state.entities, state.tokens, currentMapId, ownedEntityIds, tod, mapAlwaysDark]
  );

  // Track cursor for hover tooltip
  useEffect(() => {
    const onMove = (e) => setCursorPos({ x: e.clientX, y: e.clientY });
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  const tokenMove = (tokenId, x, y) => {
    const token = state.tokens[tokenId];
    if (!token) {
      dlog(`[plagues-call] player tokenMove REJECT: no token ${tokenId.slice(-6)}`);
      return;
    }
    const entity = state.entities[token.entityId];
    if (!entity || !ownedEntityIds.has(entity.id)) {
      dlog(`[plagues-call] player tokenMove REJECT: not owned ${tokenId.slice(-6)} entity=${entity?.name} ownedIds=[${[...ownedEntityIds].map(id => id.slice(-6)).join(',')}]`);
      toast('You may only move your own characters', 'error');
      return;
    }
    dlog(`[plagues-call] player tokenMove OK token=${tokenId.slice(-6)} → (${x.toFixed(0)}, ${y.toFixed(0)})`);
    // v7.2 PERFORMANCE FIX: optimistic local dispatch. Update the
    // player's own token position immediately so their vision circle,
    // light radius, and all derived UI update without waiting for the
    // full DM round-trip (which was the 3-4 second lighting lag).
    // The DM remains authoritative - if for any reason the DM rejects
    // the move, the next state_update will correct it.
    dispatch({ type: 'TOKEN_MOVE_EPHEMERAL', tokenId, x, y, mapId: token.mapId });
    // v8.4: optimistically bank the distance travelled so the "remaining
    // movement" readout updates immediately, instead of lagging a full DM
    // round-trip behind the token. The DM stays authoritative: the next
    // state_update reconciles usedFt to the server's clamped value.
    {
      const mv = state.movement, init = state.initiative;
      const isActiveTurn = init?.active && init.entries[init.turn]?.entityId === entity.id;
      if (isActiveTurn && mv && mv.entityId === entity.id) {
        const movedFt = Math.hypot(x - token.x, y - token.y) / PX_PER_FOOT;
        if (movedFt > 0.01) dispatch({ type: 'MOVEMENT_USE', addFt: movedFt });
      }
    }
    // Then send the authoritative action to the DM for persistence
    // + broadcast to all other peers.
    const sent = sync.sendPlayerAction({
      type: 'move_token',
      payload: { tokenId, x, y },
      peerId: myPeerId,
    });
    dlog(`[plagues-call] sendPlayerAction(move_token) returned ${sent} dmConn.open=${sync?.dmConnection?.open}`);
  };

  const tokenDoubleClick = (tokenId) => setSelectedTokenId(tokenId);

  // Player-action sender used by TokenDetailPanel/EditMySheet for own-entity writes
  const playerActionSender = useCallback((action) => {
    if (!sync) return;
    sync.sendPlayerAction({ ...action, peerId: myPeerId });
  }, [sync, myPeerId]);

  // Reminder helpers - reminders are stored per-peer, so we route
  // create/delete through the DM-authoritative action pipeline.
  const myReminders = state.reminders?.[myPeerId] || [];
  const reminderUpsert = (r) => {
    playerActionSender({ type: 'reminder_upsert', payload: { reminder: r } });
  };
  const reminderDelete = (id) => {
    playerActionSender({ type: 'reminder_delete', payload: { id } });
  };

  // v7.2: Claim button lock. Mobile devices were reporting duplicate
  // claims from double-taps, and with the slow round-trip that existed
  // in v7 it was easy to think the first tap "didn't register" and
  // tap again. The DM will accept only the first one anyway, but the
  // UI should lock out rapid repeat taps and give immediate feedback.
  const [claimLocked, setClaimLocked] = useState(false);
  const claimLockTimerRef = useRef(null);
  const withClaimLock = (fn) => {
    if (claimLocked) {
      toast('Claim in progress…', 'info');
      return;
    }
    setClaimLocked(true);
    fn();
    if (claimLockTimerRef.current) clearTimeout(claimLockTimerRef.current);
    // Unlock after 2s. If the DM accepts the claim, the state_update
    // will re-render and this button goes away anyway. The 2s window
    // is a safety release in case the network drops the request.
    claimLockTimerRef.current = setTimeout(() => setClaimLocked(false), 2000);
  };
  useEffect(() => () => {
    if (claimLockTimerRef.current) clearTimeout(claimLockTimerRef.current);
  }, []);

  const claimPC = (entityId) => withClaimLock(() => {
    const t0 = performance.now();
    sync.sendPlayerAction({
      type: 'claim_pc',
      payload: { entityId, playerName },
      peerId: myPeerId,
    });
    dlog(`[plagues-call] claim_pc sent for ${entityId.slice(-6)} (${(performance.now() - t0).toFixed(0)}ms)`);
    setShowClaim(false);
    toast('Requesting character…', 'success');
  });

  const claimFamiliar = (entityId) => withClaimLock(() => {
    sync.sendPlayerAction({
      type: 'claim_familiar',
      payload: { entityId, playerName },
      peerId: myPeerId,
    });
    toast('Requesting familiar…', 'success');
  });

  const unclaimFamiliar = (entityId) => {
    sync.sendPlayerAction({
      type: 'unclaim_familiar',
      payload: { entityId },
      peerId: myPeerId,
    });
  };

  const claimSpectator = () => withClaimLock(() => {
    sync.sendPlayerAction({
      type: 'claim_spectator',
      payload: { playerName },
      peerId: myPeerId,
    });
    setShowClaim(false);
  });

  // v7.8 FIX: request / build a new character from anywhere (incl. spectator).
  const requestNewCharacter = () => {
    setBuilderDismissed(false);
    playerActionSender({ type: 'submit_request', payload: { kind: 'new_character' } });
    toast('Requested a new character. Waiting for the DM to approve…', 'info', 4500);
  };
  const createNewCharacter = (payload) => {
    setCreatingChar(true);
    setCreatingPayload(payload);
    clearCreation();
    playerActionSender({ type: 'create_and_claim_pc', payload });
    toast(`Creating ${payload.name}…`, 'success');
  };
  // Re-send create until the claim lands (a missed sync shouldn't strand the
  // player on a spinner); release the spinner once the PC is claimed or on a
  // safety timeout so the builder reappears for another try.
  useEffect(() => {
    if (!creatingChar) return;
    if (claimedEntityId) { setCreatingChar(false); setCreatingPayload(null); return; }
    const iv = setInterval(() => {
      if (creatingPayload) playerActionSender({ type: 'create_and_claim_pc', payload: creatingPayload });
    }, TUNING.claimResendMs || 2500);
    const giveUp = setTimeout(() => setCreatingChar(false), TUNING.claimGiveUpMs || 12000);
    return () => { clearInterval(iv); clearTimeout(giveUp); };
  }, [creatingChar, claimedEntityId, creatingPayload, playerActionSender]);
  // Build the topbar control reflecting request state (for non-PC players).
  const newCharControl = !claimedEntityId ? (
    newCharStatus === 'pending' ? (
      <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>⏳ Awaiting DM…</span>
    ) : newCharGranted ? (
      <button className="btn sm primary" onClick={() => setBuilderDismissed(false)}>✨ Create character</button>
    ) : (
      <button className="btn sm" onClick={requestNewCharacter}>✨ New character</button>
    )
  ) : null;

  const unclaimPC = () => {
    sync.sendPlayerAction({
      type: 'unclaim_pc',
      payload: {},
      peerId: myPeerId,
    });
  };

  // Already-claimed IDs across all peers (used to filter the claim modal list)
  const allClaimedPCIds = new Set(
    Object.values(state.claims || {}).map(c => c.pc).filter(Boolean)
  );
  const allClaimedFamiliarIds = new Set(
    Object.values(state.claims || {}).flatMap(c => c.familiars || [])
  );
  const unclaimedPCs = Object.values(state.entities).filter(e => {
    if (e.type !== 'PC') return false;
    return !allClaimedPCIds.has(e.id);
  });
  const availableFamiliars = Object.values(state.entities).filter(e => {
    if (e.type !== 'Familiar') return false;
    return !allClaimedFamiliarIds.has(e.id);
  });

  // Player-action sender already defined above at the top of this component.
  // (Previously there was a duplicate definition here - removed.)

  // Clicking a party card opens the detail panel for that PC's token
  // (only if it has one on the current map; otherwise focus the claimed PC).
  const selectPCById = (entityId) => {
    const tok = Object.values(state.tokens).find(t => t.entityId === entityId);
    if (tok) setSelectedTokenId(tok.id);
  };

  // ==========================================================
  // Forced onboarding: until the player has claimed a PC,
  // requested one, or chosen spectator mode, we render an
  // overlay gate so they can't interact with the map.
  // ==========================================================
  if (!hasMadeChoice && syncStatus === 'live') {
    return (
      <div className="app-shell">
        <div className="topbar">
          <span className="mode-badge player">⌂ Player</span>
          <span className="topbar-title">{APP_NAME}</span>
          <div className="topbar-spacer" />
          <div className="conn-status">
            <div className="conn-dot live" />
            <span className="mono">{roomCode}</span>
            <span style={{ color: 'var(--ink-dim)' }}>· {playerName}</span>
          </div>
          <button className="btn ghost" onClick={onLogout}>⎋ Leave</button>
        </div>
        <PlayerOnboardingGate
          state={state}
          myPeerId={myPeerId}
          playerName={playerName}
          playerActionSender={playerActionSender}
          onRequestNewPC={() => toast('Please ask your DM to create a character for you.', 'info', 5000)}
          obfuscateHp={state.obfuscateHp}
        />
      </div>
    );
  }

  const effectsEnabled = settings.sicknessEffects !== false;
  const sicknessWobbleClass = effectsEnabled && sicknessLevel >= 2 ? `sickness-wobble-${Math.min(sicknessLevel, 3)}` : '';

  return (
    <div className={`app-shell ${sicknessWobbleClass}`}>
      {effectsEnabled && sicknessLevel >= 3 && <div className="sickness-vignette" />}
      <div className="topbar">
        <span className="mode-badge player">⌂ Player</span>
        <span className="topbar-title">{APP_NAME}</span>
        <div className="topbar-divider" />
        {claimedEntity ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div className="entity-swatch" style={{ background: claimedEntity.color, width: 12, height: 12 }} />
            <span style={{ fontSize: 13, fontWeight: 500 }}>{claimedEntity.name}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
              {state.obfuscateHp
                ? hpLabel(claimedEntity.hp.max > 0 ? claimedEntity.hp.current / claimedEntity.hp.max * 100 : 0).text + ' HP'
                : `${claimedEntity.hp.current}/${claimedEntity.hp.max} HP`}
            </span>
            <div className="hud-sheet-tabs" title="Open your character sheet">
              {(claimedEntity.type === 'PC'
                ? [['core', '◆', 'Core'], ['combat', '⚔', 'Combat'], ['spells', '✦', 'Spells'], ['gear', '🜚', 'Gear'], ['story', '❧', 'Story']]
                : [['core', '◆', 'Core'], ['combat', '⚔', 'Combat'], ['gear', '🜚', 'Gear'], ['story', '❧', 'Story']]
              ).map(([key, icon, label]) => (
                <button key={key} className="btn sm hud-sheet-tab"
                  onClick={() => { setSheetTab(key); setShowSheet(true); }}
                  title={`Open ${label}`}>
                  <span className="hud-sheet-icon">{icon}</span> {label}
                </button>
              ))}
            </div>
            {/* v7.1: Give players a way to claim a familiar even after
                they've claimed a PC. This button was missing in v7, so
                familiars were only reachable from the initial claim
                modal - by the time a player had a PC, there was no UI
                entry point. Shown only when unclaimed familiars exist
                OR the player already has familiars (so they can manage). */}
            {(availableFamiliars.length > 0 || (myClaim.familiars || []).length > 0) && (
              <button className="btn sm" onClick={() => setShowClaim(true)}
                title="Claim or release a familiar">
                ✦ Familiar{(myClaim.familiars || []).length > 0 ? `s (${myClaim.familiars.length})` : ''}
              </button>
            )}
            <button className="btn sm ghost" onClick={unclaimPC}>Release</button>
          </div>
        ) : myClaim.spectator ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="mono" style={{ fontSize: 12, color: 'var(--ink-dim)' }}>👁 Spectator mode</span>
            <button className="btn sm" onClick={() => setShowClaim(true)}>⚐ Claim Character</button>
            {newCharControl}
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn primary" onClick={() => setShowClaim(true)}>⚐ Claim Character</button>
            {newCharControl}
          </div>
        )}
        <div className="topbar-divider" />
        <button className={`btn ${showInit ? 'active' : ''}`} onClick={() => setShowInit(!showInit)}>⚔ Initiative</button>
        {/* v7 #6: Players get a stripped-down ToolsMenu - no DM-only
            block / hazard / soundboard items. */}
        <ToolsMenu
          isDM={false}
          measureMode={measureMode} setMeasureMode={setMeasureMode}
          showDraw={showDraw} setShowDraw={setShowDraw}
          showDice={showDice} setShowDice={setShowDice}
          placingReminder={placingReminder} setPlacingReminder={setPlacingReminder}
        />
        <div className="topbar-spacer" />
        <div className="conn-status">
          <div className={`conn-dot ${syncStatusClass(syncStatus)}`} />
          <span className="mono">{roomCode}</span>
          <span style={{ color: 'var(--ink-dim)' }}>· {playerName}</span>
        </div>
        <button className="btn ghost" title="Settings" onClick={onOpenSettings}>⚙</button>
        <button className="btn ghost" onClick={onLogout}>⎋ Leave</button>
      </div>

      <div className={`main player-view ${pLeftCollapsed ? 'pleft-collapsed' : ''} ${pRightCollapsed ? 'pright-collapsed' : ''}`}>
        <button className={`panel-toggle pleft ${pLeftCollapsed ? 'closed' : ''}`}
          title={pLeftCollapsed ? 'Show party' : 'Hide party'} onClick={() => setPLeftCollapsed(c => !c)}>
          {pLeftCollapsed ? '›' : '‹'}
        </button>
        <button className={`panel-toggle pright ${pRightCollapsed ? 'closed' : ''}`}
          title={pRightCollapsed ? 'Show revealed' : 'Hide revealed'} onClick={() => setPRightCollapsed(c => !c)}>
          {pRightCollapsed ? '‹' : '›'}
        </button>
        <PartySidebar
          state={state}
          claimedEntityId={claimedEntityId}
          ownedFamiliarIds={claimedFamiliarIds}
          currentMapId={currentMapId}
          onSelectPC={selectPCById}
        />

        <div className={`canvas-container sick-level-${sicknessLevel} tod-${Math.round((state.timeOfDay || 0) * 10)} ${claimedEntity && claimedEntity.hp.current <= 0 ? 'downed' : ''}`}>
          <MapCanvas
            map={currentMap}
            entities={state.entities}
            tokens={state.tokens}
            initiative={state.initiative}
            mode="player"
            peerId={myPeerId}
            claimedEntityId={claimedEntityId}
            ownedEntityIds={ownedEntityIds}
            onTokenMove={tokenMove}
            onTokenDoubleClick={tokenDoubleClick}
            onPlaceEntity={() => {}}
            onPlaceRequest={(entityId, x, y) => {
              if (!ownedEntityIds.has(entityId)) return;
              playerActionSender({ type: 'submit_request', payload: { kind: 'place_token', data: { entityId, x, y, mapId: currentMapId } } });
              toast('Token placement requested - awaiting the DM', 'info', 4000);
            }}
            onViewportChange={() => {}}
            selectedTokenId={selectedTokenId}
            mapScale={state.mapScale || 1}
            movement={state.movement}
            moveRangeOpacity={settings?.moveRangeOpacity ?? 0.55}
            lockOffTurn={state.lockOffTurn}
            reminders={myReminders}
            onReminderUpsert={reminderUpsert}
            onReminderDelete={reminderDelete}
            placingReminder={placingReminder}
            onPlaceReminderDone={() => setPlacingReminder(false)}
            hoveredTokenId={hoveredToken?.tokenId}
            onTokenHoverChange={setHoveredToken}
            blockZones={state.blockZones?.[currentMapId] || []}
            visionEnabled={!!(currentMap?.alwaysDark) || (state.timeOfDay || 0) >= 0.5}
            visionSources={playerVisionSources}
            measureMode={measureMode}
            onMeasureModeDone={() => setMeasureMode(null)}
            drawings={state.drawings?.[currentMapId] || []}
            drawMode={drawMode}
            drawColor={drawColor}
            drawWidth={drawWidth}
            drawOwner={myPeerId}
            onDrawingUpsert={(d) => playerActionSender({ type: 'drawing_upsert', payload: { mapId: currentMapId, drawing: d } })}
            onDrawingDelete={(id) => playerActionSender({ type: 'drawing_delete', payload: { mapId: currentMapId, id } })}
            hazards={state.hazards?.[currentMapId] || []}
            layers={state.layers?.[currentMapId] || []}
            onLayerTransform={(id, patch) => playerActionSender({ type: 'layer_transform', payload: { mapId: currentMapId, id, patch } })}
          />

          <TokenTooltip hovered={hoveredToken} entities={state.entities} mode="player"
            x={cursorPos.x} y={cursorPos.y}
            obfuscateHp={state.obfuscateHp}
            ownedEntityIds={ownedEntityIds} />

          {/* v7.5: same active-tool feedback for players (measure / reminder / draw). */}
          <ActiveToolBanner
            measureMode={measureMode}
            placingReminder={placingReminder}
            drawMode={drawMode}
            onDone={() => {
              setMeasureMode(null);
              setPlacingReminder(false);
              setDrawMode(null);
            }}
          />

          <div className="canvas-overlay top-left">
            {currentMap && <Breadcrumb map={currentMap} maps={state.maps} onSwitch={() => {}} />}
          </div>

          {isForced && (
            <div className="canvas-overlay bottom-center">
              <div className="forced-view-banner">
                <span className="glyph">⚑</span>
                DM-controlled view · {currentMap?.name}
              </div>
            </div>
          )}

          {syncStatus !== 'live' && (
            <div className="canvas-overlay bottom-center">
              <div className="forced-view-banner">
                {syncStatus === 'connecting' ? 'Connecting to the table…' : syncStatus === 'error' ? 'Connection lost. Reopen the page to retry.' : 'Offline'}
              </div>
            </div>
          )}

          {showInit && <InitiativeTracker state={state} dispatch={() => {}} mode="player" onClose={() => setShowInit(false)} />}

          {showDraw && (
            <DrawingPanel
              state={state}
              onClose={() => setShowDraw(false)}
              drawMode={drawMode} setDrawMode={setDrawMode}
              drawColor={drawColor} setDrawColor={setDrawColor}
              drawWidth={drawWidth} setDrawWidth={setDrawWidth}
              onClearOwn={() => playerActionSender({ type: 'drawing_clear_owner', payload: { mapId: currentMapId } })}
              onClearAll={() => {}}
              isDM={false}
            />
          )}

          {showDice && (
            <DiceTray
              state={state}
              onClose={() => setShowDice(false)}
              myPeerId={myPeerId}
              myName={playerName}
              isDM={false}
              dispatch={() => {}}
              onRoll={(entry) => playerActionSender({ type: 'dice_roll', payload: { entry } })}
            />
          )}

          {selectedToken && selectedTokenEntity && (
            <RadialTokenMenu
              state={state}
              token={selectedToken}
              entity={selectedTokenEntity}
              mode="player"
              dispatch={() => {}}
              onClose={() => setSelectedTokenId(null)}
              claimedEntityId={claimedEntityId}
              myPeerId={myPeerId}
              playerActionSender={playerActionSender}
              obfuscateHp={state.obfuscateHp}
              physicalDice={state.physicalDice === true}
            />
          )}

          {showBuilderOverlay && (
            <div className="onboarding-overlay">
              <div className="onboarding-card">
                <div className="onboarding-title">Create your character</div>
                <div className="onboarding-subtitle">
                  The DM approved your request. Build your hero below.
                </div>
                <NewCharacterBuilder
                  playerName={playerName}
                  busy={creatingChar}
                  onCancel={() => setBuilderDismissed(true)}
                  onCreate={createNewCharacter}
                  onRoll={(text) => playerActionSender({ type: 'creation_roll', payload: { text } })}
                />
                <div className="settings-hint" style={{ textAlign: 'center', marginTop: 12 }}>
                  You can reopen this from the "Create character" button up top.
                </div>
              </div>
            </div>
          )}

          {showClaim && (
            <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && setShowClaim(false)}>
              <div className="modal slide-up" style={{ maxWidth: 480 }}>
                <div className="float-panel-header">
                  <span>⚐ Claim</span>
                  <button className="close-x" onClick={() => setShowClaim(false)}>×</button>
                </div>
                <div className="float-panel-body">
                  {!claimedEntity && (
                    <>
                      <label>Characters</label>
                      {unclaimedPCs.length === 0 ? (
                        <div className="empty-state"><span className="glyph">⚔</span>No unclaimed characters.</div>
                      ) : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
                          {unclaimedPCs.map(e => (
                            <div key={e.id} className="claim-option"
                              onClick={() => claimPC(e.id)}>
                              <div className="pc-avatar" style={{ background: e.color, width: 36, height: 36 }}>
                                {e.imageUrl
                                  ? <img src={e.imageUrl} alt="" style={{width:'100%',height:'100%',objectFit:'cover',borderRadius:'50%'}} />
                                  : (e.name[0] || '?').toUpperCase()}
                              </div>
                              <div style={{ flex: 1 }}>
                                <div style={{ fontWeight: 500 }}>{e.name}</div>
                                <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                                  Level {e.level} {e.class} · {e.hp.max} HP · AC {e.ac}
                                </div>
                              </div>
                              <button className="btn primary sm">Claim</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {availableFamiliars.length > 0 && (
                    <>
                      <label>Familiars <span style={{ color: 'var(--ink-mute)', fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>- you may claim multiple</span></label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                        {availableFamiliars.map(e => (
                          <div key={e.id} className="claim-option familiar"
                            onClick={() => claimFamiliar(e.id)}>
                            <div className="pc-avatar familiar-avatar" style={{ background: e.color, width: 32, height: 32 }}>
                              {(e.name[0] || '?').toUpperCase()}
                            </div>
                            <div style={{ flex: 1 }}>
                              <div style={{ fontWeight: 500 }}>{e.name}</div>
                              <div style={{ fontSize: 11, color: 'var(--ink-dim)' }}>
                                Familiar {e.faction ? `· bonded to ${e.faction}` : ''}
                              </div>
                            </div>
                            <button className="btn sm">Claim</button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}

                  {claimedFamiliarIds.length > 0 && (
                    <>
                      <label style={{ marginTop: 14 }}>Your familiars</label>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {claimedFamiliarIds.map(fid => {
                          const f = state.entities[fid];
                          if (!f) return null;
                          return (
                            <div key={fid} className="claim-option" style={{ cursor: 'default' }}>
                              <div className="pc-avatar familiar-avatar" style={{ background: f.color, width: 28, height: 28 }}>
                                {(f.name[0] || '?').toUpperCase()}
                              </div>
                              <span style={{ flex: 1, fontSize: 13 }}>{f.name}</span>
                              <button className="btn sm ghost" onClick={() => unclaimFamiliar(fid)}>Release</button>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}

                  {!claimedEntity && (
                    <div style={{ marginTop: 16, borderTop: '1px solid var(--border-soft)', paddingTop: 14 }}>
                      <label>New character</label>
                      {newCharStatus === 'pending' ? (
                        <div className="grant-status pending">⏳ Waiting for the DM to approve your new character…</div>
                      ) : newCharGranted ? (
                        <button className="btn primary" style={{ width: '100%' }}
                          onClick={() => { setShowClaim(false); setBuilderDismissed(false); }}>
                          ✨ Build your approved character
                        </button>
                      ) : (
                        <>
                          <button className="btn" style={{ width: '100%' }}
                            onClick={() => { requestNewCharacter(); }}>
                            ✨ Request a new character
                          </button>
                          {newCharStatus === 'rejected' && (
                            <div className="settings-hint" style={{ marginTop: 6 }}>
                              The DM declined last time. You can ask again.
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {showSheet && (
            <EditMySheetModal
              state={state}
              myPeerId={myPeerId}
              claim={myClaim}
              playerActionSender={playerActionSender}
              onClose={() => setShowSheet(false)}
              obfuscateHp={state.obfuscateHp}
              initialTab={sheetTab}
            />
          )}
        </div>

        <RevealedMonstersSidebar
          state={state} currentMapId={currentMapId} ownedEntityIds={ownedEntityIds}
          view={rightView} setView={setRightView}
          sheetNode={claimedEntity ? (
            <div style={{ padding: '8px 8px 20px' }}>
              <CompactSheet entity={claimedEntity} onOpenFull={() => setShowSheet(true)} />
            </div>
          ) : null}
          chatNode={
            <ChatPanel messages={state.chat || []} isDM={false} myPeerId={myPeerId} embedded
              defaultName={displayNameForPeer(state, myPeerId)}
              onSend={({ text, whisperToDm }) => playerActionSender({ type: 'chat_send', payload: { text, whisperToDm: !!whisperToDm } })} />
          }
        />
      </div>

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={onSettingsChange}
          onClose={onCloseSettings}
          mode="player"
        />
      )}
      <AttackCinematicLayer state={state} dispatch={() => {}} isDM={false} physicalDice={state.physicalDice === true} myPeerId={myPeerId} playerActionSender={playerActionSender} />
    </div>
  );
}

// ====================================================================
// ROOT APP
// ====================================================================
function Root() {
  const [auth, setAuth] = useState(() => {
    // Try the v2 key first, then fall back to the legacy shadowquill key
    let loaded = null;
    try {
      const raw = localStorage.getItem(AUTH_KEY);
      if (raw) loaded = JSON.parse(raw);
    } catch {}
    if (!loaded) {
      try {
        const legacy = localStorage.getItem(LEGACY_AUTH_KEY);
        if (legacy) loaded = JSON.parse(legacy);
      } catch {}
    }
    // v4 fix #7: backfill playerId for pre-v4 saves so refresh restores claim
    if (loaded && loaded.mode === 'player' && !loaded.playerId) {
      loaded.playerId = getOrCreatePlayerId();
      try { localStorage.setItem(AUTH_KEY, JSON.stringify(loaded)); } catch {}
    }
    return loaded;
  });

  // v2: global settings (theme + whatever else lands here later).
  // Stored outside game state so they're per-device, not per-session.
  const [settings, setSettings] = useState(() => {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
    } catch {}
    return { ...DEFAULT_SETTINGS };
  });

  // Apply + persist theme whenever it changes. Uses `data-theme` on the root
  // element so CSS can toggle variable blocks without a full reload.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
    // v7.8: grain texture toggle (defaults on). CSS keys off this attribute.
    document.documentElement.setAttribute('data-grain', settings.grain === false ? 'off' : 'on');
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  }, [settings]);

  const updateSettings = (patch) => setSettings(s => ({ ...s, ...patch }));

  const [showSettings, setShowSettings] = useState(false);

  if (!auth) {
    return (
      <AuthScreen onAuth={(a) => {
        setAuth(a);
        try { localStorage.setItem(AUTH_KEY, JSON.stringify(a)); } catch {}
      }} />
    );
  }

  const logout = () => {
    try { localStorage.removeItem(AUTH_KEY); } catch {}
    try { localStorage.removeItem(LEGACY_AUTH_KEY); } catch {}
    setAuth(null);
  };

  return (
    <Session
      auth={auth}
      onLogout={logout}
      settings={settings}
      onSettingsChange={updateSettings}
      showSettings={showSettings}
      onOpenSettings={() => setShowSettings(true)}
      onCloseSettings={() => setShowSettings(false)}
    />
  );
}

// ====================================================================
// PLAYER ACTION VALIDATION HELPERS (module-level - pure, no closures)
// ====================================================================

// Returns the set of entity IDs a peer owns: their claimed PC, explicitly
// claimed familiars, and any familiars bonded by peerId or by PC.
function ownedByPeer(s, pid) {
  const c = s.claims?.[pid];
  const out = new Set();
  if (c) {
    for (const id of (c.familiars || [])) out.add(id);
    // v7.9: PCs the DM has temporarily lent to this player.
    for (const id of (c.controlledPcs || [])) out.add(id);
    if (c.pc) out.add(c.pc);
  }
  for (const [, ent] of Object.entries(s.entities)) {
    if (!ent || ent.type !== 'Familiar') continue;
    if (ent.bondedPeerId === pid) out.add(ent.id);
    if (c && ent.bondedPcId && ent.bondedPcId === c.pc) out.add(ent.id);
  }
  return out;
}

// Fields a player may write on their own entity. DM-only fields are never
// writable by players regardless of claim (deathSaves, sickness, type, etc.).
const PLAYER_FIELD_WHITELIST = new Set([
  'name', 'color', 'ac', 'speed', 'initBonus', 'passivePerception',
  'class', 'playerName', 'notes', 'playerDescription',
  'imageUrl', 'faction', 'role', 'darkvision', 'lightRadius',
  // v7.6: expanded character-sheet fields
  'money', 'xp', 'proficiencyBonus', 'hitDice', 'race', 'background',
  'alignment', 'attacks', 'spells', 'features', 'proficiencies',
  'inventory', 'traits', 'ideals', 'bonds', 'flaws', 'backstory',
  'weapons', // v7.9: structured weapons (players manage their own)
  'armor', 'shield', 'handsTotal', // v8.8: equipment (armour, shields, hands)
  'speeds', // v8.3: structured walk/fly/jump speeds
]);
// v7.8: `level` and the six ability scores are NOT here - players change
// those only through the DM-approved request queue (submit_request).
const PLAYER_HP_WHITELIST    = new Set(['current', 'max']);
const PLAYER_STATS_WHITELIST = new Set(['str', 'dex', 'con', 'int', 'wis', 'cha']);

function Session({ auth, onLogout, settings, onSettingsChange, showSettings, onOpenSettings, onCloseSettings }) {
  const toast = useToast();
  // v7 #1: IDB-backed initial state. The reducer initializer can't be
  // async, so we start with default state and hydrate asynchronously
  // from IDB in a useEffect. The DM session shows a brief loading toast
  // while IDB streams in. Migrating from v6 localStorage happens once
  // here too - old blobs get split, written to IDB, and removed from
  // localStorage to free up the quota.
  const [state, dispatch] = useReducer(reducer, null, () => makeDefaultState());
  const [hydrated, setHydrated] = useState(false);
  const [awaitingApproval, setAwaitingApproval] = useState(false); // v8.9: held pending DM admit

  useEffect(() => {
    if (auth.mode !== 'dm') { setHydrated(true); return; }
    let cancelled = false;
    (async () => {
      try {
        // One-time migration from v6 localStorage blob → IDB
        const mig = await migrateLocalStorageToIDB();
        if (mig.migrated) {
          dlog(`[plagues-call] migrated ${mig.bytes} bytes from ${mig.source} to IndexedDB`);
        }
        const loaded = await loadSessionFromIDB();
        if (cancelled) return;
        if (loaded) {
          const migrated = migrateState(loaded);
          const tokenCount = Object.keys(migrated.tokens || {}).length;
          const mapCount = Object.keys(migrated.maps || {}).length;
          dlog(`[plagues-call] loaded from IDB: ${tokenCount} tokens, ${mapCount} maps`);
          dispatch({ type: 'HYDRATE', state: migrated });
        } else {
          // No IDB data - try one more legacy fallback before giving up
          let raw = null;
          try { raw = localStorage.getItem(LEGACY_STORAGE_KEY); } catch {}
          if (raw) {
            try {
              const parsed = JSON.parse(raw);
              const migrated = migrateState(parsed);
              dispatch({ type: 'HYDRATE', state: migrated });
              dlog(`[plagues-call] loaded from legacy localStorage`);
              // Persist into IDB right away so future loads use it
              persistSessionToIDB(migrated).catch(e =>
                console.warn('[plagues-call] initial IDB write failed:', e?.message));
            } catch (e) {
              console.warn('[plagues-call] legacy parse failed:', e?.message);
            }
          } else {
            console.log('[plagues-call] no saved state found - starting fresh');
          }
        }
      } catch (err) {
        console.error('[plagues-call] hydrate failed:', err?.message || err);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    })();
    return () => { cancelled = true; };
  }, [auth.mode]);

  const [syncStatus, setSyncStatus] = useState('offline');
  const [peerList, setPeerList] = useState([]);
  const [myPeerId, setMyPeerId] = useState(null);
  const syncRef = useRef(null);
  const stateRef = useRef(state);
  const settingsRef = useRef(settings);
  const consumedGrantsRef = useRef(new Set()); // v8.3: dedupe create_and_claim_pc retries
  const hazardTurnRef = useRef(null); // v8.3: which init turn last took per-turn hazard damage
  const heartbeatHashRef = useRef(new Map()); // v8.9: per-peer last-sent payload hash (dedup heartbeat)
  const approvedPeersRef = useRef(new Set()); // v8.9: peers the DM has admitted this session
  const heldPeersRef = useRef(new Map()); // v8.9: peerId -> {playerId, playerName} awaiting DM approval
  useEffect(() => { settingsRef.current = settings; }, [settings]);
  stateRef.current = state;

  // v7.2: Player-side IDB hydration for map images. When a state_update
  // arrives with a sentinel imageUrl for a map we've seen before, try
  // loading the image from our local IDB cache. Avoids waiting for the
  // DM to re-push bytes we already have. Keeps a loaded-set in a ref
  // so we only try each mapId once per session.
  const idbHydratedMapsRef = useRef(new Set());
  useEffect(() => {
    if (auth.mode !== 'player') return;
    const maps = state.maps || {};
    for (const [id, m] of Object.entries(maps)) {
      if (idbHydratedMapsRef.current.has(id)) continue;
      if (m?.imageUrl !== IMG_SENTINEL) continue;
      idbHydratedMapsRef.current.add(id);
      (async () => {
        try {
          const cached = await idbGet(IDB_STORES.mapImages, id);
          if (cached && typeof cached === 'string' && cached.startsWith('data:')) {
            dispatch({ type: 'MAP_IMAGE_RECEIVED', mapId: id, dataUrl: cached });
            dlog(`[plagues-call] hydrated map_image ${id.slice(-6)} from IDB cache`);
          }
        } catch (err) {
          // Cache miss is normal on first join - DM will push bytes.
        }
      })();
    }
  }, [state.maps, auth.mode]);

  // v7 fix #1: BULLETPROOF persistence via IndexedDB.
  // The v6 strategy (write everything to localStorage) ran into the 5MB
  // localStorage quota - once map images accumulated, every save threw
  // QuotaExceededError and silently lost state. v7:
  //   - State JSON (without map images) goes to IDB store 'session'/main
  //   - Each map image is stored separately in IDB store 'mapImages'
  //   - Write debounce remains (250ms) but writes are async + transactional
  //   - Critical actions still trigger an immediate write
  //   - On quota or write failure: explicit toast + console.error, no silent loss
  //   - Save log shows JSON bytes + map image count
  //
  // We hold a pending-save ref so multiple in-flight writes coalesce;
  // newer writes supersede older ones if they overlap.
  const persistInFlightRef = useRef(false);
  const persistQueuedRef = useRef(false);
  const persistNow = useCallback((reason = 'routine') => {
    if (auth.mode !== 'dm') return;
    if (!hydrated) return; // don't overwrite IDB before initial load
    // Coalesce: if a save is already running, mark a follow-up save and
    // let the in-flight one schedule it.
    if (persistInFlightRef.current) {
      persistQueuedRef.current = true;
      return;
    }
    persistInFlightRef.current = true;
    const snapshot = stateRef.current;
    const t0 = performance.now();
    persistSessionToIDB(snapshot)
      .then(({ jsonBytes, imageCount }) => {
        const tokens = Object.keys(snapshot.tokens || {}).length;
        const elapsed = performance.now() - t0;
        dlog(`[plagues-call] saved (${reason}): ${jsonBytes} JSON bytes, ${tokens} tokens, ${imageCount} map images, ${elapsed.toFixed(0)}ms`);
      })
      .catch(err => {
        console.error('[plagues-call] SAVE FAILED', err?.name, err?.message);
        if (err?.name === 'QuotaExceededError') {
          toast('Storage quota exceeded - export and prune old maps', 'error');
        } else {
          toast('Save failed - see console', 'error');
        }
      })
      .finally(() => {
        persistInFlightRef.current = false;
        if (persistQueuedRef.current) {
          persistQueuedRef.current = false;
          // Trampoline the queued save with a microtask delay so we don't
          // recurse a giant stack during fast edits.
          setTimeout(() => persistNow('coalesced'), 0);
        }
      });
  }, [auth.mode, toast, hydrated]);

  // v7.1 PERFORMANCE FIX: the v7 persist strategy fired an IDB write
  // on EVERY state change whose signature differed - including every
  // pointermove during a token drag (TOKEN_MOVE dispatches at ~60fps).
  // That caused JSON.stringify + IDB write per frame, producing visible
  // stutter on both the DM canvas and the dragged token.
  //
  // New strategy: ALL state changes debounce through a single 800ms
  // timer. The "critical" immediate-write path is kept only for the
  // true invariants (token count / entity count / current map), not
  // for every movement. Writes coalesce naturally; if you drag a
  // token for 3 seconds, that's ONE IDB write at the end, not 180.
  // The beforeunload + pagehide flush guarantees nothing is lost on
  // page close.
  const lastSigRef = useRef('');
  const persistTimerRef = useRef(null);
  useEffect(() => {
    if (auth.mode !== 'dm') return;
    if (!hydrated) return;
    const s = state;
    // Structural signature ignores positions - only counts + current map.
    // A change here means a token was added/removed/claimed/etc.
    // Movement is handled by the debounce alone.
    const structSig = [
      Object.keys(s.tokens || {}).length,
      Object.keys(s.entities || {}).length,
      Object.keys(s.maps || {}).length,
      s.currentMapId,
    ].join('::');
    if (structSig !== lastSigRef.current) {
      lastSigRef.current = structSig;
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistNow('critical');
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      persistTimerRef.current = null;
      persistNow('debounced');
    }, 800);
    return () => {
      // Intentionally do NOT clear the timer on unmount - we want the
      // pending write to land. beforeunload catches the close path.
    };
  }, [state, auth.mode, persistNow, hydrated]);

  // Flush on unload (survives across tab-close)
  useEffect(() => {
    if (auth.mode !== 'dm') return;
    const flush = () => persistNow('unload');
    window.addEventListener('beforeunload', flush);
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      window.removeEventListener('pagehide', flush);
    };
  }, [auth.mode, persistNow]);

  // Setup sync
  useEffect(() => {
    if (auth.local) return;
    if (!auth.roomCode) return;

    const sync = new SyncManager({
      mode: auth.mode,
      onStateUpdate: (newState) => {
        if (auth.mode === 'player') {
          const tokCount = Object.keys(newState?.tokens || {}).length;
          dlog(`[plagues-call] player ← state_update ${tokCount} tokens`);
          setAwaitingApproval(false); // v8.9: real state means we've been admitted
          dispatch({ type: 'REPLACE', payload: newState });
        }
      },
      onAwaitingApproval: () => { if (auth.mode === 'player') setAwaitingApproval(true); },
      onPlayerAction: (action, peerId) => {
        handlePlayerAction(action, peerId);
      },
      // v4: When a player reconnects, migrate their claim from their old
      // peer id to the new one, keyed on their stable playerId.
      onPlayerHello: (hello, newPeerId) => {
        if (!hello?.playerId || typeof hello.playerId !== 'string') return;
        // v8.9: cap the untrusted display name (the dice path already caps
        // peerName; the hello path didn't, so it was broadcast uncapped).
        const safeName = (typeof hello.playerName === 'string' ? hello.playerName : '').trim().slice(0, 40);
        const curr = stateRef.current;
        // Find any existing peer key whose "playerId" marker matches
        const claims = curr.claims || {};
        let fromPeerId = null;
        for (const [pid, c] of Object.entries(claims)) {
          if (c && c.playerId === hello.playerId && pid !== newPeerId) {
            fromPeerId = pid;
            break;
          }
        }
        // v8.9: DM approval gate. A brand-new player (no prior claim, not yet
        // approved this session) is held until the DM accepts them; a
        // reconnecting player with an existing claim skips the gate.
        const isReconnect = !!fromPeerId;
        if (settingsRef.current?.approveNewPlayers === true && !isReconnect && !approvedPeersRef.current.has(hello.playerId)) {
          heldPeersRef.current.set(newPeerId, { playerId: hello.playerId, playerName: safeName });
          dispatch({ type: 'REQUEST_ADD', request: {
            id: uid('req_'), peerId: newPeerId, playerName: safeName || 'Player',
            kind: 'join_request', payload: { playerId: hello.playerId }, ts: Date.now(), status: 'pending',
          } });
          try { syncRef.current?.connections.get(newPeerId)?.send({ type: 'awaiting_approval' }); } catch {}
          toast(`${safeName || 'A player'} is asking to join`, 'info');
          return;
        }
        // v8.9: approval is keyed on the stable playerId, so an admitted player
        // (even a claimless spectator) isn't re-held after a reconnect.
        if (hello.playerId) approvedPeersRef.current.add(hello.playerId);
        dispatch({ type: 'CLAIM_MIGRATE',
          fromPeerId, toPeerId: newPeerId,
          playerName: safeName,
          playerId: hello.playerId,
        });
        if (fromPeerId) {
          toast(`${safeName || 'Player'} reconnected - claim restored`, 'success');
        }
      },
      onStatusChange: setSyncStatus,
      onPeerListChange: setPeerList,
      onPeerId: setMyPeerId,
      onError: (msg) => toast(msg, 'error'),
      // v7.2: map image bytes arrive separately. Cache in IDB and
      // merge into state so the map layer renders.
      onMapImage: (mapId, dataUrl, layerId) => {
        if (auth.mode !== 'player') return;
        if (!mapId || !dataUrl) return;
        const t0 = performance.now();
        if (layerId) {
          // v7.7: a layer image. Cache under the same 'layer:<id>' key and
          // merge into the matching layer.
          idbSet(IDB_STORES.mapImages, 'layer:' + layerId, dataUrl).catch(err => {
            console.warn('[plagues-call] cache layer image failed:', err);
          });
          dispatch({ type: 'LAYER_IMAGE_RECEIVED', mapId, layerId, dataUrl });
          dlog(`[plagues-call] received layer image ${layerId.slice(-6)} in ${(performance.now() - t0).toFixed(0)}ms`);
          return;
        }
        idbSet(IDB_STORES.mapImages, mapId, dataUrl).catch(err => {
          console.warn('[plagues-call] cache map image failed:', err);
        });
        dispatch({ type: 'MAP_IMAGE_RECEIVED', mapId, dataUrl });
        const elapsed = performance.now() - t0;
        dlog(`[plagues-call] received map_image ${mapId.slice(-6)} in ${elapsed.toFixed(0)}ms`);
      },
      // v7.2: ephemeral token-position updates. Apply locally without
      // waiting for the next full state_update; gives sub-frame
      // responsiveness for remote viewers watching a token move.
      onTokenPos: (tokenId, x, y, mapId) => {
        if (auth.mode !== 'player') return;
        dlog(`[plagues-call] player got token_pos token=${tokenId.slice(-6)} → (${x.toFixed(0)}, ${y.toFixed(0)})`);
        dispatch({ type: 'TOKEN_MOVE_EPHEMERAL', tokenId, x, y, mapId });
      },
      onSoundData: (soundId, name, dataUrl) => {
        if (!soundId || !dataUrl) return;
        // Populate the in-memory cache immediately so useSoundPlayback can
        // find the bytes synchronously on the next render, without waiting
        // for the IDB write to commit (which would lose the race).
        _soundDataCache.set(soundId, dataUrl);
        idbSet(IDB_STORES.sounds, soundId, { id: soundId, name, dataUrl, ts: Date.now() })
          .catch(err => console.warn('[plagues-call] cache sound failed:', err));
      },
    });

    syncRef.current = sync;

    const joinT0 = performance.now();
    if (auth.mode === 'dm') {
      sync.hostSession(auth.roomCode);
      dlog(`[plagues-call] DM hosting room ${auth.roomCode}`);
    } else {
      // Wrap onStateUpdate to log when the first state arrives (claim modal ready).
      const priorHandler = sync.onStateUpdate;
      let fired = false;
      sync.onStateUpdate = (payload) => {
        if (!fired) {
          fired = true;
          dlog(`[plagues-call] claim modal ready in ${(performance.now() - joinT0).toFixed(0)}ms`);
        }
        priorHandler?.(payload);
      };
      sync.joinSession(auth.roomCode, auth.playerId, auth.playerName);
      dlog(`[plagues-call] player joining room ${auth.roomCode}`);
    }

    return () => { sync.destroy(); };
  }, [auth.roomCode, auth.mode, auth.local]);

  // v7.1 PERFORMANCE FIX: DM broadcasts state changes to peers. The
  // v7 debounce was 30ms - still fires several times per 100ms during
  // a token drag, and each broadcast serializes the entire filtered
  // state (typically 50-200 KB with drawings/hazards). On lower-end
  // devices this caused visible input stutter.
  //
  // New: 120ms debounce. At worst ~8 broadcasts per second of dragging.
  // Each broadcast is still perfectly current because the useEffect
  // re-runs on every state change and only the last scheduled timer
  // actually fires (previous ones get cleared).
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current || syncStatus !== 'live') return;
    const handle = setTimeout(() => {
      peerList.forEach(pid => {
        if (heldPeersRef.current.has(pid)) return; // v8.9: awaiting DM approval
        const conn = syncRef.current.connections.get(pid);
        if (conn?.open) {
          try {
            conn.send({
              type: 'state_update',
              // v7.2: strip heavy assets (map image bytes, sound bytes)
              // before wire transmit. These travel through separate
              // map_image / sound_data envelopes on demand.
              payload: {
                ...stripHeavyAssetsForWire(filterStateForPlayer(stateRef.current, pid, settingsRef.current?.obfuscateHp === true)),
                obfuscateHp: settingsRef.current?.obfuscateHp === true,
                physicalDice: settingsRef.current?.physicalDice === true,
              }
            });
          } catch {}
        }
      });
    }, 120);
    return () => clearTimeout(handle);
  }, [state, peerList, syncStatus, auth.mode]);

  // v8.3 safety heartbeat (v8.9: de-duplicated - there were two identical
  // copies pushing full state twice every 2s). The debounced push above covers
  // normal latency; this repairs a missed broadcast (a brief closed connection,
  // a dropped envelope) so a player is never more than ~2s stale. v8.9: skip
  // the send when the filtered payload is byte-identical to what we last sent
  // this peer, so an idle table stops re-rendering every 2s for nothing.
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current || syncStatus !== 'live') return;
    if (!peerList.length) return;
    const iv = setInterval(() => {
      peerList.forEach(pid => {
        if (heldPeersRef.current.has(pid)) return; // v8.9: awaiting DM approval
        const conn = syncRef.current.connections.get(pid);
        if (conn?.open) {
          try {
            const payload = {
              ...stripHeavyAssetsForWire(filterStateForPlayer(stateRef.current, pid, settingsRef.current?.obfuscateHp === true)),
              obfuscateHp: settingsRef.current?.obfuscateHp === true,
                physicalDice: settingsRef.current?.physicalDice === true,
            };
            const fp = imageFingerprint(JSON.stringify(payload));
            if (heartbeatHashRef.current.get(pid) === fp) return; // unchanged - skip
            heartbeatHashRef.current.set(pid, fp);
            conn.send({ type: 'state_update', payload });
          } catch {}
        }
      });
    }, 2000);
    return () => clearInterval(iv);
  }, [peerList, syncStatus, auth.mode]);

  // v8.9: reconcile the held-peer set. A join_request can leave "pending"
  // without going through onApproveJoin/onRejectJoin - the 120s TTL sweep
  // auto-rejects it, or the peer closes the tab. Either way the peer would
  // otherwise sit held forever (spinner on their side, broadcasts suppressed
  // on ours). This watches connections + requests and cleans up:
  //   - disconnected held peer  -> drop from held (and hash cache)
  //   - held peer with no pending join_request -> treat as declined, kick.
  useEffect(() => {
    if (auth.mode !== 'dm') return;
    if (heldPeersRef.current.size === 0) return;
    const reqs = Object.values(stateRef.current.pendingRequests || {});
    for (const pid of Array.from(heldPeersRef.current.keys())) {
      if (!peerList.includes(pid)) {
        heldPeersRef.current.delete(pid);
        heartbeatHashRef.current.delete(pid);
        continue;
      }
      const stillPending = reqs.some(r => r.kind === 'join_request' && r.peerId === pid && r.status === 'pending');
      if (!stillPending) {
        heldPeersRef.current.delete(pid);
        try { syncRef.current?.connections.get(pid)?.send({ type: 'kicked', reason: 'Your request to join was not approved in time.' }); } catch {}
      }
    }
  }, [state.pendingRequests, peerList, auth.mode]);

  // v8.3: hazardous terrain - per-turn damage. When initiative advances, the
  // creature whose turn it now is takes damage from any damaging hazard whose
  // polygon contains its token (if the hazard is flagged "per turn"). Guarded
  // by a ref so each turn is charged at most once. DM-authoritative.
  useEffect(() => {
    if (auth.mode === 'player') return;
    const init = state.initiative;
    if (!init?.active) { hazardTurnRef.current = null; return; }
    const key = `${init.round}:${init.turn}`;
    if (hazardTurnRef.current === key) return;
    hazardTurnRef.current = key;
    const activeId = init.entries?.[init.turn]?.entityId;
    if (!activeId) return;
    const ent = state.entities[activeId];
    if (!ent || !ent.hp || ent.hp.current <= 0) return;
    const tok = Object.values(state.tokens).find(t => t.entityId === activeId && t.mapId === state.currentMapId);
    if (!tok) return;
    const hits = damagingHazardsAt(state, tok.mapId, tok.x, tok.y).filter(h => h.damage.perTurn);
    if (!hits.length) return;
    for (const h of hits) {
      const rolled = rollHazardDamage(h.damage);
      dispatch({ type: 'HAZARD_QUEUE', event: {
        id: uid('hzd_'), entityId: activeId, entityName: ent.name, entityColor: ent.color || '#888',
        tokenId: tok.id, hazardId: h.id, hazardKind: h.hazardKind, dmgType: h.damage.type || h.hazardKind,
        rolled, reason: 'turn', ts: Date.now(),
      } });
    }
  }, [state.initiative?.turn, state.initiative?.round, state.initiative?.active, auth.mode]);

  // v7.2 PERFORMANCE FIX: initial-state push to new peers. Previously
  // this sent the WHOLE state inline including megabytes of map image
  // dataUrls - producing the 10-second join lag. Now we:
  //   1. Send a lean state_update immediately (kilobytes, arrives fast)
  //      so the claim modal can render right away
  //   2. Send the current map's image bytes in a separate map_image
  //      envelope moments later (player caches in IDB so reconnects
  //      don't re-transmit)
  //   3. Trickle other map images over the next few seconds with
  //      setTimeout so we don't block the main thread on mobile
  const sentMapImagesRef = useRef({}); // peerId → Map of imageKey → content fingerprint
  const sentSoundsRef = useRef(new Set()); // peerIds that have received full sound library
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current) return;
    const newPeers = peerList.filter(pid => !sentMapImagesRef.current[pid]);
    for (const pid of newPeers) {
      sentMapImagesRef.current[pid] = new Map();
    }
    const sync = syncRef.current;
    peerList.forEach(pid => {
      if (heldPeersRef.current.has(pid)) return; // v8.9: awaiting DM approval
      const conn = sync.connections.get(pid);
      if (!conn?.open) return;
      try {
        const t0 = performance.now();
        const filtered = filterStateForPlayer(stateRef.current, pid, settingsRef.current?.obfuscateHp === true);
        const lean = {
          ...stripHeavyAssetsForWire(filtered),
          obfuscateHp: settingsRef.current?.obfuscateHp === true,
                physicalDice: settingsRef.current?.physicalDice === true,
        };
        conn.send({ type: 'state_update', payload: lean });
        const elapsed = performance.now() - t0;
        if (elapsed > 50) dlog(`[plagues-call] lean state_update to ${pid.slice(-6)}: ${elapsed.toFixed(0)}ms`);
      } catch (err) {
        console.warn('[plagues-call] initial state push failed:', err);
      }
      // Send all known sounds to this peer if we haven't already.
      // This covers sounds played in previous sessions that are already in
      // state.soundEvents when the player joins - they have no inline dataUrl
      // and no IDB entry, so we push the bytes from the DM's IDB proactively.
      if (!sentSoundsRef.current.has(pid)) {
        sentSoundsRef.current.add(pid);
        idbAllEntries(IDB_STORES.sounds).then(entries => {
          const c = sync.connections.get(pid);
          if (!c?.open) return;
          for (const [soundId, rec] of Object.entries(entries)) {
            if (!rec?.dataUrl) continue;
            try { c.send({ type: 'sound_data', soundId, name: rec.name, dataUrl: rec.dataUrl }); } catch {}
          }
        }).catch(() => {});
      }
    });
  }, [peerList, auth.mode]);

  // v7.8: when a peer disconnects (or is kicked), drop its per-peer asset
  // caches so a fresh reconnect re-receives the current map/layer images and
  // sound library instead of being assumed up to date. The fingerprint cache
  // already suppresses redundant resends to a live peer; clearing it on
  // disconnect is the belt-and-suspenders that also covers a client whose IDB
  // was cleared while it was away. peerList reflects live connections (it is
  // rebuilt from the socket map on every open/close), so any id missing from
  // it is no longer connected.
  useEffect(() => {
    if (auth.mode !== 'dm') return;
    const live = new Set(peerList);
    for (const pid of Object.keys(sentMapImagesRef.current)) {
      if (!live.has(pid)) delete sentMapImagesRef.current[pid];
    }
    for (const pid of Array.from(sentSoundsRef.current)) {
      if (!live.has(pid)) sentSoundsRef.current.delete(pid);
    }
  }, [peerList, auth.mode]);

  // v7.2: push map image bytes to peers for maps they haven't cached.
  // Runs when the current map changes OR when a new peer joins. The
  // actual byte push is deferred via setTimeout so it doesn't block
  // the claim modal from rendering.
  useEffect(() => {
    if (auth.mode !== 'dm' || !syncRef.current) return;
    const s = stateRef.current;
    const currentMapId = s.currentMapId;
    if (!currentMapId) return;
    const currentMap = s.maps?.[currentMapId];
    const mapBytes = currentMap?.imageUrl && currentMap.imageUrl.startsWith('data:') ? currentMap.imageUrl : null;
    // v7.7: image envelopes to send for the current map - the base map plus
    // every layer that carries inline bytes. Keyed so each is sent once/peer.
    const jobs = [];
    if (mapBytes) jobs.push({ key: currentMapId, dataUrl: mapBytes });
    for (const l of (s.layers?.[currentMapId] || [])) {
      if (l?.imageUrl && typeof l.imageUrl === 'string' && l.imageUrl.startsWith('data:')) {
        jobs.push({ key: 'layer:' + l.id, layerId: l.id, dataUrl: l.imageUrl });
      }
    }
    if (jobs.length === 0) return;
    // v7.8: fingerprint each image once (same bytes for all peers) so a
    // replaced image is detected as new and re-sent.
    for (const j of jobs) j.fp = imageFingerprint(j.dataUrl);

    const sync = syncRef.current;
    const timers = [];
    let slot = 0;
    peerList.forEach((pid) => {
      const sentMap = sentMapImagesRef.current[pid] || (sentMapImagesRef.current[pid] = new Map());
      jobs.forEach((job) => {
        // skip only if THIS peer already has this exact image content
        if (sentMap.get(job.key) === job.fp) return;
        const t = setTimeout(() => {
          const conn = sync.connections.get(pid);
          if (!conn?.open) return;
          try {
            conn.send({ type: 'map_image', mapId: currentMapId, layerId: job.layerId, dataUrl: job.dataUrl });
            sentMap.set(job.key, job.fp);
            dlog(`[plagues-call] image ${job.key.slice(-6)} → ${pid.slice(-6)}`);
          } catch (err) {
            console.warn('[plagues-call] image send failed:', err);
          }
        }, 50 + (slot++) * 150);
        timers.push(t);
      });
    });
    return () => timers.forEach(t => clearTimeout(t));
  }, [peerList, state.currentMapId, state.maps, state.layers, auth.mode]);

  // Handle player actions (DM side). All writes go through here so the DM
  // can validate ownership before dispatching. Players never mutate state
  // directly - they always send an intent message.
  const handlePlayerAction = useCallback((action, peerId) => {
    const curr = stateRef.current;

    // v8.9 SECURITY: a single top-level ceiling on inbound action size. The
    // whitelist lets players write structured fields (weapons, armour, inline
    // portraits, sheet text) that individual handlers only spot-check; this is
    // the general backstop against a modified client shipping a multi-megabyte
    // object graph that lands in state and rebroadcasts to everyone. ~256KB is
    // far above any legitimate action (a downscaled portrait is ~40KB).
    try {
      const sz = JSON.stringify(action)?.length || 0;
      if (sz > 262144) {
        dlog(`[plagues-call] REJECT oversized action (${sz} bytes) from ${String(peerId).slice(-6)}`);
        return;
      }
    } catch { return; } // unserializable / circular - reject

    // v7.6: after an onboarding choice (claim PC / familiar / spectator),
    // push fresh state straight back to that peer instead of waiting for
    // the next incidental broadcast. On an idle table the debounced
    // broadcast might not fire again for many seconds, which made the
    // selection feel like it took 10-20s to "actuate". The 60ms defer
    // lets the dispatch commit so stateRef holds the post-claim state.
    const pushSoon = () => {
      const pid = peerId;
      if (heldPeersRef.current.has(pid)) return; // v8.9: never push to a peer awaiting approval
      setTimeout(() => {
        if (heldPeersRef.current.has(pid)) return;
        const conn = syncRef.current?.connections.get(pid);
        if (!conn?.open) return;
        try {
          conn.send({
            type: 'state_update',
            payload: {
              ...stripHeavyAssetsForWire(filterStateForPlayer(stateRef.current, pid, settingsRef.current?.obfuscateHp === true)),
              obfuscateHp: settingsRef.current?.obfuscateHp === true,
                physicalDice: settingsRef.current?.physicalDice === true,
            },
          });
        } catch {}
      }, TUNING.pushSoonMs);
    };

    switch (action.type) {
      // v7.6: a player sends a public chat message. The DM resolves the
      // sender's display name authoritatively (no name spoofing) and never
      // lets a player send a whisper.
      case 'chat_send': {
        const text = String(action.payload?.text || '').replace(/\s+$/, '').slice(0, TUNING.chatMaxChars);
        if (!text.trim()) return;
        // v8.9: players may now whisper privately to the DM. Any other whisper
        // target from a player is ignored (no player-to-player spoofing). The
        // DM sees all chat unfiltered; chatForViewer keeps it from other peers.
        const toDm = action.payload?.whisperToDm === true;
        dispatch({ type: 'CHAT_ADD', message: {
          id: uid('msg_'), ts: Date.now(), senderId: peerId,
          senderName: displayNameForPeer(curr, peerId),
          text,
          whisperTo: toDm ? 'dm' : null,
          whisperToName: toDm ? 'DM' : null,
        } });
        pushSoon(); // v8.9: nudge a fast snapshot back like moves/claims do
        return;
      }
      // v7.8: a player asks the DM for something (generic approval queue).
      // The DM stamps identity server-side and de-dupes per kind. Sheet
      // stat/level requests and the new-character grant all flow through
      // here. Auto-decline (2 min) is handled by a DM-side sweep effect.
      case 'submit_request': {
        const kind = String(action.payload?.kind || '');
        const ACTION_KINDS = ['apply_damage', 'apply_heal', 'apply_condition'];
        if (!['new_character', 'stat_change', 'level_change', 'place_token', ...ACTION_KINDS].includes(kind)) return;
        // v7.9: player action requests - a player asks the DM to apply damage,
        // healing, or a condition to a TARGET token. The DM reviews and applies
        // (optionally with weakness/resistance/immunity). The source must be one
        // of the requester's own characters; the target may be anyone.
        if (ACTION_KINDS.includes(kind)) {
          const data0 = action.payload?.data || {};
          const owned = ownedByPeer(curr, peerId);
          let sourceId = String(data0.sourceEntityId || '');
          if (!owned.has(sourceId)) sourceId = curr.claims?.[peerId]?.pc || [...owned][0] || '';
          if (!sourceId || !curr.entities[sourceId]) return;
          const targetTok = data0.targetTokenId ? curr.tokens[data0.targetTokenId] : null;
          const targetId = String(data0.targetEntityId || targetTok?.entityId || '');
          const target = curr.entities[targetId];
          if (!target) return;
          let payload;
          if (kind === 'apply_condition') {
            const cond = String(data0.condition || '');
            if (!CONDITIONS.includes(cond)) return;
            payload = { sourceEntityId: sourceId, targetEntityId: targetId, targetTokenId: data0.targetTokenId || null, condition: cond };
          } else {
            // Normalize to a components array. New clients send `components`;
            // legacy single-component clients send dice/modifier/flat/damageType.
            const sanitizeDice = (arr) => Array.isArray(arr) ? arr.slice(0, 60).map(d => ({
              sides: Math.max(2, Math.min(100, Math.round(Number(d.sides)) || 6)),
              result: Math.max(1, Math.min(100, Math.round(Number(d.result)) || 1)),
            })) : [];
            const mkComp = (c) => {
              const dice = sanitizeDice(c.dice);
              return {
                dice, diceSum: dice.reduce((a, d) => a + d.result, 0),
                modifier: Math.max(-99, Math.min(99, Math.round(Number(c.modifier)) || 0)),
                flat: Math.max(0, Math.min(9999, Math.round(Number(c.flat)) || 0)),
                type: kind === 'apply_damage' ? String(c.type || '').slice(0, 24) : '',
              };
            };
            const comps = (Array.isArray(data0.components) && data0.components.length)
              ? data0.components.slice(0, 12).map(mkComp)
              : [mkComp({ dice: data0.dice, modifier: data0.modifier, flat: data0.flat, type: data0.damageType })];
            const cl20 = (v) => Math.max(1, Math.min(20, Math.round(Number(v)) || 1));
            const ADVS = ['normal', 'advantage', 'disadvantage'];
            let d20a, d20b, advMode;
            if (data0.d20a != null) {
              d20a = cl20(data0.d20a); d20b = (data0.d20b != null) ? cl20(data0.d20b) : d20a;
              advMode = ADVS.includes(data0.advMode) ? data0.advMode : 'normal';
            } else if (data0.toHitRoll != null) {
              d20a = cl20(data0.toHitRoll); d20b = d20a; advMode = 'normal';
            } else { d20a = null; d20b = null; advMode = 'normal'; }
            const toHit = (data0.toHit == null) ? null : Math.max(-50, Math.min(99, Math.round(Number(data0.toHit)) || 0));
            const toHitRoll = (d20a != null) ? effectiveD20(advMode, d20a, d20b) : null;
            let effect = null;
            const e0 = data0.effect;
            if (e0 && typeof e0 === 'object' && CONDITIONS.includes(e0.condition)) {
              let save = null;
              if (e0.save && ABILITIES.includes(String(e0.save.ability))) {
                save = { ability: String(e0.save.ability), dc: Math.max(1, Math.min(40, Math.round(Number(e0.save.dc)) || 10)) };
              }
              let contest = null;
              if (e0.contest && ABILITIES.includes(String(e0.contest.ability))) {
                contest = {
                  ability: String(e0.contest.ability),
                  atkD20: Math.max(1, Math.min(20, Math.round(Number(e0.contest.atkD20)) || 10)),
                  atkMod: Math.max(-10, Math.min(20, Math.round(Number(e0.contest.atkMod)) || 0)),
                  atkTotal: Math.max(-10, Math.min(60, Math.round(Number(e0.contest.atkTotal)) || 10)),
                };
              }
              effect = { condition: e0.condition, save, contest };
            }
            payload = { sourceEntityId: sourceId, targetEntityId: targetId, targetTokenId: data0.targetTokenId || null,
              components: comps, toHit, toHitRoll, d20a, d20b, advMode, effect,
              weaponName: String(data0.weaponName || '').slice(0, 40), attackName: String(data0.attackName || '').slice(0, 40) };
          }
          const req = {
            id: uid('req_'), peerId, playerName: displayNameForPeer(curr, peerId),
            kind, payload, ts: Date.now(), status: 'pending', resolvedTs: null,
          };
          dispatch({ type: 'REQUEST_ADD', request: req });
          // v8.0: start the shared cinematic for attacks (damage). The to-hit
          // is decided here vs the target's AC; every client animates to the
          // same pre-rolled result. If one is already playing, this request
          // waits its turn and the DM overlay promotes it later.
          if (kind === 'apply_damage' && !curr.activeAttack) {
            const src = curr.entities[sourceId];
            const ac = (typeof target.ac === 'number') ? target.ac : null;
            const toHitTotal = (payload.toHitRoll != null) ? payload.toHitRoll + (payload.toHit || 0) : null;
            const hit = (toHitTotal != null && ac != null) ? (toHitTotal >= ac) : true;
            dispatch({ type: 'ATTACK_SET', attack: {
              id: req.id,
              attackerId: sourceId, attackerName: src?.name || 'Attacker', attackerColor: src?.color || '#888', attackerImg: src?.imageUrl || null,
              targetId, targetName: target.name || 'Target', targetColor: target.color || '#888', targetImg: target.imageUrl || null, targetAc: ac,
              weaponName: payload.weaponName || '', attackName: payload.attackName || '',
              toHit: payload.toHit ?? null, toHitRoll: payload.toHitRoll ?? null, hit,
              d20a: payload.d20a, d20b: payload.d20b, advMode: payload.advMode, effect: payload.effect,
              targetStats: target.stats || {}, components: payload.components, startedTs: Date.now(),
            } });
          }
          const tn = target.name || 'a target';
          toast(`${req.playerName} requests ${kind === 'apply_heal' ? `to heal ${tn}` : kind === 'apply_condition' ? `to apply ${payload.condition} to ${tn}` : `to strike ${tn}`}`, 'info');
          pushSoon();
          return;
        }
        // De-dupe: ignore if this peer already has a pending request of the
        // same kind (prevents button spam creating a pile of popups).
        const dup = Object.values(curr.pendingRequests || {}).some(
          r => r.peerId === peerId && r.kind === kind && r.status === 'pending');
        if (dup) return;
        // A peer who already controls a PC can't request another character.
        if (kind === 'new_character' && curr.claims?.[peerId]?.pc) return;
        // Clear any prior *resolved* request of this kind so the queue holds
        // at most one per peer per kind (keeps the gate's lookup unambiguous).
        for (const r of Object.values(curr.pendingRequests || {})) {
          if (r.peerId === peerId && r.kind === kind && r.status !== 'pending') {
            dispatch({ type: 'REQUEST_REMOVE', id: r.id });
          }
        }
        // Validate kind-specific payloads against the requester's own PC so
        // a client can't request changes to someone else or out-of-range.
        let data = action.payload?.data || {};
        if (kind === 'stat_change' || kind === 'level_change') {
          const entId = curr.claims?.[peerId]?.pc;
          const ent = entId && curr.entities[entId];
          if (!ent) return;
          if (kind === 'stat_change') {
            const stat = String(data.stat || '').toLowerCase();
            if (!PLAYER_STATS_WHITELIST.has(stat)) return;
            const from = Number(ent.stats?.[stat] ?? 10);
            const to = Math.round(Number(data.to));
            if (!Number.isFinite(to) || to < 1 || to > 30 || to === from) return;
            data = { entityId: entId, stat, from, to };
          } else {
            const from = Number(ent.level || 1);
            const to = Math.round(Number(data.to));
            // level changes are ±1 only.
            if (!Number.isFinite(to) || Math.abs(to - from) !== 1 || to < 1 || to > 20) return;
            data = { entityId: entId, from, to };
          }
        }
        if (kind === 'place_token') {
          // v8.5: a player asks the DM to place one of their own tokens at a
          // chosen spot. Validate ownership + coords server-side.
          const entId = String(data.entityId || '');
          const owned = ownedByPeer(curr, peerId);
          const ent = curr.entities[entId];
          if (!ent || !owned.has(entId)) return;
          const x = Number(data.x), y = Number(data.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          data = { entityId: entId, entityName: ent.name, x, y, mapId: String(data.mapId || curr.currentMapId) };
        }
        const req = {
          id: uid('req_'), peerId, playerName: displayNameForPeer(curr, peerId),
          kind, payload: data,
          ts: Date.now(), status: 'pending', resolvedTs: null,
        };
        dispatch({ type: 'REQUEST_ADD', request: req });
        toast(`${req.playerName} requests ${kind === 'new_character' ? 'a new character' : kind === 'level_change' ? 'a level change' : kind === 'place_token' ? `to place ${data.entityName || 'a token'}` : 'a stat change'}`, 'info');
        pushSoon();
        return;
      }
      // v7.8: a stat/HP roll made during character creation, logged to chat
      // visible ONLY to the DM (whisperTo='dm'), so the table has an audit
      // trail of what each player rolled.
      case 'creation_roll': {
        const txt = String(action.payload?.text || '').slice(0, 200);
        if (!txt) return;
        dispatch({ type: 'CHAT_ADD', message: {
          id: uid('msg_'), ts: Date.now(), senderId: 'dm',
          senderName: '🎲 Creation', text: `${displayNameForPeer(curr, peerId)}: ${txt}`,
          whisperTo: 'dm', whisperToName: 'DM',
        } });
        pushSoon();
        return;
      }
      // v7.8: after the DM accepts a level-UP, the player rolls the new
      // level's hit die client-side; the DM adds roll + CON mod to max (and
      // current) HP and clears the awaiting flag. Logged DM-only.
      case 'roll_levelup_hp': {
        const entId = curr.claims?.[peerId]?.pc;
        const ent = entId && curr.entities[entId];
        if (!ent || !ent.awaitingHpRoll) return;
        const die = ent.awaitingHpRoll.die || CLASS_HIT_DIE[ent.class] || 8;
        let roll = Math.round(Number(action.payload?.roll));
        if (!Number.isFinite(roll) || roll < 1 || roll > die) roll = rollHitDie(die);
        const conMod = Math.floor(((ent.stats?.con ?? 10) - 10) / 2);
        const add = Math.max(1, roll + conMod);
        const newMax = (ent.hp?.max || 0) + add;
        dispatch({ type: 'ENTITY_PATCH', id: ent.id, patch: {
          hp: { current: (ent.hp?.current || 0) + add, max: newMax }, awaitingHpRoll: null,
        } });
        dispatch({ type: 'CHAT_ADD', message: {
          id: uid('msg_'), ts: Date.now(), senderId: 'dm', senderName: '🎲 Level-up',
          text: `${displayNameForPeer(curr, peerId)} rolled d${die}→${roll}${conMod >= 0 ? '+' : ''}${conMod} = +${add} HP (max now ${newMax})`,
          whisperTo: 'dm', whisperToName: 'DM',
        } });
        pushSoon();
        return;
      }
      // v7.6/7.8: a player finalises a brand-new PC built in the multi-phase
      // creator. Requires an *accepted* new_character grant (the gate); the
      // grant is consumed on success. The DM clamps every value so a client
      // can't inject impossible stats/HP. Idempotent on an existing claim.
      case 'create_and_claim_pc': {
        const existing0 = curr.claims?.[peerId];
        if (existing0 && existing0.pc) return;
        // Gate: there must be an accepted new_character grant for this peer.
        const grant = Object.values(curr.pendingRequests || {}).find(
          r => r.peerId === peerId && r.kind === 'new_character' && r.status === 'accepted');
        if (!grant) { console.warn('[plagues-call] create_and_claim_pc without grant'); return; }
        // v8.3 FIX: the player's builder re-sends this action on an interval
        // until the claim syncs back. React dispatches don't update stateRef
        // synchronously, so a burst of retries could each pass the claim/grant
        // guards above and spawn duplicate PCs (the "4-5 identical tokens" bug).
        // Consume the grant id in a ref the instant we accept it - this is
        // synchronous and immune to dispatch/render timing, so every retry for
        // the same grant after the first is dropped here.
        if (consumedGrantsRef.current.has(grant.id)) return;
        consumedGrantsRef.current.add(grant.id);
        const p = action.payload || {};
        const name = (String(p.name || '').trim().slice(0, 60)) || 'New Hero';
        const cls = String(p.class || '').slice(0, 40);
        const race = String(p.race || '').slice(0, 40);
        const level = Math.min(20, Math.max(1, Math.round(Number(p.level)) || 1));
        const stats = {};
        for (const k of ['str', 'dex', 'con', 'int', 'wis', 'cha']) {
          const n = Math.round(Number((p.stats || {})[k]));
          stats[k] = Number.isFinite(n) ? Math.min(30, Math.max(1, n)) : 10;
        }
        const die = CLASS_HIT_DIE[cls] || 8;
        const conMod = Math.floor((stats.con - 10) / 2);
        // Trust the builder's rolled HP but clamp to a plausible band for the
        // level (level-1 is fixed max die; higher levels could roll high).
        const hpFloor = Math.max(1, level + level * conMod);
        const hpCeil = (die + conMod) + (level - 1) * (die + conMod);
        let hpMax = Math.round(Number(p.hp));
        if (!Number.isFinite(hpMax)) hpMax = die + conMod;
        hpMax = Math.min(Math.max(hpMax, Math.max(1, hpFloor)), Math.max(hpCeil, die + conMod));
        hpMax = Math.max(1, hpMax);
        const raceData = DND_RACES.find(r => r.name === race);
        // v7.8: accept a custom speed from the builder (homebrew races); clamp
        // to a sane band, else fall back to the known race's speed or 30.
        const reqSpeed = Math.round(Number(p.speed));
        const speed = (Number.isFinite(reqSpeed) && reqSpeed >= 0 && reqSpeed <= 200)
          ? reqSpeed : (raceData?.speed || 30);
        // v7.8: carry every race element onto the sheet. Standard races draw
        // their size/height/traits from the authoritative table; homebrew races
        // bring theirs from the (clamped) builder payload. The result is written
        // into Features & Traits so a custom race is as complete as a stock one.
        const desc = raceData
          ? { size: raceData.size, height: raceData.height, traits: raceData.bonus }
          : { size: String(p.size || '').slice(0, 20),
              height: String(p.raceHeight || '').slice(0, 40),
              traits: String(p.raceTraits || '').slice(0, 500) };
        const raceLines = [];
        if (race) raceLines.push(`Race: ${race}`);
        const meta = [];
        if (desc.size) meta.push(`Size: ${desc.size}`);
        meta.push(`Speed: ${speed} ft`);
        if (desc.height) meta.push(`Typical height: ${desc.height}`);
        if (meta.length) raceLines.push(meta.join(' · '));
        if (desc.traits) raceLines.push(String(desc.traits).trim());
        const features = raceLines.join('\n');
        const clip = (v, n) => String(v || '').slice(0, n);
        const ent = makeEntity({
          type: 'PC', name, class: cls, level, stats, race,
          speed,
          features,
          background: clip(p.background, 40),
          traits: clip(p.traits, 400),
          ideals: clip(p.ideals, 300),
          bonds: clip(p.bonds, 300),
          flaws: clip(p.flaws, 300),
          backstory: clip(p.backstory, 1000),
          hp: { current: hpMax, max: hpMax },
          initBonus: Math.floor((stats.dex - 10) / 2),
          proficiencyBonus: 2 + Math.floor((level - 1) / 4),
          hitDice: `${level}d${die}`,
          playerName: existing0?.playerName || grant.playerName || '',
        });
        dispatch({ type: 'ENTITY_UPSERT', entity: ent });
        dispatch({ type: 'CLAIM_PC', peerId, entityId: ent.id, playerName: ent.playerName });
        dispatch({ type: 'REQUEST_REMOVE', id: grant.id }); // consume the grant
        toast(`${name} (${race} ${cls} ${level}) created & claimed`, 'success');
        pushSoon();
        return;
      }
      case 'claim_pc': {
        const { entityId, playerName } = action.payload;
        const entity = curr.entities[entityId];
        if (!entity || entity.type !== 'PC') return;
        // v7.2: idempotency. If this peer already has this PC claimed,
        // ignore the duplicate - mobile double-taps otherwise trigger
        // two full state-sync rounds per claim.
        const existing = curr.claims?.[peerId];
        if (existing && existing.pc === entityId) {
          dlog(`[plagues-call] claim_pc ignored (already claimed by same peer) ${entityId.slice(-6)}`);
          return;
        }
        const takenBySomeoneElse = Object.entries(curr.claims || {})
          .some(([k, c]) => c.pc === entityId && k !== peerId);
        if (takenBySomeoneElse) return;
        const t0 = performance.now();
        dispatch({ type: 'CLAIM_PC', peerId, entityId, playerName });
        toast(`${entity.name} claimed by ${playerName || 'a player'}`, 'success');
        dlog(`[plagues-call] claim_pc ${entityId.slice(-6)} dispatched in ${(performance.now() - t0).toFixed(0)}ms`);
        pushSoon();
        break;
      }
      case 'unclaim_pc':
        dispatch({ type: 'UNCLAIM_PC', peerId });
        break;
      case 'claim_familiar': {
        const { entityId, playerName } = action.payload;
        const entity = curr.entities[entityId];
        if (!entity || entity.type !== 'Familiar') return;
        // v7.2: idempotency for duplicate taps.
        const existing = curr.claims?.[peerId];
        if (existing && (existing.familiars || []).includes(entityId)) return;
        const takenBySomeoneElse = Object.entries(curr.claims || {})
          .some(([k, c]) => (c.familiars || []).includes(entityId) && k !== peerId);
        if (takenBySomeoneElse) return;
        dispatch({ type: 'CLAIM_FAMILIAR', peerId, entityId });
        if (playerName) dispatch({ type: 'SET_PLAYER_NAME', peerId, playerName });
        pushSoon();
        break;
      }
      case 'unclaim_familiar':
        dispatch({ type: 'UNCLAIM_FAMILIAR', peerId, entityId: action.payload.entityId });
        break;
      case 'claim_spectator':
        dispatch({ type: 'CLAIM_SPECTATOR', peerId, playerName: action.payload.playerName });
        pushSoon();
        break;
      // v8.3: a player rolling the save/contest for a token they own (the
      // target's perspective). The host recomputes success against the current
      // DC (so a client can't fake the threshold) and broadcasts it.
      case 'attack_save_roll': {
        const atk = curr.activeAttack;
        if (!atk || atk.id !== action.attackId || atk.saveResult) return;
        if (!ownedByPeer(curr, peerId).has(atk.targetId)) return;
        const dc = atk.effect?.save?.dc;
        if (dc == null) return;
        const sr = action.saveResult || {};
        const roll = Math.max(1, Math.min(20, Math.round(Number(sr.roll)) || 1));
        const mod = Math.max(-20, Math.min(20, Math.round(Number(sr.mod)) || 0));
        const total = roll + mod;
        dispatch({ type: 'ATTACK_UPDATE', id: atk.id, patch: { saveResult: {
          ability: atk.effect.save.ability, dc, d20a: sr.d20a, d20b: sr.d20b,
          advMode: ['normal', 'advantage', 'disadvantage'].includes(sr.advMode) ? sr.advMode : 'normal',
          roll, mod, total, success: total >= dc,
        } } });
        pushSoon();
        return;
      }
      // v8.3: a player declares a movement mode for this turn (dash / fly /
      // walk / jump). Only valid for the entity whose turn it is, owned by
      // the requesting peer.
      case 'movement_mode': {
        const entityId = action.entityId;
        const entity = curr.entities[entityId];
        if (!entity) return;
        if (!ownedByPeer(curr, peerId).has(entityId)) return;
        const init = curr.initiative;
        if (!(init?.active && init.entries[init.turn]?.entityId === entityId)) return;
        dispatch({ type: 'MOVEMENT_MODE', entityId, mode: action.mode });
        pushSoon();
        return;
      }
      case 'move_token': {
        const { tokenId, x, y } = action.payload;
        // v8.9: reject non-finite coordinates before any math runs. A hostile
        // or buggy client could send x:"abc" and detonate inside toFixed().
        if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) {
          console.log('[plagues-call] move_token REJECT: non-finite coords');
          return;
        }
        const token = curr.tokens[tokenId];
        if (!token) {
          dlog(`[plagues-call] DM move_token REJECT: no token ${tokenId?.slice(-6)} from peer=${peerId?.slice(-6)}`);
          return;
        }
        const entity = curr.entities[token.entityId];
        if (!entity) {
          dlog(`[plagues-call] DM move_token REJECT: no entity for token ${tokenId.slice(-6)}`);
          return;
        }
        const owned = ownedByPeer(curr, peerId);
        if (!owned.has(entity.id)) {
          dlog(`[plagues-call] DM move_token REJECT: peer ${peerId.slice(-6)} doesn't own ${entity.name} (${entity.id.slice(-6)}). owned=[${[...owned].map(id => id.slice(-6)).join(',')}] claim=${JSON.stringify(curr.claims?.[peerId])}`);
          return;
        }
        // v7.8: off-turn movement lock. During active combat, a player may
        // only move the token whose initiative turn it currently is.
        if (curr.lockOffTurn && curr.initiative?.active && curr.initiative.entries.length) {
          const activeId = curr.initiative.entries[curr.initiative.turn]?.entityId;
          if (activeId !== entity.id) {
            dlog(`[plagues-call] move_token REJECT: off-turn locked (active=${String(activeId).slice(-6)}, tried=${entity.id.slice(-6)})`);
            pushSoon(); // snap the token back for the mover
            return;
          }
        }
        // v7.8: during combat, a player may only move within their remaining
        // movement budget on their own turn. Clamp the destination to the
        // remaining range (measured from the token's current position) and
        // bank the distance actually travelled. The DM is never budget-limited
        // (DM moves go through plain TOKEN_MOVE, not this handler).
        let nx = x, ny = y;
        const init = curr.initiative;
        const mv = curr.movement;
        const isActiveTurn = init?.active && init.entries[init.turn]?.entityId === entity.id;
        if (isActiveTurn && mv && mv.entityId === entity.id) {
          const cap = (mv.budgetFt != null) ? mv.budgetFt : walkSpeedOf(entity);
          const remainingPx = Math.max(0, cap - (mv.usedFt || 0)) * PX_PER_FOOT;
          const dx = x - token.x, dy = y - token.y;
          const dist = Math.hypot(dx, dy);
          let movedPx = dist;
          if (dist > remainingPx) {
            const k = remainingPx / dist; // clamp onto the remaining circle
            nx = token.x + dx * k;
            ny = token.y + dy * k;
            movedPx = remainingPx;
          }
          dispatch({ type: 'MOVEMENT_USE', addFt: movedPx / PX_PER_FOOT });
        }
        dlog(`[plagues-call] DM move_token OK peer=${peerId.slice(-6)} token=${tokenId.slice(-6)} → (${nx.toFixed(0)}, ${ny.toFixed(0)})`);
        dispatch({ type: 'TOKEN_MOVE', id: tokenId, x: nx, y: ny });
        // v8.3: on-entry hazard damage. If this move carried the token into a
        // damaging hazard flagged "on entry" that it wasn't already inside.
        {
          const entered = damagingHazardsAt(curr, token.mapId, nx, ny)
            .filter(h => h.damage.onEntry && !pointInPoly(token.x, token.y, h.points));
          if (entered.length && entity.hp && entity.hp.current > 0) {
            for (const h of entered) {
              const rolled = rollHazardDamage(h.damage);
              dispatch({ type: 'HAZARD_QUEUE', event: {
                id: uid('hzd_'), entityId: entity.id, entityName: entity.name, entityColor: entity.color || '#888',
                tokenId, hazardId: h.id, hazardKind: h.hazardKind, dmgType: h.damage.type || h.hazardKind,
                rolled, reason: 'entry', ts: Date.now(),
              } });
            }
          }
        }
        // v7.2: broadcast ephemeral token_pos to all OTHER peers so
        // remote viewers see the movement immediately (not waiting for
        // the 120ms state_update debounce). The originating peer has
        // already applied the move optimistically.
        const sync = syncRef.current;
        if (sync?.connections) {
          let sentCount = 0;
          for (const [pid, conn] of sync.connections) {
            if (pid === peerId) continue;
            if (!conn?.open) continue;
            try {
              conn.send({ type: 'token_pos', tokenId, x: nx, y: ny, mapId: token.mapId });
              sentCount++;
            } catch (err) {
              dlog(`[plagues-call] DM token_pos send failed to peer=${pid.slice(-6)}: ${err?.message}`);
            }
          }
          dlog(`[plagues-call] DM token_pos broadcast to ${sentCount} peer(s)`);
        }
        // v7.8: nudge a fresh snapshot so the mover sees the clamped position
        // and updated remaining budget promptly.
        if (isActiveTurn) pushSoon();
        break;
      }
      case 'patch_own_entity': {
        // v3: expanded whitelist - players may edit the full stat block on
        // their own entities, but certain DM-only fields are never writable.
        const { entityId, op } = action.payload || {};
        const targetId = entityId || curr.claims?.[peerId]?.pc;
        if (!targetId) return;
        if (!ownedByPeer(curr, peerId).has(targetId)) return;
        const entity = curr.entities[targetId];
        if (!entity) return;
        if (op === 'hp_adjust') {
          const delta = Number(action.payload.delta) || 0;
          dispatch({ type: 'ENTITY_HP_ADJUST', id: targetId, delta: clamp(delta, -1000, 1000) });
        } else if (op === 'toggle_condition') {
          const condition = String(action.payload.condition || '');
          if (!CONDITIONS.includes(condition)) return;
          dispatch({ type: 'ENTITY_TOGGLE_CONDITION', id: targetId, condition });
        } else if (op === 'field_set') {
          // Apply a patch of allowed fields. Drop anything outside the whitelist.
          const raw = action.payload.patch || {};
          const patch = {};
          for (const [k, v] of Object.entries(raw)) {
            if (PLAYER_FIELD_WHITELIST.has(k)) patch[k] = v;
          }
          // v4 #9: clamp vision numeric fields so a bad client can't DoS the
          // vision overlay with absurd radii.
          if ('darkvision' in patch)  patch.darkvision  = clamp(Number(patch.darkvision)  || 0, 0, 600);
          if ('lightRadius' in patch) patch.lightRadius = clamp(Number(patch.lightRadius) || 0, 0, 600);
          if (raw.hp && typeof raw.hp === 'object') {
            const hp = {};
            for (const [k, v] of Object.entries(raw.hp)) {
              if (PLAYER_HP_WHITELIST.has(k)) hp[k] = clamp(Number(v) || 0, 0, 10000);
            }
            if (Object.keys(hp).length) patch.hp = hp;
          }
          // v7.8: ability scores are request-only - never applied directly
          // from a player patch. (DM edits go through ENTITY_PATCH instead.)
          if (raw.conditions && Array.isArray(raw.conditions)) {
            patch.conditions = raw.conditions.filter(c => CONDITIONS.includes(c));
          }
          // v7.6: coin purse - keep only known denominations, non-negative ints
          if (raw.money && typeof raw.money === 'object') {
            const money = {};
            for (const [k, v] of Object.entries(raw.money)) {
              if (['pp', 'gp', 'ep', 'sp', 'cp'].includes(k)) money[k] = clamp(Math.floor(Number(v) || 0), 0, 1e9);
            }
            if (Object.keys(money).length) patch.money = money;
          }
          // v7.6: clamp numeric sheet fields; cap long free-text fields
          if ('xp' in patch) patch.xp = clamp(Math.floor(Number(patch.xp) || 0), 0, 1e9);
          if ('proficiencyBonus' in patch) patch.proficiencyBonus = clamp(Number(patch.proficiencyBonus) || 0, 0, 20);
          for (const tf of ['hitDice', 'race', 'background', 'alignment', 'attacks', 'spells', 'features', 'proficiencies', 'inventory', 'traits', 'ideals', 'bonds', 'flaws', 'backstory', 'name', 'notes', 'playerDescription', 'faction', 'role']) {
            if (typeof patch[tf] === 'string') patch[tf] = patch[tf].slice(0, 20000);
          }
          // v8.9: bound the structured equipment/graph fields. They pass the
          // whitelist as arbitrary objects; individual shape isn't validated,
          // so cap their count/serialized size and drop anything absurd.
          if ('weapons' in patch) {
            if (!Array.isArray(patch.weapons) || patch.weapons.length > 50) delete patch.weapons;
          }
          for (const gf of ['armor', 'shield', 'speeds']) {
            if (gf in patch) {
              try { if (JSON.stringify(patch[gf] ?? null).length > 4000) delete patch[gf]; } catch { delete patch[gf]; }
            }
          }
          if ('handsTotal' in patch) patch.handsTotal = clamp(Math.floor(Number(patch.handsTotal) || 2), 0, 20);
          // Sanitize image data URL - must start with data:image/
          if (typeof patch.imageUrl === 'string' && !patch.imageUrl.startsWith('data:image/') && patch.imageUrl !== '') {
            delete patch.imageUrl;
          }
          // v8.9: cap portrait size. The DM's own upload UI downscales to a
          // 256px JPEG, but a modified client could set a 50MB data URL that
          // then rides inline in every broadcast (portraits aren't stripped by
          // stripHeavyAssetsForWire). Reject anything over ~200KB.
          if (typeof patch.imageUrl === 'string' && patch.imageUrl.length > 200000) {
            delete patch.imageUrl;
            toast?.('Portrait too large (max ~200KB) - not applied', 'error');
          }
          if (Object.keys(patch).length) {
            dispatch({ type: 'ENTITY_PATCH', id: targetId, patch });
          }
        }
        break;
      }
      case 'reminder_upsert': {
        // Player's own reminder on their own track. Defensive sanitize.
        const r = action.payload?.reminder;
        if (!r || typeof r !== 'object') return;
        const safe = {
          id: String(r.id || uid('rem_')),
          mapId: r.mapId ? String(r.mapId) : null,
          x: Number(r.x) || 0,
          y: Number(r.y) || 0,
          label: String(r.label || '').slice(0, 200),
          color: typeof r.color === 'string' ? r.color.slice(0, 20) : '#c9a34a',
          size: clamp(Number(r.size) || 1, REMINDER_SIZE_MIN, REMINDER_SIZE_MAX),
        };
        dispatch({ type: 'REMINDER_UPSERT', peerId, reminder: safe });
        break;
      }
      case 'reminder_delete': {
        dispatch({ type: 'REMINDER_DELETE', peerId, id: String(action.payload?.id || '') });
        break;
      }
      // v6 #10: Player drawings flow through DM authority. Validate +
      // sanitize shape + stamp owner as the originating peerId so the
      // DM can track who drew what, and so 'drawing_clear_owner' can
      // wipe just that player's drawings.
      case 'drawing_upsert': {
        const { mapId, drawing } = action.payload || {};
        if (!mapId || !drawing?.type) return;
        if (!curr.maps?.[mapId]) return;
        const allowedTypes = new Set(['free', 'line', 'circle']);
        if (!allowedTypes.has(drawing.type)) return;
        const color = typeof drawing.color === 'string' ? drawing.color.slice(0, 30) : '#c9a34a';
        const width = clamp(Number(drawing.width) || 3, 1, 16);
        let safe;
        if (drawing.type === 'free') {
          const pts = Array.isArray(drawing.points) ? drawing.points : [];
          if (pts.length < 2) return;
          // Cap the number of points so a malicious client can't submit millions
          const clippedPts = pts.slice(0, 500).map(p => [Number(p[0]) || 0, Number(p[1]) || 0]);
          safe = { id: uid('draw_'), type: 'free', points: clippedPts, color, width, owner: peerId };
        } else if (drawing.type === 'line') {
          safe = {
            id: uid('draw_'), type: 'line',
            x0: Number(drawing.x0) || 0, y0: Number(drawing.y0) || 0,
            x1: Number(drawing.x1) || 0, y1: Number(drawing.y1) || 0,
            color, width, owner: peerId,
          };
        } else if (drawing.type === 'circle') {
          safe = {
            id: uid('draw_'), type: 'circle',
            cx: Number(drawing.cx) || 0, cy: Number(drawing.cy) || 0,
            r: clamp(Number(drawing.r) || 0, 0, 5000),
            color, width, owner: peerId,
          };
        }
        if (safe) dispatch({ type: 'DRAWING_UPSERT', mapId, drawing: safe });
        break;
      }
      case 'drawing_clear_owner': {
        const mapId = action.payload?.mapId;
        if (!mapId || !curr.maps?.[mapId]) return;
        dispatch({ type: 'DRAWING_CLEAR_OWNER', mapId, owner: peerId });
        break;
      }
      // v7.5: Player erases one of their OWN drawings. The DM validates
      // ownership server-side - a player can never delete another
      // player's (or the DM's) drawing, even with a forged id.
      case 'drawing_delete': {
        const { mapId, id } = action.payload || {};
        if (!mapId || !id || !curr.maps?.[mapId]) return;
        const target = (curr.drawings?.[mapId] || []).find(d => d.id === id);
        if (!target || target.owner !== peerId) return;
        dispatch({ type: 'DRAWING_DELETE', mapId, id });
        break;
      }
      // v7.7: a player moves/rotates a non-dmOnly layer. The DM validates
      // the layer exists, isn't DM-only, isn't locked, and that the patch
      // only touches what the current mode permits (move→x,y, rotate→rot).
      case 'layer_transform': {
        const { mapId, id, patch } = action.payload || {};
        if (!mapId || !id || !patch) return;
        const layer = (curr.layers?.[mapId] || []).find(l => l.id === id);
        if (!layer || layer.dmOnly || layer.mode === 'locked') return;
        const clean = {};
        if (layer.mode === 'move') {
          if (Number.isFinite(Number(patch.x))) clean.x = Math.round(Number(patch.x));
          if (Number.isFinite(Number(patch.y))) clean.y = Math.round(Number(patch.y));
        } else if (layer.mode === 'rotate') {
          if (Number.isFinite(Number(patch.rotation))) clean.rotation = Math.round(Number(patch.rotation)) % 360;
        }
        if (Object.keys(clean).length === 0) return;
        dispatch({ type: 'LAYER_UPDATE', mapId, id, patch: clean });
        pushSoon();
        break;
      }
      // v7 #9 / v7.2: Player dice roll. Stamp peerId server-side so a
      // client can't pretend to be someone else; clamp dice quantities
      // and result ranges so a malicious client can't inject a fake
      // crit. Accepts both v7.2 `groups` shape AND legacy flat `dice`
      // array for backward compat with older clients.
      case 'dice_roll': {
        const e = action.payload?.entry;
        if (!e) return;
        const allowedSides = new Set([4, 6, 8, 10, 12, 20]);
        // v8.9 SECURITY: the DM is the source of truth for auto-rolled dice.
        // Previously the host only range-clamped the client's numbers, so a
        // modified client could send results:[20] forever (a fake-crit
        // generator). Now, unless the table is in physical-dice mode (where
        // players legitimately type the numbers they rolled at the table - a
        // setting the DM controls, not the client), the host ROLLS the values
        // itself and keeps only the client's dice COUNT + die size. The
        // player's tray animation is purely cosmetic; it lands on the value the
        // DM broadcasts back through DICE_ROLL.
        const trustEntered = settingsRef.current?.physicalDice === true;
        const rollN = (die, n) => Array.from({ length: n }, () => 1 + Math.floor(Math.random() * die));
        let groups = [];
        let total = 0;
        let totalDice = 0;
        if (Array.isArray(e.groups)) {
          for (const g of e.groups) {
            if (!allowedSides.has(g?.die)) continue;
            if (!Array.isArray(g.results)) continue;
            const count = Math.min(100, g.results.length);
            if (count === 0) continue;
            if (totalDice + count > 200) break;
            const sanitized = trustEntered
              ? g.results.slice(0, 100).map(r => clamp(r | 0, 1, g.die | 0))
              : rollN(g.die | 0, count);
            groups.push({ die: g.die | 0, results: sanitized });
            total += sanitized.reduce((s, r) => s + r, 0);
            totalDice += sanitized.length;
          }
        } else if (Array.isArray(e.dice)) {
          const dice = e.dice.slice(0, 100).filter(d => allowedSides.has(d.die));
          if (dice.length > 0) {
            // v8.9 fix: roll each die at its OWN size. The old code took the
            // first die's size for the whole group, so a legacy 2d6 + 1d20 got
            // re-rolled as all d20s on the server.
            const sides = dice[0].die | 0;
            const results = trustEntered
              ? dice.map(d => clamp(d.result | 0, 1, d.die | 0))
              : dice.map(d => 1 + Math.floor(Math.random() * (d.die | 0)));
            groups = [{ die: sides, results }];
            total = results.reduce((s, r) => s + r, 0);
            totalDice = results.length;
          }
        }
        if (groups.length === 0) return;
        const peerName = typeof e.peerName === 'string' ? e.peerName.slice(0, 40) : 'Player';
        const expression = groups.map(g => `${g.results.length}d${g.die}`).join(' + ');
        const entry = {
          id: uid('roll_'),
          ts: Date.now(),
          peerId,
          peerName,
          groups,
          total,
          expression,
        };
        dlog(`[plagues-call] dice_roll ${peerName}: ${expression} = ${total}`);
        dispatch({ type: 'DICE_ROLL', entry });
        break;
      }
      // v7 #10: Player-side sound triggers are not allowed; only the DM
      // can play sounds. We stub a case so player attempts are ignored
      // explicitly rather than falling through to no-op.
      case 'sound_play':
      case 'sound_stop':
        return;
    }
  }, [toast]);

  if (auth.mode === 'dm') {
    return (
      <DMInterface
        state={state}
        dispatch={dispatch}
        sync={syncRef.current}
        syncStatus={auth.local ? 'local' : syncStatus}
        peerCount={peerList.length}
        peerList={peerList}
        onLogout={onLogout}
        roomCode={auth.local ? null : auth.roomCode}
        toast={toast}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onOpenSettings={onOpenSettings}
        showSettings={showSettings}
        onCloseSettings={onCloseSettings}
      />
    );
  }

  return (
    <>
      {awaitingApproval && (
        <div className="onboarding-overlay" style={{ zIndex: 9000 }}>
          <div className="onboarding-card" style={{ textAlign: 'center', maxWidth: 420 }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🚪</div>
            <h2 style={{ fontFamily: "'Cinzel', serif", color: 'var(--gold)', marginBottom: 8 }}>Waiting to be admitted</h2>
            <p style={{ color: 'var(--ink-dim)', fontSize: 14, lineHeight: 1.5 }}>
              This table requires the DM to approve new players. Hold tight - you'll join automatically the moment they let you in.
            </p>
            <div className="spinner" style={{ margin: '16px auto 0' }} />
          </div>
        </div>
      )}
      <PlayerInterface
        state={state}
        dispatch={dispatch}
        myPeerId={myPeerId}
        playerName={auth.playerName}
        sync={syncRef.current}
        syncStatus={syncStatus}
        onLogout={onLogout}
        roomCode={auth.roomCode}
        toast={toast}
        settings={settings}
        onSettingsChange={onSettingsChange}
        onOpenSettings={onOpenSettings}
        showSettings={showSettings}
        onCloseSettings={onCloseSettings}
      />
    </>
  );
}

// ====================================================================
// MOUNT
// ====================================================================
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ToastProvider>
    <Root />
  </ToastProvider>
);
