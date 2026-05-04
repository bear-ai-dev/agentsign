import { nanoid } from "nanoid";
import { all, get, nowIso, parseJson, run } from "./db.js";
import { createResendDomain, setupVercelDomain, verifyResendDomain, verifyVercelDomain } from "./providerAdapters.js";
import type { DnsRecord, SenderProfile } from "./types.js";

type SenderProfileInput = {
  email_domain?: string;
  signing_domain?: string;
  from_email?: string;
  from_name?: string;
};

export type ResolvedSenderProfile = {
  senderEmail: string | null;
  senderName: string;
  senderProfile: SenderProfile | null;
  signingBaseUrl: string | null;
};

function normalizeDomain(value: unknown, label: string) {
  const domain = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`${label} must be a valid domain`);
  return domain;
}

function normalizeEmail(value: unknown, label: string) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${label} must be a valid email address`);
  return email;
}

function emailDomain(email: string) {
  return email.split("@")[1]?.toLowerCase() ?? "";
}

function recordsJson(records: DnsRecord[]) {
  return records.length ? JSON.stringify(records) : null;
}

function isVerified(profile: SenderProfile | null | undefined) {
  return profile?.email_domain_status === "verified" && profile.signing_domain_status === "verified";
}

export function senderProfileForApi(profile: SenderProfile | null) {
  if (!profile) return null;
  return {
    id: profile.id,
    owner_email: profile.owner_email,
    email_domain: profile.email_domain,
    signing_domain: profile.signing_domain,
    default_from_email: profile.default_from_email,
    default_from_name: profile.default_from_name,
    resend_domain_id: profile.resend_domain_id,
    email_domain_status: profile.email_domain_status,
    signing_domain_status: profile.signing_domain_status,
    email_dns_records: parseJson<DnsRecord[]>(profile.email_dns_records_json, []),
    signing_dns_records: parseJson<DnsRecord[]>(profile.signing_dns_records_json, []),
    created_at: profile.created_at,
    updated_at: profile.updated_at,
    verified_at: profile.verified_at
  };
}

export async function getSenderProfileForOwner(ownerEmail: string | null | undefined) {
  if (!ownerEmail) return null;
  return get<SenderProfile>(
    "SELECT * FROM sender_profiles WHERE owner_email = ? ORDER BY created_at DESC LIMIT 1",
    ownerEmail.trim().toLowerCase()
  );
}

export async function getVerifiedSenderProfileForOwner(ownerEmail: string | null | undefined) {
  const profile = await getSenderProfileForOwner(ownerEmail);
  return isVerified(profile) ? profile : null;
}

export async function ownerHasVerifiedSenderProfile(ownerEmail: string | null | undefined) {
  return Boolean(await getVerifiedSenderProfileForOwner(ownerEmail));
}

export async function createOrUpdateSenderProfile(ownerEmail: string | null | undefined, input: SenderProfileInput) {
  if (!ownerEmail) throw new Error("This API key has no owner. Run agentcontract login to create a user-owned key.");
  const normalizedOwner = ownerEmail.trim().toLowerCase();
  const emailDomainValue = normalizeDomain(input.email_domain, "email_domain");
  const signingDomainValue = normalizeDomain(input.signing_domain, "signing_domain");
  const fromEmail = normalizeEmail(input.from_email, "from_email");
  if (emailDomain(fromEmail) !== emailDomainValue) throw new Error("from_email must belong to email_domain");
  const fromName = String(input.from_name ?? "").trim() || null;

  const [emailSetup, signingSetup] = await Promise.all([
    createResendDomain(emailDomainValue),
    setupVercelDomain(signingDomainValue)
  ]);
  const existing = await getSenderProfileForOwner(normalizedOwner);
  const id = existing?.id ?? `sp_${nanoid(12)}`;
  const createdAt = existing?.created_at ?? nowIso();
  const updatedAt = nowIso();
  const verifiedAt = emailSetup.status === "verified" && signingSetup.status === "verified" ? updatedAt : existing?.verified_at ?? null;

  if (existing) {
    await run(
      `UPDATE sender_profiles
       SET email_domain = ?, signing_domain = ?, default_from_email = ?, default_from_name = ?,
           resend_domain_id = ?, email_domain_status = ?, signing_domain_status = ?,
           email_dns_records_json = ?, signing_dns_records_json = ?, updated_at = ?, verified_at = ?
       WHERE id = ? AND owner_email = ?`,
      emailDomainValue,
      signingDomainValue,
      fromEmail,
      fromName,
      emailSetup.providerDomainId,
      emailSetup.status,
      signingSetup.status,
      recordsJson(emailSetup.records),
      recordsJson(signingSetup.records),
      updatedAt,
      verifiedAt,
      id,
      normalizedOwner
    );
  } else {
    await run(
      `INSERT INTO sender_profiles (
        id, owner_email, email_domain, signing_domain, default_from_email, default_from_name,
        resend_domain_id, email_domain_status, signing_domain_status, email_dns_records_json,
        signing_dns_records_json, created_at, updated_at, verified_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      normalizedOwner,
      emailDomainValue,
      signingDomainValue,
      fromEmail,
      fromName,
      emailSetup.providerDomainId,
      emailSetup.status,
      signingSetup.status,
      recordsJson(emailSetup.records),
      recordsJson(signingSetup.records),
      createdAt,
      updatedAt,
      verifiedAt
    );
  }

  return (await getSenderProfileForOwner(normalizedOwner))!;
}

export async function verifySenderProfile(ownerEmail: string | null | undefined) {
  const profile = await getSenderProfileForOwner(ownerEmail);
  if (!profile) throw new Error("Sender profile not found");

  const [emailResult, signingResult] = await Promise.all([
    verifyResendDomain(profile.resend_domain_id, profile.email_domain),
    verifyVercelDomain(profile.signing_domain)
  ]);
  const updatedAt = nowIso();
  const verifiedAt = emailResult.status === "verified" && signingResult.status === "verified" ? updatedAt : profile.verified_at;

  await run(
    `UPDATE sender_profiles
     SET resend_domain_id = ?, email_domain_status = ?, signing_domain_status = ?,
         email_dns_records_json = ?, signing_dns_records_json = ?, updated_at = ?, verified_at = ?
     WHERE id = ? AND owner_email = ?`,
    emailResult.providerDomainId,
    emailResult.status,
    signingResult.status,
    recordsJson(emailResult.records),
    recordsJson(signingResult.records),
    updatedAt,
    verifiedAt,
    profile.id,
    profile.owner_email
  );

  return (await getSenderProfileForOwner(profile.owner_email))!;
}

export async function resolveSenderProfile(input: {
  ownerEmail: string | null;
  requestedSenderEmail?: string | null;
  senderName?: string;
}): Promise<ResolvedSenderProfile> {
  const ownerEmail = input.ownerEmail?.trim().toLowerCase() || null;
  const requested = input.requestedSenderEmail?.trim().toLowerCase() || null;
  const verifiedProfile = await getVerifiedSenderProfileForOwner(ownerEmail);

  if (!ownerEmail) {
    return {
      senderEmail: requested,
      senderName: input.senderName?.trim() ?? "",
      senderProfile: null,
      signingBaseUrl: null
    };
  }

  if (verifiedProfile) {
    const senderEmail = requested ?? verifiedProfile.default_from_email;
    if (emailDomain(senderEmail) !== verifiedProfile.email_domain) {
      throw new Error("sender_email must belong to the verified sender domain");
    }
    return {
      senderEmail,
      senderName: input.senderName?.trim() || verifiedProfile.default_from_name || "",
      senderProfile: verifiedProfile,
      signingBaseUrl: `https://${verifiedProfile.signing_domain}`
    };
  }

  if (requested && requested !== ownerEmail) {
    throw new Error("sender_email must match the logged-in account email or a verified sender domain");
  }

  return {
    senderEmail: requested ?? ownerEmail,
    senderName: input.senderName?.trim() ?? "",
    senderProfile: null,
    signingBaseUrl: null
  };
}

export async function listSenderProfilesForOwner(ownerEmail: string | null | undefined) {
  if (!ownerEmail) return [];
  return all<SenderProfile>(
    "SELECT * FROM sender_profiles WHERE owner_email = ? ORDER BY created_at DESC",
    ownerEmail.trim().toLowerCase()
  );
}
