import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { materialsRoutes } from './routes.ts'
import { settingsRoutes } from './settings-routes.ts'
import { assistRoutes } from './assist-routes.ts'
import { importRoutes } from './import-routes.ts'
import { lorebookRoutes } from './lorebook-routes.ts'
import { playthroughRoutes } from './playthrough-routes.ts'

const app = new Hono()

app.route('/api/materials', materialsRoutes)
app.route('/api/settings', settingsRoutes)
app.route('/api/assist', assistRoutes)
app.route('/api/import', importRoutes)
app.route('/api/lorebooks', lorebookRoutes)
app.route('/api/playthroughs', playthroughRoutes)

app.get('/api/health', (c) => c.json({ ok: true }))

// 生产构建后由同一个进程托管前端；开发时走 Vite 的 proxy
app.use('/*', serveStatic({ root: './dist' }))

const port = Number(process.env.PORT ?? 8787)

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`话本 · 服务已启动 http://127.0.0.1:${info.port}`)
})
