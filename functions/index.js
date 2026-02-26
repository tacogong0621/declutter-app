const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { initializeApp } = require("firebase-admin/app");

initializeApp();
const firestoreDb = getFirestore();

// Detect image media type from base64 string (magic bytes)
function getMediaType(base64String) {
  if (base64String.startsWith("data:")) {
    const match = base64String.match(/^data:(image\/\w+);base64,/);
    if (match) return match[1];
    base64String = base64String.split(",")[1];
  }
  if (base64String.startsWith("/9j/")) return "image/jpeg";
  if (base64String.startsWith("iVBOR")) return "image/png";
  if (base64String.startsWith("R0lGOD")) return "image/gif";
  if (base64String.startsWith("UklGR")) return "image/webp";
  return "image/jpeg";
}

// Strip data URL prefix if present, returning raw base64
function stripDataUrlPrefix(base64String) {
  return base64String.includes(",") ? base64String.split(",")[1] : base64String;
}

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");
const openaiApiKey = defineSecret("OPENAI_API_KEY");

const ALLOWED_ORIGINS = [
  "https://tacogong0621.github.io",
  "http://localhost:5000",
  "http://localhost:3000",
];

/**
 * generateEncouragement — HTTP endpoint called via fetch from the frontend.
 * Returns a one-sentence AI encouragement message after an item is decluttered.
 */
exports.generateEncouragement = onRequest(
  { secrets: [anthropicApiKey], cors: ALLOWED_ORIGINS },
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
          model: "claude-haiku-4-5-20251001",
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

/**
 * generateTidyCommentHTTP — HTTP endpoint for Tidy AI Coach comment.
 * Accepts a prompt from the frontend and returns AI-generated text.
 * This is a fallback for when the Firestore onCreate trigger doesn't fire.
 */
exports.generateTidyCommentHTTP = onRequest(
  { secrets: [anthropicApiKey], cors: ALLOWED_ORIGINS },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { prompt } = req.body;

    if (!prompt) {
      res.status(400).json({ error: "Missing prompt" });
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text();
        console.error("[TidyHTTP] Anthropic API error:", response.status, errBody);
        res.status(502).json({ error: "AI service unavailable" });
        return;
      }

      const data = await response.json();
      res.json({ text: data.content[0].text.trim() });
    } catch (error) {
      console.error("[TidyHTTP] Error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

// --- Helper functions for Tidy AI Coach context ---

const CATEGORY_NAMES = {
  clothing: "👕 Clothing",
  books: "📖 Books",
  electronics: "📱 Electronics",
  furniture: "🪑 Furniture",
  kitchenware: "🍽️ Kitchenware",
  shoes: "👟 Shoes",
  food: "🥫 Food",
  toys: "🧸 Toys",
  digital: "📄 Digital Docs",
  other: "📦 Other",
};

const SPACES = {
  kitchen_space: "Kitchen",
  bathroom: "Bathroom",
  bedroom: "Bedroom",
  living: "Living Room",
  kids_room: "Kids Room",
  closet: "Closet",
  office: "Office",
  garage: "Garage",
  pantry: "Pantry",
};

function getCategoryName(category) {
  return CATEGORY_NAMES[category] || "📦 Other";
}

function getSpaceDisplayName(spaceKey) {
  return SPACES[spaceKey] || spaceKey;
}

function getMostFrequent(items, field) {
  const counts = {};
  items.forEach((item) => {
    const val = item[field];
    if (val) counts[val] = (counts[val] || 0) + 1;
  });
  let maxKey = null;
  let maxCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxKey = key;
    }
  }
  return maxKey;
}

function getItemsThisWeek(items) {
  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  return items.filter((item) => {
    const created = item.createdAt?.toDate
      ? item.createdAt.toDate()
      : new Date(item.createdAt);
    return created >= weekAgo;
  }).length;
}

function formatRecentItemsList(recentItems) {
  return recentItems
    .map((item) => {
      const created = item.createdAt?.toDate
        ? item.createdAt.toDate()
        : new Date(item.createdAt);
      const daysAgo = Math.floor(
        (Date.now() - created.getTime()) / (1000 * 60 * 60 * 24)
      );
      const spaceName = getSpaceDisplayName(item.space);
      const categoryName = getCategoryName(item.category);
      return `  - "${item.name}" (${categoryName}, ${spaceName}, ${daysAgo === 0 ? "today" : daysAgo + "d ago"})`;
    })
    .join("\n");
}

function buildTidyPrompt(itemData, context) {
  const {
    userVision,
    totalItems,
    currentStreak,
    totalPoints,
    itemsThisWeek,
    topSpaceName,
    topCategoryName,
    recentItemsList,
  } = context;

  const spaceName = getSpaceDisplayName(itemData.space);
  const categoryName = getCategoryName(itemData.category);
  const hasBA = itemData.hasBeforeAfter;
  const note = itemData.note && itemData.note.trim() ? itemData.note.trim() : "";
  const noteLine = note
    ? `- User's note: "${note}"`
    : `- User's note: (empty)`;

  if (hasBA) {
    return `You are "Tidy", a warm and encouraging AI decluttering coach.

USER'S VISION: "${userVision}"
This is their personal goal — reference it naturally when relevant, don't force it.

USER'S HISTORY:
- Total items decluttered: ${totalItems}
- Current streak: ${currentStreak} days
- Total points: ${totalPoints}
- Items this week: ${itemsThisWeek}
- Most cleared space lately: ${topSpaceName}
- Most cleared category lately: ${topCategoryName}
- Recent items:
${recentItemsList}

JUST NOW they decluttered WITH before & after photos:
- Item: ${itemData.name}
- Category: ${categoryName}
- Space: ${spaceName}
- Points earned: ${itemData.points} + 30 bonus for B&A
${noteLine}

Write a personalized, encouraging comment with ONE practical maintenance tip (2-3 sentences max).

Rules:
- If the user left a NOTE, acknowledge it naturally (e.g., if they wrote "took me 2 hours!" recognize the effort. If they wrote "남편이 도와줬어요" mention the teamwork)
- The note is the user's voice — respond like a friend who actually read what they wrote
- If the note is empty, ignore it
- First: celebrate their effort, connecting to their vision or history
- Then: give ONE tip for MAINTAINING the cleared space using HABITS, not products
- Good tips: "one in one out rule", rearranging by frequency of use, weekly 5-min reset, folding methods, keeping surfaces clear, grouping similar items
- NEVER suggest buying storage bins, containers, organizers, shelves, or ANY product
- NEVER recommend shopping or purchases — this is a minimalism app
- Connect to their VISION when it feels natural (e.g., if vision is about kids playing freely and they cleared kids room toys, mention it)
- Notice PATTERNS (e.g., "You've been on a kitchen streak this week!" or "3rd clothing item — closet must be feeling spacious!")
- Celebrate MILESTONES (every 5 items, streak milestones at 3/7/14/30 days, point milestones at 50/100/200/500)
- Reference their HISTORY naturally (e.g., "After the pantry yesterday, now the kitchen — you're conquering the whole first floor!")
- Use 1 emoji max
- Match the user's language: Korean item name → Korean response. English → English.
- Keep it natural, like a supportive friend who knows them well
- NEVER be generic. ALWAYS reference something specific about THIS person.

BAD: "Space looks great! Try to keep it organized."
BAD (ignores note): User writes "2시간 걸렸어요 ㅠㅠ" → "Nice B&A! Keep it clean!"
GOOD: "옷장 3번째 정리! 아이들이 자유롭게 뛰어놀 수 있는 집에 한 발짝 더 가까워졌어요 👏 행거 간격을 주먹 하나로 유지하면 이 상태 오래 갈 거예요!"
GOOD (reads note): User writes "남편이랑 같이 했어요!" → "둘이 함께 하니까 더 뿌듯하죠! 팀워크 최고 👏 매주 같은 시간에 10분씩 함께 정리하면 이 깔끔함이 계속 유지될 거예요!"`;
  }

  return `You are "Tidy", a warm and encouraging AI decluttering coach.

USER'S VISION: "${userVision}"
This is their personal goal — reference it naturally when relevant, don't force it.

USER'S HISTORY:
- Total items decluttered: ${totalItems}
- Current streak: ${currentStreak} days
- Total points: ${totalPoints}
- Items this week: ${itemsThisWeek}
- Most cleared space lately: ${topSpaceName}
- Most cleared category lately: ${topCategoryName}
- Recent items:
${recentItemsList}

JUST NOW they decluttered:
- Item: ${itemData.name}
- Category: ${categoryName}
- Space: ${spaceName}
- Points earned: ${itemData.points}
${noteLine}

Write a short, personalized comment (2-3 sentences max).

Rules:
- If the user left a NOTE, acknowledge it naturally (e.g., if they wrote "finally letting go of this!" respond to that emotion. If they wrote "이거 버리기 아까웠는데" empathize with the difficulty)
- The note is the user's voice — respond like a friend who actually read what they wrote
- If the note is empty, ignore it
- Connect to their VISION when it feels natural (e.g., if vision is about kids playing freely and they cleared kids room toys, mention it)
- Notice PATTERNS (e.g., "You've been on a kitchen streak this week!" or "3rd clothing item — closet must be feeling spacious!")
- Celebrate MILESTONES (every 5 items, streak milestones at 3/7/14/30 days, point milestones at 50/100/200/500)
- Reference their HISTORY naturally (e.g., "After the pantry yesterday, now the kitchen — you're conquering the whole first floor!")
- Use 1 emoji max
- Match the user's language: Korean item name → Korean response. English → English.
- Do NOT suggest buying anything — NEVER recommend products, storage bins, organizers, etc.
- Do NOT give practical tips or suggestions — just encourage and celebrate
- Keep it natural, like a supportive friend who knows them well
- NEVER be generic. ALWAYS reference something specific about THIS person.

BAD (generic): "Great job decluttering! Keep it up!"
BAD (ignores note): User writes "이거 진짜 고민 많이 했어" → "Great declutter! You're doing amazing!"
GOOD (personalized): "팬트리 이어서 주방까지! 🍳 이번 주만 5개째 — 모든 것이 제자리에 있는 집, 점점 가까워지고 있어요!"
GOOD (reads note): User writes "아이가 어릴때 입던건데 아깝다" → "아이의 추억이 담긴 옷이라 쉽지 않았을 텐데, 정말 대단해요. 추억은 마음속에 남아있으니까요 🤍"`;
}

/**
 * generateTidyComment — Firestore onCreate trigger.
 * Automatically generates a Tidy AI Coach comment whenever a new item is created,
 * regardless of which platform (web, mobile, etc.) created the item.
 */
exports.generateTidyComment = onDocumentCreated(
  { document: "items/{itemId}", secrets: [anthropicApiKey] },
  async (event) => {
    const snap = event.data;
    if (!snap) {
      console.log("[Tidy] No data in event, skipping.");
      return;
    }

    const itemData = snap.data();
    const itemId = event.params.itemId;

    if (!itemData.userId || !itemData.name || !itemData.category) {
      console.log("[Tidy] Item missing required fields, skipping.", itemId);
      return;
    }

    // Skip if item already has an AI comment (prevent duplicates)
    if (
      itemData.comments &&
      itemData.comments.some((c) => c.isAI)
    ) {
      console.log("[Tidy] Item already has AI comment, skipping.", itemId);
      return;
    }

    console.log("[Tidy] Generating comment for item:", itemId, itemData.name);

    try {
      // Fetch all user items for context (no orderBy to avoid composite index requirement)
      const itemsSnapshot = await firestoreDb
        .collection("items")
        .where("userId", "==", itemData.userId)
        .get();

      const allItems = itemsSnapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
      // Sort by createdAt descending in JS (avoids Firestore composite index)
      allItems.sort((a, b) => {
        const aTime = a.createdAt?.toDate
          ? a.createdAt.toDate().getTime()
          : 0;
        const bTime = b.createdAt?.toDate
          ? b.createdAt.toDate().getTime()
          : 0;
        return bTime - aTime;
      });
      const totalItems = allItems.length;

      // Recent items (last 7)
      const recentItems = allItems.slice(0, 7);
      const recentItemsList = formatRecentItemsList(recentItems);

      // Pattern detection
      const topSpace = getMostFrequent(recentItems, "space");
      const topCategory = getMostFrequent(recentItems, "category");
      const itemsThisWeek = getItemsThisWeek(allItems);
      const topSpaceName = topSpace ? getSpaceDisplayName(topSpace) : "N/A";
      const topCategoryName = topCategory
        ? getCategoryName(topCategory)
        : "N/A";

      // Fetch user data for vision, streak, score
      const userSnapshot = await firestoreDb
        .collection("users")
        .where("userId", "==", itemData.userId)
        .get();

      let userVision = "";
      let currentStreak = 0;
      let totalPoints = 0;
      if (!userSnapshot.empty) {
        const userData = userSnapshot.docs[0].data();
        userVision = userData.dreamVision || "";
        currentStreak = userData.streak || 0;
        totalPoints = userData.score || 0;
      }

      const prompt = buildTidyPrompt(itemData, {
        userVision,
        totalItems,
        currentStreak,
        totalPoints,
        itemsThisWeek,
        topSpaceName,
        topCategoryName,
        recentItemsList,
      });

      // Call Claude API
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 200,
          messages: [{ role: "user", content: prompt }],
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text();
        console.error("[Tidy] Anthropic API error:", response.status, errBody);
        return;
      }

      const result = await response.json();
      const tidyText = result.content[0].text.trim();

      // Save the AI comment directly to the item document
      await snap.ref.update({
        comments: FieldValue.arrayUnion({
          userName: "Tidy",
          authorAvatar: "🏠",
          isAI: true,
          text: tidyText,
          createdAt: new Date().toISOString(),
        }),
      });

      console.log("[Tidy] Comment saved for item:", itemId);
    } catch (error) {
      console.error("[Tidy] Comment generation failed for item:", itemId, error);
    }
  }
);

/**
 * analyzeSpace — HTTP endpoint for AI Coach Tidy.
 * Accepts a base64 photo of a messy space, analyzes it with Claude,
 * generates a "cleaned up" visualization with DALL-E, and returns the results.
 */
exports.analyzeSpace = onRequest(
  {
    secrets: [anthropicApiKey, openaiApiKey],
    timeoutSeconds: 120,
    memory: "512MiB",
    cors: ALLOWED_ORIGINS,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { imageBase64, userId, userVision } = req.body;

    if (!imageBase64 || !userId) {
      res.status(400).json({ error: "Missing required fields" });
      return;
    }

    const analysisPrompt = `You are "Tidy", an AI decluttering coach for a minimalism app.

Analyze this photo of a messy space. Respond ONLY in valid JSON (no markdown, no backticks).

USER'S VISION: "${userVision || ""}"

{
  "spaceName": "Kitchen Island",
  "itemCount": 12,
  "steps": [
    { "text": "Mail & papers → recycle or file", "minutes": 2 },
    { "text": "Keys, wallet → landing zone by door", "minutes": 1 }
  ],
  "totalMinutes": 8,
  "mainTip": "The 'nothing lives here' rule — this surface is for cooking, not storing. 60-second nightly sweep keeps it clear.",
  "encouragement": "About 12 items don't belong here. Clear in ~8 minutes:",
  "imagePrompt": "A clean, minimalist kitchen island with clear granite countertop, no clutter, soft natural lighting, same kitchen layout as original photo, photorealistic, tidy and organized"
}

Rules for steps:
- NEVER suggest buying anything (no bins, organizers, containers, shelves, products)
- Only suggest REMOVING items or RELOCATING them to where they already belong
- Tips should be about HABITS, not purchases
- Match the user's language (Korean photo context → Korean response, etc.)
- Keep steps actionable and specific
- The imagePrompt should describe the SAME space but clean and minimal — fewer items, not reorganized with new products
- imagePrompt must always be in English for DALL-E compatibility`;

    try {
      // STEP 1: Claude API — analyze the photo
      console.log("[Coach] Analyzing space for user:", userId);
      const detectedMediaType = getMediaType(imageBase64);
      const rawBase64 = stripDataUrlPrefix(imageBase64);
      const analysisResponse = await fetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": anthropicApiKey.value(),
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001",
            max_tokens: 500,
            messages: [
              {
                role: "user",
                content: [
                  {
                    type: "image",
                    source: {
                      type: "base64",
                      media_type: detectedMediaType,
                      data: rawBase64,
                    },
                  },
                  {
                    type: "text",
                    text: analysisPrompt,
                  },
                ],
              },
            ],
          }),
        }
      );

      if (!analysisResponse.ok) {
        const errText = await analysisResponse.text();
        console.error("[Coach] Claude API error:", analysisResponse.status, errText);
        res.status(502).json({ error: "Analysis failed" });
        return;
      }

      const analysisData = await analysisResponse.json();
      const analysisText = analysisData.content[0].text;

      // STEP 2: Parse the analysis JSON
      let parsed;
      try {
        parsed = JSON.parse(analysisText);
      } catch (parseErr) {
        console.error("[Coach] JSON parse error:", parseErr, analysisText);
        // Try to extract JSON from the text
        const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          res.status(502).json({ error: "Analysis returned invalid format" });
          return;
        }
      }

      // STEP 3: DALL-E — generate the "after" image (optional, requires OPENAI_API_KEY)
      let afterImageUrl = null;
      const oaiKey = openaiApiKey.value();
      if (!oaiKey) {
        console.log("[Coach] OPENAI_API_KEY not configured, skipping DALL-E image generation");
      }
      if (oaiKey) try {
        console.log("[Coach] Generating after image with DALL-E");
        const dalleResponse = await fetch(
          "https://api.openai.com/v1/images/generations",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${oaiKey}`,
            },
            body: JSON.stringify({
              model: "dall-e-3",
              prompt: parsed.imagePrompt || "A clean, minimalist room, photorealistic, tidy",
              n: 1,
              size: "1024x1024",
              quality: "standard",
            }),
          }
        );

        if (dalleResponse.ok) {
          const dalleResult = await dalleResponse.json();
          const generatedUrl = dalleResult.data[0].url;

          // STEP 4: Download and save to Firebase Storage
          const imgResponse = await fetch(generatedUrl);
          const imgArrayBuffer = await imgResponse.arrayBuffer();
          const imgBuffer = Buffer.from(imgArrayBuffer);

          const bucket = getStorage().bucket();
          const timestamp = Date.now();
          const filePath = `coach/${userId}/${timestamp}_after.jpg`;
          const file = bucket.file(filePath);
          await file.save(imgBuffer, {
            contentType: "image/jpeg",
            metadata: { cacheControl: "public,max-age=31536000" },
          });
          await file.makePublic();
          afterImageUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        } else {
          const dalleErr = await dalleResponse.text();
          console.error("[Coach] DALL-E error:", dalleResponse.status, dalleErr);
          // Continue without after image — analysis is still useful
        }
      } catch (dalleError) {
        console.error("[Coach] DALL-E generation failed:", dalleError);
        // Continue without after image
      }

      // STEP 5: Save before photo to Storage
      try {
        const beforeBuffer = Buffer.from(rawBase64, "base64");
        const bucket = getStorage().bucket();
        const timestamp = Date.now();
        const ext = detectedMediaType === "image/png" ? "png" : "jpg";
        const beforePath = `coach/${userId}/${timestamp}_before.${ext}`;
        const beforeFile = bucket.file(beforePath);
        await beforeFile.save(beforeBuffer, {
          contentType: detectedMediaType,
          metadata: { cacheControl: "public,max-age=31536000" },
        });
        await beforeFile.makePublic();
        const beforeUrl = `https://storage.googleapis.com/${bucket.name}/${beforePath}`;

        // Save session to Firestore
        await firestoreDb.collection("coachSessions").add({
          userId,
          beforeImageUrl: beforeUrl,
          afterImageUrl: afterImageUrl || null,
          analysis: parsed,
          createdAt: FieldValue.serverTimestamp(),
        });
      } catch (saveError) {
        console.error("[Coach] Save error:", saveError);
        // Non-fatal — return results anyway
      }

      console.log("[Coach] Analysis complete for user:", userId);
      res.json({
        analysis: parsed,
        afterImageUrl,
      });
    } catch (error) {
      console.error("[Coach] analyzeSpace error:", error);
      res.status(500).json({ error: "Internal server error" });
    }
  }
);

/**
 * createCheckout — HTTP endpoint for Stripe checkout session creation.
 * Creates a Stripe Checkout session for Pro subscription.
 */
exports.createCheckout = onRequest({ cors: ALLOWED_ORIGINS }, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { billingCycle, userId } = req.body;

  if (!userId) {
    res.status(400).json({ error: "Missing userId" });
    return;
  }

  // Placeholder — Stripe integration requires STRIPE_SECRET_KEY
  // and price IDs to be configured. Return a placeholder response.
  console.log("[Checkout] Request for", billingCycle, "from user:", userId);
  res.status(501).json({
    error: "Stripe checkout not yet configured. Set up STRIPE_SECRET_KEY and price IDs.",
  });
});
