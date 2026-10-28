// Copyright (c) 2026 Anish Sandeep Bhargav (Dytalmc). Licensed under the MIT License; see LICENSE.
(() => {
  'use strict';

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const CONFIG = window.SKYHOPPER_CONFIG || {};
  const ACHIEVEMENT_GROUPS = [
    { prefix: 'score', title: 'Gate Runner', category: 'Best score', metric: 'bestScore', count: 200, target: n => n <= 20 ? n : n <= 50 ? 20 + (n - 20) * 5 : n <= 100 ? 170 + (n - 50) * 10 : n <= 150 ? 670 + (n - 100) * 25 : 1920 + (n - 150) * 59, description: t => `Reach a best score of ${t}.` },
    { prefix: 'flights', title: 'Sky Traveller', category: 'Flights', metric: 'gamesPlayed', count: 200, target: n => n <= 25 ? n : n <= 100 ? 25 + (n - 25) * 4 : n <= 150 ? 325 + (n - 100) * 10 : 825 + (n - 150) * 1500 + (n - 150) ** 2 * 130, description: t => `Complete ${t.toLocaleString()} flights.` },
    { prefix: 'items', title: 'Curio Collector', category: 'Items', metric: 'itemsCollected', count: 200, target: n => n <= 25 ? n : n <= 75 ? 25 + (n - 25) * 5 : n <= 125 ? 275 + (n - 75) * 20 : 1275 + (n - 125) * 550 + (n - 125) ** 2 * 80, description: t => `Collect ${t.toLocaleString()} flight relics.` },
    { prefix: 'rare', title: 'Star Seeker', category: 'Rare finds', metric: 'rareItems', count: 150, target: n => n <= 10 ? n : n <= 40 ? 10 + (n - 10) * 3 : n <= 100 ? 100 + (n - 40) * 10 : 700 + (n - 100) * 1500 + (n - 100) ** 2 * 200, description: t => `Collect ${t.toLocaleString()} rare-or-better relics.` },
    { prefix: 'arcade', title: 'Arcade Voyager', category: 'Arcade score', metric: 'arcadeScore', count: 150, target: n => n <= 25 ? n : n <= 75 ? 25 + (n - 25) * 5 : n <= 125 ? 275 + (n - 75) * 20 : 1275 + (n - 125) * 2500 + (n - 125) ** 2 * 200, description: t => `Earn ${t.toLocaleString()} total Arcade points.` },
    { prefix: 'upgrades', title: 'Bazaar Legend', category: 'Store purchases', metric: 'upgradesPurchased', count: 100, target: n => n <= 10 ? n : n <= 30 ? 10 + (n - 10) * 2 : n <= 60 ? 50 + (n - 30) : 80 + Math.ceil((n - 60) * 23 / 40), description: t => `Complete ${t.toLocaleString()} in-game store purchases.` }
  ];
  const AWARDS = ACHIEVEMENT_GROUPS.flatMap(group => Array.from({ length: group.count }, (_, i) => {
    const n = i + 1, target = group.target(n);
    return { id: `${group.prefix}_${String(n).padStart(3, '0')}`, name: `${group.title} ${String(n).padStart(3, '0')}`, note: group.description(target), symbol: ['✦', '⌁', '♛', '◇', '☼', 'ϟ'][ACHIEVEMENT_GROUPS.indexOf(group)], category: group.prefix, metric: group.metric, target };
  }));
  const RARITIES = [
    { id: 'common', name: 'Common', weight: 48, count: 40, color: '#c4cfdd' },
    { id: 'uncommon', name: 'Uncommon', weight: 28, count: 30, color: '#83f1d0' },
    { id: 'rare', name: 'Rare', weight: 15, count: 22, color: '#86dfff' },
    { id: 'epic', name: 'Epic', weight: 6.5, count: 16, color: '#bca5ff' },
    { id: 'legendary', name: 'Legendary', weight: 2, count: 8, color: '#ffd68a' },
    { id: 'mythic', name: 'Mythic', weight: .5, count: 4, color: '#ffa79c' }
  ];
  const ITEM_TYPES = [
    { id: 'shield', label: 'Aegis', symbol: '⬡', aura: '#bca5ff', texture: 'hex-weave', description: 'Wraps the bird in a one-hit ward. The shield can rescue a risky crossing.' },
    { id: 'slow', label: 'Hourglass', symbol: '⌛', aura: '#86dfff', texture: 'time-rings', description: 'Bends the pace of the sky, giving your next few gates a slower rhythm.' },
    { id: 'heal', label: 'Heart', symbol: '♥', aura: '#ffa79c', texture: 'heart-pulse', description: 'Restores a heart in Arcade, or grants a brief protective pulse at full health.' },
    { id: 'magnet', label: 'Magnet', symbol: '⊛', aura: '#83f1d0', texture: 'orbit-lines', description: 'Pulls nearby relics toward your flight path for a short collection window.' },
    { id: 'gust', label: 'Gust', symbol: '〰', aura: '#b7e6ff', texture: 'wind-streaks', description: 'Releases a lift of wind that nudges the bird upward and steadies its arc.' },
    { id: 'score', label: 'Star', symbol: '✦', aura: '#ffd68a', texture: 'star-map', description: 'Charges your next gates with bonus points. Score relics never grant coins directly.' },
    { id: 'ward', label: 'Ward', symbol: '◈', aura: '#f2c4ff', texture: 'rune-grid', description: 'A rare protective rune that refreshes a stronger shield and brief invulnerability.' },
    { id: 'time', label: 'Time Shard', symbol: '◷', aura: '#ffb8db', texture: 'prism-clock', description: 'Adds time to Slow Skies and leaves a luminous time-wake behind the bird.' }
  ];
  const RELIC_PREFIXES = ['Dawnlit', 'Cinder', 'Frostbound', 'Mosslight', 'Velvet', 'Astral', 'Tidal', 'Sun-forged', 'Moonwoven', 'Wildspark', 'Cloudglass', 'Rosegold', 'Thunderkissed', 'Starfall', 'Dreaming', 'Eclipse'];
  const RELIC_DESCRIPTORS = ['Whisper', 'Echo', 'Prism', 'Promise', 'Memory', 'Secret', 'Waltz', 'Signal', 'Crown', 'Petal', 'Cipher', 'Lantern', 'Comet', 'Oath', 'Mirage'];
  const ABILITY_ITEMS = [];
  let itemIndex = 1;
  for (const rarity of RARITIES) {
    for (let i = 0; i < rarity.count; i++, itemIndex++) {
      const type = ITEM_TYPES[(itemIndex - 1) % ITEM_TYPES.length];
      const tier = RARITIES.indexOf(rarity);
      const prefix = RELIC_PREFIXES[(itemIndex * 7 + tier) % RELIC_PREFIXES.length];
      const descriptor = RELIC_DESCRIPTORS[(itemIndex * 3 + i) % RELIC_DESCRIPTORS.length];
      ABILITY_ITEMS.push({
        code: `ability_${String(itemIndex).padStart(3, '0')}`,
        name: `${prefix} ${type.label} ${descriptor} ${String(itemIndex).padStart(3, '0')}`,
        description: type.description,
        effectDescription: type.id === 'shield' || type.id === 'ward' ? `Protective aura for up to ${(1.2 + (Math.min(10, 1 + tier * 2 + (i % 4)) * .42)).toFixed(1)} seconds.` : type.id === 'slow' || type.id === 'time' ? `Slow the world for up to ${(1.2 + Math.min(10, 1 + tier * 2 + (i % 4)) * .24).toFixed(1)} seconds.` : type.id === 'heal' ? 'Restore one heart or receive a small shield when hearts are full.' : type.id === 'magnet' ? 'Draw relics closer to your bird while the magnet field is active.' : type.id === 'gust' ? 'Get a burst of lift and a colour-matched wind ribbon.' : 'Store a score multiplier for the next gate crossings.',
        rarity: rarity.id, rarityName: rarity.name, rarityColor: rarity.color, rarityWeight: rarity.weight,
        type: type.id, typeName: type.label, symbol: type.symbol, auraColor: type.aura, texture: type.texture,
        textureVariant: (itemIndex - 1) % 5, power: Math.min(10, 1 + tier * 2 + (i % 4)),
        dropChance: rarity.weight / rarity.count
      });
    }
  }
  const UPGRADES = [
    { code: 'shield_core', name: 'Aegis Tuning', desc: 'Extend Star Shield duration.', basePrice: 20, maxLevel: 5, color: '#bca5ff', effect: '+0.35s shield per level' },
    { code: 'cooldown_coil', name: 'Quick-Charge Coil', desc: 'Reduce ability cooldowns.', basePrice: 25, maxLevel: 5, color: '#86dfff', effect: '−6% cooldown per level' },
    { code: 'slow_clock', name: 'Slow-Sky Dial', desc: 'Keep slow skies active longer.', basePrice: 25, maxLevel: 5, color: '#83f1d0', effect: '+0.5s slow per level' },
    { code: 'heart_vessel', name: 'Heart Vessel', desc: 'Start Arcade flights with extra health.', basePrice: 50, maxLevel: 2, color: '#ffa79c', effect: '+1 starting heart per level' },
    { code: 'magnet_field', name: 'Relic Magnet', desc: 'Collect flying relics from farther away.', basePrice: 20, maxLevel: 5, color: '#83f1d0', effect: '+18px pickup reach per level' },
    { code: 'rarity_compass', name: 'Rarity Compass', desc: 'Slightly improve higher-tier drop odds.', basePrice: 40, maxLevel: 5, color: '#ffd68a', effect: 'Better rare-drop weighting' },
    { code: 'score_lens', name: 'Comet Lens', desc: 'Every fifth gate can earn a bonus point.', basePrice: 50, maxLevel: 3, color: '#ffd68a', effect: 'Bonus points at levels 2–3' },
    { code: 'wind_rider', name: 'Tailwind Stitching', desc: 'Give collected Gust relics a stronger lift.', basePrice: 35, maxLevel: 5, color: '#86dfff', effect: 'Stronger Gust effect' }
  ];
  const COSMETIC_DEPARTMENTS = {
    birds: [
      ['bird_classic','Classic Dawn','#ffd477','#f49a5e','dots','✦','common',0,'The original little flyer, touched by a warm sunrise.'],
      ['bird_cobalt','Cobalt Current','#86dfff','#4567ca','waves','◈','common',25,'Deep-blue feathers with a cool current running through them.'],
      ['bird_peach','Peach Comet','#ffbca0','#e77b83','speckles','✧','common',25,'Soft peach enamel with comet-dust speckles.'],
      ['bird_moss','Mosslight Sprite','#9bdaa2','#447d63','leaf','❋','common',30,'A woodland glow with leaf-like feather markings.'],
      ['bird_lilac','Lilac Dream','#d4b7ff','#8875d5','stars','✦','uncommon',35,'Lilac plumage that catches the light like a lucid dream.'],
      ['bird_ember','Emberwing','#ff9b72','#c94d54','flame','♨','uncommon',40,'Burnished ember feathers and a little extra attitude.'],
      ['bird_glacier','Glacier Finch','#c7f4ff','#76b9d9','frost','❄','uncommon',40,'Ice-blue feathers with a crystalline frost pattern.'],
      ['bird_honey','Honey Halo','#ffe49a','#cf8b36','honeycomb','✺','uncommon',45,'Golden honey tones and a glossy, sunlit belly.'],
      ['bird_rose','Rose Quartz','#ffb6d4','#b65f93','crystal','♡','rare',50,'Polished rose-quartz colours with delicate crystal facets.'],
      ['bird_midnight','Midnight Owl','#68729e','#222b52','constellation','☾','rare',55,'A night-sky coat sprinkled with tiny constellations.'],
      ['bird_solar','Solar Flare','#fff0a8','#ff804b','rays','☼','rare',60,'Bright solar gold with a fiery orange edge.'],
      ['bird_jade','Jade Lantern','#85e4ca','#237e75','scales','◈','rare',60,'Jade enamel with small, overlapping scale marks.'],
      ['bird_aurora','Aurora Echo','#b4f5e8','#a9a0ff','aurora','✧','epic',70,'A shifting aurora gradient across the original bird silhouette.'],
      ['bird_prism','Prism Drift','#ffb4df','#8bd9ff','prism','◇','epic',75,'Prismatic feather highlights that shimmer when you flap.'],
      ['bird_starforged','Starforged','#ffe3a3','#8e7be8','star-map','✦','legendary',90,'Forged in a comet trail, engraved with star-map lines.'],
      ['bird_eclipse','Eclipse Sovereign','#f3c7ff','#33395f','eclipse','◉','mythic',100,'A velvet-dark body framed by a luminous eclipse rim.'],
      ['bird_tangerine','Tangerine Twist','#ffc57a','#f16a4d','stripes','➶','uncommon',35,'A citrus colourway with fast, angled feather marks.'],
      ['bird_seaglass','Sea Glass','#c2fff0','#479aaf','bubbles','◌','epic',80,'Sea-glass colour and tiny bubbles from an imagined coast.']
    ],
    auras: [
      ['aura_none','Barely a Breeze','#8090ad','#52617c','none','·','common',0,'No aura at all: keep the unadorned classic look.'],
      ['aura_mint','Mint Orbit','#83f1d0','#b9ffed','orbit','◌','common',25,'A clean mint orbit that loops around your bird.'],
      ['aura_sun','Sun Halo','#ffd68a','#fff2c1','sunrays','☼','common',25,'A small golden solar halo with pulsing rays.'],
      ['aura_violet','Violet Crown','#bca5ff','#f1dcff','crown','♛','common',30,'Violet arcs rotate like a tiny crown.'],
      ['aura_ember','Ember Ring','#ff9b72','#ffd18c','embers','✧','uncommon',35,'Warm embers orbit your bird in slow spirals.'],
      ['aura_moon','Moon Mist','#d7e4ff','#8ba6d8','moon','☾','uncommon',40,'A cool lunar haze with crescent sparks.'],
      ['aura_ocean','Ocean Pulse','#86dfff','#397bb7','ripple','◎','uncommon',40,'Three ocean-blue pulses ripple out from your flight.'],
      ['aura_rose','Rose Nebula','#ffa9ce','#bc82e4','nebula','✿','rare',50,'A rose-and-lilac nebula swirls around the silhouette.'],
      ['aura_aurora','Aurora Veil','#83f1d0','#bca5ff','aurora','⌁','rare',55,'A soft, shifting northern-light veil.'],
      ['aura_starfield','Starfield Halo','#d5ddff','#7f8dff','stars','✦','rare',60,'A halo of little stars that orbit at different speeds.'],
      ['aura_prism','Prism Halo','#ffb4df','#86dfff','prism','◇','epic',70,'Prismatic double rings flash subtly as you flap.'],
      ['aura_thunder','Thunder Arc','#a9c5ff','#7e72db','lightning','ϟ','epic',75,'A restrained electric arc flickers between two points.'],
      ['aura_frost','Frost Sigil','#d5fbff','#8bcde8','snowflake','❄','epic',75,'A faint crystalline sigil made of icy motes.'],
      ['aura_golden','Golden Hour','#ffdb83','#e99b47','sunrays','✺','legendary',90,'Warm gold light with a soft cinematic flare.'],
      ['aura_eclipse','Mythic Eclipse','#f4ceff','#7d77f8','eclipse','◉','legendary',95,'Dark-violet eclipse rings with a bright pearl corona.'],
      ['aura_celestial','Celestial Choir','#fbe8ae','#bbadff','constellation','✧','mythic',100,'A rare constellation draws itself around the bird.'],
      ['aura_coral','Coral Bloom','#ffb5a7','#f28f9f','petals','❀','uncommon',35,'Tiny coral petals blossom and drift away.'],
      ['aura_glacier','Glacier Crown','#c8f5ff','#7197db','frost','✧','epic',80,'An icy crown glitters with a cool blue aura.']
    ],
    trails: [
      ['trail_none','Quiet Air','#8090ad','#52617c','none','·','common',0,'No wake behind you, just the pure bird and the gaps.'],
      ['trail_mint','Mint Ribbon','#83f1d0','#c0ffee','ribbon','〰','common',25,'A thin mint ribbon follows every flap.'],
      ['trail_comet','Comet Dust','#ffd68a','#fff4ce','dust','✦','common',25,'A fine trail of star dust that fades quickly.'],
      ['trail_bubble','Bubble Drift','#86dfff','#c9f5ff','bubbles','◌','common',30,'Little transparent bubbles float in your wake.'],
      ['trail_rose','Rosewave','#ffa9ce','#ffd5e9','wave','〰','uncommon',35,'A pink wave that undulates with your bird.'],
      ['trail_ember','Ember Dash','#ff9b72','#ffd18c','embers','✧','uncommon',40,'Bright embers flicker and dim behind each flap.'],
      ['trail_violet','Violet Afterimage','#bca5ff','#e8dbff','echo','◇','uncommon',40,'Two faint afterimages trail the bird.'],
      ['trail_ocean','Ocean Wake','#67cce9','#b2f3ff','wave','≈','rare',50,'A sea-blue wake like sunlight on water.'],
      ['trail_leaves','Autumn Leaves','#edac70','#f8d5a6','leaves','❧','rare',55,'Tiny warm leaves tumble in the draft.'],
      ['trail_snow','Snowfall Line','#e5f4ff','#aacfe9','snow','❄','rare',60,'A drifting snowfall that only lasts a heartbeat.'],
      ['trail_prism','Prism Stream','#ffaee5','#8bdfff','prism','◇','epic',70,'A quiet pastel spectrum with no harsh flashing.'],
      ['trail_lightning','Lightning Stitch','#a9c5ff','#e2d8ff','lightning','ϟ','epic',75,'Short electric stitches punctuate the trail.'],
      ['trail_starlight','Starlight Wake','#fff0b7','#c4c7ff','stars','✦','epic',80,'Tiny distant stars appear then wink out.'],
      ['trail_phoenix','Phoenix Ribbon','#ffb270','#ff6f81','flame','♨','legendary',90,'A fiery ribbon with a glowing core.'],
      ['trail_void','Void Thread','#c1b6ff','#6169aa','void','◈','legendary',95,'A dark thread edged by a soft spectral line.'],
      ['trail_celestial','Celestial River','#dbf7ff','#d6b4ff','constellation','✧','mythic',100,'A tiny celestial river that leaves star-map sparks.'],
      ['trail_pollen','Spring Pollen','#ffe0ef','#c4efbb','petals','❀','uncommon',35,'Spring petals wander gently from the flight path.'],
      ['trail_tidal','Tidal Glass','#9cebe0','#518cc0','bubbles','◌','epic',80,'Glassy aqua drops shimmer in a smooth, flowing trail.']
    ],
    wings: [
      ['wings_classic','Classic Feathers','#f7dfac','#d99057','classic','⌁','common',0,'The original wing and its familiar two-beat flap.'],
      ['wings_sail','Sailcloth Wings','#f2f0e5','#8ba9b8','sail','⌁','common',25,'A soft sailcloth wing with a crisp outlined edge.'],
      ['wings_ember','Ember Tips','#ffcb93','#e56b52','flame','♨','common',25,'Warm ember tips appear at the end of each flap.'],
      ['wings_frost','Frost Feathers','#d5f6ff','#78b5de','frost','❄','common',30,'Icy feather panels with subtle bright tips.'],
      ['wings_royal','Royal Pinions','#d3b9ff','#7a63be','royal','♛','uncommon',35,'Royal violet panels with small gold accents.'],
      ['wings_mint','Mint Gliders','#a9f8db','#4aaf99','glider','➶','uncommon',40,'Sleek glider-style wings with mint leading edges.'],
      ['wings_rose','Rose Petals','#ffc4df','#c46a98','petal','❀','uncommon',40,'Petal-shaped panels that fan during the flap cycle.'],
      ['wings_aurora','Aurora Pinions','#c5ffe9','#9b8be6','aurora','✧','rare',50,'A shifting green-violet sheen on the wing panels.'],
      ['wings_moon','Moon-feather','#dfe6ff','#8a98cb','moon','☾','rare',55,'Pale lunar feathers with crescent etching.'],
      ['wings_solar','Solar Kite','#ffeaa7','#e9a54a','solar','☼','rare',60,'Golden sail wings warmed by a solar edge.'],
      ['wings_jade','Jade Sculpted','#a9e8cf','#398a75','scales','◈','rare',60,'Layered jade scales form a sculpted wing.'],
      ['wings_prism','Prism Plumes','#ffd0ef','#80dff7','prism','◇','epic',70,'Prismatic feather panels with softly shifting colour.'],
      ['wings_storm','Storm Runners','#bac8ff','#6578bc','storm','ϟ','epic',75,'Angular wing tips with a muted electric glow.'],
      ['wings_starforged','Starforged Wings','#ffe0a5','#9681e4','star-map','✦','legendary',90,'Star-map etching across legendary golden wings.'],
      ['wings_phoenix','Phoenix Plumes','#ffbd79','#dc5471','flame','♨','legendary',95,'A bright phoenix colourway that keeps the original shape.'],
      ['wings_eclipse','Eclipse Crownwings','#edddff','#555787','eclipse','◉','mythic',100,'A dark celestial panel edged in a thin pearl glow.'],
      ['wings_meadow','Meadow Glide','#d6f4a8','#65b88b','leaf','❋','uncommon',35,'Meadow-green panels with leaf-shaped feathers.'],
      ['wings_tide','Tidal Kites','#a5e7ff','#427dac','wave','≈','epic',80,'Tidal blue wings with wave-like inlay.']
    ]
  };
  const STORE_COSMETICS = Object.values(COSMETIC_DEPARTMENTS).flatMap(items => items.map(([code,name,primary,secondary,texture,symbol,rarity,price,description]) => ({
    code, name, slot: code.startsWith('bird_') ? 'bird' : code.startsWith('aura_') ? 'aura' : code.startsWith('trail_') ? 'trail' : 'wings',
    primary: primary.trim(), secondary, texture, symbol, rarity, price, description,
    rarityColor: (RARITIES.find(r => r.id === rarity) || RARITIES[0]).color,
    ownedDefault: price === 0
  })));
  const COSMETIC_DEFAULTS = { bird: 'bird_classic', aura: 'aura_none', trail: 'trail_none', wings: 'wings_classic' };
  const palette = ['#bca5ff', '#83f1d0', '#ffd68a', '#86dfff', '#ffa79c'];
  const defaultSave = () => ({ bestScore: 0, gamesPlayed: 0, xp: 0, coins: 0, awards: [], runs: [], lifetimeScore: 0, arcadeScore: 0, itemsCollected: 0, rareItems: 0, upgradesPurchased: 0, inventory: {}, upgrades: {} });
  const PILOT_NAME_STORAGE_KEY = 'skyhopper_pilot_name';
  function normalisePilotName(value) { return String(value ?? '').trim().toLowerCase(); }
  function validPilotName(value) { return /^[a-z0-9_]{3,16}$/.test(value); }
  function readGuestPilotName() {
    try {
      const value = normalisePilotName(window.localStorage.getItem(PILOT_NAME_STORAGE_KEY));
      return validPilotName(value) ? value : 'Guest Pilot';
    } catch { return 'Guest Pilot'; }
  }
  // Gameplay progression remains session-only for guests; only their non-sensitive display-name preference persists.
  let guestPilotName = readGuestPilotName();
  let localSave = defaultSave();
  let guestRuns = [];
  let supabase = null;
  let authSession = null;
  let authUser = null;
  let cloudProfile = null;
  let cloudStats = null;
  let cloudAwards = [];
  let cloudInventory = {};
  let cloudUpgrades = {};
  let cloudCosmetics = new Set();
  let cloudLoadout = { ...COSMETIC_DEFAULTS };
  let cloudAbilityCatalog = null;
  let cloudStoreCatalog = null;
  let activeStoreTab = 'birds';
  let awardNoticeCount = 0;
  let authMode = 'signin';
  let leaderView = 'global';
  let mode = 'classic';
  let audioContext = null;
  let toastTimer = null;
  let accountActionBusy = false;
  let worldClockMs = 0;
  let lastWorldLabel = '';
  let achievementPage = 0;
  const ACHIEVEMENTS_PAGE_SIZE = 50;

  // Resolve every UI element once so the animation/game systems share a stable DOM map.
  const els = {
    canvas: $('#gameCanvas'), area: $('#gameArea'), overlay: $('#gameOverlay'), startBtn: $('#startBtn'), restartBtn: $('#restartBtn'),
    score: $('#scoreValue'), best: $('#bestValue'), games: $('#gamesValue'), awards: $('#awardsValue'), health: $('#healthDisplay'),
    gameState: $('#gameStateLabel'), overlayKicker: $('#overlayKicker'), overlayTitle: $('#overlayTitle'), overlayText: $('#overlayText'),
    summary: $('#runSummaryText'), floatingScore: $('#floatingScore'), sound: $('#soundBtn'), connection: $('#connectionLabel'),
    accountBtn: $('#accountBtn'), accountBtnText: $('#accountBtnText'), headerAvatar: $('#headerAvatar'), profileName: $('#profileName'),
    profileStatus: $('#profileStatus'), profileAvatar: $('#profileAvatar'), level: $('#levelValue'), xp: $('#xpValue'), xpFill: $('#xpFill'),
    coins: $('#coinValue'), profileBest: $('#profileBest'), profileAction: $('#profileAction'), editPilotNameBtn: $('#editPilotNameBtn'), profileFootnote: $('#profileFootnote'),
    modeDescription: $('#modeDescription'), abilityHint: $('#abilityHint'), leaderboard: $('#leaderboardList'), leaderboardStatus: $('#leaderboardStatus'),
    authDialog: $('#authDialog'), authForm: $('#authForm'), authTitle: $('#authTitle'), authEyebrow: $('#authEyebrow'),
    pilotNameDialog: $('#pilotNameDialog'), pilotNameForm: $('#pilotNameForm'), pilotNameInput: $('#pilotNameInput'), pilotNameMessage: $('#pilotNameMessage'), pilotNameSaveBtn: $('#pilotNameSaveBtn'), pilotNamePrivacyNote: $('#pilotNamePrivacyNote'),
    authSubtitle: $('#authSubtitle'), authUsername: $('#authUsername'), usernameField: $('#usernameField'), authEmail: $('#authEmail'),
    authPassword: $('#authPassword'), authMessage: $('#authMessage'), authSubmitBtn: $('#authSubmitBtn'), authBackendNote: $('#authBackendNote'),
    toastRegion: $('#toastRegion'), difficulty: $('#difficultyBadge'), worldLabel: $('#worldLabel'),
    inventoryList: $('#inventoryList'), itemCount: $('#itemCountValue'), storeList: $('#storeList'),
    storeDialog: $('#storeDialog'), storeCosmeticList: $('#storeCosmeticList'), storeBalance: $('#storeBalance'), storeDialogBalance: $('#storeDialogBalance')
  };
  const ctx = els.canvas.getContext('2d');
  const W = els.canvas.width, H = els.canvas.height, GROUND = 66;
  const game = {
    running: false, paused: false, over: false, score: 0, elapsed: 0, lastFrame: 0, spawn: 0,
    best: 0, sound: true, pipes: [], pickups: [], particles: [], stars: [], clouds: [], health: 3,
    invulnerable: 0, shieldMs: 0, slowMs: 0, magnetMs: 0, pickupTimer: 0, bonusNext: 0,
    cooldowns: { shield: 0, slow: 0, heal: 0 }, damaged: false, abilitiesUsed: 0, mode: mode,
    groundOffset: 0, shake: 0, newBest: false, difficultyIndex: 0,
    itemsCollected: 0, rareItems: 0, trail: [],
    bird: { x: 110, y: 276, vy: 0, r: 14, rot: 0, wing: 0 }
  };
  for (let i = 0; i < 36; i++) game.stars.push({ x: Math.random() * W, y: Math.random() * (H - GROUND), r: Math.random() * 1.5 + .25, a: Math.random() * .5 + .15, phase: Math.random() * 8 });
  for (let i = 0; i < 6; i++) game.clouds.push({ x: i * 94 + Math.random() * 30, y: 65 + Math.random() * 200, s: .55 + Math.random() * .65, a: .22 + Math.random() * .24 });

  function loadSave() { return defaultSave(); }
  function saveLocal() { /* Guest progress is deliberately not persisted on this device. */ }
  function nonNegativeInt(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; }
  function loadMode() { return 'classic'; }
  function persistMode() { /* Mode choice is a session preference, not player data. */ }
  function safeText(value) { return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]); }
  function activeStats() {
    if (authUser && cloudProfile) return {
      bestScore: nonNegativeInt(cloudProfile.best_score), gamesPlayed: nonNegativeInt(cloudStats?.games_played),
      xp: nonNegativeInt(cloudProfile.xp), coins: nonNegativeInt(cloudStats?.coins), awards: [...new Set(cloudAwards)],
      lifetimeScore: nonNegativeInt(cloudStats?.lifetime_score), arcadeScore: nonNegativeInt(cloudStats?.arcade_score),
      itemsCollected: nonNegativeInt(cloudStats?.items_collected), rareItems: nonNegativeInt(cloudStats?.rare_items),
      upgradesPurchased: nonNegativeInt(cloudStats?.upgrades_purchased), inventory: cloudInventory, upgrades: cloudUpgrades
    };
    return localSave;
  }
  function activeInventory() { return authUser ? cloudInventory : localSave.inventory; }
  function activeUpgrades() { return authUser ? cloudUpgrades : localSave.upgrades; }
  function upgradeLevel(code) { return nonNegativeInt(activeUpgrades()?.[code]); }
  function maxHealth() { return 3 + Math.min(2, upgradeLevel('heart_vessel')); }
  function effectiveRarityWeights() {
    const luck = upgradeLevel('rarity_compass');
    const multipliers = { common: 1, uncommon: 1 + luck * .025, rare: 1 + luck * .11, epic: 1 + luck * .18, legendary: 1 + luck * .24, mythic: 1 + luck * .3 };
    const weighted = RARITIES.map(r => ({ ...r, adjusted: r.weight * multipliers[r.id] }));
    const total = weighted.reduce((sum, r) => sum + r.adjusted, 0);
    return weighted.map(r => ({ ...r, chance: r.adjusted / total * 100 }));
  }
  function itemChance(item) {
    const tier = effectiveRarityWeights().find(r => r.id === item.rarity);
    const count = RARITIES.find(r => r.id === item.rarity)?.count || 1;
    return (tier?.chance || item.rarityWeight) / count;
  }
  function currentMetric(stats, metric) { return nonNegativeInt(stats?.[metric]); }
  function awardEligibleForStats(stats) {
    return AWARDS.filter(a => currentMetric(stats, a.metric) >= a.target).map(a => a.id);
  }
  function maxLevelCost(def, level) { return Math.min(100, def.basePrice * (level + 1)); }
  function computedLevel(xp) { return Math.floor(Math.sqrt(Math.max(0, xp) / 100)) + 1; }
  function xpWithinLevel(xp) {
    const level = computedLevel(xp), start = (level - 1) ** 2 * 100, next = level ** 2 * 100;
    return { level, current: Math.max(0, xp - start), needed: next - start, percent: Math.min(100, (xp - start) / Math.max(1, next - start) * 100) };
  }

  function updateProfileUI() {
    const stats = activeStats();
    const name = authUser ? (cloudProfile?.username || authUser.user_metadata?.username || 'New Pilot') : guestPilotName;
    const level = xpWithinLevel(stats.xp || 0);
    els.profileName.textContent = name;
    els.profileStatus.textContent = authUser ? 'Cloud-synced pilot account' : 'Guest · session only';
    els.profileAvatar.textContent = name.charAt(0).toUpperCase() || (authUser ? '✦' : '✧');
    els.headerAvatar.textContent = name.charAt(0).toUpperCase() || '✦';
    els.accountBtnText.textContent = authUser ? 'Account' : 'Sign in';
    els.editPilotNameBtn.innerHTML = `${authUser ? 'Change pilot name' : (guestPilotName === 'Guest Pilot' ? 'Choose pilot name' : 'Change pilot name')} <span>↗</span>`;
    els.level.textContent = String(level.level);
    els.xp.textContent = `${level.current} / ${level.needed}`;
    els.xpFill.style.width = `${Math.max(0, level.percent)}%`;
    els.coins.textContent = String(stats.coins || 0);
    els.profileBest.textContent = String(stats.bestScore || 0);
    els.best.textContent = String(stats.bestScore || 0);
    els.games.textContent = String(stats.gamesPlayed || 0);
    els.awards.textContent = `${stats.awards.length} / ${AWARDS.length}`;
    $('#awardCountBadge').textContent = `${stats.awards.length.toLocaleString()}/${AWARDS.length.toLocaleString()}`;
    $('#awardProgressFill').style.width = `${stats.awards.length / AWARDS.length * 100}%`;
    els.profileAction.textContent = authUser ? 'Sign out of flight club ↗' : 'Create pilot account ↗';
    els.profileFootnote.textContent = authUser ? 'Progress, relics, coins and upgrades sync to Supabase.' : 'Guest progress lasts until refresh; your display name stays on this device. Sign in for cloud saves.';
    els.connection.textContent = authUser && cloudProfile ? 'CLOUD FLIGHT LOG' : (supabase ? 'CLOUD READY · GUEST' : 'GUEST FLIGHT');
    $('.online-pill').classList.toggle('is-connected', Boolean(supabase && authUser));
    if (authUser && !cloudProfile) els.profileStatus.textContent = 'Loading cloud pilot data…';
    updateAwardsUI(stats.awards || []);
    updateHealthUI();
    updateAbilityUI();
    renderInventoryUI();
    renderStoreUI();
  }

  function updateAwardsUI(unlocked) {
    const unlockedSet = new Set(unlocked);
    const preview = [];
    for (const group of ACHIEVEMENT_GROUPS) {
      const items = AWARDS.filter(a => a.category === group.prefix);
      const next = items.find(a => !unlockedSet.has(a.id));
      if (next) preview.push(next);
    }
    const recent = AWARDS.filter(a => unlockedSet.has(a.id)).slice(-2).reverse();
    const list = $('#awardList');
    if (!list) return;
    const rows = [...recent, ...preview.filter(a => !recent.some(r => r.id === a.id))].slice(0, 8);
    list.innerHTML = rows.map(a => {
      const isUnlocked = unlockedSet.has(a.id);
      return `<div class="award-row ${isUnlocked ? 'unlocked' : ''}" data-award="${a.id}"><span class="award-medal" style="color:${isUnlocked ? '#83f1d0' : '#8796b4'}">${a.symbol}</span><span><b>${safeText(a.name)}</b><small>${safeText(a.note)}</small></span><span class="award-check">${isUnlocked ? '✓' : '○'}</span></div>`;
    }).join('');
    $('#achievementSummary') && ($('#achievementSummary').textContent = `${unlocked.length.toLocaleString()} / ${AWARDS.length.toLocaleString()} unlocked`);
  }
  function updateHealthUI() {
    els.health.hidden = mode !== 'arcade';
    const max = maxHealth();
    els.health.textContent = Array.from({ length: max }, (_, i) => i < game.health ? '♥' : '♡').join(' ');
    els.health.setAttribute('aria-label', `Health: ${game.health} of ${max} hearts`);
  }
  function updateAbilityUI() {
    const enabled = mode === 'arcade';
    $$('.ability-item').forEach(button => {
      const id = button.dataset.ability;
      const canHeal = id !== 'heal' || game.health < maxHealth();
      button.disabled = !enabled || !canHeal || !game.running || game.paused || (game.cooldowns[id] || 0) > 0;
      const cooldownEl = $(`#${id}Cooldown`);
      button.classList.toggle('cooling', (game.cooldowns[id] || 0) > 0);
      if (cooldownEl) cooldownEl.textContent = (game.cooldowns[id] || 0) > 0 ? `${Math.ceil(game.cooldowns[id] / 1000)}S` : (id === 'heal' && game.health >= maxHealth() ? 'FULL HP' : 'READY');
    });
    els.abilityHint.textContent = enabled ? (game.running ? 'Press Q, E or R — relics also grant instant effects.' : 'Start an Arcade flight to use your skills and collect relics.') : 'Switch to Arcade to use your skills and discover flying relics.';
  }
  function updateModeUI() {
    $$('.mode-option').forEach(button => button.classList.toggle('active', button.dataset.mode === mode));
    game.mode = mode;
    els.modeDescription.textContent = mode === 'classic'
      ? 'Pure flight. One collision ends the run; the gates steadily get faster, but the classic gap stays true.'
      : 'Starts at Normal, then ramps through Swift, Hard, Expert and Chaos. Gaps shift, narrow and surprise you; collect relics to survive.';
    if (els.difficulty) els.difficulty.hidden = mode !== 'arcade';
    updateHealthUI(); updateAbilityUI(); updateDifficultyUI();
  }

  function renderInventoryUI() {
    if (!els.inventoryList) return;
    const inventory = activeInventory() || {};
    const owned = ABILITY_ITEMS.filter(item => nonNegativeInt(inventory[item.code]) > 0);
    const unique = owned.length;
    if (els.itemCount) els.itemCount.textContent = `${unique} / ${ABILITY_ITEMS.length}`;
    $('#collectionProgressFill') && ($('#collectionProgressFill').style.width = `${unique / ABILITY_ITEMS.length * 100}%`);
    if (!owned.length) {
      els.inventoryList.innerHTML = '<div class="inventory-empty"><span>✧</span><b>Your relic shelf is waiting.</b><small>Collect glowing relics while flying to fill this collection.</small></div>';
      return;
    }
    els.inventoryList.innerHTML = owned.slice(0, 8).map(item => `<div class="inventory-chip" title="${safeText(item.name)} · Power ${item.power}"><span style="color:${item.rarityColor}">${item.symbol}</span><span><b>${safeText(item.name)}</b><small>${item.rarityName} · Power ${item.power}</small></span><strong>×${nonNegativeInt(inventory[item.code])}</strong></div>`).join('');
  }

  function getCosmetic(code) { return STORE_COSMETICS.find(item => item.code === code) || null; }
  function equippedCosmetic(slot) { return getCosmetic(cloudLoadout?.[slot] || COSMETIC_DEFAULTS[slot]); }
  function renderStoreUI() {
    if (!els.storeList) return;
    const stats = activeStats();
    els.storeList.innerHTML = UPGRADES.map(def => {
      const level = upgradeLevel(def.code), maxed = level >= def.maxLevel, price = maxLevelCost(def, level);
      const affordable = nonNegativeInt(stats.coins) >= price;
      return `<article class="upgrade-card" style="--upgrade-color:${def.color}"><div class="upgrade-glyph">✦</div><div class="upgrade-info"><div class="upgrade-heading"><b>${safeText(def.name)}</b><span>LV ${level}/${def.maxLevel}</span></div><p>${safeText(def.desc)}</p><small>${safeText(def.effect)}</small><div class="upgrade-track"><span style="width:${level / def.maxLevel * 100}%"></span></div></div><button class="upgrade-buy" type="button" data-upgrade="${def.code}" ${maxed || !affordable || !authUser ? 'disabled' : ''}>${maxed ? 'MAXED' : !authUser ? 'SIGN IN' : `◆ ${price}`}</button></article>`;
    }).join('');
    const coinsText = `${nonNegativeInt(stats.coins).toLocaleString()} coins`;
    if (els.storeBalance) els.storeBalance.textContent = coinsText;
    if (els.storeDialogBalance) els.storeDialogBalance.textContent = nonNegativeInt(stats.coins).toLocaleString();
    renderStoreCosmetics();
  }
  function renderStoreCosmetics() {
    const list = els.storeCosmeticList;
    if (!list) return;
    const q = String($('#storeSearch')?.value || '').trim().toLowerCase();
    const slotSet = activeStoreTab === 'birds' ? ['bird'] : activeStoreTab === 'auras' ? ['aura'] : activeStoreTab === 'trails' ? ['trail', 'wings'] : [];
    const items = STORE_COSMETICS.filter(item => slotSet.includes(item.slot) && (!q || `${item.name} ${item.description} ${item.rarity} ${item.texture}`.toLowerCase().includes(q)));
    $('#storeDepartmentTitle').textContent = ({ birds: 'Bird looks', auras: 'Auras & atmosphere', trails: 'Trails & wings', upgrades: 'Permanent upgrades' })[activeStoreTab];
    $('#storeDepartmentSubtitle').textContent = ({ birds: 'New colourways, feather textures and signature looks.', auras: 'An animated identity that orbits your bird.', trails: 'A custom wake and wing language for every flight.', upgrades: 'Permanent boosts for Arcade survival and relic hunts.' })[activeStoreTab];
    $('#storeFeatureTitle').textContent = ({ birds: 'Keep the classic silhouette. Make it yours.', auras: 'Small details. Big sky energy.', trails: 'Leave a little story in the sky.', upgrades: 'Invest in your next personal best.' })[activeStoreTab];
    $('#storeFeatureText').textContent = activeStoreTab === 'upgrades' ? 'Upgrade costs use earned coins and never exceed 100 coins per level.' : 'Every piece has a name, rarity, texture motif, description and colour identity.';
    $('#storeUpgradeSection').hidden = activeStoreTab !== 'upgrades';
    list.hidden = activeStoreTab === 'upgrades';
    if (activeStoreTab === 'upgrades') return;
    const coins = nonNegativeInt(activeStats().coins);
    list.innerHTML = items.map(item => {
      const isDefault = item.ownedDefault || item.price === 0;
      const owned = isDefault || cloudCosmetics.has(item.code);
      const equipped = cloudLoadout?.[item.slot] === item.code || (!cloudLoadout?.[item.slot] && COSMETIC_DEFAULTS[item.slot] === item.code);
      const buttonText = equipped ? 'EQUIPPED' : owned ? 'EQUIP STYLE' : !authUser ? 'SIGN IN TO SAVE' : item.price === 0 ? 'CLAIM FREE' : `◆ ${item.price}`;
      const disabled = Boolean(equipped || (authUser && !owned && coins < item.price));
      return `<article class="store-product-card ${equipped ? 'is-equipped' : ''} rarity-${safeText(item.rarity)}" style="--item-primary:${item.primary};--item-secondary:${item.secondary};--item-rarity:${item.rarityColor}">
        <div class="product-art product-art-${safeText(item.slot)} texture-${safeText(item.texture)}"><span class="art-orbit"></span><span class="art-glyph">${safeText(item.symbol)}</span><span class="art-glint">✦</span><span class="art-rarity">${safeText(item.rarity)}</span></div>
        <div class="product-card-body"><div class="product-name-line"><h3>${safeText(item.name)}</h3><span class="product-slot-label">${safeText(item.slot === 'bird' ? 'BIRD SKIN' : item.slot === 'aura' ? 'AURA' : item.slot === 'trail' ? 'TRAIL' : 'WING STYLE')}</span></div>
          <p>${safeText(item.description)}</p><div class="product-meta"><span><i class="colour-swatch"></i>${safeText(item.texture.replaceAll('-', ' '))}</span><span class="product-rarity">${safeText(item.rarity)}</span></div>
          <button class="product-action ${equipped ? 'equipped' : owned ? 'owned' : ''}" type="button" data-store-code="${safeText(item.code)}" data-store-owned="${owned ? '1' : '0'}" ${disabled ? 'disabled' : ''}>${buttonText}</button>
        </div></article>`;
    }).join('') || '<div class="store-empty-state"><span>✧</span><b>No items found.</b><small>Try another search or shop department.</small></div>';
  }

  function updateDifficultyUI() {
    if (!els.difficulty) return;
    const tier = difficultyTier(game.score);
    game.difficultyIndex = tier.index;
    els.difficulty.textContent = tier.name.toUpperCase();
    els.difficulty.dataset.tier = tier.index;
    els.difficulty.hidden = mode !== 'arcade';
  }
  function difficultyTier(score) {
    if (score < 10) return { index: 0, name: 'Normal', speed: 0, gap: 0 };
    if (score < 22) return { index: 1, name: 'Swift', speed: .24, gap: 8 };
    if (score < 38) return { index: 2, name: 'Hard', speed: .5, gap: 18 };
    if (score < 60) return { index: 3, name: 'Expert', speed: .78, gap: 28 };
    return { index: 4, name: 'Chaos', speed: 1.05, gap: 38 };
  }
  function currentGameSpeed() {
    if (mode === 'classic') return 2.55 + Math.min(4.15, game.score * .035);
    return 2.55 + difficultyTier(game.score).speed + Math.min(2.1, game.score * .018);
  }
  function hexRgb(hex) {
    const raw = String(hex || '#000000').replace('#', '').slice(0, 6);
    const full = raw.length === 3 ? raw.split('').map(c => c + c).join('') : raw.padEnd(6, '0');
    const value = Number.parseInt(full, 16) || 0;
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  }
  function mixHex(a, b, t) {
    const x = hexRgb(a), y = hexRgb(b), f = Math.max(0, Math.min(1, t));
    return '#' + [x.r, x.g, x.b].map((v, i) => Math.round(v + ([y.r, y.g, y.b][i] - v) * f).toString(16).padStart(2, '0')).join('');
  }
  function getWorldState() {
    const dayMinutes = (worldClockMs / 1000 * 8) % 1440;
    const hour = dayMinutes / 60;
    let period = 'night';
    if (hour >= 5 && hour < 7) period = 'dawn';
    else if (hour >= 7 && hour < 11) period = 'morning';
    else if (hour >= 11 && hour < 16) period = 'noon';
    else if (hour >= 16 && hour < 20) period = 'evening';
    const skyFrames = [
      { h: 0, c: ['#10182f', '#26375b', '#354563', '#59657c'] },
      { h: 5, c: ['#202d53', '#73577d', '#bd8099', '#e6b0a8'] },
      { h: 6, c: ['#a46c8c', '#d68b9b', '#f3bba0', '#f5d8b0'] },
      { h: 8, c: ['#5caedb', '#90d1e8', '#b5e0df', '#f0deb6'] },
      { h: 12, c: ['#53b9e8', '#8fdbec', '#c5e7d0', '#f4e0a5'] },
      { h: 16, c: ['#7a6798', '#d17f91', '#efaa91', '#f1c7a1'] },
      { h: 19, c: ['#553f6b', '#976a8e', '#d18794', '#edbaaa'] },
      { h: 20, c: ['#151b3c', '#343d66', '#454b72', '#6f718b'] },
      { h: 24, c: ['#10182f', '#26375b', '#354563', '#59657c'] }
    ];
    let left = skyFrames[0], right = skyFrames[skyFrames.length - 1];
    for (let i = 0; i < skyFrames.length - 1; i++) if (hour >= skyFrames[i].h && hour <= skyFrames[i + 1].h) { left = skyFrames[i]; right = skyFrames[i + 1]; break; }
    const blend = (hour - left.h) / Math.max(.001, right.h - left.h);
    const sky = left.c.map((colour, i) => mixHex(colour, right.c[i], blend));
    const seasonLength = 600000; // Seasons blend gradually over ten minutes of world time.
    const seasonProgressAll = (worldClockMs % (seasonLength * 4)) / seasonLength;
    const seasonIndex = Math.floor(seasonProgressAll) % 4;
    const seasonProgress = seasonProgressAll - Math.floor(seasonProgressAll);
    const seasons = ['Spring', 'Summer', 'Autumn', 'Winter'];
    const dayLight = Math.max(0, Math.sin(((hour - 6) / 12) * Math.PI));
    const sunProgress = Math.max(0, Math.min(1, (hour - 6) / 12));
    const moonProgress = hour >= 18 ? (hour - 18) / 12 : (hour + 6) / 12;
    return { hour, period, season: seasons[seasonIndex], seasonIndex, seasonProgress, nextSeasonIndex: (seasonIndex + 1) % 4, sky, isNight: hour < 5 || hour >= 20, moonVisible: hour < 6 || hour >= 18, dayLight, sunProgress, moonProgress, dayMinutes };
  }
  function updateWorldLabel() {
    const world = getWorldState();
    const hour = Math.floor(world.hour).toString().padStart(2, '0');
    const minute = Math.floor((world.hour % 1) * 60).toString().padStart(2, '0');
    const label = `${world.season.toUpperCase()} · ${world.period.toUpperCase()} · ${hour}:${minute}`;
    if (label !== lastWorldLabel && els.worldLabel) { els.worldLabel.textContent = label; const icon = $('#weatherChip span:first-child'); if (icon) icon.textContent = world.period === 'night' ? '☾' : world.period === 'dawn' ? '☼' : world.period === 'evening' ? '☀' : '✦'; lastWorldLabel = label; }
  }
  function chooseAbilityItem() {
    const tiers = effectiveRarityWeights();
    let roll = Math.random() * tiers.reduce((sum, tier) => sum + tier.chance, 0);
    let selected = tiers[0];
    for (const tier of tiers) { roll -= tier.chance; if (roll <= 0) { selected = tier; break; } }
    const options = ABILITY_ITEMS.filter(item => item.rarity === selected.id);
    return options[Math.floor(Math.random() * options.length)] || ABILITY_ITEMS[0];
  }
  function rarityRank(rarity) { return RARITIES.findIndex(r => r.id === rarity); }
  function unlockLocalAwards() {
    const unlockedBefore = new Set(localSave.awards);
    const metrics = { bestScore: localSave.bestScore, gamesPlayed: localSave.gamesPlayed, itemsCollected: localSave.itemsCollected, rareItems: localSave.rareItems, arcadeScore: localSave.arcadeScore, upgradesPurchased: localSave.upgradesPurchased };
    const earned = awardEligibleForStats(metrics).filter(id => !unlockedBefore.has(id));
    localSave.awards = [...unlockedBefore, ...earned];
    earned.forEach(toastAward);
    return earned;
  }
  function renderAchievementBrowser(reset = false) {
    const list = $('#achievementCatalog');
    if (!list) return;
    if (reset) achievementPage = 0;
    const query = String($('#achievementSearch')?.value || '').trim().toLowerCase();
    const category = $('#achievementCategory')?.value || 'all';
    const unlocked = new Set(activeStats().awards || []);
    const matching = AWARDS.filter(a => (category === 'all' || a.category === category) && (!query || `${a.name} ${a.note} ${a.category}`.toLowerCase().includes(query)));
    const slice = matching.slice(0, (achievementPage + 1) * ACHIEVEMENTS_PAGE_SIZE);
    list.innerHTML = slice.map(a => `<article class="catalog-row ${unlocked.has(a.id) ? 'is-unlocked' : ''}"><span style="color:${unlocked.has(a.id) ? '#83f1d0' : '#8291ad'}">${unlocked.has(a.id) ? '✓' : '○'}</span><span><b>${safeText(a.name)}</b><small>${safeText(a.note)}</small></span><em>${safeText(a.category)}</em></article>`).join('') || '<div class="inventory-empty">No matching achievements.</div>';
    $('#achievementResults') && ($('#achievementResults').textContent = `${slice.length.toLocaleString()} of ${matching.length.toLocaleString()} matching · ${unlocked.size.toLocaleString()} unlocked`);
    $('#loadMoreAchievements') && ($('#loadMoreAchievements').hidden = slice.length >= matching.length);
  }
  function renderCodex() {
    const list = $('#codexList');
    if (!list) return;
    const query = String($('#codexSearch')?.value || '').trim().toLowerCase();
    const category = $('#codexRarity')?.value || 'all';
    const inventory = activeInventory() || {};
    const items = ABILITY_ITEMS.filter(item => (category === 'all' || item.rarity === category) && (!query || `${item.name} ${item.type} ${item.rarity}`.toLowerCase().includes(query)));
    list.innerHTML = items.map(item => `<article class="codex-card ${nonNegativeInt(inventory[item.code]) ? 'owned' : 'unowned'}" style="--rarity-color:${item.rarityColor};--item-aura:${item.auraColor}"><div class="codex-symbol texture-${safeText(item.texture)}">${nonNegativeInt(inventory[item.code]) ? item.symbol : '◌'}</div><div class="codex-main"><b>${nonNegativeInt(inventory[item.code]) ? safeText(item.name) : 'Undiscovered relic'}</b><small>${item.rarityName} · ${safeText(item.typeName || item.type)} · ${safeText(item.texture)}</small><div class="codex-meta"><span>${itemChance(item).toFixed(2)}% per drop</span><span>POWER ${item.power}/10</span></div><p class="codex-description">${safeText(item.description)}</p><em class="codex-effect">${safeText(item.effectDescription || 'A mysterious flight relic.')}</em></div><strong>${nonNegativeInt(inventory[item.code]) ? `×${nonNegativeInt(inventory[item.code])}` : '???'}</strong></article>`).join('');
    $('#codexResults') && ($('#codexResults').textContent = `${items.length} relic designs · ${ABILITY_ITEMS.filter(i => nonNegativeInt(inventory[i.code]) > 0).length}/120 discovered`);
  }
  function showToast(message, type = 'success', ms = 3000) {
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message;
    els.toastRegion.appendChild(toast);
    window.setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateY(5px)'; window.setTimeout(() => toast.remove(), 220); }, ms);
  }
  function tone(freq = 480, duration = .07, type = 'sine', volume = .035) {
    if (!game.sound) return;
    try {
      audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audioContext.state === 'suspended') audioContext.resume();
      const osc = audioContext.createOscillator(), gain = audioContext.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, audioContext.currentTime);
      gain.gain.setValueAtTime(volume, audioContext.currentTime); gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
      osc.connect(gain); gain.connect(audioContext.destination); osc.start(); osc.stop(audioContext.currentTime + duration);
    } catch (_) { /* Audio is an optional extra. */ }
  }
  function burst(x, y, count = 12, colors = ['#ffffff', '#83f1d0', '#ffd68a']) {
    for (let i = 0; i < count; i++) game.particles.push({ x, y, vx: (Math.random() - .5) * 4.4, vy: (Math.random() - .6) * 4.1, life: 22 + Math.random() * 22, maxLife: 42, size: 1.4 + Math.random() * 2.7, color: colors[Math.floor(Math.random() * colors.length)], gravity: .05 });
  }
  function toastAward(id) {
    const award = AWARDS.find(a => a.id === id);
    if (!award) return;
    awardNoticeCount++;
    const panel = $('#awardNoticePanel');
    if (panel) {
      $('#awardNoticeIcon').textContent = award.symbol;
      $('#awardNoticeTitle').textContent = award.name;
      $('#awardNoticeDescription').textContent = award.note;
      $('#awardNoticeQueue').textContent = awardNoticeCount > 1 ? `${awardNoticeCount} NEW MILESTONES · MOST RECENT SHOWN` : `${award.category.toUpperCase()} MILESTONE`;
      panel.hidden = false;
      panel.classList.remove('notice-arrive'); void panel.offsetWidth; panel.classList.add('notice-arrive');
      // This notice lives in the side rail, never over the play canvas.
    }
    tone(790, .1, 'triangle', .045); window.setTimeout(() => tone(1040, .16, 'sine', .035), 95);
  }

  function showOverlay(kicker, title, text, buttonText) {
    els.overlay.hidden = false;
    els.overlayKicker.textContent = kicker; els.overlayTitle.textContent = title; els.overlayText.textContent = text; els.startBtn.innerHTML = `<span>▶</span> ${safeText(buttonText)}`; els.overlay.hidden = false;
  }
  function resetRun() {
    game.score = 0; game.elapsed = 0; game.spawn = 0; game.pipes = []; game.pickups = []; game.particles = [];
    game.health = maxHealth(); game.invulnerable = 0; game.shieldMs = 0; game.slowMs = 0; game.magnetMs = 0; game.bonusNext = 0;
    game.pickupTimer = 0; game.itemsCollected = 0; game.rareItems = 0; game.trail = [];
    game.cooldowns = { shield: 0, slow: 0, heal: 0 }; game.damaged = false; game.abilitiesUsed = 0; game.shake = 0; game.newBest = false;
    game.bird = { x: 110, y: 276, vy: 0, r: 14, rot: 0, wing: 0 };
    game.pipes.push(makePipe(W + 80));
    els.score.textContent = '000';
    updateHealthUI(); updateAbilityUI(); updateDifficultyUI();
  }
  function startRun() {
    if (authUser && (!supabase || !cloudProfile || !cloudStats)) { showToast('Your cloud save is still loading. Try again in a moment.', 'info', 2600); return; }
    resetRun(); game.running = true; game.paused = false; game.over = false; game.lastFrame = performance.now();
    els.overlay.hidden = true; els.gameState.textContent = mode === 'arcade' ? 'ARCADE FLIGHT IN PROGRESS' : 'CLASSIC FLIGHT IN PROGRESS';
    game.bird.vy = -6.4; burst(game.bird.x - 10, game.bird.y + 3, 6, ['#ffffff', '#ffd68a', '#83f1d0']); tone(510, .07, 'triangle');
    els.area.focus({ preventScroll: true }); updateAbilityUI();
  }
  function pauseRun() {
    if (!game.running || game.paused) return;
    game.paused = true; game.running = false; els.gameState.textContent = 'PAUSED — CATCH YOUR BREATH';
    showOverlay('A MOMENT IN THE CLOUDS', 'Flight paused.', 'Your bird can wait. Come back when you are ready.', 'Resume flight'); updateAbilityUI();
  }
  function resumeRun() {
    if (!game.paused) return startRun();
    game.paused = false; game.running = true; game.lastFrame = performance.now(); els.overlay.hidden = true; els.gameState.textContent = mode === 'arcade' ? 'ARCADE FLIGHT IN PROGRESS' : 'CLASSIC FLIGHT IN PROGRESS'; updateAbilityUI();
  }
  function makePipe(x) {
    const tier = difficultyTier(game.score);
    const gap = mode === 'arcade' ? Math.max(106, 176 - tier.gap - Math.floor(game.score / 8) * 2 + (Math.random() * 17 - 8)) : 158;
    const minTop = 62, maxTop = H - GROUND - gap - 62;
    let top = minTop + Math.random() * Math.max(1, maxTop - minTop);
    const previous = game.pipes[game.pipes.length - 1];
    // Reject nearly identical heights often enough to feel unpredictable without forcing impossible jumps.
    if (mode === 'arcade' && previous) {
      for (let attempt = 0; attempt < 5 && Math.abs(top - previous.top) < 30; attempt++) top = minTop + Math.random() * Math.max(1, maxTop - minTop);
    }
    return { x, top, gap, w: mode === 'arcade' ? 64 + Math.random() * 8 : 67, passed: false, seed: Math.random() * 100, shimmer: Math.random() * 6, tint: ['#50bda1', '#82c9ed', '#bf9cf5', '#efbd76'][Math.floor(Math.random() * 4)] };
  }
  function flap() {
    if (game.paused) { resumeRun(); return; }
    if (!game.running) { if (game.over) startRun(); else startRun(); return; }
    game.bird.vy = -6.25; game.bird.rot = -.35; game.bird.wing = 0;
    burst(game.bird.x - 10, game.bird.y + 4, 4, ['#ffffff', '#ffe5a4', '#83f1d0']); tone(430 + Math.random() * 100, .05, 'triangle', .024);
  }
  function collisionWithPipe(pipe) {
    const b = game.bird, r = b.r * .82;
    const intersects = b.x + r > pipe.x - 2 && b.x - r < pipe.x + pipe.w + 2;
    return intersects && (b.y - r < pipe.top || b.y + r > pipe.top + pipe.gap);
  }
  function applyHit(source = 'gate') {
    if (!game.running || game.invulnerable > 0) return;
    if (game.mode === 'classic') { finishRun(); return; }
    game.damaged = true; game.shake = 10; game.invulnerable = 1250;
    if (game.shieldMs > 0) {
      game.shieldMs = 0; burst(game.bird.x, game.bird.y, 24, ['#bca5ff', '#ffffff', '#83f1d0']);
      els.summary.textContent = 'Your Star Shield absorbed a hit. Keep flying!'; tone(880, .14, 'sine', .035); return;
    }
    game.health = Math.max(0, game.health - 1); updateHealthUI(); burst(game.bird.x, game.bird.y, 17, ['#ffa79c', '#fff0e8', '#ffd68a']); tone(170, .15, 'sawtooth', .04);
    game.bird.vy = source === 'floor' ? -5 : -3.7;
    if (source === 'floor') { game.bird.y = H - GROUND - game.bird.r - 5; game.bird.vy = -5; }
    else if (source === 'ceiling') { game.bird.y = game.bird.r + 5; game.bird.vy = 3.5; }
    else {
      const overlapping = game.pipes.find(p => collisionWithPipe(p));
      if (overlapping) game.bird.y = game.bird.y < overlapping.top ? overlapping.top - game.bird.r - 4 : overlapping.top + overlapping.gap + game.bird.r + 4;
    }
    if (game.health <= 0) finishRun();
  }
  function useAbility(id) {
    if (mode !== 'arcade' || !game.running || game.paused || game.cooldowns[id] > 0) return;
    if (id === 'heal' && game.health >= maxHealth()) { showToast('Your hearts are already full.', 'info', 2000); return; }
    game.abilitiesUsed++;
    if (id === 'shield') { game.shieldMs = 4400 + upgradeLevel('shield_core') * 350; game.cooldowns.shield = Math.max(5200, 10500 - upgradeLevel('cooldown_coil') * 650); burst(game.bird.x, game.bird.y, 17, ['#bca5ff', '#83f1d0', '#ffffff']); showToast('Star Shield on — one hit protected.', 'success', 2100); tone(680, .13, 'sine'); }
    if (id === 'slow') { game.slowMs = 5000 + upgradeLevel('slow_clock') * 500; game.cooldowns.slow = Math.max(7000, 14500 - upgradeLevel('cooldown_coil') * 650); burst(game.bird.x, game.bird.y, 12, ['#86dfff', '#ffffff', '#bca5ff']); showToast('Slow skies engaged.', 'success', 2100); tone(590, .16, 'sine'); }
    if (id === 'heal') { game.health = Math.min(maxHealth(), game.health + 1); game.cooldowns.heal = Math.max(6000, 12000 - upgradeLevel('cooldown_coil') * 600); updateHealthUI(); burst(game.bird.x, game.bird.y, 22, ['#ffa79c', '#fff4eb', '#83f1d0']); showToast('Heart bloom — one heart restored.', 'success', 2100); tone(760, .15, 'sine'); }
    updateAbilityUI();
  }
  function finishRun() {
    if (game.over) return;
    game.running = false; game.paused = false; game.over = true;
    const finalScore = game.score, runMode = mode, duration = Math.max(1000, Math.floor(game.elapsed));
    const wasCloud = Boolean(authUser && supabase && cloudProfile && cloudStats);
    const priorStats = activeStats();
    game.newBest = finalScore > nonNegativeInt(priorStats.bestScore);
    let newly = [];
    let coinsEarned = 0;
    const xpGain = Math.max(10, finalScore * 5);
    if (wasCloud) {
      const oldLifetime = nonNegativeInt(cloudStats.lifetime_score);
      const oldArcade = nonNegativeInt(cloudStats.arcade_score);
      const newLifetime = oldLifetime + finalScore;
      const newArcade = oldArcade + (runMode === 'arcade' ? finalScore : 0);
      coinsEarned = runMode === 'arcade' ? Math.floor(newArcade / 100) - Math.floor(oldArcade / 100) : 0;
      cloudProfile = { ...cloudProfile, best_score: Math.max(nonNegativeInt(cloudProfile.best_score), finalScore), xp: nonNegativeInt(cloudProfile.xp) + xpGain, level: computedLevel(nonNegativeInt(cloudProfile.xp) + xpGain) };
      cloudStats = { ...cloudStats, games_played: nonNegativeInt(cloudStats.games_played) + 1, lifetime_score: newLifetime, arcade_score: newArcade, coins: nonNegativeInt(cloudStats.coins) + coinsEarned };
    } else {
      const oldArcade = nonNegativeInt(localSave.arcadeScore);
      const newLifetime = nonNegativeInt(localSave.lifetimeScore) + finalScore;
      const newArcade = oldArcade + (runMode === 'arcade' ? finalScore : 0);
      localSave.bestScore = Math.max(nonNegativeInt(localSave.bestScore), finalScore);
      localSave.gamesPlayed += 1;
      localSave.xp += xpGain;
      coinsEarned = runMode === 'arcade' ? Math.floor(newArcade / 100) - Math.floor(oldArcade / 100) : 0;
      localSave.coins += coinsEarned;
      localSave.lifetimeScore = newLifetime;
      localSave.arcadeScore = newArcade;
      guestRuns.unshift({ score: finalScore, mode: runMode, pilotName: guestPilotName, playedAt: new Date().toISOString() });
      guestRuns = guestRuns.slice(0, 12);
      newly = unlockLocalAwards();
    }
    const stats = activeStats();
    game.best = Math.max(game.best, finalScore);
    els.gameState.textContent = game.newBest ? 'NEW PERSONAL BEST!' : 'FLIGHT COMPLETE';
    const nextCoin = wasCloud ? nonNegativeInt(cloudStats.coins) : nonNegativeInt(localSave.coins);
    els.summary.textContent = runMode === 'arcade' ? (coinsEarned > 0 ? `Arcade reward: +${coinsEarned} coin${coinsEarned === 1 ? '' : 's'} · 1 coin per 100 Arcade points. Balance: ${nextCoin}.` : `Flight complete: ${finalScore} points. Arcade coins accrue at 0.01 per Arcade point; the next coin arrives at your next 100-point milestone.`) : `Classic flight: ${finalScore} points. Classic is coin-free — switch to Arcade to earn 1 coin per 100 points.`;
    if (finalScore > 0) burst(game.bird.x, game.bird.y, 18, ['#ffd68a', '#ffffff', '#83f1d0']);
    if (game.newBest) { tone(830, .14, 'triangle'); window.setTimeout(() => tone(1120, .22, 'sine', .03), 120); }
    showOverlay(game.newBest ? 'NEW PERSONAL BEST' : 'FLIGHT COMPLETE', game.newBest ? 'Look at you fly!' : (finalScore >= 10 ? 'That was a good run.' : 'One more go?'), `You scored ${finalScore}. ${runMode === 'arcade' ? `Hearts left: ${game.health}.` : ''} Your best is ${Math.max(stats.bestScore, finalScore)}.`, 'Fly again');
    updateProfileUI(); updateLeaderboard(); updateAbilityUI();
    if (wasCloud) submitCloudRun(finalScore, duration, runMode, game.damaged, game.abilitiesUsed);
  }
  async function submitCloudRun(score, duration, runMode, damaged, abilitiesUsed) {
    try {
      const { data, error } = await supabase.rpc('submit_run', {
        p_score: score, p_duration_ms: duration, p_mode: runMode,
        p_damaged: Boolean(damaged), p_abilities_used: Math.min(3, Math.max(0, abilitiesUsed))
      });
      if (error) throw error;
      const cloudUnlocked = Array.isArray(data?.awards) ? data.awards : [];
      await Promise.all([fetchCloudProfile(), fetchCloudAwards(), fetchCloudInventory(), fetchCloudUpgrades(), fetchCloudStoreCosmetics()]);
      cloudUnlocked.forEach(id => toastAward(id));
      updateProfileUI(); updateLeaderboard(); renderAchievementBrowser(); renderCodex();
      showToast('Flight, rewards and achievements synced to Supabase.', 'success', 2600);
    } catch (error) {
      console.warn('Cloud score sync failed:', error);
      showToast('Cloud save failed. This run is not saved locally; check Supabase setup and try again.', 'error', 5000);
      await Promise.allSettled([fetchCloudProfile(), fetchCloudAwards(), fetchCloudInventory(), fetchCloudUpgrades()]);
      updateProfileUI();
    }
  }

  function drawRoundedRect(x, y, w, h, r) {
    const radius = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
    ctx.beginPath(); ctx.roundRect(x, y, w, h, radius);
  }
  function drawSky(t) {
    const world = getWorldState();
    const sky = ctx.createLinearGradient(0, 0, 0, H);
    world.sky.forEach((colour, i) => sky.addColorStop(i / (world.sky.length - 1), colour));
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, H);
    const daylight = world.dayLight;
    const sunX = 35 + world.sunProgress * (W - 70);
    const sunY = 62 + (1 - Math.sin(world.sunProgress * Math.PI)) * 178;
    if (world.dayLight > .02) {
      const glow = ctx.createRadialGradient(sunX, sunY, 3, sunX, sunY, 108);
      glow.addColorStop(0, '#fff7d4c9'); glow.addColorStop(.24, '#fff4ce4d'); glow.addColorStop(1, '#fff4ce00');
      ctx.fillStyle = glow; ctx.fillRect(sunX - 112, sunY - 112, 224, 224);
      ctx.fillStyle = '#fff4ce'; ctx.beginPath(); ctx.arc(sunX, sunY, 19, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff4ce55'; ctx.lineWidth = 1;
      for (let i = 0; i < 9; i++) { const a = i / 9 * Math.PI * 2; ctx.beginPath(); ctx.moveTo(sunX + Math.cos(a) * 27, sunY + Math.sin(a) * 27); ctx.lineTo(sunX + Math.cos(a) * 35, sunY + Math.sin(a) * 35); ctx.stroke(); }
    }
    if (world.moonVisible) {
      const moonX = 35 + world.moonProgress * (W - 70);
      const moonY = 62 + (1 - Math.sin(world.moonProgress * Math.PI)) * 178;
      const moonGlow = ctx.createRadialGradient(moonX, moonY, 1, moonX, moonY, 62);
      moonGlow.addColorStop(0, '#d9e8ffc0'); moonGlow.addColorStop(1, '#d9e8ff00');
      ctx.fillStyle = moonGlow; ctx.beginPath(); ctx.arc(moonX, moonY, 62, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#eaf1ff'; ctx.beginPath(); ctx.arc(moonX, moonY, 15, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#a2b5db'; ctx.beginPath(); ctx.arc(moonX + 6, moonY - 4, 14, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#eff4ff'; ctx.beginPath(); ctx.arc(moonX - 8, moonY - 3, 2, 0, Math.PI * 2); ctx.fill();
    }
    game.stars.forEach(s => {
      const twinkle = (Math.sin(t * .0018 + s.phase) + 1) * .18;
      ctx.globalAlpha = world.isNight ? Math.min(.95, .45 + s.a + twinkle) : Math.max(0, (s.a + twinkle - .48) * (1 - daylight));
      ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
    }); ctx.globalAlpha = 1;
    // Hidden detail: occasional shooting stars only appear after dusk.
    if (world.isNight) {
      const cometCycle = ((t % 54000) + 54000) % 54000;
      if (cometCycle < 1150) {
        const progress = cometCycle / 1150;
        const cx = W + 48 - progress * (W + 95), cy = 76 + progress * 118;
        const trail = ctx.createLinearGradient(cx - 42, cy - 15, cx + 1, cy + 1);
        trail.addColorStop(0, '#d8e6ff00'); trail.addColorStop(1, '#fff4cddd');
        ctx.strokeStyle = trail; ctx.lineWidth = 1.8; ctx.beginPath(); ctx.moveTo(cx - 42, cy - 15); ctx.lineTo(cx + 1, cy + 1); ctx.stroke();
        ctx.fillStyle = '#fff9db'; ctx.beginPath(); ctx.arc(cx + 1, cy + 1, 2.2, 0, Math.PI * 2); ctx.fill();
      }
    }
    // A tiny hidden constellation glints at score 42 — a quiet Easter egg.
    if (game.score === 42) {
      ctx.save(); ctx.globalAlpha = .35 + (Math.sin(t * .002) + 1) * .16; ctx.strokeStyle = '#ffe6a6'; ctx.lineWidth = 1;
      const points = [[W - 94, 58], [W - 82, 47], [W - 72, 60], [W - 60, 43], [W - 48, 53]];
      ctx.beginPath(); points.forEach((point, i) => i ? ctx.lineTo(point[0], point[1]) : ctx.moveTo(point[0], point[1])); ctx.stroke();
      ctx.fillStyle = '#fff3c4'; points.forEach(([x, y]) => { ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill(); }); ctx.restore();
    }
    // Drifting clouds change their tint subtly between night, dawn and bright daytime.
    game.clouds.forEach(c => {
      let x = (c.x - t * .008 * c.s) % (W + 150); if (x < -100) x += W + 150; x -= 50;
      ctx.globalAlpha = c.a * (.58 + daylight * .42); ctx.fillStyle = world.isNight ? '#c4d3f7' : world.seasonIndex === 2 ? '#fff0e2' : '#fffdf2';
      ctx.beginPath(); ctx.ellipse(x, c.y, 30 * c.s, 10 * c.s, 0, 0, Math.PI * 2); ctx.ellipse(x + 19 * c.s, c.y - 8 * c.s, 18 * c.s, 14 * c.s, 0, 0, Math.PI * 2); ctx.ellipse(x + 38 * c.s, c.y, 23 * c.s, 9 * c.s, 0, 0, Math.PI * 2); ctx.fill();
    }); ctx.globalAlpha = 1;
    // Small seasonal flecks: blossom in spring, warm leaves in autumn, snow in winter.
    if (world.seasonIndex === 0 || world.seasonIndex === 2 || world.seasonIndex === 3) {
      for (let i = 0; i < 18; i++) {
        const x = (i * 79 + t * (world.seasonIndex === 3 ? -.018 : .024) * (1 + i % 3)) % W;
        const y = (i * 43 + t * (world.seasonIndex === 3 ? .025 : .055) * (1 + i % 2)) % (H - GROUND);
        ctx.globalAlpha = world.seasonIndex === 3 ? .52 : .3;
        ctx.fillStyle = world.seasonIndex === 0 ? '#ffe0f0' : world.seasonIndex === 2 ? '#f8bd86' : '#ffffff';
        if (world.seasonIndex === 2) { ctx.save(); ctx.translate(x, y); ctx.rotate(t * .001 + i); ctx.fillRect(-2, -1, 5, 2); ctx.restore(); }
        else { ctx.beginPath(); ctx.arc(x, y, world.seasonIndex === 3 ? 1.6 : 2, 0, Math.PI * 2); ctx.fill(); }
      }
      ctx.globalAlpha = 1;
    }
    const horizonPalettes = [['#b5c6df', '#80b2a5', '#538f7f'], ['#a7b6d4', '#729d9d', '#4e8a81'], ['#c4a4b3', '#a98283', '#6b706e'], ['#b9c9df', '#7e9eae', '#587b90']];
    const horizons = horizonPalettes[world.seasonIndex].map((c, i) => mixHex(c, horizonPalettes[world.nextSeasonIndex][i], world.seasonProgress));
    ctx.fillStyle = horizons[0]; ctx.beginPath(); ctx.moveTo(0, 408);
    for (let x = 0; x <= W + 20; x += 22) ctx.lineTo(x, 376 + Math.sin(x * .023 + .8) * 19 + Math.sin(x * .043) * 8);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = horizons[1]; ctx.beginPath(); ctx.moveTo(0, 463);
    for (let x = 0; x <= W + 20; x += 24) ctx.lineTo(x, 425 + Math.sin(x * .026 + t * .00007 + 1) * 20 + Math.sin(x * .061) * 10);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
    ctx.fillStyle = horizons[2]; ctx.beginPath(); ctx.moveTo(0, 497);
    for (let x = 0; x <= W + 20; x += 26) ctx.lineTo(x, 464 + Math.sin(x * .019 + t * .00008 + 2) * 17 + Math.cos(x * .055) * 7);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath(); ctx.fill();
  }
  function drawPipe(p, t) {
    const x = p.x, w = p.w, top = p.top, gap = p.gap, bottom = top + gap, groundTop = H - GROUND;
    const shimmer = (Math.sin(t * .004 + p.shimmer) + 1) * .5;
    const pipeGrad = ctx.createLinearGradient(x, 0, x + w, 0);
    pipeGrad.addColorStop(0, '#277e79'); pipeGrad.addColorStop(.14, p.tint || '#4ba995'); pipeGrad.addColorStop(.34, '#7ae1b8'); pipeGrad.addColorStop(.7, p.tint || '#50bda1'); pipeGrad.addColorStop(1, '#247e7c');
    ctx.fillStyle = '#214c5c2b';
    drawRoundedRect(x + 4, 0, w, top - 18, 9); ctx.fill();
    drawRoundedRect(x + 4, bottom + 20, w, groundTop - bottom - 19, 9); ctx.fill();
    ctx.fillStyle = pipeGrad;
    drawRoundedRect(x, -8, w, top - 14, 10); ctx.fill();
    drawRoundedRect(x, bottom + 18, w, groundTop - bottom - 16, 10); ctx.fill();
    ctx.fillStyle = '#c1ffe055'; ctx.fillRect(x + 8, 0, 5, Math.max(0, top - 20)); ctx.fillRect(x + 8, bottom + 23, 5, Math.max(0, groundTop - bottom - 29));
    ctx.fillStyle = '#185e62';
    drawRoundedRect(x - 5, top - 22, w + 10, 25, 7); ctx.fill(); drawRoundedRect(x - 5, bottom - 2, w + 10, 25, 7); ctx.fill();
    ctx.fillStyle = '#83e5c0'; ctx.fillRect(x + 1, top - 19, w - 2, 4); ctx.fillRect(x + 1, bottom + 2, w - 2, 4);
    // Fine golden inlay makes the gates feel like an illustrated arcade toy.
    ctx.globalAlpha = .25 + shimmer * .28; ctx.fillStyle = '#ffefb5'; ctx.fillRect(x + w - 12, 8, 2, Math.max(0, top - 34)); ctx.fillRect(x + w - 12, bottom + 27, 2, Math.max(0, groundTop - bottom - 38)); ctx.globalAlpha = 1;
    ctx.strokeStyle = '#d0ffe01c'; ctx.lineWidth = 1; ctx.strokeRect(x + 4.5, top - 10, w - 9, 1);
  }
  function drawGround(t) {
    const y = H - GROUND, world = getWorldState();
    const groundPalettes = [['#eadbb0', '#8bbd86', '#b1daa0'], ['#ead9a5', '#8bbd86', '#b1daa0'], ['#dfbf91', '#9caa79', '#c7a16f'], ['#d8e3ee', '#a7c8d3', '#c4d6e4']];
    const ground = groundPalettes[world.seasonIndex].map((c, i) => mixHex(c, groundPalettes[world.nextSeasonIndex][i], world.seasonProgress));
    ctx.fillStyle = ground[0]; ctx.fillRect(0, y, W, GROUND);
    ctx.fillStyle = ground[1]; ctx.fillRect(0, y, W, 9);
    ctx.fillStyle = ground[2]; ctx.fillRect(0, y, W, 3);
    ctx.fillStyle = world.seasonIndex === 3 ? '#d2e0ed' : '#c7b97f';
    const off = (t * .07) % 25;
    for (let x = -off; x < W + 25; x += 25) { ctx.fillRect(x, y + 20, 13, 4); ctx.fillRect(x + 9, y + 37, 7, 3); }
    ctx.fillStyle = '#fff3ce'; ctx.fillRect(0, y + 10, W, 2);
  }
  function drawPickup(p, t) {
    const item = p.item, bob = Math.sin(t * .004 + p.phase) * 5, x = p.x, y = p.y + bob;
    const auraColor = item.auraColor || item.rarityColor;
    ctx.save(); ctx.translate(x, y); ctx.rotate(Math.sin(t * .0018 + p.phase) * .15);
    const pulse = 1 + Math.sin(t * .004 + p.phase) * .08;
    const glow = ctx.createRadialGradient(0, 0, 1, 0, 0, 30 + item.power * .9);
    glow.addColorStop(0, `${auraColor}aa`); glow.addColorStop(.45, `${item.rarityColor}35`); glow.addColorStop(1, `${item.rarityColor}00`);
    ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, (30 + item.power * .9) * pulse, 0, Math.PI * 2); ctx.fill();
    // Each relic family has its own animated aura language, shape and texture.
    ctx.strokeStyle = `${auraColor}b8`; ctx.lineWidth = item.rarity === 'mythic' ? 2 : 1.1;
    if (item.type === 'shield' || item.type === 'ward') {
      ctx.beginPath(); ctx.arc(0, 0, 20 + Math.sin(t * .003 + p.phase) * 2, t * .0006, t * .0006 + Math.PI * 1.55); ctx.stroke();
      ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2 - Math.PI / 2; const px = Math.cos(a) * 18, py = Math.sin(a) * 18; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.closePath(); ctx.stroke();
    } else if (item.type === 'slow' || item.type === 'time') {
      for (let i = 0; i < 3; i++) { ctx.globalAlpha = .65 - i * .14; ctx.beginPath(); ctx.arc(0, 0, 17 + i * 4 + Math.sin(t * .002 + i) * 1.5, -t * .0008 + i, -t * .0008 + i + Math.PI * 1.35); ctx.stroke(); } ctx.globalAlpha = 1;
    } else if (item.type === 'heal') {
      ctx.beginPath(); ctx.arc(0, 0, 17 + pulse * 2, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = .7; ctx.beginPath(); ctx.moveTo(-19, -7); ctx.lineTo(-24, -12); ctx.moveTo(19, 7); ctx.lineTo(24, 12); ctx.stroke(); ctx.globalAlpha = 1;
    } else if (item.type === 'magnet') {
      ctx.beginPath(); ctx.arc(0, 0, 18, -.9, .9); ctx.stroke(); ctx.beginPath(); ctx.arc(0, 0, 18, Math.PI - .9, Math.PI + .9); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-12, -15); ctx.lineTo(-6, -20); ctx.moveTo(12, -15); ctx.lineTo(6, -20); ctx.stroke();
    } else if (item.type === 'gust') {
      for (let i = 0; i < 3; i++) { const shift = (t * .03 + i * 10) % 22; ctx.globalAlpha = .7 - i * .15; ctx.beginPath(); ctx.moveTo(-23 + shift, -7 + i * 7); ctx.quadraticCurveTo(-3 + shift, -13 + i * 7, 14 + shift / 3, -5 + i * 7); ctx.stroke(); } ctx.globalAlpha = 1;
    } else {
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + t * .0007; ctx.beginPath(); ctx.moveTo(Math.cos(a) * 15, Math.sin(a) * 15); ctx.lineTo(Math.cos(a) * 23, Math.sin(a) * 23); ctx.stroke(); }
    }
    ctx.fillStyle = '#0e1830eF'; ctx.strokeStyle = item.rarityColor; ctx.lineWidth = item.rarity === 'mythic' ? 2.8 : item.rarity === 'legendary' ? 2.2 : 1.6;
    ctx.beginPath(); ctx.roundRect(-13, -13, 26, 26, item.type === 'heal' ? 13 : item.type === 'time' ? 5 : 8); ctx.fill(); ctx.stroke();
    // Subtle inlay pattern is clipped to the jewel tile.
    ctx.save(); ctx.beginPath(); ctx.roundRect(-11, -11, 22, 22, 6); ctx.clip();
    ctx.globalAlpha = .22; ctx.strokeStyle = auraColor; ctx.lineWidth = .8;
    for (let i = -24; i <= 24; i += 6) { ctx.beginPath(); ctx.moveTo(i, -14); ctx.lineTo(i + 16, 14); ctx.stroke(); }
    ctx.restore(); ctx.globalAlpha = 1;
    ctx.fillStyle = auraColor; ctx.font = 'bold 16px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(item.symbol, 0, 1);
    ctx.fillStyle = '#ffffffdd'; ctx.beginPath(); ctx.arc(9, -9, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function drawBird() {
    const b = game.bird;
    const skin = equippedCosmetic('bird') || getCosmetic(COSMETIC_DEFAULTS.bird);
    const aura = equippedCosmetic('aura') || getCosmetic(COSMETIC_DEFAULTS.aura);
    const trail = equippedCosmetic('trail') || getCosmetic(COSMETIC_DEFAULTS.trail);
    const wings = equippedCosmetic('wings') || getCosmetic(COSMETIC_DEFAULTS.wings);
    if (trail && trail.code !== 'trail_none') {
      game.trail.forEach(point => {
        const fade = Math.max(0, 1 - point.age / point.maxAge);
        ctx.save(); ctx.globalAlpha = fade * .62; ctx.fillStyle = trail.primary;
        if (trail.texture.includes('bubbles') || trail.texture.includes('dust') || trail.texture.includes('stars')) {
          ctx.beginPath(); ctx.arc(point.x - point.age * .35, point.y + Math.sin(point.age * .7 + point.phase) * 3, 1.1 + fade * 2, 0, Math.PI * 2); ctx.fill();
        } else {
          ctx.beginPath(); ctx.ellipse(point.x - point.age * .75, point.y + Math.sin(point.age * .6 + point.phase) * 2, 5 + fade * 8, 1.2 + fade * 1.7, -.12, 0, Math.PI * 2); ctx.fill();
          if (trail.texture === 'prism') { ctx.globalAlpha *= .65; ctx.fillStyle = trail.secondary; ctx.fillRect(point.x - point.age * .75, point.y - 1, 7, 1.2); }
        }
        ctx.restore();
      });
    }
    ctx.save(); ctx.translate(b.x, b.y); ctx.rotate(b.rot);
    const auraColor = aura && aura.code !== 'aura_none' ? aura.primary : null;
    if (auraColor) {
      const pulse = 1 + Math.sin(game.elapsed * .006) * .055;
      const radius = 27 * pulse;
      const glow = ctx.createRadialGradient(0, 0, 8, 0, 0, 43 * pulse);
      glow.addColorStop(0, `${auraColor}20`); glow.addColorStop(.45, `${auraColor}21`); glow.addColorStop(1, `${auraColor}00`);
      ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(0, 0, 43 * pulse, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `${auraColor}a8`; ctx.lineWidth = aura.rarity === 'mythic' ? 2.2 : 1.35;
      if (aura.texture === 'eclipse' || aura.texture === 'orbit' || aura.texture === 'prism') {
        for (let i = 0; i < (aura.texture === 'eclipse' ? 3 : 2); i++) {
          ctx.beginPath(); ctx.ellipse(0, 0, radius + i * 5, radius * (.78 + i * .06), game.elapsed * .00025 * (i % 2 ? -1 : 1), game.elapsed * .0005 + i, game.elapsed * .0005 + i + Math.PI * 1.55); ctx.stroke();
        }
      } else if (aura.texture === 'sunrays' || aura.texture === 'crown' || aura.texture === 'lightning') {
        for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + game.elapsed * .0003; const r1 = 23, r2 = 29 + Math.sin(game.elapsed * .003 + i) * 2; ctx.beginPath(); ctx.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); ctx.stroke(); }
      } else if (aura.texture === 'petals' || aura.texture === 'snowflake') {
        for (let i = 0; i < 7; i++) { const a = i * Math.PI * 2 / 7 + game.elapsed * .0002; ctx.beginPath(); ctx.ellipse(Math.cos(a) * 28, Math.sin(a) * 28, 3, 5, a, 0, Math.PI * 2); ctx.stroke(); }
      } else {
        ctx.beginPath(); ctx.arc(0, 0, radius, game.elapsed * .0007, game.elapsed * .0007 + Math.PI * 1.65); ctx.stroke();
        for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + game.elapsed * .0005; ctx.beginPath(); ctx.arc(Math.cos(a) * 30, Math.sin(a) * 30, 1.8, 0, Math.PI * 2); ctx.stroke(); }
      }
    }
    if (game.mode === 'arcade' && game.shieldMs > 0) {
      const pulse = 1 + Math.sin(game.elapsed * .008) * .035;
      ctx.strokeStyle = '#bca5ffb0'; ctx.lineWidth = 2; ctx.fillStyle = '#bca5ff12'; ctx.beginPath(); ctx.arc(0, 0, 27 * pulse, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.strokeStyle = '#83f1d080'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(0, 0, 31 * pulse, game.elapsed * .001, game.elapsed * .001 + 1.5); ctx.stroke();
    }
    if (game.invulnerable > 0 && Math.floor(game.invulnerable / 90) % 2 === 0) ctx.globalAlpha = .48;
    ctx.fillStyle = '#31566a40'; ctx.beginPath(); ctx.ellipse(0, 16, 15, 4, 0, 0, Math.PI * 2); ctx.fill();
    const body = ctx.createLinearGradient(-15, -14, 15, 13);
    body.addColorStop(0, mixHex(skin?.primary || '#ffd477', '#ffffff', .23));
    body.addColorStop(.55, skin?.primary || '#ffd477');
    body.addColorStop(1, skin?.secondary || '#ffab63');
    ctx.fillStyle = body; ctx.beginPath(); ctx.ellipse(0, 0, 16, 13, 0, 0, Math.PI * 2); ctx.fill();
    // Procedural feather textures give each skin a distinct visual material without image downloads.
    ctx.save(); ctx.beginPath(); ctx.ellipse(0, 0, 15, 12, 0, 0, Math.PI * 2); ctx.clip();
    ctx.globalAlpha = .28; ctx.strokeStyle = skin?.secondary || '#ffab63'; ctx.fillStyle = skin?.secondary || '#ffab63'; ctx.lineWidth = 1;
    const texture = skin?.texture || 'dots';
    if (texture === 'stripes' || texture === 'rays' || texture === 'flame' || texture === 'waves') {
      for (let i = -24; i <= 24; i += 5) { ctx.beginPath(); ctx.moveTo(i, -14); ctx.quadraticCurveTo(i + 8, 0, i - 2, 14); ctx.stroke(); }
    } else if (texture === 'stars' || texture === 'star-map' || texture === 'constellation') {
      for (let i = 0; i < 8; i++) { const x = -11 + (i * 7 % 23), y = -8 + (i * 11 % 17); ctx.beginPath(); ctx.arc(x, y, i % 3 === 0 ? 1.5 : .7, 0, Math.PI * 2); ctx.fill(); }
    } else if (texture === 'scales' || texture === 'honeycomb' || texture === 'crystal' || texture === 'prism') {
      for (let y = -12; y <= 12; y += 5) for (let x = -15; x <= 15; x += 7) { ctx.beginPath(); ctx.moveTo(x, y - 2); ctx.lineTo(x + 3, y); ctx.lineTo(x, y + 2); ctx.lineTo(x - 3, y); ctx.closePath(); ctx.stroke(); }
    } else {
      for (let i = 0; i < 15; i++) { const x = ((i * 17) % 28) - 14, y = ((i * 13) % 22) - 11; ctx.beginPath(); ctx.arc(x, y, i % 4 === 0 ? 1.35 : .65, 0, Math.PI * 2); ctx.fill(); }
    }
    ctx.restore(); ctx.globalAlpha = 1;
    ctx.strokeStyle = mixHex(skin?.primary || '#ffd477', '#ffffff', .45); ctx.lineWidth = 1.2; ctx.stroke();
    // Wing texture is separate from the body skin and changes with the wing-style slot.
    const wingFill = ctx.createLinearGradient(-13, 0, 3, 12); wingFill.addColorStop(0, wings?.primary || '#f49a5e'); wingFill.addColorStop(1, wings?.secondary || '#d99057');
    ctx.fillStyle = wingFill; ctx.beginPath(); ctx.ellipse(-5, 4, 8, 5.2, Math.sin(game.elapsed * .02) * .3, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = wings?.secondary || '#ffdba0'; ctx.lineWidth = 1.4; ctx.beginPath(); ctx.ellipse(-5, 4, 5.5, 3, 0, .1, Math.PI * .9); ctx.stroke();
    if (wings?.texture && wings.texture !== 'classic') { ctx.globalAlpha = .55; ctx.strokeStyle = wings.secondary; ctx.lineWidth = .8; ctx.beginPath(); ctx.moveTo(-11, 2); ctx.lineTo(-2, 6); ctx.moveTo(-10, 5); ctx.lineTo(-3, 8); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.arc(7, -5, 5.2, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#18243b'; ctx.beginPath(); ctx.arc(8.8, -5, 2.4, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(9.5, -6, .8, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#f27c65'; ctx.beginPath(); ctx.moveTo(14, -1); ctx.lineTo(25, 2.5); ctx.lineTo(14, 5.5); ctx.closePath(); ctx.fill(); ctx.strokeStyle = '#ffd3a0'; ctx.lineWidth = .8; ctx.stroke();
    ctx.strokeStyle = '#de8c4b'; ctx.lineWidth = 1.6; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(-2, 10); ctx.lineTo(-1, 15); ctx.moveTo(4, 10); ctx.lineTo(5, 15); ctx.stroke();
    ctx.restore();
  }
  function drawParticles(dt = 1) {
    for (const p of game.particles) {
      const alpha = Math.max(0, Math.min(1, p.life / p.maxLife)); ctx.globalAlpha = alpha; ctx.fillStyle = p.color;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2); ctx.fill();
    } ctx.globalAlpha = 1;
  }
  function render(t = 0) {
    ctx.save();
    if (game.shake > 0) ctx.translate((Math.random() - .5) * game.shake, (Math.random() - .5) * game.shake);
    drawSky(t);
    game.pipes.forEach(pipe => drawPipe(pipe, t));
    game.pickups.forEach(pickup => drawPickup(pickup, t));
    drawGround(t); drawParticles(); drawBird();
    if (game.mode === 'arcade' && game.slowMs > 0 && game.running) {
      ctx.fillStyle = '#78dbff0d'; ctx.fillRect(0, 0, W, H);
    }
    ctx.restore();
  }
  function collectPickup(pickup) {
    if (!pickup || pickup.collected) return;
    pickup.collected = true;
    const item = pickup.item;
    game.itemsCollected++;
    if (rarityRank(item.rarity) >= rarityRank('rare')) game.rareItems++;
    burst(pickup.x, pickup.y, 12, [item.rarityColor, '#ffffff', '#83f1d0']);
    tone(680 + item.power * 35, .09, 'triangle', .03);
    applyRelicEffect(item);
    showToast(`${item.name} · POWER ${item.power}`, 'success', 2300);
    if (authUser && supabase) {
      supabase.rpc('collect_ability_item', { p_item_code: item.code }).then(async ({ data, error }) => {
        if (error) throw error;
        await Promise.all([fetchCloudProfile(), fetchCloudAwards(), fetchCloudInventory()]);
        (Array.isArray(data?.awards) ? data.awards : []).forEach(toastAward);
        updateProfileUI(); renderAchievementBrowser(); renderCodex();
      }).catch(error => {
        console.warn('Relic cloud sync failed:', error);
        showToast('Relic effect applied, but its collection did not sync. Check your connection.', 'error', 3800);
      });
    } else {
      localSave.inventory[item.code] = nonNegativeInt(localSave.inventory[item.code]) + 1;
      localSave.itemsCollected++;
      if (rarityRank(item.rarity) >= rarityRank('rare')) localSave.rareItems++;
      unlockLocalAwards(); updateProfileUI(); renderAchievementBrowser(); renderCodex();
    }
  }
  function applyRelicEffect(item) {
    const power = item.power;
    if (item.type === 'shield' || item.type === 'ward') {
      game.shieldMs = Math.max(game.shieldMs, 1200 + power * 420);
      game.invulnerable = Math.max(game.invulnerable, 650 + power * 110);
    } else if (item.type === 'slow' || item.type === 'time') {
      game.slowMs = Math.min(10000, game.slowMs + 1200 + power * 240);
    } else if (item.type === 'heal') {
      if (game.health < maxHealth()) game.health = Math.min(maxHealth(), game.health + 1);
      else game.shieldMs = Math.max(game.shieldMs, 1100 + power * 180);
      updateHealthUI();
    } else if (item.type === 'magnet') game.magnetMs = Math.min(12000, game.magnetMs + 2200 + power * 500);
    else if (item.type === 'gust') game.bird.vy = Math.max(-8.5, game.bird.vy - 1.3 - power * (.17 + upgradeLevel('wind_rider') * .025));
    else if (item.type === 'score') game.bonusNext = Math.min(10, game.bonusNext + Math.max(1, Math.floor(power / 2)));
  }
  function update(dt) {
    const elapsed = Math.min(dt, 34); const step = elapsed / 16.667;
    game.elapsed += elapsed;
    worldClockMs += elapsed * (game.running ? 0.65 + Math.min(2.2, game.score * .025) : .42);
    updateWorldLabel();
    if (!game.running || game.paused) {
      game.bird.wing += step * .09;
      if (!game.over && !game.paused) game.bird.y = 276 + Math.sin(game.elapsed * .0022) * 7;
      game.clouds.forEach(c => { c.x -= .04 * c.s * step; if (c.x < -70) c.x = W + 60; });
      game.particles = game.particles.filter(p => p.life > 0);
      game.particles.forEach(p => { p.x += p.vx * step; p.y += p.vy * step; p.vy += (p.gravity || .04) * step; p.life -= step; });
      if (game.shake > 0) game.shake = Math.max(0, game.shake - step * .7);
      return;
    }
    if (game.mode === 'arcade') {
      game.invulnerable = Math.max(0, game.invulnerable - elapsed);
      game.shieldMs = Math.max(0, game.shieldMs - elapsed);
      game.slowMs = Math.max(0, game.slowMs - elapsed);
      game.magnetMs = Math.max(0, game.magnetMs - elapsed);
      for (const id of Object.keys(game.cooldowns)) game.cooldowns[id] = Math.max(0, game.cooldowns[id] - elapsed);
    }
    const pace = game.slowMs > 0 ? .53 : 1;
    const speed = currentGameSpeed();
    const b = game.bird; b.vy += .34 * step; b.y += b.vy * step; b.rot = Math.min(1.12, Math.max(-.42, b.vy * .07)); b.wing += step * .22;
    game.trail.forEach(point => { point.age += step; });
    game.trail = game.trail.filter(point => point.age < point.maxAge);
    if (Math.random() < .75) game.trail.unshift({ x: b.x - 12, y: b.y + 2, age: 0, maxAge: 18, phase: Math.random() * 6 });
    if (game.trail.length > 24) game.trail.length = 24;
    game.groundOffset = (game.groundOffset + speed * step) % 25;
    game.spawn += step * pace;
    const spawnTarget = mode === 'arcade' ? Math.max(66, 100 - Math.floor(game.score / 7) * 1.7) : 100;
    const nextPipeX = W + 28;
    // A future gate could otherwise spawn beside an already-moving relic. Defer that
    // gate briefly while the relic is within its horizontal danger zone. Clamp the spawn
    // accumulator so the delay cannot make several gates bunch up on the next frame.
    const pickupBlocksGateSpawn = mode === 'arcade' && game.pickups.some(pickup => Math.abs(pickup.x - nextPipeX) < 132);
    if (pickupBlocksGateSpawn) {
      game.spawn = Math.min(game.spawn, spawnTarget);
    } else if (game.spawn > spawnTarget) {
      game.pipes.push(makePipe(nextPipeX));
      game.spawn -= spawnTarget;
    }
    for (const pipe of game.pipes) {
      pipe.x -= speed * step * pace;
      if (!pipe.passed && pipe.x + pipe.w < b.x) {
        pipe.passed = true;
        let gained = 1;
        const scoreLevel = upgradeLevel('score_lens');
        if (scoreLevel >= 2 && (game.score + 1) % 5 === 0) gained += Math.min(2, scoreLevel - 1);
        if (game.bonusNext > 0) { gained += game.bonusNext; game.bonusNext = 0; }
        game.score += gained; els.score.textContent = String(game.score).padStart(3, '0');
        burst(b.x + 5, b.y, 7, ['#ffffff', '#ffd68a', '#83f1d0']); tone(730, .055, 'sine', .023);
        els.floatingScore.textContent = `+${gained}`; els.floatingScore.classList.remove('pop'); void els.floatingScore.offsetWidth; els.floatingScore.classList.add('pop');
        updateDifficultyUI();
        if (game.score % 5 === 0) els.summary.textContent = `${game.score} gates cleared. ${mode === 'arcade' ? difficultyTier(game.score).name + ' sky —' : 'The pace is rising —'} keep your rhythm!`;
      }
      if (collisionWithPipe(pipe)) { applyHit('gate'); if (!game.running) break; }
    }
    game.pipes = game.pipes.filter(p => p.x > -p.w - 22);
    if (mode === 'arcade') {
      game.pickupTimer += elapsed;
      if (game.pickupTimer > 6200 + Math.random() * 4900 && game.pickups.length < 1) {
        const item = chooseAbilityItem();
        // All gates and relics move at the same pace. Spawn relics well beyond the newest
        // gate's right edge so their sprite never overlaps a pipe, including the gate that
        // may have been created earlier in this same update. Keep additional room for glow.
        const pickupRadius = 28;
        const gateClearance = 78;
        const maxPipeWidth = 72;
        let pickupX = W + 28 + maxPipeWidth + pickupRadius + gateClearance;
        for (const pipe of game.pipes) {
          const pipeLeft = pipe.x - pickupRadius - gateClearance;
          const pipeRight = pipe.x + pipe.w + pickupRadius + gateClearance;
          if (pickupX >= pipeLeft && pickupX <= pipeRight) pickupX = pipeRight;
        }
        const pickupY = 95 + Math.random() * (H - GROUND - 175);
        game.pickups.push({ item, x: pickupX, y: pickupY, phase: Math.random() * Math.PI * 2, collected: false });
        game.pickupTimer = 0;
      }
      for (const pickup of game.pickups) {
        pickup.x -= speed * step * pace;
        const reach = 20 + upgradeLevel('magnet_field') * 18 + (game.magnetMs > 0 ? 64 : 0);
        if (Math.hypot(pickup.x - b.x, pickup.y + Math.sin(worldClockMs * .004 + pickup.phase) * 5 - b.y) < reach) collectPickup(pickup);
      }
      game.pickups = game.pickups.filter(p => !p.collected && p.x > -40);
    } else game.pickups = [];
    if (game.running && (b.y - b.r < 0 || b.y + b.r > H - GROUND)) {
      const hitCeiling = b.y - b.r < 0;
      if (game.mode === 'classic') finishRun();
      else if (game.invulnerable <= 0) applyHit(hitCeiling ? 'ceiling' : 'floor');
      else { b.y = Math.max(b.r + 1, Math.min(H - GROUND - b.r - 1, b.y)); if (b.y <= b.r + 1) b.vy = Math.max(0, b.vy); }
    }
    game.particles = game.particles.filter(p => p.life > 0);
    game.particles.forEach(p => { p.x += p.vx * step; p.y += p.vy * step; p.vy += (p.gravity || .04) * step; p.life -= step; });
    if (game.shake > 0) game.shake = Math.max(0, game.shake - step * .7);
    updateAbilityUI();
  }
  function loop(now) {
    const dt = game.lastFrame ? now - game.lastFrame : 16.67; game.lastFrame = now;
    update(dt); render(now); requestAnimationFrame(loop);
  }

  function renderLocalLeaderboard() {
    const runs = guestRuns;
    if (!runs.length) {
      els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>✧</span><b>No flights this session.</b><small>Guest history is memory-only. Sign in to keep your flight log in Supabase.</small></div>';
      els.leaderboardStatus.textContent = 'Session-only history'; return;
    }
    els.leaderboard.innerHTML = runs.slice(0, 8).map((run, index) => {
      const stamp = run.playedAt ? new Date(run.playedAt) : null;
      const date = stamp && !Number.isNaN(stamp.getTime()) ? stamp.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : 'Recent';
      return `<div class="leader-row"><span class="leader-rank">${String(index + 1).padStart(2, '0')}</span><span class="leader-avatar">${run.mode === 'arcade' ? '⚡' : '✦'}</span><span class="leader-user"><b>${safeText(run.pilotName || guestPilotName)}</b><small>${safeText(date)} · ${safeText(run.mode)} flight</small></span><span class="leader-score">${nonNegativeInt(run.score)}</span></div>`;
    }).join('');
    els.leaderboardStatus.textContent = `${runs.length} session flight${runs.length === 1 ? '' : 's'}`;
  }
  async function updateLeaderboard() {
    if (leaderView === 'local') {
      if (!authUser || !supabase) { renderLocalLeaderboard(); return; }
      els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>⌁</span><b>Loading your flight log…</b></div>';
      try {
        const { data, error } = await supabase.from('flight_runs').select('score, mode, created_at').eq('user_id', authUser.id).order('created_at', { ascending: false }).limit(8);
        if (error) throw error;
        if (!data?.length) { els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>✧</span><b>No cloud flights yet.</b><small>Finish a signed-in run and it will appear here.</small></div>'; els.leaderboardStatus.textContent = 'No cloud flights'; return; }
        els.leaderboard.innerHTML = data.map((run, index) => `<div class="leader-row"><span class="leader-rank">${String(index + 1).padStart(2, '0')}</span><span class="leader-avatar">${run.mode === 'arcade' ? '⚡' : '✦'}</span><span class="leader-user"><b>${run.mode === 'arcade' ? 'Arcade flight' : 'Classic flight'}</b><small>${safeText(new Date(run.created_at).toLocaleDateString())} · ${safeText(run.mode)}</small></span><span class="leader-score">${nonNegativeInt(run.score)}</span></div>`).join('');
        els.leaderboardStatus.textContent = 'Saved in Supabase';
      } catch (error) { console.warn('Personal flight log failed:', error); renderLocalLeaderboard(); showToast('Could not load the cloud flight log.', 'error', 3000); }
      return;
    }
    if (!supabase) {
      els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>♛</span><b>Your rivals are out there.</b><small>Connect Supabase for a shared global board. Guest scores are session-only.</small></div>';
      els.leaderboardStatus.textContent = 'Backend setup needed'; return;
    }
    els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>⌁</span><b>Looking for pilots…</b><small>Refreshing the global flight board.</small></div>';
    try {
      const { data, error } = await supabase.from('profiles').select('id, username, best_score, level, xp, updated_at').gt('best_score', 0).order('best_score', { ascending: false }).order('updated_at', { ascending: true }).limit(10);
      if (error) throw error;
      if (!data?.length) {
        els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>✧</span><b>Room for a legend.</b><small>Be the first pilot to post a score to the global board.</small></div>';
        els.leaderboardStatus.textContent = 'Awaiting first record'; return;
      }
      els.leaderboard.innerHTML = data.map((person, index) => {
        const name = String(person.username || 'Sky Pilot');
        const first = name.charAt(0).toUpperCase() || '✦';
        const color = palette[index % palette.length];
        return `<div class="leader-row"><span class="leader-rank">${String(index + 1).padStart(2, '0')}</span><span class="leader-avatar" style="background:linear-gradient(140deg,${color},#83f1d0)">${safeText(first)}</span><span class="leader-user"><b>${safeText(name)}</b><small>LEVEL ${nonNegativeInt(person.level) || 1} · FLIGHT CLUB</small></span><span class="leader-score">${nonNegativeInt(person.best_score)}</span></div>`;
      }).join('');
      els.leaderboardStatus.textContent = 'Global best flights';
    } catch (error) {
      console.warn('Leaderboard fetch failed:', error);
      els.leaderboard.innerHTML = '<div class="leaderboard-empty"><span>⌁</span><b>Board taking a breather.</b><small>Check the migration and RLS policies in Supabase.</small></div>';
      els.leaderboardStatus.textContent = 'Could not load board';
    }
  }

  async function initBackend() {
    const url = String(CONFIG.supabaseUrl || '').trim();
    const key = String(CONFIG.supabaseAnonKey || '').trim();
    if (!url || !key || /YOUR_|your-project|your_key/i.test(url + key)) {
      els.authBackendNote.textContent = 'Supabase is not configured yet. You can play as a guest, but guest progress is memory-only and disappears on refresh.';
      updateProfileUI(); updateLeaderboard(); return;
    }
    try {
      const moduleUrl = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
      const { createClient } = await import(moduleUrl);
      supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: true } });
      try { await fetchRemoteCatalogs(); } catch (catalogError) { console.warn('Remote catalog unavailable; using built-in visual fallbacks:', catalogError); }
      els.authBackendNote.textContent = 'Progress, currency, inventory, achievements, cosmetics and equipped styles are stored in Supabase. Your email is never shown publicly.';
      els.connection.textContent = 'CLOUD READY'; $('.online-pill').classList.add('is-connected');
      supabase.auth.onAuthStateChange((_event, session) => {
        authSession = session; authUser = session?.user || null;
        window.setTimeout(async () => {
          if (authUser) {
            try { await Promise.all([fetchCloudProfile(), fetchCloudAwards(), fetchCloudInventory(), fetchCloudUpgrades(), fetchCloudStoreCosmetics()]); }
            catch (error) { console.warn('Cloud profile refresh failed:', error); showToast('Some cloud data could not be loaded. Check the database patch.', 'error', 4200); }
          } else { cloudProfile = null; cloudStats = null; cloudAwards = []; cloudInventory = {}; cloudUpgrades = {}; cloudCosmetics = new Set(); cloudLoadout = { ...COSMETIC_DEFAULTS }; }
          updateProfileUI(); updateLeaderboard(); renderAchievementBrowser(); renderCodex();
        }, 0);
      });
      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      authSession = data.session; authUser = authSession?.user || null;
      if (authUser) await Promise.all([fetchCloudProfile(), fetchCloudAwards(), fetchCloudInventory(), fetchCloudUpgrades(), fetchCloudStoreCosmetics()]);
      updateProfileUI(); updateLeaderboard(); renderAchievementBrowser(); renderCodex();
    } catch (error) {
      console.error('Supabase initialization failed:', error);
      supabase = null;
      els.authBackendNote.textContent = 'Supabase could not connect. Check the project URL, publishable key and database migration.';
      els.connection.textContent = 'GUEST FLIGHT'; $('.online-pill').classList.remove('is-connected');
      updateProfileUI(); updateLeaderboard();
    }
  }
  async function fetchCloudProfile() {
    if (!supabase || !authUser) return;
    const [{ data: profile, error: profileError }, { data: stats, error: statsError }] = await Promise.all([
      supabase.from('profiles').select('id, username, best_score, xp, level, updated_at').eq('id', authUser.id).maybeSingle(),
      supabase.from('player_stats').select('games_played, coins, lifetime_score, arcade_score, items_collected, rare_items, upgrades_purchased').eq('user_id', authUser.id).maybeSingle()
    ]);
    if (profileError) throw profileError;
    if (statsError) throw statsError;
    cloudProfile = profile ? { ...profile } : null;
    cloudStats = stats || { games_played: 0, coins: 0, lifetime_score: 0, arcade_score: 0, items_collected: 0, rare_items: 0, upgrades_purchased: 0 };
  }
  async function fetchCloudAwards() {
    if (!supabase || !authUser) return;
    const { data, error } = await supabase.from('user_achievements').select('achievement_code').eq('user_id', authUser.id);
    if (error) throw error;
    cloudAwards = (data || []).map(row => row.achievement_code).filter(id => AWARDS.some(a => a.id === id));
  }
  async function fetchCloudInventory() {
    if (!supabase || !authUser) return;
    const { data, error } = await supabase.from('player_inventory').select('item_code, quantity').eq('user_id', authUser.id);
    if (error) throw error;
    cloudInventory = Object.fromEntries((data || []).map(row => [row.item_code, nonNegativeInt(row.quantity)]));
  }
  async function fetchCloudUpgrades() {
    if (!supabase || !authUser) return;
    const { data, error } = await supabase.from('player_upgrades').select('upgrade_code, level').eq('user_id', authUser.id);
    if (error) throw error;
    cloudUpgrades = Object.fromEntries((data || []).map(row => [row.upgrade_code, nonNegativeInt(row.level)]));
  }
  async function fetchCloudStoreCosmetics() {
    if (!supabase || !authUser) return;
    const [{ data: ownedRows, error: ownedError }, { data: loadoutRow, error: loadoutError }] = await Promise.all([
      supabase.from('player_cosmetics').select('item_code').eq('user_id', authUser.id),
      supabase.from('player_loadout').select('bird_code, aura_code, trail_code, wings_code').eq('user_id', authUser.id).maybeSingle()
    ]);
    if (ownedError) throw ownedError;
    if (loadoutError) throw loadoutError;
    cloudCosmetics = new Set((ownedRows || []).map(row => row.item_code));
    cloudLoadout = {
      bird: loadoutRow?.bird_code || COSMETIC_DEFAULTS.bird,
      aura: loadoutRow?.aura_code || COSMETIC_DEFAULTS.aura,
      trail: loadoutRow?.trail_code || COSMETIC_DEFAULTS.trail,
      wings: loadoutRow?.wings_code || COSMETIC_DEFAULTS.wings
    };
  }
  async function fetchRemoteCatalogs() {
    if (!supabase) return;
    // Catalogue information is fetched from Supabase; in-file definitions are an offline-safe fallback only.
    const [abilityResult, storeResult] = await Promise.all([
      supabase.from('ability_catalog').select('code,name,rarity,item_type,power,drop_chance_percent,description,aura_color,texture_style,effect_description').order('code'),
      supabase.from('store_catalog').select('code,name,slot,description,rarity,price,primary_color,secondary_color,texture_style,symbol').order('slot').order('code')
    ]);
    if (!abilityResult.error && Array.isArray(abilityResult.data) && abilityResult.data.length) {
      cloudAbilityCatalog = abilityResult.data;
      const byCode = new Map(abilityResult.data.map(row => [row.code, row]));
      ABILITY_ITEMS.forEach(item => {
        const row = byCode.get(item.code); if (!row) return;
        item.name = row.name || item.name; item.description = row.description || item.description;
        item.auraColor = row.aura_color || item.auraColor; item.texture = row.texture_style || item.texture;
        item.effectDescription = row.effect_description || item.effectDescription;
        item.power = nonNegativeInt(row.power) || item.power;
        if (row.drop_chance_percent != null) item.dropChance = Number(row.drop_chance_percent);
      });
    }
    if (!storeResult.error && Array.isArray(storeResult.data) && storeResult.data.length) {
      cloudStoreCatalog = storeResult.data;
      const defaults = new Map(STORE_COSMETICS.map(item => [item.code, item]));
      const rows = storeResult.data.map(row => {
        const seed = defaults.get(row.code) || {};
        const rarityName = row.rarity || seed.rarity || 'common';
        return { ...seed, code: row.code, name: row.name || seed.name, slot: row.slot || seed.slot,
          description: row.description || seed.description || 'A Flight Club cosmetic.', rarity: rarityName,
          price: Number(row.price ?? seed.price ?? 25), primary: row.primary_color || seed.primary,
          secondary: row.secondary_color || seed.secondary, texture: row.texture_style || seed.texture || 'dots',
          symbol: row.symbol || seed.symbol || '✦', rarityColor: (RARITIES.find(r => r.id === rarityName) || RARITIES[0]).color,
          ownedDefault: Number(row.price ?? seed.price ?? 25) === 0 };
      });
      STORE_COSMETICS.splice(0, STORE_COSMETICS.length, ...rows);
    }
  }
  async function buyOrEquipCosmetic(code) {
    const item = getCosmetic(code);
    if (!item) return;
    if (!authUser || !supabase) { showToast('Sign in to buy, equip and cloud-save cosmetics.', 'info', 2800); openAuth('signin'); return; }
    const isOwned = item.ownedDefault || item.price === 0 || cloudCosmetics.has(code);
    const buttons = $$('[data-store-code]'); buttons.forEach(button => button.disabled = true);
    try {
      if (isOwned) {
        const { error } = await supabase.rpc('equip_store_item', { p_item_code: code });
        if (error) throw error;
        await fetchCloudStoreCosmetics();
        showToast(`${item.name} equipped. Your flight look is saved to the cloud.`, 'success', 2600);
      } else {
        if (nonNegativeInt(activeStats().coins) < item.price) { showToast(`You need ${item.price} coins for ${item.name}.`, 'error'); return; }
        const { data, error } = await supabase.rpc('purchase_store_item', { p_item_code: code });
        if (error) throw error;
        await Promise.all([fetchCloudProfile(), fetchCloudStoreCosmetics(), fetchCloudAwards()]);
        (Array.isArray(data?.awards) ? data.awards : []).forEach(toastAward);
        showToast(`${item.name} added to your cloud collection.`, 'success', 2800);
      }
      updateProfileUI(); renderStoreUI(); renderCodex();
    } catch (error) {
      console.warn('Store action failed:', error);
      showToast(error?.message || 'Store action failed. Apply the latest Supabase migration and try again.', 'error', 4500);
    } finally { renderStoreUI(); }
  }
  function openStore() {
    if (!els.storeDialog) return;
    if (game.running) pauseRun();
    renderStoreUI();
    if (!els.storeDialog.open) els.storeDialog.showModal();
  }
  function setStoreTab(tab) {
    activeStoreTab = ['birds', 'auras', 'trails', 'upgrades'].includes(tab) ? tab : 'birds';
    $$('.store-tab').forEach(button => {
      const selected = button.dataset.storeTab === activeStoreTab;
      button.classList.toggle('active', selected); button.setAttribute('aria-selected', String(selected));
    });
    renderStoreUI();
  }

  async function buyUpgrade(code) {
    const def = UPGRADES.find(item => item.code === code);
    if (!def) return;
    if (!authUser || !supabase) { showToast('Sign in to purchase upgrades and save them to Supabase.', 'info', 3000); openAuth('signin'); return; }
    const level = upgradeLevel(code);
    if (level >= def.maxLevel) { showToast('That upgrade is already maxed.', 'info'); return; }
    const price = maxLevelCost(def, level);
    if (nonNegativeInt(activeStats().coins) < price) { showToast(`You need ${price} coins for ${def.name}.`, 'error'); return; }
    const buttons = $$('.upgrade-buy'); buttons.forEach(button => button.disabled = true);
    try {
      const { data, error } = await supabase.rpc('purchase_upgrade', { p_upgrade_code: code });
      if (error) throw error;
      await Promise.all([fetchCloudProfile(), fetchCloudUpgrades(), fetchCloudAwards()]);
      (Array.isArray(data?.awards) ? data.awards : []).forEach(toastAward);
      updateProfileUI(); renderAchievementBrowser(); showToast(`${def.name} upgraded to level ${level + 1}.`, 'success');
    } catch (error) {
      console.warn('Upgrade purchase failed:', error);
      showToast(error?.message || 'The upgrade purchase failed. Check your Supabase setup.', 'error', 4200);
    } finally { renderStoreUI(); }
  }

  function setAuthMode(nextMode) {
    authMode = nextMode === 'signup' ? 'signup' : 'signin';
    $$('.auth-tab').forEach(button => button.classList.toggle('active', button.dataset.authMode === authMode));
    const signingUp = authMode === 'signup';
    els.usernameField.hidden = !signingUp;
    els.authUsername.required = signingUp;
    els.authPassword.autocomplete = signingUp ? 'new-password' : 'current-password';
    els.authTitle.textContent = signingUp ? 'Your sky starts here.' : 'Enter the flight club.';
    els.authEyebrow.textContent = signingUp ? 'MAKE YOUR MARK' : 'WELCOME BACK, PILOT';
    els.authSubtitle.textContent = signingUp ? 'Choose a pilot name. Your best flights and awards will follow you.' : 'Sign in to sync your scores, awards and flight log.';
    els.authSubmitBtn.innerHTML = signingUp ? 'Create pilot account <span>↗</span>' : 'Sign in <span>↗</span>';
    clearAuthMessage();
  }
  function clearAuthMessage() { els.authMessage.className = 'auth-message'; els.authMessage.textContent = ''; }
  function authMessage(message, type = 'info') { els.authMessage.textContent = message; els.authMessage.className = `auth-message visible ${type}`; }
  function pilotNameMessage(message, type = 'info') {
    els.pilotNameMessage.textContent = message;
    els.pilotNameMessage.className = `auth-message visible ${type}`;
  }
  function openPilotNameDialog() {
    const current = authUser ? (cloudProfile?.username || authUser.user_metadata?.username || '') : guestPilotName;
    els.pilotNameInput.value = current === 'Guest Pilot' || current === 'New Pilot' ? '' : current;
    els.pilotNameMessage.className = 'auth-message';
    els.pilotNameMessage.textContent = '';
    els.pilotNameSaveBtn.disabled = false;
    els.pilotNameSaveBtn.innerHTML = 'Save pilot name <span>↗</span>';
    els.pilotNamePrivacyNote.textContent = authUser
      ? 'Your new name is stored in your public pilot profile and may appear on the global leaderboard.'
      : 'Guest names are stored on this device only. Guest scores, coins and progression still reset after refresh.';
    if (!els.pilotNameDialog.open) els.pilotNameDialog.showModal();
    window.setTimeout(() => els.pilotNameInput.focus(), 60);
  }
  async function handlePilotNameSubmit(event) {
    event.preventDefault();
    const username = normalisePilotName(els.pilotNameInput.value);
    if (!validPilotName(username)) {
      pilotNameMessage('Use 3–16 letters, numbers or underscores. Spaces are not allowed.', 'error');
      return;
    }
    els.pilotNameSaveBtn.disabled = true;
    els.pilotNameSaveBtn.textContent = 'Saving name…';
    try {
      if (authUser && supabase) {
        const { data, error } = await supabase.rpc('set_pilot_username', { p_username: username });
        if (error) throw error;
        cloudProfile = { ...(cloudProfile || {}), username: typeof data === 'string' ? data : username };
        // Keep Auth metadata in sync too; the profiles table remains the authoritative public name.
        const { error: metadataError } = await supabase.auth.updateUser({ data: { username } });
        if (metadataError) console.warn('Pilot name saved to profile, but Auth metadata could not be updated:', metadataError);
        await fetchCloudProfile();
      } else {
        guestPilotName = username;
        try { window.localStorage.setItem(PILOT_NAME_STORAGE_KEY, username); }
        catch { pilotNameMessage('This browser blocked local storage. The name will last only for this page session.', 'info'); }
      }
      updateProfileUI();
      updateLeaderboard();
      if (els.pilotNameMessage.classList.contains('info')) {
        // Preserve the storage warning rather than replacing it with a success message.
      } else {
        pilotNameMessage(`Pilot name saved as ${username}.`, 'success');
      }
      showToast(`Pilot name updated: ${username}`, 'success', 2300);
      window.setTimeout(() => { if (els.pilotNameDialog.open) els.pilotNameDialog.close(); }, 850);
    } catch (error) {
      console.warn('Pilot name update failed:', error);
      const message = String(error?.message || 'Could not save the pilot name.');
      if (error?.code === '23505' || /duplicate|unique|profiles_username_key/i.test(message)) {
        pilotNameMessage('That pilot name is already taken. Choose a different one.', 'error');
      } else if (/function.*set_pilot_username|set_pilot_username.*not found|schema cache/i.test(message)) {
        pilotNameMessage('The database update is missing. Run the included supabase/set_pilot_username_patch.sql, then try again.', 'error');
      } else {
        pilotNameMessage(message, 'error');
      }
    } finally {
      els.pilotNameSaveBtn.disabled = false;
      els.pilotNameSaveBtn.innerHTML = 'Save pilot name <span>↗</span>';
    }
  }
  function openAuth(nextMode = 'signin') {
    setAuthMode(nextMode);
    if (!els.authDialog.open) els.authDialog.showModal();
    if (!supabase) { els.authBackendNote.textContent = 'Backend is not configured yet. Follow SUPABASE_SETUP.md; guest progress will not survive refresh.'; }
    window.setTimeout(() => (authMode === 'signup' ? els.authUsername : els.authEmail).focus(), 60);
  }
  async function handleAuthSubmit(event) {
    event.preventDefault(); clearAuthMessage();
    if (!supabase) { authMessage('Accounts are not configured yet. Complete the Supabase setup guide and fill in supabase-config.js, then redeploy.', 'error'); return; }
    const email = els.authEmail.value.trim(); const password = els.authPassword.value;
    if (authMode === 'signup') {
      const username = els.authUsername.value.trim().toLowerCase();
      if (!/^[a-z0-9_]{3,16}$/.test(username)) { authMessage('Pilot names must be 3–16 characters: letters, numbers or underscores.', 'error'); return; }
      accountActionBusy = true; els.authSubmitBtn.disabled = true; els.authSubmitBtn.textContent = 'Creating your account…';
      try {
        const { data, error } = await supabase.auth.signUp({ email, password, options: { data: { username } } });
        if (error) throw error;
        if (data.session) {
          authMessage('Account created. Your flight log is syncing now.', 'success');
          window.setTimeout(() => { if (els.authDialog.open) els.authDialog.close(); }, 1100);
        } else {
          setAuthMode('signin');
          authMessage('Check your email for the confirmation link. Once confirmed, sign in to sync your flights.', 'success');
        }
      } catch (error) { authMessage(readableAuthError(error), 'error'); }
      finally { accountActionBusy = false; els.authSubmitBtn.disabled = false; els.authSubmitBtn.innerHTML = authMode === 'signup' ? 'Create pilot account <span>↗</span>' : 'Sign in <span>↗</span>'; }
    } else {
      accountActionBusy = true; els.authSubmitBtn.disabled = true; els.authSubmitBtn.textContent = 'Signing in…';
      try {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        authMessage('Welcome back. Your flight log is syncing.', 'success');
        window.setTimeout(() => { if (els.authDialog.open) els.authDialog.close(); }, 750);
      } catch (error) { authMessage(readableAuthError(error), 'error'); }
      finally { accountActionBusy = false; els.authSubmitBtn.disabled = false; els.authSubmitBtn.innerHTML = authMode === 'signup' ? 'Create pilot account <span>↗</span>' : 'Sign in <span>↗</span>'; }
    }
  }
  function readableAuthError(error) {
    const msg = String(error?.message || 'Something went wrong.');
    if (/invalid login credentials/i.test(msg)) return 'That email and password combination was not recognised.';
    if (/user already registered/i.test(msg)) return 'An account already exists for that email. Try signing in.';
    if (/password/i.test(msg) && /weak|length/i.test(msg)) return 'Choose a stronger password of at least 8 characters.';
    if (/rate limit|too many requests/i.test(msg)) return 'Too many attempts. Wait a little before trying again.';
    if (/username/i.test(msg) && /duplicate|unique/i.test(msg)) return 'That pilot name is already taken. Try another one.';
    return msg;
  }
  async function accountButtonAction() {
    if (accountActionBusy) return;
    if (!authUser) { openAuth('signin'); return; }
    if (!supabase) return;
    if (!window.confirm('Sign out of the Flight Club? Cloud progress stays in Supabase. Guest progress is temporary.')) return;
    const { error } = await supabase.auth.signOut();
    if (error) showToast(`Could not sign out: ${error.message}`, 'error');
    else { showToast('Signed out. Guest progress is temporary; sign in again to load your cloud save.', 'success'); els.authDialog.close?.(); }
  }

  // UI wiring
  els.startBtn.addEventListener('click', () => { if (game.paused) resumeRun(); else startRun(); });
  els.restartBtn.addEventListener('click', () => startRun());
  els.canvas.addEventListener('pointerdown', event => { event.preventDefault(); flap(); });
  els.overlay.addEventListener('pointerdown', event => event.stopPropagation());
  els.area.addEventListener('keydown', event => {
    if (['Space', 'ArrowUp', 'KeyW'].includes(event.code)) { event.preventDefault(); if (!event.repeat) flap(); }
  });
  document.addEventListener('keydown', event => {
    const active = document.activeElement;
    const tag = active?.tagName;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || els.authDialog.open || els.pilotNameDialog.open || $('#achievementDialog')?.open || $('#codexDialog')?.open || $('#storeDialog')?.open) return;
    // Do not steal Space/Arrow keys from unrelated buttons and links. The active game
    // area and start/resume button are the intentional keyboard play surfaces.
    const canDriveGame = !active || active === document.body || active === document.documentElement || active === els.startBtn;
    if (canDriveGame && ['Space', 'ArrowUp', 'KeyW'].includes(event.code)) {
      event.preventDefault(); if (!event.repeat) flap();
    }
    if (event.code === 'KeyP' || event.code === 'Escape') { if (game.running) pauseRun(); else if (game.paused) resumeRun(); }
    if (mode === 'arcade' && ['KeyQ', 'KeyE', 'KeyR'].includes(event.code)) useAbility(({ KeyQ: 'shield', KeyE: 'slow', KeyR: 'heal' })[event.code]);
  });
  window.addEventListener('blur', () => { if (game.running) pauseRun(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && game.running) pauseRun(); });
  els.sound.addEventListener('click', () => {
    game.sound = !game.sound; els.sound.textContent = game.sound ? '♫' : '×';
    els.sound.setAttribute('aria-label', game.sound ? 'Turn sound off' : 'Turn sound on'); if (game.sound) tone(640, .07);
  });
  $$('.mode-option').forEach(button => button.addEventListener('click', () => {
    const next = button.dataset.mode; if (next === mode) return;
    if (game.running) { game.running = false; game.paused = false; game.over = false; }
    mode = next; game.mode = next; persistMode(); updateModeUI();
    els.gameState.textContent = next === 'arcade' ? 'ARCADE MODE SELECTED' : 'CLASSIC MODE SELECTED';
    els.summary.textContent = next === 'arcade' ? 'Normal at take-off. The sky will climb through five automatic difficulty tiers.' : 'Back to basics: one bump ends the run. The gates alone get faster.';
    showOverlay(next === 'arcade' ? 'THE SKY WILL TEST YOU' : 'BACK TO THE CLASSICS', next === 'arcade' ? 'Start at Normal.' : 'Pure flight.', next === 'arcade' ? 'Collect glowing relics, use your skills, and watch the gaps get stranger as your score rises.' : 'No health bar and no manual skills. Classic gates speed up as your score grows.', 'Start flying');
    updateDifficultyUI(); updateAbilityUI();
  }));
  $$('.ability-item').forEach(button => button.addEventListener('click', () => useAbility(button.dataset.ability)));
  $$('.leader-tab').forEach(button => button.addEventListener('click', () => {
    leaderView = button.dataset.leaderView; $$('.leader-tab').forEach(tab => tab.classList.toggle('active', tab === button)); updateLeaderboard();
  }));
  $('#refreshBoardBtn').addEventListener('click', updateLeaderboard);
  els.storeList?.addEventListener('click', event => { const button = event.target.closest('[data-upgrade]'); if (button && !button.disabled) buyUpgrade(button.dataset.upgrade); });
  $('#openStoreBtn')?.addEventListener('click', openStore);
  $('#storeEnterBtn')?.addEventListener('click', openStore);
  $('#closeStoreBtn')?.addEventListener('click', () => els.storeDialog.close());
  $('#storeFooterClose')?.addEventListener('click', () => els.storeDialog.close());
  els.storeDialog?.addEventListener('click', event => { if (event.target === els.storeDialog) els.storeDialog.close(); });
  $$('.store-tab').forEach(button => button.addEventListener('click', () => setStoreTab(button.dataset.storeTab)));
  els.storeCosmeticList?.addEventListener('click', event => { const button = event.target.closest('[data-store-code]'); if (button && !button.disabled) buyOrEquipCosmetic(button.dataset.storeCode); });
  $('#storeSearch')?.addEventListener('input', renderStoreCosmetics);
  $('#dismissAwardNotice')?.addEventListener('click', () => { const panel = $('#awardNoticePanel'); if (panel) panel.hidden = true; awardNoticeCount = 0; });
  $('#allAchievementsBtn')?.addEventListener('click', () => { renderAchievementBrowser(true); $('#achievementDialog').showModal(); });
  $('#closeAchievementDialog')?.addEventListener('click', () => $('#achievementDialog').close());
  $('#achievementDialog')?.addEventListener('click', event => { if (event.target === $('#achievementDialog')) $('#achievementDialog').close(); });
  $('#achievementSearch')?.addEventListener('input', () => renderAchievementBrowser(true));
  $('#achievementCategory')?.addEventListener('change', () => renderAchievementBrowser(true));
  $('#loadMoreAchievements')?.addEventListener('click', () => { achievementPage++; renderAchievementBrowser(false); });
  $('#openCodexBtn')?.addEventListener('click', () => { renderCodex(); $('#codexDialog').showModal(); });
  $('#closeCodexDialog')?.addEventListener('click', () => $('#codexDialog').close());
  $('#codexDialog')?.addEventListener('click', event => { if (event.target === $('#codexDialog')) $('#codexDialog').close(); });
  $('#codexSearch')?.addEventListener('input', renderCodex);
  $('#codexRarity')?.addEventListener('change', renderCodex);
  els.accountBtn.addEventListener('click', accountButtonAction);
  els.editPilotNameBtn.addEventListener('click', openPilotNameDialog);
  els.pilotNameForm.addEventListener('submit', handlePilotNameSubmit);
  $('#closePilotNameBtn').addEventListener('click', () => els.pilotNameDialog.close());
  els.pilotNameDialog.addEventListener('click', event => { if (event.target === els.pilotNameDialog) els.pilotNameDialog.close(); });
  els.profileAction.addEventListener('click', () => authUser ? accountButtonAction() : openAuth('signup'));
  $$('.auth-tab').forEach(button => button.addEventListener('click', () => setAuthMode(button.dataset.authMode)));
  $('#closeAuthBtn').addEventListener('click', () => els.authDialog.close());
  els.authDialog.addEventListener('click', event => { if (event.target === els.authDialog) els.authDialog.close(); });
  els.authForm.addEventListener('submit', handleAuthSubmit);

  // Initial state and animation.
  updateModeUI(); updateProfileUI(); updateLeaderboard(); renderAchievementBrowser(); renderCodex(); updateWorldLabel();
  showOverlay('WELCOME TO THE FLIGHT CLUB', 'Ready, little bird?', 'Tap to flap. Find the gap. Trust your wings.', 'Start flying');
  initBackend(); requestAnimationFrame(loop);
})();
