let _warnedMissingAllowedOrigin = false;
function buildCorsHeaders(event) {
  const allowed = process.env.ALLOWED_ORIGIN;
  const reqOrigin = (event && event.headers && (event.headers.origin || event.headers.Origin)) || "";
  const base = {
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (allowed) {
    if (reqOrigin && reqOrigin === allowed) {
      base["Access-Control-Allow-Origin"] = allowed;
      base["Vary"] = "Origin";
    }
    return base;
  }
  if (!_warnedMissingAllowedOrigin) {
    console.warn("search: ALLOWED_ORIGIN not set; falling back to '*' (dev only)");
    _warnedMissingAllowedOrigin = true;
  }
  base["Access-Control-Allow-Origin"] = "*";
  return base;
}

exports.handler = async function (event) {
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

  const headers = buildCorsHeaders(event);

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!RAPIDAPI_KEY || RAPIDAPI_KEY === "YOUR_KEY_HERE") {
    console.error("search: missing RAPIDAPI_KEY env var");
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Server missing RAPIDAPI_KEY env var" }) };
  }

  const params = event.queryStringParameters || {};
  const query = (params.query || "").trim().replace(/^#/, "").toLowerCase();

  if (!query) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Query is required" }) };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const url = `https://instagram-scraper-api2.p.rapidapi.com/v1/hashtag?hashtag=${encodeURIComponent(query)}&count=50`;
    const res = await fetch(url, {
      headers: {
        "x-rapidapi-host": "instagram-scraper-api2.p.rapidapi.com",
        "x-rapidapi-key": RAPIDAPI_KEY,
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`search: upstream ${res.status}: ${errText}`);
      return { statusCode: res.status, headers, body: JSON.stringify({ error: `Upstream API returned ${res.status}` }) };
    }

    const data = await res.json();
    const items = data?.data?.items || data?.items || [];
    const sevenDaysAgo = Date.now() / 1000 - 7 * 24 * 60 * 60;

    const reels = items
      .filter(item => (item.media_type === 2 || item.is_video === true) && item.taken_at >= sevenDaysAgo)
      .map(item => {
        const likes = item.like_count || 0;
        const comments = item.comment_count || 0;
        const views = item.view_count || item.video_view_count || item.play_count || 0;
        const shares = item.reshare_count || item.share_count || 0;
        const saves = item.save_count || item.saved_count || item.bookmark_count || 0;
        const engagementRate = views > 0 ? ((likes + comments + saves + shares) / views) * 100 : 0;
        const shortcode = item.code || item.shortcode || "";
        const captionText = item.caption?.text || "";
        const hashtags = (captionText.match(/#\w+/g) || []).slice(0, 10);
        return {
          url: `https://www.instagram.com/reel/${shortcode}/`,
          shortcode,
          thumbnail: item.thumbnail_url || item.display_url || item.image_versions?.items?.[0]?.url || null,
          caption: captionText.slice(0, 500),
          hashtags,
          likes, views, comments, shares, saves,
          engagementRate: parseFloat(engagementRate.toFixed(2)),
          durationSeconds: item.video_duration || item.duration || null,
          audioTitle: item.clips_metadata?.original_sound_info?.original_audio_title
            || item.clips_metadata?.music_info?.music_asset_info?.title
            || null,
          postedAt: item.taken_at,
          username: item.user?.username || item.owner?.username || "unknown",
          userFullName: item.user?.full_name || item.owner?.full_name || "",
          userVerified: !!(item.user?.is_verified || item.owner?.is_verified),
        };
      })
      .filter(r => r.views > 0)
      .sort((a, b) => b.engagementRate - a.engagementRate)
      .slice(0, 20);

    return { statusCode: 200, headers, body: JSON.stringify({ reels, query, total: reels.length }) };
  } catch (err) {
    console.error("search: error", err);
    const msg = err.name === "AbortError" ? "Upstream request timed out" : "Internal server error";
    return { statusCode: 500, headers, body: JSON.stringify({ error: msg }) };
  } finally {
    clearTimeout(timeout);
  }
};
