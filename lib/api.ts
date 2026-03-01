/**
 * API 클라이언트
 * - 일반 요청: Authorization: Bearer {accessToken}
 * - 401 시: refresh 후 재시도, refresh 실패 시 로그인 페이지로 리다이렉트
 */

import { getAccessToken, getRefreshToken, setTokens, clearTokens } from "./auth";

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8080";
const REFRESH_URL = `${API_BASE}/api/auth/refresh`;

let isRefreshing = false;
let refreshSubscribers: Array<(token: string) => void> = [];

function onRefreshed(accessToken: string) {
  refreshSubscribers.forEach((cb) => cb(accessToken));
  refreshSubscribers = [];
}

function addRefreshSubscriber(cb: (token: string) => void) {
  refreshSubscribers.push(cb);
}

async function refreshTokens(): Promise<{ accessToken: string; refreshToken: string }> {
    const refreshToken = getRefreshToken();

    // 디버깅을 위해 토큰 상태 확인
    if (!refreshToken) {
        console.error("❌ 리프레시 토큰이 없습니다.");
        throw new Error("No refresh token");
    }

    const res = await fetch(REFRESH_URL, {
        method: "POST",
        headers: {
            // 1. Content-Type 제거 (Body가 없으므로 400 에러 방지)
            "Authorization-Refresh": `Bearer ${refreshToken}`,
        },
    });

    if (!res.ok) {
        if (res.status === 401) {
            clearTokens();
            if (typeof window !== "undefined") {
                window.location.href = "/login";
            }
        }
        // 400 에러 발생 시 서버가 주는 메시지를 확인하기 위해 로그 추가
        const errorText = await res.text();
        console.error(`❌ 토큰 재발급 요청 실패 (${res.status}):`, errorText);
        throw new Error(`Refresh failed: ${res.status}`);
    }

    // 2. 백엔드 ApiResponse 구조에 맞춰 파싱
    const responseJson = await res.json();

    // 백엔드 ApiResponse 객체 내부의 data 필드에서 토큰 추출
    const tokenData = responseJson.data;

    if (!tokenData || !tokenData.accessToken || !tokenData.refreshToken) {
        console.error("❌ 응답 데이터 구조가 올바르지 않습니다:", responseJson);
        throw new Error("Invalid refresh response");
    }

    const newAccessToken = tokenData.accessToken;
    const newRefreshToken = tokenData.refreshToken;

    setTokens(newAccessToken, newRefreshToken);

    console.log("✅ 토큰 재발급 성공!");
    return { accessToken: newAccessToken, refreshToken: newRefreshToken };
}

export type RequestInitWithRetry = RequestInit & {
  _retry?: boolean;
};

/**
 * 401 인터셉터가 적용된 fetch
 * - 요청 시 Authorization: Bearer {accessToken} 자동 추가
 * - 401 발생 시 refresh 후 원래 요청 재시도
 * - refresh도 401이면 토큰 삭제 후 /login 으로 리다이렉트
 */
export async function apiFetch(
    input: RequestInfo | URL,
    init: RequestInitWithRetry = {}
): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url.startsWith("/") ? url : `/${url}`}`;

    const doRequest = async (token: string | null, isRetry = false): Promise<Response> => {
        const headers = new Headers(init.headers);
        // GET/HEAD에는 Content-Type을 강제로 붙이지 않는다.
        if (init.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        if (token) headers.set("Authorization", `Bearer ${token}`);

        try {
            const res = await fetch(fullUrl, { ...init, headers });

            // 1. 401 에러 발생 시 처리
            if (res.status === 401) {
                // 이미 재시도한 요청이라면 더 이상 시도하지 않고 종료 (무한 루프 방지)
                if (isRetry) {
                    console.error("❌ 재시도 중에도 401 발생. 로그인이 필요합니다.");
                    clearTokens();
                    if (typeof window !== "undefined") window.location.href = "/login";
                    return res;
                }

                // 2. 다른 곳에서 이미 토큰을 갱신 중이라면 대기열에 등록
                if (isRefreshing) {
                    return new Promise<Response>((resolve, reject) => {
                        addRefreshSubscriber((newToken) => {
                            // 갱신 완료 후 새 토큰으로 재시도
                            doRequest(newToken, true).then(resolve).catch(reject);
                        });
                    });
                }

                // 3. 토큰 갱신 시작
                isRefreshing = true;
                try {
                    console.log("🔄 토큰 만료됨. 새 토큰 발급 중...");
                    const { accessToken: newToken } = await refreshTokens();

                    // 대기열에 있는 친구들에게 새 토큰 전달
                    onRefreshed(newToken);

                    // ⭐️ 현재 실패했던 이 요청도 새 토큰으로 즉시 재시도 (Retry)
                    return await doRequest(newToken, true);
                } catch (refreshError) {
                    // 리프레시 토큰까지 만료된 경우
                    console.error("❌ 토큰 갱신 실패. 다시 로그인하세요.");
                    // 대기열에 있는 친구들도 전부 실패 처리 (필요 시)
                    refreshSubscribers = [];
                    throw refreshError;
                } finally {
                    isRefreshing = false;
                }
            }

            return res;
        } catch (error) {
            // ⭐️ CORS 에러나 네트워크 에러가 여기서 잡힙니다.
            console.error("🌐 네트워크/CORS 에러 발생:", error);
            throw error;
        }
    };

    const currentToken = getAccessToken();
    return doRequest(currentToken);
}

/**
 * GET / POST 등 편의 메서드 (JSON 응답 파싱)
 */
export async function apiGet<T = unknown>(path: string): Promise<T> {
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

/**
 * 매직 링크 메일 발송 (POST /api/auth/email/request)
 * @param email 수신 이메일
 * @param purpose "signup" | undefined — signup 시 이메일 인증 링크, 생략 시 비밀번호 재설정
 */
async function requestMagicLink(email: string, origin: string = "web"): Promise<void> {
  let res: Response;
  try {
    // 1. 경로 수정: /email/request -> /email-request
    // 2. 전달 방식 수정: JSON 바디 대신 Query Parameter 사용 (@RequestParam 대응)
    const url = `${API_BASE}/api/auth/email-request?email=${encodeURIComponent(email)}&origin=${origin}`;

    res = await fetch(url, {
      method: "POST", // 백엔드 @PostMapping 확인됨
      headers: {
        // Query Parameter 방식이므로 JSON 헤더는 필요 없지만, 관례상 두어도 무방합니다.
        "Content-Type": "application/json",
      },
    });
  } catch (e) {
    throw new Error("서버에 연결할 수 없습니다. 백엔드 주소를 확인해주세요.");
  }

  if (!res.ok) {
    const text = await res.text();
    let msg = "메일 발송에 실패했습니다.";

    // 404 에러 시 주소 확인 안내
    if (res.status === 404) {
      msg = "API 경로를 찾을 수 없습니다. 백엔드 컨트롤러 매핑을 확인하세요.";
    } else {
      try {
        const json = JSON.parse(text);
        msg = json.message || json.error || msg;
      } catch {
        if (text) msg = text;
      }
    }
    throw new Error(msg);
  }
}

/** 비밀번호 재설정용 매직 링크 */
export async function requestMagicLinkEmail(email: string): Promise<void> {
  return requestMagicLink(email);
}

/**
 * 비밀번호 재설정 코드 요청 (POST /api/auth/password/code-request)
 */
export async function requestResetCode(email: string): Promise<void> {
  const url = `${API_BASE}/api/auth/password/code-request?email=${encodeURIComponent(email)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST" });
  } catch {
    throw new Error("서버에 연결할 수 없습니다.");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = "인증 코드 발송에 실패했습니다.";
    try {
      const json = JSON.parse(text);
      msg = json.message || json.error || msg;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
}

/**
 * 비밀번호 재설정 코드 검증 (POST /api/auth/password/verify)
 * @returns resetToken
 */
export async function verifyResetCode(email: string, code: string): Promise<string> {
  const url = `${API_BASE}/api/auth/password/verify?email=${encodeURIComponent(email)}&code=${encodeURIComponent(code)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "POST" });
  } catch {
    throw new Error("서버에 연결할 수 없습니다.");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = "코드 검증에 실패했습니다.";
    try {
      const json = JSON.parse(text);
      msg = json.message || json.error || msg;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  const json = await res.json();
  return json.data; // resetToken
}

/**
 * 비밀번호 재설정 (PATCH /api/auth/password/reset)
 */
export async function resetPassword(resetToken: string, newPassword: string): Promise<void> {
  const url = `${API_BASE}/api/auth/password/reset?resetToken=${encodeURIComponent(resetToken)}&newPassword=${encodeURIComponent(newPassword)}`;
  let res: Response;
  try {
    res = await fetch(url, { method: "PATCH" });
  } catch {
    throw new Error("서버에 연결할 수 없습니다.");
  }
  if (!res.ok) {
    const text = await res.text();
    let msg = "비밀번호 변경에 실패했습니다.";
    try {
      const json = JSON.parse(text);
      msg = json.message || json.error || msg;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
}

/** 회원가입 이메일 인증용 매직 링크 (메일에서 링크 클릭 시 회원가입 페이지로 리다이렉트) */
export async function requestSignupVerifyEmail(email: string): Promise<void> {
  return requestMagicLink(email, "web");
}

/**
 * 회원가입 (POST /api/auth/signup) — 이메일 인증 완료 후 호출
 */
export async function signUp(data: { nickname: string; email: string; password: string }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/auth/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const text = await res.text();
    let msg = "회원가입에 실패했습니다.";
    try {
      const json = JSON.parse(text);
      if (typeof json.message === "string") msg = json.message;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
}

/** report 등에서 사용 (axios 스타일: response.data) */
export const api = {
  get: async (url: string) => {
    const res = await apiFetch(url);
    const data = await res.json().catch(() => ({}));
    return { data };
  },
  post: async (url: string, body?: unknown) => {
    const fullUrl = url.startsWith("http") ? url : `${API_BASE}${url.startsWith("/") ? url : `/${url}`}`;
    const res = await apiFetch(fullUrl, {
      method: "POST",
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    return { data };
  },
};
