import { mkdir, writeFile } from "node:fs/promises";
const assets = {
  coast: "photo-1518837695005-2083093ee35b",
  portrait: "photo-1534528741775-53994a69daeb",
};
await mkdir("public/media", { recursive: true });
await Promise.all(
  Object.entries(assets).map(async ([name, id]) => {
    const response = await fetch(
      `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1000&q=85`,
    );
    if (!response.ok) throw new Error(`${name}: ${response.status}`);
    await writeFile(`public/media/${name}.jpg`, Buffer.from(await response.arrayBuffer()));
    console.log(`Saved ${name}`);
  }),
);
const video = await fetch(
  "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4",
);
if (!video.ok) throw new Error(`Video: ${video.status}`);
await writeFile("public/media/sample.mp4", Buffer.from(await video.arrayBuffer()));
console.log("Saved demo video");
