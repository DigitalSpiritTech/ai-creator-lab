/**
 * SHA-256 of every bundled ffmpeg and ffprobe binary, as `npm ci` writes it to disk (the release's
 * `.gz` asset, decompressed), per platform and architecture. `ffmpeg-static` 5.2.0 downloads
 * release b6.0 and `@derhuerst/ffprobe-static` 5.3.0 downloads release b6.1.1 from
 * https://github.com/eugeneware/ffmpeg-static/releases by tag alone, with no checksum of their own,
 * so the app checks the file before it first runs it (`resolveMediaTool` in `media.ts`).
 *
 * Computed on 2026-11-10 from the release assets, and checked against the macOS arm64 binaries
 * `npm ci` installed. Changing either package version means computing these again.
 * @packageDocumentation
 */

export interface BundledChecksum {
  release: string;
  sha256: string;
  size: number;
}

/** Keyed `<tool>-<platform>-<arch>` with Node's `process.platform` and `process.arch` names. */
export const BUNDLED_CHECKSUMS: Readonly<Record<string, BundledChecksum>> = {
  "ffmpeg-darwin-arm64": { release: "b6.0", sha256: "a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584", size: 45568216 },
  "ffmpeg-darwin-x64": { release: "b6.0", sha256: "cfe20936c83ecf5d68e424b87e8cc45b24dd6be81787810123bb964a0df686f9", size: 78829164 },
  "ffmpeg-freebsd-x64": { release: "b6.0", sha256: "88b62c286c6f303b885645c869585284801e2344b8dd67856f0417d923d17d4b", size: 87736624 },
  "ffmpeg-linux-arm": { release: "b6.0", sha256: "1a9ddc19d0e071b6e1ff6f8f34dc05ec6dd4d8f3e79a649f5a9ec0e8c929c4cb", size: 30943188 },
  "ffmpeg-linux-arm64": { release: "b6.0", sha256: "237800b37bb65a81ad47871c6c8b7c45c0a3ca62a5b3f9d2a7a9a2dd9a338271", size: 50015760 },
  "ffmpeg-linux-ia32": { release: "b6.0", sha256: "103500b65ccb78c3c804088d6e17111d85e2bd03f5a0c61c349dc2d05e165f09", size: 50981772 },
  "ffmpeg-linux-x64": { release: "b6.0", sha256: "ed652b2f32e0851d1946894fb8333f5b677c1b2ce6b9d187910a67f8b99da028", size: 78683840 },
  "ffmpeg-win32-ia32": { release: "b6.0", sha256: "fb3766af5cc193ca863e15cd4554a33732973209dad5e3c1433b5e291bceb16c", size: 74250240 },
  "ffmpeg-win32-x64": { release: "b6.0", sha256: "e9fd5e711debab9d680955fc1e38a2c1160fd280b144476cc3f62bc43ef49db1", size: 81114624 },
  "ffprobe-darwin-arm64": { release: "b6.1.1", sha256: "bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64", size: 45528808 },
  "ffprobe-darwin-x64": { release: "b6.1.1", sha256: "fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0", size: 78780408 },
  "ffprobe-linux-arm": { release: "b6.1.1", sha256: "e61ef24870ddc3b80aa8b435512a545bd889e4ed4c2fc7c885f7d3dabad2a53f", size: 31671692 },
  "ffprobe-linux-arm64": { release: "b6.1.1", sha256: "d17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8", size: 50994160 },
  "ffprobe-linux-ia32": { release: "b6.1.1", sha256: "a13b4cce0a4b9bd6714672e4df81076ec06f4c295d798162d48e3de68c781d6d", size: 51955948 },
  "ffprobe-linux-x64": { release: "b6.1.1", sha256: "4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d", size: 79665792 },
  "ffprobe-win32-x64": { release: "b6.1.1", sha256: "3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4", size: 82668032 },
};

export function checksumKey(tool: "ffmpeg" | "ffprobe", platform: string = process.platform, arch: string = process.arch): string {
  return `${tool}-${platform}-${arch}`;
}
