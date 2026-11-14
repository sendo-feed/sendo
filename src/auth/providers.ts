/*
 * ログインを頼む提供元（docs/decisions/accounts.md の 2）。GitHub などは、あとから同じ形で足す。
 */

/** OpenID Connect の提供元。どの値もコードで決まる定数（利用者が渡す URL ではない） */
export type OidcProvider = {
  /** URL に使う名前（/auth/<id>/login） */
  id: string;
  /** identities に置く issuer。ID トークンの iss は acceptedIssuers のどれかならよい */
  issuer: string;
  acceptedIssuers: readonly string[];
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  /** 求める範囲。メールが要るので email を含める */
  scope: string;
  /** 認可のリクエストに足すパラメーター */
  authorizationParams?: Readonly<Record<string, string>>;
};

/**
 * Google（https://developers.google.com/identity/openid-connect/openid-connect）。
 * ID トークンの iss は、https:// の付いたものと付かないものの 2 通りがある。
 */
export const GOOGLE: OidcProvider = {
  id: "google",
  issuer: "https://accounts.google.com",
  acceptedIssuers: ["https://accounts.google.com", "accounts.google.com"],
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
  jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
  scope: "openid email",
  // 複数の Google アカウントを持つ人が、どれでログインするかを選べるようにする
  authorizationParams: { prompt: "select_account" },
};

/** ログインに使える提供元。キーは URL に使う名前 */
export const PROVIDERS = { google: GOOGLE } as const satisfies Record<string, OidcProvider>;

export type ProviderId = keyof typeof PROVIDERS;
