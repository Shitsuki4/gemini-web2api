import type { Model, SparkContext } from "../types";
import { ApiError } from "../util";
const bases = [
  ["gemini-3.6-flash", "fbb127bbb056c959", 1],
  ["gemini-3.5-flash-lite", "cf41b0e0dd7d53e5", 6],
  ["gemini-3.1-pro", "9d8ca3786ebdfbea", 3],
  ["gemini-3.8-flash", "56fdd199312815e2", 1],
] as const;
export const MODELS: Model[] = bases.flatMap(([id, hex, mode]) => [
  { id, hex, mode },
  { id: id + "-thinking", hex, mode, thinking: true },
]);
for (const [id, tool] of [
  ["gemini-image", 14],
  ["gemini-music", 21],
  ["gemini-canvas", 2],
  ["gemini-video", 11],
] as const)
  MODELS.push({ id, tool, hex: bases[0][1], mode: 1 });
// Spark Beta is an agent/task protocol, not a Flash alias.
MODELS.push({
  id: "gemini-spark",
  hex: "56fdd199312815e2",
  mode: 1,
  tool: 40,
  spark: true,
});
export function resolveModel(id: string) {
  const model = MODELS.find((m) => m.id === id);
  if (!model)
    throw new ApiError(
      400,
      "unknown_model",
      `Unknown model: ${String(id).slice(0, 80)}`,
    );
  return model;
}
export function modelHeader(model: Model, uuid: string) {
  const h: unknown[] = [
    1,
    null,
    null,
    null,
    model.hex,
    null,
    null,
    0,
    model.spark ? [4, 5, 6, 8, 16, 4, 5, 6, 8, 16] : [4, 5, 6, 8],
    null,
    null,
    model.spark ? 2 : 1,
    null,
    null,
    model.mode,
    model.thinking ? 2 : 1,
    uuid,
  ];
  if (model.spark) {
    // Preserve the observed Spark capability sequence and timestamp structure.
    // The abbreviated normal header accepted a task but produced no answer.
    const timestamp = Date.now();
    h[17] = null;
    h[18] = null;
    h[19] = [[], [Math.floor(timestamp / 1000), (timestamp % 1000) * 1000000]];
  }
  return JSON.stringify(h);
}
export function payload(
  prompt: string,
  model: Model,
  uuid: string,
  metadata?: unknown[],
  turn = 0,
  refs: unknown[] = [],
  sparkContext?: SparkContext,
): unknown[] {
  const a = Array(model.spark ? 99 : 97).fill(null);
  a[0] = [prompt, 0, null, refs.length ? refs : null, null, null, 0];
  a[1] = ["en"];
  a[2] = metadata || ["", "", "", null, null, null, null, null, null, ""];
  a[6] = [0];
  a[7] = 1;
  a[10] = 1;
  a[11] = 0;
  a[17] = [[turn]];
  a[18] = 0;
  a[27] = 1;
  a[30] = [4];
  a[41] = [1];
  a[53] = 0;
  a[59] = uuid;
  a[61] = [];
  a[68] = 1;
  a[79] = model.mode;
  a[80] = model.thinking ? 2 : 1;
  a[91] = 0;
  a[96] = model.thinking ? 1 : 0;
  if (model.tool) a[49] = model.tool;
  if (model.tool === 11) a[55] = [[16]];
  if (model.spark) {
    // Observed on the signed-in Spark UI. Never copy browser challenge slots 3/4.
    a[2] = null;
    a[6] = [1];
    a[30] = [4, 16];
    a[67] = 0;
    a[68] = 2;
    a[83] = sparkContext ? null : 1;
    a[98] = 1;
    if (sparkContext) {
      a[71] = [
        sparkContext.conversationId,
        null,
        null,
        null,
        null,
        null,
        null,
        sparkContext.cursor ?? null,
      ];
    }
  }
  return a;
}
