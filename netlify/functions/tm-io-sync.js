// netlify/functions/tm-io-sync.js

let cachedData = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 perces szerver gyorsítótár

const TRIO_PLAYERS = [
  { id: "11a8675e-a5ab-4b76-9c03-c3e96d39534b", name: "Martin", color: "#00ff88" },
  { id: "968c7f56-8c32-4f19-8116-d1ab10fafc59", name: "Patrik", color: "#00e5ff" },
  { id: "e0abfb46-0151-4816-b25c-a47846a17843", name: "Márk", color: "#ff3366" }
];

const USER_AGENT = "TrackmaniaTrioTelemetry/3.0 (contact: github.com/mrky1102/trackmania-app)";

async function fetchSafeJson(url, timeoutMs = 5000) {
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
    if (!res.ok) return null;
    return await res.json();
  } catch {
    clearTimeout(timer);
    return null;
  }
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  const forceRefresh = event.queryStringParameters?.force === "1";

  if (!forceRefresh && cachedData && (Date.now() - lastCacheTime < CACHE_TTL_MS)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...cachedData, cached: true })
    };
  }

  try {
    // 1. Profilok lekérése mindhárom fiókra
    const profileResults = await Promise.all(
      TRIO_PLAYERS.map(async (p) => {
        const data = await fetchSafeJson(`https://trackmania.io/api/player/${p.id}`);
        if (!data) {
          return {
            accountId: p.id,
            displayName: p.name,
            clubTag: null,
            color: p.color,
            trophies: { points: 0, echelon: 0, counts: [0,0,0,0,0,0,0,0,0], zones: [] },
            matchmaking: { ranked3v3: null, royal: null }
          };
        }

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
      })
    );

    // 2. COTD statisztikák lekérése
    const cotdResults = await Promise.all(
      TRIO_PLAYERS.map(async (p) => {
        const c = await fetchSafeJson(`https://trackmania.io/api/player/${p.id}/cotd/0`);
        if (!c) {
          return { accountId: p.id, totalPlayed: 0, totalWins: 0, totalDivWins: 0, recentCups: [] };
        }
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
      })
    );

    // COTD adatok összefűzése a profilokkal
    profileResults.forEach(p => {
      p.cotd = cotdResults.find(c => c.accountId === p.accountId) || null;
    });

    // 3. Hivatalos Kampány lekérése
    let campaignData = { name: "Official Campaign", tracks: [] };
    const campList = await fetchSafeJson("https://trackmania.io/api/campaigns/0");
    if (campList && Array.isArray(campList.campaigns) && campList.campaigns.length > 0) {
      const activeCamp = campList.campaigns[0];
      const campDetail = await fetchSafeJson(`https://trackmania.io/api/officialcampaign/${activeCamp.id}`);
      if (campDetail && Array.isArray(campDetail.playlist)) {
        campaignData = {
          name: campDetail.name || activeCamp.name || "Official Campaign",
          tracks: campDetail.playlist.map((m, idx) => ({
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
      }
    }

    const payload = {
      status: "ok",
      fetchedAt: new Date().toISOString(),
      players: profileResults,
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
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: "partial",
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