import http from "k6/http";
import { baseUrl, thresholds } from "./common.js";
export const options = { vus: 10, duration: "30s", thresholds };
export default function () {
  http.post(
    `${baseUrl}/api/v1/auth/login`,
    JSON.stringify({
      email: "load-test-invalid@example.test",
      password: "invalid",
    }),
    { headers: { "content-type": "application/json" } },
  );
}
