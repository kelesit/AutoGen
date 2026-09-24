import { createApp } from "./app.mjs";
const { app, close } = await createApp({ dataDir: process.env.DATA_DIR });
const port = Number(process.env.PORT || 8787);
const server = app.listen(port, process.env.HOST || "127.0.0.1", () =>
  console.log(`Playbox API ready: http://127.0.0.1:${port} (demo provider)`),
);
function stop() {
  server.close(() => {
    close();
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
