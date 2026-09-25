// dsh-tingxue test/segment.test.mjs — 分段器单元测试（纯逻辑，node 直跑）
// 验证 2000 字符边界与句末切分。
import assert from 'node:assert/strict'
import { segmentText, countCodepoints } from '../src/segment.mjs'

let passed = 0
const ok = (name) => { passed += 1; console.log('  ✓', name) }

// 1. 短文本：单段原样，≤ 预算
{
  const segs = segmentText('你好，听雪。')
  assert.equal(segs.length, 1)
  assert.equal(segs[0], '你好，听雪。')
  ok('短文本单段原样')
}

// 2. 边界：正好 2000 码点 → 不加前缀单段
{
  const s = '你'.repeat(2000)
  const segs = segmentText(s)
  assert.equal(segs.length, 1)
  assert.ok(countCodepoints(segs[0]) <= 2000)
  ok(`2000 码点整 → 单段（len=${countCodepoints(segs[0])}）`)
}

// 3. 超预算：段与段之间在句末分隔符后切，不留半截句
{
  // 预算足够容纳单个短句，验证句末切分 + 每段 ≤ 预算（前缀计入）
  const segs = segmentText('今天天气很好。我们出去玩吧！你喜欢听雪吗？', {
    maxCodepoints: 20,
  })
  for (let i = 0; i < segs.length; i++) {
    const body = segs[i].replace(/^（\d+\/\d+）/, '')
    if (i < segs.length - 1) {
      assert.ok(/[。？！…!?]$/.test(body), `第 ${i + 1} 段应以句末收尾，实际: ${JSON.stringify(body)}`)
    }
    assert.ok(countCodepoints(segs[i]) <= 20, `段 ${i + 1} 超预算: ${countCodepoints(segs[i])}`)
  }
  assert.ok(segs.length > 1)
  ok('多句超预算 → 句末切分、段不含半截句')
}

// 3b. 单句长于整段预算：无法整句下移，则退化为边界/硬切，但绝不丢字符
{
  const long = '这'.repeat(50) + '。' + '后句。'
  const segs = segmentText(long, { maxCodepoints: 20 })
  const joinedBody = segs.map((s) => s.replace(/^（\d+\/\d+）/, '')).join('')
  assert.equal(joinedBody, long, '分段后拼接必须等于原文（不丢字符）')
  for (const s of segs) assert.ok(countCodepoints(s) <= 20)
  ok('超长单句：拼接还原不丢字符，段 ≤ 预算')
}

// 4. 关键场景：边界处句末在中间 → 末尾未完成句整体下移，不留半截
{
  // budget 2000；前 1995 字无句末（全 '前'），末尾是 10 字完整句（共 2005 > 2000）
  const front = '前'.repeat(1995)
  const tail = '这是要下移的句子。'
  const full = front + tail
  assert.ok(countCodepoints(full) > 2000)
  const segs = segmentText(full)
  assert.ok(segs.length >= 2)
  // 段拼接必须还原原文
  const joined = segs.map((s) => s.replace(/^（\d+\/\d+）/, '')).join('')
  assert.equal(joined, full)
  // 末尾未完成句必须完整落在最后一段（不被硬切），且每段 ≤ 预算
  const lastBody = segs[segs.length - 1].replace(/^（\d+\/\d+）/, '')
  assert.ok(lastBody.includes('这是要下移的句子。'), `末尾整句应整体下移，实际: ${JSON.stringify(lastBody)}`)
  for (const s of segs) assert.ok(countCodepoints(s) <= 2000, `段超预算: ${countCodepoints(s)}`)
  ok('边界处未完成句整体下移（不留半截句）')
}

// 4b. 窗口内存在句末 → 在最近的句末后切，后半未完成部分移到下一条
{
  const s = '完整的句子一个。' + '未' + '完'.repeat(30) + '结尾句。'
  const segs = segmentText(s, { maxCodepoints: 20 })
  // 第一段（去掉前缀）应以句末收尾
  const firstBody = segs[0].replace(/^（\d+\/\d+）/, '')
  assert.ok(/[。？！…!?]$/.test(firstBody), `首段应以句末收尾: ${JSON.stringify(firstBody)}`)
  const joined = segs.map((x) => x.replace(/^（\d+\/\d+）/, '')).join('')
  assert.equal(joined, s)
  ok('窗口内从句末后切，未完成部分下移')
}

// 5. 单段预算内放得多（含前缀收敛）；段号前缀计入预算
{
  const segs = segmentText('A'.repeat(4000), { maxCodepoints: 2000 })
  for (const s of segs) assert.ok(countCodepoints(s) <= 2000, `前缀计入预算: ${countCodepoints(s)}`)
  ok('4000 字符 → 前缀计入预算且每段 ≤2000')
}

// 6. 无句末的长串 → 退化为空格/换行/硬切，段 ≤ 预算
{
  const segs = segmentText('X'.repeat(2500), { maxCodepoints: 2000 })
  for (const s of segs) assert.ok(countCodepoints(s) <= 2000)
  assert.ok(segs.length >= 2)
  ok('无句末长串 → 硬切，每段 ≤2000')
}

// 7. 多行文本：优先句末再换行
{
  const segs = segmentText('第一段。\n第二段。\n第三段。', { maxCodepoints: 5 })
  let lastEndsSentence = true
  for (const s of segs) {
    const body = s.replace(/^（\d+\/\d+）/, '')
    if (countCodepoints(segs[segs.length - 1].replace(/^（\d+\/\d+）/, '')) === countCodepoints(body) && segs[segs.length - 1].replace(/^（\d+\/\d+）/, '') === body) {
      // 末段不强制句末
    } else {
      assert.ok(/[。？！…!?]$/.test(body), `段应以句末收尾: ${JSON.stringify(body)}`)
    }
  }
  void lastEndsSentence
  ok('多行文本句末切分')
}

console.log(`\n${passed} 个用例全部通过。`)
