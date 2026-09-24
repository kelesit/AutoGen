import { createHash } from "node:crypto";

const RATIOS = new Set(["adaptive", "21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const RESOLUTIONS = new Set(["768P", "2K"]);
const KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

function invalid(message) {
  throw new TypeError(message);
}

function httpsUrl(value, label) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && url.hostname) return value;
  } catch {}
  invalid(`${label} must be a provider-readable HTTPS URL`);
}

function asset(assets, id, label) {
  if (typeof id !== "string" || !id || !Object.hasOwn(assets, id))
    invalid(`${label} must identify a stored asset`);
  return httpsUrl(assets[id], label);
}

export function compileH3MotionRequest({ template, inputAssetIds, assetUrls }) {
  if (!template || !assetUrls || !inputAssetIds) invalid("template, inputAssetIds and assetUrls are required");
  if (!template.id || !Number.isInteger(template.version) || template.version < 1)
    invalid("template needs a stable id and positive version");
  const slots = template.inputSlots;
  const clips = template.motionClips;
  if (!Array.isArray(slots) || slots.length < 1 || slots.length > 9)
    invalid("template must define 1–9 image slots");
  if (!Array.isArray(clips) || clips.length < 1 || clips.length > 3)
    invalid("motion template must contain 1–3 reference video clips");
  if (!template.output || !RESOLUTIONS.has(template.output.resolution))
    invalid("MiniMax-H3 output resolution must be 768P or 2K");
  if (!Number.isInteger(template.output.duration) || template.output.duration < 4 || template.output.duration > 15)
    invalid("MiniMax-H3 output duration must be an integer from 4 to 15 seconds");
  const ratio = template.output.ratio ?? "adaptive";
  if (!RATIOS.has(ratio)) invalid("unsupported output aspect ratio");
  if (typeof template.promptRecipe !== "string" || template.promptRecipe.length > 6000)
    invalid("promptRecipe must be a string of at most 6000 characters");

  const seen = new Set();
  const imageIds = [];
  const slotInstructions = slots.map((slot, index) => {
    if (!slot || !KEY.test(slot.key) || seen.has(slot.key)) invalid("image slot keys must be unique and stable");
    seen.add(slot.key);
    if (!["scene", "person"].includes(slot.kind)) invalid("image slot kind must be scene or person");
    if (slot.sourceRole !== undefined &&
        (typeof slot.sourceRole !== "string" || !slot.sourceRole.trim() || slot.sourceRole.length > 200))
      invalid("sourceRole must be a non-empty description of at most 200 characters");
    const imageId = inputAssetIds[slot.key];
    asset(assetUrls, imageId, `image slot ${slot.key}`);
    imageIds.push(imageId);
    const meaning = slot.kind === "scene" ? "the scene and visible subjects" : `the appearance of ${slot.key}`;
    const mapping = slot.sourceRole ? ` Map this image to ${slot.sourceRole.trim()} in the reference video.` : "";
    return `Reference image ${index + 1} supplies ${meaning}.${mapping}`;
  });
  if (Object.keys(inputAssetIds).some((key) => !seen.has(key))) invalid("unknown image slot supplied");

  let inputSeconds = 0;
  const videoIds = clips.map((clip, index) => {
    if (!clip || !Number.isFinite(clip.durationSeconds) || clip.durationSeconds < 2 || clip.durationSeconds > 15)
      invalid(`reference video ${index + 1} must be 2–15 seconds`);
    asset(assetUrls, clip.assetId, `reference video ${index + 1}`);
    inputSeconds += clip.durationSeconds;
    return clip.assetId;
  });
  if (inputSeconds > 15) invalid("reference video clips may total at most 15 seconds");

  // Prompt text is mandatory even when the creator did not write a custom prompt.
  // Images are appearance references, never first_frame: H3 forbids mixing
  // first/last-frame mode with reference-video mode.
  const text = [
    "Use the reference video for the temporal action, its sequence and timing. Use the reference images for appearance and identity. Keep the identities consistent; do not copy the source video's people merely because they appear in the motion reference.",
    ...slotInstructions,
    template.promptRecipe.trim(),
  ].filter(Boolean).join(" ");
  if (text.length > 7000) invalid("compiled prompt exceeds MiniMax's 7000-character limit");
  const request = {
    model: "MiniMax-H3",
    content: [
      { type: "text", text },
      ...imageIds.map((id) => ({
        type: "image_url", image_url: { url: assetUrls[id] }, role: "reference_image",
      })),
      ...videoIds.map((id) => ({
        type: "video_url", video_url: { url: assetUrls[id] }, role: "reference_video",
      })),
    ],
    resolution: template.output.resolution,
    duration: template.output.duration,
    ratio,
  };
  return {
    request,
    trace: {
      templateId: template.id,
      templateVersion: template.version,
      imageSlots: Object.fromEntries(slots.map((slot, i) => [slot.key, imageIds[i]])),
      sourceRoles: Object.fromEntries(slots.filter((slot) => slot.sourceRole)
        .map((slot) => [slot.key, slot.sourceRole.trim()])),
      motionClipIds: videoIds,
      previewAssetId: template.previewAssetId ?? null,
      inputVideoSeconds: inputSeconds,
      requestSha256: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
    },
  };
}
