// Cursor colors: a fixed palette of 8 hues at matched lightness and chroma,
// defined in OKLCH and converted to hex — per SPEC-learning.md. Random
// per-user colors produce unreadable cursors and near-identical pairs;
// fixing the palette avoids that regardless of how many people join.
//
// Conversion is the standard OKLab/OKLCH -> linear sRGB -> sRGB path from
// Björn Ottosson's OKLab reference (https://bottosson.github.io/posts/oklab/).
function oklchToHex (L, C, hueDegrees) {
  const h = (hueDegrees * Math.PI) / 180
  const a = C * Math.cos(h)
  const b = C * Math.sin(h)

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b

  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3

  const rLin = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
  const gLin = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
  const bLin = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s

  const toSrgbByte = (c) => {
    const clamped = Math.min(1, Math.max(0, c))
    const encoded = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255)
  }

  return (
    '#' +
    [toSrgbByte(rLin), toSrgbByte(gLin), toSrgbByte(bLin)]
      .map((v) => v.toString(16).padStart(2, '0'))
      .join('')
  )
}

// Medium lightness, moderate chroma: vivid enough to read as a distinct
// person, not so light it washes out on the light theme or so dark it
// disappears on the dark theme. Hues spaced 45° apart for 8 total.
const LIGHTNESS = 0.72
const CHROMA = 0.15
const HUES = [0, 45, 90, 135, 180, 225, 270, 315]

export const CURSOR_PALETTE = HUES.map((hue) => oklchToHex(LIGHTNESS, CHROMA, hue))
