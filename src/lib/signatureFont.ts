import { readFileSync } from "node:fs";

let cachedFontFaceCss: string | null | undefined;

export function signatureFontFaceCss() {
  if (cachedFontFaceCss !== undefined) return cachedFontFaceCss;

  try {
    const font = readFileSync(new URL("../assets/GreatVibes-Regular.ttf", import.meta.url));
    cachedFontFaceCss = `@font-face { font-family: "AgentContract Signature"; src: url("data:font/truetype;base64,${font.toString("base64")}") format("truetype"); font-weight: 400; font-style: normal; }`;
  } catch {
    cachedFontFaceCss = null;
  }

  return cachedFontFaceCss;
}
