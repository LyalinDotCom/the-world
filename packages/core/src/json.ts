export interface ParsedJson {
  value: unknown;
  repaired: boolean;
}

export function parseModelJson(text: string): ParsedJson {
  const trimmed = stripCodeFence(text.trim());
  try {
    return { value: JSON.parse(trimmed), repaired: false };
  } catch {
    const extracted = extractFirstObject(trimmed);
    if (!extracted) {
      throw new Error('Model output did not contain a JSON object.');
    }
    return { value: JSON.parse(extracted), repaired: true };
  }
}

function stripCodeFence(text: string): string {
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fence ? fence[1]!.trim() : text;
}

function extractFirstObject(text: string): string | undefined {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return text.slice(start, end + 1);
}
