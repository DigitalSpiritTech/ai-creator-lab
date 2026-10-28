/**
 * The environment child processes (ffmpeg, ffprobe) run with: the few variables they need and
 * none of the app's secrets. `.env.local` is loaded into `process.env`, so without this every
 * helper on PATH would see the API keys.
 * @packageDocumentation
 */

const PASSED = ["NODE_ENV", "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "FFMPEG_PATH", "FFPROBE_PATH", "SystemRoot", "SYSTEMROOT", "USERPROFILE", "PATHEXT", "ComSpec"];

/** The environment for a media helper: PATH, temp and locale settings, nothing else. */
export function childEnv(source: Record<string, string | undefined> = process.env): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  for (const name of PASSED) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env as NodeJS.ProcessEnv;
}
