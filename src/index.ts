import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { extractFramesEverySecond, framesToBase64 } from '../vid.js'

const app = new Hono()

app.get('/', (c) => {
  return c.text('Hello Hono! Upload a video to /extract-from-url to get frames.')
})

app.post('/extract-from-url', async (c) => {
  try {
    const body = await c.req.json()
    const url = body.url

    if (!url || typeof url !== 'string') {
      return c.json({ error: 'No URL provided. Please provide a video URL.' }, 400)
    }

    console.log(`🔗 Processing video from URL: ${url}`)

    const response = await fetch("http://localhost:9000", {
      method: "POST",
      body: JSON.stringify({
        url: url,
      }),
      headers: {
        Authorization: `Bearer cobalt`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const responseData = await response.json();

    if (!responseData) {
      throw new Error("No download URL found in API response");
    }

    const videoTunnel = responseData.url;
    console.log(`📡 Got video download URL: ${videoTunnel}`);

    const videoResponse = await fetch(videoTunnel);

    if (!videoResponse.ok) {
      throw new Error(`Failed to fetch video: ${videoResponse.status}`);
    }

    const arrayBuffer = await videoResponse.arrayBuffer();
    console.log(`✅ Downloaded TikTok video data (${arrayBuffer.byteLength} bytes)`);

    console.log(`🎬 Extracting frames from video (1 frame per second)...`);
    const frames = await extractFramesEverySecond(Buffer.from(arrayBuffer));

    // Convert frames to base64 for easy transfer
    const framesBase64 = framesToBase64(frames)

    return c.json({
      success: true,
      message: `Extracted ${frames.length} frames from video`,
      frames: framesBase64.map(frame => ({
        timestamp: frame.timestamp,
        base64Image: `data:image/jpeg;base64,${frame.base64}`
      }))
    })
  } catch (error) {
    console.error('Error extracting frames from URL:', error)
    return c.json({
      error: 'Failed to extract frames from URL',
      details: error instanceof Error ? error.message : 'Unknown error'
    }, 500)
  }
})


serve({
  fetch: app.fetch,
  port: 3000
}, (info) => {
  console.log(`Server is running on http://localhost:${info.port}`)
  console.log(`\nEndpoints:`)
  console.log(`  POST /extract-from-url - Download video from URL and extract frames`)
})
