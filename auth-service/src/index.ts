import "dotenv/config";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { fromNodeHeaders } from "better-auth/node";
import { auth } from "./auth.js";

const app = express();
const port = parseInt(process.env.AUTH_PORT || "3002", 10);
const frontendURL = process.env.FRONTEND_URL || "http://localhost:5173";

app.use(
  cors({
    origin: frontendURL,
    methods: ["GET", "POST", "PUT", "DELETE"],
    credentials: true,
  })
);

// Better Auth handles all /api/auth/* routes
// IMPORTANT: do not use express.json() before this handler
app.all("/api/auth/*", toNodeHandler(auth));

// Internal endpoint for FastAPI to validate sessions
app.get("/internal/validate", async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: fromNodeHeaders(req.headers),
    });
    if (session) {
      res.json({
        user: {
          id: session.user.id,
          email: session.user.email,
          name: session.user.name,
          image: session.user.image,
        },
      });
    } else {
      res.status(401).json({ error: "Not authenticated" });
    }
  } catch {
    res.status(401).json({ error: "Not authenticated" });
  }
});

app.listen(port, () => {
  console.log(`Auth service running on http://localhost:${port}`);
});
