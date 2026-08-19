import { readFile, writeFile } from "node:fs/promises";
import type { Rectangle } from "electron";

const DEFAULT_BOUNDS: Rectangle = {
  x: 0,
  y: 0,
  width: 1180,
  height: 760
};

export async function readWindowBounds(path: string): Promise<Rectangle> {
  try {
    return parseWindowBounds(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return DEFAULT_BOUNDS;
  }
}

export async function writeWindowBounds(
  path: string,
  bounds: Rectangle
): Promise<void> {
  await writeFile(
    path,
    `${JSON.stringify(parseWindowBounds(bounds), null, 2)}\n`,
    "utf8"
  );
}

export function parseWindowBounds(value: unknown): Rectangle {
  const record =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const width = boundedInteger(record.width, 900, 4000, DEFAULT_BOUNDS.width);
  const height = boundedInteger(
    record.height,
    620,
    3000,
    DEFAULT_BOUNDS.height
  );
  const x = boundedInteger(record.x, -20_000, 20_000, DEFAULT_BOUNDS.x);
  const y = boundedInteger(record.y, -20_000, 20_000, DEFAULT_BOUNDS.y);
  return { x, y, width, height };
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : fallback;
}
