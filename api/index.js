// api/index.js —— Vercel Serverless Function 入口
// 职责：把整个 Express app 导出成 Vercel 可识别的 handler
//
// Vercel 约定：
//   - 任何 /api/*.js 会被当成 serverless function
//   - 我们把所有路由都交给同一个 Express app 处理
//   - vercel.json 里的 rewrites 会把所有请求（包括 /、/d/:id 等）路由到这里
//
// 为什么不直接让每个路由一个文件？
//   - Express 已经装好了中间件/CSP/速率限制，拆散了要重复写
//   - 冷启动开销集中在一处反而更简单
//   - 单文件 Express app 在 Vercel 上是官方认可的模式

module.exports = require('../server.js');
