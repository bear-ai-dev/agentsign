import "dotenv/config";

const explicitApiKey = process.env.AGENTCONTRACT_API_KEY ?? process.env.AGENTSIGN_API_KEY ?? process.env.AGENTINK_API_KEY;
const isProduction = Boolean(process.env.VERCEL) || process.env.NODE_ENV === "production";

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  apiKey: explicitApiKey ?? (isProduction ? "" : "ak_local_dev_key_change_me"),
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  resendEmailsPerSecond: positiveInteger(process.env.RESEND_EMAILS_PER_SECOND, 5),
  emailFrom: process.env.EMAIL_FROM ?? "contracts@yourdomain.com",
  emailFromName: process.env.EMAIL_FROM_NAME ?? "AgentContract",
  vercelApiToken: process.env.VERCEL_API_TOKEN ?? "",
  vercelProjectId: process.env.VERCEL_PROJECT_ID ?? "",
  vercelTeamId: process.env.VERCEL_TEAM_ID ?? "",
  vercelDnsCname: process.env.VERCEL_DNS_CNAME ?? "cname.vercel-dns.com",
  databasePath: process.env.DATABASE_PATH ?? (process.env.VERCEL ? "/tmp/agentsign.db" : "./agentsign.db"),
  pdfOutputDir: process.env.PDF_OUTPUT_DIR ?? (process.env.VERCEL ? "/tmp/agentsign-pdfs" : "./pdfs"),
  workosApiKey: process.env.WORKOS_API_KEY ?? "",
  workosClientId: process.env.WORKOS_CLIENT_ID ?? "",
  workosCookiePassword: process.env.WORKOS_COOKIE_PASSWORD ?? "",
  workosRedirectUri: process.env.WORKOS_REDIRECT_URI ?? "",
  isVercel: Boolean(process.env.VERCEL),
  isProduction
};
