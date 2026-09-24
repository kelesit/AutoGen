import { readFileSync } from "node:fs";
import { createAssetService } from "../../server/asset-service.mjs";
import { createCatalogService } from "../../server/catalog-service.mjs";
import { calculateQuote } from "../../server/generation-service.mjs";
export function setupCatalog(db, dataDir, ownerId) {
  const assets = createAssetService(db, dataDir);
  const catalog = createCatalogService(db, assets);
  const bytes = readFileSync(new URL("../../public/media/sample.mp4", import.meta.url));
  const ref = assets.upload({ ownerId, kind: "reference", bytes });
  const preview = assets.upload({ ownerId, kind: "preview", bytes });
  const image = assets.upload({
    ownerId,
    kind: "image",
    bytes: readFileSync(new URL("../../public/media/portrait.jpg", import.meta.url)),
    mime: "image/jpeg",
  });
  const template = catalog.createCurated(ownerId, crypto.randomUUID(), {
    title: "动作测试",
    description: "测试",
    category: "动作",
    referenceVideoIds: [ref.id],
    previewVideoId: preview.id,
    inputSlots: [{ key: "person", kind: "person", label: "人物", required: true }],
    promptRecipe: "wave",
  }).template;
  const quote = calculateQuote(template, "720p", 4);
  return {
    assets,
    catalog,
    template,
    image,
    ref,
    preview,
    jobBody: {
      templateId: template.id,
      templateVersionId: template.versionId,
      uploadIds: { person: image.id },
      resolution: "720p",
      duration: 4,
      expectedCost: quote.cost,
      priceVersion: quote.version,
      prompt: "test",
    },
  };
}
