import { Dict } from 'koishi'

const table = 'fZodR9XQDSUm21yCkr6zBqiveYah8bt4xsWpHnJE7jL5VG3guMTKNPAwcF'
const tr = table.split('').reduce((acc, x, i) => ({ ...acc, [x]: i }), {} as Dict<number>)
const s = [11, 10, 3, 8, 4, 6]

export function toAvid(bvid: string) {
  let r = 0
  for (let i = 0; i < 6; i++) {
    r += tr[bvid[s[i]]] * Math.pow(58, i)
  }
  r = (r - 8728348608) ^ 177451812
  if (r > 0) return r.toString()
  return bvid
}
