import { env } from "./env.js";
import type { DnsRecord, DomainStatus } from "./types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function cleanRecords(value: unknown): DnsRecord[] {
  const records = Array.isArray(value) ? value : [];
  return records.map((item) => {
    const record = asRecord(item);
    return {
      type: String(record.type ?? record.record ?? "").toUpperCase(),
      name: String(record.name ?? record.host ?? ""),
      value: String(record.value ?? record.data ?? ""),
      status: record.status ? String(record.status) : undefined,
      priority: typeof record.priority === "number" ? record.priority : null
    };
  }).filter((record) => record.type && record.name && record.value);
}

function normalizeStatus(value: unknown): DomainStatus {
  const status = String(value ?? "").toLowerCase();
  if (["verified", "success", "active"].includes(status)) return "verified";
  if (["failed", "failure", "error"].includes(status)) return "failed";
  if (status === "pending_operator_action") return "pending_operator_action";
  return "pending";
}

async function providerJson(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = asRecord(result).message ?? asRecord(result).error ?? response.statusText;
    throw new Error(String(message));
  }
  return asRecord(result);
}

export async function createResendDomain(domain: string) {
  if (!env.resendApiKey) {
    return {
      providerDomainId: null,
      status: "pending_operator_action" as DomainStatus,
      records: [] as DnsRecord[]
    };
  }

  const result = await providerJson("https://api.resend.com/domains", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name: domain })
  });

  return {
    providerDomainId: typeof result.id === "string" ? result.id : null,
    status: normalizeStatus(result.status),
    records: cleanRecords(result.records ?? result.dns_records)
  };
}

export async function verifyResendDomain(providerDomainId: string | null, domain: string) {
  if (!env.resendApiKey || !providerDomainId) {
    return {
      providerDomainId,
      status: "pending_operator_action" as DomainStatus,
      records: [] as DnsRecord[]
    };
  }

  const result = await providerJson(`https://api.resend.com/domains/${encodeURIComponent(providerDomainId)}/verify`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ name: domain })
  });

  return {
    providerDomainId: typeof result.id === "string" ? result.id : providerDomainId,
    status: normalizeStatus(result.status),
    records: cleanRecords(result.records ?? result.dns_records)
  };
}

function vercelTeamQuery() {
  return env.vercelTeamId ? `?teamId=${encodeURIComponent(env.vercelTeamId)}` : "";
}

export async function setupVercelDomain(domain: string) {
  const records = [{ type: "CNAME", name: domain, value: env.vercelDnsCname }];
  if (!env.vercelApiToken || !env.vercelProjectId) {
    return {
      status: "pending_operator_action" as DomainStatus,
      records
    };
  }

  const result = await providerJson(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(env.vercelProjectId)}/domains${vercelTeamQuery()}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.vercelApiToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ name: domain })
    }
  );

  return {
    status: result.verified === true ? "verified" as DomainStatus : "pending" as DomainStatus,
    records
  };
}

export async function verifyVercelDomain(domain: string) {
  const records = [{ type: "CNAME", name: domain, value: env.vercelDnsCname }];
  if (!env.vercelApiToken || !env.vercelProjectId) {
    return {
      status: "pending_operator_action" as DomainStatus,
      records
    };
  }

  const result = await providerJson(
    `https://api.vercel.com/v10/projects/${encodeURIComponent(env.vercelProjectId)}/domains/${encodeURIComponent(domain)}${vercelTeamQuery()}`,
    {
      method: "GET",
      headers: { Authorization: `Bearer ${env.vercelApiToken}` }
    }
  );

  return {
    status: result.verified === true ? "verified" as DomainStatus : "pending" as DomainStatus,
    records
  };
}
