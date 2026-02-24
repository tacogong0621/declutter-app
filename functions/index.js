const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

exports.generateEncouragement = onRequest(
  { cors: true, secrets: [anthropicApiKey] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { itemName, category, points, totalScore, streak, categoryCount } =
      req.body;

    if (!itemName || !category) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const prompt = `User decluttered "${itemName}" (${category}) in a minimalism challenge.

Current status:
- Points earned: ${points}
- Total points: ${totalScore}
- Streak: ${streak} days
- Category stats: ${JSON.stringify(categoryCount)}

Write a short, warm encouragement message in ONE sentence. Include 1-2 emojis.
Style: Friendly and encouraging tone, specific praise, occasional suggestions.
Example styles:
- "Furniture takes real commitment - amazing work! 👏"
- "You're really good at the ${category} category! Minimalist vibes 👍"
- "Streak day ${streak} achieved! Keep going! 🔥"
Don't copy examples - be creative.`;

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 150,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Anthropic API error:", response.status, errorText);
        res.status(502).json({ error: "AI service unavailable" });
        return;
      }

      const data = await response.json();
      res.json({ message: data.content[0].text.trim() });
    } catch (error) {
      console.error("Error calling Anthropic API:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);
const functions = require('firebase-functions');
const fetch = require('node-fetch');

/**
 * Firebase Cloud Function to generate Tidy AI Coach comments.
 * Proxies requests to the Anthropic API so the API key stays server-side.
 *
 * Set the API key with:
 *   firebase functions:config:set anthropic.key="sk-ant-xxxxx"
 */
exports.generateTidyComment = functions.https.onCall(async (data, context) => {
  const apiKey = functions.config().anthropic?.key;
  if (!apiKey) {
    throw new functions.https.HttpsError('failed-precondition', 'Anthropic API key not configured');
  }

  const { prompt } = data;
  if (!prompt || typeof prompt !== 'string') {
    throw new functions.https.HttpsError('invalid-argument', 'prompt is required');
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      throw new functions.https.HttpsError('internal', 'Anthropic API request failed');
    }

    const result = await response.json();
    return { text: result.content[0].text.trim() };
  } catch (error) {
    if (error instanceof functions.https.HttpsError) throw error;
    console.error('generateTidyComment error:', error);
    throw new functions.https.HttpsError('internal', 'Failed to generate comment');
  }
});
