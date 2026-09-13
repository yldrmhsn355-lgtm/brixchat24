import http from "k6/http";
import { check } from "k6";
export const baseUrl = __ENV.TARGET_URL || "http://localhost:4400";
export function get(path) {
  const response = http.get(`${baseUrl}${path}`);
  check(response, { "status below 500": (r) => r.status < 500 });
  return response;
}
export const thresholds = {
  http_req_failed: ["rate<0.01"],
  http_req_duration: ["p(95)<750"],
};
