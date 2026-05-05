import "dotenv/config";

function cleanEnv(value: string | undefined, fallback = "") {
  const trimmed = value?.trim();
  return trimmed || fallback;
}

function cleanUrl(value: string | undefined, fallback: string) {
  return cleanEnv(value, fallback).replace(/\/+$/, "");
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: cleanUrl(process.env.BASE_URL, "http://localhost:3000"),
  apiKey: cleanEnv(process.env.AGENTCONTRACT_API_KEY ?? process.env.AGENTSIGN_API_KEY ?? process.env.AGENTINK_API_KEY, "ak_local_dev_key_change_me"),
  resendApiKey: cleanEnv(process.env.RESEND_API_KEY),
  emailFrom: cleanEnv(process.env.EMAIL_FROM, "contracts@yourdomain.com"),
  emailFromName: cleanEnv(process.env.EMAIL_FROM_NAME, "Bear AI"),
  databasePath: cleanEnv(process.env.DATABASE_PATH, process.env.VERCEL ? "/tmp/agentsign.db" : "./agentsign.db"),
  pdfOutputDir: cleanEnv(process.env.PDF_OUTPUT_DIR, process.env.VERCEL ? "/tmp/agentsign-pdfs" : "./pdfs"),
  workosApiKey: cleanEnv(process.env.WORKOS_API_KEY),
  workosClientId: cleanEnv(process.env.WORKOS_CLIENT_ID),
  workosCookiePassword: cleanEnv(process.env.WORKOS_COOKIE_PASSWORD),
  workosRedirectUri: cleanUrl(process.env.WORKOS_REDIRECT_URI, ""),
  isVercel: Boolean(process.env.VERCEL)
};
