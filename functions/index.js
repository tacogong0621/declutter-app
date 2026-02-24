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
