import axios from "axios";
import { endViewAs, getViewAs } from "@/lib/impersonation";
import { API_URL } from "@/lib/apiUrl";

export const api = axios.create({
  baseURL: API_URL,
  headers: { "Content-Type": "application/json" },
  withCredentials: false,
});

// ─── Request Interceptor: attach access token ─────────────────────────────────
api.interceptors.request.use(
  (config) => {
    if (typeof window !== "undefined") {
      const token = localStorage.getItem("accessToken");
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ─── Response Interceptor: handle 401 and token refresh ───────────────────────
/**
 * Calls where a 401 is the answer rather than an expired session: a wrong
 * email or password, or a refresh token that has run out. Treating the login's
 * 401 as "session expired" sent the browser to /login — reloading the very page
 * the error was about to be shown on, so a wrong password looked like nothing.
 */
const AUTH_ANSWER_PATHS = ["/auth/login", "/auth/refresh-token"];
const isAuthAnswer = (url?: string) => !!url && AUTH_ANSWER_PATHS.some((p) => url.endsWith(p));

/** Clear the session and go to the login page — unless already there, where a reload only wipes what is on screen. */
function sendToLogin() {
  if (typeof window === "undefined") return;
  localStorage.removeItem("accessToken");
  localStorage.removeItem("refreshToken");
  if (window.location.pathname !== "/login") window.location.href = "/login";
}

let isRefreshing = false;
let failedQueue: Array<{ resolve: (value: unknown) => void; reject: (reason?: unknown) => void }> = [];

const processQueue = (error: unknown, token: string | null = null) => {
  failedQueue.forEach(({ resolve, reject }) => {
    if (error) {
      reject(error);
    } else {
      resolve(token);
    }
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // A "View as" pass that has ended, run out or lost its admin has no refresh
    // token: back to the admin's own account rather than the login page.
    if (error.response?.status === 401 && getViewAs() && !isAuthAnswer(originalRequest?.url)) {
      endViewAs({ tellServer: false });
      return Promise.reject(error);
    }

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthAnswer(originalRequest?.url)) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        })
          .then((token) => {
            originalRequest.headers.Authorization = `Bearer ${token}`;
            return api(originalRequest);
          })
          .catch((err) => Promise.reject(err));
      }

      originalRequest._retry = true;
      isRefreshing = true;

      const refreshToken = typeof window !== "undefined" ? localStorage.getItem("refreshToken") : null;

      if (!refreshToken) {
        isRefreshing = false;
        processQueue(error, null);
        sendToLogin();
        return Promise.reject(error);
      }

      try {
        const response = await axios.post(`${API_URL}/auth/refresh-token`, { refreshToken });
        const { accessToken, refreshToken: newRefreshToken } = response.data.data;

        localStorage.setItem("accessToken", accessToken);
        localStorage.setItem("refreshToken", newRefreshToken);

        api.defaults.headers.common.Authorization = `Bearer ${accessToken}`;
        originalRequest.headers.Authorization = `Bearer ${accessToken}`;

        processQueue(null, accessToken);
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        sendToLogin();
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;
