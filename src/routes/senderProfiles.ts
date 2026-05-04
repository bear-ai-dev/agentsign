import { Hono, type Context } from "hono";
import { requireApiKey } from "../lib/auth.js";
import { createOrUpdateSenderProfile, getSenderProfileForOwner, senderProfileForApi, verifySenderProfile } from "../lib/senderProfiles.js";
import type { ApiKeyRecord } from "../lib/types.js";

export const senderProfiles = new Hono();
senderProfiles.use("/v1/sender-profile", requireApiKey);
senderProfiles.use("/v1/sender-profile/*", requireApiKey);

function apiKeyRecord(c: Context): ApiKeyRecord | null {
  return (((c as unknown as { get(key: string): unknown }).get("apiKeyRecord") ?? null) as ApiKeyRecord | null);
}

function requestOwnerEmail(c: Context) {
  return apiKeyRecord(c)?.owner_email?.trim().toLowerCase() ?? null;
}

function profileResponse(profile: Awaited<ReturnType<typeof getSenderProfileForOwner>>) {
  const api = senderProfileForApi(profile ?? null);
  return {
    profile: api,
    email_dns_records: api?.email_dns_records ?? [],
    signing_dns_records: api?.signing_dns_records ?? []
  };
}

senderProfiles.get("/v1/sender-profile", async (c) => {
  const profile = await getSenderProfileForOwner(requestOwnerEmail(c));
  if (!profile) return c.json({ profile: null, email_dns_records: [], signing_dns_records: [] });
  return c.json(profileResponse(profile));
});

senderProfiles.post("/v1/sender-profile", async (c) => {
  try {
    const profile = await createOrUpdateSenderProfile(requestOwnerEmail(c), await c.req.json());
    return c.json(profileResponse(profile), 201);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});

senderProfiles.post("/v1/sender-profile/verify", async (c) => {
  try {
    const profile = await verifySenderProfile(requestOwnerEmail(c));
    return c.json(profileResponse(profile));
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : "Invalid request" }, 400);
  }
});
