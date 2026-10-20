// Prompt-only transforms. No DOM, storage, dictionary or network dependencies.
const comment = (line) => /^\s*#/.test(line);
const divider = (line) => /^\s*---\s*$/.test(line);
const special = (line) => comment(line) || divider(line);

// 1.7.2: no paste transform. Converting A1111 "(tag:1.2)" broke real tags with parentheses
// (sunna_(zenless_zone_zero) became sunna_1.1::zenless_zone_zero::); NovelAI reads () literally.

export function normalizeBlur(text) {
  const lines = String(text).split(/\r?\n/);
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (special(lines[i])) continue;
    // Protect complete references, artist tokens and wildcard names before replacing underscores.
    lines[i] = lines[i].replace(/@[^\s,，]+|artist:[^\s,，:]+|__[^\r\n]*?__|_/gi,
      (part) => part === '_' ? ' ' : part)
      .replace(/，/g, ',').replace(/[^\S\n]+/g, ' ')
      .replace(/(?:\s*,\s*)+/g, ', ').trim();
    if (lines[i]) last = i;
  }
  if (last >= 0) lines[last] = lines[last].replace(/,?$/, ', ');
  return lines.join('\n');
}

export function stripForGeneration(text) {
  return String(text).split(/\r?\n/).filter((line) => !special(line)).join('\n');
}
