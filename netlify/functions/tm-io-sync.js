// netlify/functions/tm-io-sync.js

// Gyorsítótár (5 perc), hogy kíméljük a Trackmania.io szerverét
let cachedResponse = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Alapértelmezett 3 játékos Account ID (UUID) - felülírható Netlify Environment Variable-ökkel
// Példaként 3 valós formátumú Trackmania Account UUID van megadva:
const DEFAULT_PLAYERS = [
  {
    id: process.env.TM_PLAYER_1_ID || "26d9a7de-4067-4926-9d93-2fe622869fc7",
    color: "#00ff88"
  },
  {
    id: process.env.TM_PLAYER_2_ID || "d320a238-1f3a-4668-a770-7218b6204c59",
    color: "#00e5ff"
  },
  {
    id: process.env.TM_PLAYER_3_ID || "58c38c8e-9b7a-4e36-8a45-4c876e57b654",
    color: "#ff3366"
  }
];

const TMIO_BASE = "https://trackmania.io/api";
// A Trackmania.io megköveteli az értelmes User-Agent fejlécet!
const USER_AGENT = process.env.TMIO_USER_AGENT || "TMTrioTelemetryWebapp/2.0 (Discord: tm_trio_hun)";

async function fetchTmioJson(path) {
  const headers = {
    "User-Agent": USER_AGENT,
    "Accept": "application/json"
  };
  if (process.env.TMIO_API_KEY) {
    headers["Authorization"] = process.env.TMIO_API_KEY;
  }

  const res = await fetch(`${TMIO_BASE}${path}`, { headers });
  if (!res.ok) {
    throw new Error(`Trackmania.io API hiba (${res.status}) ezen az útvonalon: ${path}`);
  }
  return res.json();
}

// Opcionális Nadeo Core API lekérdezés a 25 pálya egyéni PB idejéhez (ha nem vagytok Top 100-ban)
async function fetchNadeoMapRecords(accountIds, mapIds) {
  const login = process.env.NADEO_SERVER_LOGIN;
  const pass = process.env.NADEO_SERVER_PASSWORD;
  if (!login || !pass || mapIds.length === 0) return {};

  try {
    const authString = Buffer.from(`${login}:${pass}`).toString("base64");
    const tokenRes = await fetch("https://prod.trackmania.core.nadeo.online/v2/authentication/token/basic", {
      method: "POST",
      headers: {
        "Authorization": `Basic ${authString}`,
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({ audience: "NadeoServices" })
    });

    if (!tokenRes.ok) return {};
    const { accessToken } = await tokenRes.json();

    const recordsByPlayerAndMap = {};
    const mapIdListStr = mapIds.join(",");

    // 2024 júliusa óta a Nadeo API egyszerre 1 accountId-t és több mapId-t fogad el
    for (const accId of accountIds) {
      const recUrl = `https://prod.trackmania.core.nadeo.online/v2/mapRecords/by-account/?accountIdList=${accId}&mapIdList=${mapIdListStr}`;
      const recRes = await fetch(recUrl, {
        headers: {
          "Authorization": `nadeo_v1 t=${accessToken}`,
          "User-Agent": USER_AGENT
        }
      });

      if (recRes.ok) {
        const list = await recRes.json();
        for (const item of list) {
          if (!recordsByPlayerAndMap[item.mapId]) recordsByPlayerAndMap[item.mapId] = {};
          recordsByPlayerAndMap[item.mapId][item.accountId] = {
            timeMs: item.recordScore?.time || null,
            timestamp: item.timestamp || null,
            url: item.url || null,
            medal: item.medal || null
          };
        }
      }
    }
    return recordsByPlayerAndMap;
  } catch (e) {
    console.warn("Nadeo mapRecords kiegészítő lekérdezés sikertelen:", e.message);
    return {};
  }
}

// Játékos teljes Trackmania.io adatlapjának lekérése (Profil + COTD + Trófeák)
async function fetchFullPlayerFromTmio(playerCfg) {
  const id = playerCfg.id.trim();

  const [profileRes, cotdRes, trophiesRes] = await Promise.allSettled([
    fetchTmioJson(`/player/${id}`),
    fetchTmioJson(`/player/${id}/cotd/0`),
    fetchTmioJson(`/player/${id}/trophies/0`)
  ]);

  if (profileRes.status !== "fulfilled") {
    throw new Error(`Nem sikerült lekérni a játékost (${id}): ${profileRes.reason?.message}`);
  }

  const p = profileRes.value;
  const cotd = cotdRes.status === "fulfilled" ? cotdRes.value : null;
  const trophyHistory = trophiesRes.status === "fulfilled" ? trophiesRes.value : null;

  // Földrajzi Zónák és Helyezések kicsomagolása (pl. Fejér -> Hungary -> Europe -> World)
  const zones = [];
  let currentZone = p.trophies?.zone;
  const positions = p.trophies?.zonepositions || [];
  let zIdx = 0;
  while (currentZone) {
    zones.push({
      name: currentZone.name,
      flag: currentZone.flag,
      position: positions[zIdx] ?? null
    });
    currentZone = currentZone.parent;
    zIdx++;
  }

  // Matchmaking (3v3 Ranked és Royal) kicsomagolása
  let mm3v3 = null;
  let mmRoyal = null;
  if (Array.isArray(p.matchmaking)) {
    for (const m of p.matchmaking) {
      const info = m.info || m;
      if (info.typeid === 2 || info.typename === "3v3") {
        mm3v3 = {
          progression: info.progression ?? 0,
          rank: info.rank ?? null,
          mvp: info.mvp ?? 0,
          divisionName: info.division?.rule || `Div ${info.division?.position ?? "-"}`,
          minPoints: info.division?.minpoints ?? 0,
          maxPoints: info.division?.maxpoints ?? 0
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
    accountId: p.accountid || id,
    displayName: p.displayname || "Ismeretlen Pilóta",
    clubTag: p.clubtag || null,
    firstSeen: p.timestamp || null,
    color: playerCfg.color,
    meta: {
      twitch: p.meta?.twitch || null,
      youtube: p.meta?.youtube || null,
      twitter: p.meta?.twitter || null,
      vanity: p.meta?.vanity || null,
      comment: p.meta?.comment || null
    },
    trophies: {
      points: p.trophies?.points || 0,
      echelon: p.trophies?.echelon || 0,
      counts: p.trophies?.counts || [0, 0, 0, 0, 0, 0, 0, 0, 0], // T1 - T9
      zones: zones, // [Régió, Ország, Kontinens, Világ]
      recentGains: (trophyHistory?.gains || []).slice(0, 6)
    },
    matchmaking: {
      ranked3v3: mm3v3,
      royal: mmRoyal
    },
    cotd: cotd
      ? {
          totalPlayed: cotd.total || 0,
          totalWins: cotd.stats?.totalwins || 0,
          totalDivWins: cotd.stats?.totaldivwins || 0,
          averageDiv: cotd.stats?.averagediv ? Number(cotd.stats.averagediv.toFixed(2)) : null,
          averageRankPct: cotd.stats?.averagerank ? Number((cotd.stats.averagerank * 100).toFixed(1)) : null,
          averageDivRankPct: cotd.stats?.averagedivrank ? Number((cotd.stats.averagedivrank * 100).toFixed(1)) : null,
          bestRank: cotd.stats?.bestprimary?.bestrank || null,
          bestDiv: cotd.stats?.bestprimary?.bestdiv || null,
          winStreak: cotd.stats?.winavestreak || 0,
          divWinStreak: cotd.stats?.divwinavestreak || 0,
          recentCups: (cotd.cotds || []).slice(0, 10).map(c => ({
            id: c.id,
            name: c.name,
            timestamp: c.timestamp,
            div: c.div,
            rank: c.rank,
            divRank: c.divrank,
            score: c.score,
            totalPlayers: c.totalplayers
          }))
        }
      : null
  };
}

// Hivatalos Szezonális Kampány és Pályák lekérése a Trackmania.io-ról
async function fetchCurrentOfficialCampaign(players, nadeoRecordsMap) {
  const campaignsList = await fetchTmioJson("/campaigns/0");
  const officialMeta = (campaignsList.campaigns || []).find(c => c.clubid === 0) || campaignsList.campaigns?.[0];

  if (!officialMeta) {
    throw new Error("Nem található aktív hivatalos kampány a Trackmania.io-n.");
  }

  let campaignDetail;
  try {
    campaignDetail = await fetchTmioJson(`/officialcampaign/${officialMeta.id}`);
  } catch {
    campaignDetail = await fetchTmioJson(`/campaign/official/${officialMeta.id}`);
  }

  const playlist = campaignDetail.playlist || [];
  const mapIds = playlist.map(m => m.mapId).filter(Boolean);

  // Ha van Nadeo kulcs, lekérjük a 3 játékos összes mapRecordját
  const nadeoRecords = await fetchNadeoMapRecords(
    players.map(p => p.accountId),
    mapIds
  );

  // Pályák feldolgozása + első 10 pálya Top Leaderboardjának lekérése a Trackmania.io-ról
  const tracks = await Promise.all(
    playlist.map(async (m, idx) => {
      let wrTime = null;
      let wrHolder = null;
      let tmioMapTops = [];

      // Lekérjük a pálya Trackmania.io ranglistáját (WR + ha a 3 barát benne van a topban)
      try {
        const lb = await fetchTmioJson(
          `/leaderboard/${campaignDetail.leaderboarduid}/${m.mapUid}?offset=0&length=100`
        );
        tmioMapTops = lb.tops || [];
        if (tmioMapTops.length > 0) {
          wrTime = tmioMapTops[0].time;
          wrHolder = tmioMapTops[0].player?.name || null;
        }
      } catch {
        // Ha a leaderboard végpont lassú, nem akasztjuk meg a teljes betöltést
      }

      const tierNames = ["White", "Green", "Blue", "Red", "Black"];
      const tier = tierNames[Math.floor(idx / 5)] || "Black";

      // A 3 barát időeredményeinek összerendelése az adott pályához
      const playerTimes = {};
      for (const pl of players) {
        // 1. Megnézzük, benne van-e a Trackmania.io leaderboardban
        const foundInLb = tmioMapTops.find(t => t.player?.id === pl.accountId);
        // 2. Megnézzük, megvan-e a Nadeo mapRecords lekérdezésben
        const foundInNadeo = nadeoRecords[m.mapId]?.[pl.accountId];

        if (foundInLb) {
          playerTimes[pl.accountId] = {
            timeMs: foundInLb.time,
            position: foundInLb.position,
            timestamp: foundInLb.timestamp,
            ghostUrl: foundInLb.ghost ? `https://trackmania.io${foundInLb.ghost}` : null,
            source: "TM.io Leaderboard"
          };
        } else if (foundInNadeo && foundInNadeo.timeMs) {
          playerTimes[pl.accountId] = {
            timeMs: foundInNadeo.timeMs,
            position: null,
            timestamp: foundInNadeo.timestamp,
            ghostUrl: foundInNadeo.url,
            source: "Nadeo MapRecords"
          };
        } else {
          playerTimes[pl.accountId] = null;
        }
      }

      return {
        index: idx + 1,
        mapId: m.mapId,
        mapUid: m.mapUid,
        rawName: m.name,
        cleanName: (m.name || "").replace(/\$[0-9a-fA-F]{1,3}|\$[iIoOwWnNmMgGzZ<>sStT]/g, "").trim(),
        authorName: m.authorplayer?.name || "Nadeo",
        authorScore: m.authorScore,
        goldScore: m.goldScore,
        silverScore: m.silverScore,
        bronzeScore: m.bronzeScore,
        thumbnailUrl: m.thumbnailUrl || null,
        exchangeId: m.exchangeid || null,
        tier,
        wrTime,
        wrHolder,
        playerTimes
      };
    })
  );

  return {
    id: campaignDetail.id,
    name: campaignDetail.name || officialMeta.name,
    leaderboardUid: campaignDetail.leaderboarduid,
    publishDate: campaignDetail.publishdate,
    tracks
  };
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  const queryParams = event.queryStringParameters || {};
  const forceRefresh = queryParams.force === "1";

  // Lehetőség van URL paraméterben is átadni a 3 Account ID-t (?p1=...&p2=...&p3=...)
  const requestedPlayers = [
    { id: queryParams.p1 || DEFAULT_PLAYERS[0].id, color: "#00ff88" },
    { id: queryParams.p2 || DEFAULT_PLAYERS[1].id, color: "#00e5ff" },
    { id: queryParams.p3 || DEFAULT_PLAYERS[2].id, color: "#ff3366" }
  ];

  const cacheKey = requestedPlayers.map(p => p.id).join("|");

  if (
    !forceRefresh &&
    cachedResponse &&
    cachedResponse.cacheKey === cacheKey &&
    Date.now() - cacheTimestamp < CACHE_TTL_MS
  ) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...cachedResponse.payload, cached: true })
    };
  }

  try {
    // 1. Mindhárom játékos összes Trackmania.io adatának lekérése
    const playersData = await Promise.all(
      requestedPlayers.map(cfg => fetchFullPlayerFromTmio(cfg))
    );

    // 2. Aktuális Hivatalos Kampány + Pályák + Idők lekérése
    const campaignData = await fetchCurrentOfficialCampaign(playersData);

    const payload = {
      status: "ok",
      fetchedAt: new Date().toISOString(),
      nadeoRecordsActive: Boolean(process.env.NADEO_SERVER_LOGIN && process.env.NADEO_SERVER_PASSWORD),
      players: playersData,
      campaign: campaignData
    };

    cachedResponse = { cacheKey, payload };
    cacheTimestamp = Date.now();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload)
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        status: "error",
        error: err.message,
        hint: "Ellenőrizd, hogy a 3 Trackmania.io Account UUID helyes-e!"
      })
    };
  }
};