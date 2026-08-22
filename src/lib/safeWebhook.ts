import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const webhookTimeoutMs = 8_000;

const blockedNetworks = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
] as const) blockedNetworks.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128], ["::1", 128], ["64:ff9b::", 96], ["100::", 64],
  ["2001:db8::", 32], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
] as const) blockedNetworks.addSubnet(address, prefix, "ipv6");

export function isPrivateNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0];
  const mapped = normalized.match(/^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/);
  if (mapped) {
    const ipv4 = mapped[1] ?? [mapped[2], mapped[3]]
      .flatMap((part) => {
        const value = Number.parseInt(part!, 16);
        return [value >>> 8, value & 0xff];
      })
      .join(".");
    return isPrivateNetworkAddress(ipv4);
  }
  const family = isIP(normalized);
  if (family === 4) return blockedNetworks.check(normalized, "ipv4");
  if (family === 6) return blockedNetworks.check(normalized, "ipv6");
  return true;
}

export async function validateWebhookUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("webhook_url must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("webhook_url must be an HTTPS URL without embedded credentials");
  }

  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => isPrivateNetworkAddress(address))) {
    throw new Error("webhook_url must resolve only to public network addresses");
  }
  return { url, address: addresses[0] };
}

export async function postWebhook(urlValue: string, body: string, headers: Record<string, string>) {
  const { url, address } = await validateWebhookUrl(urlValue);
  return new Promise<number>((resolve, reject) => {
    const req = request(url, {
      method: "POST",
      headers,
      timeout: webhookTimeoutMs,
      family: address.family,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family)
    }, (response) => {
      response.resume();
      response.once("end", () => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          reject(new Error("Webhook redirects are not allowed"));
          return;
        }
        resolve(status);
      });
    });
    req.once("timeout", () => req.destroy(new Error("Webhook request timed out")));
    req.once("error", reject);
    req.end(body);
  });
}
