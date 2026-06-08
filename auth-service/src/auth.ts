import { betterAuth } from "better-auth";
import mysql from "mysql2/promise";

const frontendURL = process.env.FRONTEND_URL || "http://localhost:5173";

const pool = mysql.createPool(process.env.DATABASE_URL!);

export const auth = betterAuth({
  database: pool,
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
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google"],
    },
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: "none",
      secure: true,
    },
  },
});
