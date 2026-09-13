import { get, thresholds } from "./common.js";
export const options = {
  vus: 25,
  duration: __ENV.SOAK_DURATION || "30m",
  thresholds,
};
export default function () {
  get("/health");
}
