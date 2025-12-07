// waveUpdater.js
// ---------------------------------------------------------
// PURPOSE:
//   - Called ONLY at midnight & noon (CST/CDT) by Netlify
//   - Fetch Stormglass hourly wave forecast
//   - Convert meters → feet
//   - Save entire dataset to GitHub: stormglass.json
// ---------------------------------------------------------

const fetch = require("node-fetch");
const { Octokit } = require("@octokit/rest");

const STORMGLASS_KEY = process.env.STORMGLASS_KEY;
const GITHUB_TOKEN   = process.env.GITHUB_TOKEN;
const GITHUB_REPO    = "nottbob/wave-proxy";
const GITHUB_BRANCH  = "main";

const STORMGLASS_URL =
  "https://api.stormglass.io/v2/weather/point?lat=26.071389&lng=-97.128722&params=waveHeight&source=sg";

exports.handler = async () => {
  try {
    // ------------------------------------------
    // 1. Fetch Stormglass data ONCE
    // ------------------------------------------
    const sgRes = await fetch(STORMGLASS_URL, {
      headers: { Authorization: STORMGLASS_KEY }
    });

    if (!sgRes.ok) throw new Error("Stormglass fetch failed");

    const json = await sgRes.json();
    if (!json.hours || !json.hours.length)
      throw new Error("Stormglass missing hours[]");

    // ------------------------------------------
    // 2. Convert waves to ft, build array
    // ------------------------------------------
    const waves = json.hours.map(h => {
      const m = h.waveHeight?.sg;
      const ft = m ? (m * 3.28084).toFixed(1) : null;
      return {
        time: h.time,     // KEEP ORIGINAL ISO 8601 STRING
        waveFt: ft
      };
    });

    // ------------------------------------------
    // 3. Build final JSON for GitHub
    // ------------------------------------------
    const payload = {
      timestamp: Date.now(),
      waves
    };

    const bodyStr = JSON.stringify(payload, null, 2);

    // ------------------------------------------
    // 4. Upload to GitHub
    // ------------------------------------------
    const octokit = new Octokit({ auth: GITHUB_TOKEN });

    // Load existing file to get its SHA
    const existing = await octokit.repos.getContent({
      owner: "nottbob",
      repo: "wave-proxy",
      path: "stormglass.json",
      ref: GITHUB_BRANCH
    });

    const sha = existing?.data?.sha;

    await octokit.repos.createOrUpdateFileContents({
      owner: "nottbob",
      repo: "wave-proxy",
      branch: GITHUB_BRANCH,
      path: "stormglass.json",
      sha,
      message: "Automated Stormglass wave update",
      content: Buffer.from(bodyStr).toString("base64")
    });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true })
    };

  } catch (err) {
    return {
      statusCode: 500,
      body: String(err)
    };
  }
};
