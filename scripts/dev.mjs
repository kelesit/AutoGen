import { spawn } from "node:child_process";
const children = [
  spawn(process.execPath, ["--watch", "server/index.mjs"], { stdio: "inherit" }),
  spawn(process.execPath, ["--watch", "server/worker.mjs"], { stdio: "inherit" }),
  spawn("npm", ["run", "dev:client"], { stdio: "inherit" }),
];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  children.forEach((child) => child.kill("SIGTERM"));
  setTimeout(() => process.exit(code), 300);
}
children.forEach((child) => child.on("exit", (code) => stop(code || 0)));
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
