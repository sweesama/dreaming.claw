// public/static/machine3d.js · v3 · The Machine, Dematerialized
//
// 打字机不再是实体 —— 所有零件变成发光粒子云。
// 纸张保持实体（概念：机器是代码，成品是实物）。
//
// 技术栈：
//   - MeshSurfaceSampler：从几何体表面均匀采样点
//   - 自定义 ShaderMaterial：每颗粒子带噪声抖动 + 深度透视点大小
//   - 开场组装动画：粒子从四散位置聚拢成机器（assembleT: 0→1）
//   - Additive blending：粒子重叠处发光
//
// 导出 API：
//   { tick(char?), breakLine(), newDream(), dispose(), mounted }

import * as THREE from 'three';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

// ============================================================
// 共享粒子 Shader
// ============================================================
const particleVertexShader = /* glsl */ `
  attribute vec3 color;
  attribute vec3 seed;    // 每粒子的随机三维种子，0..1
  uniform float uTime;
  uniform float uAssemble;   // 组装进度 0..1
  uniform float uPixelRatio;
  uniform float uBaseSize;
  varying vec3 vColor;
  varying float vAlpha;

  // easeOutCubic
  float easeOut(float t) { return 1.0 - pow(1.0 - t, 3.0); }

  void main() {
    // 粒子在静止态已经在 position（home 位置）
    // 组装前：粒子分散在一个大球体里的随机点
    // seed 范围 0..1 → 转换到 -1..1 表示方向
    vec3 dir = normalize(seed * 2.0 - 1.0 + vec3(0.0001));
    float dist = 4.0 + seed.x * 5.0;     // 半径 4-9
    vec3 scatter = dir * dist + vec3(0.0, 1.0, 0.0);

    float t = easeOut(clamp(uAssemble, 0.0, 1.0));
    vec3 pos = mix(scatter, position, t);

    // 组装完成后，添加持续的小幅抖动（数据流感）
    float jit = smoothstep(0.8, 1.0, uAssemble);
    pos += vec3(
      sin(uTime * 0.9 + seed.x * 12.0) * 0.004,
      cos(uTime * 1.1 + seed.y * 13.0) * 0.004,
      sin(uTime * 0.7 + seed.z * 11.0) * 0.004
    ) * jit;

    vec4 mv = modelViewMatrix * vec4(pos, 1.0);

    // 点大小：按距离透视
    gl_PointSize = uBaseSize * uPixelRatio * (1.0 / max(0.001, -mv.z));

    gl_Position = projectionMatrix * mv;
    vColor = color;
    // 组装时渐显
    vAlpha = smoothstep(0.0, 0.5, uAssemble);
  }
`;

const particleFragmentShader = /* glsl */ `
  varying vec3 vColor;
  varying float vAlpha;
  void main() {
    vec2 uv = gl_PointCoord - 0.5;
    float d = dot(uv, uv);
    if (d > 0.25) discard;
    // 指数衰减：中心亮，边缘柔和
    float a = exp(-d * 14.0) * vAlpha;
    gl_FragColor = vec4(vColor * (0.5 + a * 1.2), a);
  }
`;

// ============================================================
// 主入口
// ============================================================
export function initMachine3D(container, options = {}) {
  const opts = Object.assign({
    aspect: 0.62,
    maxPixelRatio: 2,
  }, options);

  const lowPerf = window.innerWidth < 640 || /Android.*Mobile|iPhone|iPod/i.test(navigator.userAgent);

  const width = container.clientWidth || 680;
  const height = Math.round(width * opts.aspect);

  // ---------- Renderer / Scene / Camera ----------
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setSize(width, height, false);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, opts.maxPixelRatio));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  renderer.domElement.style.display = 'block';
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // 环境贴图（让纸材质的高光有可反射的"世界"）
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  pmrem.dispose();

  // 视锥设计（必须与 paper 位置同步）：
  //   纸 top 在世界 y=4.25，纸 bottom y=2.25，键盘 y≈0.5~1.8
  //   lookAt y=2.5 → 下俯 3.2° → 视野 -21° ~ +15°
  //   → 纸 (+10°) 和键盘 (-18°) 都在视锥内，无裁切
  const camera = new THREE.PerspectiveCamera(36, width / height, 0.1, 60);
  camera.position.set(0, 2.9, 7.2);
  camera.lookAt(0, 2.5, 0);

  // 纸现在是全息投影，不需要实体光照。保留极弱的半球光仅为 envmap fallback。
  const hemi = new THREE.HemisphereLight(0x5c7088, 0x0a0a12, 0.15);
  scene.add(hemi);

  // ---------- 共享粒子材质 ----------
  // 所有 Points 复用这个材质，uniform 集中控制
  const particleUniforms = {
    uTime: { value: 0 },
    uAssemble: { value: 0 },
    uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
    uBaseSize: { value: 3.2 },
  };

  const particleMat = new THREE.ShaderMaterial({
    uniforms: particleUniforms,
    vertexShader: particleVertexShader,
    fragmentShader: particleFragmentShader,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexColors: false, // 我们用 attribute 传
  });

  // ---------- Helper: mesh geometry → Points ----------
  // 从一个几何体表面采样 count 个点，返回 Points 对象（尚未定位）
  // color 可以是单色，也可以是 [mainHex, accentHex, accentRatio] 混搭
  function makePoints(geometry, count, colorSpec) {
    const tempMesh = new THREE.Mesh(geometry);
    const sampler = new MeshSurfaceSampler(tempMesh).build();
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);

    const mainHex = Array.isArray(colorSpec) ? colorSpec[0] : colorSpec;
    const accentHex = Array.isArray(colorSpec) ? colorSpec[1] : null;
    const accentRatio = Array.isArray(colorSpec) ? (colorSpec[2] || 0.15) : 0;

    const mainColor = new THREE.Color(mainHex);
    const accentColor = accentHex ? new THREE.Color(accentHex) : null;

    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      sampler.sample(v);
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;

      // 颜色：主色 + 少量强调色
      const useAccent = accentColor && Math.random() < accentRatio;
      const base = useAccent ? accentColor : mainColor;
      const tint = 0.75 + Math.random() * 0.5;
      colors[i * 3] = base.r * tint;
      colors[i * 3 + 1] = base.g * tint;
      colors[i * 3 + 2] = base.b * tint;

      seeds[i * 3] = Math.random();
      seeds[i * 3 + 1] = Math.random();
      seeds[i * 3 + 2] = Math.random();
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geom.setAttribute('seed', new THREE.BufferAttribute(seeds, 3));

    const points = new THREE.Points(geom, particleMat);
    points.frustumCulled = false;
    return points;
  }

  // ---------- 色板：主青蓝 + 黄铜暖色强调 ----------
  const COLOR = {
    body: ['#4a8fd4', '#e4a858', 0.12],      // 机身：青蓝 + 12% 黄铜
    baseBlock: '#2d5a88',                     // 底座深蓝
    brass: '#e4a858',                          // 黄铜饰件
    keyStem: '#3a5a88',
    keyCap: ['#bcdfff', '#e4a858', 0.08],     // 键帽：亮青 + 少量铜
    keyRing: '#304878',
    chrome: '#d8f0ff',                         // 铬银
    darkMetal: '#5d90b8',
    rubber: '#1a2540',
    ribbon: '#ff6bb5',                         // 色带：热粉红
    bell: '#e4c060',                           // 铜铃
  };

  // ============================================================
  // 开始构建 —— 把原来的 Mesh 逐一替换成 Points
  // ============================================================
  const machine = new THREE.Group();
  // 整体抬高 0.4：修正底部被视锥裁切；同时让纸也跟着上移一点，视觉更居中
  machine.position.y = 0.4;
  scene.add(machine);

  // ---------- 机身（梯形挤出） ----------
  const bodyShape = new THREE.Shape();
  bodyShape.moveTo(-1.35, 0);
  bodyShape.lineTo(1.35, 0);
  bodyShape.lineTo(1.2, 0.3);
  bodyShape.lineTo(1.1, 0.95);
  bodyShape.quadraticCurveTo(1.08, 1.12, 0.8, 1.15);
  bodyShape.lineTo(-0.55, 1.2);
  bodyShape.quadraticCurveTo(-0.9, 1.18, -1.15, 0.85);
  bodyShape.lineTo(-1.35, 0.5);
  bodyShape.closePath();

  const bodyGeom = new THREE.ExtrudeGeometry(bodyShape, {
    depth: 5.2,
    bevelEnabled: true,
    bevelThickness: 0.06,
    bevelSize: 0.08,
    bevelSegments: 4,
    curveSegments: 10,
  });
  bodyGeom.center();
  const bodyPts = makePoints(bodyGeom, lowPerf ? 4000 : 7000, COLOR.body);
  bodyPts.rotation.y = Math.PI / 2;
  bodyPts.position.set(0, 0.4, 0);
  machine.add(bodyPts);

  // ---------- 底座块 ----------
  const baseGeom = new THREE.BoxGeometry(5.4, 0.18, 2.7);
  const basePts = makePoints(baseGeom, 2500, COLOR.baseBlock);
  basePts.position.set(0, 0.09, 0);
  machine.add(basePts);

  // ---------- 橡胶脚 × 4 ----------
  const footGeom = new THREE.CylinderGeometry(0.12, 0.12, 0.08, 20);
  for (const [sx, sz] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
    const fp = makePoints(footGeom, 150, COLOR.rubber);
    fp.position.set(sx * 2.4, 0.04, sz * 1.15);
    machine.add(fp);
  }

  // ---------- 黄铜铭牌 ----------
  const nameplateGeom = new THREE.BoxGeometry(1.5, 0.22, 0.04);
  const namePts = makePoints(nameplateGeom, 800, COLOR.brass);
  namePts.position.set(0, 0.3, 1.36);
  machine.add(namePts);

  // 铭牌上的细铜线浮雕
  for (const [y, w] of [[0.35, 1.2], [0.25, 1.0]]) {
    const lp = makePoints(new THREE.BoxGeometry(w, 0.012, 0.02), 200, COLOR.brass);
    lp.position.set(0, y, 1.39);
    machine.add(lp);
  }

  // ---------- 滚轴（Platen） ----------
  const platenLength = 4.3;
  const platenGeom = new THREE.CylinderGeometry(0.22, 0.22, platenLength, 40);
  const platenPts = makePoints(platenGeom, 2000, COLOR.rubber);
  platenPts.rotation.z = Math.PI / 2;
  platenPts.position.set(0, 1.2, -0.2);
  machine.add(platenPts);

  // ---------- 滚轴黄铜端盖 × 2 ----------
  const endCapGeom = new THREE.CylinderGeometry(0.38, 0.38, 0.12, 32);
  const endCapCenterGeom = new THREE.CylinderGeometry(0.14, 0.14, 0.14, 20);
  const notchGeom = new THREE.BoxGeometry(0.02, 0.05, 0.14);

  for (const xSign of [-1, 1]) {
    const capGroup = new THREE.Group();
    capGroup.position.set(xSign * (platenLength / 2 + 0.05), 1.2, -0.2);

    const outer = makePoints(endCapGeom, 1500, COLOR.brass);
    outer.rotation.z = Math.PI / 2;
    capGroup.add(outer);

    const center = makePoints(endCapCenterGeom, 400, COLOR.darkMetal);
    center.rotation.z = Math.PI / 2;
    center.position.x = xSign * 0.01;
    capGroup.add(center);

    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const notch = makePoints(notchGeom, 60, COLOR.darkMetal);
      notch.position.set(xSign * 0.065, Math.cos(a) * 0.32, Math.sin(a) * 0.32);
      capGroup.add(notch);
    }

    machine.add(capGroup);
  }

  // ---------- 滚轴细轴 ----------
  const axleGeom = new THREE.CylinderGeometry(0.05, 0.05, 4.7, 16);
  const axlePts = makePoints(axleGeom, 600, COLOR.chrome);
  axlePts.rotation.z = Math.PI / 2;
  axlePts.position.set(0, 1.2, -0.2);
  machine.add(axlePts);

  // ---------- 纸（全息投影 · 双层 canvas） ----------
  //
  // frameCanvas: 静态边框/扫描线/状态栏（只画一次）
  // textCanvas:  打字的文字（每帧会被轻微 destination-out，产生褪色梦感）
  // paperCanvas: 合成输出（= frame + text），作为 THREE.CanvasTexture 的源
  //
  // 字体栈：中文 fallback 覆盖全部常见字符（Courier 没中文，必须加中文字体）

  // 字体栈：英文 Courier 等宽 + 中文用"宋体/SimSun"保留方正复古感
  // （如果回退到 YaHei 黑体就会太"现代"，破坏打字机气质）
  const PAPER_FONT =
    '"Courier New", "Courier", "SimSun", "Songti SC", "STSong", "宋体", "Noto Serif SC", serif';

  // canvas 尺寸必须与下面 paperGeom 的 aspect 一致（3.8 宽 : 2.0 高 ≈ 1.875）
  // 这个 aspect 接近 16:9 全息屏，比 A4 纸更像"电子全息屏"
  const PAPER_W = 960;
  const PAPER_H = 512;

  const frameCanvas = document.createElement('canvas');
  frameCanvas.width = PAPER_W;
  frameCanvas.height = PAPER_H;
  const fctx = frameCanvas.getContext('2d');

  const textCanvas = document.createElement('canvas');
  textCanvas.width = PAPER_W;
  textCanvas.height = PAPER_H;
  const tctx = textCanvas.getContext('2d');

  const paperCanvas = document.createElement('canvas');
  paperCanvas.width = PAPER_W;
  paperCanvas.height = PAPER_H;
  const pctx = paperCanvas.getContext('2d');

  // 画静态框架（只需调用一次，除非改变 UI）
  function paintFrame() {
    fctx.clearRect(0, 0, PAPER_W, PAPER_H);

    // 极淡的青色底色（给整张纸一点"存在感"，加色混合下会透出微光）
    fctx.fillStyle = 'rgba(80, 180, 255, 0.06)';
    fctx.fillRect(0, 0, PAPER_W, PAPER_H);

    // 扫描线（4px 一根）
    fctx.strokeStyle = 'rgba(120, 210, 255, 0.08)';
    fctx.lineWidth = 1;
    for (let y = 0; y < PAPER_H; y += 4) {
      fctx.beginPath();
      fctx.moveTo(0, y + 0.5);
      fctx.lineTo(PAPER_W, y + 0.5);
      fctx.stroke();
    }

    // 外边框（距边 6px）
    fctx.strokeStyle = 'rgba(170, 230, 255, 0.55)';
    fctx.lineWidth = 2.5;
    fctx.strokeRect(6, 6, PAPER_W - 12, PAPER_H - 12);

    // 内边距引导线（左右两条）
    fctx.strokeStyle = 'rgba(120, 210, 255, 0.18)';
    fctx.lineWidth = 1;
    fctx.beginPath(); fctx.moveTo(80, 20); fctx.lineTo(80, PAPER_H - 20); fctx.stroke();
    fctx.beginPath(); fctx.moveTo(PAPER_W - 80, 20); fctx.lineTo(PAPER_W - 80, PAPER_H - 20); fctx.stroke();

    // 顶部状态栏（canvas 里的字号要够大，否则映射到屏幕会看不见）
    fctx.strokeStyle = 'rgba(170, 230, 255, 0.3)';
    fctx.beginPath(); fctx.moveTo(80, 64); fctx.lineTo(PAPER_W - 80, 64); fctx.stroke();
    fctx.fillStyle = 'rgba(170, 230, 255, 0.55)';
    fctx.font = `bold 24px ${PAPER_FONT}`;
    fctx.textBaseline = 'alphabetic';
    fctx.fillText('◆ stream · active', 88, 46);
  }
  paintFrame();

  // 合成一次：paperCanvas = frame + text
  function compositePaper() {
    pctx.clearRect(0, 0, PAPER_W, PAPER_H);
    pctx.drawImage(frameCanvas, 0, 0);
    pctx.drawImage(textCanvas, 0, 0);
  }
  compositePaper();

  const paperTexture = new THREE.CanvasTexture(paperCanvas);
  paperTexture.colorSpace = THREE.SRGBColorSpace;
  paperTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  paperTexture.premultiplyAlpha = false;

  // 全息材质：不受光影响 + 加色混合 + 透明
  const paperMat = new THREE.MeshBasicMaterial({
    map: paperTexture,
    transparent: true,
    opacity: 0,          // 组装时淡入
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  // plane 尺寸与 canvas aspect 严格一致：3.8 宽 : 2.0 高 ≈ 1.875 = PAPER_W / PAPER_H
  // 宽屏全息感；纸比机身略宽一点，像是机器上方悬浮的投影
  const paperGeom = new THREE.PlaneGeometry(3.8, 2.0, 8, 10);
  {
    const pos = paperGeom.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      // 轻微向后卷：只卷纸的上 1/3（y > 0.3）
      const bend = Math.max(0, y - 0.3) * 0.05;
      pos.setZ(i, pos.getZ(i) - bend);
    }
    pos.needsUpdate = true;
    paperGeom.computeVertexNormals();
  }
  const paper = new THREE.Mesh(paperGeom, paperMat);
  // 纸中心 y = 3.25，top 在 4.25、bottom 在 2.25——底部恰好不碰键盘
  paper.position.set(0, 3.25, -0.28);
  paper.rotation.x = -0.08;
  machine.add(paper);

  // 布局基于 canvas 960×512（16:9 全息屏），与 plane aspect 严格匹配
  // 状态栏底线在 y=64；可用写字区 y=100 ~ 482，约 6 行；满了就上滚一行
  const PAPER = {
    marginX: 90,
    maxX: PAPER_W - 90,    // = 870，一行可容 ~18 个汉字
    lineH: 58,
    fontSize: 44,
    cursorX: 90,
    cursorY: 108,
    firstY: 108,
    scrollY: PAPER_H - 30, // = 482
    dirty: false,
  };

  // 写一个字到 textCanvas（tctx）。注意：不碰 frameCanvas / paperCanvas。
  function writeCharToPaper(ch) {
    if (!ch || ch.length === 0) return;

    // 全息文字：亮青色 + 光晕
    tctx.font = `bold ${PAPER.fontSize}px ${PAPER_FONT}`;
    tctx.textBaseline = 'alphabetic';
    tctx.shadowColor = 'rgba(140, 220, 255, 0.95)';
    tctx.shadowBlur = 12;
    tctx.fillStyle = 'rgba(220, 245, 255, 1.0)';

    const w = tctx.measureText(ch).width;

    // 关键修复：**画之前**判断这个字会不会越界。如果越界先换行再画，
    // 不要先画再判断，否则最后一个字会戳出右边界。
    if (PAPER.cursorX + w > PAPER.maxX) {
      PAPER.cursorX = PAPER.marginX;
      PAPER.cursorY += PAPER.lineH;
      maybeScroll();
    }

    // 轻微抖动，模仿打字机不齐
    const jx = (Math.random() - 0.5) * 1.2;
    const jy = (Math.random() - 0.5) * 1.2;
    tctx.fillText(ch, PAPER.cursorX + jx, PAPER.cursorY + jy);

    // 清掉 shadow
    tctx.shadowBlur = 0;
    tctx.shadowColor = 'transparent';

    PAPER.cursorX += w;
    PAPER.dirty = true;
  }

  function lineBreakPaper() {
    PAPER.cursorX = PAPER.marginX;
    PAPER.cursorY += PAPER.lineH;
    maybeScroll();
    PAPER.dirty = true;
  }

  // 把 textCanvas 上所有文字向上滚一行
  // 由于 text 层单独存在，滚动简单：用 buffer 画布偏移拷贝
  function maybeScroll() {
    if (PAPER.cursorY > PAPER.scrollY) {
      const shift = PAPER.lineH;
      // 创建临时 buffer（只在滚动时偶尔发生，开销可接受）
      const buf = document.createElement('canvas');
      buf.width = textCanvas.width;
      buf.height = textCanvas.height;
      buf.getContext('2d').drawImage(textCanvas, 0, -shift);
      tctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
      tctx.drawImage(buf, 0, 0);
      PAPER.cursorY -= shift;
    }
  }

  function resetPaper() {
    tctx.clearRect(0, 0, textCanvas.width, textCanvas.height);
    PAPER.cursorX = PAPER.marginX;
    PAPER.cursorY = PAPER.firstY;
    PAPER.dirty = true;
  }

  // 纸张金属导向片
  for (const xs of [-1, 1]) {
    const guide = makePoints(new THREE.BoxGeometry(0.05, 0.7, 0.05), 200, COLOR.chrome);
    guide.position.set(xs * 1.42, 1.65, -0.15);
    machine.add(guide);
  }

  // ---------- 色带（热粉红高光） ----------
  const ribbonGeom = new THREE.BoxGeometry(1.9, 0.06, 0.06);
  const ribbonPts = makePoints(ribbonGeom, 600, COLOR.ribbon);
  ribbonPts.position.set(0, 1.03, 0.3);
  machine.add(ribbonPts);

  // 色带卷轴 × 2
  for (const xs of [-1, 1]) {
    const spool = makePoints(new THREE.CylinderGeometry(0.2, 0.2, 0.14, 24), 400, COLOR.darkMetal);
    spool.rotation.x = Math.PI / 2;
    spool.position.set(xs * 1.12, 1.03, 0.3);
    machine.add(spool);

    const pin = makePoints(new THREE.CylinderGeometry(0.05, 0.05, 0.18, 12), 120, COLOR.brass);
    pin.rotation.x = Math.PI / 2;
    pin.position.set(xs * 1.12, 1.03, 0.3);
    machine.add(pin);
  }

  // （v3 原本有 20 根打字杆扇形排列在纸后方，视觉像蜘蛛腿，删除。
  //   现在敲键时只有按键下沉 + 纸面出字，更干净。）

  // ---------- 键盘（4 排 × 9~12 键） ----------
  const keyRows = [
    { y: 0.55, z: 1.0,  count: 12, size: 0.18 },
    { y: 0.66, z: 0.72, count: 11, size: 0.18 },
    { y: 0.77, z: 0.44, count: 10, size: 0.18 },
    { y: 0.88, z: 0.16, count: 9,  size: 0.18 },
  ];
  const keys = [];
  for (const row of keyRows) {
    const stemGeom = new THREE.BoxGeometry(row.size * 0.7, 0.18, row.size * 0.7);
    const ringGeom = new THREE.CylinderGeometry(row.size * 0.7, row.size * 0.7, 0.03, 24);
    const capGeom = new THREE.CylinderGeometry(row.size * 0.6, row.size * 0.66, 0.08, 24);

    const gap = 0.32;
    const totalW = row.count * gap;
    for (let i = 0; i < row.count; i++) {
      const x = -totalW / 2 + i * gap + gap / 2;

      const stem = makePoints(stemGeom, 160, COLOR.keyStem);
      stem.position.set(x, row.y - 0.07, row.z);
      machine.add(stem);

      const ring = makePoints(ringGeom, 150, COLOR.keyRing);
      ring.position.set(x, row.y + 0.01, row.z);
      machine.add(ring);

      const cap = makePoints(capGeom, 220, COLOR.keyCap);
      cap.position.set(x, row.y + 0.06, row.z);
      machine.add(cap);

      keys.push({
        stem, cap, ring,
        restY_stem: stem.position.y,
        restY_cap: cap.position.y,
        restY_ring: ring.position.y,
        pressing: false,
        progress: 0,
      });
    }
  }

  // ---------- 空格键 ----------
  const spaceBar = makePoints(new THREE.BoxGeometry(1.5, 0.08, 0.25), 800, COLOR.keyCap);
  spaceBar.position.set(0, 0.53, 1.25);
  machine.add(spaceBar);

  for (const xs of [-0.6, 0.6]) {
    const pillar = makePoints(new THREE.BoxGeometry(0.1, 0.15, 0.1), 80, COLOR.keyStem);
    pillar.position.set(xs, 0.45, 1.25);
    machine.add(pillar);
  }

  // ---------- 回车拉杆 ----------
  const leverPivot = new THREE.Group();
  leverPivot.position.set(-2.35, 1.25, -0.25);
  machine.add(leverPivot);

  const leverArm = makePoints(new THREE.CylinderGeometry(0.03, 0.03, 1.3, 12), 400, COLOR.chrome);
  leverArm.position.set(-0.48, 0.5, 0);
  leverArm.rotation.z = 0.75;
  leverPivot.add(leverArm);

  const leverKnob = makePoints(new THREE.SphereGeometry(0.1, 20, 16), 300, COLOR.brass);
  leverKnob.position.set(-0.9, 1.05, 0);
  leverPivot.add(leverKnob);

  // ---------- 边缘铃 ----------
  const bellGeom = new THREE.SphereGeometry(0.1, 18, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  const bellPts = makePoints(bellGeom, 400, COLOR.bell);
  bellPts.position.set(1.95, 1.32, -0.42);
  machine.add(bellPts);

  // ============================================================
  // 交互：鼠标视差
  // ============================================================
  let targetRotX = 0, targetRotY = 0;
  let curRotX = 0, curRotY = 0;
  const onMove = (e) => {
    const rect = container.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const my = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    targetRotY = mx * 0.22;
    targetRotX = -my * 0.1;
  };
  const onLeave = () => { targetRotX = 0; targetRotY = 0; };
  container.addEventListener('mousemove', onMove);
  container.addEventListener('mouseleave', onLeave);

  const onResize = () => {
    const w = container.clientWidth;
    const h = Math.round(w * opts.aspect);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    particleUniforms.uPixelRatio.value = Math.min(window.devicePixelRatio, 2);
  };
  window.addEventListener('resize', onResize);

  // ============================================================
  // 动画状态
  // ============================================================
  let assembleT = 0;        // 组装进度 0..1，由 clock 推进
  const ASSEMBLE_DURATION = 2.2;
  let leverTarget = 0;      // 回车拉杆目标角度
  let leverVel = 0;         // 回车拉杆角速度
  let paperFadeFrame = 0;   // 纸面褪色节拍器

  // ============================================================
  // Render loop
  // ============================================================
  const clock = new THREE.Clock();
  let running = true;

  // ---------- FPS 自适应降级 ----------
  // 连续 3 秒平均 FPS < 22 就认定这台设备跑不动粒子 3D，主动拆台、暴露 fallback
  // 用 EMA 平滑单帧抖动，避免误判
  let fpsEMA = 60;               // 平滑后的 FPS（初始乐观值）
  let badFrames = 0;             // 连续"低于阈值"的帧计数
  const FPS_LOW = 22;
  const BAD_FRAMES_LIMIT = 180;  // ≈ 3 秒 @ 60fps（或更长时间的低 fps）
  let fpsCheckActive = true;     // 组装完才开始检查（组装期帧率本来就会低）

  function render() {
    if (!running) return;
    requestAnimationFrame(render);
    const dt = Math.min(0.05, clock.getDelta());
    const t = clock.elapsedTime;

    // FPS EMA（α=0.05，相当于最近 ~20 帧的平均）
    if (dt > 0) {
      const fpsNow = 1 / dt;
      fpsEMA = fpsEMA * 0.95 + fpsNow * 0.05;
    }
    // 组装完 1.5 秒后再开始监控（给场景稳定时间）
    if (fpsCheckActive && assembleT >= 1 && t > ASSEMBLE_DURATION + 1.5) {
      if (fpsEMA < FPS_LOW) {
        badFrames++;
        if (badFrames > BAD_FRAMES_LIMIT) {
          // 这台设备撑不住。温和地拆掉 3D，让 CSS 自动显示 offline fallback
          console.warn('[machine3d] low FPS detected (' + fpsEMA.toFixed(1) + '), falling back');
          fpsCheckActive = false;
          running = false;
          try {
            renderer.domElement.remove();
            renderer.dispose();
          } catch (e) { /* 静默 */ }
          return;
        }
      } else {
        badFrames = Math.max(0, badFrames - 2); // 好帧数恢复更快
      }
    }

    // 组装进度
    if (assembleT < 1) {
      assembleT = Math.min(1, assembleT + dt / ASSEMBLE_DURATION);
      particleUniforms.uAssemble.value = assembleT;
    }

    // 全息纸呼吸式闪烁：组装后 opacity 在 0.82~1.0 之间波动 + 偶发 glitch
    const paperBaseOp = Math.max(0, Math.min(1, (assembleT - 0.55) / 0.45));
    const flicker = 0.9 + Math.sin(t * 3.2) * 0.05 + Math.sin(t * 11.7) * 0.04;
    // 1% 几率的瞬时 glitch（跳一下）
    const glitch = Math.random() < 0.01 ? (0.55 + Math.random() * 0.3) : 1;
    paperMat.opacity = paperBaseOp * flicker * glitch;

    particleUniforms.uTime.value = t;

    // 鼠标视差 + 微呼吸
    curRotX += (targetRotX - curRotX) * 4 * dt;
    curRotY += (targetRotY - curRotY) * 4 * dt;
    machine.rotation.x = curRotX + Math.sin(t * 0.4) * 0.005;
    machine.rotation.y = curRotY;

    // 按键动画
    for (const k of keys) {
      if (k.pressing) {
        k.progress += dt / 0.22;
        let depth;
        if (k.progress < 0.3) depth = (k.progress / 0.3) * 0.09;
        else if (k.progress < 1) depth = (1 - (k.progress - 0.3) / 0.7) * 0.09;
        else { depth = 0; k.pressing = false; k.progress = 0; }
        k.stem.position.y = k.restY_stem - depth;
        k.cap.position.y = k.restY_cap - depth;
        k.ring.position.y = k.restY_ring - depth * 0.5;
      }
    }

    // 色带发光：通过 base size 脉冲（所有粒子会变大一下）—— 不够精确
    // 改为：色带 Points 的 material 可单独替换。简单处理：跳过（视觉已有打字杆戳纸和键按下动画）

    // 拉杆弹簧
    const springK = 70, damp = 9;
    const err = leverTarget - leverPivot.rotation.z;
    leverVel += err * springK * dt;
    leverVel *= Math.exp(-damp * dt);
    leverPivot.rotation.z += leverVel * dt;
    leverTarget *= Math.pow(0.01, dt);
    if (Math.abs(leverTarget) < 0.001) leverTarget = 0;

    // 铃发光衰减（暂无单独材质控制；跳过视觉）

    // ---------- 全息纸：褪色 + 合成 ----------
    // 每 3 帧褪一点 textCanvas 上的像素（destination-out），
    // 文字就会"出现 → 亮几秒 → 慢慢消失"——梦感。
    // 新敲的字刚落下时最亮，旧的字会一点点淡出。
    paperFadeFrame++;
    if (paperFadeFrame % 3 === 0) {
      tctx.globalCompositeOperation = 'destination-out';
      // 0.012 ≈ 每 3 帧扣 1.2% 的 alpha → ~8 秒从 100% 衰到 5%
      tctx.fillStyle = 'rgba(0, 0, 0, 0.012)';
      tctx.fillRect(0, 0, textCanvas.width, textCanvas.height);
      tctx.globalCompositeOperation = 'source-over';
      PAPER.dirty = true;  // 褪色也算脏，需要重新合成
    }
    if (PAPER.dirty) {
      compositePaper();
      paperTexture.needsUpdate = true;
      PAPER.dirty = false;
    }

    renderer.render(scene, camera);
  }
  render();

  // ============================================================
  // 公开 API
  // ============================================================
  return {
    mounted: true,

    tick(ch) {
      if (!running) return;  // FPS 降级后空转不再做任何事
      // 先触发键按下动画
      if (keys.length) {
        const k = keys[Math.floor(Math.random() * keys.length)];
        k.pressing = true;
        k.progress = 0;
      }
      // 字延后 ~60ms 再落到纸上，模拟"键到底 → 字锤打色带 → 墨迹出现"的物理延迟
      // 这样视觉上键在下沉时字才出现，比同步触发真实很多
      if (typeof ch === 'string' && ch.length) {
        setTimeout(() => { if (running) writeCharToPaper(ch); }, 60);
      }
    },

    breakLine() {
      if (!running) return;
      leverTarget = 0.55;
      leverVel = -1.5;
      lineBreakPaper();
    },

    newDream() {
      if (!running) return;
      resetPaper();
    },

    dispose() {
      running = false;
      window.removeEventListener('resize', onResize);
      container.removeEventListener('mousemove', onMove);
      container.removeEventListener('mouseleave', onLeave);
      renderer.dispose();
      paperTexture.dispose();
      envTex.dispose();
      particleMat.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
      });
      if (renderer.domElement.parentNode) {
        renderer.domElement.parentNode.removeChild(renderer.domElement);
      }
    },
  };
}
