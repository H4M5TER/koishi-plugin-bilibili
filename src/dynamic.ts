import { Argv, Channel, Context, Dict, h, Logger, Quester, Schema } from 'koishi'
import { } from 'koishi-plugin-puppeteer'
import { Page } from 'puppeteer-core'

declare module '.' {
  interface BilibiliChannel {
    dynamic?: DynamicNotifiction[]
  }
}

interface DynamicNotifiction {
  botId: string
  bilibiliId: string
  atAll: boolean
  // The time won't be presisted in database.
  // We just find a place to record the time.
  lastUpdated?: number
}

type DynamicContent = {
  DYNAMIC_TYPE_AV: {
    major: {
      archive: {
        title: string
        cover: string
      }
    }
  }
  DYNAMIC_TYPE_DRAW: {
    desc: {
      text: string
    }
    major: {
      draw: {
        items: {
          src: string
        }[]
      }
    }
  }
  DYNAMIC_TYPE_WORD: {
    desc: {
      text: string
    }
  }
  DYNAMIC_TYPE_FORWARD: {
    desc: {
      text: string
    }
  }
  DYNAMIC_TYPE_LIVE_RCMD: {
    major: {
      live_rcmd: {
        content: string
      }
    }
  }
}

type BilibiliDynamicItem<T extends keyof DynamicContent = keyof DynamicContent> = T extends infer P ? {
  id_str: string
  type: P
  orig: T extends 'DYNAMIC_TYPE_LIVE_RCMD' ? BilibiliDynamicItem : never
  modules: {
    module_author: {
      name: string
      pub_ts: number
    }
    module_dynamic: DynamicContent[T]
  }
} : never

export interface LivePlayInfo {
  title: string
  cover: string
  link: string
}

const DynamicTypes: (keyof DynamicContent)[] = [
  'DYNAMIC_TYPE_AV',
  'DYNAMIC_TYPE_DRAW',
  'DYNAMIC_TYPE_WORD',
  'DYNAMIC_TYPE_FORWARD',
  'DYNAMIC_TYPE_LIVE_RCMD',
]
export interface Config {
  interval: number
  image: boolean
  allow: (keyof DynamicContent)[]
  cookie: string
}

export const Config: Schema<Config> = Schema.object({
  interval: Schema.number().description('请求之间的间隔 (秒)。').default(10),
  image: Schema.boolean().description('是否渲染为图片 (该选项依赖 puppeteer 插件)。').default(true),
  allow: Schema.array(Schema.union([
    Schema.const('DYNAMIC_TYPE_AV').description('视频'),
    Schema.const('DYNAMIC_TYPE_DRAW').description('相簿'),
    Schema.const('DYNAMIC_TYPE_WORD').description('文字'),
    Schema.const('DYNAMIC_TYPE_FORWARD').description('转发'),
    Schema.const('DYNAMIC_TYPE_LIVE_RCMD').description('开播'),
  ])).default(DynamicTypes).role('checkbox').description('选择发送哪些类型的动态'),
  cookie: Schema.string().default(''),
})

export const logger = new Logger('bilibili/dynamic')

export async function apply(ctx: Context, config: Config) {
  const channels = await ctx.database.get('channel', {}, ['id', 'guildId', 'platform', 'bilibili'])
  const list = channels.filter(channel => channel.bilibili.dynamic).reduce((acc, x) => {
    x.bilibili.dynamic.forEach(notification => {
      (acc[notification.bilibiliId] ||= []).push([x, notification])
    })
    return acc
  }, {} as Dict<[Pick<Channel, 'id' | 'guildId' | 'platform' | 'bilibili'>, DynamicNotifiction][]>)

  ctx.guild().command('bilibili/dynamic.add <uid:string>', '添加对 B 站用户的动态的监听', { checkArgCount: true, authority: 2 })
    .option('at', '--at', { fallback: false })
    .channelFields(['id', 'guildId', 'platform', 'bilibili'])
    .before(checkDynamic)
    .action(async ({ session, options }, uid) => {
      if (session.channel.bilibili.dynamic.find(notification => notification.bilibiliId === uid)) {
        return '该用户已在监听列表中。'
      }
      try {
        await request(uid, ctx.http, config)
      } catch (e) {
        logger.error(e)
        return '请求失败，请检查 UID 是否正确或重试。'
      }
      const notification: DynamicNotifiction = {
        botId: `${session.platform}:${session.bot.userId || session.bot.selfId}`,
        bilibiliId: uid,
        atAll: options.at,
      }
      session.channel.bilibili.dynamic.push(notification)
      ; (list[uid] ||= []).push([{
        id: session.channel.id,
        guildId: session.channel.guildId,
        platform: session.platform,
        bilibili: session.channel.bilibili,
      }, notification])
      return '添加成功。'
    })

  ctx.guild().command('bilibili/dynamic.remove <uid:string>', '删除对 B 站用户的动态监听', { checkArgCount: true, authority: 2 })
    .channelFields(['id', 'guildId', 'platform', 'bilibili'])
    .before(checkDynamic)
    .action(({ session }, uid) => {
      const { channel } = session
      const index = channel.bilibili.dynamic
        .findIndex(notification => notification.bilibiliId === uid)
      if (index === -1) return '该用户不在监听列表中。'
      channel.bilibili.dynamic.splice(index, 1)
      const listIndex = list[uid]
        .findIndex(([{ id, guildId, platform }, notification]) => {
          return channel.id === id
            && channel.guildId === guildId
            && channel.platform === platform
            && notification.bilibiliId === uid
        })
      if (listIndex === -1) throw new Error('Data is out of sync.')
      list[uid].splice(listIndex, 1)
      return '删除成功。'
    })

  ctx.guild().command('bilibili/dynamic.list', '列出当前监听 B 站用户列表', { authority: 2 })
    .channelFields(['bilibili'])
    .before(checkDynamic)
    .action(({ session }) => {
      if (session.channel.bilibili.dynamic.length === 0) return '监听列表为空。'
      return session.channel.bilibili.dynamic
        .map(notification => '·' + notification.bilibiliId).join('\n')
    })

  async function* listen() {
    while (true) {
      const entries = Object.entries(list)
      if (entries.length === 0) {
        yield
        continue
      }
      for (const [uid, notifications] of entries) {
        if (notifications.length === 0) continue
        const time = notifications[0][1].lastUpdated
        try {
          const items = await request(uid, ctx.http, config)
          // setup time on every start up
          if (!notifications[0][1].lastUpdated) {
            notifications.forEach(([, notification]) =>
              notification.lastUpdated = items[0]?.modules.module_author.pub_ts || Math.ceil(+new Date() / 1000))
            continue
          }
          const neo = items.filter(item => item.modules.module_author.pub_ts > time)
            .filter(item => config.allow.some(type => item.type === type))
          if (neo.length !== 0) {
            let rendered: string[]
            if (ctx.puppeteer && config.image) {
              rendered = await Promise.all(neo.map(item => renderImage(ctx, item)))
            } else {
              rendered = neo.map(renderText)
            }
            rendered.forEach((text, index) => {
              notifications.forEach(([channel, notification]) => {
                notification.lastUpdated = neo[index].modules.module_author.pub_ts
                let msg = text
                if (notification.atAll) { msg = h.at('all').toString() + msg }
                const bot = ctx.bots[notification.botId]
                bot.sendMessage(channel.id, msg, channel.guildId)
              })
            })
          }
        } catch (e) {
          logger.error(e)
        }
        yield
      }
    }
  }

  const generator = listen()
  ctx.setInterval(async () => {
    await generator.next()
  }, config.interval * 1000)
}

function checkDynamic({ session }: Argv<never, 'bilibili'>) {
  session.channel.bilibili.dynamic ||= []
}

async function request(uid: string, http: Quester, config: Config): Promise<BilibiliDynamicItem[]> {
  const res = await http.get('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/space?host_mid=' + uid, {
    headers: {
      'Cookie': config.cookie,
    },
  })
  if (res.code !== 0) throw new Error(`Failed to get dynamics. ${JSON.stringify(res)}`)
  return (res.data.items as BilibiliDynamicItem[])
    .sort((a, b) => b.modules.module_author.pub_ts - a.modules.module_author.pub_ts)
}

async function renderImage(ctx: Context, item: BilibiliDynamicItem): Promise<string> {
  let page: Page
  try {
    page = await ctx.puppeteer.page()
    await page.setViewport({ width: 1920 * 2, height: 1080 * 2 })
    await page.goto(`https://t.bilibili.com/${item.id_str}`)
    await page.waitForNetworkIdle()
    await (await page.$('.login-tip'))?.evaluate(e => e.remove())
    await (await page.$('.bili-dyn-item__panel')).evaluate(e => e.remove())
    await page.evaluate(() => {
      let popover: any
      while (popover = document.querySelector('.van-popover')) popover.remove()
    })
    const element = await page.$('.bili-dyn-item')
    if (item.type === 'DYNAMIC_TYPE_LIVE_RCMD') {
      const info: LivePlayInfo = JSON.parse(item.modules.module_dynamic.major.live_rcmd.content).live_play_info
      return `${item.modules.module_author.name} 开始直播: ${info.title}\n`
        + h.image(await element.screenshot())
        + `\n${info.link}`
    } else {
      return `${item.modules.module_author.name} 发布了动态:\n`
        + h.image(await element.screenshot())
        + `\nhttps://t.bilibili.com/${item.id_str}`
    }
  } finally {
    page?.close()
  }
}

function renderText(item: BilibiliDynamicItem): string {
  const author = item.modules.module_author
  let result: string
  if (item.type === 'DYNAMIC_TYPE_AV') {
    const dynamic = item.modules.module_dynamic
    result = `${author.name} 发布了视频:\n${dynamic.major.archive.title}\n<image url="${dynamic.major.archive.cover}"/>`
  } else if (item.type === 'DYNAMIC_TYPE_DRAW') {
    const dynamic = item.modules.module_dynamic
    result = `${author.name} 发布了动态:\n${dynamic.desc.text}\n${dynamic.major.draw.items.map(item =>
      `<image url="${item.src}"/>`).join('')}`
  } else if (item.type === 'DYNAMIC_TYPE_WORD') {
    const dynamic = item.modules.module_dynamic
    result = `${author.name} 发布了动态:\n${dynamic.desc.text}`
  } else if (item.type === 'DYNAMIC_TYPE_FORWARD') {
    const dynamic = item.modules.module_dynamic
    result = `${author.name} 转发动态:\n${dynamic.desc.text}\n${renderText(item.orig)}`
  } else if (item.type === 'DYNAMIC_TYPE_LIVE_RCMD') {
    const dynamic = item.modules.module_dynamic
    const info: LivePlayInfo = JSON.parse(dynamic.major.live_rcmd.content).live_play_info
    result = `${author.name} 开始直播:\n${info.title}`
    if (info.cover) result += `\n${h.image(info.cover)}`
  } else {
    result = `${author.name} 发布了未知类型的动态: ${item['type']}`
  }
  return result + `\nhttps://t.bilibili.com/${item.id_str}`
}
