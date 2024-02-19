import { Context, Logger, Quester, Schema, h, version } from 'koishi'
import { toAvid } from './utils'

// av -> 6 avid -> 8 bv -> 9
const VIDEO_REGEX = /(((https?:\/\/)?(www.|m.)?bilibili.com\/(video\/)?)?((av|AV)(\d+)|((BV|bv)1[1-9A-NP-Za-km-z]{9})))/
// value -> 4
const B23_REGEX = /((https?:\/\/)?(b23.tv|bili2233.cn)\/(((av|ep|ss)\d+)|BV1[1-9A-NP-Za-km-z]{9}|\S{6,7}))/
// from https://gist.github.com/dperini/729294
const URL_REGEX = /(?:(?:(?:https?|ftp):)?\/\/)?(?:(?:[a-z0-9\u00a1-\uffff][a-z0-9\u00a1-\uffff_-]{0,62})?[a-z0-9\u00a1-\uffff]\.)+(?:[a-z\u00a1-\uffff]{2,}\.?)(?::\d{2,5})?(?:[/?#]\S*)?/ig

export interface Config {
  behavior: 'text' | 'mixed' | 'image'
  maxline: number
  urlExtract: boolean
}

export const Config: Schema<Config> = Schema.object({
  behavior: Schema.union([
    Schema.const('text').description('直接发送，按行数截断'),
    Schema.const('mixed').description('超过行数则渲染成图片发送'),
    Schema.const('image').description('渲染成图片发送'),
  ]).description('简介的渲染行为，没有 puppeteer 时回退到文本').role('radio').default('mixed'),
  maxline: Schema.number().default(5).description('简介的最大行数，设置为 0 则不限制'),
  urlExtract: Schema.boolean().default(false).description('发图时提取链接以文本发送'),
})

const template = `<html>
<head>
<meta charset="utf-8">
<style>
body{
  font-size: 1.3rem;
  padding: 2rem;
  background: #fff;
  background-size: cover;
  background-repeat: no-repeat;
  background-position: center center;
}
.text-card{
  padding: 0.8rem 2rem;
  background: rgba(255, 255, 255, 0.6);
  border-radius: 16px;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.1), 0 2px 4px rgba(0, 0, 0, 0.1);
  backdrop-filter: blur(10)
}
</style>
</head>
<body style="display: inline-block">
<div class="text-card">
{placeholder}
</div>
</body>
</html>`

const logger = new Logger('bilibili/url')

export function apply(ctx: Context, config: Config) {
  async function render(data: any) {
    const { bvid, aid } = data
    const up = (data.staff ?? []).map(staff => staff.name).join('/') || data.owner.name
    const date = (new Date(data.pubdate * 1000)).toLocaleString()
    let summary = `
标题: ${data.title}
UP 主: ${up} |  发布时间: ${date}
点赞: ${data.stat.like} | 硬币: ${data.stat.coin} | 收藏: ${data.stat.favorite}
播放: ${data.stat.view} | 弹幕: ${data.stat.danmaku} | 评论: ${data.stat.reply}\n\n`
    const desc: string = data.desc
    let newDesc: string | h[]
    let urls: string
    const lines = desc.split('\n')
    const renderText = config.behavior === 'text' || !ctx.puppeteer
      || config.behavior === 'mixed' && lines.length <= config.maxline
    if (renderText) {
      if (config.maxline === 0) {
        newDesc = desc
      } else {
        newDesc = lines.slice(0, config.maxline).join('\n')
      }
    } else {
      const html = template.replace('{placeholder}', lines.reduce((x, acc) => x + `<div>${acc}</div>`, ''))
      newDesc = h.parse(await ctx.puppeteer.render(html))
      if (config.urlExtract) {
        urls = desc.match(URL_REGEX)?.join('\n') || ''
      }
    }
    return <>
      {`https://bilibili.com/video/av${aid}`}
      <image url={data.pic} />
      {summary}
      {newDesc}
      {urls}
    </>
  }
  ctx.middleware(async ({ elements }, next) => {
    try {
      for (const element of elements) {
        let url
        if (element.type === 'text') {
          url = element.attrs.content
        } else if (element.type === 'json') {
          const { detail_1, news } = JSON.parse(element.attrs.data).meta
          if (detail_1) url = detail_1.qqdocurl
          if (news) url = news.jumpUrl
        }
        const vid = await testVideo(url, ctx.http)
        if (!vid) return next()
        if (/bv/i.test(vid)) {
          url = `https://api.bilibili.com/x/web-interface/view?bvid=${vid}`
        } else {
          url = `https://api.bilibili.com/x/web-interface/view?aid=${vid}`
        }
        const res = await ctx.http.get(url)
        if (res.code !== 0) throw new Error(`Failed to get video info. ${JSON.stringify(res)}}`)
        return await render(res.data)
      }
    } catch (e) {
      logger.error('请求时发生异常: ', e)
    }
    return next()
  })
}

async function testVideo(content: string, http: Quester): Promise<string> {
  let match: RegExpExecArray
  if (match = B23_REGEX.exec(content)) {
    const url = await parseB23(match[4], http)
    return await testVideo(url, http)
  } else if (match = VIDEO_REGEX.exec(content)) {
    return match[8] || toAvid(match[9])
  }
}

async function parseB23(value: string, http: Quester): Promise<string> {
  const result = await http(`https://b23.tv/${value}`, { redirect: 'manual' })
  if (result.status !== 302) return
  return result.headers.get('location')
}
