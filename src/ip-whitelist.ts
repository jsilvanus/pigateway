export function normalizeIp(ip: string | undefined): string {
  if (!ip) return "";
  let clean = ip.trim();
  if (clean.startsWith("::ffff:")) {
    clean = clean.slice(7);
  }
  if (clean === "::1") {
    clean = "127.0.0.1";
  }
  return clean;
}

function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let num = 0;
  for (const p of parts) {
    const n = parseInt(p, 10);
    if (isNaN(n) || n < 0 || n > 255) return null;
    num = ((num << 8) + n) >>> 0;
  }
  return num;
}

export function isIpWhitelisted(clientIp: string | undefined, allowedHosts?: string[]): boolean {
  if (!allowedHosts || allowedHosts.length === 0) {
    return false;
  }
  const normalized = normalizeIp(clientIp);
  if (!normalized) return false;

  for (const host of allowedHosts) {
    const target = normalizeIp(host);
    if (!target) continue;

    // Exact match
    if (normalized === target) {
      return true;
    }

    // Subnet wildcard (e.g. 192.168.1.*)
    if (target.endsWith(".*") && normalized.startsWith(target.slice(0, -1))) {
      return true;
    }

    // CIDR notation (e.g. 192.168.1.0/24 or 10.0.0.0/8)
    if (target.includes("/")) {
      const parts = target.split("/");
      const subnet = parts[0];
      const bitsStr = parts[1];
      if (subnet && bitsStr) {
        const bits = parseInt(bitsStr, 10);
        if (!isNaN(bits) && bits >= 0 && bits <= 32) {
          const ipNum = ipv4ToNumber(normalized);
          const subNum = ipv4ToNumber(subnet);
          if (ipNum !== null && subNum !== null) {
            const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
            if ((ipNum & mask) === (subNum & mask)) {
              return true;
            }
          }
        }
      }
    }
  }
  return false;
}
