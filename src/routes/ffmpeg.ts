import type { Context } from 'hono'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const DANGEROUS_PATTERN = /[`$|;&]|\.\.\/|\.\.\\|file:|\/dev\/|\/proc\/|\/sys\/|\/etc\//i

function validateArgs(args: string[]): { valid: boolean; reason?: string } {
  for (const arg of args) {
    if (DANGEROUS_PATTERN.test(arg)) {
      return { valid: false, reason: `Dangerous pattern in argument: ${arg}` }
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

function executeFfmpeg(cliArgs: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false

    console.log(`[ffmpeg] Running: ffmpeg ${cliArgs.join(' ')}`)

    const proc = spawn('ffmpeg', cliArgs, { stdio: ['ignore', 'pipe', 'pipe'] })

    let stdout = ''
    let stderr = ''

    proc.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      console.error('[ffmpeg] Process timed out after 120s, killing')
      proc.kill('SIGKILL')
      reject(new Error('FFmpeg timed out after 120 seconds'))
    }, 120_000)

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      if (code === 0) {
        console.log('[ffmpeg] Process exited successfully')
        if (stderr) console.log(`[ffmpeg] stderr output:\n${stderr.slice(-2000)}`)
        resolve(stderr)
      } else {
        console.error(`[ffmpeg] Process exited with code ${code}`)
        if (stderr) console.error(`[ffmpeg] stderr:\n${stderr.slice(-2000)}`)
        reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`))
      }
    })

    proc.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.error(`[ffmpeg] Failed to spawn process: ${err.message}`)
      reject(new Error(`Failed to start FFmpeg: ${err.message}`))
    })
  })
}

export async function ffmpegHandler(c: Context) {
  let tmpDir: string | null = null

  try {
    console.log('[ffmpeg] Received request')

    const formData = await c.req.parseBody({ all: true })

    const file = formData['file']
    if (!file || !(file instanceof File)) {
      console.warn('[ffmpeg] Missing or invalid "file" field')
      return c.json({ error: 'Missing required "file" field' }, 400)
    }

    console.log(`[ffmpeg] File: ${file.name} (${file.size} bytes, ${file.type})`)

    // Parse args from query string (space or + separated) OR form body (JSON array)
    const queryArgs = c.req.query('args')
    const argsRaw = formData['args']
    let userArgs: string[] = []

    if (queryArgs) {
      // Query param: split by space (+ gets decoded to space in URLs)
      userArgs = queryArgs.split(/\s+/).filter(Boolean)
      console.log(`[ffmpeg] Args from query string: ${JSON.stringify(userArgs)}`)
    } else if (argsRaw && typeof argsRaw === 'string') {
      try {
        const parsed = JSON.parse(argsRaw)
        if (!Array.isArray(parsed) || !parsed.every((a: unknown) => typeof a === 'string')) {
          console.warn('[ffmpeg] args must be a JSON string array')
          return c.json({ error: '"args" must be a JSON array of strings' }, 400)
        }
        userArgs = parsed
      } catch {
        console.warn('[ffmpeg] Invalid JSON in args field')
        return c.json({ error: 'Invalid JSON in "args" field' }, 400)
      }
    }

    console.log(`[ffmpeg] User args: ${JSON.stringify(userArgs)}`)

    // Get output format from query string or form body
    const outputFormat = c.req.query('format') || (formData['outputFormat'] as string) || 'mp4'
    if (!/^[a-zA-Z0-9]+$/.test(outputFormat)) {
      console.warn(`[ffmpeg] Invalid output format: ${outputFormat}`)
      return c.json({ error: 'Invalid output format — must be alphanumeric (e.g. "mp4", "webm")' }, 400)
    }

    console.log(`[ffmpeg] Output format: ${outputFormat}`)

    // Validate all user args for dangerous patterns
    const check = validateArgs(userArgs)
    if (!check.valid) {
      console.warn(`[ffmpeg] Validation failed: ${check.reason}`)
      return c.json({ error: 'Invalid arguments', details: check.reason }, 400)
    }

    // Create temp directory
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ffmpeg-'))
    const inputExt = path.extname(file.name || 'input.bin') || '.bin'
    const inputPath = path.join(tmpDir, `input${inputExt}`)
    const outputPath = path.join(tmpDir, `output.${outputFormat}`)

    console.log(`[ffmpeg] Temp dir: ${tmpDir}`)
    console.log(`[ffmpeg] Input path: ${inputPath}`)
    console.log(`[ffmpeg] Output path: ${outputPath}`)

    // Write input file
    const buffer = Buffer.from(await file.arrayBuffer())
    await fs.writeFile(inputPath, buffer)
    console.log(`[ffmpeg] Wrote ${buffer.length} bytes to input file`)

    // Filter out -y and output filename patterns from user args (we handle those)
    const filteredArgs = userArgs.filter(arg => 
      arg !== '-y' && 
      !arg.match(/^output\.(mp4|wav|mp3|webm|mkv|avi|mov|flv|ogg|flac|m4a|gif|png|jpg|jpeg|webp)$/i)
    )
    console.log(`[ffmpeg] Filtered args: ${JSON.stringify(filteredArgs)}`)

    // Build final command: ffmpeg -y -i <input> [user args for output options] <output>
    const cliArgs = ['-y', '-i', inputPath, ...filteredArgs, outputPath]

    // Execute FFmpeg
    await executeFfmpeg(cliArgs)

    // Read output
    const stat = await fs.stat(outputPath)
    console.log(`[ffmpeg] Output file size: ${stat.size} bytes`)

    if (stat.size > MAX_OUTPUT_SIZE) {
      console.warn(`[ffmpeg] Output exceeds 500MB limit (${stat.size} bytes)`)
      return c.json({ error: 'Output file exceeds 500MB limit' }, 413)
    }

    const outputBuffer = await fs.readFile(outputPath)
    const contentType = MIME_MAP[outputFormat] || 'application/octet-stream'

    console.log(`[ffmpeg] Returning ${outputBuffer.length} bytes as ${contentType}`)

    return new Response(outputBuffer, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Disposition': `attachment; filename="output.${outputFormat}"`,
        'Content-Length': String(outputBuffer.length),
      },
    })
  } catch (error) {
    console.error('[ffmpeg] Processing error:', error)
    return c.json({
      error: 'FFmpeg processing failed',
      details: error instanceof Error ? error.message : 'Unknown error',
    }, 500)
  } finally {
    if (tmpDir) {
      console.log(`[ffmpeg] Cleaning up temp dir: ${tmpDir}`)
      fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
  }
}
