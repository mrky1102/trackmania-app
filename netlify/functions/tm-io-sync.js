// netlify/functions/tm-io-sync.js

let cachedPayload = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 3 * 60 * 1000; // 3 perces gyorsítótár

const TRIO_PLAYERS = [
  { id: "11a8675e-a5ab-4b76-9c03-c3e96d39534b", name: "Martin", color: "#00ff88" },
  { id: "968c7f56-8c32-4f19-8116-d1ab10fafc59", name: "Patrik", color: "#00e5ff" },
  { id: "e0abfb46-0151-4816-b25c-a47846a17843", name: "Márk", color: "#ff3366" }
];

const USER_AGENT = "TrackmaniaTrioTelemetry/4.0 (github.com/mrky1102/trackmania-app)";

async function fetchSafeJson(url, timeoutMs = 4500) {
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

function cleanTmName(raw) {
  if (!raw) return "";
  return raw.replace(/\$[0-9a-fA-F]{1,3}|\$[iIoOwWnNmMgGzZ<>sStT]/g, "").trim();
}

exports.handler = async function (event) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  const forceRefresh = event.queryStringParameters?.force === "1";

  if (!forceRefresh && cachedPayload && (Date.now() - lastCacheTime < CACHE_TTL_MS)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...cachedPayload, cached: true })
    };
  }

  try {
    // 1. Profilok, COTD és Trófea történet lekérése párhuzamosan a 3 játékosra
    const playersData = await Promise.all(
      TRIO_PLAYERS.map(async (p) => {
        const [profile, cotd, trophyHist] = await Promise.all([
          fetchSafeJson(`https://trackmania.io/api/player/${p.id}`),
          fetchSafeJson(`https://trackmania.io/api/player/${p.id}/cotd/0`),
          fetchSafeJson(`https://trackmania.io/api/player/${p.id}/trophies/0`)
        ]);

        // Földrajzi zónák kibontása
        const zones = [];
        let curZone = profile?.trophies?.zone;
        const positions = profile?.trophies?.zonepositions || [];
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
        if (Array.isArray(profile?.matchmaking)) {
          for (const m of profile.matchmaking) {
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
          displayName: profile?.displayname || p.name,
          customName: p.name,
          clubTag: cleanTmName(profile?.clubtag) || null,
          firstSeen: profile?.timestamp || null,
          color: p.color,
          meta: {
            twitch: profile?.meta?.twitch || null,
            youtube: profile?.meta?.youtube || null
          },
          trophies: {
            points: profile?.trophies?.points || 0,
            echelon: profile?.trophies?.echelon || 0,
            counts: profile?.trophies?.counts || [0, 0, 0, 0, 0, 0, 0, 0, 0],
            zones: zones,
            recentGains: (trophyHist?.gains || []).slice(0, 6).map(g => ({
              timestamp: g.timestamp,
              points: g.points,
              type: g.achievement?.type || "Reward"
            }))
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
                recentCups: (cotd.cotds || []).slice(0, 12).map(cup => ({
                  id: cup.id,
                  name: cup.name,
                  timestamp: cup.timestamp,
                  div: cup.div,
                  rank: cup.rank,
                  divRank: cup.divrank,
                  totalPlayers: cup.totalplayers
                }))
              }
            : null
        };
      })
    );

    // 2. Kampányok és Weekly Shorts lekérése a Trackmania.io-ról
    const [campList, weeklyList] = await Promise.all([
      fetchSafeJson("https://trackmania.io/api/campaigns/0"),
      fetchSafeJson("https://trackmania.io/api/weeklyshorts/0")
    ]);

    let campaignData = null;
    if (campList && Array.isArray(campList.campaigns) && campList.campaigns.length > 0) {
      const officialMeta = campList.campaigns.find(c => c.clubid === 0) || campList.campaigns[0];
      const campDetail = await fetchSafeJson(`https://trackmania.io/api/officialcampaign/${officialMeta.id}`);
      if (campDetail && Array.isArray(campDetail.playlist)) {
        campaignData = {
          id: campDetail.id,
          name: cleanTmName(campDetail.name || officialMeta.name),
          tracks: campDetail.playlist.map((m, idx) => ({
            index: idx + 1,
            mapUid: m.mapUid,
            name: cleanTmName(m.name || `Pálya ${idx + 1}`),
            authorName: m.authorplayer?.name || "Nadeo",
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

    // Weekly Challenges összeállítása (ha a TM.io weeklyshorts végpont elérhető)
    let weeklyChallenges = [];
    if (weeklyList && Array.isArray(weeklyList.campaigns) && weeklyList.campaigns.length > 0) {
      const topWeeks = weeklyList.campaigns.slice(0, 4);
      const weekDetails = await Promise.all(
        topWeeks.map(w => fetchSafeJson(`https://trackmania.io/api/weeklyshorts/${w.id}`))
      );
      weeklyChallenges = weekDetails.filter(Boolean).map((wd, wIdx) => ({
        id: wd.id || `w_${wIdx}`,
        name: cleanTmName(wd.name || `Weekly Shorts #${wIdx + 1}`),
        publishDate: wd.publishdate || null,
        tracks: (wd.playlist || []).map((m, idx) => ({
          index: idx + 1,
          mapUid: m.mapUid,
          name: cleanTmName(m.name || `Challenge #${idx + 1}`),
          authorName: m.authorplayer?.name || "Nadeo",
          authorScore: m.authorScore,
          goldScore: m.goldScore,
          silverScore: m.silverScore,
          bronzeScore: m.bronzeScore
        }))
      }));
    }

    const payload = {
      status: "ok",
      fetchedAt: new Date().toISOString(),
      players: playersData,
      campaign: campaignData,
      weeklyChallenges: weeklyChallenges.length > 0 ? weeklyChallenges : null
    };

    cachedPayload = payload;
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
        error: err.message
      })
    };
  }
};