import { join } from "node:path";

/** Where boards (*.ydoc) and the view registry (views/*.json) live. */
export const DATA_DIR = process.env.SINAPSI_DATA ?? join(import.meta.dirname, "..", "..", "..", "data");
