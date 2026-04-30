import "dotenv/config";

export const env = {
  port: Number(process.env.PORT ?? 3000),
  baseUrl: process.env.BASE_URL ?? "http://localhost:3000",
  apiKey: process.env.AGENTINK_API_KEY ?? "ak_local_dev_key_change_me",
  resendApiKey: process.env.RESEND_API_KEY ?? "",
  emailFrom: process.env.EMAIL_FROM ?? "contracts@yourdomain.com",
  emailFromName: process.env.EMAIL_FROM_NAME ?? "Bear AI",
  databasePath: process.env.DATABASE_PATH ?? (process.env.VERCEL ? "/tmp/agentink.db" : "./agentink.db"),
  pdfOutputDir: process.env.PDF_OUTPUT_DIR ?? (process.env.VERCEL ? "/tmp/agentink-pdfs" : "./pdfs"),
  isVercel: Boolean(process.env.VERCEL)
};
