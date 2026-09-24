import { test } from "node:test";
import assert from "node:assert/strict";
import { compileH3MotionRequest } from "./compile.mjs";

const base = {
  template: {
    id: "dance",
    version: 1,
    inputSlots: [
      { key: "lead", kind: "person", sourceRole: "the dancer on the left" },
      { key: "partner", kind: "person" },
    ],
    motionClips: [{ assetId: "motion-a", durationSeconds: 6 }],
    promptRecipe: "A two-person dance in the reference video's order.",
    output: { duration: 6, resolution: "768P", ratio: "9:16" },
    previewAssetId: "preview-a",
  },
  inputAssetIds: { lead: "image-a", partner: "image-b" },
  assetUrls: {
    "motion-a": "https://example.test/motion-a.mp4",
    "motion-b": "https://example.test/motion-b.mp4",
    "image-a": "https://example.test/a.jpg",
    "image-b": "https://example.test/b.jpg",
  },
};

test("H3 motion request includes image identities and a video action reference", () => {
  const { request, trace } = compileH3MotionRequest(base);
  assert.deepEqual(request.content.map(({ type, role }) => [type, role]), [
    ["text", undefined],
    ["image_url", "reference_image"],
    ["image_url", "reference_image"],
    ["video_url", "reference_video"],
  ]);
  assert.equal(trace.previewAssetId, "preview-a");
  assert.equal(request.content.some(({ role }) => role === "first_frame"), false);
  assert.match(request.content[0].text, /Reference image 1 supplies the appearance of lead/);
  assert.match(request.content[0].text, /Map this image to the dancer on the left/);
  assert.deepEqual(trace.sourceRoles, { lead: "the dancer on the left" });
  assert.equal(trace.motionClipIds[0], "motion-a");
});

test("changing only the motion reference changes the frozen request digest", () => {
  const original = compileH3MotionRequest(base);
  const changed = compileH3MotionRequest({
    ...base,
    template: { ...base.template, motionClips: [{ assetId: "motion-b", durationSeconds: 6 }] },
  });
  assert.notEqual(original.trace.requestSha256, changed.trace.requestSha256);
  assert.deepEqual(original.trace.imageSlots, changed.trace.imageSlots);
});

test("creator prompt may be blank because the required model prompt is composed by the server", () => {
  const { request } = compileH3MotionRequest({
    ...base,
    template: { ...base.template, promptRecipe: "" },
  });
  assert.ok(request.content[0].text.length > 0);
  assert.match(request.content[0].text, /reference video/);
});

test("invalid reference or missing actor input is rejected before a billable call", () => {
  assert.throws(() => compileH3MotionRequest({
    ...base,
    template: { ...base.template, motionClips: [{ assetId: "motion-a", durationSeconds: 16 }] },
  }), /2–15 seconds/);
  assert.throws(() => compileH3MotionRequest({ ...base, inputAssetIds: { lead: "image-a" } }), /partner/);
  assert.throws(() => compileH3MotionRequest({
    ...base,
    assetUrls: { ...base.assetUrls, "motion-a": "http://localhost/motion.mp4" },
  }), /HTTPS URL/);
});
