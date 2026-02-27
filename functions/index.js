const { onRequest, onCall } = require("firebase-functions/v2/https");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { defineSecret } = require("firebase-functions/params");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { initializeApp } = require("firebase-admin/app");
const Stripe = require("stripe");

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
const stripeSecretKey = defineSecret("STRIPE_SECRET_KEY");
const stripeWebhookSecret = defineSecret("STRIPE_WEBHOOK_SECRET");

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

    // 80% short (<8 words), 20% detailed
    const isShortMode = Math.random() < 0.8;

    const shortPrompt = `User decluttered "${itemName}" (${category}).
Status: ${points} pts earned, ${totalScore} total, streak ${streak} days, categories: ${JSON.stringify(categoryCount)}

Write a punchy encouragement in UNDER 8 WORDS. Include 1 emoji.
MUST reference something specific: the item name, category, streak count, or a milestone.
NEVER generic phrases like "Great job!" or "Keep it up!" — make it personal to THIS moment.
Examples of the right vibe:
- "Old jacket, new freedom 🧥"
- "Streak day ${streak} — unstoppable 🔥"
- "${totalScore} points! Minimalist mode ⚡"
- "Kitchen breathing easier now 🍽️"
Don't copy examples — be creative and specific to their data.`;

    const detailedPrompt = `User decluttered "${itemName}" (${category}).
Status: ${points} pts earned, ${totalScore} total, streak ${streak} days, categories: ${JSON.stringify(categoryCount)}

Write a warm, personalized encouragement in 1-2 sentences. Include 1-2 emojis.
Reference something specific: the item, a pattern in their category stats, their streak, or a points milestone.
NOT generic — make it about THIS person's decluttering journey and data.
Don't use cliché phrases like "Amazing!" or "Great job!".`;

    const prompt = isShortMode ? shortPrompt : detailedPrompt;

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
          max_tokens: isShortMode ? 60 : 150,
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

    const { system, prompt, maxTokens } = req.body;

    if (!prompt) {
      res.status(400).json({ error: "Missing prompt" });
      return;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      // Allow frontend to pass maxTokens (capped at 200 for safety)
      const tokenLimit = Math.min(maxTokens || 200, 200);

      const apiBody = {
        model: "claude-haiku-4-5-20251001",
        max_tokens: tokenLimit,
        messages: [{ role: "user", content: prompt }],
      };
      if (system) {
        apiBody.system = system;
      }

      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": anthropicApiKey.value(),
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify(apiBody),
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
  accessories: "👜 Accessories",
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
  mudroom: "Mudroom",
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

// --- Tidy AI Coach System Prompt ---
const TIDY_SYSTEM_PROMPT = `You are Tidy, an expert decluttering coach who has deeply internalized the methodologies of the world's leading organizing experts.

YOUR KNOWLEDGE BASE:
- Marie Kondo (KonMari): 'Does it spark joy?' Category-by-category method (clothes → books → papers → komono → sentimental). Folding, vertical storage, thanking items before releasing them.
- Dana K. White ('Decluttering at the Speed of Life'): Container concept — 'where does this LIVE?' and 'does it have a home?' Practical for busy families. Flat surfaces as danger zones.
- The Minimalists (Joshua Fields Millburn): 90/90 rule (used in last 90 days? will use in next 90?). Everything in, nothing out first.
- Margareta Magnusson (Swedish Death Cleaning / Döstädning): Long-term sustainability, not burdening others with your stuff.
- Peter Walsh: Envision the life you want, then edit possessions to match that vision.

YOUR COACHING STYLE:
- Never give generic advice like 'start small' or 'one step at a time'
- Always reference the user's specific situation: their space, item, emotional state
- Reference specific techniques from the methods above when relevant
- Acknowledge emotional difficulty — letting go has real psychological weight
- Be warm and direct. Ban phrases: 'Amazing!', 'Great job!', 'You've got this!'
- When someone is stuck, diagnose WHY: fear of waste? Sentimental attachment? Decision fatigue? Then address that specific block
- Always end with ONE concrete physical next action, not a vague goal
- Respond in the same language the user writes in (Korean if they write Korean)

NOTE HANDLING:
- If the user wrote a note about the item, treat it as the most important signal
- Notes reveal emotional attachment, guilt, hesitation, or reasoning — read between the lines
- Example: 'gift from mom but never use' → address the guilt of releasing a gift specifically
- Example: 'bought expensive but wrong size' → address sunk cost fallacy directly
- Example: 'not sure' → they're on the fence, help them decide with the 90/90 rule or spark joy test
- Always reference what they wrote ('You mentioned this was a gift...') so they feel heard

CONTEXT RULES:
- If user vision is provided, tie your advice back to it
- If streak/history is provided, acknowledge their momentum specifically
- If a photo is provided, start by describing what you actually see before advising

RESPONSE RULES:
- Follow the LENGTH MODE specified in the task instruction:
  SHORT MODE: Under 8 words + 1 emoji. Like a friend's quick text — warm, specific, not generic. React to something real: their note, the item, a pattern, a milestone. Examples of the right vibe: "Gift guilt released — proud of you 💛", "5th item this week! 🔥", "Closet breathing again ✨", "That sunk cost is gone now 🙌"
  DETAILED MODE: 2-3 sentences max + 1 emoji. Full coaching response with specific references.
- NEVER suggest buying storage bins, containers, organizers, shelves, or ANY product
- NEVER recommend shopping or purchases — this is a minimalism app
- Notice PATTERNS (e.g., "kitchen streak this week!" or "3rd clothing item")
- Celebrate MILESTONES (every 5 items, streak at 3/7/14/30 days, points at 50/100/200/500)
- Reference their history naturally
- NEVER be generic — ALWAYS reference something specific about THIS person
- If user wrote a note, SHORT MODE should react to that note specifically
- If item has before & after photos (DETAILED MODE only): celebrate effort, then give ONE maintenance tip using HABITS (not products). Good tips: "one in one out", rearrange by frequency, weekly 5-min reset, folding methods, clear surfaces, group similar items
- If no before & after photos (DETAILED MODE only): just encourage and celebrate — do NOT give tips or suggestions`;

function buildTidyUserMessage(itemData, context, shortMode) {
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
  const itemNote = itemData.note && itemData.note.trim() ? itemData.note.trim() : "";

  const userContext = [
    userVision ? "Dream home vision: " + userVision : "",
    currentStreak ? "Current streak: " + currentStreak + " days" : "",
    categoryName ? "Category: " + categoryName : "",
    spaceName ? "Space: " + spaceName : "",
    itemNote ? "User note about this item: " + itemNote : "",
  ].filter(Boolean).join("\n");

  const historyBlock = `USER'S HISTORY:
- Total items decluttered: ${totalItems}
- Total points: ${totalPoints}
- Items this week: ${itemsThisWeek}
- Most cleared space lately: ${topSpaceName}
- Most cleared category lately: ${topCategoryName}
- Recent items:
${recentItemsList}`;

  const itemBlock = hasBA
    ? `JUST NOW they decluttered WITH before & after photos:
- Item: ${itemData.name}
- Category: ${categoryName}
- Space: ${spaceName}
- Points earned: ${itemData.points} + 30 bonus for B&A`
    : `JUST NOW they decluttered:
- Item: ${itemData.name}
- Category: ${categoryName}
- Space: ${spaceName}
- Points earned: ${itemData.points}`;

  let task;
  if (shortMode) {
    task = `LENGTH MODE: SHORT. Write a punchy reaction UNDER 8 WORDS + 1 emoji.
Must reference something specific: ${itemNote ? "their note (\"" + itemNote + "\"), " : ""}the item, a pattern, or a milestone.
Do NOT be generic. React to what makes THIS declutter unique.`;
  } else if (hasBA) {
    task = "LENGTH MODE: DETAILED. Write a personalized comment with ONE practical maintenance tip (2-3 sentences max).";
  } else {
    task = "LENGTH MODE: DETAILED. Write a short, personalized comment (2-3 sentences max).";
  }

  return [userContext, historyBlock, itemBlock, task].join("\n\n");
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

      // 80% short (<8 words), 20% detailed
      const shortMode = Math.random() < 0.8;

      const userMessage = buildTidyUserMessage(itemData, {
        userVision,
        totalItems,
        currentStreak,
        totalPoints,
        itemsThisWeek,
        topSpaceName,
        topCategoryName,
        recentItemsList,
      }, shortMode);

      // Call Claude API with system prompt + user context message
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
          max_tokens: shortMode ? 60 : 200,
          system: TIDY_SYSTEM_PROMPT,
          messages: [{ role: "user", content: userMessage }],
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

Analyze this photo of a messy space. First, carefully list EVERY visible object (furniture, items on surfaces, items on floor, wall decorations — everything). Then suggest how to rearrange and neaten them IN PLACE. Respond ONLY in valid JSON (no markdown, no backticks).

USER'S VISION: "${userVision || ""}"

{
  "spaceName": "Bedroom",
  "visibleItems": ["bed with rumpled blanket", "wooden bookshelf", "desk with laptop", "office chair with jacket draped over it", "stack of books on floor", "coffee mug on desk", "pile of clothes on bed", "sneakers by door", "trash wrapper on desk", "water bottle on floor", "backpack leaning on wall"],
  "itemArrangements": [
    "bed with blanket smoothed and pulled flat",
    "jacket moved from chair to a hook or folded on bed corner",
    "books stacked upright on bookshelf",
    "coffee mug centered on desk beside laptop",
    "clothes folded in a neat pile on bed corner",
    "sneakers paired neatly side by side by door",
    "water bottle standing upright on desk",
    "backpack standing upright against wall"
  ],
  "trashToRemove": ["trash wrapper on desk"],
  "misplacedItems": ["dirty plate that belongs in kitchen", "random shopping bag"],
  "itemCount": 11,
  "steps": [
    { "text": "Clothes on bed → fold into a neat stack on bed corner", "minutes": 3 },
    { "text": "Books on floor → stand upright on bookshelf", "minutes": 2 },
    { "text": "Dirty plate → return to kitchen", "minutes": 1 },
    { "text": "Trash wrapper → throw away", "minutes": 1 },
    { "text": "Sneakers → pair neatly by door", "minutes": 1 }
  ],
  "totalMinutes": 7,
  "mainTip": "The 'everything has a home' rule — each item gets returned to its spot. 60-second nightly reset keeps it maintained.",
  "encouragement": "This space has great bones! About 7 minutes of rearranging will make a huge difference:"
}

Rules for steps:
- NEVER suggest buying anything (no bins, organizers, containers, shelves, products)
- Suggest REARRANGING items in place (fold, stack, align, group, straighten, pair) — NOT removing them
- trashToRemove: actual garbage (wrappers, used tissues, empty containers)
- misplacedItems: objects that clearly do NOT belong in this type of space (e.g. dirty dishes in a bedroom, random shopping bags, shoes in the kitchen). These are items someone would carry back to their proper room. Do NOT put furniture, decor, books, electronics, or personal items that reasonably belong in this space
- Tips should be about HABITS, not purchases
- Match the user's language (Korean photo context → Korean response, etc.)
- Keep steps actionable and specific
- visibleItems MUST list EVERY object you can see — furniture, items on surfaces, items on floor, wall items. Be exhaustive.
- itemArrangements MUST describe the SAME items in their neatened state — same count, same objects, just repositioned/straightened/folded
- Do NOT include an imagePrompt field — it will be built from your visibleItems and itemArrangements automatically`;

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
            max_tokens: 800,
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

      // STEP 3: Build the image edit prompt from visibleItems + itemArrangements
      const items = parsed.visibleItems || [];
      const arrangements = parsed.itemArrangements || [];
      const trash = parsed.trashToRemove || [];
      const misplaced = parsed.misplacedItems || [];
      const removable = [...trash, ...misplaced];

      let builtImagePrompt;
      if (items.length > 0 && arrangements.length > 0) {
        const removableLower = removable.map((r) => r.toLowerCase());
        const keepList = items.filter((i) => !removableLower.some((r) => i.toLowerCase().includes(r.split(" ")[0])));
        builtImagePrompt = [
          "CRITICAL INSTRUCTION: This is a REARRANGING task, NOT a removing task.",
          "Show the SAME room with the SAME objects — just neatly repositioned and straightened.",
          "DO NOT erase, delete, or make any objects disappear EXCEPT the specific removable items listed below.",
          "",
          `ITEMS THAT MUST STAY (${keepList.length} objects — all must be visible in result):`,
          ...keepList.map((item, i) => `  ${i + 1}. ${item}`),
          "",
          "HOW TO REARRANGE THEM:",
          ...arrangements.map((arr, i) => `  ${i + 1}. ${arr}`),
          "",
          removable.length > 0 ? `THESE items may be removed (trash or misplaced): ${removable.join(", ")}` : "",
          "",
          "RULES:",
          "- Same room, same camera angle, same walls, same floor, same lighting, same colors.",
          "- The number of visible objects should be approximately the SAME as the original photo minus the removable items.",
          "- The room should look lived-in and realistic — like someone spent 1 hour straightening up.",
          "- DO NOT make surfaces empty. Items stay on surfaces but get aligned and grouped.",
          "- DO NOT make the room look like a magazine photo or a showroom.",
          "- Realistic photo style matching the original image.",
        ].filter(Boolean).join("\n");
      } else {
        builtImagePrompt = parsed.imagePrompt || null;
      }

      // STEP 4: OpenAI image edit — generate the "after" image by editing the original photo
      let afterImageUrl = null;
      const oaiKey = openaiApiKey.value();
      if (!oaiKey) {
        console.log("[Coach] OPENAI_API_KEY not configured, skipping image generation");
      }
      if (oaiKey) try {
        console.log("[Coach] Generating after image with gpt-image-1 edit");
        console.log("[Coach] Image prompt length:", (builtImagePrompt || "").length, "chars");

        const imageBuffer = Buffer.from(rawBase64, "base64");
        const imageBlob = new Blob([imageBuffer], { type: detectedMediaType });
        const ext = detectedMediaType === "image/png" ? "png" : "jpg";

        const fallbackPrompt = "REARRANGING task — NOT a removing task. Show the exact same room with the exact same furniture and belongings, but neatly repositioned. Fold clothes into neat stacks, stand books upright, align items on surfaces into groups, pair shoes neatly. DO NOT erase or delete ANY objects — every piece of furniture and every item must remain visible. Only remove actual trash (wrappers, tissues) and items that clearly do not belong in this type of room. The room should look like someone spent 1 hour straightening up — still lived-in, not empty. Same angle, same lighting, same background. Realistic photo.";

        const formData = new FormData();
        formData.append("image", imageBlob, `photo.${ext}`);
        formData.append("model", "gpt-image-1");
        formData.append("prompt", builtImagePrompt || fallbackPrompt);
        formData.append("n", "1");
        formData.append("size", "1024x1024");
        formData.append("quality", "medium");

        const editResponse = await fetch(
          "https://api.openai.com/v1/images/edits",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${oaiKey}`,
            },
            body: formData,
          }
        );

        if (editResponse.ok) {
          const editResult = await editResponse.json();
          const b64Image = editResult.data[0].b64_json;
          const imgBuffer = Buffer.from(b64Image, "base64");

          const bucket = getStorage().bucket();
          const timestamp = Date.now();
          const filePath = `coach/${userId}/${timestamp}_after.png`;
          const file = bucket.file(filePath);
          await file.save(imgBuffer, {
            contentType: "image/png",
            metadata: { cacheControl: "public,max-age=31536000" },
          });
          await file.makePublic();
          afterImageUrl = `https://storage.googleapis.com/${bucket.name}/${filePath}`;
        } else {
          const editErr = await editResponse.text();
          console.error("[Coach] Image edit error:", editResponse.status, editErr);
          // Continue without after image — analysis is still useful
        }
      } catch (editError) {
        console.error("[Coach] Image edit generation failed:", editError);
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
 * imageProxy — HTTP endpoint that proxies Firebase Storage images with proper CORS headers.
 * Used by the share image generator to draw photos on canvas without tainting it.
 */
exports.imageProxy = onRequest(
  { cors: ALLOWED_ORIGINS },
  async (req, res) => {
    const url = req.query.url;
    if (!url || (!url.includes('firebasestorage.googleapis.com') && !url.includes('storage.googleapis.com'))) {
      res.status(400).json({ error: "Invalid or missing image URL" });
      return;
    }

    try {
      const response = await fetch(url);
      if (!response.ok) {
        res.status(response.status).json({ error: "Failed to fetch image" });
        return;
      }

      const contentType = response.headers.get("content-type") || "image/jpeg";
      const buffer = Buffer.from(await response.arrayBuffer());

      res.set("Content-Type", contentType);
      res.set("Cache-Control", "public, max-age=86400");
      res.send(buffer);
    } catch (error) {
      console.error("[imageProxy] Error:", error);
      res.status(500).json({ error: "Proxy fetch failed" });
    }
  }
);

/**
 * createCheckoutSession — Callable function for Stripe checkout session creation.
 * Takes a "plan" parameter ("monthly" or "yearly") and returns a checkout URL.
 */
exports.createCheckoutSession = onCall(
  { secrets: [stripeSecretKey] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new Error("You must be logged in to subscribe.");
    }

    const { plan } = request.data;
    if (!plan || !["monthly", "yearly"].includes(plan)) {
      throw new Error("Invalid plan. Must be 'monthly' or 'yearly'.");
    }

    const priceId =
      plan === "monthly"
        ? "price_xxxx_monthly"
        : "price_xxxx_yearly";

    const stripe = new Stripe(stripeSecretKey.value());

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: "https://tacogong0621.github.io/success",
      cancel_url: "https://tacogong0621.github.io",
      metadata: { uid },
    });

    return { url: session.url };
  }
);

/**
 * stripeWebhook — HTTP endpoint that handles Stripe webhook events.
 * Listens for checkout.session.completed and customer.subscription.deleted
 * to update the user's isPremium status in Firestore.
 */
exports.stripeWebhook = onRequest(
  { secrets: [stripeSecretKey, stripeWebhookSecret] },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).send("Method not allowed");
      return;
    }

    const stripe = new Stripe(stripeSecretKey.value());
    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.rawBody,
        sig,
        stripeWebhookSecret.value()
      );
    } catch (err) {
      console.error("[StripeWebhook] Signature verification failed:", err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
      return;
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const uid = session.metadata?.uid;
      if (uid) {
        await firestoreDb.doc(`users/${uid}`).set(
          { isPremium: true },
          { merge: true }
        );
        console.log("[StripeWebhook] Set isPremium=true for user:", uid);
      }
    } else if (event.type === "customer.subscription.deleted") {
      const subscription = event.data.object;
      // Retrieve the original checkout session to get the uid from metadata
      const sessions = await stripe.checkout.sessions.list({
        subscription: subscription.id,
        limit: 1,
      });
      const uid = sessions.data[0]?.metadata?.uid;
      if (uid) {
        await firestoreDb.doc(`users/${uid}`).set(
          { isPremium: false },
          { merge: true }
        );
        console.log("[StripeWebhook] Set isPremium=false for user:", uid);
      }
    }

    res.status(200).json({ received: true });
  }
);
