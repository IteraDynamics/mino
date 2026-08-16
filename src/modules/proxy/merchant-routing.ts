import { isIP } from "node:net";
import { domainToASCII } from "node:url";

export interface NormalizedMerchantRoutingTarget {
  readonly domain: string;
  readonly baseUrl: string;
}

const BLOCKED_PRIVATE_SUFFIXES = new Set(["local", "localhost", "internal"]);

export function normalizeMerchantRoutingTarget(
  domainValue: string,
  baseUrlValue: string,
): NormalizedMerchantRoutingTarget {
  const domain = normalizeMerchantDomain(domainValue);
  const rawBaseUrl = baseUrlValue.trim();
  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw new MerchantRoutingValidationError("Merchant base URL must be a valid absolute URL");
  }

  if (url.protocol !== "https:") {
    throw new MerchantRoutingValidationError("Merchant base URL must use HTTPS");
  }
  if (url.username || url.password) {
    throw new MerchantRoutingValidationError("Merchant base URL must not contain user information");
  }
  if (url.search || url.hash) {
    throw new MerchantRoutingValidationError("Merchant base URL must not contain query or fragment data");
  }
  if (url.pathname && url.pathname !== "/") {
    throw new MerchantRoutingValidationError("Merchant base URL must identify an HTTPS origin");
  }

  const hostname = normalizeMerchantDomain(url.hostname);
  if (hostname !== domain) {
    throw new MerchantRoutingValidationError(
      "Merchant base URL hostname must exactly match registered domain",
    );
  }

  return {
    domain,
    baseUrl: url.origin,
  };
}

export function normalizeMerchantDomain(value: string): string {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, "");
  if (
    trimmed.length === 0 ||
    trimmed.length > 253 ||
    trimmed.includes("://") ||
    trimmed.includes("/") ||
    trimmed.includes("@") ||
    trimmed.includes(":")
  ) {
    throw new MerchantRoutingValidationError("Merchant domain is invalid");
  }

  const ascii = domainToASCII(trimmed).toLowerCase();
  if (
    !ascii ||
    ascii.length > 253 ||
    isIP(ascii) !== 0 ||
    !ascii.includes(".") ||
    !validHostname(ascii)
  ) {
    throw new MerchantRoutingValidationError("Merchant domain is invalid");
  }

  const terminalLabel = ascii.split(".").at(-1);
  if (terminalLabel && BLOCKED_PRIVATE_SUFFIXES.has(terminalLabel)) {
    throw new MerchantRoutingValidationError("Merchant domain is not a routable public hostname");
  }

  return ascii;
}

function validHostname(value: string): boolean {
  return value.split(".").every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
  );
}

export class MerchantRoutingValidationError extends Error {}
