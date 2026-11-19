export function buildNativeCapture(outputDirectory: string, options?: {
  includeDirectory?: string;
  compile?: (command: string, args: string[], options: { stdio: 'pipe'; timeout: number }) => unknown;
}): { path: string; sourceSha256: string; binarySha256: string; napiVersion: 8 };
export const buildDarwinCapture: typeof buildNativeCapture;
