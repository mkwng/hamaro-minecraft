// Microsoft account -> Xbox Live -> XSTS -> Minecraft services token chain.
//
// Input: a Microsoft OAuth 2.0 access token for the consumer tenant with the
// `XboxLive.signin` scope (obtained via MSAL in webServer.ts). Output: the
// caller's Minecraft: Java Edition profile { id, name }.
//
// The chain (all JSON over HTTPS, using Node's built-in fetch):
//   1. user.auth.xboxlive.com/user/authenticate      -> XBL token + user hash (uhs)
//   2. xsts.auth.xboxlive.com/xsts/authorize          -> XSTS token for rp://api.minecraftservices.com/
//   3. api.minecraftservices.com/authentication/login_with_xbox -> Minecraft access token
//   4. api.minecraftservices.com/minecraft/profile   -> { id, name }
//
// NOTE (operator caveat): step 3 returns HTTP 403 for Azure app registrations
// that Mojang/Microsoft have not yet approved via the AppID review form
// (https://aka.ms/mce-reviewappid). See README.md.

export type MinecraftAuthErrorCode =
  | 'NO_XBOX_ACCOUNT'
  | 'CHILD_ACCOUNT'
  | 'REGION_NOT_AVAILABLE'
  | 'ADULT_VERIFICATION_REQUIRED'
  | 'APP_NOT_APPROVED'
  | 'NO_JAVA_LICENSE'
  | 'UPSTREAM';

interface ErrorPresentation {
  /** Page title shown to the player. */
  title: string;
  /** HTTP status for the error page. */
  httpStatus: number;
}

const PRESENTATION: Record<MinecraftAuthErrorCode, ErrorPresentation> = {
  NO_XBOX_ACCOUNT: { title: 'No Xbox profile on this account', httpStatus: 403 },
  CHILD_ACCOUNT: { title: 'Child account restriction', httpStatus: 403 },
  REGION_NOT_AVAILABLE: { title: 'Xbox Live unavailable in your region', httpStatus: 403 },
  ADULT_VERIFICATION_REQUIRED: { title: 'Account verification required', httpStatus: 403 },
  APP_NOT_APPROVED: { title: "This whitelist bot isn't fully set up yet", httpStatus: 503 },
  NO_JAVA_LICENSE: { title: 'No Minecraft: Java Edition on this account', httpStatus: 403 },
  UPSTREAM: { title: 'Login service error', httpStatus: 502 },
};

export class MinecraftAuthError extends Error {
  readonly title: string;
  readonly httpStatus: number;

  constructor(
    public readonly code: MinecraftAuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MinecraftAuthError';
    ({ title: this.title, httpStatus: this.httpStatus } = PRESENTATION[code]);
  }
}

export interface MinecraftProfile {
  /** 32-hex Mojang UUID without dashes. */
  id: string;
  /** Current in-game name. */
  name: string;
}

// ---- Response shapes (only the fields we read) ------------------------------

interface XboxTokenResponse {
  Token?: string;
  DisplayClaims?: { xui?: Array<{ uhs?: string }> };
}

interface XstsErrorResponse {
  XErr?: number;
}

interface MinecraftLoginResponse {
  access_token?: string;
}

interface MinecraftProfileResponse {
  id?: string;
  name?: string;
}

// ---- Constants -------------------------------------------------------------

const XBL_USER_AUTHENTICATE = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_AUTHORIZE = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_LOGIN_WITH_XBOX = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE = 'https://api.minecraftservices.com/minecraft/profile';

const XSTS_ERRORS: Record<number, { code: MinecraftAuthErrorCode; message: string }> = {
  2148916233: {
    code: 'NO_XBOX_ACCOUNT',
    message:
      'This Microsoft account has no Xbox profile. Sign in once at xbox.com to create one, then try again.',
  },
  2148916235: {
    code: 'REGION_NOT_AVAILABLE',
    message: 'Xbox Live is not available in the country associated with this Microsoft account.',
  },
  2148916236: {
    code: 'ADULT_VERIFICATION_REQUIRED',
    message: 'This account needs adult verification on xbox.com before it can sign in.',
  },
  2148916237: {
    code: 'ADULT_VERIFICATION_REQUIRED',
    message: 'This account needs adult verification on xbox.com before it can sign in.',
  },
  2148916238: {
    code: 'CHILD_ACCOUNT',
    message:
      'This is a child account: an adult must add it to a Microsoft family before it can sign in to third-party apps.',
  },
};

// ---- HTTP helper -----------------------------------------------------------

/** Maps a non-2xx response to a specific auth error; return undefined to fall back to UPSTREAM. */
type ErrorMapper = (status: number, bodyText: string) => MinecraftAuthError | undefined;

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  headers?: Record<string, string>;
  mapError?: ErrorMapper;
}

async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...options.headers },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw (
      options.mapError?.(response.status, text) ??
      new MinecraftAuthError(
        'UPSTREAM',
        `${new URL(url).host} returned HTTP ${response.status}${text ? `: ${text.slice(0, 200)}` : ''}`,
      )
    );
  }
  return (await response.json()) as T;
}

/** Format a 32-hex Mojang id as a dashed UUID for logs/display. */
export function formatUuid(id: string): string {
  const hex = id.replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return id;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- The chain -----------------------------------------------------------

/** Resolve the Minecraft: Java Edition profile for a Microsoft access token. */
export async function fetchMinecraftProfile(msAccessToken: string): Promise<MinecraftProfile> {
  // 1. Microsoft access token -> Xbox Live (XBL) user token.
  //    For tokens obtained via an Azure AD (v2.0) app, the RpsTicket must be prefixed "d=".
  const xbl = await requestJson<XboxTokenResponse>(XBL_USER_AUTHENTICATE, {
    body: {
      Properties: {
        AuthMethod: 'RPS',
        SiteName: 'user.auth.xboxlive.com',
        RpsTicket: `d=${msAccessToken}`,
      },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT',
    },
  });
  const userHash = xbl.DisplayClaims?.xui?.[0]?.uhs;
  if (!xbl.Token || !userHash) {
    throw new MinecraftAuthError('UPSTREAM', 'Xbox Live response was missing the token or user hash (uhs).');
  }

  // 2. XBL token -> XSTS token scoped to Minecraft services.
  //    XSTS answers 401 with an XErr code that maps to actionable user messages.
  const xsts = await requestJson<XboxTokenResponse>(XSTS_AUTHORIZE, {
    body: {
      Properties: {
        SandboxId: 'RETAIL',
        UserTokens: [xbl.Token],
      },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT',
    },
    mapError: (status, text) => {
      if (status !== 401) return undefined;
      let parsed: XstsErrorResponse | undefined;
      try {
        parsed = JSON.parse(text) as XstsErrorResponse;
      } catch {
        parsed = undefined;
      }
      const known = parsed?.XErr !== undefined ? XSTS_ERRORS[parsed.XErr] : undefined;
      return known ? new MinecraftAuthError(known.code, known.message) : undefined;
    },
  });

  if (!xsts.Token) {
    throw new MinecraftAuthError('UPSTREAM', 'XSTS response was missing the token.');
  }

  // 3. XSTS token -> Minecraft services access token.
  //    403/401 here = the Azure app hasn't passed Mojang's AppID review yet.
  const login = await requestJson<MinecraftLoginResponse>(MC_LOGIN_WITH_XBOX, {
    body: { identityToken: `XBL3.0 x=${userHash};${xsts.Token}` },
    mapError: (status) =>
      status === 403 || status === 401
        ? new MinecraftAuthError(
            'APP_NOT_APPROVED',
            "Minecraft's login service refused this application (its Azure app is still awaiting " +
              "Mojang's AppID approval). This is a server setup issue, not a problem with your account — " +
              'please tell a server admin, and try again once they say it is approved.',
          )
        : undefined,
  });

  if (!login.access_token) {
    throw new MinecraftAuthError('UPSTREAM', 'Minecraft login response was missing the access token.');
  }

  // 4. Minecraft access token -> Java Edition profile (404 = no license).
  const profile = await requestJson<MinecraftProfileResponse>(MC_PROFILE, {
    method: 'GET',
    headers: { Authorization: `Bearer ${login.access_token}` },
    mapError: (status) =>
      status === 404
        ? new MinecraftAuthError(
            'NO_JAVA_LICENSE',
            'This Microsoft account does not own Minecraft: Java Edition (or has never logged into the game to create a profile).',
          )
        : undefined,
  });
  if (!profile.id || !profile.name) {
    throw new MinecraftAuthError('UPSTREAM', 'Minecraft profile response was missing id/name.');
  }
  return { id: profile.id, name: profile.name };
}
