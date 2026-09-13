import { get, thresholds } from "./common.js";
export const options = { vus: 20, duration: "30s", thresholds };
export default function () {
  get("/health/ready");
}
