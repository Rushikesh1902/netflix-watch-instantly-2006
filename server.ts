import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import { MOVIES } from "./src/movies"; // Note: Use js extension or resolve relative import

dotenv.config();

const app = express();
app.use(express.json());

const PORT = 3000;

// Initialize GoogleGenAI client (Server-side only)
let ai: GoogleGenAI | null = null;
const apiKey = process.env.GEMINI_API_KEY;

if (apiKey && apiKey !== "MY_GEMINI_API_KEY") {
  try {
    ai = new GoogleGenAI({
      apiKey: apiKey,
      httpOptions: {
        headers: {
          "User-Agent": "aistudio-build",
        },
      },
    });
    console.log("GoogleGenAI initialized successfully with API key.");
  } catch (err) {
    console.error("Error initializing GoogleGenAI:", err);
  }
} else {
  console.log("No valid GEMINI_API_KEY found. Falling back to rule-based offline engines.");
}

// 1. Natural Language Movie Search Endpoint
app.post("/api/gemini/search", async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== "string") {
    return res.status(400).json({ error: "Query is required" });
  }

  // Graceful rule-based fallback if Gemini is not available
  const runOfflineSearch = () => {
    const q = query.toLowerCase();
    
    // Check if user is looking for "movies under X hours"
    const underHoursMatch = q.match(/under (\d+)\s*(hour|hr|hours)/);
    let maxRuntime = Infinity;
    if (underHoursMatch) {
      maxRuntime = parseInt(underHoursMatch[1]) * 60;
    }

    // Check if user specified a year
    const yearMatch = q.match(/\b(19\d{2}|200[0-6])\b/);
    const targetYear = yearMatch ? parseInt(yearMatch[1]) : null;

    const filtered = MOVIES.filter(m => {
      // Basic text matches
      const matchesText = 
        m.title.toLowerCase().includes(q) ||
        m.genres.some(g => g.toLowerCase().includes(q)) ||
        m.cast.some(c => c.toLowerCase().includes(q)) ||
        m.synopsis.toLowerCase().includes(q);

      // Runtime filters
      const matchesRuntime = m.runtime <= maxRuntime;

      // Year filters
      const matchesYear = targetYear ? m.year === targetYear : true;

      // Genre specific short-hands
      const matchesComedy = q.includes("comedy") ? m.genres.includes("Comedy") : true;
      const matchesAction = q.includes("action") ? m.genres.includes("Action") : true;
      const matchesSciFi = q.includes("sci-fi") || q.includes("scifi") ? m.genres.includes("Sci-Fi") : true;
      const matchesDrama = q.includes("drama") ? m.genres.includes("Drama") : true;
      const matchesFamily = q.includes("family") ? m.genres.includes("Family") : true;

      return (matchesText || underHoursMatch || yearMatch) && matchesRuntime && matchesYear && matchesComedy && matchesAction && matchesSciFi && matchesDrama && matchesFamily;
    });

    return {
      matchingIds: filtered.map(m => m.id),
      explanation: `Offline Search Filter identified ${filtered.length} cinematic features matching your query.`,
      isFallback: true
    };
  };

  if (!ai) {
    return res.json(runOfflineSearch());
  }

  try {
    const moviesSummary = MOVIES.map(m => ({
      id: m.id,
      title: m.title,
      year: m.year,
      runtime: m.runtime,
      genres: m.genres,
      cast: m.cast,
      synopsis: m.synopsis
    }));

    const prompt = `You are the high-performance search backend of Netflix in the year 2006. 
Analyze the user's natural language movie query: "${query}"

Filter and select the matching movies from the following list of available titles:
${JSON.stringify(moviesSummary)}

Return a JSON object containing a list of the exact movie IDs that match the query, plus a short, 2006-style explanation of your findings (mention broadband connections, media players, or DVDs if relevant).`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            matchingIds: {
              type: Type.ARRAY,
              items: { type: Type.STRING },
              description: "The movie IDs matching the criteria"
            },
            explanation: {
              type: Type.STRING,
              description: "A friendly, scannable, 2006-themed sentence explaining the results."
            }
          },
          required: ["matchingIds", "explanation"]
        }
      }
    });

    if (response.text) {
      const data = JSON.parse(response.text.trim());
      return res.json({
        matchingIds: data.matchingIds || [],
        explanation: data.explanation || "Search completed successfully.",
        isFallback: false
      });
    } else {
      throw new Error("Empty response from Gemini");
    }
  } catch (error) {
    console.error("Gemini Search Error:", error);
    return res.json(runOfflineSearch());
  }
});

// 2. AI Help Center Assistant Endpoint
app.post("/api/gemini/help", async (req, res) => {
  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: "Messages array is required" });
  }

  const runOfflineHelp = (userMsg: string) => {
    const q = userMsg.toLowerCase();
    let reply = "Netflix Customer Support (2006): Thank you for contacting us! ";

    if (q.includes("buffer") || q.includes("lag") || q.includes("slow")) {
      reply += "Streaming issues are common on broadband lines under 1.5 Mbps. We recommend pausing the player to let the buffer fill to 100% before playing. Ensure no other computers on your local network are downloading files.";
    } else if (q.includes("dial") || q.includes("speed")) {
      reply += "Netflix Watch Instantly requires a high-speed broadband connection (DSL or Cable). Traditional 56k dial-up modems do not have sufficient throughput and will experience continuous buffering. We suggest adding titles to your DVD Queue instead.";
    } else if (q.includes("media player") || q.includes("wmp") || q.includes("error")) {
      reply += "Please make sure you have Windows Media Player 10 or later installed with correct DRM licenses configured. You can download the latest version from Microsoft's Windows Update site.";
    } else if (q.includes("mac") || q.includes("safari") || q.includes("apple")) {
      reply += "Watch Instantly requires the Netflix Silverlight or Windows Media plug-in. Macintosh support is currently in beta. Please ensure you are running Mac OS X 10.4 Tiger with Safari 2.0.";
    } else {
      reply += "For best streaming, make sure you are using Internet Explorer 6 or Firefox 1.5. If your buffer fails, try reducing your streaming quality to 240p in your Account Settings.";
    }

    return { text: reply, isFallback: true };
  };

  const lastUserMessage = messages[messages.length - 1]?.text || "";

  if (!ai) {
    return res.json(runOfflineHelp(lastUserMessage));
  }

  try {
    const formattedHistory = messages.map(m => `${m.sender === "user" ? "User" : "Representative"}: ${m.text}`).join("\n");

    const prompt = `You are a friendly, helpful Netflix Customer Support Representative in the year 2006. 
You are assisting a customer with their "Watch Instantly" Beta streaming service.
Technology is strictly limited to 2006:
- Connection types: 56k Dial-up, DSL (768kbps), Cable (1.5 - 3Mbps).
- Browser support: Internet Explorer 6/7, Firefox 1.5, Safari 2.0 (macOS Tiger).
- Players: Windows Media Player 10 (needs DRM updates), RealPlayer, QuickTime 7.
- Resolution maxes out at 480p.
- We also offer a DVD-by-mail service.

Address the customer's query. Keep your response very helpful, professional, authentic to 2006, and concise (under 4 sentences). Do not mention modern terms like Netflix app, Smart TV, Chrome, 4K, or 108p.

Chat history:
${formattedHistory}

Representative:`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    if (response.text) {
      return res.json({ text: response.text.trim(), isFallback: false });
    } else {
      throw new Error("Empty response from Gemini");
    }
  } catch (error) {
    console.error("Gemini Help Error:", error);
    return res.json(runOfflineHelp(lastUserMessage));
  }
});

// 3. AI Recommendation Explainer Endpoint
app.post("/api/gemini/explain", async (req, res) => {
  const { movieTitle, movieGenres, ratedMovieTitle, rating } = req.body;
  
  const fallbackExplanation = `This film is recommended for you because you enjoy ${movieGenres ? movieGenres.join(", ") : "similar genres"} and gave ${ratedMovieTitle || "other movies"} a rating of ${rating || 5} stars!`;

  if (!ai) {
    return res.json({ explanation: fallbackExplanation, isFallback: true });
  }

  try {
    const prompt = `You are a movie recommendation assistant on Netflix in 2006. 
Explain to a customer why we are recommending they watch "${movieTitle}" (Genres: ${movieGenres?.join(", ")}) based on the fact that they recently rated "${ratedMovieTitle}" as ${rating} out of 5 stars.
Write a witty, short (1-2 sentences), highly personalized recommendation pitch that sounds like early Netflix algorithms. Use 2006 jargon (e.g. "We crunched the numbers in our movie matching engine", "Instantly queue this up").`;

    const response = await ai.models.generateContent({
      model: "gemini-3.5-flash",
      contents: prompt,
    });

    if (response.text) {
      return res.json({ explanation: response.text.trim(), isFallback: false });
    } else {
      throw new Error("Empty response");
    }
  } catch (error) {
    console.error("Gemini Explain Error:", error);
    return res.json({ explanation: fallbackExplanation, isFallback: true });
  }
});

// Serve Vite on Express in Dev Mode; static assets in Prod
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite middleware mounted for development.");
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Netflix 2006 Server booting on port ${PORT}...`);
    console.log(`Available at http://localhost:${PORT}`);
  });
}

startServer();
