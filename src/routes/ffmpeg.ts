import type { Context } from 'hono'
import Ffmpeg from 'fluent-ffmpeg'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

export interface FfmpegArgs {
  outputOptions?: string[]
  inputOptions?: string[]
  audioCodec?: string
  videoCodec?: string
  videoBitrate?: string
  audioBitrate?: string
  duration?: number
  seekInput?: number
  size?: string
  fps?: number
  noAudio?: boolean
  noVideo?: boolean
  format?: string
}

const DANGEROUS_PATTERN = /[`$|;&]|\.\.\/|\.\.\\|file:|\/dev\/|\/proc\/|\/sys\/|\/etc\//i

function validateOptionValue(value: string): boolean {
  return !DANGEROUS_PATTERN.test(value)
}

function validateOptions(options: string[]): { valid: boolean; reason?: string } {
  for (let i = 0; i < options.length; i++) {
    const token = options[i]
    if (!validateOptionValue(token)) {
      return { valid: false, reason: `Dangerous pattern in value: ${token}` }
    }
  }
  return { valid: true }
}

const MIME_MAP: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  flv: 'video/x-flv',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  gif: 'image/gif',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
}

const MAX_OUTPUT_SIZE = 500 * 1024 * 1024 // 500MB

function executeFfmpeg(inputPath: string, outputPath: string, args: FfmpegArgs): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let cmd = Ffmpeg(inputPath).output(outputPath)

    if (args.inputOptions?.length) {
      cmd = cmd.inputOptions(args.inputOptions)
    }
    if (args.videoCodec) cmd = cmd.videoCodec(args.videoCodec)
    if (args.audioCodec) cmd = cmd.audioCodec(args.audioCodec)
    if (args.videoBitrate) cmd = cmd.videoBitrate(args.videoBitrate)
    if (args.audioBitrate) cmd = cmd.audioBitrate(args.audioBitrate)
    if (args.duration != null) cmd = cmd.duration(args.duration)
    if (args.seekInput != null) cmd = cmd.seekInput(args.seekInput)
    if (args.size) cmd = cmd.size(args.size)
    if (args.fps != null) cmd = cmd.fps(args.fps)
    if (args.noAudio) cmd = cmd.noAudio()
    if (args.noVideo) cmd = cmd.noVideo()
    if (args.format) cmd = cmd.format(args.format)
    if (args.outputOptions?.length) {
      cmd = cmd.outputOptions(args.outputOptions)
    }

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { (cmd as any).kill('SIGKILL') } catch {}
      reject(new Error('FFmpeg timed out after 120 seconds'))
    }, 120_000)

    cmd
      .on('end', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })
      .on('error', (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      .run()
  })
}

export async function ffmpegHandler(c: Context) {
  let tmpDir: string | null = null

  try {
    const formData = await c.req.parseBody({ all: true })

    const file = formData['file']
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'Missing required "file" field' }, 400)
    }

    const argsRaw = formData['args']
    let args: FfmpegArgs = {}
    if (argsRaw && typeof argsRaw === 'string') {
      try {
        args = JSON.parse(argsRaw)
      } catch {
        return c.json({ error: 'Invalid JSON in "args" field' }, 400)
      }
    }

    const outputFormat = (formData['outputFormat'] as string) || 'mp4'
    if (!/^[a-zA-Z0-9]+$/.test(outputFormat)) {
      return c.json({ error: 'Invalid output format — must be alphanumeric (e.g. "mp4", "webm")' }, 400)
    }

    // Validate inputOptions
    if (args.inputOptions?.length) {
      const check = validateOptions(args.inputOptions)
      if (!check.valid) {
        return c.json({ error: 'Invalid input options', details: check.reason }, 400)
      }
    }

    // Validate outputOptions
    if (args.outputOptions?.length) {
      const check = validateOptions(args.outputOptions)
      if (!check.valid) {
        return c.json({ error: 'Invalid output options', details: check.reason }, 400)
      }
    }

    // Validate string args for dangerous patterns
    for (const key of ['audioCodec', 'videoCodec', 'videoBitrate', 'audioBitrate', 'size', 'format'] as const) {
      const val = args[key]
      if (val && !validateOptionValue(val)) {
        return c.json({ error: `Dangerous pattern in "${key}"`, details: val }, 400)
      }
    }

    // Create temp directory
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-'))
    const inputExt = path.extname(file.name || 'input.bin') || '.bin'
    const inputPath = path.join(tmpDir, `input${inputExt}`)
    const outputPath = path.join(tmpDir, `output.${outputFormat}`)

    // Write input file
    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(inputPath, buffer)

    // Execute FFmpeg
    await executeFfmpeg(inputPath, outputPath, args)

    // Read output
    const stat = await fs.stat(outputPath)
    if (stat.size > MAX_OUTPUT_SIZE) {
      return c.json({ error: 'Output file exceeds 500MB limit' }, 413)
    }

    const outputBuffer = await fs.readFile(outputPath)
    const contentType = MIME_MAP[outputFormat] || 'application/octet-stream'

    return new Response(outputBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="output.${outputFormat}"`,
        'Content-Length': String(outputBuffer.length),
      },
    })
  } catch (error) {
    console.error('FFmpeg processing error:', error)
    return c.json({
      error: 'FFmpeg processing failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  } finally {
    if (tmpDir) {
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
