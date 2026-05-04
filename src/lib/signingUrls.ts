import { env } from "./env.js";
import type { Agreement } from "./types.js";

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}

export function agreementBaseUrl(agreement: Pick<Agreement, "signing_base_url">) {
  return trimSlash(agreement.signing_base_url || env.baseUrl);
}

export function agreementUrl(agreement: Pick<Agreement, "signing_base_url">, path: string) {
  return `${agreementBaseUrl(agreement)}${path.startsWith("/") ? path : `/${path}`}`;
}

export function signingHostMatches(agreement: Pick<Agreement, "signing_base_url">, requestUrl: string, hostHeader?: string | null) {
  if (!agreement.signing_base_url) return true;
  const expected = new URL(agreement.signing_base_url).host.toLowerCase();
  const actual = (hostHeader || new URL(requestUrl).host).toLowerCase();
  return actual === expected;
}
