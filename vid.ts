import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export async function extractFramesEverySecond(
    videoBuffer: Buffer,
    fps: number = 3,
    durationSeconds: number = 3,
): Promise<Array<{ timestamp: number; imageBuffer: Buffer; filePath?: string }>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-frames-"));
    const videoPath = path.join(tempDir, "video.mp4");
    const framesDir = path.join(tempDir, "frames");

    try {
        await fs.writeFile(videoPath, videoBuffer);
        await fs.mkdir(framesDir, { recursive: true });

        const frames: Array<{ timestamp: number; imageBuffer: Buffer; filePath?: string }> = [];

        const finalFramesDir = framesDir;

        await new Promise<void>((resolve, reject) => {
            const outputOptions = [
                "-vf", `fps=${fps}`,
                "-q:v", "2",
                "-start_number", "0",
            ];

            outputOptions.push("-t", durationSeconds.toString());

            ffmpeg(videoPath)
                .outputOptions(outputOptions)
                .output(path.join(finalFramesDir, "frame_%03d.jpg"))
                .on("end", () => resolve())
                .on("error", (err) => {
                    console.error("FFmpeg error:", err);
                    reject(err);
                })
                .on("progress", (progress) => {
                    if (progress.percent) {
                        console.log(`Frame extraction progress: ${Math.round(progress.percent)}%`);
                    }
                })
                .run();
        });

        const frameFiles = await fs.readdir(finalFramesDir);
        const sortedFrames = frameFiles
            .filter((file) => file.endsWith(".jpg"))
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/)?.[0] || "0");
                const numB = parseInt(b.match(/\d+/)?.[0] || "0");
                return numA - numB;
            });

        console.log(`📸 Found ${sortedFrames.length} frame files in directory`);

        for (let i = 0; i < sortedFrames.length; i++) {
            const frameFile = sortedFrames[i];
            const framePath = path.join(finalFramesDir, frameFile);
            const imageBuffer = await fs.readFile(framePath);
            const timestamp = i / fps;

            const stats = await fs.stat(framePath);
            if (stats.size === 0) {
                console.warn(`⚠️ Warning: Frame ${frameFile} is empty (0 bytes)`);
            }

            const frameData: { timestamp: number; imageBuffer: Buffer; filePath?: string } = {
                timestamp,
                imageBuffer,
            };

            frames.push(frameData);
        }

        return frames;
    } finally {
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
            console.error("Error cleaning up temporary files:", cleanupError);
        }
    }
}

export function framesToBase64(
    frames: Array<{ timestamp: number; imageBuffer: Buffer; filePath?: string }>
): Array<{ timestamp: number; base64: string; filePath?: string }> {
    return frames.map((frame) => ({
        timestamp: frame.timestamp,
        base64: frame.imageBuffer.toString("base64"),
        filePath: frame.filePath,
    }));
}