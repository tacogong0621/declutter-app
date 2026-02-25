const { onRequest } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { initializeApp } = require("firebase-admin/app");

initializeApp();
const firestoreDb = getFirestore();

const anthropicApiKey = defineSecret("ANTHROPIC_API_KEY");

const ALLOWED_ORIGINS = [
  "https://tacogong0621.github.io",
  "http://localhost:5000",
  "http://localhost:3000",
];

function setCorsHeaders(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
  } else {
    res.set("Access-Control-Allow-Origin", ALLOWED_ORIGINS[0]);
  }
  res.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Max-Age", "3600");
}

/**
 * generateEncouragement — HTTP endpoint called via fetch from the frontend.
 * Returns a one-sentence AI encouragement message after an item is decluttered.
 */
exports.generateEncouragement = onRequest(
  { secrets: [anthropicApiKey] },
  async (req, res) => {
    setCorsHeaders(req, res);

    if (req.method === "OPTIONS") {
      res.status(204).send("");
      return;
    }

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

const BINGO_SPACES = {
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
  return BINGO_SPACES[spaceKey] || spaceKey;
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

Write a personalized, encouraging comment with ONE practical maintenance tip (2-3 sentences max).

Rules:
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
GOOD: "옷장 3번째 정리! 아이들이 자유롭게 뛰어놀 수 있는 집에 한 발짝 더 가까워졌어요 👏 행거 간격을 주먹 하나로 유지하면 이 상태 오래 갈 거예요!"`;
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

Write a short, personalized comment (2-3 sentences max).

Rules:
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
GOOD (personalized): "팬트리 이어서 주방까지! 🍳 이번 주만 5개째 — 모든 것이 제자리에 있는 집, 점점 가까워지고 있어요!"`;
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
      // Fetch all user items for context
      const itemsSnapshot = await firestoreDb
        .collection("items")
        .where("userId", "==", itemData.userId)
        .orderBy("createdAt", "desc")
        .get();

      const allItems = itemsSnapshot.docs.map((d) => ({
        id: d.id,
        ...d.data(),
      }));
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
