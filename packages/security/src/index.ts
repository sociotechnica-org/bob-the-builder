export interface PasswordEnv {
  BOB_PASSWORD: string;
}

export interface PasswordOptions {
  allowCookie?: boolean;
  cookieName?: string;
}

const DEFAULT_COOKIE_NAME = "bob_password";
const TEXT_ENCODER = new TextEncoder();

type SubtleCryptoWithTimingSafeEqual = SubtleCrypto & {
  timingSafeEqual?: (a: BufferSource, b: BufferSource) => boolean;
};

function timingSafeEqualStrings(left: string, right: string): boolean {
  const leftBytes = TEXT_ENCODER.encode(left);
  const rightBytes = TEXT_ENCODER.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);
  const leftPadded = new Uint8Array(maxLength);
  const rightPadded = new Uint8Array(maxLength);
  leftPadded.set(leftBytes);
  rightPadded.set(rightBytes);
  let mismatch = leftBytes.length ^ rightBytes.length;

  const subtleCrypto = globalThis.crypto?.subtle as SubtleCryptoWithTimingSafeEqual | undefined;
  if (subtleCrypto && typeof subtleCrypto.timingSafeEqual === "function") {
    const bytesEqual = subtleCrypto.timingSafeEqual(leftPadded, rightPadded);
    return bytesEqual && mismatch === 0;
  }

  for (let index = 0; index < maxLength; index += 1) {
    mismatch |= leftPadded[index] ^ rightPadded[index];
  }

  return mismatch === 0;
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) {
    return null;
  }

  const [scheme, ...rest] = authHeader.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "bearer" || rest.length !== 1) {
    return null;
  }

  return rest[0] || null;
}

export function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null;
  }

  const cookie = cookieHeader
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));

  if (!cookie) {
    return null;
  }

  const value = cookie.slice(name.length + 1);
  if (!value) {
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function unauthorizedResponse(message = "Unauthorized"): Response {
  return Response.json({ error: message }, { status: 401 });
}

export function requirePassword(
  request: Request,
  env: PasswordEnv,
  options: PasswordOptions = {}
): Response | null {
  const bearerToken = extractBearerToken(request.headers.get("authorization"));
  if (bearerToken && timingSafeEqualStrings(bearerToken, env.BOB_PASSWORD)) {
    return null;
  }

  if (options.allowCookie) {
    const cookieName = options.cookieName ?? DEFAULT_COOKIE_NAME;
    const cookiePassword = getCookieValue(request.headers.get("cookie"), cookieName);
    if (cookiePassword && timingSafeEqualStrings(cookiePassword, env.BOB_PASSWORD)) {
      return null;
    }
  }

  return unauthorizedResponse();
}
