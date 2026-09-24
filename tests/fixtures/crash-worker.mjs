import { openDatabase } from "../../server/database.mjs";
import { createEngine } from "../../server/engine.mjs";
const dataDir = process.argv[2];
const db = openDatabase(dataDir);
const engine = createEngine({
  db,
  dataDir,
  jobDuration: 0,
  leaseMs: 50,
  afterSubmit() {
    if (process.argv[3] !== "persist") process.exit(73);
  },
  afterPersist() {
    process.exit(73);
  },
});
await engine.tick();
process.exit(74);
