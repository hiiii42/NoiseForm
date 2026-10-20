// What goes into the public repository. Everything else in the development tree (design references,
// review reports, diagnostics, notes, credentials) stays private. Used by tools/release.mjs and by
// tools/check.mjs, which scans exactly these files for personal information.
export const PUBLISH = [
  '.github', '.gitignore', 'public', 'server.js', 'test', 'tools', 'licenses', 'THIRD_PARTY.md',
  'docs/USER_GUIDE.md', 'docs/ARCHITECTURE.md', 'package.json', 'package-lock.json',
  'jsconfig.json', 'tsconfig.check.json',
];
// Renamed on the way out: the public changelog is the dated short version.
export const RENAME = { 'CHANGELOG-brief.md': 'CHANGELOG.md' };
// Owned by the public repository itself; never overwritten by a release.
export const PUBLIC_OWNED = ['README.md', 'README.zh-CN.md', 'LICENSE', 'docs/media', '.git', '.gitattributes'];

// Personal markers that must never ship: home directories, local scratch paths, and the
// maintainer's own proxy port (written split so this file does not trip its own rule).
export const PERSONAL = [
  { name: 'user home path', re: /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s'"`<>]+|\/(?:home|Users)\/[a-z][\w.-]+\//i },
  { name: 'local scratch path', re: /\b[A-Za-z]:[\\/]+Temp\b/i },
  { name: 'private proxy port', re: new RegExp('\\b' + ['78', '97'].join('') + '\\b') },
];
