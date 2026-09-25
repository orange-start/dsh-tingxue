// 图谱面板独立测试：用假 store 启动 HTTP 服务，验证 / 和 /graph-data.json。
import { createGraphDashboard } from '../src/graph-dashboard/index.mjs'

const fakeStore = {
  async listAllEntities() {
    return [
      { id: 'e1', name: '用户', type: 'person', summary: '听雪的主人' },
      { id: 'e2', name: '咖啡', type: 'thing', summary: '用户喜欢的饮品' },
      { id: 'e3', name: '编程', type: 'concept', summary: '用户的工作' },
    ]
  },
  async listAllRelations() {
    return [
      { id: 'r1', sourceId: 'e1', targetId: 'e2', relation: '喜欢' },
      { id: 'r2', sourceId: 'e1', targetId: 'e3', relation: '从事' },
    ]
  },
}

const dash = createGraphDashboard({ store: fakeStore, config: { graphDashboardPort: 8799 }, logger: console })
const url = await dash.start()
console.log('URL:', url)

// 测试 /graph-data.json
const dataRes = await fetch(url + '/graph-data.json')
const data = await dataRes.json()
console.log('nodes:', data.nodes.length, 'edges:', data.edges.length)
console.log('node[0]:', JSON.stringify(data.nodes[0]))
console.log('edge[0]:', JSON.stringify(data.edges[0]))

// 测试 /
const htmlRes = await fetch(url + '/')
const html = await htmlRes.text()
console.log('html length:', html.length)
console.log('has canvas:', html.includes('canvas'))
console.log('has force:', html.includes('force') || html.includes('tick'))

await dash.stop()
console.log('stopped OK')
