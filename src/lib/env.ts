import "dotenv/config";

export const insecureDevelopmentApiKey = "ak_local_dev_key_change_me";

function cleanEnv(value: string | undefined, fallback = "") {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function firstCleanEnv(...values: Array<string | undefined>) {
  for (const value of values) {
    const cleaned = cleanEnv(value);
    if (cleaned) return cleaned;
  }
  return "";
}

function cleanUrl(value: string | undefined, fallback: string) {
  return cleanEnv(value, fallback).replace(/\/+$/, "");
}

const apiKey = firstCleanEnv(
  process.env.AGENTCONTRACT_API_KEY,
  process.env.AGENTSIGN_API_KEY,
  process.env.AGENTINK_API_KEY
);
const workosCookiePassword = cleanEnv(process.env.WORKOS_COOKIE_PASSWORD);
const isProduction = process.env.NODE_ENV === "production" || Boolean(process.env.VERCEL);

if (isProduction) {
  if (!apiKey || apiKey === insecureDevelopmentApiKey || apiKey.length < 32) {
    throw new Error("AGENTCONTRACT_API_KEY must be a unique secret of at least 32 characters in production");
  }
  if (!workosCookiePassword || workosCookiePassword === apiKey || workosCookiePassword.length < 32) {
    throw new Error("WORKOS_COOKIE_PASSWORD must be a separate secret of at least 32 characters in production");
  }
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: cleanUrl(process.env.BASE_URL, "http://localhost:3000"),
  apiKey,
  cronSecret: cleanEnv(process.env.CRON_SECRET),
  resendApiKey: cleanEnv(process.env.RESEND_API_KEY),
  emailFrom: cleanEnv(process.env.EMAIL_FROM, "contracts@yourdomain.com"),
  emailFromName: cleanEnv(process.env.EMAIL_FROM_NAME, "Bear AI"),
  databasePath: cleanEnv(process.env.DATABASE_PATH, process.env.VERCEL ? "/tmp/agentsign.db" : "./agentsign.db"),
  pdfOutputDir: cleanEnv(process.env.PDF_OUTPUT_DIR, process.env.VERCEL ? "/tmp/agentsign-pdfs" : "./pdfs"),
  workosApiKey: cleanEnv(process.env.WORKOS_API_KEY),
  workosClientId: cleanEnv(process.env.WORKOS_CLIENT_ID),
  workosCookiePassword,
  workosRedirectUri: cleanUrl(process.env.WORKOS_REDIRECT_URI, ""),
  isVercel: Boolean(process.env.VERCEL),
  isProduction
};
