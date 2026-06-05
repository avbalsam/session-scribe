import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

const frontendURL = process.env.FRONTEND_URL || "http://localhost:5173";

export const auth = betterAuth({
  database: new Database("./auth.db"),
  baseURL: process.env.AUTH_SERVICE_URL || "http://localhost:3002",
  secret: process.env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    },
  },
  trustedOrigins: [frontendURL],
});
