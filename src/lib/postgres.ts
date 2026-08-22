export function verifiedPostgresSsl(databaseUrl: string) {
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;
  return { rejectUnauthorized: true as const };
}
