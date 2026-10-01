// Production-shaped anonymized fixtures for Phase 9 (P9-2) migration testing.
// Represents realistic legacy KV and transitional D1 states across accounts,
// custom lists, likes, virtual channels, activity tracking, and install links.

export const TEST_TOKEN_KEY = "k1:" + Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => i + 11)).toString("base64");

export const MIGRATION_TMDB_FIXTURES = {
  finds: {
    tt0137523: { movie_results: [{ id: 550, title: "Fight Club", release_date: "1999-10-15", poster_path: "/fc.jpg" }], tv_results: [] },
    tt0068646: { movie_results: [{ id: 238, title: "The Godfather", release_date: "1972-03-14", poster_path: "/gf.jpg" }], tv_results: [] },
    tt0903747: { movie_results: [], tv_results: [{ id: 1396, name: "Breaking Bad", first_air_date: "2008-01-20", poster_path: "/bb.jpg" }] },
    tt0141842: { movie_results: [], tv_results: [{ id: 1399, name: "The Sopranos", first_air_date: "1999-01-10", poster_path: "/sopranos.jpg" }] },
    tt0944947: { movie_results: [], tv_results: [{ id: 1399, name: "Game of Thrones", first_air_date: "2011-04-17", poster_path: "/got.jpg" }] },
    tt9243946: { movie_results: [{ id: 559969, title: "El Camino: A Breaking Bad Movie", release_date: "2019-10-11", poster_path: "/elcamino.jpg" }], tv_results: [] },
    tt3032476: { movie_results: [], tv_results: [{ id: 60059, name: "Better Call Saul", first_air_date: "2015-02-08", poster_path: "/bcs.jpg" }] },
    tt0083658: { movie_results: [{ id: 78, title: "Blade Runner", release_date: "1982-06-25", poster_path: "/br.jpg" }], tv_results: [] },
    tt0062622: { movie_results: [{ id: 62, title: "2001: A Space Odyssey", release_date: "1968-04-10", poster_path: "/2001.jpg" }], tv_results: [] },
    tt0133093: { movie_results: [{ id: 603, title: "The Matrix", release_date: "1999-03-30", poster_path: "/matrix.jpg" }], tv_results: [] },
    tt0120737: { movie_results: [{ id: 120, title: "The Fellowship of the Ring", release_date: "2001-12-18", poster_path: "/lotr1.jpg" }], tv_results: [] },
    tt0386676: { movie_results: [], tv_results: [{ id: 2316, name: "The Office", first_air_date: "2005-03-24", poster_path: "/office.jpg" }] },
  },
  shows: {
    1396: { id: 1396, name: "Breaking Bad", external_ids: { imdb_id: "tt0903747" }, poster_path: "/bb.jpg" },
    1399: { id: 1399, name: "The Sopranos", external_ids: { imdb_id: "tt0141842" }, poster_path: "/sopranos.jpg" },
    60059: { id: 60059, name: "Better Call Saul", external_ids: { imdb_id: "tt3032476" }, poster_path: "/bcs.jpg" },
    2316: { id: 2316, name: "The Office", external_ids: { imdb_id: "tt0386676" }, poster_path: "/office.jpg" },
  },
  movies: {
    550: { id: 550, title: "Fight Club", external_ids: { imdb_id: "tt0137523" }, release_date: "1999-10-15", poster_path: "/fc.jpg" },
    238: { id: 238, title: "The Godfather", external_ids: { imdb_id: "tt0068646" }, release_date: "1972-03-14", poster_path: "/gf.jpg" },
    559969: { id: 559969, title: "El Camino: A Breaking Bad Movie", external_ids: { imdb_id: "tt9243946" }, release_date: "2019-10-11", poster_path: "/elcamino.jpg" },
    78: { id: 78, title: "Blade Runner", external_ids: { imdb_id: "tt0083658" }, release_date: "1982-06-25", poster_path: "/br.jpg" },
    62: { id: 62, title: "2001: A Space Odyssey", external_ids: { imdb_id: "tt0062622" }, release_date: "1968-04-10", poster_path: "/2001.jpg" },
    603: { id: 603, title: "The Matrix", external_ids: { imdb_id: "tt0133093" }, release_date: "1999-03-30", poster_path: "/matrix.jpg" },
    120: { id: 120, title: "The Fellowship of the Ring", external_ids: { imdb_id: "tt0120737" }, release_date: "2001-12-18", poster_path: "/lotr1.jpg" },
  },
};

export const MIGRATION_FIXTURES = {
  // 6 Accounts with diverse states and authentication formats
  accounts: [
    {
      username: "cinemabuff99",
      displayName: "Cinema Buff 🎥",
      key: "k_cinemabuff_secret_12345",
      keyHash: "pbkdf2:100000:0102030405060708090a0b0c0d0e0f10:7242558905a26c4a33bf115548b3a2ca119470eb1965b318b4f4c4e80c7ea456",
      recoveryAnswer: "rosebud",
      recoveryAnswerHash: "pbkdf2:100000:a1a2a3a4a5a6a7a8a9aaabacadaeafb0:a507c317817b1c9b9b6a211d059201c8712ef5e5a68463e99a5741b29e8cd790",
      createdAt: 1704067200000,
      lastActive: 1704100000000,
      inD1: true,
      inKV: true,
    },
    {
      username: "bingewatcher42",
      displayName: "Series Binger 🍿",
      key: "k_bingewatcher_secret_67890",
      keyHash: "pbkdf2:100000:1112131415161718191a1b1c1d1e1f20:00dee2d72d591babc3cf5892e6f8f232301645634ff5a90f3bfede8acd2b1589",
      recoveryAnswer: "winterfell",
      recoveryAnswerHash: "pbkdf2:100000:b1b2b3b4b5b6b7b8b9babbbcbdbebfc0:6a6465ba2c703f17251db8d1ecaef771bb1805febf88c758f3c6f5a50eae52f7",
      createdAt: 1705000000000,
      lastActive: 1705050000000,
      inD1: true,
      inKV: true,
    },
    {
      username: "retrocurator",
      displayName: "Retro Curator 📼",
      key: "k_retrocurator_secret_11223",
      keyHash: "pbkdf2:100000:5152535455565758595a5b5c5d5e5f60:74dd4371c6ffb5b335311f1cf40e65a97cf6fa4160f1f26d70d3a0df6e30d23b",
      recoveryAnswer: "rosebud",
      recoveryAnswerHash: "pbkdf2:100000:a1a2a3a4a5a6a7a8a9aaabacadaeafb0:a507c317817b1c9b9b6a211d059201c8712ef5e5a68463e99a5741b29e8cd790",
      createdAt: 1706000000000,
      lastActive: 1706020000000,
      inD1: true,
      inKV: false, // D1 only (e.g. KV expired)
    },
    {
      username: "animeotaku",
      displayName: "Anime Enthusiast ⚔️",
      key: "k_animeotaku_secret_33445",
      keyHash: "pbkdf2:100000:2122232425262728292a2b2c2d2e2f30:c8f2e2da7abb40d9ea2bf80a99a904c16abf02ea1df07998ecc827a3037c9329",
      recoveryAnswer: "konoha",
      recoveryAnswerHash: "pbkdf2:100000:c1c2c3c4c5c6c7c8c9cacbcccdcecfd0:b5bdb98ccf9ce9ace8447b3615fc36de9eebf0a548cd3056968ec633c0a496f6",
      createdAt: 1707000000000,
      lastActive: 1707040000000,
      inD1: false, // KV only (un-backfilled creator)
      inKV: true,
    },
    {
      username: "communitystar",
      displayName: "Community Star ⭐",
      key: "k_communitystar_secret_55667",
      keyHash: "pbkdf2:100000:3132333435363738393a3b3c3d3e3f40:5c69b4a32fa6d57895a181a51d334de966c02dabc7f5eebf630b686b84353597",
      recoveryAnswer: "rosebud",
      recoveryAnswerHash: "pbkdf2:100000:a1a2a3a4a5a6a7a8a9aaabacadaeafb0:a507c317817b1c9b9b6a211d059201c8712ef5e5a68463e99a5741b29e8cd790",
      createdAt: 1708000000000,
      lastActive: 1708080000000,
      inD1: true,
      inKV: true,
    },
    {
      username: "deleteduser88",
      displayName: "Deleted User",
      key: "k_deleteduser_secret_99887",
      keyHash: "pbkdf2:100000:4142434445464748494a4b4c4d4e4f50:b5280585097c44b2a2b3cccb00a6f7087ba7c0febd074041ae3807279c588394",
      createdAt: 1700000000000,
      deletedAt: 1709000000000,
      isTombstone: true,
    },
  ],

  // 8 Custom & Anonymous Lists
  lists: [
    {
      username: "cinemabuff99",
      slug: "top-noir-classics",
      name: "Top Noir Classics",
      type: "movie",
      visibility: "public",
      items: [
        { id: "tt0137523", type: "movie", name: "Fight Club", year: "1999", poster: "https://image.tmdb.org/t/p/w500/fc.jpg" },
        { id: "tmdb:550", type: "movie", name: "Fight Club (duplicate)" },
        { id: "tt0068646", type: "movie", name: "The Godfather", year: "1972" },
        { id: "tt9999999", type: "movie", name: "Lost 1930s Film (stub)", year: "1931" },
        { name: "Unnamed Mystery Movie without ID", type: "movie" }, // unresolved item
      ],
      createdAt: 1704100000000,
      updatedAt: 1704100000000,
      likes: 12,
    },
    {
      username: "bingewatcher42",
      slug: "crossover-chronology",
      name: "Breaking Universe Chronology",
      type: "series",
      visibility: "private",
      items: [
        { id: "62085", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Pilot", seasonNum: 1, episodeNum: 1 },
        { id: "62086", type: "episode", showId: "1396", showTitle: "Breaking Bad", name: "Cat's in the Bag...", seasonNum: 1, episodeNum: 2 },
        { id: "tt9243946", type: "movie", name: "El Camino: A Breaking Bad Movie", isCompanion: true, companionType: "bridge_movie", companionNote: "Watch immediately after S5 finale" },
        { id: "tt3032476", type: "series", name: "Better Call Saul", year: "2015" },
      ],
      createdAt: 1705100000000,
      updatedAt: 1705100000000,
      likes: 0,
    },
    {
      username: "cinemabuff99",
      slug: "sci-fi-vault",
      name: "Sci-Fi Masterpieces Vault",
      type: "movie",
      visibility: "public",
      // Large list (42 items) to test chunking across multiple backfill inserts
      items: [
        { id: "tt0083658", type: "movie", name: "Blade Runner", year: "1982" },
        { id: "tt0062622", type: "movie", name: "2001: A Space Odyssey", year: "1968" },
        { id: "tt0133093", type: "movie", name: "The Matrix", year: "1999" },
        ...Array.from({ length: 39 }, (_, i) => ({
          id: `tt00${80000 + i}`,
          type: "movie",
          name: `Sci-Fi Archive Reel #${i + 1}`,
          year: String(1970 + (i % 50)),
        })),
      ],
      createdAt: 1704200000000,
      updatedAt: 1704200000000,
      likes: 5,
    },
    {
      username: "bingewatcher42",
      slug: "synced-dramas",
      name: "Synced Indie Dramas",
      type: "series",
      visibility: "private",
      sourceUrl: "https://mdblist.com/lists/curator/prestige-indie-dramas",
      synced: true,
      lastSyncedAt: 1705200000000,
      baseItemIds: ["tt0903747", "tt0141842"],
      items: [
        { id: "tt0903747", type: "series", name: "Breaking Bad" },
        { id: "tt0141842", type: "series", name: "The Sopranos" },
      ],
      createdAt: 1705150000000,
      updatedAt: 1705150000000,
      likes: 1,
    },
    {
      username: "communitystar",
      slug: "weekend-specials",
      name: "Weekend Specials (D1 baseline)",
      type: "mixed",
      visibility: "public",
      d1Items: [
        { id: "tt0137523", type: "movie", name: "Fight Club" },
      ],
      // Fresher KV version: tests conflict resolution where KV is newer than D1
      kvItems: [
        { id: "tt0137523", type: "movie", name: "Fight Club" },
        { id: "tt0068646", type: "movie", name: "The Godfather" },
        { id: "tt0903747", type: "series", name: "Breaking Bad" },
      ],
      createdAt: 1708100000000,
      d1UpdatedAt: 1708100000000,
      kvUpdatedAt: 1708107200000, // 2 hours fresher
      likes: 20,
    },
    {
      username: "animeotaku",
      slug: "shonen-hits",
      name: "Shonen Powerhouses",
      type: "series",
      visibility: "public",
      inD1: false, // KV only (un-backfilled creator has list in KV only)
      items: [
        { id: "tt0903747", type: "series", name: "Placeholder Anime 1" },
        { id: "tt0141842", type: "series", name: "Placeholder Anime 2" },
      ],
      createdAt: 1707100000000,
      updatedAt: 1707100000000,
      likes: 4,
    },
    {
      username: "bingewatcher42",
      slug: "watchlist",
      name: "Watchlist",
      type: "mixed",
      visibility: "private",
      items: [
        { id: "tt0068646", type: "movie", name: "The Godfather" },
      ],
      createdAt: 1705100000000,
      updatedAt: 1705100000000,
      likes: 0,
    },
    {
      // Anonymous published list
      isAnonymous: true,
      slug: "cult-classics-1980s",
      name: "Cult Classics of the 1980s",
      type: "movie",
      items: [
        { id: "tt0083658", type: "movie", name: "Blade Runner", year: "1982" },
        { id: "tt0062622", type: "movie", name: "2001: A Space Odyssey", year: "1968" },
      ],
      likes: 7,
      publishedAt: 1703000000000,
    },
  ],

  // Channels
  channels: [
    {
      code: "ch_nightshift",
      username: "communitystar",
      name: "Night Shift TV",
      description: "Night Shift 24/7 Schedule",
      dailyRotate: true,
      rotateShows: 2,
      rotateEpisodes: 2,
      storyLocked: ["tt0903747"],
      public: true,
      shows: [
        { id: "tt0903747", name: "Breaking Bad" },
        { id: "tt0141842", name: "The Sopranos" },
      ],
      likes: 8,
      adds: 15,
    },
    {
      code: "ch_cine_mix",
      username: "cinemabuff99",
      name: "Cinema & Episodes Shuffled",
      description: "Curated mix with paired episode arcs",
      shuffle: true,
      pairParts: true,
      pairedGroups: [["tt0903747:1:1", "tt0903747:1:2"]],
      public: true,
      shows: [{ id: "tt0903747", name: "Breaking Bad" }],
      extraItems: [
        { kind: "movie", imdbId: "tt0137523", title: "Fight Club", released: "1999-10-15", runtime: 139 },
      ],
      likes: 3,
      adds: 7,
    },
    {
      code: "ch_classic_timeline",
      username: "retrocurator",
      name: "Classic Timeline",
      description: "Chronological release sequence",
      sortByAired: true,
      autoSort: "interleave",
      public: false,
      shows: [
        { id: "tt0141842", name: "The Sopranos" },
      ],
      likes: 1,
      adds: 2,
    },
  ],

  // Activity tracking for bingewatcher42
  activity: {
    username: "bingewatcher42",
    t0: 1768078800000, // Fixed baseline time
    kvTracking: {
      watchHistory: [
        { id: "e1", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 1, watchedAt: 1768078800000 },
        { id: "e2", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 2, watchedAt: 1768078800000 + 3600000 },
        // Twin scrobble within 4 minutes -> deduplicates to single play
        { id: "tt0903747:1:2", type: "episode", showId: "tt0903747", seasonNum: 1, episodeNum: 2, watchedAt: 1768078800000 + 3600000 + 240000 },
        { id: "tt0137523", type: "movie", name: "Fight Club", watchedAt: 1768078800000 + 7200000 },
        // Episode without showTitle: extracted from composite ID
        { id: "tt0944947:2:3", type: "episode", name: "Game of Thrones S2E3", watchedAt: 1768078800000 + 10800000 },
        // Ghost items without identifiers: safely dropped
        { name: "Ghost Item 1", type: "movie", watchedAt: 1768078800000 },
        { name: "Ghost Item 2", type: "movie", watchedAt: 1768078800000 },
      ],
      continueWatching: [
        { id: "e3", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 3 },
        { id: "tt0120737", type: "movie", kind: "movie", name: "The Fellowship of the Ring", isCompanion: true, companionType: "sequel_movie", companionNote: "Continue Middle-Earth saga" },
      ],
      fullyWatchedShowIds: ["tt0944947"],
      dismissedContinueWatching: { "tt0903747": { seasonNum: 1, episodeNum: 2 } },
      removedAiringNext: { "tt0944947": { seasonNum: 2, episodeNum: 3 } },
      watchlist: [{ id: "tt0068646", type: "movie", name: "The Godfather" }],
    },
    d1History: [
      // Older movie play in D1 not in KV
      { id: "tt0068646", type: "movie", title: "The Godfather", watchedAt: 1768078800000 - 86400000 },
      // Duplicate of e1 in D1: union test
      { id: "e1", type: "episode", showId: "tt0903747", seasonNum: 1, episodeNum: 1, watchedAt: 1768078800000 },
    ],
    d1ShowStates: [
      { showId: "tmdb:1399", isFullyWatched: 0, dismissedSeason: 1, dismissedEpisode: 5, updatedAt: 1768078800000 },
    ],
    scrobbleQueue: [
      // Enqueued scrobble pending sync
      { id: "e4", type: "episode", showId: "tt0903747", showTitle: "Breaking Bad", seasonNum: 1, episodeNum: 4, watchedAt: 1768078800000 + 14400000 },
    ],
  },

  // Legacy Install configurations (IDs must be <= SHORT_ID_LENGTH which is 12)
  installs: [
    {
      id: "inst_full_01",
      record: {
        tmdbKey: "TEST_USER_TMDB_KEY_99",
        mdblistKey: "TEST_USER_MDB_KEY_88",
        traktKey: "TEST_USER_TRAKT_KEY_77",
        traktAccessToken: "TRAKT_BEARER_TOKEN_VAL_1",
        simklAccessToken: "SIMKL_BEARER_TOKEN_VAL_2",
        region: "US",
        entries: [
          { id: "row1", name: "Popular Movies", type: "movie", url: "https://mdblist.com/lists/curator/popular" },
          { id: "row2", name: "Top Series", type: "series", url: "https://trakt.tv/users/someone/lists/top-shows" },
        ],
      },
    },
    {
      id: "inst_shelf02",
      record: {
        trackCreatorKey: "k_bingewatcher_secret_67890",
        region: "GB",
        entries: [
          { id: "cw", name: "Continue Watching", type: "series", url: "special:continue-watching" },
        ],
      },
    },
    {
      id: "inst_anon_03",
      record: {
        region: "CA",
        entries: [
          { id: "p1", name: "Public Noir", type: "movie", url: "https://example.test/lists/cinemabuff99/top-noir-classics" },
        ],
      },
    },
  ],
};

function buildChannelItems(shows) {
  const items = [];
  shows.forEach((show, s) => {
    for (let season = 1; season <= 2; season++) {
      for (let ep = 1; ep <= 4; ep++) {
        items.push({
          kind: "episode",
          imdbId: show.id,
          season,
          episode: ep,
          showName: show.name,
          epName: `${show.name} ${season}x${ep}`,
          released: `20${10 + s}-0${season}-${String(ep * 3).padStart(2, "0")}`,
          runtime: 30 + s,
          thumbnail: `https://img.example.com/${show.id}/${season}/${ep}.jpg`,
        });
      }
    }
  });
  return items;
}

/**
 * Seeds all legacy production-shaped fixtures into the test environment.
 * Sets up D1 legacy tables and KV storage before backfill runs.
 */
export async function seedLegacyProductionFixtures(env) {
  const db = env.DB._db;
  const kv = env.CONFIGS._store;

  // 1. Seed Accounts (Creators)
  for (const acc of MIGRATION_FIXTURES.accounts) {
    if (acc.isTombstone) {
      kv.set(`creatordeleted:${acc.username}`, String(acc.deletedAt));
      try {
        db.prepare(
          "INSERT OR REPLACE INTO creator_tombstones (username, until, created_at) VALUES (?, ?, ?)"
        ).run(acc.username, acc.deletedAt + 86400000 * 30, acc.deletedAt);
      } catch {}
      continue;
    }

    if (acc.inD1) {
      db.prepare(`
        INSERT OR REPLACE INTO creators (username, display_name, key_hash, recovery_answer_hash, created_at, last_active)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(acc.username, acc.displayName, acc.keyHash, acc.recoveryAnswerHash, acc.createdAt, acc.lastActive);
    }

    if (acc.inKV) {
      kv.set(`creator:${acc.username}`, JSON.stringify({
        username: acc.username,
        displayName: acc.displayName,
        keyHash: acc.keyHash,
        recoveryAnswerHash: acc.recoveryAnswerHash,
        createdAt: acc.createdAt,
        lastActive: acc.lastActive,
        shareJson: null,
        listsStamp: null,
      }));
    }
  }

  // 2. Seed Custom Lists
  const accountOrders = new Map();
  for (const l of MIGRATION_FIXTURES.lists) {
    if (l.isAnonymous) {
      kv.set(`publishedlist:user:${l.slug}`, JSON.stringify({
        name: l.name,
        type: l.type,
        items: l.items,
        visibility: "public",
        likes: l.likes,
        publishedAt: l.publishedAt,
      }));
      try {
        db.prepare(`
          INSERT OR REPLACE INTO published_lists (id, name, type, items_json, likes, published_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(`user:${l.slug}`, l.name, l.type, JSON.stringify(l.items), l.likes, l.publishedAt);
      } catch {}
      continue;
    }

    const listId = `${l.username}:${l.slug}`;
    const d1Items = l.d1Items || l.items;
    const kvItems = l.kvItems || l.items;

    // D1 row (only if user/list is in D1)
    if (l.inD1 !== false) {
      db.prepare(`
        INSERT OR REPLACE INTO creator_lists (id, username, name, type, visibility, items_json, created_at, updated_at, likes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(listId, l.username, l.name, l.type, l.visibility, JSON.stringify(d1Items), l.createdAt, l.d1UpdatedAt || l.updatedAt, l.likes);
    }

    // KV record
    kv.set(`creatorlist:${l.username}:${l.slug}`, JSON.stringify({
      name: l.kvItems ? `${l.name} (KV Updated)` : l.name,
      type: l.type,
      visibility: l.visibility,
      items: kvItems,
      sourceUrl: l.sourceUrl || null,
      synced: !!l.synced,
      lastSyncedAt: l.lastSyncedAt || null,
      baseItemIds: l.baseItemIds || null,
      createdAt: l.createdAt,
      updatedAt: l.kvUpdatedAt || l.updatedAt,
      likes: l.likes,
    }));

    if (!accountOrders.has(l.username)) accountOrders.set(l.username, []);
    accountOrders.get(l.username).push(l.slug);
  }

  // Set legacy list orders
  for (const [user, slugs] of accountOrders.entries()) {
    kv.set(`creatorlistorder:${user}`, JSON.stringify({ order: slugs }));
  }

  // 3. Seed Likes
  const topListId = "cinemabuff99:top-noir-classics";
  const weekendListId = "communitystar:weekend-specials";
  try {
    db.prepare("INSERT OR IGNORE INTO list_likes (list_id, username, created_at) VALUES (?, ?, ?)")
      .run(topListId, "bingewatcher42", 1704200000000);
    db.prepare("INSERT OR IGNORE INTO list_likes (list_id, username, created_at) VALUES (?, ?, ?)")
      .run(weekendListId, "cinemabuff99", 1708200000000);
  } catch {}

  kv.set(`listlikevoters:cinemabuff99:top-noir-classics`, JSON.stringify([
    "u:bingewatcher42",
    "u:communitystar",
    "u:ghost_user_99", // deleted account
    "a:deadbeef1234",  // anonymous voter
  ]));
  kv.set(`listlikevoters:communitystar:weekend-specials`, JSON.stringify([
    "u:cinemabuff99",
    "a:cafebabe5678",
  ]));
  kv.set(`listlikevoters:user:cult-classics-1980s`, JSON.stringify([
    "a:anon_cult_fan_1",
    "a:anon_cult_fan_2",
  ]));

  // External list likes
  const extUrl = "https://mdblist.com/lists/curator/top-picks";
  kv.set(`externallike:${extUrl}`, JSON.stringify({ count: 3 }));
  kv.set(`extlikevoters:${extUrl}`, JSON.stringify(["u:cinemabuff99", "a:ext_fan"]));

  // 4. Seed Channels
  const exploreEntries = [];
  for (const ch of MIGRATION_FIXTURES.channels) {
    const items = [...buildChannelItems(ch.shows), ...(ch.extraItems || [])];
    const payload = {
      name: ch.name,
      description: ch.description,
      dailyRotate: !!ch.dailyRotate,
      rotateShows: ch.rotateShows || 0,
      rotateEpisodes: ch.rotateEpisodes || 0,
      storyLocked: ch.storyLocked || [],
      shuffle: !!ch.shuffle,
      pairParts: !!ch.pairParts,
      pairedGroups: ch.pairedGroups || [],
      sortByAired: !!ch.sortByAired,
      autoSort: ch.autoSort || null,
      items,
    };

    kv.set(`channelshare:${ch.code}`, JSON.stringify({
      code: ch.code,
      name: ch.name,
      channel: payload,
      creatorName: ch.username,
      owner: ch.username,
      published: !!ch.public,
      likes: ch.likes || 0,
      adds: ch.adds || 0,
      createdAt: 1707000000000,
    }));

    if (ch.likes) {
      kv.set(`channel:likes:${ch.code}`, String(ch.likes));
      kv.set(`channellikevoters:${ch.code}`, JSON.stringify(["u:cinemabuff99", "a:anon_ch_fan"]));
    }
    if (ch.adds) {
      kv.set(`channel:added:${ch.code}`, String(ch.adds));
      kv.set(`channeladdvoters:${ch.code}`, JSON.stringify(["u:cinemabuff99"]));
    }

    if (ch.public) {
      exploreEntries.push({
        code: ch.code,
        name: ch.name,
        description: ch.description,
        creatorName: ch.username,
        owner: ch.username,
        itemCount: items.length,
        likes: ch.likes || 0,
        adds: ch.adds || 0,
        publishedAt: 1707000000000,
      });
    }
  }
  kv.set("index:publicchannels", JSON.stringify({ entries: exploreEntries }));
  kv.set("index:explorechannels", JSON.stringify({ entries: exploreEntries }));

  // 5. Seed Activity Tracking (bingewatcher42)
  const act = MIGRATION_FIXTURES.activity;
  kv.set(`creatorsynctracking:${act.username}`, JSON.stringify({
    updatedAt: act.t0 + 18000000,
    ...act.kvTracking,
  }));
  kv.set(`creatorscrobblequeue:${act.username}`, JSON.stringify({
    watchHistory: act.scrobbleQueue,
    continueWatching: [],
  }));

  try {
    db.prepare("INSERT OR REPLACE INTO creator_tracking_meta (username, updated_at) VALUES (?, ?)")
      .run(act.username, act.t0 + 3600000);
    for (const item of act.d1History) {
      db.prepare(`
        INSERT OR REPLACE INTO watch_history (username, item_id, item_type, title, show_id, season_num, episode_num, watched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(act.username, item.id, item.type, item.title || null, item.showId || null, item.seasonNum || null, item.episodeNum || null, item.watchedAt);
    }
    for (const ss of act.d1ShowStates) {
      db.prepare(`
        INSERT OR REPLACE INTO creator_show_states (username, show_id, is_fully_watched, dismissed_season, dismissed_episode, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(act.username, ss.showId, ss.isFullyWatched, ss.dismissedSeason, ss.dismissedEpisode, ss.updatedAt);
    }
  } catch {}

  // 6. Seed Legacy Installs
  for (const inst of MIGRATION_FIXTURES.installs) {
    kv.set(`cfg:${inst.id}`, JSON.stringify(inst.record));
  }
}

/**
 * Takes a stable snapshot of legacy KV keys and legacy D1 tables to verify
 * that backfill routines only copy and leave legacy data untouched.
 */
export function snapshotLegacyStores(env) {
  const kvEntries = [...env.CONFIGS._store.entries()]
    .filter(([k]) => !k.startsWith("snap:") && !k.startsWith("token:") && !k.startsWith("lease:"))
    .sort(([a], [b]) => a.localeCompare(b));

  const tables = {};
  const db = env.DB._db;
  for (const t of [
    "creators",
    "creator_lists",
    "published_lists",
    "list_likes",
    "creator_tombstones",
    "watch_history",
    "creator_show_states",
    "creator_tracking_meta",
  ]) {
    try {
      tables[t] = db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all();
    } catch {
      tables[t] = null;
    }
  }

  return JSON.stringify({ kv: kvEntries, tables });
}
