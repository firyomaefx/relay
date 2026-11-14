import { defineConfig, triggers } from "cf/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "relay-health",
    entrypoint,
    compatibilityDate: "2026-11-14",
    triggers: [triggers.scheduled({ schedule: "*/5 * * * *" })],
  },
});
