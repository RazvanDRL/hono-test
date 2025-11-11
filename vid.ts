import ffmpeg from "fluent-ffmpeg";
import { promises as fs } from "fs";
import path from "path";
import os from "os";

export async function extractFramesEverySecond(
    videoBuffer: Buffer,
    saveDirectory?: string
): Promise<Array<{ timestamp: number; imageBuffer: Buffer; filePath?: string }>> {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "video-frames-"));
    const videoPath = path.join(tempDir, "video.mp4");
    const framesDir = path.join(tempDir, "frames");

    try {
        await fs.writeFile(videoPath, videoBuffer);
        await fs.mkdir(framesDir, { recursive: true });

        const frames: Array<{ timestamp: number; imageBuffer: Buffer; filePath?: string }> = [];

        const finalFramesDir = saveDirectory || framesDir;
        if (saveDirectory) {
            await fs.mkdir(finalFramesDir, { recursive: true });
            console.log(`📁 Saving frames to: ${finalFramesDir}`);
            console.log(`📁 Absolute path: ${path.resolve(finalFramesDir)}`);
        }

        await new Promise<void>((resolve, reject) => {
            ffmpeg(videoPath)
                .outputOptions([
                    "-vf", "fps=1",
                    "-q:v", "2",
                    "-start_number", "0",
                ])
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
            const timestamp = i;

            const stats = await fs.stat(framePath);
            if (stats.size === 0) {
                console.warn(`⚠️ Warning: Frame ${frameFile} is empty (0 bytes)`);
            }

            const frameData: { timestamp: number; imageBuffer: Buffer; filePath?: string } = {
                timestamp,
                imageBuffer,
            };

            if (saveDirectory) {
                frameData.filePath = framePath;
                if (i < 5 || i === sortedFrames.length - 1) {
                    console.log(`  ✓ Frame ${i}: ${frameFile} (${(stats.size / 1024).toFixed(2)} KB) -> ${framePath}`);
                }
            }

            frames.push(frameData);
        }

        if (saveDirectory) {
            console.log(`✅ Successfully saved ${frames.length} frames to ${saveDirectory}`);

            const summaryPath = path.join(finalFramesDir, "frames-summary.txt");
            const summaryContent = `Video Frame Extraction Summary
================================
Total Frames: ${frames.length}
Extraction Date: ${new Date().toISOString()}
Directory: ${finalFramesDir}

Frames:
${frames.map((f, i) => `  ${i}. frame_${String(i).padStart(3, '0')}.jpg (timestamp: ${f.timestamp}s, size: ${(f.imageBuffer.length / 1024).toFixed(2)} KB)`).join('\n')}
`;
            await fs.writeFile(summaryPath, summaryContent);
            console.log(`📄 Created summary file: ${summaryPath}`);
        }

        return frames;
    } finally {
        if (!saveDirectory) {
            try {
                await fs.rm(tempDir, { recursive: true, force: true });
            } catch (cleanupError) {
                console.error("Error cleaning up temporary files:", cleanupError);
            }
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