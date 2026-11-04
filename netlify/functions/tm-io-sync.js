// netlify/functions/tm-io-sync.js

// 5 perces szerveroldali memória-gyorsítótár
let cachedData = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

const TRIO_PLAYERS = [
  { id: "11a8675e-a5ab-4b76-9c03-c3e96d39534b", name: "Martin", color: "#00ff88" },
  { id: "968c7f56-8c32-4f19-8116-d1ab10fafc59", name: "Patrik", color: "#00e5ff" },
  { id: "e0abfb46-0151-4816-b25c-a47846a17843", name: "Márk", color: "#ff3366" }
];

const USER_AGENT = "TM-Trio-Martin-Patrik-Mark/2.0 (contact: tm-trio-app)";

async function fetchWithTimeout(url, timeoutMs = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json"
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  const forceRefresh = event.queryStringParameters?.force === "1";

  // Ha a gyorsítótár még érvényes, azonnal visszaküldjük
  if (!forceRefresh && cachedData && (Date.now() - lastCacheTime < CACHE_TTL_MS)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...cachedData, cached: true })
    };
  }

  try {
    // 1. Profilok és Zóna Rangsorok lekérése párhuzamosan (3 kérés)
    const profilePromises = TRIO_PLAYERS.map(async (p) => {
      try {
        const data = await fetchWithTimeout(`https://trackmania.io/api/player/${p.id}`);
        
        // Zónák kibontása (Világ -> Európa -> Magyarország -> Megye)
        const zones = [];
        let curZone = data.trophies?.zone;
        const positions = data.trophies?.zonepositions || [];
        let zIdx = 0;
        while (curZone) {
          zones.push({
            name: curZone.name,
            flag: curZone.flag,
            position: positions[zIdx] ?? null
          });
          curZone = curZone.parent;
          zIdx++;
        }

        // 3v3 Ranked és Royal kibontása
        let mm3v3 = null;
        let mmRoyal = null;
        if (Array.isArray(data.matchmaking)) {
          for (const m of data.matchmaking) {
            const info = m.info || m;
            if (info.typeid === 2 || info.typename === "3v3") {
              mm3v3 = {
                progression: info.progression ?? 0,
                rank: info.rank ?? null,
                mvp: info.mvp ?? 0,
                divisionName: info.division?.rule || `Div ${info.division?.position ?? "-"}`
              };
            } else if (info.typeid === 3 || info.typename === "Royal") {
              mmRoyal = {
                progression: info.progression ?? 0,
                rank: info.rank ?? null,
                wins: info.mvp ?? info.wins ?? 0,
                divisionName: info.division?.rule || `Div ${info.division?.position ?? "-"}`
              };
            }
          }
        }

        return {
          accountId: p.id,
          displayName: data.displayname || p.name,
          clubTag: data.clubtag || null,
          firstSeen: data.timestamp || null,
          color: p.color,
          meta: {
            twitch: data.meta?.twitch || null,
            youtube: data.meta?.youtube || null
          },
          trophies: {
            points: data.trophies?.points || 0,
            echelon: data.trophies?.echelon || 0,
            counts: data.trophies?.counts || [0, 0, 0, 0, 0, 0, 0, 0, 0],
            zones: zones
          },
          matchmaking: {
            ranked3v3: mm3v3,
            royal: mmRoyal
          }
        };
      } catch (e) {
        // Ha egy profil lekérése nem sikerül, biztonsági adatokkal pótoljuk
        return {
          accountId: p.id,
          displayName: p.name,
          clubTag: null,
          color: p.color,
          trophies: { points: 0, echelon: 0, counts: [0,0,0,0,0,0,0,0,0], zones: [] },
          matchmaking: { ranked3v3: null, royal: null }
        };
      }
    });

    // 2. COTD statisztikák lekérése párhuzamosan (3 kérés)
    const cotdPromises = TRIO_PLAYERS.map(async (p) => {
      try {
        const c = await fetchWithTimeout(`https://trackmania.io/api/player/${p.id}/cotd/0`);
        return {
          accountId: p.id,
          totalPlayed: c.total || 0,
          totalWins: c.stats?.totalwins || 0,
          totalDivWins: c.stats?.totaldivwins || 0,
          averageDiv: c.stats?.averagediv ? Number(c.stats.averagediv.toFixed(2)) : null,
          averageRankPct: c.stats?.averagerank ? Number((c.stats.averagerank * 100).toFixed(1)) : null,
          bestRank: c.stats?.bestprimary?.bestrank || null,
          bestDiv: c.stats?.bestprimary?.bestdiv || null,
          recentCups: (c.cotds || []).slice(0, 10).map(cup => ({
            id: cup.id,
            name: cup.name,
            timestamp: cup.timestamp,
            div: cup.div,
            rank: cup.rank,
            divRank: cup.divrank,
            totalPlayers: cup.totalplayers
          }))
        };
      } catch {
        return { accountId: p.id, totalPlayed: 0, totalWins: 0, totalDivWins: 0, recentCups: [] };
      }
    });

    // 3. Aktuális Hivatalos Kampány és Pályák (1 kérés)
    let campaignData = null;
    try {
      const camp = await fetchWithTimeout("https://trackmania.io/api/campaign/official/0");
      campaignData = {
        name: camp.name || "Official Campaign",
        tracks: (camp.playlist || []).map((m, idx) => ({
          index: idx + 1,
          mapUid: m.mapUid,
          name: (m.name || `Pálya ${idx + 1}`).replace(/\$[0-9a-fA-F]{1,3}|\$[iIoOwWnNmMgGzZ<>sStT]/g, "").trim(),
          authorScore: m.authorScore,
          goldScore: m.goldScore,
          silverScore: m.silverScore,
          bronzeScore: m.bronzeScore,
          thumbnailUrl: m.thumbnailUrl || null,
          tier: idx < 5 ? "White" : idx < 10 ? "Green" : idx < 15 ? "Blue" : idx < 20 ? "Red" : "Black"
        }))
      };
    } catch {
      campaignData = { name: "Official Campaign", tracks: [] };
    }

    const [players, cotds] = await Promise.all([
      Promise.all(profilePromises),
      Promise.all(cotdPromises)
    ]);

    // COTD adatok hozzáfűzése a profilokhoz
    players.forEach(p => {
      p.cotd = cotds.find(c => c.accountId === p.accountId) || null;
    });

    const payload = {
      status: "ok",
      fetchedAt: new Date().toISOString(),
      players,
      campaign: campaignData
    };

    cachedData = payload;
    lastCacheTime = Date.now();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload)
    };

  } catch (err) {
    return {
      statusCode: 200, // 200-at adunk vissza JSON hibaüzenettel a HTML error elkerülésére
      headers,
      body: JSON.stringify({
        status: "error",
        error: err.message,
        players: TRIO_PLAYERS.map(p => ({
          accountId: p.id,
          displayName: p.name,
          color: p.color,
          trophies: { points: 0, echelon: 0, counts: [0,0,0,0,0,0,0,0,0], zones: [] }
        }))
      })
    };
  }
};