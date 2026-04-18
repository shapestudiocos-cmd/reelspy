const https = require("https");

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: options.method || "GET",
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

exports.handler = async function (event) {
  const RAPIDAPI_KEY = process.env.RAPIDAPI_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  if (!RAPIDAPI_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing RAPIDAPI_KEY env var" }) };
  }
  if (!ANTHROPIC_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ANTHROPIC_API_KEY env var" }) };
  }

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch { body = {}; }

  const { reelUrl } = body;
  if (!reelUrl) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "reelUrl is required" }) };
  }

  const match = reelUrl.match(/(?:reel|p)\/([A-Za-z0-9_-]+)/);
  if (!match) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid Instagram reel URL" }) };
  }
  const shortcode = match[1];

  try {
    // Step 1: Fetch reel info from RapidAPI
    const reelRes = await httpsRequest(
      `https://instagram-scraper-api2.p.rapidapi.com/v1/post_info?code_or_id_or_url=${shortcode}`,
      {
        headers: {
          "x-rapidapi-host": "instagram-scraper-api2.p.rapidapi.com",
          "x-rapidapi-key": RAPIDAPI_KEY,
          Accept: "application/json",
        },
      }
    );

    let caption = "", username = "unknown", likes = 0, views = 0, comments = 0, hashtags = [];

    if (reelRes.status === 200) {
      try {
        const rd = JSON.parse(reelRes.body);
        const item = rd?.data || rd?.items?.[0] || rd;
        caption = item?.caption?.text || item?.caption_text || "";
        username = item?.user?.username || item?.owner?.username || "unknown";
        likes = item?.like_count || 0;
        views = item?.view_count || item?.video_view_count || 0;
        comments = item?.comment_count || 0;
        hashtags = (caption.match(/#\w+/g) || []).slice(0, 10);
      } catch (e) {}
    }

    // Step 2: Claude AI analysis
    const claudeBody = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{
        role: "user",
        content: `You are an Instagram content analyst. Analyze this reel and return ONLY a valid JSON object — no markdown, no explanation.

Reel info:
- Username: ${username}
- Caption: "${caption || "No caption"}"
- Hashtags: ${hashtags.join(", ") || "none"}
- Likes: ${likes}, Views: ${views}, Comments: ${comments}

Return exactly:
{
  "niche": "primary niche in 1-2 words",
  "contentType": "Tutorial / Review / Story / Comedy / Transformation / List / POV / etc",
  "tone": "Educational / Entertaining / Inspirational / Controversial / Emotional / etc",
  "hook": "describe the hook style in 1 sentence",
  "whyItWorks": "1-2 sentences on why this performs well",
  "relatedQueries": ["query1", "query2", "query3", "query4", "query5"],
  "suggestedNiches": ["niche1", "niche2", "niche3"]
}`,
      }],
    });

    const claudeRes = await httpsRequest(
      "https://api.anthropic.com/v1/messages",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(claudeBody),
        },
      },
      claudeBody
    );

    if (claudeRes.status !== 200) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: `Claude API error: ${claudeRes.body}` }) };
    }

    const claudeData = JSON.parse(claudeRes.body);
    const rawText = claudeData.content?.[0]?.text || "{}";

    let analysis;
    try {
      const clean = rawText.replace(/```json|```/g, "").trim();
      analysis = JSON.parse(clean);
    } catch {
      analysis = {
        niche: "general",
        contentType: "Unknown",
        tone: "Unknown",
        hook: "Could not parse",
        whyItWorks: "Analysis unavailable",
        relatedQueries: [username, "trending reels"],
        suggestedNiches: ["trending"],
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        reelData: { caption, username, likes, views, comments, hashtags },
        analysis,
        shortcode,
      }),
    };
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: "Function crashed: " + err.message }) };
  }
};
