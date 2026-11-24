/** Minimal types for the Emscripten module exported by @ffmpeg/core 0.12 (ESM build). */
declare module '@ffmpeg/core' {
  export interface FFmpegCoreFS {
    mkdir(path: string): void;
    rmdir(path: string): void;
    mount(type: unknown, opts: unknown, mountpoint: string): void;
    unmount(mountpoint: string): void;
    writeFile(path: string, data: Uint8Array): void;
    readFile(path: string): Uint8Array;
    unlink(path: string): void;
    stat(path: string): { size: number };
    readdir(path: string): string[];
    filesystems: Record<string, unknown>;
  }
  export interface FFmpegCore {
    FS: FFmpegCoreFS;
    /** Runs ffmpeg synchronously on the calling thread. Returns its exit code. */
    exec(...args: string[]): number;
    ffprobe(...args: string[]): number;
    setLogger(fn: (m: { type: 'stdout' | 'stderr'; message: string }) => void): void;
    /** `time` is the output position in microseconds. */
    setProgress(fn: (p: { progress: number; time: number }) => void): void;
    reset(): void;
  }
  export interface FFmpegCoreInit {
    wasmBinary?: Uint8Array | ArrayBuffer;
  }
  const createFFmpegCore: (init?: FFmpegCoreInit) => Promise<FFmpegCore>;
  export default createFFmpegCore;
}
