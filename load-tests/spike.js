import { get, thresholds } from "./common.js";
export const options = {
  stages: [
    { duration: "20s", target: 20 },
    { duration: "20s", target: 200 },
    { duration: "20s", target: 20 },
  ],
  thresholds,
};
export default function () {
  get("/health");
}
