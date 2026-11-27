// Use native ESM resolution for Pi AI's public subpath. Pi 0.82's extension
// loader otherwise appends the subpath to its compat.js package alias.
export function loadResponsesConverter() {
  return import("@earendil-works/pi-ai/api/openai-responses-shared");
}
