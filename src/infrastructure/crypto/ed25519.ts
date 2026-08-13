import {
  createPrivateKey,
  createPublicKey,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";

export type Ed25519KeyInput = KeyObject | string | Buffer;

export function signEd25519(
  payload: string | Uint8Array,
  privateKey: Ed25519KeyInput,
): Buffer {
  return sign(null, Buffer.from(payload), normalizePrivateKey(privateKey));
}

export function verifyEd25519(
  payload: string | Uint8Array,
  signature: Uint8Array,
  publicKey: Ed25519KeyInput,
): boolean {
  return verify(
    null,
    Buffer.from(payload),
    normalizePublicKey(publicKey),
    Buffer.from(signature),
  );
}

export function constantTimeStringEquals(
  left: string | undefined,
  right: string | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return false;
  }

  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);

  if (leftBytes.length !== rightBytes.length) {
    return false;
  }

  return timingSafeEqual(leftBytes, rightBytes);
}

function normalizePrivateKey(input: Ed25519KeyInput): KeyObject {
  if (isKeyObject(input)) {
    return input;
  }
  return createPrivateKey(input);
}

function normalizePublicKey(input: Ed25519KeyInput): KeyObject {
  if (isKeyObject(input)) {
    return input;
  }
  return createPublicKey(input);
}

function isKeyObject(value: Ed25519KeyInput): value is KeyObject {
  return typeof value === "object" && "type" in value && typeof value.type === "string";
}
