import { X509Certificate } from "node:crypto";

function configuredCaCertificate(value: string | undefined) {
  const certificate = value?.trim().replace(/\\n/g, "\n");
  if (!certificate) return undefined;

  try {
    new X509Certificate(certificate);
  } catch {
    throw new Error("DATABASE_CA_CERT must contain a valid PEM-encoded X.509 certificate");
  }
  return certificate;
}

export function verifiedPostgresSsl(databaseUrl: string, caCertificate = process.env.DATABASE_CA_CERT) {
  const hostname = new URL(databaseUrl).hostname.toLowerCase();
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;

  const ca = configuredCaCertificate(caCertificate);
  return ca ? { rejectUnauthorized: true as const, ca } : { rejectUnauthorized: true as const };
}
