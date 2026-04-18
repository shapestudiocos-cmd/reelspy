const https = require("https");

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: "GET",
      headers,
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.end();
  });
}

exports.handler = async function (event) {
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!RAPIDAPI_KEY || RAPIDAPI_KEY === "YOUR_KEY_HERE") {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Server missing RAPIDAPI_KEY env var" }),
    };
  }

  const params = event.queryStringParameters || {};
  const query = (params.query || "").trim().replace(/^#/, "").toLowerCase();

  if (!query) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Query is required" }) };
  }

  try {
    const apiUrl = `https://instagram-scraper-api2.p.rapidapi.com/v1/hashtag?hashtag=${encodeURIComponent(query)}&count=50`;

    const response = await httpsGet(apiUrl, {
      "x-rapidapi-host": "instagram-scraper-api2.p.rapidapi.com",
      "x-rapidapi-key": RAPIDAPI_KEY,
      "Accept": "application/json",
    });

    if (response.status !== 200) {
      return {
        statusCode: response.status,
        headers,
        body: JSON.stringify({ error: `RapidAPI error ${response.status}: ${response.body}` }),
      };
    }

    let data;
    try {
      data = JSON.parse(response.body);
    } catch (e) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: "Failed to parse API response" }) };
    }

    const items = data?.data?.items || data?.items || [];
    const sevenDaysAgo = Date.now() / 1000 - 7 * 24 * 60 * 60;

    const reels = items
      .filter((item) => {
        const isVideo = item.media_type === 2 || item.is_video === true;
        const isRecent = !item.taken_at || item.taken_at >= sevenDaysAgo;
        return isVideo && isRecent;
      })
      .map((item) => {
        const likes = item.like_count || 0;
        const comments = item.comment_count || 0;
        const views = item.view_count || item.video_view_count || item.play_count || 1;
        const shares = item.reshare_count || item.share_count || 0;
        const engagementRate = ((likes + comments) / views) * 100;
        const shortcode = item.code || item.shortcode || "";
        return {
          url: `https://www.instagram.com/reel/${shortcode}/`,
          thumbnail:
            item.thumbnail_url ||
            item.display_url ||
            item.image_versions?.items?.[0]?.url ||
            null,
          caption: (item.caption?.text || item.caption_text || "").slice(0, 200),
          likes,
          views,
          comments,
          shares,
          engagementRate: parseFloat(engagementRate.toFixed(2)),
          postedAt: item.taken_at || null,
          username: item.user?.username || item.owner?.username || "unknown",
        };
      })
      .filter((r) => r.views > 0)
      .sort((a, b) => b.engagementRate - a.engagementRate)
      .slice(0, 20);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ reels, query, total: reels.length }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: "Function crashed: " + err.message }),
    };
  }
};
