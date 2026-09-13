import http from "k6/http";
import { baseUrl, thresholds } from "./common.js";
export const options = { vus: 25, duration: "30s", thresholds };
export default function () {
  http.post(`${baseUrl}/api/v1/webhooks/meta`, "{}", {
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": "sha256=invalid",
    },
  });
}
