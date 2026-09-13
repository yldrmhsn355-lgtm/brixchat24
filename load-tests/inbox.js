import { get, thresholds } from "./common.js";
export const options = { vus: 50, duration: "1m", thresholds };
export default function () {
  get("/api/v1/conversations");
}
