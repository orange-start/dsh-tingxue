// dsh-tingxue src/graph-dashboard/index.mjs
// 可交互关系图谱可视化面板（蜘蛛网样式，零外部依赖，离线可用）。
//  - 自绘 force-directed 力导向图（原生 canvas，无需 CDN / 无网络）。
//  - 交互：以鼠标为中心缩放（滚轮）、拖动节点、空白拖动平移、点击节点看详情、
//          右下角回中按钮 + 放大/缩小按钮、搜索高亮、hover 高亮、按类型着色。
//  - 美术：深色渐变背景、发光节点、平滑动画、圆角面板、柔和配色。
//  - 端点：/graph-data.json（图谱数据）、/（UI）。
//  - 仅监听 loopback（127.0.0.1），本机浏览器打开，不暴露公网。
//  - 力导向物理参数集中在脚本顶部常量区，便于调参。

import { createServer } from 'node:http'
import { findPort, sendJson } from '../http/index.mjs'

export function createGraphDashboard({ store, config = {}, logger } = {}) {
  const warn = (m) => { try { logger?.warn?.('[dsh-tingxue/dashboard]', m) } catch {} }
  const info = (m) => { try { logger?.info?.('[dsh-tingxue/dashboard]', m) } catch {} }

  const host = config.graphDashboardHost ?? '127.0.0.1'
  const port = config.graphDashboardPort ?? 8765
  let server = null
  let boundUrl = ''

  /** 收集图谱数据：节点 + 边。 */
  async function collectGraphData() {
    if (!store) return { nodes: [], edges: [] }
    try {
      const [entities, relations] = await Promise.all([
        store.listAllEntities?.({ limit: 1500 }) ?? [],
        store.listAllRelations?.({ limit: 6000 }) ?? [],
      ])
      const byId = new Map(entities.map((e) => [e.id, e]))
      const edges = relations
        .filter((r) => byId.has(r.sourceId) && byId.has(r.targetId))
        .map((r) => ({ id: r.id, from: r.sourceId, to: r.targetId, label: r.relation }))
      const nodes = entities.map((e) => ({
        id: e.id, name: e.name, type: e.type ?? 'concept', summary: e.summary ?? '',
      }))
      return { nodes, edges }
    } catch (e) {
      warn(`收集图谱数据失败: ${e.message}`)
      return { nodes: [], edges: [] }
    }
  }

  // ---- 零依赖自绘力导向蜘蛛网 UI ----
  const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>听雪 · 关系图谱</title>
<style>
  :root{
    --bg0:#0a0e1a; --bg1:#141a2e; --panel:rgba(20,26,46,.92); --panel2:rgba(30,38,64,.9);
    --text:#eef2fb; --muted:#93a0bd; --accent:#7aa8ff; --accent2:#b48cff;
    --person:#ff8fa3; --place:#5ec8ff; --thing:#c79bff; --concept:#ffd166;
  }
  *{box-sizing:border-box;margin:0;padding:0;}
  html,body{height:100%;}
  body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--text);overflow:hidden;
    background:radial-gradient(1200px 800px at 20% 10%,#1a2340 0%,var(--bg0) 55%),var(--bg0);}
  #top{height:56px;display:flex;align-items:center;gap:14px;padding:0 20px;background:var(--panel);
    border-bottom:1px solid rgba(122,168,255,.15);backdrop-filter:blur(10px);position:relative;z-index:6;}
  #top h1{font-size:16px;font-weight:700;letter-spacing:.5px;white-space:nowrap;
    background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent;}
  .stats{display:flex;gap:18px;font-size:12px;color:var(--muted);white-space:nowrap;}
  .stats b{color:var(--text);font-size:14px;}
  .searchbox{position:relative;margin-left:auto;}
  #search{background:var(--panel2);border:1px solid rgba(122,168,255,.2);color:var(--text);padding:8px 14px 8px 34px;
    border-radius:10px;font-size:13px;outline:none;width:200px;transition:border-color .2s,box-shadow .2s;}
  #search:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(122,168,255,.15);}
  .searchbox::before{content:"⌕";position:absolute;left:12px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:15px;}
  button{background:var(--panel2);border:1px solid rgba(122,168,255,.2);color:var(--text);padding:8px 14px;border-radius:10px;
    cursor:pointer;font-size:13px;transition:all .2s;}
  button:hover{border-color:var(--accent);background:rgba(122,168,255,.15);transform:translateY(-1px);}
  .legend{display:flex;gap:14px;font-size:11px;color:var(--muted);align-items:center;flex-wrap:wrap;margin-left:6px;}
  .legend span{display:inline-flex;align-items:center;gap:5px;}
  .dot{width:10px;height:10px;border-radius:50%;display:inline-block;box-shadow:0 0 6px currentColor;}
  #cv{position:absolute;top:56px;left:0;width:100%;height:calc(100% - 56px);display:block;cursor:grab;}
  #cv.dragging{cursor:grabbing;}
  #loading{position:absolute;top:56px;left:0;width:100%;height:calc(100% - 56px);display:flex;align-items:center;justify-content:center;
    flex-direction:column;gap:16px;color:var(--muted);font-size:14px;background:transparent;z-index:4;}
  #loading .big{font-size:48px;animation:pulse 1.6s ease-in-out infinite;}
  @keyframes pulse{0%,100%{opacity:.5;transform:scale(.95)}50%{opacity:1;transform:scale(1.05)}}
  #side{position:absolute;top:70px;right:16px;width:300px;max-height:calc(100% - 100px);background:var(--panel);
    border:1px solid rgba(122,168,255,.18);border-radius:16px;padding:16px;overflow-y:auto;display:none;
    box-shadow:0 12px 40px rgba(0,0,0,.5);z-index:5;backdrop-filter:blur(12px);animation:slideIn .25s ease;}
  #side.show{display:block;}
  @keyframes slideIn{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:translateX(0)}}
  #side h2{font-size:15px;margin-bottom:8px;color:var(--accent);word-break:break-word;}
  #side h3{font-size:12px;margin:12px 0 6px;color:var(--muted);letter-spacing:.5px;}
  #side .sum{font-size:12.5px;color:var(--text);background:var(--panel2);padding:9px 12px;border-radius:10px;line-height:1.7;margin-bottom:6px;word-break:break-word;}
  #side .sum.rel{cursor:pointer;transition:all .15s;border:1px solid transparent;}
  #side .sum.rel:hover{border-color:var(--accent);background:rgba(122,168,255,.12);transform:translateX(2px);}
  #side .close{position:absolute;top:10px;right:12px;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;padding:4px;}
  #side .close:hover{color:var(--text);}
  .tag{display:inline-block;font-size:10px;padding:2px 9px;border-radius:20px;margin-left:6px;vertical-align:middle;letter-spacing:.5px;}
  .tag.person{background:rgba(255,143,163,.15);color:var(--person)}.tag.place{background:rgba(94,200,255,.15);color:var(--place)}
  .tag.thing{background:rgba(199,155,255,.15);color:var(--thing)}.tag.concept{background:rgba(255,209,102,.15);color:var(--concept)}
  /* 右下角控制按钮组 */
  #controls{position:absolute;right:18px;bottom:18px;display:flex;flex-direction:column;gap:8px;z-index:6;}
  #controls button{width:42px;height:42px;border-radius:12px;font-size:18px;display:flex;align-items:center;justify-content:center;
    background:var(--panel);border:1px solid rgba(122,168,255,.25);box-shadow:0 4px 16px rgba(0,0,0,.4);}
  #controls button:hover{background:rgba(122,168,255,.2);transform:scale(1.05);}
  #controls .home{font-size:16px;}
  #hint{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);font-size:11px;color:var(--muted);
    background:rgba(10,14,26,.7);padding:6px 16px;border-radius:20px;border:1px solid rgba(122,168,255,.12);white-space:nowrap;z-index:3;pointer-events:none;}
  #toast{position:absolute;left:50%;top:10px;transform:translateX(-50%);background:var(--panel);border:1px solid rgba(122,168,255,.2);
    padding:9px 18px;border-radius:12px;font-size:13px;z-index:9;display:none;box-shadow:0 6px 24px rgba(0,0,0,.5);}
  @media(max-width:760px){.stats,.legend{display:none;}#search{width:120px;}.searchbox{margin-left:0;}}
</style>
</head>
<body>
<div id="top">
  <h1>听雪 · 关系图谱</h1>
  <div class="stats"><span>实体 <b id="stNode">-</b></span><span>关系 <b id="stEdge">-</b></span></div>
  <div class="searchbox"><input id="search" placeholder="搜索实体…"></div>
  <button id="refresh" title="刷新">⟳</button>
  <div class="legend">
    <span><i class="dot" style="background:var(--concept);color:var(--concept)"></i>concept</span>
    <span><i class="dot" style="background:var(--person);color:var(--person)"></i>person</span>
    <span><i class="dot" style="background:var(--place);color:var(--place)"></i>place</span>
    <span><i class="dot" style="background:var(--thing);color:var(--thing)"></i>thing</span>
  </div>
</div>
<div id="toast"></div>
<canvas id="cv"></canvas>
<div id="loading"><div class="big">🕸️</div>正在加载关系图谱…</div>
<div id="side"></div>
<div id="controls">
  <button class="home" id="btnHome" title="回到中心">⌂</button>
  <button id="btnZoomIn" title="放大">+</button>
  <button id="btnZoomOut" title="缩小">−</button>
  <button id="btnMinimap" title="切换小地图模式（标准缩略图 / 鹰眼）">◉</button>
</div>
<div id="hint">滚轮缩放（以鼠标为中心）· 拖动节点 · 空白拖动平移 · 点击节点看关联</div>
<script>
(function(){
"use strict";

// ===== 常量 =====
// 力导向物理参数（集中定义，便于调参）
const REPULSION_FORCE = 3200;      // 斥力强度
const REPULSION_DIST = 260;        // 斥力作用半径：仅该范围内节点对施加斥力（>60 节点不再堆叠）
const SPRING_REST = 90;            // 弹簧理想边长
const SPRING_K = 0.03;             // 弹簧刚度
const DAMPING = 0.85;              // 速度阻尼
const CENTER_X = 0.01, CENTER_Y = 0.008;  // 回中引力
const MAX_VEL = 12;                // 速度钳制上限（防近距离斥力发散抖动）
const MAX_TICKS = 300;             // 初始收敛帧数
const RESUME_TICKS = 90;           // 拖拽松手后继续收敛帧数
const COLORS = { person:'#ff8fa3', place:'#5ec8ff', thing:'#c79bff', concept:'#ffd166' };
const MINIMAP_W = 150, MINIMAP_H = 100;

// ===== DOM 引用 =====
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');
const sidePanel = document.getElementById('side');
const toast = document.getElementById('toast');
const statNode = document.getElementById('stNode');
const statEdge = document.getElementById('stEdge');

// ===== 状态 =====
let graph = { nodes: [], edges: [] };
let nodePos = [];       // 每个节点的世界坐标
let nodeVel = [];       // 每个节点的速度
let nodeIndex = [];     // 节点 id → index
let adjacency = [];     // 邻接表（邻居高亮用）
let clusterCenters = {};
let dragging = -1;      // 当前拖动节点索引（-1 = 未拖动）
let isViewDragging = false;
let lastPointerX = 0, lastPointerY = 0;
let zoom = 1, panX = 0, panY = 0;
let tickCount = 0, animationOn = true;
let hoverIndex = -1;
let minimapMode = 'standard';  // 'standard' | 'eagle'
let staticDrawScheduled = false;

const devicePixelRatio = Math.min(2, window.devicePixelRatio || 1);

/** HTML 转义，防止注入。 */
const escapeHtml = (value) =>
  String(value == null ? '' : value).replace(/[&<>"']/g, (ch) =>
    ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));

/** 节点基半径：随视口尺寸自适应（9–20px）。 */
const getNodeBaseRadius = () =>
  Math.max(9, Math.min(20, Math.min(cv.clientWidth||window.innerWidth, cv.clientHeight||window.innerHeight)/50));

// ===== 画布尺寸 =====
function resizeCanvas() {
  const width = cv.clientWidth || window.innerWidth || 1200;
  const height = cv.clientHeight || window.innerHeight || 720;
  cv.width = width * devicePixelRatio;
  cv.height = height * devicePixelRatio;
}
window.addEventListener('resize', () => { resizeCanvas(); scheduleStaticDraw(); });

// ===== 数据加载 =====
async function loadData() {
  const loadingEl = document.getElementById('loading');
  loadingEl.style.display = 'flex';
  try {
    const response = await fetch('/graph-data.json');
    graph = await response.json();
    initForceLayout();
    resizeCanvas();
    animationOn = true;
    tickCount = 0;
    draw();
    requestAnimationFrame(tick);
    statNode.textContent = graph.nodes.length;
    statEdge.textContent = graph.edges.length;
    if (!graph.nodes.length) {
      loadingEl.innerHTML = '<div class="big" style="font-size:40px">🕸️</div>图谱还是空的 — 和听雪聊聊天，实体关系会慢慢长出来。';
    } else {
      loadingEl.style.display = 'none';
    }
  } catch (err) {
    loadingEl.innerHTML = '<div>加载失败：' + escapeHtml(err.message) + '</div>';
  }
}

// ===== 力导向布局初始化 =====
function initForceLayout() {
  const nodeCount = graph.nodes.length;
  nodePos = new Array(nodeCount);
  nodeVel = new Array(nodeCount);
  nodeIndex = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) nodeIndex[i] = graph.nodes[i].id;

  // 邻接表（用于邻居高亮）
  adjacency = new Array(nodeCount);
  for (let i = 0; i < nodeCount; i++) adjacency[i] = new Set();
  for (const edge of graph.edges) {
    if (edge._s == null || edge._t == null) continue;
    adjacency[edge._s].add(edge._t);
    adjacency[edge._t].add(edge._s);
  }

  // 按类型聚类：每种类型一个簇中心，节点初始围绕各自中心散布
  const typeCount = {};
  for (const node of graph.nodes) {
    const type = node.type || 'concept';
    typeCount[type] = (typeCount[type] || 0) + 1;
  }
  const types = Object.keys(typeCount);
  const centerX = cv.clientWidth / 2;
  const centerY = cv.clientHeight / 2 * 0.9;
  const ringRadius = Math.min(cv.clientWidth, cv.clientHeight) / 2 * 0.42;
  clusterCenters = {};
  types.forEach((type, idx) => {
    const angle = (idx / types.length) * Math.PI * 2;
    clusterCenters[type] = { x: centerX + Math.cos(angle)*ringRadius, y: centerY + Math.sin(angle)*ringRadius };
  });
  const spreadRadius = Math.min(cv.clientWidth, cv.clientHeight) / 2 * 0.4;
  for (let i = 0; i < nodeCount; i++) {
    const type = graph.nodes[i].type || 'concept';
    const center = clusterCenters[type] || { x: centerX, y: centerY };
    const angle = (i / nodeCount) * Math.PI * 2;
    nodePos[i] = {
      x: center.x + Math.cos(angle)*spreadRadius*0.5 + (Math.random()-.5)*40,
      y: center.y + Math.sin(angle)*spreadRadius*0.5 + (Math.random()-.5)*40,
    };
    nodeVel[i] = { x: 0, y: 0 };
  }
  for (const edge of graph.edges) {
    edge._s = nodeIndex.indexOf(edge.from);
    edge._t = nodeIndex.indexOf(edge.to);
  }
}

// ===== 物理模拟 =====
/** 斥力：仅在作用半径内的节点对之间施加。返回参与演算的节点数。 */
function applyRepulsion(nodeCount) {
  // 参与演算的节点数受视口面积限制，避免超大图 O(n²) 卡死
  const activeCount = Math.min(nodeCount, Math.floor(cv.clientWidth * cv.clientHeight * 0.0006));
  for (let i = 0; i < activeCount; i++) {
    const nodeA = nodePos[i];
    for (let j = i + 1; j < activeCount; j++) {
      const nodeB = nodePos[j];
      const dx = nodeA.x - nodeB.x, dy = nodeA.y - nodeB.y;
      const distSq = dx*dx + dy*dy;
      if (distSq >= REPULSION_DIST * REPULSION_DIST) continue; // 作用半径外忽略
      let safeDistSq = distSq < 4 ? 4 : distSq; // 防距离=0 除零/爆炸
      const dist = Math.sqrt(safeDistSq);
      const force = REPULSION_FORCE / safeDistSq;
      const forceX = dx / dist * force, forceY = dy / dist * force;
      nodeVel[i].x += forceX; nodeVel[i].y += forceY;
      nodeVel[j].x -= forceX; nodeVel[j].y -= forceY;
    }
  }
  return activeCount;
}
/** 弹簧力：把相连节点拉向理想边长 SPRING_REST。 */
function applySprings(nodeCount) {
  for (const edge of graph.edges) {
    if (edge._s == null || edge._t == null || edge._s >= nodeCount || edge._t >= nodeCount) continue;
    const a = nodePos[edge._s], b = nodePos[edge._t];
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.sqrt(dx*dx + dy*dy) || 1;
    const force = (dist - SPRING_REST) * SPRING_K;
    const forceX = dx / dist * force, forceY = dy / dist * force;
    nodeVel[edge._s].x += forceX; nodeVel[edge._s].y += forceY;
    nodeVel[edge._t].x -= forceX; nodeVel[edge._t].y -= forceY;
  }
}
/** 积分：回中引力 + 阻尼 + 速度钳制 + 位置更新。 */
function integrate(nodeCount) {
  for (let i = 0; i < nodeCount; i++) {
    nodeVel[i].x += (cv.clientWidth/2 - nodePos[i].x) * CENTER_X;
    nodeVel[i].y += (cv.clientHeight/2 - nodePos[i].y) * CENTER_Y;
    nodeVel[i].x *= DAMPING;
    nodeVel[i].y *= DAMPING;
    const speed = Math.sqrt(nodeVel[i].x*nodeVel[i].x + nodeVel[i].y*nodeVel[i].y);
    if (speed > MAX_VEL) { // 速度钳制，防抖动
      const clampFactor = MAX_VEL / speed;
      nodeVel[i].x *= clampFactor;
      nodeVel[i].y *= clampFactor;
    }
    nodePos[i].x += nodeVel[i].x;
    nodePos[i].y += nodeVel[i].y;
  }
}
/** 每帧动画：按当前动画状态迭代物理模拟一帧。 */
function tick() {
  const nodeCount = graph.nodes.length;
  if (!nodeCount) { requestAnimationFrame(tick); return; }
  if (animationOn) {
    const activeCount = applyRepulsion(nodeCount);
    applySprings(activeCount);
    integrate(activeCount);
    if (++tickCount > MAX_TICKS) animationOn = false;
  }
  draw();
  if (animationOn) requestAnimationFrame(tick);
  else scheduleStaticDraw();
}

// ===== 绘制 =====
function draw() {
  // 固定背景层（屏幕坐标，不随缩放/平移）
  drawGridBackground();
  // 世界内容层（节点/边），应用缩放与平移
  ctx.setTransform(devicePixelRatio*zoom, 0, 0, devicePixelRatio*zoom, devicePixelRatio*panX, devicePixelRatio*panY);
  // 邻居高亮：hover 节点 + 其直达邻居，其余变暗
  const focus = hoverIndex >= 0 ? hoverIndex : -1;
  const highlightSet = new Set();
  if (focus >= 0) {
    highlightSet.add(focus);
    for (const nb of adjacency[focus] || []) highlightSet.add(nb);
  }
  const isDimmedNode = (i) => (focus >= 0 && !highlightSet.has(i));
  drawEdges(focus, highlightSet);
  drawNodes(isDimmedNode);
  drawMinimap();
}
function drawGridBackground() {
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  ctx.clearRect(0, 0, cv.clientWidth, cv.clientHeight);
  ctx.strokeStyle = 'rgba(122,168,255,.05)';
  ctx.lineWidth = 1;
  const step = 60;
  for (let x = 0; x < cv.clientWidth; x += step) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.clientHeight); ctx.stroke();
  }
  for (let y = 0; y < cv.clientHeight; y += step) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(cv.clientWidth, y); ctx.stroke();
  }
}
/** 绘制边（带渐变发光 + hover/聚焦高亮）。 */
function drawEdges(focus, highlightSet) {
  for (const edge of graph.edges) {
    if (edge._s == null || edge._t == null) continue;
    const a = nodePos[edge._s], b = nodePos[edge._t];
    const isHovered = (hoverIndex === edge._s || hoverIndex === edge._t);
    const isFocusEdge = (focus >= 0 && highlightSet.has(edge._s) && highlightSet.has(edge._t));
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    if (isHovered) { ctx.strokeStyle = 'rgba(122,168,255,.6)'; ctx.lineWidth = 2.2/zoom; }
    else if (isFocusEdge) { ctx.strokeStyle = 'rgba(122,168,255,.4)'; ctx.lineWidth = 1.6/zoom; }
    else { ctx.strokeStyle = 'rgba(122,168,255,.22)'; ctx.lineWidth = 1.2/zoom; }
    ctx.stroke();
  }
}
/** 绘制节点与标签（搜索/hover 高亮、标签碰撞避让）。 */
function drawNodes(isDimmedNode) {
  const query = (document.getElementById('search').value || '').trim().toLowerCase();
  const radius = getNodeBaseRadius() * 0.42;
  const labelRects = [];
  for (let i = 0; i < graph.nodes.length; i++) {
    const node = graph.nodes[i];
    const p = nodePos[i];
    const nodeColor = COLORS[node.type] || '#93a0bd';
    const isMatch = !!query && (node.name || '').toLowerCase().includes(query);
    const isHovered = i === hoverIndex;
    const dimmed = isDimmedNode(i);
    const nodeSize = isMatch ? radius*1.5 : isHovered ? radius*1.25 : radius;
    if (dimmed) ctx.globalAlpha = 0.18;
    // 发光光晕
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, nodeSize*3);
    glow.addColorStop(0, nodeColor + '55');
    glow.addColorStop(1, 'transparent');
    ctx.beginPath(); ctx.arc(p.x, p.y, nodeSize*3, 0, Math.PI*2); ctx.fillStyle = glow; ctx.fill();
    // 节点本体
    ctx.beginPath(); ctx.arc(p.x, p.y, nodeSize, 0, Math.PI*2);
    ctx.fillStyle = isMatch ? '#ffffff' : nodeColor; ctx.fill();
    ctx.lineWidth = (isMatch ? 2.5 : 1.5)/zoom;
    ctx.strokeStyle = isMatch ? nodeColor : 'rgba(255,255,255,.5)'; ctx.stroke();
    // 标签（碰撞避让：与已绘制标签包围盒重叠则跳过）
    ctx.font = (11/zoom) + 'px "PingFang SC","Segoe UI",sans-serif';
    ctx.textAlign = 'center';
    const labelBottom = p.y + nodeSize + 14/zoom;
    const textWidth = ctx.measureText(node.name).width;
    const labelX = p.x - textWidth/2 - 3;
    const labelTop = labelBottom - 9;
    const labelWidth = textWidth + 6, labelHeight = 16;
    let overlaps = false;
    for (const rect of labelRects) {
      if (labelX < rect.x + rect.w && labelX + labelWidth > rect.x &&
          labelTop < rect.y + rect.h && labelTop + labelHeight > rect.y) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) {
      labelRects.push({ x: labelX, y: labelTop, w: labelWidth, h: labelHeight });
      ctx.fillStyle = isMatch ? '#0a0e1a' : '#eef2fb';
      ctx.fillText(node.name, p.x, labelBottom);
    }
    if (dimmed) ctx.globalAlpha = 1;
  }
}

// ===== 小地图 =====
function minimapPosition() {
  const controlsHeight = 142, gap = 14;
  return {
    x: cv.clientWidth - MINIMAP_W - 14,
    y: cv.clientHeight - controlsHeight - gap - MINIMAP_H,
  };
}
/** 全图世界坐标包围盒。 */
function graphBounds() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < graph.nodes.length; i++) {
    const p = nodePos[i];
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
  }
  if (!isFinite(minX)) { minX = 0; minY = 0; maxX = 1; maxY = 1; }
  return { minX, minY, maxX, maxY };
}
/** 当前视口的世界坐标范围。 */
function viewportWorld() {
  const vx0 = -panX / zoom, vy0 = -panY / zoom;
  return { minX: vx0, minY: vy0, maxX: vx0 + cv.clientWidth/zoom, maxY: vy0 + cv.clientHeight/zoom };
}
/** 小地图要显示的世界范围（标准 = 全图，鹰眼 = 当前视口）。 */
function minimapWorld() {
  return minimapMode === 'eagle' ? viewportWorld() : graphBounds();
}
function drawMinimap() {
  const nodeCount = graph.nodes.length;
  if (!nodeCount) return;
  // 小地图用屏幕坐标绘制：重置变换（不受 zoom/pan 影响），画完恢复世界变换
  ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
  const { x: miniX, y: miniY } = minimapPosition();
  const world = minimapWorld();
  const w = world.maxX - world.minX || 1, h = world.maxY - world.minY || 1;
  const scaleFactor = Math.min(MINIMAP_W/w, MINIMAP_H/h);
  const offsetX = miniX + (MINIMAP_W - w*scaleFactor)/2;
  const offsetY = miniY + (MINIMAP_H - h*scaleFactor)/2;
  // 背景
  ctx.fillStyle = 'rgba(10,14,26,.75)';
  ctx.fillRect(miniX, miniY, MINIMAP_W, MINIMAP_H);
  ctx.strokeStyle = 'rgba(122,168,255,.3)'; ctx.lineWidth = 1;
  ctx.strokeRect(miniX, miniY, MINIMAP_W, MINIMAP_H);
  // 节点缩略
  for (let i = 0; i < nodeCount; i++) {
    const p = nodePos[i];
    if (p.x < world.minX || p.x > world.maxX || p.y < world.minY || p.y > world.maxY) continue;
    const nodeColor = COLORS[graph.nodes[i].type] || '#93a0bd';
    ctx.fillStyle = nodeColor;
    ctx.fillRect(offsetX + (p.x-world.minX)*scaleFactor - 1, offsetY + (p.y-world.minY)*scaleFactor - 1, 2, 2);
  }
  if (minimapMode === 'standard') {
    // 标准模式：画当前视口矩形（运动的白框）
    const vp = viewportWorld();
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 1;
    ctx.strokeRect(offsetX + (vp.minX-world.minX)*scaleFactor, offsetY + (vp.minY-world.minY)*scaleFactor,
      (vp.maxX-vp.minX)*scaleFactor, (vp.maxY-vp.minY)*scaleFactor);
  } else {
    // 鹰眼模式：小地图即当前视口，画"全图范围"淡框提示
    const gb = graphBounds();
    ctx.strokeStyle = 'rgba(122,168,255,.35)'; ctx.lineWidth = 1;
    ctx.strokeRect(offsetX + (gb.minX-world.minX)*scaleFactor, offsetY + (gb.minY-world.minY)*scaleFactor,
      (gb.maxX-gb.minX)*scaleFactor, (gb.maxY-gb.minY)*scaleFactor);
  }
  // 恢复世界变换（保持一致性）
  ctx.setTransform(devicePixelRatio*zoom, 0, 0, devicePixelRatio*zoom, devicePixelRatio*panX, devicePixelRatio*panY);
}
function minimapHit(screenX, screenY) {
  const { x: miniX, y: miniY } = minimapPosition();
  return screenX >= miniX && screenX <= miniX + MINIMAP_W && screenY >= miniY && screenY <= miniY + MINIMAP_H;
}
/** 小地图点击 → 平移视口使该世界点居中。 */
function minimapJump(screenX, screenY) {
  const nodeCount = graph.nodes.length;
  if (!nodeCount) return;
  const { x: miniX, y: miniY } = minimapPosition();
  const world = minimapWorld();
  const w = world.maxX - world.minX || 1, h = world.maxY - world.minY || 1;
  const scaleFactor = Math.min(MINIMAP_W/w, MINIMAP_H/h);
  const offsetX = miniX + (MINIMAP_W - w*scaleFactor)/2;
  const offsetY = miniY + (MINIMAP_H - h*scaleFactor)/2;
  const worldX = world.minX + (screenX - offsetX)/scaleFactor;
  const worldY = world.minY + (screenY - offsetY)/scaleFactor;
  panX = cv.clientWidth/2 - worldX*zoom;
  panY = cv.clientHeight/2 - worldY*zoom;
  scheduleStaticDraw();
}

// ===== 坐标 / 命中 / 缩放 =====
function screenToWorld(screenX, screenY) {
  return { x: (screenX - panX)/zoom, y: (screenY - panY)/zoom };
}
/** canvas 相对坐标（canvas 顶部有 56px 标题栏，必须减去偏移）。 */
function canvasOffset() {
  const rect = cv.getBoundingClientRect();
  return { x: rect.left, y: rect.top };
}
function eventPosition(ev) {
  const origin = canvasOffset();
  return { x: ev.clientX - origin.x, y: ev.clientY - origin.y };
}
function hitTest(worldX, worldY) {
  const radius = getNodeBaseRadius() * 0.42;
  for (let i = graph.nodes.length - 1; i >= 0; i--) {
    const p = nodePos[i];
    const dx = p.x - worldX, dy = p.y - worldY;
    if (dx*dx + dy*dy <= radius*radius*1.7) return i;
  }
  return -1;
}
/** 以鼠标为中心缩放。 */
function zoomAt(screenX, screenY, factor) {
  const before = screenToWorld(screenX, screenY);
  zoom = Math.max(.2, Math.min(5, zoom*factor));
  const after = screenToWorld(screenX, screenY);
  panX += (after.x - before.x)*zoom;
  panY += (after.y - before.y)*zoom;
  scheduleStaticDraw();
}

// ===== 静态重绘调度 =====
function scheduleStaticDraw() {
  if (staticDrawScheduled) return;
  staticDrawScheduled = true;
  requestAnimationFrame(() => { staticDrawScheduled = false; draw(); });
}

// ===== 事件绑定：鼠标 =====
cv.addEventListener('mousedown', (ev) => {
  const p = eventPosition(ev);
  lastPointerX = p.x; lastPointerY = p.y;
  const world = screenToWorld(p.x, p.y);
  const hit = hitTest(world.x, world.y);
  dragging = hit >= 0 ? hit : -1;
  isViewDragging = hit < 0;
  cv.classList.toggle('dragging', isViewDragging);
  // 拖动节点时暂停力导向模拟：避免每帧 O(n²) 计算
  if (dragging >= 0) animationOn = false;
});
cv.addEventListener('mousemove', (ev) => {
  const p = eventPosition(ev);
  const world = screenToWorld(p.x, p.y);
  const hit = hitTest(world.x, world.y);
  if (hit !== hoverIndex) { hoverIndex = hit; scheduleStaticDraw(); }
  if (dragging >= 0) {
    nodePos[dragging].x = world.x; nodePos[dragging].y = world.y;
    scheduleStaticDraw();
  } else if (isViewDragging) {
    panX += p.x - lastPointerX; panY += p.y - lastPointerY;
    scheduleStaticDraw();
  }
  lastPointerX = p.x; lastPointerY = p.y;
});
/** 拖拽结束：短暂恢复模拟让被拖节点带动邻域重新收敛（RESUME_TICKS 而非重跑 MAX_TICKS）。 */
function endDrag() {
  const wasDragging = dragging >= 0;
  dragging = -1;
  isViewDragging = false;
  cv.classList.remove('dragging');
  if (wasDragging) { animationOn = true; tickCount = MAX_TICKS - RESUME_TICKS; requestAnimationFrame(tick); }
}
window.addEventListener('mouseup', endDrag);
cv.addEventListener('mouseleave', () => { hoverIndex = -1; scheduleStaticDraw(); });
cv.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const p = eventPosition(ev);
  const factor = ev.deltaY < 0 ? 1.15 : 0.87;
  zoomAt(p.x, p.y, factor);
}, { passive: false });
cv.addEventListener('click', (ev) => {
  const p = eventPosition(ev);
  // 点击小地图 → 跳转视口
  if (minimapHit(p.x, p.y)) { minimapJump(p.x, p.y); return; }
  const world = screenToWorld(p.x, p.y);
  const hit = hitTest(world.x, world.y);
  showNode(hit >= 0 ? hit : null);
});

// ===== 事件绑定：右下角控制 / 键盘 / 搜索 =====
document.getElementById('btnHome').addEventListener('click', () => {
  zoom = 1; panX = 0; panY = 0; scheduleStaticDraw();
  toastMessage('已回到中心');
});
document.getElementById('btnZoomIn').addEventListener('click', () => zoomAt(cv.clientWidth/2, cv.clientHeight/2, 1.25));
document.getElementById('btnZoomOut').addEventListener('click', () => zoomAt(cv.clientWidth/2, cv.clientHeight/2, 0.8));
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { sidePanel.classList.remove('show'); document.getElementById('search').value = ''; scheduleStaticDraw(); }
  if (ev.key === '+' || ev.key === '=') zoomAt(cv.clientWidth/2, cv.clientHeight/2, 1.25);
  if (ev.key === '-' || ev.key === '_') zoomAt(cv.clientWidth/2, cv.clientHeight/2, 0.8);
  if (ev.key === 'Home') { zoom = 1; panX = 0; panY = 0; scheduleStaticDraw(); }
});
function toastMessage(message) {
  toast.textContent = message;
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 1500);
}
function showNode(indexToShow) {
  if (indexToShow == null || indexToShow < 0) { sidePanel.classList.remove('show'); return; }
  const node = graph.nodes[indexToShow];
  const rels = graph.edges.filter((edge) => edge._s === indexToShow || edge._t === indexToShow);
  let html = '<button class="close" onclick="document.getElementById(&#39;side&#39;).classList.remove(&#39;show&#39;)">✕</button>';
  html += '<h2>' + escapeHtml(node.name || '') + '</h2>';
  html += '<span class="tag ' + escapeHtml(node.type || 'concept') + '">' + escapeHtml(node.type || 'concept') + '</span>';
  if (node.summary && node.summary !== node.name) html += '<div class="sum">' + escapeHtml(node.summary) + '</div>';
  if (rels.length) {
    html += '<h3>关联（' + rels.length + ' 条）</h3>';
    for (const rel of rels) {
      const otherIndex = rel._s === indexToShow ? rel._t : rel._s;
      const other = graph.nodes[otherIndex];
      const direction = rel._s === indexToShow ? '→' : '←';
      html += '<div class="sum rel" onclick="window.focusIndex(' + otherIndex + ')">' + direction + ' <b>' + escapeHtml(rel.label) + '</b> ' + escapeHtml(other ? other.name : '') + '</div>';
    }
  }
  sidePanel.innerHTML = html;
  sidePanel.classList.add('show');
}
window.focusIndex = (index) => {
  showNode(index);
  const p = nodePos[index];
  if (p) { panX = cv.clientWidth/2 - p.x*zoom; panY = cv.clientHeight/2 - p.y*zoom; scheduleStaticDraw(); }
};
document.getElementById('search').addEventListener('input', () => scheduleStaticDraw());
document.getElementById('refresh').addEventListener('click', loadData);
// 小地图模式切换：标准缩略图 ↔ 鹰眼
document.getElementById('btnMinimap').addEventListener('click', () => {
  minimapMode = (minimapMode === 'standard') ? 'eagle' : 'standard';
  toastMessage(minimapMode === 'eagle' ? '鹰眼模式：小地图随主视图缩放' : '标准缩略图模式：全图缩略+视口白框');
  scheduleStaticDraw();
});

// ===== 事件绑定：触屏（同样减去 canvas 偏移） =====
cv.addEventListener('touchstart', (ev) => {
  const touch = ev.touches[0];
  const origin = canvasOffset();
  const qx = touch.clientX - origin.x, qy = touch.clientY - origin.y;
  lastPointerX = qx; lastPointerY = qy;
  const world = screenToWorld(qx, qy);
  const hit = hitTest(world.x, world.y);
  dragging = hit >= 0 ? hit : -1;
  isViewDragging = hit < 0;
  if (dragging >= 0) animationOn = false;
}, { passive: true });
cv.addEventListener('touchmove', (ev) => {
  ev.preventDefault();
  const touch = ev.touches[0];
  const origin = canvasOffset();
  const qx = touch.clientX - origin.x, qy = touch.clientY - origin.y;
  if (dragging >= 0) {
    const world = screenToWorld(qx, qy);
    nodePos[dragging].x = world.x; nodePos[dragging].y = world.y;
    scheduleStaticDraw();
  } else if (isViewDragging) {
    panX += qx - lastPointerX; panY += qy - lastPointerY;
    scheduleStaticDraw();
  }
  lastPointerX = qx; lastPointerY = qy;
}, { passive: false });
window.addEventListener('touchend', endDrag);

loadData();
})();
</script>
</body>
</html>`

  /** 启动 HTTP 服务。返回启动成功的 URL 或 null。 */
  async function start() {
    if (server) return boundUrl
    const actualPort = port || (await findPort(8765, host)) || 8765
    try {
      server = createServer(async (req, res) => {
        try {
          const url = (req.url || '/').split('?')[0]
          if (url === '/graph-data.json' || url === '/graph.json') {
            const payload = await collectGraphData()
            sendJson(res, 200, payload)
          } else {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
            res.end(HTML)
          }
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('error: ' + e.message)
        }
      })
      server.listen(actualPort, host)
      await new Promise((resolve, reject) => {
        server.once('listening', resolve)
        server.once('error', reject)
      })
      boundUrl = `http://${host}:${actualPort}`
      info(`关系图谱面板已启动：${boundUrl}（本机可交互，离线可用）`)
      return boundUrl
    } catch (e) {
      warn(`图谱面板启动失败: ${e.message}`)
      server = null
      return null
    }
  }

  async function stop() {
    if (!server) return
    try { await new Promise((r) => server.close(r)) } catch {}
    server = null
  }

  return { start, stop, get url() { return boundUrl } }
}
